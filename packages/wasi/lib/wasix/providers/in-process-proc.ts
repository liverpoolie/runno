// In-process `ProcProvider`.
//
// Realm-local simulation of POSIX process semantics. Spawned children
// share the same JS realm as their parent — there is no sandbox boundary,
// no second `WebAssembly.Memory`, and no fork. Each child is a fresh
// `WASIX` instance driven against the same (or a sibling) compiled
// module, with its own fd-table, args, env, signals provider, and pid.
//
// ─── Lifecycle (synchronous spawn) ──────────────────────────────────────────
//
// `spawn(req)` runs the child guest **to completion** inside the calling
// frame. The exit info is cached on the proc-table entry; `join(pid)`
// returns it immediately. Pipes work for parent-writes-then-child-reads
// patterns and child-writes-then-parent-reads patterns; full duplex
// blocking pipe IO across the spawn boundary is out-of-scope (issue
// § "Out of scope" — blocking-pipe tests stay tagged
// `requires-asyncify`).
//
// ─── fork() ─────────────────────────────────────────────────────────────────
//
// Always returns `{ kind: "unsupported" }`. The wasix-libc fork() path
// requires reifying the post-fork call stack from JS, which the runtime
// cannot do without Asyncify (`WASIX-PLAN.md` § "Why those tests can't
// be passed by providers alone"). The `proc_fork` syscall handler maps
// the unsupported result to `ENOSYS`.
//
// ─── Cross-pid kill ────────────────────────────────────────────────────────
//
// `kill(pid, signo)` looks up the target's signals provider in the
// realm-shared proc table and routes the signal through it. This is the
// **single cross-provider interaction** in v1: the proc fabric reaches
// into the target's `SignalsProvider` slot. With synchronous spawn the
// target is typically already terminated, but the wiring is in place
// for future async-spawn variants where children outlive the spawn
// frame.

import type {
  ProcExitInfo,
  ProcExecRequest,
  ProcForkResult,
  ProcProvider,
  ProcSpawnRequest,
  SignalsProvider,
} from "../providers.js";
import { Result, WASIXError } from "../wasix-32v1.js";
import { createPipe, type PipeReadEnd, type PipeWriteEnd } from "./pipes.js";

/**
 * Module resolver: maps a path string from `ProcSpawnRequest.path` to a
 * compiled `WebAssembly.Module`. Empty `path` means "same module as the
 * parent" — the resolver returns the parent's module so a guest can
 * `spawn()` itself with different argv.
 *
 * Hosts that want sibling-module spawning supply a resolver that fetches
 * `path` and returns a fresh compiled module synchronously (the
 * provider's `spawn` contract is sync — async resolvers need to route
 * through `WASIXWorkerHost`'s async-capable proc bridge).
 */
export type ModuleResolver = (path: string) => WebAssembly.Module;

/**
 * Run a fresh WASIX instance and return its `ProcExitInfo`.
 *
 * The provider does not see this directly — the runtime supplies a
 * concrete runner via `InProcessProcProviderOptions.runChild`. Wiring
 * the runner from outside avoids a circular import between
 * `in-process-proc.ts` and `wasix.ts`.
 */
export type ChildRunner = (
  module: WebAssembly.Module,
  req: ProcSpawnRequest,
  pid: number,
  installSignals: (signals: SignalsProvider) => void,
) => ProcExitInfo;

/**
 * Replace the current guest and run the replacement. Like `runChild`
 * but reuses the calling instance's pid; returns the replacement's exit
 * info up to the caller's runtime so it can throw the existing
 * `WASIXExit` sentinel and unwind cleanly.
 */
export type ExecRunner = (
  module: WebAssembly.Module,
  req: ProcExecRequest,
  pid: number,
) => ProcExitInfo;

export type InProcessProcProviderOptions = {
  /** PID of this provider's owning instance. Defaults to `1` (root). */
  selfPid?: number;
  /** PID of this provider's parent. Defaults to `0` (no parent). */
  parentPid?: number;
  /** Resolver for sibling module URLs. Empty path uses `parentModule`. */
  moduleResolver?: ModuleResolver;
  /**
   * Module the parent WASIX instance is running. The proc provider
   * captures this so a guest invoking `spawn` with `path === ""` can
   * re-run the same compiled module against fresh argv / env.
   */
  parentModule?: WebAssembly.Module;
  /**
   * Child-runner callback. Provided by the runtime so the provider
   * can stay decoupled from `WASIX.start()`'s implementation.
   */
  runChild?: ChildRunner;
  /**
   * Exec-runner callback. Like `runChild` but reuses the caller's pid
   * and returns the replacement's exit so the runtime can unwind.
   */
  runExec?: ExecRunner;
  /**
   * Signals provider for **this** instance — used by another sibling's
   * `kill(myPid, …)` to deliver a signal back to us. Defaults to a no-op
   * provider that returns SUCCESS for every call (signals slot
   * unconfigured = signals are default-ignored).
   */
  selfSignals?: SignalsProvider;
};

