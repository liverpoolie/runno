// Cooperative `ThreadsProvider`.
//
// Single JS event loop, single wasm instance, **non-preemptive**. Yield
// points are explicit:
//
//   - `thread_sleep` (this provider)
//   - `futex_wait`   (delegated to a `FutexProvider` that re-enters this
//                     scheduler via the parker hook below)
//   - blocking I/O   (future — sockets / poll / pipe slices)
//
// Anything else runs the calling thread to completion before another
// thread gets a turn. `parallelism()` honestly returns `1`. This is a
// valid simulation under the wasix model — guests that *require* real
// preemption (timer interrupts, async signal delivery from another
// thread) are skipped under the `requires-asyncify` token in the test
// suite.
//
// ─── Scheduling model ───────────────────────────────────────────────────────
//
// Each thread runs on the JS call stack. Spawning a thread merely
// records it on the run queue. When the current thread yields — sleep
// or futex wait — the scheduler pops a runnable thread, calls
// `wasi_thread_start(tid, startArg)` reentrantly on it, and that thread
// runs until it itself yields or exits. Once the scheduler determines
// the original waiter's wake condition is satisfied, control returns up
// the stack to the original syscall.
//
// Virtual time is consumed by `sleep` only — wall time never advances
// inside the scheduler. This keeps tests deterministic: a `usleep(1000)`
// followed by `usleep(2000)` always wakes in that order regardless of
// real wall time.
//
// ─── TID allocation ────────────────────────────────────────────────────────
//
// The thread that ran `_start` is TID 1. Spawned threads start at 2 and
// monotonically increase. TID 0 is reserved per WASIX convention and is
// never returned. (Verified: wasix-libc treats `__WASI_TID_INVALID = 0`.)
//
// ─── Signals ────────────────────────────────────────────────────────────────
//
// `signal(tid, signo)` records the pending signal on the target's
// record. Slice 6 only tracks the queue; Slice 7 will deliver signals
// at the next yield point of the target thread. Self-signal is a no-op
// here for the same reason — the actual handler dispatch is Slice 7.

import { Result, WASIXError } from "../wasix-32v1.js";
import {
  FUTEX_WAIT_OK,
  FUTEX_WAIT_TIMEOUT,
  type ThreadsProvider,
} from "../providers.js";

/** TID allocated to the thread that ran `_start`. */
const MAIN_TID = 1;
/** Sentinel WAITING used when virtual time should NOT advance. */
const NO_DEADLINE = null as bigint | null;

type ThreadStatus =
  | "ready"
  | "running"
  | "sleeping"
  | "futex-waiting"
  | "joining"
  | "exited";

type ThreadRecord = {
  tid: number;
  startArg: number;
  status: ThreadStatus;
  /** Virtual-clock wake time (sleeping) or futex-wait deadline. */
  wakeAtNs: bigint | null;
  /** Set true by `unparkFutex` when this thread is woken by a `wake()`. */
  futexWoken: boolean;
  exitCode?: number;
  pendingSignals: number[];
  joiners: number[];
  /** TID we're parked on (for `joining`). */
  joinTarget?: number;
};

/**
 * Internal sentinel — thrown by `exit()` to unwind the wasm call stack
 * when a thread calls `thread_exit`. Caught by the scheduler in the
 * frame that invoked `wasi_thread_start` for that thread.
 */
class CooperativeThreadExit {
  constructor(public readonly tid: number) {}
}

/**
 * Cooperative threads provider. Documented as non-preemptive — see file
 * header. The scheduler runs guest threads on the JS call stack; only
 * the threads that hit a yield point (sleep / futex_wait) ever
 * relinquish control.
 */
export class CooperativeThreadsProvider implements ThreadsProvider {
  private nextTid = 2;
  private records = new Map<number, ThreadRecord>();
  private runQueue: number[] = [];
  private currentTid: number = MAIN_TID;
  private virtualClockNs: bigint = 0n;
  private threadStart?: (tid: number, startArg: number) => void;
  private signalDrain?: (tid: number) => void;

