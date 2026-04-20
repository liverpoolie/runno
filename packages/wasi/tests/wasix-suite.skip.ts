// Skip map for the wasmer/tests/wasix integration suite.
//
// Each entry keyed by the test directory name (matching the `.wasm` stem
// under `public/bin/wasix-tests/`). Tests listed here are marked
// `test.fixme()` by the Playwright spec with a structured reason token.
//
// Guardrails (enforced by the slice-3 review):
//   - Filesystem tests are **not** allowed to carry a
//     `requires-wasixcc-build-fix` reason permanently — Slice 3 ships real
//     filesystem semantics through the FileSystemProvider wiring. If a
//     filesystem test fails at runtime, fix the provider, don't skip.
//   - Reason tokens are drawn from the fixed union specified in Issue #4.
//     The token names are a grep contract: `grep requires-provider-sockets`
//     is meant to return every test blocked on that capability, so later
//     slices can flip the entries atomically when the provider lands.

/**
 * Fixed reason vocabulary from Issue #4 (Slice 3 exit criteria). Pick the
 * most specific match. Do **not** extend this union without matching
 * plan + issue discussion — the tokens are shared across slices.
 *
 * - `requires-asyncify`            — needs Asyncify (e.g. post-fork longjmp).
 * - `requires-provider-sockets`    — needs SocketProvider (Slice 6).
 * - `requires-provider-threads`    — needs ThreadsProvider (Slice 4/5).
 * - `requires-provider-futex`      — needs FutexProvider (Slice 5).
 * - `requires-provider-signals`    — needs SignalProvider (Slice 7).
 * - `requires-provider-proc`       — needs ProcessProvider / proc_fork /
 *                                    proc_exec / proc_spawn (Slice 8).
 * - `requires-slice-N`             — needs a capability scheduled for a
 *                                    later slice (N = 3..10). Use this
 *                                    when no single provider token fits
 *                                    (e.g. TTY features, poll/epoll).
 * - `requires-wasixcc-build-fix`   — test failed to build under wasixcc.
 *                                    Auto-populated by `build-wasix-suite.mjs`
 *                                    at prepare time; do not hand-author
 *                                    unless you've triaged a persistent
 *                                    build failure.
 */
export type SkipReason =
  | "requires-asyncify"
  | "requires-provider-sockets"
  | "requires-provider-threads"
  | "requires-provider-futex"
  | "requires-provider-signals"
  | "requires-provider-proc"
  | "requires-slice-3"
  | "requires-slice-4"
  | "requires-slice-5"
  | "requires-slice-6"
  | "requires-slice-7"
  | "requires-slice-8"
  | "requires-slice-9"
  | "requires-slice-10"
  | "requires-wasixcc-build-fix";

export type SkipEntry = {
  reason: SkipReason;
  /** Optional free-form note — triage link, upstream bug, etc. */
  note?: string;
};

/**
 * Skip map: `<test-name>` → skip reason.
 *
 * Keep entries alphabetised; `wasix-suite.spec.ts` reads this map and
 * marks each matching test `test.fixme(true, reason)`.
 *
 * Classification notes (for later slices un-skipping their own entries):
 *   - `fork*` / `spawn` / `pipe` / `unix-pipe` / `fd-pipe` → Slice 8
 *     (process provider) via `requires-provider-proc`. `fork-longjmp`
 *     additionally needs `requires-asyncify`, picking the more specific
 *     token per the plan (process comes first on the critical path).
 *   - `multi-threading` → `requires-provider-threads` (Slice 4/5).
 *   - `socket-*`, `sockets` → `requires-provider-sockets` (Slice 6).
 *   - `signals`, `fork-signals` → `requires-provider-signals` (Slice 7).
 *   - `epoll` / `eventfd` / `poll` / `poll-fifo` → Slice 5 poll surface.
 *   - `tty` / `ptyname` / `ioctl` → TTY work (Slice 10 grab-bag).
 *   - `link`, `mount`, `readlink`, `symlink`, `shm`, `procfs` → Slice 9
 *     (filesystem extraction) where WASIDrive grows the missing pieces.
 *   - `close-preopen`, `dup` → rely on fd_renumber / mount-table work
 *     deferred to Slice 9 alongside the drive refactor.
 */
export const WASIX_SUITE_SKIPS: Record<string, SkipEntry> = {
  "close-preopen": {
    reason: "requires-slice-9",
    note: "fd_renumber on preopened fds; requires mount-table plumbing.",
  },
  dup: {
    reason: "requires-slice-9",
    note: "fd_renumber / dup2 semantics not wired in Slice 3.",
  },
  epoll: {
    reason: "requires-slice-5",
    note: "epoll surface lands with poll slice.",
  },
  eventfd: {
    reason: "requires-slice-5",
    note: "eventfd surface lands with poll slice.",
  },
  "fd-pipe": {
    reason: "requires-provider-proc",
    note: "anonymous pipe pair — needs process/pipe plumbing.",
  },
  fork: { reason: "requires-provider-proc" },
  "fork-and-exec": { reason: "requires-provider-proc" },
  "fork-longjmp": {
    // Needs both Asyncify (post-fork longjmp) and the process provider.
    // The plan flags Asyncify as the blocker it cannot un-skip; favour
    // that token so the grep on `requires-asyncify` surfaces this test.
    reason: "requires-asyncify",
    note: "post-fork longjmp requires Asyncify (plan § Future-asyncify).",
  },
  "fork-pipes": { reason: "requires-provider-proc" },
  "fork-signals": {
    reason: "requires-provider-signals",
    note: "signal delivery across fork — signals provider drives this.",
  },
  ioctl: {
    reason: "requires-slice-10",
    note: "TTY ioctls — lands with TTY slice.",
  },
  link: {
    reason: "requires-slice-9",
    note: "hard links; WASIDrive has no link table.",
  },
  mount: {
    reason: "requires-slice-9",
    note: "mount syscall; Runno has a single preopen root.",
  },
  "multi-threading": { reason: "requires-provider-threads" },
  pipe: { reason: "requires-provider-proc" },
  poll: {
    reason: "requires-slice-5",
    note: "poll surface lands with Slice 5.",
  },
  "poll-fifo": {
    reason: "requires-slice-5",
    note: "poll surface lands with Slice 5.",
  },
  procfs: {
    reason: "requires-slice-9",
    note: "Wasmer-specific /proc view — deferred to filesystem extraction.",
  },
  ptyname: {
    reason: "requires-slice-10",
    note: "TTY feature — lands with TTY slice.",
  },
  readlink: {
    reason: "requires-slice-9",
    note: "Symlinks are not represented in WASIDrive.",
  },
  shm: {
    reason: "requires-slice-9",
    note: "POSIX shared memory — deferred alongside filesystem extraction.",
  },
  signals: { reason: "requires-provider-signals" },
  "socket-tcp": { reason: "requires-provider-sockets" },
  "socket-udp": { reason: "requires-provider-sockets" },
  sockets: { reason: "requires-provider-sockets" },
  spawn: { reason: "requires-provider-proc" },
  symlink: {
    reason: "requires-slice-9",
    note: "Symlinks are not represented in WASIDrive.",
  },
  tty: {
    reason: "requires-slice-10",
    note: "TTY semantics — lands with TTY slice.",
  },
  "unix-pipe": { reason: "requires-provider-proc" },
};