type ProcEntry = {
  pid: number;
  parentPid: number;
  signals: SignalsProvider;
  exitInfo: ProcExitInfo | null;
};

/**
 * Realm-shared proc table. All `InProcessProcProvider` instances in a
 * given realm share the same table reference so siblings can `kill` and
 * `join` each other through their pids.
 */
type ProcTable = Map<number, ProcEntry>;
type PidCounter = { next: number };

type PipeEntry = {
  read: PipeReadEnd;
  write: PipeWriteEnd;
  readTaken: boolean;
  writeTaken: boolean;
};
type PipeRegistry = Map<number, PipeEntry>;
type PipeIdCounter = { next: number };

const NULL_SIGNALS: SignalsProvider = {
  register: () => Result.SUCCESS,
  raise: () => Result.SUCCESS,
  raiseInterval: () => Result.SUCCESS,
  signalThread: () => Result.SUCCESS,
};

/**
 * In-process proc provider — see file header for semantics.
 *
 * The provider also implements an internal pipe-broker surface
 * (`allocatePipe` / `takePipeEnd`) used by the WASIX runtime to wire
 * pipe ends across spawn boundaries. The broker is not part of the
 * abstract `ProcProvider` interface — it's an in-process-simulation
 * artefact. Async-capable host providers that want to back pipes need
 * a separate cross-realm channel (out of scope for v1).
 */
export class InProcessProcProvider implements ProcProvider {
  private readonly selfPid: number;
  private readonly selfParentPid: number;
  private readonly procTable: ProcTable;
  private readonly pidCounter: PidCounter;
  private readonly pipes: PipeRegistry;
  private readonly pipeIdCounter: PipeIdCounter;

  parentModule?: WebAssembly.Module;
  private readonly moduleResolver?: ModuleResolver;
  private readonly runChild?: ChildRunner;
  private readonly runExec?: ExecRunner;
  private readonly selfSignals: SignalsProvider;

  constructor(options: InProcessProcProviderOptions = {}) {
    this.selfPid = options.selfPid ?? 1;
    this.selfParentPid = options.parentPid ?? 0;
    this.parentModule = options.parentModule;
    this.moduleResolver = options.moduleResolver;
    this.runChild = options.runChild;
    this.runExec = options.runExec;
    this.selfSignals = options.selfSignals ?? NULL_SIGNALS;

    this.procTable = new Map();
    this.pidCounter = { next: this.selfPid + 1 };
    this.pipes = new Map();
    this.pipeIdCounter = { next: 1 };

    this.procTable.set(this.selfPid, {
      pid: this.selfPid,
      parentPid: this.selfParentPid,
      signals: this.selfSignals,
      exitInfo: null,
    });
  }

  /**
   * Internal: build a sibling provider that **shares** the proc table
   * + pipe registry + pid counters with `this`. Used by `runChild` to
   * give the new child its own `proc` slot while siblings can find each
   * other for cross-pid kill.
   */
  forChild(
    childPid: number,
    childParentPid: number,
    options: Pick<
      InProcessProcProviderOptions,
      "moduleResolver" | "runChild" | "runExec" | "selfSignals" | "parentModule"
    >,
  ): InProcessProcProvider {
    const child = Object.create(
      InProcessProcProvider.prototype,
    ) as InProcessProcProvider;
    Object.assign(child as unknown as Record<string, unknown>, {
      selfPid: childPid,
      selfParentPid: childParentPid,
      procTable: this.procTable,
      pidCounter: this.pidCounter,
      pipes: this.pipes,
      pipeIdCounter: this.pipeIdCounter,
      parentModule: options.parentModule ?? this.parentModule,
      moduleResolver: options.moduleResolver ?? this.moduleResolver,
      runChild: options.runChild ?? this.runChild,
      runExec: options.runExec ?? this.runExec,
      selfSignals: options.selfSignals ?? NULL_SIGNALS,
    });
    return child;
  }

  // ─── ProcProvider ──────────────────────────────────────────────────────

  id(): number {
    return this.selfPid;
  }

  parentId(): number {
    return this.selfParentPid;
  }

  /**
   * `fork()` is permanently unsupported in the in-process simulation —
   * reifying the post-fork call stack from JS requires Asyncify, which
   * is not available in this slice. The runtime maps the unsupported
   * tag to `ENOSYS` at the `proc_fork` syscall site.
   */
  fork(): ProcForkResult {
    return { kind: "unsupported" };
  }