  constructor() {
    this.records.set(MAIN_TID, {
      tid: MAIN_TID,
      startArg: 0,
      status: "running",
      wakeAtNs: NO_DEADLINE,
      futexWoken: false,
      pendingSignals: [],
      joiners: [],
    });
  }

  // ─── ThreadsProvider ────────────────────────────────────────────────────

  setThreadStart(fn: (tid: number, startArg: number) => void): void {
    this.threadStart = fn;
  }

  /**
   * Register a per-yield-point pending-signal drain callback. Slice 7
   * wires `SelfSignalProvider.drainPending` here so signals enqueued
   * via `signalThread` reach the target TID at its next runnable
   * transition. Calling this is optional — without it, the scheduler
   * never invokes drain, and `signalThread` simply queues forever
   * (matches POSIX SIG_IGN semantics for the wasmer suite tests).
   */
  setSignalDrain(fn: (tid: number) => void): void {
    this.signalDrain = fn;
  }

  spawn(startArg: number): number {
    const tid = this.nextTid++;
    this.records.set(tid, {
      tid,
      startArg,
      status: "ready",
      wakeAtNs: NO_DEADLINE,
      futexWoken: false,
      pendingSignals: [],
      joiners: [],
    });
    this.runQueue.push(tid);
    return tid;
  }

  id(): number {
    return this.currentTid;
  }

  parallelism(): number {
    // Single-worker cooperative scheduler. Any value above 1 would lie.
    return 1;
  }

  exit(code: number): void {
    const me = this.records.get(this.currentTid);
    if (me) {
      me.status = "exited";
      me.exitCode = code;
      this.notifyJoiners(this.currentTid);
    }
    // Unwind the wasm stack. Caught either by the scheduler's
    // `runOtherRunnable` (for non-main threads) or by `WASIX.start`'s
    // catch (for the main thread, which sees this as a regular exit).
    if (this.currentTid === MAIN_TID) {
      // For the main thread, throw a regular Error that wasix.ts treats
      // as an exit. We re-throw a structurally-similar error — wasix.ts
      // already handles `WASIXExit` from `proc_exit`; here we leave
      // matching to the runtime by surfacing a thrown exit code marker.
      throw new MainThreadExit(code);
    }
    throw new CooperativeThreadExit(this.currentTid);
  }

  sleep(durationNs: bigint): void {
    const me = this.records.get(this.currentTid);
    if (!me) throw new WASIXError(Result.ESRCH);
    if (durationNs <= 0n) {
      // Zero / negative sleep is a yield only — let the scheduler run
      // any other ready thread once before returning.
      this.runOtherRunnable(() => true, /*allowOnePass*/ true);
      return;
    }
    me.status = "sleeping";
    me.wakeAtNs = this.virtualClockNs + durationNs;
    this.runOtherRunnable(
      () => me.status === "ready" || me.status === "running",
      /*allowOnePass*/ false,
    );
    // Resumed: advance virtual clock to the wake-at if we got here via
    // direct unblock without a clock advance.
    if (me.wakeAtNs !== null && me.wakeAtNs > this.virtualClockNs) {
      this.virtualClockNs = me.wakeAtNs;
    }
    me.wakeAtNs = NO_DEADLINE;
  }

  join(tid: number): number {
    const target = this.records.get(tid);
    if (!target) return -1;
    if (target.status === "exited") {
      return target.exitCode ?? 0;
    }
    target.joiners.push(this.currentTid);
    const me = this.records.get(this.currentTid);
    if (!me) throw new WASIXError(Result.ESRCH);
    me.status = "joining";
    me.joinTarget = tid;
    this.runOtherRunnable(
      () => target.status === "exited",
      /*allowOnePass*/ false,
    );
    me.joinTarget = undefined;
    return target.exitCode ?? 0;
  }

  signal(tid: number, signo: number): Result {
    const target = this.records.get(tid);
    if (!target) return Result.ESRCH;
    target.pendingSignals.push(signo);
    return Result.SUCCESS;
  }

