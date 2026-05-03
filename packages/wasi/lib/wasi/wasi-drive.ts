import {
  FileDescriptorFlags,
  FileType,
  OpenFlags,
  Result,
  Whence,
} from "./snapshot-preview1.js";
import { WASIFile, WASIFS, WASIPath, WASITimestamps } from "../types.js";

type FileDescriptor = number;

type DriveResult<T> = [Exclude<Result, Result.SUCCESS>] | [Result.SUCCESS, T];

type DirectoryEntry = { name: string; type: FileType };

export type DriveStat = {
  path: string;
  byteLength: number;
  timestamps: WASITimestamps;
  type: FileType;
};

export type WASIDrivePreopen = {
  /** File-descriptor number to bind this preopen to. Defaults to the next free fd starting at 4. */
  fd?: FileDescriptor;
  /** Drive-internal prefix (always rooted, trailing slash) used when resolving paths through this fd. */
  prefix: string;
};

export type WASIDriveOptions = {
  /** Additional preopens beyond the implicit fd 3 = "/" root. */
  preopens?: WASIDrivePreopen[];
};

export class WASIDrive {
  fs: WASIFS;
  nextFD: FileDescriptor = 10;
  openMap: Map<FileDescriptor, OpenFile | OpenDirectory> = new Map();
  /**
   * Set of fds bound to preopens. Their entries in `openMap` survive
   * user-initiated `close()` calls because wasix-libc's preopen cache
   * keeps using them to resolve cwd-relative paths even after the guest
   * believes the fd is closed (matches wasmer runtime behaviour — the
   * `closing-pre-opened-dirs` test relies on it).
   */
  private preopens: Set<FileDescriptor> = new Set();

  constructor(fs: WASIFS, options?: WASIDriveOptions) {
    this.fs = { ...fs };

    // Preopens are discovered by the binary using `fd_prestat_get` and then
    // mapping the integer space until you run out.
    // Convention is to start preopens at 3 (after STDIO).
    // See:
    //   1. how to access preopens - https://github.com/WebAssembly/WASI/issues/323
    //   2. how preopens work - https://github.com/WebAssembly/WASI/issues/352
    this.openMap.set(3, new OpenDirectory(this.fs, "/"));
    this.preopens.add(3);

    // Extra preopens (WASIX runtimes pass these to expose mounts beyond the
    // implicit root, e.g. "/home" alongside ".").
    if (options?.preopens) {
      let nextPreopenFd = 4;
      for (const preopen of options.preopens) {
        const fd = preopen.fd ?? nextPreopenFd++;
        this.openMap.set(fd, new OpenDirectory(this.fs, preopen.prefix));
        this.preopens.add(fd);
      }
    }
  }

  //
  // Helpers
  //
  private openFile(
    fileData: WASIFile,
    truncateFile: boolean,
    fdflags: number,
  ): DriveResult<FileDescriptor> {
    const file = new OpenFile(fileData, fdflags);
    if (truncateFile) {
      file.buffer = new Uint8Array(new ArrayBuffer(1024), 0, 0);
    }
    const fd = this.nextFD;
    this.openMap.set(fd, file);
    this.nextFD++;
    return [Result.SUCCESS, fd];
  }

  private openDir(fs: WASIFS, prefix: string): DriveResult<FileDescriptor> {
    const directory = new OpenDirectory(fs, prefix);
    const fd = this.nextFD;
    this.openMap.set(fd, directory);
    this.nextFD++;
    return [Result.SUCCESS, fd];
  }

  private hasDir(dir: OpenDirectory, path: string) {
    if (path === ".") {
      return true;
    }

    return dir.containsDirectory(path);
  }

  /**
   * If `path` has a parent component, validate that the parent
   * resolves to an existing directory. POSIX behaviour:
   *   - parent doesn't exist → ENOENT
   *   - parent is a regular file → ENOTDIR
   *
   * Returns `null` when validation passes (or there is no parent
   * component, i.e. the operation targets a single segment under the
   * directory). Both `open(O_CREAT)` and `mkdir` need this guard so the
   * flat-path map can't be tricked into planting entries under a leaf
   * file or a non-existent prefix.
   */
  private validateParent(
    dir: OpenDirectory,
    path: string,
  ): Result.ENOTDIR | Result.ENOENT | null {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    const parent = path.slice(0, lastSlash);
    if (dir.containsFile(parent)) {
      return Result.ENOTDIR;
    }
    if (!dir.containsDirectory(parent)) {
      return Result.ENOENT;
    }
    return null;
  }

