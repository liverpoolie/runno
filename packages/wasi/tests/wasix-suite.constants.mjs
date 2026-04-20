// Plain ES-module constants shared between the TypeScript Playwright
// spec and the Node build script. Kept as `.mjs` so `node` can import
// it directly (no ts-loader), while `wasix-suite.config.ts` re-exports
// from here for type-checked consumers.
//
// When bumping the pinned wasmer SHA, update this file only — the `.ts`
// facade just re-exports.

/**
 * Pinned wasmer SHA (2026-04-21). To bump:
 *   1. Update the constant here.
 *   2. Re-run `npm run test:prepare:wasmer` to refresh the vendored
 *      `tests/wasix-vendor/wasmer/` checkout.
 *   3. Triage any newly-failing tests into `wasix-suite.skip.ts`.
 */
export const WASMER_SHA = "261a337d428148a9f06884c10478dd634a1f1da7";

/**
 * Subdirectories under `wasmer/tests/wasix/` to attempt to build.
 * Missing directories are skipped by the build script.
 */
export const WASIX_INCLUDE_DIRS = [
  "close-preopen",
  "create-dir",
  "dup",
  "epoll",
  "eventfd",
  "exec-env",
  "fd-pipe",
  "fdatasync",
  "file-metadata",
  "fork",
  "fork-and-exec",
  "fork-longjmp",
  "fork-pipes",
  "fork-signals",
  "fs-rename",
  "fsync",
  "fyi",
  "ioctl",
  "link",
  "longjmp",
  "main-args",
  "mount",
  "multi-threading",
  "pipe",
  "poll",
  "poll-fifo",
  "procfs",
  "ptyname",
  "readlink",
  "shm",
  "signals",
  "sleep",
  "socket-tcp",
  "socket-udp",
  "sockets",
  "spawn",
  "stat-mode",
  "static-lookup",
  "symlink",
  "tty",
  "unix-pipe",
];

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
