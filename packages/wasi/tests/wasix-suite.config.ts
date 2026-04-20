// Pinned configuration for the wasmer/tests/wasix integration suite.
//
// The suite's C sources are vendored from wasmerio/wasmer at the SHA below.
// Bumping the SHA is a deliberate change — update both this constant and
// the date comment when re-pinning.
//
// Suite layout under `wasmerio/wasmer`:
//   tests/wasix/<test-name>/main.c      — per-test C source
//   tests/wasix/<test-name>/expected    — (optional) expected stdout
//
// `includeDirs` lists the test directories we attempt to build into
// `public/bin/wasix-tests/<name>.wasm`. Tests absent from the vendored
// checkout are silently skipped by `build-wasix-suite.mjs`.
//
// The skip map lives in `wasix-suite.skip.ts` — keep it co-located with
// the Playwright spec that reads it.

/**
 * Pinned wasmer SHA (2026-04-21). To bump:
 *   1. Bump the constant here.
 *   2. Re-run `npm run test:prepare:wasmer` in `packages/wasi/` to refresh
 *      the vendored `tests/wasix-vendor/wasmer/` checkout.
 *   3. Triage any newly-failing tests into `wasix-suite.skip.ts`.
 */
export const WASMER_SHA = "261a337d428148a9f06884c10478dd634a1f1da7";

/**
 * Subdirectories under `wasmer/tests/wasix/` to build. Each entry maps to
 * `<entry>/main.c` → `public/bin/wasix-tests/<entry>.wasm`. Missing
 * directories are skipped during build; the Playwright spec only iterates
 * over binaries that actually landed in `public/bin/wasix-tests/`.
 */
export const WASIX_INCLUDE_DIRS: string[] = [
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
