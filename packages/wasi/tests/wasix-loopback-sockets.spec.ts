// Slice 5 loopback sockets specs.
//
// Coverage matrix:
//
//                         main thread    worker host (bridge)
//   single-instance       ✓              ✓
//   two-instance fabric   ✓              ✓
//
// Single-instance: drives a hand-rolled WAT guest (`wasix-tcp-loopback.wasm`)
// through the full sock_* surface (open → bind → listen → open → connect →
// accept → send → recv → byte-compare) against a freshly-constructed
// `LoopbackSocketsProvider`. The guest exits 0 on full round-trip success;
// any other code identifies which syscall returned non-zero (see WAT source).
// The worker-host variant is what proves the SAB-bridge encode/decode for
// SOCK_OPEN, SOCK_BIND, SOCK_LISTEN, SOCK_CONNECT, SOCK_ACCEPT, SOCK_SEND
// and SOCK_RECV against a non-stub provider — without it the bridge codec
// for those opcodes would only be exercised by the unit-level round-trip
// test, never end-to-end through a real provider.
//
// Two-instance: two `WASIX` (or two `WASIXWorkerHost`) instances each get
// their own `LoopbackSocketsProvider`, but both providers point at the
// SAME `LoopbackFabric`. Instance #1 runs the listener-half binary
// (open + bind + listen + exit). Instance #2 runs the connector-half
// (open + connect + send "x-fabric" + exit). The spec then inspects the
// fabric directly to verify that the connector's bytes landed on the
// listener-side socket — that's the cross-instance integration check the
// single-instance smoke cannot make. If the fabric weren't actually
// shared, the connector's `connect` would return ECONNREFUSED (exit 2).

import { test, expect } from "@playwright/test";

import type {
  WASIX,
  WASIXContext,
  WASIXWorkerHost,
  LoopbackFabric,
  LoopbackSocketsProvider,
  SocketsProvider,
  SockAddr,
} from "../lib/main";

const SINGLE_INSTANCE_BIN = "/bin/tests/wasix-tcp-loopback.wasm";
const LISTENER_BIN = "/bin/tests/wasix-tcp-fabric-listener.wasm";
const CONNECTOR_BIN = "/bin/tests/wasix-tcp-fabric-connector.wasm";

const FABRIC_PAYLOAD = "x-fabric";