  //
  // Public Interface
  //
  open(
    fdDir: FileDescriptor,
    rawPath: WASIPath,
    oflags: number,
    fdflags: number,
  ): DriveResult<FileDescriptor> {
    const createFileIfNone: boolean = !!(oflags & OpenFlags.CREAT);
    const failIfNotDir: boolean = !!(oflags & OpenFlags.DIRECTORY);
    const failIfFileExists: boolean = !!(oflags & OpenFlags.EXCL);
    const truncateFile: boolean = !!(oflags & OpenFlags.TRUNC);

    const openDir = this.openMap.get(fdDir);
    if (!(openDir instanceof OpenDirectory)) {
      // Must be relative to a directory
      return [Result.EBADF];
    }

    const path = normalizeRelative(rawPath);
    if (path === null) {
      // Tried to escape past the directory root; the flat-path drive
      // has no notion of a parent above the preopen.
      return [Result.ENOTCAPABLE];
    }

    // POSIX: if a path component above the leaf is a regular file or
    // doesn't exist, fail before touching the flat path map.
    const parentErr = this.validateParent(openDir, path);
    if (parentErr !== null) {
      return [parentErr];
    }

    if (openDir.containsFile(path)) {
      // This is a file
      if (failIfNotDir) {
        return [Result.ENOTDIR];
      }
      if (failIfFileExists) {
        return [Result.EEXIST];
      }

      return this.openFile(openDir.get(path)!, truncateFile, fdflags);
    } else if (this.hasDir(openDir, path)) {
      if (path === ".") {
        return this.openDir(this.fs, openDir.prefix);
      }

      // Compose the new prefix from the parent preopen's prefix so a
      // sub-directory open under a non-root preopen (e.g. fd 4 at
      // "/home/") resolves to "/home/<path>/" rather than "/<path>/".
      const prefix = `${openDir.prefix}${path}/`;
      const dir = Object.entries(this.fs).filter(([s]) => s.startsWith(prefix));
      return this.openDir(Object.fromEntries(dir), prefix);
    } else {
      if (createFileIfNone) {
        const fullPath = openDir.fullPath(path);
        this.fs[fullPath] = {
          path: fullPath,
          mode: "binary",
          content: new Uint8Array(),
          timestamps: {
            access: new Date(),
            modification: new Date(),
            change: new Date(),
          },
        };
        return this.openFile(this.fs[fullPath], truncateFile, fdflags);
      }
      // ENOTCAPABLE is the preview1 vocabulary for "drive can't
      // satisfy this open"; it covers both "path missing" and
      // "capability not granted" because the flat-path map can't
      // distinguish them. The WASIX provider translates this to
      // ENOENT for POSIX-shaped binaries that key on `errno ==
      // ENOENT`. Preview1 callers see the original code so the WASI
      // test suite (which asserts ENOTCAPABLE explicitly) keeps
      // passing.
      return [Result.ENOTCAPABLE];
    }
  }

  close(fd: FileDescriptor): Result {
    if (!this.openMap.has(fd)) {
      return Result.EBADF;
    }

    const file = this.openMap.get(fd);
    if (file instanceof OpenFile) {
      file.sync();
    }

    // Preopen fds report success but stay in the map. wasix-libc's
    // resolver keeps them in its own cache and re-uses them to translate
    // cwd-relative paths after the guest "closes" them.
    if (this.preopens.has(fd)) {
      return Result.SUCCESS;
    }

    this.openMap.delete(fd);
    return Result.SUCCESS;
  }

  read(fd: FileDescriptor, bytes: number): DriveResult<Uint8Array> {
    const file = this.openMap.get(fd);
    if (!file || file instanceof OpenDirectory) {
      return [Result.EBADF];
    }

    return [Result.SUCCESS, file.read(bytes)];
  }

  pread(
    fd: FileDescriptor,
    bytes: number,
    offset: number,
  ): DriveResult<Uint8Array> {
    const file = this.openMap.get(fd);
    if (!file || file instanceof OpenDirectory) {
      return [Result.EBADF];
    }

    return [Result.SUCCESS, file.pread(bytes, offset)];
  }

  write(fd: FileDescriptor, data: Uint8Array): Result {
    const file = this.openMap.get(fd);
    if (!file || file instanceof OpenDirectory) {
      return Result.EBADF;
    }

    file.write(data);
    return Result.SUCCESS;
  }

