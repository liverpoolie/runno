// ABI definitions for the wasix_32v1 import namespace.
// Mirrors the structure of lib/wasi/snapshot-preview1.ts.
// See: https://github.com/wasix-org/wasix

// ─── Errno ───────────────────────────────────────────────────────────────────

export enum Result {
  SUCCESS = 0,
  E2BIG = 1,
  EACCES = 2,
  EADDRINUSE = 3,
  EADDRNOTAVAIL = 4,
  EAFNOSUPPORT = 5,
  EAGAIN = 6,
  EALREADY = 7,
  EBADF = 8,
  EBADMSG = 9,
  EBUSY = 10,
  ECANCELED = 11,
  ECHILD = 12,
  ECONNABORTED = 13,
  ECONNREFUSED = 14,
  ECONNRESET = 15,
  EDEADLK = 16,
  EDESTADDRREQ = 17,
  EDOM = 18,
  EDQUOT = 19,
  EEXIST = 20,
  EFAULT = 21,
  EFBIG = 22,
  EHOSTUNREACH = 23,
  EIDRM = 24,
  EILSEQ = 25,
  EINPROGRESS = 26,
  EINTR = 27,
  EINVAL = 28,
  EIO = 29,
  EISCONN = 30,
  EISDIR = 31,
  ELOOP = 32,
  EMFILE = 33,
  EMLINK = 34,
  EMSGSIZE = 35,
  EMULTIHOP = 36,
  ENAMETOOLONG = 37,
  ENETDOWN = 38,
  ENETRESET = 39,
  ENETUNREACH = 40,
  ENFILE = 41,
  ENOBUFS = 42,
  ENODEV = 43,
  ENOENT = 44,
  ENOEXEC = 45,
  ENOLCK = 46,
  ENOLINK = 47,
  ENOMEM = 48,
  ENOMSG = 49,
  ENOPROTOOPT = 50,
  ENOSPC = 51,
  ENOSYS = 52,
  ENOTCONN = 53,
  ENOTDIR = 54,
  ENOTEMPTY = 55,
  ENOTRECOVERABLE = 56,
  ENOTSOCK = 57,
  ENOTSUP = 58,
  ENOTTY = 59,
  ENXIO = 60,
  EOVERFLOW = 61,
  EOWNERDEAD = 62,
  EPERM = 63,
  EPIPE = 64,
  EPROTO = 65,
  EPROTONOSUPPORT = 66,
  EPROTOTYPE = 67,
  ERANGE = 68,
  EROFS = 69,
  ESPIPE = 70,
  ESRCH = 71,
  ESTALE = 72,
  ETIMEDOUT = 73,
  ETXTBSY = 74,
  EXDEV = 75,
  ENOTCAPABLE = 76,
}

// ─── Clock IDs ────────────────────────────────────────────────────────────────

export enum ClockId {
  REALTIME = 0,
  MONOTONIC = 1,
  PROCESS_CPUTIME = 2,
  THREAD_CPUTIME = 3,
}

// ─── Signal numbers ───────────────────────────────────────────────────────────

export enum Signal {
  SIGHUP = 1,
  SIGINT = 2,
  SIGQUIT = 3,
  SIGILL = 4,
  SIGTRAP = 5,
  SIGABRT = 6,
  SIGBUS = 7,
  SIGFPE = 8,
  SIGKILL = 9,
  SIGUSR1 = 10,
  SIGSEGV = 11,
  SIGUSR2 = 12,
  SIGPIPE = 13,
  SIGALRM = 14,
  SIGTERM = 15,
  SIGCHLD = 17,
  SIGCONT = 18,
  SIGSTOP = 19,
  SIGTSTP = 20,
  SIGTTIN = 21,
  SIGTTOU = 22,
  SIGURG = 23,
  SIGXCPU = 24,
  SIGXFSZ = 25,
  SIGVTALRM = 26,
  SIGPROF = 27,
  SIGWINCH = 28,
  SIGPOLL = 29,
  SIGPWR = 30,
  SIGSYS = 31,
}

// ─── Filesystem ABI ──────────────────────────────────────────────────────────
//
// Only the constants and layouts needed by the filesystem syscalls wired in
// Slice 3 live here. Future slices append as needed. Mirrors the preview1
// shapes in lib/wasi/snapshot-preview1.ts.

/** File type (filestat::filetype, dirent::d_type). */
export enum FileType {
  UNKNOWN = 0,
  BLOCK_DEVICE = 1,
  CHARACTER_DEVICE = 2,
  DIRECTORY = 3,
  REGULAR_FILE = 4,
  SOCKET_DGRAM = 5,
  SOCKET_STREAM = 6,
  SYMBOLIC_LINK = 7,
}

/** Preopen tag returned from fd_prestat_get. */
export enum PreopenType {
  DIR = 0,
}

/** fd_seek whence. */
export enum Whence {
  SET = 0,
  CUR = 1,
  END = 2,
}

