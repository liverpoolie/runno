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
// Plus targeted error-path coverage (Review B / S2):
//   - WASIXError round trip       — provider throws → guest errno
//   - generic Error round trip    — provider throws → guest EIO
//   - kill() teardown             — mid-bridge-call kill is clean
//   - encoder overflow            — oversized response → guest EIO (B1)
//   - decoder failure             — malformed request → dispatcher recovers (B2)
//   - waitAsync fallback          — bridge works without Atomics.waitAsync

import { test, expect } from "@playwright/test";

import type {
  WASIXWorkerHost,
  AsyncClockProvider,
  WASIXWorkerHostKilledError,
} from "../lib/main";
import { ClockId } from "../lib/wasix/wasix-32v1";

test.describe("wasix-worker-bridge", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:5173");
    await page.waitForLoadState("domcontentloaded");

    // The bridge requires SharedArrayBuffer + Atomics.wait, which are gated
    // behind COOP/COEP cross-origin isolation. The Vite dev server sets the
    // right headers; if a future config change drops them, every test here
    // fails with a confusing "Atomics.wait is undefined" — assert isolation
    // up front so the failure mode points straight at the cause.
    const isolated = await page.evaluate(() =>
      Boolean(
        (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
      ),
    );
    test.skip(
      !isolated,
      "wasix-worker-bridge requires COOP/COEP cross-origin isolation",
    );
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

    expect(result.exitCode).toBe(42);
    expect(result.invocations.length).toBeGreaterThan(0);
    expect(result.invocations[0]).toBe(ClockId.MONOTONIC);
  });

  test("WASIXError thrown by provider surfaces as guest errno", async ({
    page,
  }) => {
    // Guest exits with the errno returned from clock_time_get. We have the
    // provider throw `WASIXError(Result.EBADF=8)` — the bridge encodes
    // RESP_TAG_WASIX_ERROR, the worker's callBridgeSync re-throws, the
    // wasix_clock_time_get handler returns the errno verbatim, the guest
    // exits with it. End-to-end proof that the structured-error tag stays
    // structured all the way across the bridge.
    const exitCode = await page.evaluate(async () => {
      while (
        (window as unknown as { WASIXWorkerHost?: unknown })[
          "WASIXWorkerHost"
        ] === undefined
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const w = window as unknown as {
        WASIXWorkerHost: typeof WASIXWorkerHost;
        __WASIX32v1__: {
          Result: Record<string, number>;
          WASIXError: new (r: number) => Error;
        };
      };
      const { WASIXError, Result } = w.__WASIX32v1__;

      const asyncClock: AsyncClockProvider = {
        now(): Promise<bigint> {
          return Promise.reject(new WASIXError(Result.EBADF));
        },
        resolution(): bigint {
          return 1_000n;
        },
      };

      const host = new w.WASIXWorkerHost(
        fetch("/bin/tests/wasix-bridge-errno.wasm"),
        { clock: asyncClock },
      );
      const { exitCode } = await host.start();
      return exitCode;
    });

    // EBADF is 8 — the same value the bridge round-tripped through
    // RESP_TAG_WASIX_ERROR.
    expect(exitCode).toBe(8);
  });

  test("plain Error thrown by provider surfaces as guest EIO", async ({
    page,
  }) => {
    const exitCode = await page.evaluate(async () => {
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

      const asyncClock: AsyncClockProvider = {
        now(): Promise<bigint> {
          return Promise.reject(new Error("boom"));
        },
        resolution(): bigint {
          return 1_000n;
        },
      };

      const host = new w.WASIXWorkerHost(
        fetch("/bin/tests/wasix-bridge-errno.wasm"),
        { clock: asyncClock },
      );
      const { exitCode } = await host.start();
      return exitCode;
    });

    // EIO is 29 — wasix-32v1.ts maps any non-WASIXError caught in
    // wasix_clock_time_get to EIO.
    expect(exitCode).toBe(29);
  });

  test("kill() mid-bridge-call rejects start() with WASIXWorkerHostKilledError", async ({
    page,
  }) => {
    // Provider returns a promise that never resolves. The guest's first
    // clock_time_get parks the worker on the bridge, the dispatcher waits
    // on the provider. We poll until the provider was invoked, then call
    // kill() — the dispatcher's signal aborts mid-await, raceSignal
    // rejects, the dispatcher loop exits, kill() rejects the result with
    // WASIXWorkerHostKilledError. No dangling promises, no console errors.
    const outcome = await page.evaluate(async () => {
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

      const invocations: number[] = [];
      const asyncClock: AsyncClockProvider = {
        now(id: number): Promise<bigint> {
          invocations.push(id);
          return new Promise<bigint>(() => {
            // never settles
          });
        },
        resolution(): bigint {
          return 1_000n;
        },
      };

      const host = new w.WASIXWorkerHost(
        fetch("/bin/tests/wasix-bridge-clock.wasm"),
        { clock: asyncClock },
      );

      const startPromise = host.start();
      // Swallow the rejection here so the test page doesn't surface an
      // unhandled rejection during the wait window below.
      const settled = startPromise.then(
        (v) => ({ ok: true, value: v }),
        (err: unknown) => ({ ok: false, name: (err as Error)?.name }),
      );

      // Wait for the provider to be invoked at least once — that's our
      // signal that the bridge is mid-call.
      const deadline = Date.now() + 5_000;
      while (invocations.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      host.kill();
      // kill() should be idempotent — calling it twice must not throw.
      host.kill();

      const result = await settled;
      return { result, invocations };
    });

    expect(outcome.invocations.length).toBeGreaterThan(0);
    expect(outcome.result.ok).toBe(false);
    // The constructor name survives across page.evaluate's structured
    // clone — verify it's our killed-error class, not a generic Error.
    expect((outcome.result as { name: string }).name).toBe(
      "WASIXWorkerHostKilledError" satisfies typeof WASIXWorkerHostKilledError.prototype.name,
    );
  });

  test("kill() before start() is safe and stops a pending start()", async ({
    page,
  }) => {
    // Pre-kill should not throw. A subsequent start() must reject with
    // WASIXWorkerHostKilledError without spawning a worker.
    const outcome = await page.evaluate(async () => {
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

      const host = new w.WASIXWorkerHost(
        fetch("/bin/tests/wasix-bridge-clock.wasm"),
        {},
      );

      // Pre-start kill.
      let preKillThrew = false;
      try {
        host.kill();
      } catch {
        preKillThrew = true;
      }

      // start() now should reject with the killed-error before reaching
      // worker spawn.
      const settled = await host.start().then(
        (v) => ({ ok: true, value: v }),
        (err: unknown) => ({ ok: false, name: (err as Error)?.name }),
      );

      return { preKillThrew, settled };
    });

    expect(outcome.preKillThrew).toBe(false);
    expect(outcome.settled.ok).toBe(false);
    expect((outcome.settled as { name: string }).name).toBe(
      "WASIXWorkerHostKilledError",
    );
  });

  test("oversized stdin response clamps to maxByteLength without wedging", async ({
    page,
  }) => {
    // Stdin callback returns a string that overflows the bridge response
    // region. Without defensive clamping, encodeResponse would throw
    // "payload exceeds region" — the dispatcher would catch and ship a
    // GENERIC_ERROR, but the worker-side inner-WASI fd_read doesn't catch
    // stdin throws and would crash the worker.
    //
    // The host clamps the response to `maxByteLength` (WASI short-read
    // is a contracted outcome — the guest re-issues fd_read for more), so
    // a misbehaving stdin callback degrades to a short-read instead of a
    // worker crash. The encoder overflow path's safety net (B1's
    // encodeGenericError clamp) is independently exercised below in the
    // protocol-level overflow test.
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

      // 128 KiB — comfortably larger than the 64 KiB response region.
      const oversized = "A".repeat(128 * 1024);
      let observedMax = -1;

      const host = new w.WASIXWorkerHost(
        fetch("/bin/tests/wasix-bridge-stdin.wasm"),
        {
          stdin: (max) => {
            observedMax = max;
            return oversized;
          },
        },
      );
      const { exitCode } = await host.start();
      return { exitCode, observedMax };
    });

    // Guest exits with fd_read's return code — should be SUCCESS=0
    // because the dispatcher clamped the 128 KiB response down to the
    // worker's 32-byte iovec.
    expect(result.exitCode).toBe(0);
    // Sanity: the worker's STDIN_READ request carried a small maxByteLength
    // (iov.byteLength=32 from the test guest), proving the clamp is
    // active.
    expect(result.observedMax).toBe(32);
  });

  test("encodeGenericError clamps an oversized message (B1 wedge fix)", async ({
    page,
  }) => {
    // The dispatcher's recovery path for an in-handler throw is to write
    // a GENERIC_ERROR back to the worker. Before B1, the generic-error
    // encoder used writeUtf8 — which throws if the message exceeds the
    // region, escapes the dispatcher's already-running catch, and wedges
    // the worker in REQUEST_PENDING. This test exercises encodeGenericError
    // directly with a 200 KiB message: it must NOT throw, the GENERIC_ERROR
    // tag must land in the region, and the encoded length must fit the
    // region's capacity.
    const outcome = await page.evaluate(async () => {
      while (
        (window as unknown as { __BRIDGE_TEST_API__?: unknown })[
          "__BRIDGE_TEST_API__"
        ] === undefined
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      type BridgeApi = {
        createBridgeBuffer: (n?: number) => SharedArrayBuffer;
        encodeGenericError: (region: Uint8Array, message: string) => number;
        responseRegion: (buffer: SharedArrayBuffer) => Uint8Array;
        ResponseTag: { OK: number; WASIX_ERROR: number; GENERIC_ERROR: number };
      };
      const api = (window as unknown as { __BRIDGE_TEST_API__: BridgeApi })
        .__BRIDGE_TEST_API__;

      const buffer = api.createBridgeBuffer();
      const region = api.responseRegion(buffer);
      const huge = "x".repeat(200 * 1024);

      let threw = false;
      let written = -1;
      try {
        written = api.encodeGenericError(region, huge);
      } catch {
        threw = true;
      }

      return {
        threw,
        written,
        regionByteLength: region.byteLength,
        tag: region[0],
        GENERIC_ERROR_TAG: api.ResponseTag.GENERIC_ERROR,
      };
    });

    expect(outcome.threw).toBe(false);
    expect(outcome.written).toBeGreaterThan(5);
    expect(outcome.written).toBeLessThanOrEqual(outcome.regionByteLength);
    expect(outcome.tag).toBe(outcome.GENERIC_ERROR_TAG);
  });

  test("malformed request payload triggers decode-error response without wedging the dispatcher", async ({
    page,
  }) => {
    // Direct exercise of the dispatcher's malformed-request recovery path.
    // We create a bridge buffer, write a bogus opcode word + bogus argLen
    // into the header, flip the state word to REQUEST_PENDING, and drive
    // `awaitBridgeRequest` once. It must NOT throw — it must return
    // `kind: "decode-error"`. We then write a generic-error response to
    // the SAB and verify the state machine returns to IDLE — proof that
    // the dispatcher can keep going after a malformed request.
    const outcome = await page.evaluate(async () => {
      while (
        (window as unknown as { __BRIDGE_TEST_API__?: unknown })[
          "__BRIDGE_TEST_API__"
        ] === undefined
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      type BridgeApi = {
        createBridgeBuffer: (n?: number) => SharedArrayBuffer;
        awaitBridgeRequest: (
          buffer: SharedArrayBuffer,
          signal: AbortSignal,
        ) => Promise<
          | { kind: "request"; request: unknown }
          | { kind: "decode-error"; opcode: number; message: string }
          | { kind: "aborted" }
        >;
        writeBridgeGenericError: (
          buffer: SharedArrayBuffer,
          message: string,
        ) => void;
        HEADER_BYTES: number;
        STATE_INDEX: number;
        OPCODE_INDEX: number;
        ARG_LEN_INDEX: number;
        RESP_LEN_INDEX: number;
        STATE_IDLE: number;
        STATE_REQUEST_PENDING: number;
        STATE_RESPONSE_READY: number;
      };
      const api = (window as unknown as { __BRIDGE_TEST_API__: BridgeApi })
        .__BRIDGE_TEST_API__;

      const buffer = api.createBridgeBuffer();
      const state = new Int32Array(buffer);

      // Write a bogus opcode (999 — not a real Opcode). Set argLen to
      // a small valid value so the read doesn't OOB; decodeRequest will
      // hit the default arm and throw.
      Atomics.store(state, api.OPCODE_INDEX, 999);
      Atomics.store(state, api.ARG_LEN_INDEX, 4);
      Atomics.store(state, api.STATE_INDEX, api.STATE_REQUEST_PENDING);

      const controller = new AbortController();
      const awaited = await api.awaitBridgeRequest(buffer, controller.signal);

      // Now write a generic-error response and confirm we can transition
      // the state back to RESPONSE_READY (proxy for "bridge is still
      // usable").
      api.writeBridgeGenericError(buffer, "test: decode failed");
      const postWriteState = Atomics.load(state, api.STATE_INDEX);

      return {
        kind: awaited.kind,
        // Only present when decode-error.
        opcode: (awaited as { opcode?: number }).opcode,
        postWriteState,
        STATE_RESPONSE_READY: api.STATE_RESPONSE_READY,
      };
    });

    expect(outcome.kind).toBe("decode-error");
    expect(outcome.opcode).toBe(999);
    expect(outcome.postWriteState).toBe(outcome.STATE_RESPONSE_READY);
  });

  test("dispatcher waits and resolves even when Atomics.waitAsync is absent", async ({
    page,
  }) => {
    // Some embedders ship SharedArrayBuffer + Atomics.wait but no
    // Atomics.waitAsync. The bridge's main-thread wait must fall back to
    // a microtask poll. Verify by deleting Atomics.waitAsync, then
    // driving a single request/response round trip with the bridge
    // primitives: worker-side store + notify, main-side awaitBridgeRequest,
    // main-side writeBridgeResponse.
    const outcome = await page.evaluate(async () => {
      while (
        (window as unknown as { __BRIDGE_TEST_API__?: unknown })[
          "__BRIDGE_TEST_API__"
        ] === undefined
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      type BridgeApi = {
        createBridgeBuffer: (n?: number) => SharedArrayBuffer;
        awaitBridgeRequest: (
          buffer: SharedArrayBuffer,
          signal: AbortSignal,
        ) => Promise<
          | { kind: "request"; request: { opcode: number; args: unknown } }
          | { kind: "decode-error"; opcode: number; message: string }
          | { kind: "aborted" }
        >;
        writeBridgeResponse: (
          buffer: SharedArrayBuffer,
          response: { opcode: number; result: unknown },
        ) => void;
        encodeRequest: (
          region: Uint8Array,
          request: { opcode: number; args: unknown },
        ) => number;
        requestRegion: (buffer: SharedArrayBuffer) => Uint8Array;
        Opcode: { CLOCK_NOW: number };
        STATE_INDEX: number;
        OPCODE_INDEX: number;
        ARG_LEN_INDEX: number;
        RESP_LEN_INDEX: number;
        STATE_IDLE: number;
        STATE_REQUEST_PENDING: number;
        STATE_RESPONSE_READY: number;
      };
      const api = (window as unknown as { __BRIDGE_TEST_API__: BridgeApi })
        .__BRIDGE_TEST_API__;

      // Force the fallback path. Cast through unknown because TS will
      // (correctly) complain about deleting an optional method.
      const originalWaitAsync = (Atomics as unknown as { waitAsync?: unknown })
        .waitAsync;
      delete (Atomics as unknown as { waitAsync?: unknown }).waitAsync;

      try {
        const buffer = api.createBridgeBuffer();
        const state = new Int32Array(buffer);
        const controller = new AbortController();

        // Main-thread side waits for the (forthcoming) request — must
        // succeed without waitAsync.
        const awaitedPromise = api.awaitBridgeRequest(
          buffer,
          controller.signal,
        );

        // Simulate the worker writing a CLOCK_NOW request after a
        // turn of the event loop. Encode through the real codec so the
        // dispatcher decodes a real request and confirms the fallback
        // doesn't break the protocol.
        await new Promise((r) => setTimeout(r, 0));
        const reqRegion = api.requestRegion(buffer);
        const argLen = api.encodeRequest(reqRegion, {
          opcode: api.Opcode.CLOCK_NOW,
          args: { clockId: 1 },
        });
        Atomics.store(state, api.OPCODE_INDEX, api.Opcode.CLOCK_NOW);
        Atomics.store(state, api.ARG_LEN_INDEX, argLen);
        Atomics.store(state, api.STATE_INDEX, api.STATE_REQUEST_PENDING);
        Atomics.notify(state, api.STATE_INDEX);

        const awaited = await awaitedPromise;

        // Write the response — confirm the round-trip wire format works.
        if (awaited.kind === "request") {
          api.writeBridgeResponse(buffer, {
            opcode: api.Opcode.CLOCK_NOW,
            result: { timeNs: 12345n },
          });
        }

        const finalState = Atomics.load(state, api.STATE_INDEX);

        return {
          waitAsyncPresent: typeof originalWaitAsync === "function",
          kind: awaited.kind,
          opcode:
            awaited.kind === "request"
              ? (awaited.request as { opcode: number }).opcode
              : null,
          finalState,
          STATE_RESPONSE_READY: api.STATE_RESPONSE_READY,
        };
      } finally {
        if (typeof originalWaitAsync === "function") {
          (Atomics as unknown as { waitAsync?: unknown }).waitAsync =
            originalWaitAsync;
        }
      }
    });

    // `waitAsyncPresent` is informational only — Firefox versions that
    // ship without Atomics.waitAsync also exercise the fallback path
    // here, just from the start. The functional assertions below are
    // what protect against fallback-path regressions.
    expect(outcome.kind).toBe("request");
    expect(outcome.opcode).toBe(3 /* Opcode.CLOCK_NOW */);
    expect(outcome.finalState).toBe(outcome.STATE_RESPONSE_READY);
  });
});
