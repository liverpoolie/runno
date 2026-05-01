// Raw synchronous provider interfaces for WASIX syscall slots.
// Every method is synchronous — no Promise return types.
// Async-capable variants (for WASIXWorkerHost) live in providers/async.ts.
//
// Raw pointers never leave the WASIX class; providers receive and return
// JS-native shapes (Uint8Array, bigint, plain objects).

import { ClockId, FileType, Result } from "./wasix-32v1.js";

// ─── Supporting shapes ────────────────────────────────────────────────────────

export type SockAddr =
  | { family: "inet4"; address: string; port: number }
  | { family: "inet6"; address: string; port: number }
  | { family: "unix"; path: string };

export type AddrHints = {
  family?: number;
  type?: number;
  protocol?: number;
  flags?: number;
};

export type SockRecvResult = {
  bytesRead: number;
  flags: number;
};

export type TTYState = {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  echo: boolean;
  lineBuffered: boolean;
  raw: boolean;
};

/**
 * Result of `ProcProvider.fork()`.
 *
 * The runtime never observes the post-fork-guest path in v1 — the
 * `InProcessProcProvider` returns `{ kind: "unsupported" }` from `fork()`,
 * which the `proc_fork` syscall handler maps to `ENOSYS`. The other two
 * variants exist so a future Asyncify-backed provider can surface the
 * real fork shape: the parent observes `{ kind: "parent"; childPid }`,
 * the (asyncify-resumed) child observes `{ kind: "child"; pid }`.
 */
export type ProcForkResult =
  | { kind: "unsupported" }
  | { kind: "child"; pid: number }
  | { kind: "parent"; childPid: number };

/**
 * Plain-data fd-table entry handed across the proc-spawn boundary.
 *
 * The provider never sees a live `WebAssembly.Memory`, a live `WASIX`
 * instance, or any pointer; all fd inheritance flows through this
 * discriminated union of opaque references:
 *
 * - `stdin` / `stdout` / `stderr` — child receives the host's stdio
 *   callbacks at fd 0/1/2.
 * - `fs` — the parent's fd `parentFd` is dup-shared with the child.
 *   Default semantics: the underlying `FileSystemProvider` is shared
 *   between parent and child (issue: "shared FS, isolated fd-table"),
 *   so the child can access the same drive entry through its own fd
 *   number.
 * - `pipe-read` / `pipe-write` — one end of a pipe pair allocated
 *   inside the syscall handler. `pipeId` indexes into a realm-local
 *   pipe registry the proc provider holds; the child's runtime
 *   resolves `pipeId` back into a live `PipeEnd` at startup.
 */
export type ProcFdTableEntry =
  | { kind: "stdin" }
  | { kind: "stdout" }
  | { kind: "stderr" }
  | { kind: "fs"; parentFd: number }
  | { kind: "pipe-read"; pipeId: number }
  | { kind: "pipe-write"; pipeId: number };

/** A single (childFd, entry) pair the child should install at startup. */
export type ProcFdTableSlot = {
  childFd: number;
  entry: ProcFdTableEntry;
};

export type ProcSpawnRequest = {
  /**
   * Module URL the child should load. Empty string ("") means "same
   * module as parent" — the in-process simulation re-runs the parent's
   * compiled module against the child's fresh context.
   */
  path: string;
  args: string[];
  env: Record<string, string>;
  /** fd-table the child inherits at startup. */
  fdTable: ProcFdTableSlot[];
  /** Working directory for the child (informational; in-process simulation does not chdir). */
  cwd?: string;
  /** PID of the parent issuing the spawn. */
  parentPid: number;
};

export type ProcExecRequest = {
  /** Module URL the replacement guest should load. */
  path: string;
  args: string[];
  env: Record<string, string>;
  /** fd-table the replacement guest inherits. */
  fdTable: ProcFdTableSlot[];
  cwd?: string;
};

export type ProcExitInfo = {
  exitCode: number;
  /** Signal number that caused the exit, if killed by signal. */
  signal?: number;
};

// ─── Filesystem supporting shapes ────────────────────────────────────────────

/**
 * Nanosecond timestamps for a filesystem entry.
 * Mirrors the preview1 `timestamp` record (bigint nanoseconds since epoch).
 */
