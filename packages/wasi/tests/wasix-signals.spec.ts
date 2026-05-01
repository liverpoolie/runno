// Hand-rolled signals smoke. Pairs with `programs/wasix-signals/`.
//
// The WAT module registers a universal handler via `callback_signal`,
// self-raises `SIGINT`, and asserts the handler ran exactly once
// before `proc_raise` returned. Exit code 0 == golden path.

import { test, expect } from "@playwright/test";

import type {
  SelfSignalProvider,
  WASIX,
  WASIXContext,
  WASIXWorkerHost,
} from "../lib/main";

test.beforeEach(async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForLoadState("domcontentloaded");
});

test("wasix-signals [main]: synchronous handler runs before proc_raise returns", async ({
  page,
}) => {
  const result = await page.evaluate(async function () {
    while ((window as any)["WASIX"] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const W: typeof WASIX = (window as any)["WASIX"];
    const WC: typeof WASIXContext = (window as any)["WASIXContext"];
    const SS: typeof SelfSignalProvider = (window as any)["SelfSignalProvider"];

    const wasiResult = await W.start(
      fetch("/bin/tests/wasix-signals.wasm"),
      new WC({
        args: [],
        stdout: () => {},
        stderr: () => {},
        stdin: () => null,
        fs: {},
        signals: new SS(),
      }),
    );

    return { exitCode: wasiResult.exitCode };
  });

  expect(result.exitCode).toBe(0);
});

test("wasix-signals [worker]: synchronous handler runs before proc_raise returns", async ({
  page,
}) => {
  const result = await page.evaluate(async function () {
    while ((window as any)["WASIXWorkerHost"] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const WH: typeof WASIXWorkerHost = (window as any)["WASIXWorkerHost"];
    const SS: typeof SelfSignalProvider = (window as any)["SelfSignalProvider"];

    const host = new WH(fetch("/bin/tests/wasix-signals.wasm"), {
      args: [],
      stdout: () => {},
      stderr: () => {},
      stdin: () => null,
      // Slot must be non-undefined for the worker to install its
      // local SelfSignalProvider — handler dispatch must run in the
      // same realm as the wasm instance.
      signals: new SS(),
    });
    const workerResult = await host.start();
    return { exitCode: workerResult.exitCode };
  });

  expect(result.exitCode).toBe(0);
});
