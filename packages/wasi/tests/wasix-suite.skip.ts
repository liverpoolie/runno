// Skip map for the wasmer/tests/wasix integration suite.
//
// Each entry is keyed by the test directory name (matching the `.wasm`
// stem under `public/bin/wasix-tests/`). Tests listed here are marked
// `test.fixme()` by the Playwright spec with a structured reason token.
//
// Reason tokens are drawn from the fixed union below. The token names are
// a grep contract: `grep requires-provider-sockets` is meant to return
// every test blocked on that capability so a later change can flip the
// entries atomically when the provider lands.

/**
 * Fixed reason vocabulary. Pick the most specific match. Do **not**
 * extend this union without matching plan + issue discussion — the
 * tokens are shared across the whole suite.
 *
 * - `requires-asyncify`            — needs Asyncify (e.g. post-fork longjmp).
 * - `requires-provider-sockets`    — needs SocketProvider.
 * - `requires-provider-threads`    — needs ThreadsProvider.
 * - `requires-provider-futex`      — needs FutexProvider.
 * - `requires-provider-signals`    — needs SignalProvider.
 * - `requires-provider-proc`       — needs ProcessProvider / proc_fork /
 *                                    proc_exec / proc_spawn.
 * - `requires-future-feature`      — capability scheduled for a later
 *                                    change where no single provider
 *                                    token fits (e.g. TTY, poll/epoll,
 *                                    drive extraction).
 */
export type SkipReason =
  | "requires-asyncify"
  | "requires-provider-sockets"
  | "requires-provider-threads"
  | "requires-provider-futex"
  | "requires-provider-signals"
  | "requires-provider-proc"
  | "requires-future-feature";

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
 * Classification notes:
 *   - `fork*` / `spawn` / `pipe` / `unix-pipe` / `fd-pipe` →
 *     `requires-provider-proc`. `fork-longjmp` additionally needs
 *     Asyncify, which is the harder blocker so it picks
 *     `requires-asyncify` instead.
 *   - `multi-threading` → `requires-provider-threads`.
 *   - `socket-*`, `sockets` → `requires-provider-sockets`.
 *   - `signals`, `fork-signals` → `requires-provider-signals`.
 *   - `epoll` / `eventfd` / `poll` / `poll-fifo` → poll surface
 *     (`requires-future-feature`).
 *   - `tty` / `ptyname` / `ioctl` → TTY work (`requires-future-feature`).
 *   - `link`, `mount`, `readlink`, `symlink`, `shm`, `procfs` → drive
 *     features not yet represented (`requires-future-feature`).
 *   - `close-preopen`, `dup` → fd-table re-binding via `fd_renumber`,
 *     stubbed ENOSYS at the WASIX layer pending the fd-table extraction
 *     (`requires-future-feature`).
 */
export const WASIX_SUITE_SKIPS: Record<string, SkipEntry> = {
  "close-preopen": {
    reason: "requires-future-feature",
    note:
      "fd-table re-binding after closing a preopen needs fd_renumber, " +
      "currently stubbed ENOSYS pending the WASIDrive fd-table extraction.",
  },
  dup: {
    reason: "requires-future-feature",
    note:
      "dup2 = fd_renumber, deliberately stubbed ENOSYS — fd-table mgmt " +
      "is co-located with WASIDrive and will lift later.",
  },
  epoll: {
    reason: "requires-future-feature",
    note: "epoll surface lands with the poll feature.",
  },
  eventfd: {
    reason: "requires-future-feature",
    note: "eventfd surface lands with the poll feature.",
  },
  "fd-pipe": {
    reason: "requires-provider-proc",
    note: "anonymous pipe pair — needs process/pipe plumbing.",
  },
  fork: { reason: "requires-provider-proc" },
  "fork-and-exec": { reason: "requires-provider-proc" },
  "fork-longjmp": {
    // Needs both Asyncify (post-fork longjmp) and the process provider.
    // Asyncify is the harder blocker so it wins the token.
    reason: "requires-asyncify",
    note: "post-fork longjmp requires Asyncify.",
  },
  "fork-pipes": { reason: "requires-provider-proc" },
  "fork-signals": {
    reason: "requires-provider-signals",
    note: "signal delivery across fork — signals provider drives this.",
  },
  ioctl: {
    reason: "requires-future-feature",
    note: "TTY ioctls — lands with TTY work.",
  },
  link: {
    reason: "requires-future-feature",
    note: "hard links; WASIDrive has no link table.",
  },
  mount: {
    reason: "requires-future-feature",
    note: "mount syscall; Runno has a single preopen root.",
  },
  "multi-threading": { reason: "requires-provider-threads" },
  pipe: { reason: "requires-provider-proc" },
  poll: {
    reason: "requires-future-feature",
    note: "poll surface lands with the poll feature.",
  },
  "poll-fifo": {
    reason: "requires-future-feature",
    note: "poll surface lands with the poll feature.",
  },
  procfs: {
    reason: "requires-future-feature",
    note: "Wasmer-specific /proc view — deferred alongside drive extraction.",
  },
  ptyname: {
    reason: "requires-future-feature",
    note: "TTY feature — lands with TTY work.",
  },
  readlink: {
    reason: "requires-future-feature",
    note: "Symlinks are not represented in WASIDrive.",
  },
  shm: {
    reason: "requires-future-feature",
    note: "POSIX shared memory — deferred alongside drive extraction.",
  },
  signals: { reason: "requires-provider-signals" },
  "socket-tcp": { reason: "requires-provider-sockets" },
  "socket-udp": { reason: "requires-provider-sockets" },
  sockets: { reason: "requires-provider-sockets" },
  spawn: { reason: "requires-provider-proc" },
  symlink: {
    reason: "requires-future-feature",
    note: "Symlinks are not represented in WASIDrive.",
  },
  tty: {
    reason: "requires-future-feature",
    note: "TTY semantics — lands with TTY work.",
  },
  "unix-pipe": { reason: "requires-provider-proc" },
};