export type FsTimestamps = {
  access: bigint;
  modification: bigint;
  change: bigint;
};

/**
 * Filestat record — file / directory attributes.
 *
 * JS-native shape of preview1's `filestat`. Raw pointers and numeric hashes
 * never leave the WASIX class — the provider works with this structured
 * view and `wasix.ts` marshals it into guest memory.
 */
export type Filestat = {
  /** Device ID of device containing the file. */
  dev: bigint;
  /** Inode — unique identifier within its filesystem. */
  ino: bigint;
  /** File type (regular / directory / …). */
  filetype: FileType;
  /** Number of hard links. */
  nlink: bigint;
  /** Size in bytes. */
  size: bigint;
  /** Last data access / modification / status-change timestamps. */
  timestamps: FsTimestamps;
};

/**
 * Fdstat record — file descriptor attributes.
 *
 * JS-native shape of preview1's `fdstat`.
 */
export type Fdstat = {
  /** File type. */
  filetype: FileType;
  /** File-descriptor flags (APPEND / DSYNC / NONBLOCK / RSYNC / SYNC). */
  fsFlags: number;
  /** Rights the descriptor holds. */
  fsRightsBase: bigint;
  /** Rights descriptors derived from this one may hold. */
  fsRightsInheriting: bigint;
};

/**
 * Preopen description — each preopen is a directory at a fixed fd.
 */
export type PreopenInfo = {
  /** Preopened directory path (e.g. "." / "/"). */
  name: string;
};

/**
 * A single directory entry as seen by fd_readdir.
 */
export type DirEntry = {
  /** Monotonic cookie used to resume readdir across calls. */
  next: bigint;
  /** Inode serial number. */
  ino: bigint;
  /** File type of the entry. */
  filetype: FileType;
  /** Entry name (unencoded). */
  name: string;
};

// ─── Provider interfaces ──────────────────────────────────────────────────────

export interface ClockProvider {
  now(id: ClockId): bigint;
  resolution(id: ClockId): bigint;
}

export interface RandomProvider {
  fill(buf: Uint8Array): void;
}

export interface TTYProvider {
  get(): TTYState;
  set(state: TTYState): Result;
}

/**
 * Raw threads provider.
 *
 * Synchronous JS-native API for the wasix thread syscalls (`thread_*`).
 * TID 0 is reserved per WASIX convention and never returned; allocation
 * is monotonic starting at 2 (the thread that ran `_start` is TID 1).
 *
 * - `spawn(startArg)` — returns a fresh TID. The provider arranges for
 *   `wasi_thread_start(tid, startArg)` to run on that thread; for the
 *   cooperative simulator this is driven by the scheduler at the next
 *   yield point. The host only sees the integer `startArg` — wasix-libc
 *   passes a pointer to its `__wasi_threadstartargs_t` struct here, but
 *   the runtime never dereferences it (the guest's `wasi_thread_start`
 *   does that on its side).
 * - `join(tid)` — block the caller until `tid` exits, return its exit
 *   code. Returns `-1` if the tid is unknown.
 * - `exit(code)` — terminate the calling thread. The cooperative
 *   provider throws an internal sentinel to unwind the wasm call stack
 *   and report `code` to any joiner.
 * - `sleep(durationNs)` — yield for `durationNs` nanoseconds. The
 *   cooperative provider advances its virtual clock as the run queue
 *   drains, so guests sleeping across the same scheduler interval wake
 *   in the right order.
 * - `id()` — current thread's TID.
 * - `parallelism()` — honest count of host-parallel slots. The
 *   cooperative provider returns `1`.
 * - `signal(tid, signo)` — record a pending signal on the target thread
 *   and return `Result.SUCCESS` (or `ESRCH` for an unknown tid). Actual
 *   signal *delivery* / handler invocation is Slice 7's concern; this
 *   slice only tracks the pending queue so guest code observing
 *   self-state sees the signal.
 *
 * Optional members:
 * - `setThreadStart(fn)` — wired by `WASIX.start` once the guest's
 *   `wasi_thread_start` export is available. The cooperative provider
 *   uses this to invoke spawned threads reentrantly during yield points.
 *   Multi-worker / real-thread providers that own their own instances
 *   can ignore this hook.
 */
