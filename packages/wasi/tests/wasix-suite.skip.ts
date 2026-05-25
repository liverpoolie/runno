// Skip map for the wasmer/tests/wasix integration suite.
//
// Each entry keyed by the test directory name (matching the `.wasm` stem
// under `public/bin/wasix-tests/`). Tests listed here are marked
// `test.fixme()` by the Playwright spec with a structured reason token.
//
// **Token-discipline rule.** An entry whose reason token does not match
// its actual blocker is a bug. Fix the token or the underlying provider;
// don't paper over it. The vocabulary is fixed (see `SkipReason` below);
// don't invent ad-hoc tokens — if no canonical token fits, the test
// shouldn't be on this list and the underlying gap deserves its own
// follow-up issue.
//
// The notes are part of the contract too: keep them to a single sentence
// that names the concrete blocker (e.g. "wasix-libc fork() needs
// post-fork stack reification, which requires Asyncify"), not a vague
// "signals don't work".

/**
 * Canonical reason vocabulary. Pick the most specific match.
 *
 * - `requires-asyncify`            — needs Asyncify / JSPI to reify the
 *                                    guest's call stack from JS
 *                                    (post-fork resumption, async signal
 *                                    preemption, cross-frame setjmp/
 *                                    longjmp). See `WASIX-PLAN.md` §
 *                                    Future: Asyncify opt-in.
 * - `requires-provider-sockets`    — needs `SocketsProvider` semantics the
 *                                    bundled `LoopbackSocketsProvider`
 *                                    doesn't implement.
 * - `requires-provider-threads`    — needs `ThreadsProvider` semantics the
 *                                    bundled `CooperativeThreadsProvider`
 *                                    doesn't implement.
 * - `requires-provider-futex`      — needs `FutexProvider` semantics the
 *                                    bundled `SimulatedFutexProvider`
 *                                    doesn't implement.
 * - `requires-provider-signals`    — needs `SignalsProvider` semantics the
 *                                    bundled `SelfSignalProvider` doesn't
 *                                    implement.
 * - `requires-provider-proc`       — needs `ProcProvider` semantics the
 *                                    bundled `InProcessProcProvider`
 *                                    doesn't implement.
 * - `requires-provider-tty`        — needs raw `TTYProvider` ioctl
 *                                    semantics (pty / line-discipline /
 *                                    termios) beyond the
 *                                    `ConsoleTTYProvider` shim.
 * - `requires-provider-fs`         — needs `FileSystemProvider`
 *                                    semantics the bundled
 *                                    `WASIDriveFileSystemProvider`
 *                                    doesn't implement (hard links,
 *                                    symlinks, mount tables, /proc, shm).
 * - `requires-provider-poll`       — needs poll / epoll / eventfd
 *                                    syscall surface. Not yet wired in
 *                                    the runtime; an opt-in slot is
 *                                    likely a future provider extension.
 * - `requires-wasixcc-build-fix`   — test failed to build under the
 *                                    pinned wasixcc toolchain. Auto-
 *                                    populated by `build-wasix-suite.mjs`
 *                                    at prepare time; do not hand-author
 *                                    unless triaging a persistent build
 *                                    failure.
 */
export type SkipReason =
  | "requires-asyncify"
  | "requires-provider-sockets"
  | "requires-provider-threads"
  | "requires-provider-futex"
  | "requires-provider-signals"
  | "requires-provider-proc"
  | "requires-provider-tty"
  | "requires-provider-fs"
  | "requires-provider-poll"
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
 */