test.beforeEach(async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(async () => {
    while (
      (window as unknown as { LoopbackSocketsProvider?: unknown })[
        "LoopbackSocketsProvider"
      ] === undefined ||
      (window as unknown as { LoopbackFabric?: unknown })["LoopbackFabric"] ===
        undefined ||
      (window as unknown as { WASIXWorkerHost?: unknown })[
        "WASIXWorkerHost"
      ] === undefined
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});

test.describe("LoopbackSocketsProvider — single-instance round trip", () => {
  test("main thread: full bind/connect/accept/send/recv exits 0", async ({
    page,
  }) => {
    const result = await page.evaluate(async (binPath) => {
      const w = window as unknown as {
        WASIX: typeof WASIX;
        WASIXContext: typeof WASIXContext;
        LoopbackSocketsProvider: new () => SocketsProvider;
      };
      const sockets = new w.LoopbackSocketsProvider();
      const wasiResult = await w.WASIX.start(
        fetch(binPath),
        new w.WASIXContext({
          args: [],
          stdout: () => {},
          stderr: () => {},
          stdin: () => null,
          fs: {},
          sockets,
        }),
      );
      return { exitCode: wasiResult.exitCode };
    }, SINGLE_INSTANCE_BIN);

    expect(result.exitCode).toBe(0);
  });

  test("worker host: full bind/connect/accept/send/recv exits 0 (bridge round trip)", async ({
    page,
  }) => {
    const result = await page.evaluate(async (binPath) => {
      const w = window as unknown as {
        WASIXWorkerHost: typeof WASIXWorkerHost;
        LoopbackSocketsProvider: new () => SocketsProvider;
      };
      const sockets = new w.LoopbackSocketsProvider();
      const host = new w.WASIXWorkerHost(fetch(binPath), {
        sockets,
      });
      const wasiResult = await host.start();
      return { exitCode: wasiResult.exitCode };
    }, SINGLE_INSTANCE_BIN);

    expect(result.exitCode).toBe(0);
  });
});

test.describe("LoopbackSocketsProvider — two-instance shared fabric", () => {
  test("main thread: connector writes land on listener-side fd via shared fabric", async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ listenerBin, connectorBin }) => {
        const w = window as unknown as {
          WASIX: typeof WASIX;
          WASIXContext: typeof WASIXContext;
          LoopbackFabric: new () => LoopbackFabric;
          LoopbackSocketsProvider: new (
            fabric?: LoopbackFabric,
          ) => LoopbackSocketsProvider;
        };
        const fabric = new w.LoopbackFabric();
        const listenerProvider = new w.LoopbackSocketsProvider(fabric);
        const connectorProvider = new w.LoopbackSocketsProvider(fabric);

        const listenerResult = await w.WASIX.start(
          fetch(listenerBin),
          new w.WASIXContext({
            args: [],
            stdout: () => {},
            stderr: () => {},
            stdin: () => null,
            fs: {},
            sockets: listenerProvider,
          }),
        );
        const connectorResult = await w.WASIX.start(
          fetch(connectorBin),
          new w.WASIXContext({
            args: [],
            stdout: () => {},
            stderr: () => {},
            stdin: () => null,
            fs: {},
            sockets: connectorProvider,
          }),
        );

        return inspectFabric(
          fabric,
          listenerResult.exitCode,
          connectorResult.exitCode,
        );

        function inspectFabric(
          fabric: LoopbackFabric,
          listenerExit: number,
          connectorExit: number,
        ) {
          const listenerFd = fabric.listeners.get("1:8000");
          const listener =
            listenerFd === undefined
              ? null
              : (fabric.sockets.get(listenerFd) ?? null);
          const accepted =
            listener && listener.backlog.length > 0
              ? (fabric.sockets.get(listener.backlog[0].peerFd) ?? null)
              : null;
          const decoder = new TextDecoder();
          const acceptedBytes = accepted
            ? decoder.decode(
                accepted.rxStream.subarray(0, accepted.rxStreamLen),
              )
            : "";
          return {
            listenerExit,
            connectorExit,
            listenerRegistered: listenerFd !== undefined,
            backlogSize: listener ? listener.backlog.length : 0,
            acceptedBytes,
            providersDistinct: listenerProvider !== connectorProvider,
            fabricsShared: listenerProvider.fabric === connectorProvider.fabric,
          };
        }
      },
      { listenerBin: LISTENER_BIN, connectorBin: CONNECTOR_BIN },
    );

    expect(result.providersDistinct).toBe(true);
    expect(result.fabricsShared).toBe(true);
    expect(result.listenerExit).toBe(0);
    expect(result.connectorExit).toBe(0);
    expect(result.listenerRegistered).toBe(true);
    expect(result.backlogSize).toBe(1);
    expect(result.acceptedBytes).toBe(FABRIC_PAYLOAD);
  });

  // Webkit-specific dev-mode quirk: the second `new Worker(...)` of the
  // run is rejected with `Worker load was blocked by Cross-Origin-Embedder-Policy`
  // even though COEP/COOP headers are correctly set on the dev server (the
  // first `new Worker` of the same run loads fine). This is a Vite dev-only
  // issue — the inline-worker import (`?worker&inline`) is not actually
  // inlined under `vite dev`; in a production build the worker is embedded
  // as a blob URL and the issue does not reproduce. Chromium and Firefox
  // both spawn the second worker without complaint, so the cross-instance
  // bridge codec is still exercised on those engines. Re-enable on webkit
  // once Vite ships a fix or once we run these specs against `vite preview`.
  test("worker host: connector writes land on listener-side fd via shared fabric (bridge round trip)", async ({
    page,
    browserName,
  }, testInfo) => {
    test.fixme(
      browserName === "webkit",
      "vite dev: webkit blocks the second non-inlined worker with COEP",
    );
    void testInfo;
    const result = await page.evaluate(
      async ({ listenerBin, connectorBin }) => {
        const w = window as unknown as {
          WASIXWorkerHost: typeof WASIXWorkerHost;
          LoopbackFabric: new () => LoopbackFabric;
          LoopbackSocketsProvider: new (
            fabric?: LoopbackFabric,
          ) => LoopbackSocketsProvider;
        };
        const fabric = new w.LoopbackFabric();
        const listenerProvider = new w.LoopbackSocketsProvider(fabric);
        const connectorProvider = new w.LoopbackSocketsProvider(fabric);

        // Sequenced: listener fully exits (registering its fd in the
        // fabric) before the connector starts so connect() finds the
        // listener even though main-thread JS would otherwise serialise
        // them anyway. Worker hosts could in principle run concurrently;
        // this spec enforces the same ordering as the main-thread case
        // for parity.
        let listenerResult,
          connectorResult,
          errorPhase = "";
        try {
          errorPhase = "listener-host";
          const listenerHost = new w.WASIXWorkerHost(fetch(listenerBin), {
            sockets: listenerProvider,
          });
          listenerResult = await listenerHost.start();
          errorPhase = "connector-host";
          const connectorHost = new w.WASIXWorkerHost(fetch(connectorBin), {
            sockets: connectorProvider,
          });
          connectorResult = await connectorHost.start();
        } catch (e) {
          const err =
            e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          throw new Error(`worker-host phase=${errorPhase}: ${err}`);
        }

        const listenerFd = fabric.listeners.get("1:8000");
        const listener =
          listenerFd === undefined
            ? null
            : (fabric.sockets.get(listenerFd) ?? null);
        const accepted =
          listener && listener.backlog.length > 0
            ? (fabric.sockets.get(listener.backlog[0].peerFd) ?? null)
            : null;
        const decoder = new TextDecoder();
        const acceptedBytes = accepted
          ? decoder.decode(accepted.rxStream.subarray(0, accepted.rxStreamLen))
          : "";

        return {
          listenerExit: listenerResult.exitCode,
          connectorExit: connectorResult.exitCode,
          listenerRegistered: listenerFd !== undefined,
          backlogSize: listener ? listener.backlog.length : 0,
          acceptedBytes,
          providersDistinct: listenerProvider !== connectorProvider,
          fabricsShared: listenerProvider.fabric === connectorProvider.fabric,
        };
      },
      { listenerBin: LISTENER_BIN, connectorBin: CONNECTOR_BIN },
    );

    expect(result.providersDistinct).toBe(true);
    expect(result.fabricsShared).toBe(true);
    expect(result.listenerExit).toBe(0);
    expect(result.connectorExit).toBe(0);
    expect(result.listenerRegistered).toBe(true);
    expect(result.backlogSize).toBe(1);
    expect(result.acceptedBytes).toBe(FABRIC_PAYLOAD);
  });
});

// Silence unused-import warnings — these types are used inside the
// browser-side `page.evaluate` blocks via type assertions.
type _Unused = SockAddr;