export interface ThreadsProvider {
  spawn(startArg: number): number;
  join(tid: number): number;
  exit(code: number): void;
  sleep(durationNs: bigint): void;
  id(): number;
  parallelism(): number;
  signal(tid: number, signo: number): Result;
  /** Optional: receive the guest's `wasi_thread_start` export at load time. */
  setThreadStart?(fn: (tid: number, startArg: number) => void): void;
}

/**
 * Raw futex provider.
 *
 * Synchronous backing for `futex_wait` / `futex_wake` / `futex_wake_all`.
 * The address is a u32-aligned offset into the linear memory shared with
 * the guest; providers that need the underlying buffer receive it via
 * the optional `setMemory` hook (called by `WASIX.start` once the memory
 * is resolved).
 *
 * - `wait(addr, expected, timeoutNs)` — atomically check `mem[addr]`
 *   against `expected`; if equal, park the caller. Returns one of:
 *   - `WOKEN`     (matches `FutexWaitResult.WOKEN`) — woken by a `wake`.
 *   - `TIMEOUT`   (matches `FutexWaitResult.TIMEOUT`) — deadline hit.
 *   - `MISMATCH`  — value at addr was not `expected`. The runtime
 *     translates this to `Result.EAGAIN` for the guest.
 *   `timeoutNs === null` means "no timeout" (block indefinitely).
 * - `wake(addr, count)` — wake up to `count` waiters parked on `addr`.
 *   For `futex_wake_all`, the runtime calls `wake(addr, MAX_SAFE_INTEGER)`.
 *   Returns the number of waiters actually woken.
 *
 * Optional:
 * - `setMemory(memory)` — receive the resolved `WebAssembly.Memory` so
 *   the provider can read `mem[addr]` against `expected`. Called by
 *   `WASIX.start` after auto-detection / instantiation. The simulated
 *   provider uses this hook; host-supplied providers that already know
 *   their memory at construction can ignore it.
 */
export interface FutexProvider {
  wait(addr: number, expected: number, timeoutNs: bigint | null): number;
  wake(addr: number, count: number): number;
  /** Optional: receive the resolved guest memory at load time. */
  setMemory?(memory: WebAssembly.Memory): void;
}

/**
 * `FutexProvider.wait` provider-return contract — internal to the
 * runtime / provider boundary. `wasix.ts` translates these into the
 * wasix `futex_wait` ABI (`ret_woken` byte + errno):
 *   `OK`       → `ret_woken=1`, errno = SUCCESS
 *   `TIMEOUT`  → `ret_woken=0`, errno = SUCCESS
 *   `MISMATCH` → ret_woken untouched, errno = EAGAIN
 */
export const FUTEX_WAIT_OK = 0;
export const FUTEX_WAIT_TIMEOUT = 1;
export const FUTEX_WAIT_MISMATCH = 2;

/**
 * Sync signal handler invoked by `SignalsProvider.raise` or by the
 * pending-queue drain on a `signalThread` target. The provider does
 * not know about wasm internals — `wasix.ts` builds the closure that
 * resolves an `__indirect_function_table` slot or named export and
 * calls into the guest, then hands the closure here.
 *
 * Handlers run synchronously inside the syscall frame. Anything they
 * throw propagates out the way every other syscall throw does (a
 * `WASIXError` becomes an errno; a `WebAssembly.RuntimeError` traps
 * the guest, etc.).
 */
export type SignalHandler = (signo: number) => void;

