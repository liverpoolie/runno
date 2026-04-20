// Targeted round-trip spec for the Slice 4 SharedArrayBuffer bridge.
//
// Proves end-to-end:
//   1. WASIXWorkerHost spawns a dedicated worker against a real wasm guest.
//   2. A guest `clock_time_get` call inside the worker reaches a host
//      provider on the main thread.
//   3. That provider returns a `Promise<bigint>` — the dispatcher awaits it.
//   4. The resolved value is delivered back through the SAB bridge, the
//      worker-side inner WASIX sees a sync `bigint` return, and the guest
//      writes it to memory and exits with the low byte.
//
// The guest is `programs/wasix-bridge-clock/wasix-bridge-clock.wat`, built
// to `public/bin/tests/wasix-bridge-clock.wasm` by the existing
// `build:tests:wat` script.

import { test, expect } from "@playwright/test";

import type { WASIXWorkerHost, AsyncClockProvider } from "../lib/main";

test.describe("wasix-worker-bridge", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:5173");
    await page.waitForLoadState("domcontentloaded");
  });

  test("clock_time_get round trip with async ClockProvider", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      while (
        (window as unknown as { WASIXWorkerHost?: unknown })[
          "WASIXWorkerHost"
        ] === undefined
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const w = window as unknown as {
        WASIXWorkerHost: typeof WASIXWorkerHost;
      };

      // Track whether the main-thread provider was invoked.
      const invocations: number[] = [];
      const asyncClock: AsyncClockProvider = {
        now(id: number): Promise<bigint> {
          invocations.push(id);
          return new Promise((resolve) => setTimeout(() => resolve(42n), 0));
        },
        resolution(): bigint {
          return 1_000n;
        },
      };

      const host = new w.WASIXWorkerHost(
        fetch("/bin/tests/wasix-bridge-clock.wasm"),
        {
          clock: asyncClock,
        },
      );
      const { exitCode } = await host.start();
      return { exitCode, invocations };
    });

    // 42 & 0xff === 42. Guest exits with the low byte of the Promise value.
    expect(result.exitCode).toBe(42);
    // Proof the main-thread provider was actually called at least once.
    expect(result.invocations.length).toBeGreaterThan(0);
    // MONOTONIC clock id from the guest.
    expect(result.invocations[0]).toBe(1);
  });
});