/** Oflags passed to path_open. */
export const OpenFlags = {
  CREAT: 1 << 0,
  DIRECTORY: 1 << 1,
  EXCL: 1 << 2,
  TRUNC: 1 << 3,
};

/** Fdflags — file-descriptor state flags. */
export const FdFlags = {
  APPEND: 1 << 0,
  DSYNC: 1 << 1,
  NONBLOCK: 1 << 2,
  RSYNC: 1 << 3,
  SYNC: 1 << 4,
};

/** Lookupflags — path-resolution flags for path_* syscalls. */
export const LookupFlags = {
  SYMLINK_FOLLOW: 1 << 0,
};

/** Rights flags — matches preview1; see lib/wasi/snapshot-preview1.ts. */
export const Rights = {
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  FD_ADVISE: 1n << 7n,
  FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  PATH_FILESTAT_SET_TIMES: 1n << 20n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_FILESTAT_SET_TIMES: 1n << 23n,
  PATH_SYMLINK: 1n << 24n,
  PATH_REMOVE_DIRECTORY: 1n << 25n,
  PATH_UNLINK_FILE: 1n << 26n,
  POLL_FD_READWRITE: 1n << 27n,
  SOCK_SHUTDOWN: 1n << 28n,
  SOCK_ACCEPT: 1n << 29n,
};

/**
 * Union of every Rights flag. Handed out on preopened fds and descriptors
 * the runtime opens — Runno does not enforce a rights system at the
 * provider boundary.
 */
export const ALL_RIGHTS: bigint =
  Rights.FD_DATASYNC |
  Rights.FD_READ |
  Rights.FD_SEEK |
  Rights.FD_FDSTAT_SET_FLAGS |
  Rights.FD_SYNC |
  Rights.FD_TELL |
  Rights.FD_WRITE |
  Rights.FD_ADVISE |
  Rights.FD_ALLOCATE |
  Rights.PATH_CREATE_DIRECTORY |
  Rights.PATH_CREATE_FILE |
  Rights.PATH_LINK_SOURCE |
  Rights.PATH_LINK_TARGET |
  Rights.PATH_OPEN |
  Rights.FD_READDIR |
  Rights.PATH_READLINK |
  Rights.PATH_RENAME_SOURCE |
  Rights.PATH_RENAME_TARGET |
  Rights.PATH_FILESTAT_GET |
  Rights.PATH_FILESTAT_SET_SIZE |
  Rights.PATH_FILESTAT_SET_TIMES |
  Rights.FD_FILESTAT_GET |
  Rights.FD_FILESTAT_SET_SIZE |
  Rights.FD_FILESTAT_SET_TIMES |
  Rights.PATH_SYMLINK |
  Rights.PATH_REMOVE_DIRECTORY |
  Rights.PATH_UNLINK_FILE |
  Rights.POLL_FD_READWRITE |
  Rights.SOCK_SHUTDOWN |
  Rights.SOCK_ACCEPT;

/**
 * `filestat` — file attributes.
 *
 * Record layout (size 64, alignment 8):
 * - dev      offset  0, size 8
 * - ino      offset  8, size 8
 * - filetype offset 16, size 1
 * - nlink    offset 24, size 8
 * - size     offset 32, size 8
 * - atim     offset 40, size 8 (ns since epoch)
 * - mtim     offset 48, size 8
 * - ctim     offset 56, size 8
 */
export const FILESTAT_SIZE = 64;

/**
 * `fdstat` — file-descriptor attributes.
 *
 * Record layout (size 24, alignment 8):
 * - fs_filetype            offset  0, size 1
 * - fs_flags               offset  2, size 2
 * - fs_rights_base         offset  8, size 8
 * - fs_rights_inheriting   offset 16, size 8
 */
export const FDSTAT_SIZE = 24;

/**
 * `dirent` — directory entry header preceding each name in fd_readdir.
 *
 * Record layout (size 24, alignment 8):
 * - d_next   offset  0, size 8 (dircookie for resuming the read)
 * - d_ino    offset  8, size 8
 * - d_namlen offset 16, size 4
 * - d_type   offset 20, size 1
 *
 * The entry's UTF-8 name immediately follows these 24 bytes.
 */
export const DIRENT_SIZE = 24;

/**
 * `prestat` tagged union — layout returned by fd_prestat_get.
 *
 * Record layout (size 8, alignment 4):
 * - tag        offset 0, size 1 (PreopenType)
 * - pr_name_len offset 4, size 4 (only meaningful when tag = DIR)
 */
export const PRESTAT_SIZE = 8;

// ─── Error class ─────────────────────────────────────────────────────────────

// Thrown by provider implementations to signal a specific WASIX errno.
// WASIX catches this and returns result directly; any other throw → EIO.
export class WASIXError extends Error {
  readonly result: Result;
  constructor(result: Result, message?: string) {
    super(message ?? `WASIXError: ${Result[result]}`);
    this.result = result;
  }
}
