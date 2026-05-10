// WASIDriveFileSystemProvider
//
// One of the "ergonomic" providers bundled with @runno/wasi. Wraps the
// existing preview1 WASIDrive in the FileSystemProvider interface so
// WASIX can serve filesystem syscalls through the same provider
// substrate as clock / random / etc.
//
// Sync throughout. An async variant (for IndexedDB / server-backed
// filesystems) is layered separately.

import { WASIFS } from "../../../types.js";
import { WASIDrive } from "../../../wasi/wasi-drive.js";
import type { WASIDrivePreopen } from "../../../wasi/wasi-drive.js";
// The WASIDrive is a preview1 artefact; its Result enum mirrors
// wasix-32v1.Result numerically. We read preview1 error codes directly
// and pass them straight to WASIXError (whose constructor accepts the
// numeric type via the shared enum values).
import { Result as Preview1Result } from "../../../wasi/snapshot-preview1.js";
import {
  DirEntry,
  Fdstat,
  FileSystemProvider,
  Filestat,
  PreopenInfo,
} from "../../providers.js";
import { ALL_RIGHTS, FileType, Result, WASIXError } from "../../wasix-32v1.js";

/**
 * Hash `str` to a 53-bit-ish integer and return as a bigint.
 * Used to synthesise stable inode numbers from paths.
 *
 * Same algorithm as preview1's `cyrb53` in lib/wasi/wasi.ts so a WASIX
 * binary that also imports wasi_snapshot_preview1 sees consistent inode
 * numbers across both namespaces.
 */
function cyrb53Bigint(str: string, seed = 0): bigint {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return BigInt(4294967296 * (2097151 & h2) + (h1 >>> 0));
}

function dateToNs(date: Date): bigint {
  return BigInt(date.getTime()) * 1_000_000n;
}

/**
 * Map a preview1 `Result` to a `wasix_32v1.Result`.
 *
 * The two enums share identical numeric values for every errno that the
 * filesystem code paths touch (preview1 happens to also have a typoed
 * `EACCESS` alongside the same numeric slot; wasix uses the canonical
 * `EACCES` spelling with the same value). A numeric cast is therefore
 * exact and round-trip-safe for the ergonomic wrapper's purposes.
 *
 * The drive returns `ENOTCAPABLE` for both "path missing" and
 * "capability denied" because the flat-path map can't distinguish them.
 * POSIX-shaped binaries (wasix-libc) check `errno == ENOENT` to detect
 * absent paths, so we rewrite `ENOTCAPABLE` to `ENOENT` here for path
 * lookups. Preview1 callers go through wasi.ts directly and still see
 * the original code (the WASI test suite asserts on it).
 */
function toWasixResult(err: Preview1Result): Result {
  if (err === Preview1Result.ENOTCAPABLE) {
    return Result.ENOENT;
  }
  return err as unknown as Result;
}

/**
 * One preopen exposed by the provider beyond the implicit fd 3 = ".".
 * Each maps a guest-visible name (e.g. "/home") to a drive prefix
 * (always rooted, trailing slash) used when resolving paths through
 * the bound fd.
 */
export type ProviderPreopen = {
  /** Guest-visible name returned by `fd_prestat_dir_name`. */
  name: string;
  /** Drive-internal prefix used when storing / resolving entries. */
  prefix: string;
};

export type WASIDriveFileSystemProviderOptions = {
  /**
   * Extra preopens beyond the default fd 3 = ".". Bound to consecutive
   * fds starting at 4 in the order supplied.
   *
   * Required to expose mounts that wasix-libc expects to find by
   * absolute prefix (e.g. wasix-libc's default cwd is `/home`, so a
   * `/home` preopen is needed for cwd-relative file ops to resolve).
   */
  preopens?: ProviderPreopen[];
};

/**
 * Ergonomic filesystem provider that delegates to the existing in-memory
 * `WASIDrive`. Hosts construct one with a `WASIFS` (or an existing drive)
 * and pass it as `WASIXContext.fs`.
 */
export class WASIDriveFileSystemProvider implements FileSystemProvider {
  readonly drive: WASIDrive;

  /** fd → guest-visible preopen name. fd 3 always maps to ".". */
  private readonly preopenNames: Map<number, string>;