/**
 * Raw synchronous signals provider.
 *
 * Backs the wasix `proc_raise` / `signal_register` / `callback_signal`
 * / `proc_raise_interval` / `thread_signal` syscalls. All methods are
 * synchronous; an `AsyncSignalsProvider` variant exists for hosts that
 * back signals with an async source on the main thread.
 *
 * Conventions:
 *
 * - `signo === 0` is the **universal callback** slot, used by
 *   `callback_signal` (a single string-named export that wasix-libc
 *   registers as the global signal dispatcher). Per-signal handlers
 *   take precedence; the universal callback fires when no per-signal
 *   handler is present for the raised signo.
 * - `register(signo, null)` clears whichever slot `signo` selects
 *   (matches POSIX `SIG_DFL`). The provider returns `SUCCESS`.
 * - `raise(signo)` invokes the registered handler synchronously
 *   inside the syscall frame; with no handler it returns `SUCCESS`
 *   and the signal is treated as default-ignored. `wasix.ts` maps
 *   provider throws to errnos through the standard `mapError` path.
 * - `raiseInterval(signo, intervalNs, repeat)` schedules a host-side
 *   timer; delivery is deferred to the next cooperative yield point
 *   (this slice does not preempt running guest code).
 * - `signalThread(tid, signo)` posts a pending-signal record on the
 *   target TID; delivery happens when that TID next yields, via the
 *   same registered handlers. Routes the wasix `thread_signal` ABI.
 */
export interface SignalsProvider {
  register(signo: number, handler: SignalHandler | null): Result;
  raise(signo: number): Result;
  raiseInterval(signo: number, intervalNs: bigint, repeat: boolean): Result;
  signalThread(tid: number, signo: number): Result;
  /**
   * Optional: drain pending signals enqueued via `signalThread` for
   * `tid`. The cooperative scheduler from Slice 6 calls this hook at
   * yield points before resuming a thread, so per-TID delivery
   * happens at the next runnable transition. Providers that don't
   * track per-TID queues may omit this.
   */
  drainPending?(tid: number): void;
}

export type SockAcceptResult = {
  fd: number;
  addr: SockAddr;
};

export interface SocketsProvider {
  open(af: number, type: number, proto: number): number;
  bind(fd: number, addr: SockAddr): Result;
  connect(fd: number, addr: SockAddr): Result;
  listen(fd: number, backlog: number): Result;
  accept(fd: number): SockAcceptResult;
  send(fd: number, bufs: Uint8Array[], flags: number): number;
  recv(fd: number, bufs: Uint8Array[], flags: number): SockRecvResult;
  shutdown(fd: number, how: number): Result;
  addrResolve(host: string, port: number, hints: AddrHints): SockAddr[];

  // Socket option triplet — wasix splits options into flag/size/time variants
  // by argument shape. Providers translate (level, name) → the appropriate
  // typed value; WASIX marshals it in/out of guest memory.
  getOptFlag(fd: number, level: number, name: number): boolean;
  getOptSize(fd: number, level: number, name: number): number;
  getOptTime(fd: number, level: number, name: number): bigint | null;
  setOptFlag(fd: number, level: number, name: number, value: boolean): Result;
  setOptSize(fd: number, level: number, name: number, value: number): Result;
  setOptTime(
    fd: number,
    level: number,
    name: number,
    value: bigint | null,
  ): Result;

  // Local / peer address + status accessors.
  addrLocal(fd: number): SockAddr;
  addrPeer(fd: number): SockAddr;
  status(fd: number): number;
}

/**
 * Raw synchronous proc provider.
 *
 * Backs the wasix `proc_id` / `proc_parent` / `proc_fork` / `proc_spawn` /
 * `proc_exec` / `proc_join` syscalls and the cross-pid `kill()` path that
 * Slice 7's `SignalsProvider.signalThread` cannot reach on its own.
 *
 * The provider receives JS-native plain-data shapes — never a live
 * `WASIX` instance, never a `WebAssembly.Memory`. The runtime serialises
 * each spawn / exec request into `ProcSpawnRequest` / `ProcExecRequest`
 * before invoking the provider so an out-of-realm host (a future async
 * variant routed through the worker bridge) can replay the request
 * verbatim.
 *
 * Conventions:
 *
 * - `id()` / `parentId()` — process and parent-process ids visible to
 *   the guest. The root process sees `parentId() === 0`.
 * - `fork()` — return `{ kind: "unsupported" }` to surface the wasmer
 *   semantics for `ENOSYS` at the syscall boundary; an Asyncify-backed
 *   provider may return `{ kind: "parent"; childPid }` or
 *   `{ kind: "child"; pid }` to walk the post-fork code-path.
 * - `spawn(req)` — construct a fresh child guest, return its pid.
 * - `exec(req)` — replace the current guest with a fresh one bound to
 *   the same pid. The runtime treats `exec` as terminal: after the
 *   provider returns success, the calling guest's syscall frame
 *   unwinds via the existing `proc_exit` path so the new guest's exit
 *   becomes the effective exit of the original instance. Returning
 *   `Result` lets the provider surface a pre-execve error (bad path,
 *   etc) without unwinding.
 * - `join(pid)` — block until `pid` exits and return its exit info.
 *   "Block" here means cooperatively yield via the threads provider's
 *   yield hooks — the in-process simulation drains the run queue
 *   instead of holding the main JS event loop.
 * - `kill(pid, signo)` — deliver `signo` to the target pid's signals
 *   provider. This is the **single cross-provider interaction** in v1:
 *   `InProcessProcProvider` looks up the target's `SignalsProvider`
 *   from its proc table. Returns `ESRCH` for an unknown pid.
 */
