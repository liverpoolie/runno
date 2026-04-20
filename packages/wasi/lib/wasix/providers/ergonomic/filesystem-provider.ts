// WASIDriveFileSystemProvider
//
// First of the "ergonomic" providers bundled with @runno/wasi.
// Wraps the existing preview1 WASIDrive in the raw FileSystemProvider
// interface so WASIX can serve filesystem syscalls through the same
// provider substrate as clock / random / etc.
//
// Sync throughout. An AsyncFileSystemProvider variant (for IndexedDB /
// server-backed filesystems) ships in a later slice.

import { WASIFS } from "../../../types.js";
import { WASIDrive } from "../../../wasi/wasi-drive.js";
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
 */
function toWasixResult(err: Preview1Result): Result {
  return err as unknown as Result;
}

/**
 * Ergonomic filesystem provider that delegates to the existing in-memory
 * `WASIDrive`. Hosts pass a `WASIFS` (or this provider directly) into
 * `WASIXContext.fs`; the runtime auto-wraps raw `WASIFS` values in this
 * class.
 *
 * This is a single-slice wrapper. Slice 9 extracts the common pieces
 * shared with preview1 into a common base; until then the drive stays
 * untouched and we translate at the boundary.
 */
export class WASIDriveFileSystemProvider implements FileSystemProvider {
  readonly drive: WASIDrive;

  constructor(fsOrDrive: WASIFS | WASIDrive) {
    this.drive =
      fsOrDrive instanceof WASIDrive ? fsOrDrive : new WASIDrive(fsOrDrive);
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
    // WASIDrive hard-codes fd 3 as the single preopen at "/".
    if (fd !== 3) {
      return null;
    }
    return { name: "." };
  }

  fdPrestatDirName(fd: number): string {
    if (fd !== 3) {
      throw new WASIXError(Result.EBADF);
    }
    return ".";
  }

  fdReaddir(fd: number, cookie: bigint): DirEntry[] {
    const [err, list] = this.drive.list(fd);
    if (err !== Preview1Result.SUCCESS) {
      throw new WASIXError(toWasixResult(err));
    }
    const entries: DirEntry[] = list.map((entry, index) => ({
      next: BigInt(index + 1),
      ino: cyrb53Bigint(entry.name),
      filetype: entry.type as unknown as FileType,
      name: entry.name,
    }));
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
    // WASIDrive doesn't distinguish empty vs non-empty; reuse unlink which
    // removes directories recursively in the current drive model. Future
    // slices may add strict empty-dir enforcement when the drive grows
    // real directory support.
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
