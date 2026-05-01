// Constants shared between the build script, the fetch script, and the
// Playwright spec. Run by Node directly via `--experimental-strip-types`
// (Node 22.6+); imported by Playwright's TS pipeline for the spec.

/**
 * Pinned wasmer SHA. To bump:
 *   1. Update the constant here.
 *   2. Re-run `npm run test:prepare:wasmer` to refresh the vendored
 *      `tests/wasix-vendor/wasmer/` checkout.
 *   3. Triage any newly-failing tests into `wasix-suite.skip.ts`.
 */
export const WASMER_SHA = "261a337d428148a9f06884c10478dd634a1f1da7";

/**
 * Relative path (from `packages/wasi/`) where the vendored wasmer checkout
 * lives. Kept out of git — `.gitignore` excludes `tests/wasix-vendor/`.
 */
export const WASIX_VENDOR_DIR = "tests/wasix-vendor";

/**
 * Output directory for built .wasm binaries, relative to `packages/wasi/`.
 * The Playwright spec fetches from `/bin/wasix-tests/<name>.wasm`.
 */
export const WASIX_SUITE_BIN_DIR = "public/bin/wasix-tests";

/**
 * Hand-maintained list of `wasmer/tests/wasix/<dir>` test cases the build
 * harness will compile and the Playwright spec will run.
 *
 * The set is the intersection of:
 *   1. Tests in upstream `wasmer/tests/wasix/` at `WASMER_SHA`.
 *   2. Tests that compile and link against the wasix-libc sysroot
 *      shipped by `wasix-org/wasixcc@v0.4.3`. Tests that need
 *      `fork` / `pthread_create` / `dlopen` / `<dlfcn.h>` are excluded
 *      because the linkable symbols aren't present in this toolchain
 *      release. They re-enter the set when the toolchain (or a
 *      provider) makes them buildable.
 *
 * The runtime skip map in `wasix-suite.skip.ts` covers tests that
 * *do* build but exercise capabilities not yet wired into WASIX
 * (sockets, signals, etc.).
 *
 * Keep alphabetised.
 */
export const WASIX_INCLUDE_DIRS: readonly string[] = [
  "closing-pre-opened-dirs",
  "create-and-remove-dirs",
  "create-dir-at-cwd",
  "create-dir-at-cwd-with-chdir",
  "cross-fs-rename",
  "cwd-to-home",
  "distinct-inodes-same-basename",
  "exception",
  "fd-close",
  "fs-mount",
  "fstatat-with-chdir",
  "mount-tmp-locally",
  "msync-end-of-file",
  "msync-middle-of-file",
  "msync-start-of-file",
  "munmap-sync-end-of-file",
  "munmap-sync-middle-of-file",
  "munmap-sync-start-of-file",
  "open-under-file",
  "popen",
  "posix_spawn",
  "pwrite-and-size",
  "read-after-munmap",
  "symlink-open-read-write",
  "udp",
  "vfork",
];