export interface ProcProvider {
  id(): number;
  parentId(): number;
  fork(): ProcForkResult;
  spawn(req: ProcSpawnRequest): number;
  exec(req: ProcExecRequest): Result;
  join(pid: number): ProcExitInfo;
  kill(pid: number, signo: number): Result;
}

/**
 * Raw synchronous filesystem provider.
 *
 * Mirrors the preview1 filesystem-syscall surface with JS-native shapes:
 * `Uint8Array` for buffers, `bigint` for 64-bit offsets, structured
 * `Filestat` / `Fdstat` / `DirEntry` records. No raw pointers — memory
 * marshalling lives in `wasix.ts`, mirroring `wasi.ts`.
 *
 * All methods are synchronous. An `AsyncFileSystemProvider` variant (for
 * IndexedDB / server-backed filesystems) ships in a later slice.
 *
 * Provider methods throw `WASIXError` to signal a specific errno; any
 * other thrown value is treated as `EIO` by the runtime.
 */
export interface FileSystemProvider {
  // ─── File descriptor ops ────────────────────────────────────────────────

  /** Read into the provided buffer list; returns total bytes read. */
  fdRead(fd: number, bufs: Uint8Array[]): number;

  /** Write the provided buffer list; returns total bytes written. */
  fdWrite(fd: number, bufs: Uint8Array[]): number;

  /** Seek; returns the new absolute offset. */
  fdSeek(fd: number, offset: bigint, whence: number): bigint;

  /** Close the descriptor. */
  fdClose(fd: number): void;

  /** Return the descriptor's fdstat record. */
  fdFdstatGet(fd: number): Fdstat;

  /** Update the descriptor's file-descriptor flags (APPEND / NONBLOCK / …). */
  fdFdstatSetFlags(fd: number, flags: number): void;

  /** Return the descriptor's filestat record. */
  fdFilestatGet(fd: number): Filestat;

  /** Return the preopen description for `fd`, or `null` if not a preopen. */
  fdPrestatGet(fd: number): PreopenInfo | null;

  /** Return the preopen's directory name for `fd` (e.g. "."). */
  fdPrestatDirName(fd: number): string;

  /**
   * Read directory entries. Returns up to the entries starting from `cookie`.
   * The runtime is responsible for truncating to the guest's buffer size.
   */
  fdReaddir(fd: number, cookie: bigint): DirEntry[];

  // ─── Path ops ───────────────────────────────────────────────────────────

  /**
   * Open a path relative to the directory `fdDir`. Returns the new fd.
   * `oflags` / `fdflags` mirror preview1 semantics.
   */
  pathOpen(
    fdDir: number,
    dirflags: number,
    path: string,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
  ): number;

  /** Stat a path relative to `fdDir`. */
  pathFilestatGet(fdDir: number, dirflags: number, path: string): Filestat;

  /** Create a directory at `path` relative to `fdDir`. */
  pathCreateDirectory(fdDir: number, path: string): void;

  /** Remove a file at `path` relative to `fdDir`. */
  pathUnlinkFile(fdDir: number, path: string): void;

  /** Remove an (empty) directory at `path` relative to `fdDir`. */
  pathRemoveDirectory(fdDir: number, path: string): void;

  /** Rename `oldPath` under `oldFdDir` to `newPath` under `newFdDir`. */
  pathRename(
    oldFdDir: number,
    oldPath: string,
    newFdDir: number,
    newPath: string,
  ): void;
}
