// FixedClockProvider: deterministic clock for testing and simulation.
//
// REALTIME always returns `epochNs`.
// MONOTONIC starts at `epochNs` and advances by `tick` nanoseconds on each
// call. With the default tick of 0n the monotonic clock is frozen — useful
// for deterministic replay. Set tick > 0n to simulate time passing between
// calls (e.g. tick=1_000_000n advances 1ms per call).
// CPU-time clocks (PROCESS_CPUTIME, THREAD_CPUTIME) share the monotonic
// counter and increment the same way.

import { ClockId } from "../wasix-32v1.js";
import type { ClockProvider } from "../providers.js";

export class FixedClockProvider implements ClockProvider {
  private readonly epochNs: bigint;
  private readonly tick: bigint;
  private counter: bigint;

  constructor(epochNs: bigint = 0n, tick: bigint = 0n) {
    this.epochNs = epochNs;
    this.tick = tick;
    this.counter = 0n;
  }

  now(id: ClockId): bigint {
    switch (id) {
      case ClockId.REALTIME:
        return this.epochNs;
      case ClockId.MONOTONIC:
      case ClockId.PROCESS_CPUTIME:
      case ClockId.THREAD_CPUTIME: {
        const value = this.epochNs + this.counter;
        this.counter += this.tick;
        return value;
      }
    }
  }

  resolution(_id: ClockId): bigint {
    return this.tick > 0n ? this.tick : 1n;
  }
}