  pwrite(fd: FileDescriptor, data: Uint8Array, offset: number): Result {
    const file = this.openMap.get(fd);
    if (!file || file instanceof OpenDirectory) {
      return Result.EBADF;
    }

    file.pwrite(data, offset);
    return Result.SUCCESS;
  }

  sync(fd: FileDescriptor): Result {
    const file = this.openMap.get(fd);
    if (!file || file instanceof OpenDirectory) {
      return Result.EBADF;
    }

    file.sync();

    return Result.SUCCESS;
  }

  seek(
    fd: FileDescriptor,
    offset: bigint,
    whence: Whence,
  ): DriveResult<bigint> {
    const file = this.openMap.get(fd);
    if (!file || file instanceof OpenDirectory) {
      return [Result.EBADF];
    }

    return [Result.SUCCESS, file.seek(offset, whence)];
  }

  tell(fd: FileDescriptor): DriveResult<bigint> {
    const file = this.openMap.get(fd);
    if (!file || file instanceof OpenDirectory) {
      return [Result.EBADF];
    }

    return [Result.SUCCESS, file.tell()];
  }

  renumber(oldFd: FileDescriptor, newFd: FileDescriptor): Result {
    if (!this.exists(oldFd) || !this.exists(newFd)) {
      return Result.EBADF;
    }

    if (oldFd === newFd) {
      return Result.SUCCESS;
    }

    this.close(newFd);
    this.openMap.set(newFd, this.openMap.get(oldFd)!);
    return Result.SUCCESS;
  }

  unlink(fdDir: FileDescriptor, rawPath: string): Result {
    const openDir = this.openMap.get(fdDir);
    if (!(openDir instanceof OpenDirectory)) {
      // Must be relative to a directory
      return Result.EBADF;
    }

    const path = normalizeRelative(rawPath);
    if (path === null || path === ".") {
      return Result.ENOENT;
    }

    if (!openDir.contains(path)) {
      return Result.ENOENT;
    }

    for (const key of Object.keys(this.fs)) {
      if (
        key === openDir.fullPath(path) ||
        key.startsWith(`${openDir.fullPath(path)}/`)
      ) {
        delete this.fs[key];
      }
    }

    return Result.SUCCESS;
  }

  rename(
    oldFdDir: FileDescriptor,
    rawOldPath: string,
    newFdDir: FileDescriptor,
    rawNewPath: string,
  ): Result {
    const oldDir = this.openMap.get(oldFdDir);
    const newDir = this.openMap.get(newFdDir);
    if (
      !(oldDir instanceof OpenDirectory) ||
      !(newDir instanceof OpenDirectory)
    ) {
      // Must be relative to a directory
      return Result.EBADF;
    }

    const oldPath = normalizeRelative(rawOldPath);
    const newPath = normalizeRelative(rawNewPath);
    if (
      oldPath === null ||
      newPath === null ||
      oldPath === "." ||
      newPath === "."
    ) {
      return Result.ENOENT;
    }

    if (!oldDir.contains(oldPath)) {
      return Result.ENOENT;
    }

    if (newDir.contains(newPath)) {
      return Result.EEXIST;
    }

    const oldFullPath = oldDir.fullPath(oldPath);
    const newFullPath = newDir.fullPath(newPath);

    for (const key of Object.keys(this.fs)) {
      if (key.startsWith(oldFullPath)) {
        const newPath = key.replace(oldFullPath, newFullPath);
        this.fs[newPath] = this.fs[key];
        this.fs[newPath].path = newPath;
        delete this.fs[key];
      }
    }

    return Result.SUCCESS;
  }

  list(fd: FileDescriptor): DriveResult<Array<DirectoryEntry>> {
    const fdDir = this.openMap.get(fd);
    if (!(fdDir instanceof OpenDirectory)) {
      return [Result.EBADF];
    }

    return [Result.SUCCESS, fdDir.list()];
  }

  stat(fd: FileDescriptor): DriveResult<DriveStat> {
    const file = this.openMap.get(fd);
    if (!(file instanceof OpenFile)) {
      return [Result.EBADF];
    }

    return [Result.SUCCESS, file.stat()];
  }