  spawn(req: ProcSpawnRequest): number {
    if (!this.runChild) {
      throw mkError(Result.ENOSYS, "runChild not configured");
    }
    const module = this.resolveModuleSync(req.path);
    const pid = this.pidCounter.next++;
    const entry: ProcEntry = {
      pid,
      parentPid: this.selfPid,
      signals: NULL_SIGNALS,
      exitInfo: null,
    };
    this.procTable.set(pid, entry);
    try {
      const exit = this.runChild(module, req, pid, (signals) => {
        entry.signals = signals;
      });
      entry.exitInfo = exit;
    } catch (e) {
      // Mark the child as exited with code 134 (matches WASIX.start's
      // RuntimeError handling) so a join doesn't hang.
      entry.exitInfo = { exitCode: 134 };
      throw e;
    }
    return pid;
  }

  exec(req: ProcExecRequest): Result {
    if (!this.runExec) {
      return Result.ENOSYS;
    }
    const module = this.resolveModuleSync(req.path);
    const exit = this.runExec(module, req, this.selfPid);
    const entry = this.procTable.get(this.selfPid);
    if (entry) entry.exitInfo = exit;
    return Result.SUCCESS;
  }

  join(pid: number): ProcExitInfo {
    const entry = this.procTable.get(pid);
    if (!entry) {
      throw mkError(Result.ECHILD, `unknown pid ${pid}`);
    }
    if (entry.exitInfo) return entry.exitInfo;
    // Synchronous spawn means a non-exited child shouldn't exist at the
    // time of join in v1. Surface as ECHILD so the guest sees a clean
    // error rather than hanging.
    throw mkError(Result.ECHILD, `pid ${pid} not exited`);
  }

  kill(pid: number, signo: number): Result {
    const entry = this.procTable.get(pid);
    if (!entry) return Result.ESRCH;
    if (pid === this.selfPid) {
      return entry.signals.raise(signo);
    }
    return entry.signals.signalThread(/* MAIN_TID */ 1, signo);
  }

  // ─── PipeBroker (internal extension) ───────────────────────────────────

  /**
   * Allocate a fresh pipe pair. The runtime calls this when handling
   * `proc_spawn` (PIPE_READ / PIPE_WRITE actions) and `fd_pipe`. Both
   * ends are kept in the registry until claimed via `takePipeEnd`.
   *
   * Children inherit pipe ends through `ProcSpawnRequest.fdTable`
   * entries that reference the returned `pipeId`; the child's runtime
   * resolves them to live ends at startup.
   */
  allocatePipe(): { pipeId: number; read: PipeReadEnd; write: PipeWriteEnd } {
    const pipeId = this.pipeIdCounter.next++;
    const { read, write } = createPipe();
    this.pipes.set(pipeId, {
      read,
      write,
      readTaken: false,
      writeTaken: false,
    });
    return { pipeId, read, write };
  }

  /**
   * Claim one end of a previously allocated pipe. Returns `null` if the
   * pipe is unknown or the requested end has already been taken. The
   * registry entry is dropped once both ends are claimed (the live JS
   * references in the runtime keep the underlying ring alive).
   */
  takePipeEnd(
    pipeId: number,
    direction: "read" | "write",
  ): PipeReadEnd | PipeWriteEnd | null {
    const entry = this.pipes.get(pipeId);
    if (!entry) return null;
    if (direction === "read") {
      if (entry.readTaken) return null;
      entry.readTaken = true;
      this.maybeForgetPipe(pipeId, entry);
      return entry.read;
    }
    if (entry.writeTaken) return null;
    entry.writeTaken = true;
    this.maybeForgetPipe(pipeId, entry);
    return entry.write;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private resolveModuleSync(path: string): WebAssembly.Module {
    if (path === "") {
      if (!this.parentModule) {
        throw mkError(
          Result.ENOEXEC,
          "parent module not captured before spawn",
        );
      }
      return this.parentModule;
    }
    if (!this.moduleResolver) {
      throw mkError(
        Result.ENOSYS,
        `no moduleResolver configured for path "${path}"`,
      );
    }
    return this.moduleResolver(path);
  }

  private maybeForgetPipe(pipeId: number, entry: PipeEntry): void {
    if (entry.readTaken && entry.writeTaken) {
      this.pipes.delete(pipeId);
    }
  }
}

/** Convenience: throw a `WASIXError` with a contextual message. */
function mkError(result: Result, message: string): WASIXError {
  return new WASIXError(result, message);
}
