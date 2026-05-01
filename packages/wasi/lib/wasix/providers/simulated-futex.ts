// Simulated `FutexProvider`.
//
// In-memory wait queues keyed by `(memory, addr)`. A waiter parks itself
// via the cooperative scheduler's `parkFutex` hook; `wake` flips the
// waker bit and re-queues the waiter as runnable, then returns the
// count actually woken.
//
// Memory identity is derived from a `WeakMap<WebAssembly.Memory, symbol>`
// so a multi-worker host that wires its own threads provider with a
// *shared* memory still picks up the correct queue. Distinct memories
// route to distinct queues even at the same numeric address.
//
// ─── Constraints ────────────────────────────────────────────────────────────
//
// - Single-realm only. Cross-worker waiter wakes are not handled here —
//   a host shipping a real multi-worker `ThreadsProvider` is responsible
//   for those (typically via `Atomics.wait` / `Atomics.notify` on the
//   shared backing buffer).
// - Memory must be supplied either via constructor `{ memory, threads }`
//   or via the optional `setMemory(memory)` hook called by `WASIX.start`
//   after auto-detection. Calling `wait` before either path has run
//   throws `WASIXError(EINVAL)`.

import { Result, WASIXError } from "../wasix-32v1.js";
import {
  FUTEX_WAIT_MISMATCH,
  type FutexProvider,
  type ThreadsProvider,
} from "../providers.js";
import type { CooperativeThreadsProvider } from "./cooperative-threads.js";

/**
 * Minimal hook surface this provider needs from the cooperative
 * scheduler. Re-defined here (rather than imported as the class) to
 * keep the dependency direction one-way: `cooperative-threads` does not
 * import the simulated futex.
 */
type ParkableThreads = ThreadsProvider & {
  parkFutex(timeoutNs: bigint | null): number;
  unparkFutex(tid: number): boolean;
};

type Waiter = {
  tid: number;
};

const memoryIds = new WeakMap<WebAssembly.Memory, symbol>();

function memoryKey(memory: WebAssembly.Memory, addr: number): string {
  let id = memoryIds.get(memory);
  if (!id) {
    id = Symbol("wasix-memory-id");
    memoryIds.set(memory, id);
  }
  // `Symbol.toString()` differentiates per-memory; appending `addr`
  // gives one queue per `(memory, addr)` pair.
  return `${id.toString()}:${addr >>> 0}`;
}

/**
 * Simulation futex backed by JS-side wait queues. Pairs with
 * `CooperativeThreadsProvider` (or any `ThreadsProvider` that exposes
 * `parkFutex` / `unparkFutex` hooks).
 */
export class SimulatedFutexProvider implements FutexProvider {
  private memory?: WebAssembly.Memory;
  private threads: ParkableThreads;
  private waiters = new Map<string, Waiter[]>();

  constructor(opts: {
    threads: CooperativeThreadsProvider | ParkableThreads;
    memory?: WebAssembly.Memory;
  }) {
    this.threads = opts.threads as ParkableThreads;
    this.memory = opts.memory;
  }

  setMemory(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  wait(addr: number, expected: number, timeoutNs: bigint | null): number {
    if (!this.memory) {
      throw new WASIXError(Result.EINVAL);
    }
    if (typeof this.threads.parkFutex !== "function") {
      // Host wired a non-parkable threads provider against the
      // simulated futex. Surface ENOSYS so the guest sees a clear
      // signal rather than a hang.
      throw new WASIXError(Result.ENOSYS);
    }
    if ((addr & 0x3) !== 0) {
      // Unaligned futex address — wasix-libc always aligns its
      // `__wasi_futex_t` (a u32). Surface EINVAL.
      throw new WASIXError(Result.EINVAL);
    }
    // Atomic compare against the in-memory value. We use Atomics.load on
    // an Int32Array view — `Atomics.load` is well-defined on both regular
    // and shared array buffers.
    const view = new Int32Array(this.memory.buffer);
    const idx = addr >>> 2;
    const observed = Atomics.load(view, idx);
    if (observed !== (expected | 0)) {
      return FUTEX_WAIT_MISMATCH;
    }
    const tid = this.threads.id();
    const key = memoryKey(this.memory, addr);
    const queue = this.waiters.get(key) ?? [];
    const waiter: Waiter = { tid };
    queue.push(waiter);
    this.waiters.set(key, queue);
    try {
      // parkFutex returns FUTEX_WAIT_OK / FUTEX_WAIT_TIMEOUT.
      return this.threads.parkFutex(timeoutNs);
    } finally {
      // Always remove the waiter on the way out (woken, timed out, or
      // the throw path). A subsequent `wake` against a stale entry is a
      // no-op — `unparkFutex` returns false for non-parked tids.
      const live = this.waiters.get(key);
      if (live) {
        const i = live.indexOf(waiter);
        if (i >= 0) live.splice(i, 1);
        if (live.length === 0) this.waiters.delete(key);
      }
    }
  }

  wake(addr: number, count: number): number {
    if (!this.memory) {
      throw new WASIXError(Result.EINVAL);
    }
    if (typeof this.threads.unparkFutex !== "function") {
      throw new WASIXError(Result.ENOSYS);
    }
    if (count <= 0) return 0;
    const key = memoryKey(this.memory, addr);
    const queue = this.waiters.get(key);
    if (!queue || queue.length === 0) return 0;
    let woken = 0;
    while (queue.length > 0 && woken < count) {
      const w = queue.shift()!;
      if (this.threads.unparkFutex(w.tid)) {
        woken += 1;
      }
    }
    if (queue.length === 0) {
      this.waiters.delete(key);
    }
    return woken;
  }
}
