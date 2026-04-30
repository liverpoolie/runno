// Slice 5 loopback sockets smoke spec.
//
// Drives a hand-rolled WAT guest (`wasix-tcp-loopback.wasm`) through the
// full sock_* surface: open → bind → listen → open → connect → accept →
// send → recv → byte-compare. The WASIX runtime is constructed with a
// LoopbackSocketsProvider that fakes a TCP-shaped fabric in-process — no
// real network. The guest exits 0 on full round-trip success; any other
// code identifies which syscall returned non-zero (see the WAT source for
// the mapping).

import { test, expect } from "@playwright/test";

import type { WASIX, WASIXContext } from "../lib/main";

test.beforeEach(async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForLoadState("domcontentloaded");
});

test("wasix-tcp-loopback: full bind/connect/accept/send/recv round trip exits 0", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    while (
      (window as unknown as { LoopbackSocketsProvider?: unknown })[
        "LoopbackSocketsProvider"
      ] === undefined
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const w = window as unknown as {
      WASIX: typeof WASIX;
      WASIXContext: typeof WASIXContext;
      LoopbackSocketsProvider: new () => import("../lib/main").SocketsProvider;
    };

    const sockets = new w.LoopbackSocketsProvider();
    const wasiResult = await w.WASIX.start(
      fetch("/bin/tests/wasix-tcp-loopback.wasm"),
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
  });

  expect(result.exitCode).toBe(0);
});