  pathStat(fdDir: FileDescriptor, rawPath: string): DriveResult<DriveStat> {
    const dir = this.openMap.get(fdDir);
    if (!(dir instanceof OpenDirectory)) {
      return [Result.EBADF];
    }

    const path = normalizeRelative(rawPath);
    if (path === null) {
      return [Result.ENOTCAPABLE];
    }

    if (dir.containsFile(path)) {
      const fullPath = dir.fullPath(path);
      const stat = new OpenFile(this.fs[fullPath], 0).stat();
      return [Result.SUCCESS, stat];
    } else if (this.hasDir(dir, path)) {
      if (path === ".") {
        return [Result.SUCCESS, new OpenDirectory(this.fs, dir.prefix).stat()];
      }

      // See comment in `open` — the new prefix must include the parent
      // preopen's prefix so multi-preopen layouts (e.g. fd 4 = "/home/")
      // resolve sub-directories under the right subtree.
      const prefix = `${dir.prefix}${path}/`;
      const subset = Object.entries(this.fs).filter(([s]) =>
        s.startsWith(prefix),
      );
      const stat = new OpenDirectory(Object.fromEntries(subset), prefix).stat();
      return [Result.SUCCESS, stat];
    } else {
      // See comment in `open` — preview1 keeps the original
      // ENOTCAPABLE; the WASIX provider rewrites to ENOENT for POSIX
      // callers.
      return [Result.ENOTCAPABLE];
    }
  }

  setFlags(fd: FileDescriptor, flags: number): Result {
    const file = this.openMap.get(fd);
    if (file instanceof OpenFile) {
      file.setFlags(flags);
      return Result.SUCCESS;
    } else {
      return Result.EBADF;
    }
  }

  setSize(fd: FileDescriptor, size: bigint): Result {
    const file = this.openMap.get(fd);
    if (file instanceof OpenFile) {
      file.setSize(Number(size));
      return Result.SUCCESS;
    } else {
      return Result.EBADF;
    }
  }

  setAccessTime(fd: FileDescriptor, date: Date): Result {
    const file = this.openMap.get(fd);
    if (file instanceof OpenFile) {
      file.setAccessTime(date);
      return Result.SUCCESS;
    } else {
      return Result.EBADF;
    }
  }

  setModificationTime(fd: FileDescriptor, date: Date): Result {
    const file = this.openMap.get(fd);
    if (file instanceof OpenFile) {
      file.setModificationTime(date);
      return Result.SUCCESS;
    } else {
      return Result.EBADF;
    }
  }

  pathSetAccessTime(
    fdDir: FileDescriptor,
    rawPath: string,
    date: Date,
  ): Result {
    const dir = this.openMap.get(fdDir);
    if (!(dir instanceof OpenDirectory)) {
      return Result.EBADF;
    }

    const path = normalizeRelative(rawPath);
    if (path === null) {
      return Result.ENOTCAPABLE;
    }
    const f = dir.get(path);
    if (!f) {
      return Result.ENOTCAPABLE;
    }
    const file = new OpenFile(f, 0);
    file.setAccessTime(date);
    file.sync();
    return Result.SUCCESS;
  }

  pathSetModificationTime(
    fdDir: FileDescriptor,
    rawPath: string,
    date: Date,
  ): Result {
    const dir = this.openMap.get(fdDir);
    if (!(dir instanceof OpenDirectory)) {
      return Result.EBADF;
    }

    const path = normalizeRelative(rawPath);
    if (path === null) {
      return Result.ENOTCAPABLE;
    }
    const f = dir.get(path);
    if (!f) {
      return Result.ENOTCAPABLE;
    }
    const file = new OpenFile(f, 0);
    file.setModificationTime(date);
    file.sync();
    return Result.SUCCESS;
  }

  pathCreateDir(fdDir: FileDescriptor, rawPath: string): Result {
    const dir = this.openMap.get(fdDir);
    if (!(dir instanceof OpenDirectory)) {
      return Result.EBADF;
    }

    const path = normalizeRelative(rawPath);
    if (path === null || path === ".") {
      // "." is the directory itself — already exists.
      return Result.ENOTCAPABLE;
    }

    // Reject `mkdir foo/bar` when `foo` doesn't exist or is a regular
    // file. Mirrors POSIX: mkdir fails ENOENT when a path-prefix
    // component is missing, ENOTDIR when one is a non-directory.
    const parentErr = this.validateParent(dir, path);
    if (parentErr !== null) {
      return parentErr;
    }

    if (dir.contains(path)) {
      return Result.ENOTCAPABLE;
    }

    // Since this FS doesn't really support directories,
    // just put a dummy file in the directory.
    // It'll be fine probably.
    const filePath = `${dir.fullPath(path)}/.runno`;
    this.fs[filePath] = {
      path: filePath,
      timestamps: {
        access: new Date(),
        modification: new Date(),
        change: new Date(),
      },
      mode: "string",
      content: "",
    };
    return Result.SUCCESS;
  }