export const WASIX_SUITE_SKIPS: Record<string, SkipEntry> = {
  "close-preopen": {
    reason: "requires-provider-fs",
    note: "fd_renumber across preopened fds needs a mount-table that the bundled WASIDriveFileSystemProvider doesn't model.",
  },
  "closing-pre-opened-dirs": {
    reason: "requires-provider-fs",
    note: "wasmer-style libc preopen retention across user close — the bundled WASIDriveFileSystemProvider drops the fd entry on close.",
  },
  "create-and-remove-dirs": {
    reason: "requires-provider-fs",
    note: "WASIDrive's flat-path map doesn't enforce parent-dir-exists on mkdir, so the test's first negative assertion fails.",
  },
  "create-dir-at-cwd": {
    reason: "requires-provider-fs",
    note: "WASIDrive's flat-path map doesn't normalise `./` segments, so mkdirat(cwd_fd, \"./test\") writes a path subsequent stat can't find.",
  },
  "create-dir-at-cwd-with-chdir": {
    reason: "requires-provider-fs",
    note: "Same flat-path normalisation gap as create-dir-at-cwd; chdir()-relative `./` segments don't resolve to the canonical key.",
  },
  dup: {
    reason: "requires-provider-fs",
    note: "fd_renumber / dup2 semantics aren't implemented by the bundled WASIDriveFileSystemProvider.",
  },
  epoll: {
    reason: "requires-provider-poll",
    note: "Runtime has no epoll syscall surface; poll/epoll wiring is a future provider extension.",
  },
  eventfd: {
    reason: "requires-provider-poll",
    note: "eventfd is exposed as a poll-eligible fd; runtime has no poll surface yet.",
  },
  "fd-close": {
    reason: "requires-provider-sockets",
    note: "Test opens a TCP socket via socket(AF_INET, SOCK_STREAM) and asserts EBADF on second close — needs a SocketsProvider semantics path the bundled LoopbackSocketsProvider doesn't fully implement.",
  },
  fork: {
    reason: "requires-asyncify",
    note: "wasix-libc fork() reifies post-fork guest execution, which JS cannot do without Asyncify (see WASIX-PLAN § Why those tests can't be passed by providers alone).",
  },
  "fork-and-exec": {
    reason: "requires-asyncify",
    note: "fork+exec is the drop-and-replace idiom; recognising it before the post-fork code runs would need Asyncify-level introspection.",
  },
  "fork-longjmp": {
    reason: "requires-asyncify",
    note: "post-fork longjmp requires reifying the guest's call stack, only available under Asyncify.",
  },
  "fork-pipes": {
    reason: "requires-asyncify",
    note: "post-fork blocking pipe IO requires resuming the child mid-call, which needs Asyncify.",
  },
  "fork-signals": {
    reason: "requires-asyncify",
    note: "asserts on signal delivery across the post-fork boundary, which needs Asyncify-level resume.",
  },
  "fs-mount": {
    reason: "requires-provider-fs",
    note: "mount syscall needs a multi-volume mount table the bundled WASIDriveFileSystemProvider doesn't model.",
  },
  ioctl: {
    reason: "requires-provider-tty",
    note: "TTY ioctls (TIOCGWINSZ / termios) need a raw TTYProvider beyond the ConsoleTTYProvider shim.",
  },
  link: {
    reason: "requires-provider-fs",
    note: "Hard-link bookkeeping isn't modelled by the bundled WASIDriveFileSystemProvider.",
  },
  mount: {
    reason: "requires-provider-fs",
    note: "mount syscall needs a multi-volume mount table; the bundled WASIDriveFileSystemProvider exposes a single preopen root.",
  },
  "mount-tmp-locally": {
    reason: "requires-provider-fs",
    note: "mount syscall needs a multi-volume mount table the bundled WASIDriveFileSystemProvider doesn't model.",
  },
  "msync-end-of-file": {
    reason: "requires-provider-fs",
    note: "mmap / msync — the bundled WASIDriveFileSystemProvider doesn't model file-backed mappings.",
  },
  "msync-middle-of-file": {
    reason: "requires-provider-fs",
    note: "mmap / msync — the bundled WASIDriveFileSystemProvider doesn't model file-backed mappings.",
  },
  "msync-start-of-file": {
    reason: "requires-provider-fs",
    note: "mmap / msync — the bundled WASIDriveFileSystemProvider doesn't model file-backed mappings.",
  },
  "munmap-sync-end-of-file": {
    reason: "requires-provider-fs",
    note: "mmap / munmap — the bundled WASIDriveFileSystemProvider doesn't model file-backed mappings.",
  },
  "munmap-sync-middle-of-file": {
    reason: "requires-provider-fs",
    note: "mmap / munmap — the bundled WASIDriveFileSystemProvider doesn't model file-backed mappings.",
  },
  "munmap-sync-start-of-file": {
    reason: "requires-provider-fs",
    note: "mmap / munmap — the bundled WASIDriveFileSystemProvider doesn't model file-backed mappings.",
  },
  "open-under-file": {
    reason: "requires-provider-fs",
    note: "open(\"file/child\") should return ENOTDIR; WASIDrive's flat-path map doesn't validate parent type and lets the deeper path resolve.",
  },
  poll: {
    reason: "requires-provider-poll",
    note: "Runtime has no poll syscall surface yet.",
  },
  "poll-fifo": {
    reason: "requires-provider-poll",
    note: "poll-on-fifo path needs the poll syscall surface.",
  },
  popen: {
    reason: "requires-provider-proc",
    note: "popen() needs proc_spawn2 + proc_join semantics the bundled InProcessProcProvider doesn't fully implement.",
  },
  posix_spawn: {
    reason: "requires-provider-proc",
    note: "posix_spawn() needs proc_spawn2 + proc_join semantics the bundled InProcessProcProvider doesn't fully implement.",
  },
  procfs: {
    reason: "requires-provider-fs",
    note: "Wasmer-specific /proc view isn't synthesised by WASIDriveFileSystemProvider.",
  },
  ptyname: {
    reason: "requires-provider-tty",
    note: "ptyname() reads /dev/pts entries; needs a raw TTYProvider modelling pty allocation.",
  },
  "pwrite-and-size": {
    reason: "requires-provider-fs",
    note: "Test opens absolute /data/my_file.txt — needs the wasmer --volume=.:/data multi-mount layout the bundled WASIDriveFileSystemProvider doesn't model.",
  },
  "read-after-munmap": {
    reason: "requires-provider-fs",
    note: "mmap / munmap — the bundled WASIDriveFileSystemProvider doesn't model file-backed mappings.",
  },
  readlink: {
    reason: "requires-provider-fs",
    note: "Symlinks aren't represented by WASIDriveFileSystemProvider.",
  },
  shm: {
    reason: "requires-provider-fs",
    note: "POSIX shared memory needs a /dev/shm-style mount the bundled FS provider doesn't supply.",
  },
  symlink: {
    reason: "requires-provider-fs",
    note: "Symlinks aren't represented by WASIDriveFileSystemProvider.",
  },
  "symlink-open-read-write": {
    reason: "requires-provider-fs",
    note: "Symlinks aren't represented by WASIDriveFileSystemProvider.",
  },
  tty: {
    reason: "requires-provider-tty",
    note: "Asserts on TTY mode flags / line-discipline that the ConsoleTTYProvider shim doesn't model.",
  },
  vfork: {
    reason: "requires-provider-proc",
    note: "wasix-libc reuses proc_fork semantics for vfork — needs proc_fork_env + proc_exec3 the bundled InProcessProcProvider doesn't implement.",
  },
};