  constructor(
    fsOrDrive: WASIFS | WASIDrive,
    options?: WASIDriveFileSystemProviderOptions,
  ) {
    this.preopenNames = new Map();
    this.preopenNames.set(3, ".");

    if (fsOrDrive instanceof WASIDrive) {
      this.drive = fsOrDrive;
      // Trust the caller — assume any preopens beyond fd 3 are already
      // registered on the drive. Mirror them here so prestat reads find
      // the names.
      if (options?.preopens) {
        let nextFd = 4;
        for (const p of options.preopens) {
          this.preopenNames.set(nextFd++, p.name);
        }
      }
    } else {
      const drivePreopens: WASIDrivePreopen[] | undefined =
        options?.preopens?.map((p) => ({ prefix: p.prefix }));
      this.drive = new WASIDrive(fsOrDrive, { preopens: drivePreopens });
      if (options?.preopens) {
        let nextFd = 4;
        for (const p of options.preopens) {
          this.preopenNames.set(nextFd++, p.name);
        }
      }
    }
  }

  // ─── File descriptor ops ──────────────────────────────────────────────

  fdRead(fd: number, bufs: Uint8Array[]): number {
    let bytesRead = 0;
    for (const buf of bufs) {
      if (buf.byteLength === 0) continue;
      const [err, data] = this.drive.read(fd, buf.byteLength);
      if (err !== Preview1Result.SUCCESS) {
        throw new WASIXError(toWasixResult(err));
      }
      const n = Math.min(buf.byteLength, data.byteLength);
      buf.set(data.subarray(0, n));
      bytesRead += n;
      if (n < buf.byteLength) break; // short read — no more data
    }
    return bytesRead;
  }

  fdWrite(fd: number, bufs: Uint8Array[]): number {
    let bytesWritten = 0;
    for (const buf of bufs) {
      if (buf.byteLength === 0) continue;
      const err = this.drive.write(fd, buf);
      if (err !== Preview1Result.SUCCESS) {
        throw new WASIXError(toWasixResult(err));
      }
      bytesWritten += buf.byteLength;
    }
    return bytesWritten;
  }

  fdSeek(fd: number, offset: bigint, whence: number): bigint {
    const [err, newOffset] = this.drive.seek(fd, offset, whence);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
    return newOffset;
  }

  fdClose(fd: number): void {
    const err = this.drive.close(fd);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
  }

  fdFdstatGet(fd: number): Fdstat {
    if (!this.drive.exists(fd)) {
      throw new WASIXError(Result.EBADF);
    }
    const filetype = this.drive.fileType(fd) as unknown as FileType;
    const fsFlags = this.drive.fileFdflags(fd);
    return {
      filetype,
      fsFlags,
      fsRightsBase: ALL_RIGHTS,
      fsRightsInheriting: ALL_RIGHTS,
    };
  }

  fdFdstatSetFlags(fd: number, flags: number): void {
    const err = this.drive.setFlags(fd, flags);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
  }

  fdFilestatGet(fd: number): Filestat {
    const [err, stat] = this.drive.stat(fd);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
    return {
      dev: 0n,
      ino: cyrb53Bigint(stat.path),
      filetype: stat.type as unknown as FileType,
      nlink: 1n,
      size: BigInt(stat.byteLength),
      timestamps: {
        access: dateToNs(stat.timestamps.access),
        modification: dateToNs(stat.timestamps.modification),
        change: dateToNs(stat.timestamps.change),
      },
    };
  }

  fdPrestatGet(fd: number): PreopenInfo | null {
    const name = this.preopenNames.get(fd);
    return name === undefined ? null : { name };
  }

  fdPrestatDirName(fd: number): string {
    const name = this.preopenNames.get(fd);
    if (name === undefined) {
      throw new WASIXError(Result.EBADF);
    }
    return name;
  }

