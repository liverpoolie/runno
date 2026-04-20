// Skip map for the wasmer/tests/wasix integration suite.
//
// Each entry keyed by the test directory name (matching the `.wasm` stem
// under `public/bin/wasix-tests/`). Tests listed here are marked
// `test.fixme()` by the Playwright spec with a structured reason token.
//
// Guardrails (enforced by the slice-3 review):
//   - Filesystem tests are **not** allowed to carry a `filesystem-stub`
//     reason — Slice 3 ships real filesystem semantics through the
//     FileSystemProvider wiring. If a filesystem test fails, fix the
//     provider, don't skip.
//   - Reason tokens are drawn from a fixed union (`SkipReason`). Pick the
//     most specific match; add new tokens only by extending the union in
//     this file with a short comment.

/**
 * Fixed reason vocabulary. Extend by adding a new union member **and** a
 * one-line comment documenting when it applies — don't smuggle in
 * `string` escape hatches.
 */
export type SkipReason =
  // Requires a real OS process model (fork / exec / spawn / wait).
  | "process-model"
  // Requires TCP / UDP sockets that Runno's browser host does not proxy.
  | "networking"
  // Requires pthreads / wasi-threads / shared-memory support.
  | "threads"
  // Requires kernel-backed signal delivery (SIGCHLD / SIGALRM / …).
  | "signals"
  // Requires TTY ioctls / pty semantics beyond the flat TTYProvider.
  | "tty"
  // Requires filesystem features not modelled by WASIDrive (mounts,
  // hard links, real readlink/symlink). Never use for plain CRUD tests.
  | "fs-unsupported"
  // Requires epoll / eventfd / poll semantics not yet wired in WASIX.
  | "async-io"
  // Requires a feature Wasmer ships that upstream wasix-libc doesn't
  // yet expose via a public-header surface (e.g. procfs, shm, ioctl).
  | "unsupported-api"
  // Test builds but is known flaky under headless browsers (timing,
  // pty detection) — triage before skipping.
  | "flaky";

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
    reason: "unsupported-api",
    note: "fd_renumber on preopened fds; requires mount-table plumbing.",
  },
  dup: {
    reason: "unsupported-api",
    note: "fd_renumber / dup2 semantics not wired in Slice 3.",
  },
  epoll: { reason: "async-io" },
  eventfd: { reason: "async-io" },
  "fd-pipe": { reason: "process-model", note: "anonymous pipe pair" },
  fork: { reason: "process-model" },
  "fork-and-exec": { reason: "process-model" },
  "fork-longjmp": { reason: "process-model" },
  "fork-pipes": { reason: "process-model" },
  "fork-signals": { reason: "process-model" },
  ioctl: { reason: "tty" },
  link: {
    reason: "fs-unsupported",
    note: "hard links; WASIDrive has no link table.",
  },
  mount: {
    reason: "fs-unsupported",
    note: "mount syscall; Runno has a single preopen root.",
  },
  "multi-threading": { reason: "threads" },
  pipe: { reason: "process-model" },
  poll: { reason: "async-io" },
  "poll-fifo": { reason: "async-io" },
  procfs: {
    reason: "unsupported-api",
    note: "Wasmer-specific /proc view.",
  },
  ptyname: { reason: "tty" },
  readlink: {
    reason: "fs-unsupported",
    note: "Symlinks are not represented in WASIDrive.",
  },
  shm: { reason: "unsupported-api", note: "POSIX shared memory." },
  signals: { reason: "signals" },
  "socket-tcp": { reason: "networking" },
  "socket-udp": { reason: "networking" },
  sockets: { reason: "networking" },
  spawn: { reason: "process-model" },
  symlink: {
    reason: "fs-unsupported",
    note: "Symlinks are not represented in WASIDrive.",
  },
  tty: { reason: "tty" },
  "unix-pipe": { reason: "process-model" },
};
