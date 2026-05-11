// Targeted round-trip spec for the Slice 4.1 FS bridge.
//
// Proves end-to-end:
//   1. WASIXWorkerHost spawns a dedicated worker against a real wasm guest.
//   2. The worker recognises the host's `AsyncFileSystemProvider` and routes
//      FS_FD_PRESTAT_GET / FS_FD_PRESTAT_DIR_NAME through the bridge.
//   3. The provider returns Promises that resolve after a setTimeout(0) —
//      the host dispatcher awaits them before writing the response.
//   4. The worker-side guest receives the decoded values synchronously via
//      `Atomics.wait`, and wasix.ts marshals them into guest memory.
//
// The guest is `programs/wasix-bridge-fs/wasix-bridge-fs.wat`, built to
// `public/bin/tests/wasix-bridge-fs.wasm` by the existing `build:tests`
// script.

import { test, expect } from "@playwright/test";

import type { WASIXWorkerHost, AsyncFileSystemProvider } from "../lib/main";

test.describe("wasix-worker-bridge fs", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:5173");
    await page.waitForLoadState("domcontentloaded");
  });

  test("fd_prestat_get + fd_prestat_dir_name round trip", async ({ page }) => {
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

      const calls: string[] = [];
      const asyncFs: AsyncFileSystemProvider = {
        fdPrestatGet(fd: number) {
          calls.push(`fdPrestatGet:${fd}`);
          return new Promise((resolve) =>
            setTimeout(() => resolve({ name: "/probe" }), 0),
          );
        },
        fdPrestatDirName(fd: number) {
          calls.push(`fdPrestatDirName:${fd}`);
          return new Promise((resolve) =>
            setTimeout(() => resolve("/probe"), 0),
          );
        },
        // Other methods aren't exercised by the test guest. Defensive
        // throws make a typo on the guest side surface immediately.
        fdRead: () => {
          throw new Error("unexpected fdRead");
        },
        fdWrite: () => {
          throw new Error("unexpected fdWrite");
        },
        fdSeek: () => {
          throw new Error("unexpected fdSeek");
        },
        fdClose: () => {
          throw new Error("unexpected fdClose");
        },
        fdFdstatGet: () => {
          throw new Error("unexpected fdFdstatGet");
        },
        fdFdstatSetFlags: () => {
          throw new Error("unexpected fdFdstatSetFlags");
        },
        fdFilestatGet: () => {
          throw new Error("unexpected fdFilestatGet");
        },
        fdReaddir: () => {
          throw new Error("unexpected fdReaddir");
        },
        pathOpen: () => {
          throw new Error("unexpected pathOpen");
        },
        pathFilestatGet: () => {
          throw new Error("unexpected pathFilestatGet");
        },
        pathCreateDirectory: () => {
          throw new Error("unexpected pathCreateDirectory");
        },
        pathUnlinkFile: () => {
          throw new Error("unexpected pathUnlinkFile");
        },
        pathRemoveDirectory: () => {
          throw new Error("unexpected pathRemoveDirectory");
        },
        pathRename: () => {
          throw new Error("unexpected pathRename");
        },
      };

      const debugLines: string[] = [];
      const host = new w.WASIXWorkerHost(
        fetch("/bin/tests/wasix-bridge-fs.wasm"),
        {
          fs: asyncFs,
          debug: (name, args, ret, data) => {
            debugLines.push(
              `${name}(${args.join(",")})=${ret} ${JSON.stringify(data)}`,
            );
          },
        },
      );
      const { exitCode } = await host.start();
      return { exitCode, calls, debugLines };
    });

    // Guest exits with the result code of fd_prestat_dir_name. SUCCESS == 0.
    expect(
      result.exitCode,
      `calls: ${JSON.stringify(result.calls)}\ndebug:\n${result.debugLines.join("\n")}`,
    ).toBe(0);
    expect(result.calls).toEqual(["fdPrestatGet:3", "fdPrestatDirName:3"]);
  });
});