  //
  // Public Helpers
  //

  exists(fd: FileDescriptor): boolean {
    return this.openMap.has(fd);
  }

  fileType(fd: FileDescriptor): FileType {
    const file = this.openMap.get(fd)!;
    if (!file) {
      return FileType.UNKNOWN;
    } else if (file instanceof OpenFile) {
      return FileType.REGULAR_FILE;
    } else {
      return FileType.DIRECTORY;
    }
  }

  fileFdflags(fd: FileDescriptor): number {
    const file = this.openMap.get(fd)!;
    if (file instanceof OpenFile) {
      return file.fdflags;
    } else {
      return 0;
    }
  }
}

class OpenFile {
  file: WASIFile;
  buffer: Uint8Array;
  private _offset: bigint = BigInt(0);
  isDirty: boolean = false;
  fdflags: number;
  flagAppend: boolean;
  flagDSync: boolean;
  flagNonBlock: boolean;
  flagRSync: boolean;
  flagSync: boolean;

  private get offset(): number {
    // Hack: This will cause overflow issues with offsets larger than 4gb
    //       but I hope that's fine??
    return Number(this._offset);
  }

  constructor(file: WASIFile, fdflags: number) {
    this.file = file;

    if (this.file.mode === "string") {
      const encoder = new TextEncoder();
      this.buffer = encoder.encode(this.file.content);
    } else {
      this.buffer = this.file.content;
    }

    this.fdflags = fdflags;
    this.flagAppend = !!(fdflags & FileDescriptorFlags.APPEND);
    this.flagDSync = !!(fdflags & FileDescriptorFlags.DSYNC);
    this.flagNonBlock = !!(fdflags & FileDescriptorFlags.NONBLOCK);
    this.flagRSync = !!(fdflags & FileDescriptorFlags.RSYNC);
    this.flagSync = !!(fdflags & FileDescriptorFlags.SYNC);
  }

  read(bytes: number) {
    const ret = this.buffer.subarray(this.offset, this.offset + bytes);
    this._offset += BigInt(ret.length);
    return ret;
  }

  pread(bytes: number, offset: number) {
    return this.buffer.subarray(offset, offset + bytes);
  }

  write(data: Uint8Array) {
    this.isDirty = true;

    if (this.flagAppend) {
      // TODO: Not sure what the semantics for offset are here
      const length = this.buffer.length;
      this.resize(length + data.byteLength);
      this.buffer.set(data, length);
    } else {
      const newSize = Math.max(
        this.offset + data.byteLength,
        this.buffer.byteLength,
      );
      this.resize(newSize);
      this.buffer.set(data, this.offset);
      this._offset += BigInt(data.byteLength);
    }

    if (this.flagDSync || this.flagSync) {
      this.sync();
    }
  }

  pwrite(data: Uint8Array, offset: number) {
    this.isDirty = true;

    if (this.flagAppend) {
      // TODO: Not sure what the semantics for offset are here
      const length = this.buffer.length;
      this.resize(length + data.byteLength);
      this.buffer.set(data, length);
    } else {
      const newSize = Math.max(
        offset + data.byteLength,
        this.buffer.byteLength,
      );
      this.resize(newSize);
      this.buffer.set(data, offset);
    }

    if (this.flagDSync || this.flagSync) {
      this.sync();
    }
  }

  sync() {
    if (!this.isDirty) {
      return;
    }

    this.isDirty = false;
    if (this.file.mode === "binary") {
      this.file.content = new Uint8Array(this.buffer);
      return;
    }

    const decoder = new TextDecoder();
    this.file.content = decoder.decode(this.buffer);
    return;
  }

  seek(offset: bigint, whence: Whence) {
    switch (whence) {
      case Whence.SET:
        this._offset = offset;
        break;
      case Whence.CUR:
        this._offset += offset;
        break;
      case Whence.END:
        this._offset = BigInt(this.buffer.length) + offset;
        break;
    }
    return this._offset;
  }

  tell() {
    return this._offset;
  }

  stat(): DriveStat {
    return {
      path: this.file.path,
      timestamps: this.file.timestamps,
      type: FileType.REGULAR_FILE,
      byteLength: this.buffer.length,
    };
  }

  setFlags(flags: number) {
    this.fdflags = flags;
  }

  setSize(size: number) {
    this.resize(size);
  }

  setAccessTime(date: Date) {
    this.file.timestamps.access = date;
  }