  fdReaddir(fd: number, cookie: bigint): DirEntry[] {
    const [err, list] = this.drive.list(fd);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
    // The provider contract types `cookie` as `bigint`; reject cookies
    // that would lose precision when narrowed to a Number so we surface
    // the overflow instead of silently slicing at the wrong index. The
    // drive list is always well below 2^53 entries in practice — this
    // is a type-safety guard rather than a real limit.
    if (cookie > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WASIXError(Result.EOVERFLOW);
    }
    // Drop the `.runno` sentinel that `WASIDrive.pathCreateDir` plants
    // in every mkdir'd directory — it's a flat-path-map artefact and
    // not a real entry the guest ever wrote. Going away with the
    // drive extraction in a later slice.
    const realEntries = list.filter((entry) => entry.name !== ".runno");
    // Synthesize POSIX `.` and `..` entries. wasix-libc's readdir
    // implementation passes them through verbatim (matches every
    // hosted-libc behaviour the wasmer suite asserts against), and
    // omitting them breaks tests like closing-pre-opened-dirs that
    // grep for `.` in the listing.
    const entries: DirEntry[] = [
      {
        next: 1n,
        ino: 0n,
        filetype: FileType.DIRECTORY,
        name: ".",
      },
      {
        next: 2n,
        ino: 0n,
        filetype: FileType.DIRECTORY,
        name: "..",
      },
      ...realEntries.map((entry, index) => ({
        next: BigInt(index + 3),
        ino: cyrb53Bigint(entry.name),
        filetype: entry.type as unknown as FileType,
        name: entry.name,
      })),
    ];
    const startIndex = Number(cookie);
    return entries.slice(startIndex);
  }

  // ─── Path ops ─────────────────────────────────────────────────────────

  pathOpen(
    fdDir: number,
    _dirflags: number,
    path: string,
    oflags: number,
    _rightsBase: bigint,
    _rightsInheriting: bigint,
    fdflags: number,
  ): number {
    const [err, newFd] = this.drive.open(fdDir, path, oflags, fdflags);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
    return newFd;
  }

  pathFilestatGet(fdDir: number, _dirflags: number, path: string): Filestat {
    const [err, stat] = this.drive.pathStat(fdDir, path);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
    return {
      dev: 0n,
      ino: cyrb53Bigint(stat.path),
      filetype: stat.type as unknown as FileType,
      nlink: 1n,
      size: BigInt(stat.byteLength),
      timestamps: {
        access: dateToNs(stat.timestamps.access),
        modification: dateToNs(stat.timestamps.modification),
        change: dateToNs(stat.timestamps.change),
      },
    };
  }

  pathCreateDirectory(fdDir: number, path: string): void {
    const err = this.drive.pathCreateDir(fdDir, path);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
  }

  pathUnlinkFile(fdDir: number, path: string): void {
    const err = this.drive.unlink(fdDir, path);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
  }

  pathRemoveDirectory(fdDir: number, path: string): void {
    // POSIX `rmdir` contract (mirrored by wasix `path_remove_directory`):
    //   - `path` points at a file → ENOTDIR.
    //   - directory is non-empty → ENOTEMPTY.
    //   - anything else → delegate to the drive's unlink.
    //
    // `WASIDrive.unlink` happily removes both files and non-empty
    // directories (it just prefix-walks the flat path map). Guard the
    // two error cases here so callers that exercise directory
    // semantics see the right errno.
    const [statErr, stat] = this.drive.pathStat(fdDir, path);
    if (statErr !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(statErr));
    }
    if ((stat.type as unknown as FileType) !== FileType.DIRECTORY) {
      throw new WASIXError(Result.ENOTDIR);
    }

    // Open the target directory just long enough to read its entries —
    // the drive's list() requires an fd. Close on both success and
    // failure paths so we don't leak fds on the ENOTEMPTY return.
    const [openErr, dirFd] = this.drive.open(fdDir, path, 0, 0);
    if (openErr !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(openErr));
    }
    try {
      const [listErr, entries] = this.drive.list(dirFd);
      if (listErr !== Preview1Result.SUCCESS) {
        throw new WASIXError(toWasixResult(listErr));
      }
      // `WASIDrive.pathCreateDir` plants a `.runno` sentinel file inside
      // every directory it creates because the flat-path drive has no
      // standalone directory representation. Filter it before counting so
      // a freshly created directory reports as empty here. Couples the
      // wrapper to that drive detail; goes away in Slice 9.
      const realEntries = entries.filter((e) => e.name !== ".runno");
      if (realEntries.length > 0) {
        throw new WASIXError(Result.ENOTEMPTY);
      }
    } finally {
      this.drive.close(dirFd);
    }

    const err = this.drive.unlink(fdDir, path);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
  }

  pathRename(
    oldFdDir: number,
    oldPath: string,
    newFdDir: number,
    newPath: string,
  ): void {
    const err = this.drive.rename(oldFdDir, oldPath, newFdDir, newPath);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
  }
}
