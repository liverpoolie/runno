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
// The prestat guest is `programs/wasix-bridge-fs/wasix-bridge-fs.wat`. The
// chunked-fdRead guest is `programs/wasix-bridge-fs-chunked-read/…wat`.
// Both compile to `public/bin/tests/*.wasm` via the `build:tests` script.

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

  test("fdRead splits a >64 KiB single-iovec read across chunks", async ({
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

      // Track each chunked fdRead invocation. With the default bridge buffer
      // (64 KiB request region, ~4 KiB framing headroom) chunkLimit is
      // 61_440 bytes, so a 100_000-byte iovec splits into 2 round trips.
      const chunkSizes: number[] = [];

      // File offset cursor — the provider mirrors a real FS by returning a
      // contiguous stream of pattern bytes, where byte[i] = (i + 1) mod 256.
      // Picking 0 as a never-emitted value makes a buggy zero-fill instantly
      // detectable in the guest's byte checks.
      let cursor = 0;

      const asyncFs: AsyncFileSystemProvider = {
        fdRead(_fd: number, bufs: Uint8Array[]) {
          return new Promise((resolve) =>
            setTimeout(() => {
              let total = 0;
              for (const buf of bufs) {
                chunkSizes.push(buf.byteLength);
                for (let i = 0; i < buf.byteLength; i++) {
                  buf[i] = (cursor + i + 1) % 256;
                }
                cursor += buf.byteLength;
                total += buf.byteLength;
              }
              resolve(total);
            }, 0),
          );
        },
        // Other methods aren't exercised — defensive throws make any typo
        // on the guest surface visible immediately.
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
        fdPrestatGet: () => {
          throw new Error("unexpected fdPrestatGet");
        },
        fdPrestatDirName: () => {
          throw new Error("unexpected fdPrestatDirName");
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
        fetch("/bin/tests/wasix-bridge-fs-chunked-read.wasm"),
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
      return { exitCode, chunkSizes, debugLines };
    });

    // Exit 0 == every check (rc, retptr, byte-pattern at 0/40000/99999) passed.
    expect(
      result.exitCode,
      `chunkSizes: ${JSON.stringify(result.chunkSizes)}\ndebug:\n${result.debugLines.join("\n")}`,
    ).toBe(0);
    // At least two round trips — proves the worker shim split the 100_000-byte
    // iovec instead of issuing it as a single request that would overflow the
    // 64 KiB region.
    expect(result.chunkSizes.length).toBeGreaterThanOrEqual(2);
    // The chunks sum to the requested 100_000 bytes.
    expect(result.chunkSizes.reduce((a, b) => a + b, 0)).toBe(100_000);
    // Every chunk fits in the (default-derived) chunk limit, well under 64 KiB.
    for (const size of result.chunkSizes) {
      expect(size).toBeLessThanOrEqual(64 * 1024);
    }
  });
});
