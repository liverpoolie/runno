// Slice 5 HTTPProvider smoke spec.
//
// Worker-mode only: HTTPProvider is async-capable (fetch returns a
// Promise<Response>), and the main-thread `WASIX(...)` constructor's
// `Sync<T>` constraint already rejects async sockets providers at type
// time. Wiring the provider through `WASIXWorkerHost` lets the worker
// guest see synchronous sock_send / sock_recv while the main-thread
// provider awaits its async outgoing handler.
//
// The guest is `wasix-http-get.wasm` — a hand-rolled WAT that issues a
// fixed `GET / HTTP/1.1` request, drains the response into stdout, and
// exits 0. The host's outgoing handler returns `Response("hello\n", { status: 200 })`,
// so the assembled response includes "hello" in the body — the assertion
// looks for that substring in stdout.

import { test, expect } from "@playwright/test";

import type { WASIXWorkerHost, HTTPProvider } from "../lib/main";

test.beforeEach(async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForLoadState("domcontentloaded");
});

test("wasix-http-get (worker): HTTPProvider serves a 200 response, body reaches stdout", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    while (
      (window as unknown as { HTTPProvider?: unknown })["HTTPProvider"] ===
      undefined
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const w = window as unknown as {
      WASIXWorkerHost: typeof WASIXWorkerHost;
      HTTPProvider: typeof HTTPProvider;
    };

    let stdout = "";
    const sockets = new w.HTTPProvider({
      outgoing: () =>
        new Response("hello\n", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    });

    const host = new w.WASIXWorkerHost(
      fetch("/bin/tests/wasix-http-get.wasm"),
      {
        args: [],
        stdout: (out: string) => {
          stdout += out;
        },
        stderr: () => {},
        sockets,
      },
    );
    const r = await host.start();
    return { exitCode: r.exitCode, stdout };
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("hello");
  // Sanity: response should be a valid HTTP/1.1 response.
  expect(result.stdout).toContain("HTTP/1.1 200");
});