  // ─── Park / unpark hooks for `SimulatedFutexProvider` ──────────────────

  /**
   * Park the current thread on a futex wait. Called by
   * `SimulatedFutexProvider.wait` after the in-memory expected-value
   * compare succeeds.
   *
   * Returns the provider-side `FUTEX_WAIT_*` discriminant.
   */
  parkFutex(timeoutNs: bigint | null): number {
    const me = this.records.get(this.currentTid);
    if (!me) throw new WASIXError(Result.ESRCH);
    me.status = "futex-waiting";
    me.futexWoken = false;
    me.wakeAtNs = timeoutNs === null ? null : this.virtualClockNs + timeoutNs;
    this.runOtherRunnable(
      () => me.status === "ready" || me.status === "running",
      /*allowOnePass*/ false,
    );
    const woken = me.futexWoken;
    me.futexWoken = false;
    me.wakeAtNs = NO_DEADLINE;
    return woken ? FUTEX_WAIT_OK : FUTEX_WAIT_TIMEOUT;
  }

  /**
   * Mark a futex-waiter as woken and re-queue it as runnable. Called by
   * `SimulatedFutexProvider.wake` for each waiter being released.
   * Returns whether the tid was indeed parked on a futex.
   */
  unparkFutex(tid: number): boolean {
    const t = this.records.get(tid);
    if (!t || t.status !== "futex-waiting") return false;
    t.status = "ready";
    t.futexWoken = true;
    t.wakeAtNs = NO_DEADLINE;
    this.runQueue.push(tid);
    return true;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private notifyJoiners(tid: number): void {
    const exited = this.records.get(tid);
    if (!exited) return;
    for (const joinerTid of exited.joiners) {
      const j = this.records.get(joinerTid);
      if (j && j.status === "joining" && j.joinTarget === tid) {
        j.status = "ready";
        // Don't push to runQueue — the joiner is parked higher up the
        // JS call stack; predicate-driven re-check resumes it.
      }
    }
    exited.joiners = [];
  }

  /**
   * Drive other runnable threads until the calling thread's predicate
   * returns true. The current thread's status was already set to
   * `sleeping` / `futex-waiting` / `joining` by the caller — predicate
   * decides when it's safe to resume.
   *
   * `allowOnePass` is for zero-duration sleep: run at most one other
   * thread to completion-or-yield, then return regardless.
   */
  private runOtherRunnable(
    predicate: () => boolean,
    allowOnePass: boolean,
  ): void {
    const savedTid = this.currentTid;
    let passes = 0;
    while (!predicate()) {
      if (allowOnePass && passes >= 1) break;
      let nextTid = this.popRunnable();
      if (nextTid === undefined) {
        // No queue entry — try advancing virtual time to the earliest
        // sleeper / futex deadline, marking that thread ready.
        const advanced = this.advanceVirtualClock();
        if (advanced === undefined) {
          // No runnable, no deadline — deadlock detection. Surface as
          // EDEADLK so the guest sees a deterministic error rather than
          // hanging the JS event loop.
          throw new WASIXError(Result.EDEADLK);
        }
        if (advanced === savedTid) {
          // The saved (calling) thread became runnable on the next
          // virtual tick. Predicate next iteration will return true.
          continue;
        }
        nextTid = advanced;
      }
      if (nextTid === savedTid) {
        // Defensive: don't reentrantly call threadStart on ourselves —
        // we're higher up the JS stack. Mark ready and let predicate
        // settle on the next loop.
        const me = this.records.get(savedTid);
        if (me) me.status = "running";
        break;
      }
      this.runThread(nextTid);
      passes += 1;
    }
    this.currentTid = savedTid;
    const me = this.records.get(savedTid);
    if (me && me.status !== "exited") {
      me.status = "running";
    }
    // Slice 7: drain any pending signals enqueued for the resumed
    // thread before returning into its syscall site. This is the
    // mirror of `runThread`'s drain — that path runs for spawned
    // threads, this one runs when the calling thread wakes from
    // sleep / futex / join.
    this.signalDrain?.(savedTid);
  }

  private popRunnable(): number | undefined {
    while (this.runQueue.length > 0) {
      const tid = this.runQueue.shift()!;
      const r = this.records.get(tid);
      if (r && r.status === "ready") return tid;
    }
    return undefined;
  }

  /**
   * Advance the virtual clock to the earliest sleeper / futex-deadline,
   * marking that thread ready. Returns the woken tid, or `undefined` if
   * no waiter has a finite deadline.
   */
  private advanceVirtualClock(): number | undefined {
    let earliest: { tid: number; wake: bigint } | undefined;
    for (const r of this.records.values()) {
      if (
        (r.status === "sleeping" || r.status === "futex-waiting") &&
        r.wakeAtNs !== null
      ) {
        if (!earliest || r.wakeAtNs < earliest.wake) {
          earliest = { tid: r.tid, wake: r.wakeAtNs };
        }
      }
    }
    if (!earliest) return undefined;
    if (earliest.wake > this.virtualClockNs) {
      this.virtualClockNs = earliest.wake;
    }
    const r = this.records.get(earliest.tid)!;
    if (r.status === "futex-waiting") {
      // Timeout reached — mark not-woken.
      r.futexWoken = false;
    }
    r.status = "ready";
    r.wakeAtNs = null;
    return earliest.tid;
  }

  private runThread(tid: number): void {
    const r = this.records.get(tid);
    if (!r) return;
    if (r.status !== "ready") return;
    if (!this.threadStart) {
      // No `wasi_thread_start` export was discovered on the instance,
      // yet a guest called `thread_spawn`. Surface as ENOSYS for the
      // current spawn attempt (caller will see this on the next sleep).
      r.status = "exited";
      r.exitCode = 1;
      this.notifyJoiners(tid);
      return;
    }
    const prev = this.currentTid;
    this.currentTid = tid;
    r.status = "running";
    // Slice 7: drain any pending signals before handing control back
    // to this TID's wasm frame. The cooperative scheduler is the
    // delivery point for `signalThread` and for `raiseInterval`'s
    // deferred queue.
    this.signalDrain?.(tid);
    try {
      this.threadStart(tid, r.startArg);
      // Returned normally — the user thread function fell off the end.
      // TypeScript narrowed `r.status` to "running" at the assignment
      // above, but reentrant syscalls inside `threadStart` may have
      // mutated it (e.g. `exit()` flipping it to "exited"). Re-read the
      // live record and widen the comparison.
      const live = this.records.get(tid);
      if (live && (live.status as string) !== "exited") {
        live.status = "exited";
        live.exitCode = live.exitCode ?? 0;
        this.notifyJoiners(tid);
      }
    } catch (e) {
      if (e instanceof CooperativeThreadExit) {
        // exit() already flipped status / notified joiners.
      } else if (e instanceof MainThreadExit) {
        // A spawned thread invoked `thread_exit` for the *main* thread —
        // shouldn't happen (only TID 1 can throw this in `exit()`), but
        // if it did, propagate so the outer WASIX.start catches it.
        this.currentTid = prev;
        throw e;
      } else if (e instanceof WebAssembly.RuntimeError) {
        r.status = "exited";
        r.exitCode = 134;
        this.notifyJoiners(tid);
      } else {
        // Unrecognised throw — propagate so the host sees it. This
        // includes proc_exit's WASIXExit, which must reach the outer
        // WASIX.start catch to terminate the whole process.
        this.currentTid = prev;
        throw e;
      }
    }
    this.currentTid = prev;
  }
}

/**
 * Thrown when the **main** thread invokes `thread_exit`. Caught by the
 * runtime's `WASIX.start` so the wasm execution unwinds cleanly with
 * the supplied code.
 *
 * Exported for `wasix.ts` so it can map the throw to a clean exit.
 */
export class MainThreadExit extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`thread_exit (main) ${exitCode}`);
    this.exitCode = exitCode;
  }
}
