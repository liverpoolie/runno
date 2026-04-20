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

export type ProcForkResult = {
  pid: number;
  isChild: boolean;
};

export type ProcSpawnRequest = {
  path: string;
  args: string[];
  env: Record<string, string>;
};

export type ProcExecRequest = {
  path: string;
  args: string[];
  env: Record<string, string>;
};

export type ProcExitInfo = {
  exitCode: number;
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

export interface ThreadsProvider {
  spawn(startArg: number): number;
  join(tid: number): number;
  exit(code: number): void;
  sleep(durationNs: bigint): void;
  id(): number;
  parallelism(): number;
  signal(tid: number, signo: number): Result;
}

export interface FutexProvider {
  wait(addr: number, expected: number, timeoutNs: bigint | null): number;
  wake(addr: number, count: number): number;
}

export interface SignalsProvider {
  register(signo: number, handler: number): Result;
  raiseInterval(signo: number, intervalNs: bigint): Result;
}

export interface SocketsProvider {
  open(af: number, type: number, proto: number): number;
  bind(fd: number, addr: SockAddr): Result;
  connect(fd: number, addr: SockAddr): Result;
  listen(fd: number, backlog: number): Result;
  accept(fd: number): number;
  send(fd: number, bufs: Uint8Array[], flags: number): number;
  recv(fd: number, bufs: Uint8Array[], flags: number): SockRecvResult;
  shutdown(fd: number, how: number): Result;
  addrResolve(host: string, port: number, hints: AddrHints): SockAddr[];
}

export interface ProcProvider {
  id(): number;
  parentId(): number;
  fork(): ProcForkResult;
  spawn(req: ProcSpawnRequest): number;
  exec(req: ProcExecRequest): Result;
  join(pid: number): ProcExitInfo;
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
