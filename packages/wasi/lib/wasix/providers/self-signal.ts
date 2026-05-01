// Self-delivery `SignalsProvider`.
//
// Stores per-signal handlers (and a single universal callback at
// `signo === 0`) in an in-memory map. `raise(signo)` invokes the
// registered handler synchronously inside the syscall frame; with no
// handler it returns `SUCCESS` and the signal is treated as
// default-ignored, matching the wasmer host's behaviour for the
// example-signal style tests this slice runs.
//
// ─── Scope ──────────────────────────────────────────────────────────────────
//
// - **Sync only.** Handlers run on the JS call stack of the syscall.
//   This slice does not preempt running guest code, even from
//   `raiseInterval`.
// - `raiseInterval(signo, intervalNs, repeat)` schedules with
//   `setTimeout`; on fire we enqueue a "pending self" entry that
//   drains at the next cooperative yield point (`drainSelfPending`).
//   In tight loops the timer fires but the signal is delivered later.
// - `signalThread(tid, signo)` enqueues on a per-TID pending queue;
//   `drainPending(tid)` is called by the cooperative scheduler at
//   yield points before resuming the target thread.
//
// ─── Cross-realm caveat ─────────────────────────────────────────────────────
//
// This provider lives in the same JS realm as the guest. A multi-realm
// host (real-thread workers) needs its own provider that routes the
// indirect-call invocation into the appropriate realm — see the plan
// § "Worker-mode handler dispatch" risk note.

import { Result, WASIXError } from "../wasix-32v1.js";
import type { SignalHandler, SignalsProvider } from "../providers.js";

/**
 * Self-delivery signals provider.
 *
 * Pairs with the cooperative threads + simulated futex providers to
 * give a complete in-process WASIX signal surface. The provider is
 * stateless beyond its handler map and pending queues; tests that
 * need cross-realm routing should supply a host-specific provider.
 */
export class SelfSignalProvider implements SignalsProvider {
  /**
   * `signo === 0` is the universal-callback slot (set by
   * `callback_signal`). All other keys are wasix signal numbers.
   */
  private handlers = new Map<number, SignalHandler>();
  /** Pending self-signal queue, drained at cooperative yield points. */
  private selfPending: number[] = [];
  /** Per-TID pending-signal queues for `signalThread`. */
  private threadPending = new Map<number, number[]>();
  /** Live `setTimeout` handles for repeating intervals. */
  private intervals = new Set<ReturnType<typeof setTimeout>>();

  register(signo: number, handler: SignalHandler | null): Result {
    if (handler === null) {
      this.handlers.delete(signo);
    } else {
      this.handlers.set(signo, handler);
    }
    return Result.SUCCESS;
  }

  raise(signo: number): Result {
    const handler =
      this.handlers.get(signo) ?? this.handlers.get(0 /* universal */);
    if (!handler) {
      // No handler registered — wasix tests treat this as
      // default-ignore for the synchronous signals we run. Surface
      // SUCCESS so the syscall completes cleanly.
      return Result.SUCCESS;
    }
    handler(signo);
    return Result.SUCCESS;
  }

  raiseInterval(signo: number, intervalNs: bigint, repeat: boolean): Result {
    // Convert ns → ms with a 1ms floor so very-small intervals still
    // fire at a real timer tick rather than starving on `setTimeout(0)`.
    const ms = Math.max(1, Number(intervalNs / 1_000_000n));
    const arm = (): void => {
      const handle = setTimeout(() => {
        this.intervals.delete(handle);
        // Cooperative-yield delivery: enqueue and drain at the next
        // yield point. Tight loops never see this (acceptable per
        // plan § Out of scope).
        this.selfPending.push(signo);
        if (repeat) arm();
      }, ms);
      this.intervals.add(handle);
    };
    arm();
    return Result.SUCCESS;
  }

  signalThread(tid: number, signo: number): Result {
    const queue = this.threadPending.get(tid) ?? [];
    queue.push(signo);
    this.threadPending.set(tid, queue);
    return Result.SUCCESS;
  }

  drainPending(tid: number): void {
    const queue = this.threadPending.get(tid);
    if (queue && queue.length > 0) {
      // Snapshot + clear so any handler-side `signalThread(tid, …)`
      // re-entry queues onto a fresh array rather than re-draining
      // the same signo this turn.
      const snap = queue.splice(0, queue.length);
      for (const signo of snap) {
        const handler =
          this.handlers.get(signo) ?? this.handlers.get(0 /* universal */);
        if (handler) handler(signo);
      }
      if (queue.length === 0) this.threadPending.delete(tid);
    }
    // Drain any self-pending entries (raiseInterval) at the same yield
    // point — we don't have a way to distinguish "self" from a TID-1
    // target on the cooperative scheduler, and the wasmer tests we
    // run only ever raise self.
    if (this.selfPending.length > 0) {
      const snap = this.selfPending.splice(0, this.selfPending.length);
      for (const signo of snap) {
        const handler =
          this.handlers.get(signo) ?? this.handlers.get(0 /* universal */);
        if (handler) handler(signo);
      }
    }
  }

  /**
   * Cancel all pending interval timers. Hosts that re-use a single
   * provider across runs should call this between runs; the
   * cooperative scheduler's idle teardown is otherwise fine to leak
   * the timers (they fire onto a dead provider and no-op).
   */
  dispose(): void {
    for (const h of this.intervals) clearTimeout(h);
    this.intervals.clear();
  }
}

// Re-export `WASIXError` so the file's lint surface stays self-contained
// when the provider grows error-throwing paths. The current methods
// always return `Result.SUCCESS`; future slices that surface ESRCH /
// EINVAL through this provider can throw via this constructor.
export { WASIXError };
