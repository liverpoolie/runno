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
 *   - `socket-*`, `sockets` → `requires-provider-sockets`. As of Slice 5
 *     these may be drivable by `LoopbackSocketsProvider` in-process;
 *     the first CI run that builds them with wasixcc should try
 *     removing those entries to confirm.
 *   - `signals` — passes under SelfSignalProvider; the entry was
 *     dropped from this map.
 *   - `fork-signals` → `requires-provider-proc` (handlers work
 *     in-process; the test specifically exercises signal delivery
 *     across the fork boundary, which the proc provider lands).
 *   - `epoll` / `eventfd` / `poll` / `poll-fifo` → poll surface
 *     (`requires-future-feature`).
 *   - `tty` / `ptyname` / `ioctl` → TTY work (`requires-future-feature`).
 *   - `link`, `mount`, `readlink`, `symlink`, `shm`, `procfs` → drive
 *     features not yet represented (`requires-future-feature`).
 *   - `close-preopen`, `dup` → fd-table re-binding via `fd_renumber`,
 *     stubbed ENOSYS at the WASIX layer pending the fd-table extraction
 *     (`requires-future-feature`).
 */
// The remaining FS-category carve-outs hit drive-level limitations that
// surface only once cwd plumbing lets the binary actually exercise the
// flat-path WASIDrive (Slice 3.5 added getcwd / chdir / /home preopen,
// which unblocked the rest of the wasmer cwd tests). The drive will be
// extracted and grown in a follow-up; until then these stay carved out
// with the underlying root-cause noted, not the cwd label they used to
// share.
const REQUIRES_DRIVE_PATH_NORMALIZATION: SkipEntry = {
  reason: "requires-future-feature",
  note:
    "WASIDrive's flat-path map does not normalise `./` / `/./` segments. " +
    'wasmer\'s mkdirat(cwd_fd, "./testN") writes /home/./testN/.runno, ' +
    'which subsequent stat("testN") cannot find. Lifts with the drive ' +
    "extraction in a later slice.",
};

export const WASIX_SUITE_SKIPS: Record<string, SkipEntry> = {
  // ── Drive-level limitations exposed by cwd plumbing ───────────────
  "create-dir-at-cwd": REQUIRES_DRIVE_PATH_NORMALIZATION,
  "create-dir-at-cwd-with-chdir": REQUIRES_DRIVE_PATH_NORMALIZATION,
  "create-and-remove-dirs": {
    reason: "requires-future-feature",
    note:
      "WASIDrive does not enforce `parent dir must exist` on mkdir — " +
      'mkdir("test1/test2") succeeds before mkdir("test1"), so the ' +
      "test fails its first negative assertion. Drive-level fix.",
  },
  "closing-pre-opened-dirs": {
    reason: "requires-future-feature",
    note:
      'test closes preopen fds 3-5 then calls opendir("."); wasmer keeps ' +
      "the cwd preopen accessible via libc-cached state across close, but " +
      "Runno's drive drops the fd entry on close so the subsequent open " +
      "fails. Needs the wasmer-style libc preopen retention.",
  },
  "open-under-file": {
    reason: "requires-future-feature",
    note:
      'open("parent/child") when `parent` is a regular file should ' +
      "return ENOTDIR; WASIDrive happily creates the deeper path because " +
      "the flat-path map does not validate parent type. Drive-level fix.",
  },
  "pwrite-and-size": {
    reason: "requires-future-feature",
    note:
      "needs --volume=.:/data preopen mount (the test opens absolute " +
      "/data/my_file.txt). Single-preopen WASIDrive can't model the " +
      "wasmer multi-mount layout yet.",
  },
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
  "fd-close": {
    reason: "requires-provider-sockets",
    note:
      "test opens a TCP socket via socket(AF_INET, SOCK_STREAM) and " +
      "expects close(fd) plus EBADF on second close. Needs " +
      "SocketsProvider + /bin preopen.",
  },
  "fs-mount": {
    reason: "requires-future-feature",
    note: "mount syscall; Runno has a single preopen root.",
  },
  "mount-tmp-locally": {
    reason: "requires-future-feature",
    note: "mount syscall; Runno has a single preopen root.",
  },
  "msync-end-of-file": {
    reason: "requires-future-feature",
    note: "mmap / msync — WASIDrive doesn't model file-backed mappings.",
  },
  "msync-middle-of-file": {
    reason: "requires-future-feature",
    note: "mmap / msync — WASIDrive doesn't model file-backed mappings.",
  },
  "msync-start-of-file": {
    reason: "requires-future-feature",
    note: "mmap / msync — WASIDrive doesn't model file-backed mappings.",
  },
  "munmap-sync-end-of-file": {
    reason: "requires-future-feature",
    note: "mmap / munmap — WASIDrive doesn't model file-backed mappings.",
  },
  "munmap-sync-middle-of-file": {
    reason: "requires-future-feature",
    note: "mmap / munmap — WASIDrive doesn't model file-backed mappings.",
  },
  "munmap-sync-start-of-file": {
    reason: "requires-future-feature",
    note: "mmap / munmap — WASIDrive doesn't model file-backed mappings.",
  },
  popen: {
    reason: "requires-provider-proc",
    note: "needs proc_spawn2 + proc_join (proc provider).",
  },
  posix_spawn: {
    reason: "requires-provider-proc",
    note: "needs proc_spawn2 + proc_join (proc provider).",
  },
  "read-after-munmap": {
    reason: "requires-future-feature",
    note: "mmap / munmap — WASIDrive doesn't model file-backed mappings.",
  },
  "symlink-open-read-write": {
    reason: "requires-future-feature",
    note: "symlinks are not represented in WASIDrive.",
  },
  udp: {
    reason: "requires-provider-sockets",
    note: "raw UDP send/recv — needs SocketsProvider.",
  },
  vfork: {
    reason: "requires-provider-proc",
    note:
      "needs proc_fork_env + proc_exec3 (proc provider). Distinct from " +
      "POSIX vfork — wasix-libc reuses proc_fork semantics.",
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
    reason: "requires-provider-proc",
    note:
      "Slice 7 status: signal handlers + raise() work in-process; this " +
      "test exercises signal delivery across a fork boundary, which " +
      "requires the proc fabric (Slice 8) to flow signals between " +
      "parent and child.",
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
  // multi-threading + condvar removed in Slice 6 — both pass under
  // CooperativeThreadsProvider + SimulatedFutexProvider.
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
  // signals removed in Slice 7 — handler register + raise + raise_interval
  // pass under SelfSignalProvider. Sub-tests that require asynchronous
  // preemption (signal delivered from outside the current syscall frame)
  // would need Asyncify and remain off-the-table per the plan.
  "socket-tcp": {
    reason: "requires-provider-sockets",
    note:
      "Slice 5 status: drivable by LoopbackSocketsProvider; remove this " +
      "entry once a wasixcc-built run confirms it passes. This token is " +
      "expected to be obsolete for socket-tcp.",
  },
  "socket-udp": {
    reason: "requires-provider-sockets",
    note:
      "Slice 5 status: drivable by LoopbackSocketsProvider (DGRAM path); " +
      "remove this entry once a wasixcc-built run confirms it passes. " +
      "This token is expected to be obsolete for socket-udp.",
  },
  sockets: {
    reason: "requires-provider-sockets",
    note:
      "Slice 5 status: drivable by LoopbackSocketsProvider; remove this " +
      "entry once a wasixcc-built run confirms it passes. This token is " +
      "expected to be obsolete for the catch-all `sockets` test.",
  },
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
