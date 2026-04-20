// SystemClockProvider: browser-native clock using Date.now() and performance.now().
// CPU-time clocks (PROCESS_CPUTIME, THREAD_CPUTIME) fall back to monotonic —
// fine-grained CPU accounting is unavailable in the browser sandbox.

import { ClockId } from "../wasix-32v1.js";
import type { ClockProvider } from "../providers.js";

export class SystemClockProvider implements ClockProvider {
  now(id: ClockId): bigint {
    switch (id) {
      case ClockId.REALTIME:
        return BigInt(Date.now()) * 1_000_000n;
      case ClockId.MONOTONIC:
      case ClockId.PROCESS_CPUTIME:
      case ClockId.THREAD_CPUTIME:
        return BigInt(Math.floor(performance.now() * 1_000_000));
    }
  }

  resolution(id: ClockId): bigint {
    switch (id) {
      case ClockId.REALTIME:
        return 1_000_000n; // ~1ms
      case ClockId.MONOTONIC:
      case ClockId.PROCESS_CPUTIME:
      case ClockId.THREAD_CPUTIME:
        return 1_000n; // ~1µs (approximate; browser may clamp higher)
    }
  }
}