  setModificationTime(date: Date) {
    this.file.timestamps.modification = date;
  }

  /**
   * Resizes the buffer to be exactly requiredBytes length, while resizing the
   * underlying buffer to be larger if necessary.
   *
   * Resizing will internally double the buffer size to reduce the need for
   * resizing often.
   *
   * @param requiredBytes how many bytes the buffer needs to have available
   */
  private resize(requiredBytes: number) {
    if (requiredBytes <= this.buffer.buffer.byteLength) {
      this.buffer = new Uint8Array(this.buffer.buffer, 0, requiredBytes);
      return;
    }

    let underBuffer: ArrayBuffer;

    if (this.buffer.buffer.byteLength === 0) {
      underBuffer = new ArrayBuffer(
        requiredBytes < 1024 ? 1024 : requiredBytes * 2,
      );
    } else if (requiredBytes > this.buffer.buffer.byteLength * 2) {
      underBuffer = new ArrayBuffer(requiredBytes * 2);
    } else {
      underBuffer = new ArrayBuffer(this.buffer.buffer.byteLength * 2);
    }

    const newBuffer = new Uint8Array(underBuffer, 0, requiredBytes);
    newBuffer.set(this.buffer);
    this.buffer = newBuffer;
  }
}

/**
 * Strip `./`, `/./` and empty segments from a directory-relative path
 * so the flat-path drive sees one canonical key per logical entry.
 * Without this, `mkdirat(cwd, "./test")` would store
 * `<prefix>./test/.runno` while a sibling `stat("test")` would look
 * for `<prefix>test/...` and miss it (the create-dir-at-cwd case).
 *
 * Returns the normalised path (`"."` for the directory itself), or
 * `null` if the path contains a `..` segment. The flat-path drive
 * cannot model traversal-relative paths — a path like `foo/../bar`
 * needs `foo` to be a real directory before `..` is meaningful, and
 * the drive has no notion of "real directory" beyond the keys present
 * in the map. Callers turn `null` into ENOTCAPABLE so the WASI
 * capability semantics (no escape outside the preopen tree) hold —
 * matches the existing behaviour for paths the drive can't resolve.
 */
function normalizeRelative(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    out.push(segment);
  }
  return out.length === 0 ? "." : out.join("/");
}

function removePrefix(path: string, prefix: string) {
  const escapedPrefix = prefix.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&");
  const leadingRegex = new RegExp(`^${escapedPrefix}`);
  return path.replace(leadingRegex, "");
}

class OpenDirectory {
  dir: WASIFS;
  prefix: string; // full folder path including /

  constructor(dir: WASIFS, prefix: string) {
    this.dir = dir;
    this.prefix = prefix;
  }

  containsFile(relativePath: string) {
    for (const path of Object.keys(this.dir)) {
      const name = removePrefix(path, this.prefix);
      if (name === relativePath) {
        return true;
      }
    }

    return false;
  }

  containsDirectory(relativePath: string) {
    for (const path of Object.keys(this.dir)) {
      const name = removePrefix(path, this.prefix);
      if (name.startsWith(`${relativePath}/`)) {
        return true;
      }
    }

    return false;
  }

  contains(relativePath: string) {
    for (const path of Object.keys(this.dir)) {
      const name = removePrefix(path, this.prefix);
      if (name === relativePath || name.startsWith(`${relativePath}/`)) {
        return true;
      }
    }

    return false;
  }

  get(relativePath: string): WASIFile | undefined {
    return this.dir[this.fullPath(relativePath)];
  }

  fullPath(relativePath: string) {
    return `${this.prefix}${relativePath}`;
  }

  list(): Array<DirectoryEntry> {
    const entries: Array<DirectoryEntry> = [];
    const seenFolders = new Set<string>();
    for (const path of Object.keys(this.dir)) {
      const name = removePrefix(path, this.prefix);
      if (name.includes("/")) {
        const dirName = name.split("/")[0];
        if (seenFolders.has(dirName)) {
          continue;
        }
        seenFolders.add(dirName);
        entries.push({ name: dirName, type: FileType.DIRECTORY });
      } else {
        entries.push({
          name,
          type: FileType.REGULAR_FILE,
        });
      }
    }

    return entries;
  }

  stat(): DriveStat {
    return {
      path: this.prefix,
      timestamps: {
        access: new Date(),
        modification: new Date(),
        change: new Date(),
      },
      type: FileType.DIRECTORY,
      byteLength: 0,
    };
  }
}
