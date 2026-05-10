// Direct unit tests for the WASIDriveFileSystemProvider — exercising the
// preview1-shaped FilesystemProvider interface without booting a wasm
// guest. Runs in the dev-server browser via Playwright like the other
// wasix specs (the provider only needs window globals from src/main.ts).

import { test, expect } from "@playwright/test";

import type { WASIDriveFileSystemProvider } from "../lib/main";

test.beforeEach(async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForLoadState("domcontentloaded");
});

test("WASIDriveFileSystemProvider: mkdir foo then rmdir foo round-trips on an empty drive", async ({
  page,
}) => {
  // WASIDrive's pathCreateDir plants a `.runno` sentinel inside every
  // directory it creates (the flat path map has no standalone directory
  // representation). The ergonomic wrapper's pathRemoveDirectory must
  // filter that sentinel before counting entries — otherwise a freshly
  // created (logically empty) directory cannot be removed and rmdir
  // returns ENOTEMPTY.
  const result = await page.evaluate(async function () {
    while ((window as any)["WASIDriveFileSystemProvider"] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const WD: typeof WASIDriveFileSystemProvider = (window as any)[
      "WASIDriveFileSystemProvider"
    ];

    const fs = new WD({});
    const ROOT_FD = 3; // WASIDrive hard-codes fd 3 as the root preopen.

    let createError: string | null = null;
    let removeError: string | null = null;
    let removeResult: number | null = null;
    try {
      fs.pathCreateDirectory(ROOT_FD, "foo");
    } catch (e: any) {
      createError = `${e?.message ?? e}`;
    }
    try {
      fs.pathRemoveDirectory(ROOT_FD, "foo");
    } catch (e: any) {
      removeError = `${e?.message ?? e}`;
      removeResult = typeof e?.result === "number" ? e.result : null;
    }

    // After a successful rmdir, statting the path should report ENOENT.
    let postStatResult: number | null = null;
    try {
      fs.pathFilestatGet(ROOT_FD, 0, "foo");
    } catch (e: any) {
      postStatResult = typeof e?.result === "number" ? e.result : null;
    }

    return { createError, removeError, removeResult, postStatResult };
  });

  expect(result.createError).toBe(null);
  expect(result.removeError).toBe(null);
  expect(result.removeResult).toBe(null);
  // Confirm the directory really is gone — pathStat over a missing
  // path surfaces ENOENT === 44 from the underlying WASIDrive. (The
  // drive used to return ENOTCAPABLE for both "not allowed" and "not
  // present", which leaked WASI's capability vocabulary into errno
  // paths that POSIX consumers expect to see ENOENT.)
  expect(result.postStatResult).toBe(44);
});

test("WASIDriveFileSystemProvider: rmdir on a non-empty directory still returns ENOTEMPTY", async ({
  page,
}) => {
  // Regression check on the surrounding behaviour: filtering the
  // `.runno` sentinel must not turn off the real ENOTEMPTY check when a
  // directory contains a genuine file alongside the sentinel.
  const result = await page.evaluate(async function () {
    while ((window as any)["WASIDriveFileSystemProvider"] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const WD: typeof WASIDriveFileSystemProvider = (window as any)[
      "WASIDriveFileSystemProvider"
    ];

    const fs = new WD({});
    const ROOT_FD = 3;

    fs.pathCreateDirectory(ROOT_FD, "foo");
    // Create a regular file under foo via O_CREAT (OpenFlags.CREAT === 1).
    const fileFd = fs.pathOpen(ROOT_FD, 0, "foo/bar.txt", 1, 0n, 0n, 0);
    fs.fdClose(fileFd);

    let removeResult: number | null = null;
    try {
      fs.pathRemoveDirectory(ROOT_FD, "foo");
    } catch (e: any) {
      removeResult = typeof e?.result === "number" ? e.result : null;
    }
    return { removeResult };
  });

  // Result.ENOTEMPTY === 55 in the wasix_32v1 ABI.
  expect(result.removeResult).toBe(55);
});
