import {
  ALL_RIGHTS,
  ClockId,
  DIRENT_SIZE,
  FDSTAT_SIZE,
  FILESTAT_SIZE,
  FileType,
  PRESTAT_SIZE,
  PreopenType,
  Result,
  WASIXError,
} from "./wasix-32v1.js";
import { WASIXContext, WASIXContextOptions } from "./wasix-context.js";
import {
  WASI,
  InvalidInstanceError,
  InitializationError,
} from "../wasi/wasi.js";
import { WASIContextOptions } from "../wasi/wasi-context.js";
import { WASIXExecutionResult, WASIFS } from "../types.js";
import { SystemClockProvider } from "./providers/system-clock.js";
import { SystemRandomProvider } from "./providers/system-random.js";
import { WASIDriveFileSystemProvider } from "./providers/ergonomic/filesystem-provider.js";
import type {
  ClockProvider,
  FileSystemProvider,
  RandomProvider,
} from "./providers.js";

class WASIXExit extends Error {
  code: number;
  constructor(code: number) {
    super();
    this.code = code;
  }
}

/**
 * WASIX runtime for the browser.
 *
 * Sibling of WASI (not a subclass). Composes a WASI instance internally to
 * service wasi_snapshot_preview1 and wasi_unstable imports. Slice 3 wires
 * filesystem syscalls through a `FileSystemProvider`; clock / random
 * landed in Slice 2. Memory marshalling lives in this class — providers
 * only ever see decoded JS-native values.
 *
 * Usage mirrors WASI.start():
 *
 *   const result = await WASIX.start(fetch('/bin/hello.wasm'), new WASIXContext({ … }));
 */
export class WASIX {
  instance!: WebAssembly.Instance;
  module!: WebAssembly.Module;
  memory!: WebAssembly.Memory;
  context: WASIXContext;
  hasBeenInitialized: boolean = false;

  private wasi: WASI;
  private _clock?: ClockProvider;
  private _random?: RandomProvider;
  private _fs?: FileSystemProvider;

  /**
   * Start a WASIX command.
   */
  static async start(
    wasmSource: Response | PromiseLike<Response>,
    context: Partial<WASIXContextOptions> = {},
  ): Promise<WASIXExecutionResult> {
    const wasix = new WASIX(context);
    const wasm = await WebAssembly.instantiateStreaming(
      wasmSource,
      wasix.getImportObject(),
    );
    return wasix.start(wasm);
  }

  constructor(context: Partial<WASIXContextOptions>) {
    this.context = new WASIXContext(context);
    // Internal WASI shares args / env / stdio with WASIX. When the host
    // supplies a raw FileSystemProvider via `fs`, the internal WASI is
    // constructed with an empty fs — preview1 filesystem imports are not
    // backed by the provider this slice. Slice 9 unifies the drive.
    const wasiContext: Partial<WASIContextOptions> = {
      args: context.args,
      env: context.env,
      stdin: context.stdin,
      stdout: context.stdout,
      stderr: context.stderr,
      isTTY: context.isTTY,
      debug: context.debug,
      fs: isFileSystemProvider(context.fs)
        ? {}
        : ((context.fs ?? {}) as WASIFS),
    };
    this.wasi = new WASI(wasiContext);
  }

  getImportObject() {
    const preview1 = this.wasi.getImports("preview1", this.context.debug);
    const unstable = this.wasi.getImports("unstable", this.context.debug);

    // Override proc_exit in both preview1 and unstable so that WASIXExit
    // is thrown instead of WASIExit (which is private to wasi.ts).
    const procExit = (code: number) => {
      throw new WASIXExit(code);
    };

    return {
      wasix_32v1: this.getWasix32v1Imports(),
      wasi_snapshot_preview1: { ...preview1, proc_exit: procExit },
      wasi_unstable: { ...unstable, proc_exit: procExit },
    };
  }

  /**
   * Start a WASIX command.
   *
   * See: https://github.com/WebAssembly/WASI/blob/main/legacy/application-abi.md
   */
  start(
    wasm: WebAssembly.WebAssemblyInstantiatedSource,
    options: {
      memory?: WebAssembly.Memory;
    } = {},
  ): WASIXExecutionResult {
    if (this.hasBeenInitialized) {
      throw new InitializationError(
        "This instance has already been initialized",
      );
    }

    this.hasBeenInitialized = true;
    this.instance = wasm.instance;
    this.module = wasm.module;
    this.memory =
      options.memory ?? (this.instance.exports.memory as WebAssembly.Memory);

    // Wire the internal WASI instance to the same wasm instance + memory
    // so that preview1/unstable syscalls can access guest memory and the drive.
    this.wasi.instance = wasm.instance;
    this.wasi.module = wasm.module;
    this.wasi.memory = this.memory;
    this.wasi.hasBeenInitialized = true;

    if ("_initialize" in this.instance.exports) {
      throw new InvalidInstanceError(
        "WebAssembly instance is a reactor and should be started with initialize.",
      );
    }

    if (!("_start" in this.instance.exports)) {
      throw new InvalidInstanceError(
        "WebAssembly instance doesn't export _start, it may not be WASI or may be a Reactor.",
      );
    }

    const entrypoint = this.instance.exports._start as () => void;
    try {
      entrypoint();
    } catch (e) {
      if (e instanceof WASIXExit) {
        return {
          exitCode: e.code,
          fs: this.resultFs(),
        };
      } else if (e instanceof WebAssembly.RuntimeError) {
        return {
          exitCode: 134,
          fs: this.resultFs(),
        };
      } else {
        throw e;
      }
    }

    return {
      exitCode: 0,
      fs: this.resultFs(),
    };
  }

  //
  // Provider accessors — lazy-init defaults when context slot is unset.
  //

  private get clock(): ClockProvider {
    return this.context.clock ?? (this._clock ??= new SystemClockProvider());
  }

  private get random(): RandomProvider {
    return this.context.random ?? (this._random ??= new SystemRandomProvider());
  }

  /**
   * Resolve the filesystem provider.
   *
   * - If the host supplied a `FileSystemProvider`, use it directly.
   * - If the host supplied a `WASIFS`, lazy-wrap it in
   *   `WASIDriveFileSystemProvider` so the WASIX filesystem surface shares
   *   state with the internal WASI's preview1 drive. The internal WASI
   *   owns that drive; we mirror it here so mutations through either
   *   namespace are visible to both.
   * - Otherwise construct an empty drive.
   */
  private get fs(): FileSystemProvider {
    if (this._fs) return this._fs;
    const raw = this.context.fs;
    if (isFileSystemProvider(raw)) {
      this._fs = raw;
    } else {
      // Share the internal WASI's drive so preview1 and WASIX agree on fs state.
      this._fs = new WASIDriveFileSystemProvider(this.wasi.drive);
    }
    return this._fs;
  }

  private resultFs(): WASIFS {
    // Prefer the internal WASI drive's `fs` view (preserves existing
    // behaviour for hosts that passed a WASIFS). When the host supplied
    // a raw provider and it exposes a `drive`, return its `fs`; otherwise
    // fall back to an empty snapshot — the host owns the fs state in that
    // case.
    const provider = this.fs;
    if (provider instanceof WASIDriveFileSystemProvider) {
      return provider.drive.fs;
    }
    return this.wasi.drive.fs;
  }

  //
  // wasix_32v1 syscall handlers — clock / random / filesystem wired.
  //

  private wasix_clock_time_get(
    id: number,
    _precision: bigint,
    retptr: number,
  ): number {
    try {
      const view = new DataView(this.memory.buffer);
      view.setBigUint64(retptr, this.clock.now(id as ClockId), true);
      return Result.SUCCESS;
    } catch (e) {
      if (e instanceof WASIXError) return e.result;
      this.context.debug?.("clock_time_get", [], Result.EIO, [
        { error: String(e) },
      ]);
      return Result.EIO;
    }
  }

  private wasix_clock_res_get(id: number, retptr: number): number {
    try {
      const view = new DataView(this.memory.buffer);
      view.setBigUint64(retptr, this.clock.resolution(id as ClockId), true);
      return Result.SUCCESS;
    } catch (e) {
      if (e instanceof WASIXError) return e.result;
      this.context.debug?.("clock_res_get", [], Result.EIO, [
        { error: String(e) },
      ]);
      return Result.EIO;
    }
  }

  private wasix_random_get(bufPtr: number, bufLen: number): number {
    try {
      const buf = new Uint8Array(this.memory.buffer, bufPtr, bufLen);
      this.random.fill(buf);
      return Result.SUCCESS;
    } catch (e) {
      if (e instanceof WASIXError) return e.result;
      this.context.debug?.("random_get", [], Result.EIO, [
        { error: String(e) },
      ]);
      return Result.EIO;
    }
  }

  //
  // Filesystem syscalls
  //

  private wasix_fd_read(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    retptr: number,
  ): number {
    try {
      // STDIO routes through the internal WASI so stdin/out callbacks stay in
      // one place. Any non-stdio fd goes through the provider.
      if (fd === 0 || fd === 1 || fd === 2) {
        return this.wasi.fd_read(fd, iovsPtr, iovsLen, retptr);
      }
      const view = new DataView(this.memory.buffer);
      const iovs = readIOVectors(view, iovsPtr, iovsLen);
      const bytesRead = this.fs.fdRead(fd, iovs);
      view.setUint32(retptr, bytesRead, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_read");
    }
  }

  private wasix_fd_write(
    fd: number,
    ciovsPtr: number,
    ciovsLen: number,
    retptr: number,
  ): number {
    try {
      if (fd === 0 || fd === 1 || fd === 2) {
        return this.wasi.fd_write(fd, ciovsPtr, ciovsLen, retptr);
      }
      const view = new DataView(this.memory.buffer);
      const iovs = readIOVectors(view, ciovsPtr, ciovsLen);
      const bytesWritten = this.fs.fdWrite(fd, iovs);
      view.setUint32(retptr, bytesWritten, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_write");
    }
  }

  private wasix_fd_seek(
    fd: number,
    offset: bigint,
    whence: number,
    retptr: number,
  ): number {
    try {
      const newOffset = this.fs.fdSeek(fd, offset, whence);
      const view = new DataView(this.memory.buffer);
      view.setBigUint64(retptr, newOffset, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_seek");
    }
  }

  private wasix_fd_close(fd: number): number {
    try {
      this.fs.fdClose(fd);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_close");
    }
  }

  private wasix_fd_fdstat_get(fd: number, retptr: number): number {
    try {
      // STDIO still uses the internal WASI for stdio-specific fdstat shape.
      if (fd < 3) {
        return this.wasi.fd_fdstat_get(fd, retptr);
      }
      const stat = this.fs.fdFdstatGet(fd);
      const buffer = encodeFdstat(stat);
      new Uint8Array(this.memory.buffer, retptr, buffer.byteLength).set(buffer);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_fdstat_get");
    }
  }

  private wasix_fd_fdstat_set_flags(fd: number, flags: number): number {
    try {
      this.fs.fdFdstatSetFlags(fd, flags);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_fdstat_set_flags");
    }
  }

  private wasix_fd_filestat_get(fd: number, retptr: number): number {
    try {
      if (fd < 3) {
        return this.wasi.fd_filestat_get(fd, retptr);
      }
      const stat = this.fs.fdFilestatGet(fd);
      const buffer = encodeFilestat(stat);
      new Uint8Array(this.memory.buffer, retptr, buffer.byteLength).set(buffer);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_filestat_get");
    }
  }

  private wasix_fd_prestat_get(fd: number, retptr: number): number {
    try {
      const info = this.fs.fdPrestatGet(fd);
      if (info === null) {
        return Result.EBADF;
      }
      const view = new DataView(this.memory.buffer, retptr, PRESTAT_SIZE);
      view.setUint8(0, PreopenType.DIR);
      view.setUint32(4, new TextEncoder().encode(info.name).byteLength, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_prestat_get");
    }
  }

  private wasix_fd_prestat_dir_name(
    fd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const name = this.fs.fdPrestatDirName(fd);
      const bytes = new TextEncoder().encode(name);
      const dst = new Uint8Array(this.memory.buffer, pathPtr, pathLen);
      dst.set(bytes.subarray(0, pathLen));
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_prestat_dir_name");
    }
  }

  private wasix_fd_readdir(
    fd: number,
    bufPtr: number,
    bufLen: number,
    cookie: bigint,
    retptr: number,
  ): number {
    try {
      const entries = this.fs.fdReaddir(fd, cookie);
      const encoded = encodeDirectoryEntries(entries);
      const dst = new Uint8Array(this.memory.buffer, bufPtr, bufLen);
      const toWrite = encoded.subarray(0, bufLen);
      dst.set(toWrite);
      new DataView(this.memory.buffer).setUint32(
        retptr,
        toWrite.byteLength,
        true,
      );
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "fd_readdir");
    }
  }

  private wasix_path_open(
    fdDir: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    retptr: number,
  ): number {
    try {
      const path = readString(this.memory, pathPtr, pathLen);
      const newFd = this.fs.pathOpen(
        fdDir,
        dirflags,
        path,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
      );
      new DataView(this.memory.buffer).setUint32(retptr, newFd, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "path_open");
    }
  }

  private wasix_path_filestat_get(
    fdDir: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    retptr: number,
  ): number {
    try {
      const path = readString(this.memory, pathPtr, pathLen);
      const stat = this.fs.pathFilestatGet(fdDir, dirflags, path);
      const buffer = encodeFilestat(stat);
      new Uint8Array(this.memory.buffer, retptr, buffer.byteLength).set(buffer);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "path_filestat_get");
    }
  }

  private wasix_path_create_directory(
    fdDir: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const path = readString(this.memory, pathPtr, pathLen);
      this.fs.pathCreateDirectory(fdDir, path);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "path_create_directory");
    }
  }

  private wasix_path_unlink_file(
    fdDir: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const path = readString(this.memory, pathPtr, pathLen);
      this.fs.pathUnlinkFile(fdDir, path);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "path_unlink_file");
    }
  }

  private wasix_path_remove_directory(
    fdDir: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const path = readString(this.memory, pathPtr, pathLen);
      this.fs.pathRemoveDirectory(fdDir, path);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "path_remove_directory");
    }
  }

  private wasix_path_rename(
    oldFd: number,
    oldPathPtr: number,
    oldPathLen: number,
    newFd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number {
    try {
      const oldPath = readString(this.memory, oldPathPtr, oldPathLen);
      const newPath = readString(this.memory, newPathPtr, newPathLen);
      this.fs.pathRename(oldFd, oldPath, newFd, newPath);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "path_rename");
    }
  }

  private getWasix32v1Imports(): WebAssembly.ModuleImports {
    const enosys = () => Result.ENOSYS;
    return {
      // Args / environ
      args_get: enosys,
      args_sizes_get: enosys,
      environ_get: enosys,
      environ_sizes_get: enosys,

      // Clock
      clock_res_get: this.wasix_clock_res_get.bind(this),
      clock_time_get: this.wasix_clock_time_get.bind(this),

      // File descriptors
      fd_advise: enosys,
      fd_allocate: enosys,
      fd_close: this.wasix_fd_close.bind(this),
      fd_datasync: enosys,
      fd_dup: enosys,
      fd_event: enosys,
      fd_fdstat_get: this.wasix_fd_fdstat_get.bind(this),
      fd_fdstat_set_flags: this.wasix_fd_fdstat_set_flags.bind(this),
      fd_fdstat_set_rights: enosys,
      fd_filestat_get: this.wasix_fd_filestat_get.bind(this),
      fd_filestat_set_size: enosys,
      fd_filestat_set_times: enosys,
      fd_pread: enosys,
      fd_prestat_dir_name: this.wasix_fd_prestat_dir_name.bind(this),
      fd_prestat_get: this.wasix_fd_prestat_get.bind(this),
      fd_pwrite: enosys,
      fd_read: this.wasix_fd_read.bind(this),
      fd_readdir: this.wasix_fd_readdir.bind(this),
      fd_renumber: enosys,
      fd_seek: this.wasix_fd_seek.bind(this),
      fd_sync: enosys,
      fd_tell: enosys,
      fd_write: this.wasix_fd_write.bind(this),
      fd_pipe: enosys,

      // Paths
      path_create_directory: this.wasix_path_create_directory.bind(this),
      path_filestat_get: this.wasix_path_filestat_get.bind(this),
      path_filestat_set_times: enosys,
      path_link: enosys,
      path_open: this.wasix_path_open.bind(this),
      path_readlink: enosys,
      path_remove_directory: this.wasix_path_remove_directory.bind(this),
      path_rename: this.wasix_path_rename.bind(this),
      path_symlink: enosys,
      path_unlink_file: this.wasix_path_unlink_file.bind(this),

      // Process
      proc_exit: enosys,
      proc_fork: enosys,
      proc_exec: enosys,
      proc_join: enosys,
      proc_signal: enosys,
      proc_raise: enosys,
      proc_spawn: enosys,
      proc_id: enosys,
      proc_parent: enosys,

      // Random
      random_get: this.wasix_random_get.bind(this),

      // Scheduling
      sched_yield: enosys,

      // Sockets
      sock_accept: enosys,
      sock_addr_local: enosys,
      sock_addr_peer: enosys,
      sock_addr_resolve: enosys,
      sock_bind: enosys,
      sock_connect: enosys,
      sock_get_opt_flag: enosys,
      sock_get_opt_size: enosys,
      sock_get_opt_time: enosys,
      sock_listen: enosys,
      sock_open: enosys,
      sock_recv: enosys,
      sock_recv_from: enosys,
      sock_send: enosys,
      sock_send_file: enosys,
      sock_send_to: enosys,
      sock_set_opt_flag: enosys,
      sock_set_opt_size: enosys,
      sock_set_opt_time: enosys,
      sock_shutdown: enosys,
      sock_status: enosys,

      // Threads
      thread_exit: enosys,
      thread_id: enosys,
      thread_join: enosys,
      thread_parallelism: enosys,
      thread_signal: enosys,
      thread_sleep: enosys,
      thread_spawn: enosys,

      // Futex
      futex_wait: enosys,
      futex_wake: enosys,
      futex_wake_bitset: enosys,

      // Signals
      signal_register: enosys,
      proc_raise_interval: enosys,
      callback_signal: enosys,

      // TTY
      tty_get: enosys,
      tty_set: enosys,

      // Working directory
      getcwd: enosys,
      chdir: enosys,

      // Poll
      poll_oneoff: enosys,

      // Bus / IPC (future)
      bus_open_local: enosys,
      bus_open: enosys,
      bus_close: enosys,
      bus_call: enosys,
      bus_subscribe: enosys,
      bus_poll: enosys,

      // Port / networking (future)
      port_bridge: enosys,
      port_unbridge: enosys,
      port_dhcp_acquire: enosys,
      port_addr_add: enosys,
      port_addr_remove: enosys,
      port_addr_clear: enosys,
      port_addr_list: enosys,
      port_mac: enosys,
      port_gateway_add: enosys,
      port_gateway_clear: enosys,
      port_gateway_list: enosys,
      port_route_add: enosys,
      port_route_remove: enosys,
      port_route_clear: enosys,
      port_route_list: enosys,

      // Thread locals
      thread_local_create: enosys,
      thread_local_destroy: enosys,
      thread_local_get: enosys,
      thread_local_set: enosys,

      // epoll
      epoll_create: enosys,
      epoll_ctl: enosys,
      epoll_wait: enosys,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isFileSystemProvider(
  fs: WASIFS | FileSystemProvider | undefined,
): fs is FileSystemProvider {
  if (fs === undefined || fs === null) return false;
  // WASIFS is a plain object; FileSystemProvider has methods. We match by
  // the presence of a signature function rather than relying on `instanceof`
  // (hosts may subclass).
  return typeof (fs as FileSystemProvider).fdRead === "function";
}

function readString(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): string {
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

function readIOVectors(
  view: DataView,
  iovsPtr: number,
  iovsLen: number,
): Array<Uint8Array> {
  const result: Array<Uint8Array> = new Array(iovsLen);
  let ptr = iovsPtr;
  for (let i = 0; i < iovsLen; i++) {
    const bufferPtr = view.getUint32(ptr, true);
    ptr += 4;
    const bufferLen = view.getUint32(ptr, true);
    ptr += 4;
    result[i] = new Uint8Array(view.buffer, bufferPtr, bufferLen);
  }
  return result;
}

function mapError(
  e: unknown,
  debug: WASIXContext["debug"] | undefined,
  name: string,
): number {
  if (e instanceof WASIXError) return e.result;
  debug?.(name, [], Result.EIO, [{ error: String(e) }]);
  return Result.EIO;
}

function encodeFilestat(stat: {
  dev: bigint;
  ino: bigint;
  filetype: FileType;
  nlink: bigint;
  size: bigint;
  timestamps: { access: bigint; modification: bigint; change: bigint };
}): Uint8Array {
  const buffer = new Uint8Array(FILESTAT_SIZE);
  const view = new DataView(buffer.buffer);
  view.setBigUint64(0, stat.dev, true);
  view.setBigUint64(8, stat.ino, true);
  view.setUint8(16, stat.filetype);
  view.setBigUint64(24, stat.nlink, true);
  view.setBigUint64(32, stat.size, true);
  view.setBigUint64(40, stat.timestamps.access, true);
  view.setBigUint64(48, stat.timestamps.modification, true);
  view.setBigUint64(56, stat.timestamps.change, true);
  return buffer;
}

function encodeFdstat(stat: {
  filetype: FileType;
  fsFlags: number;
  fsRightsBase: bigint;
  fsRightsInheriting: bigint;
}): Uint8Array {
  const buffer = new Uint8Array(FDSTAT_SIZE);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, stat.filetype);
  view.setUint16(2, stat.fsFlags, true);
  view.setBigUint64(8, stat.fsRightsBase, true);
  view.setBigUint64(16, stat.fsRightsInheriting, true);
  return buffer;
}

function encodeDirectoryEntries(
  entries: Array<{
    next: bigint;
    ino: bigint;
    filetype: FileType;
    name: string;
  }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const encodedEntries = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const buffer = new Uint8Array(DIRENT_SIZE + nameBytes.byteLength);
    const view = new DataView(buffer.buffer);
    view.setBigUint64(0, entry.next, true);
    view.setBigUint64(8, entry.ino, true);
    view.setUint32(16, nameBytes.byteLength, true);
    view.setUint8(20, entry.filetype);
    buffer.set(nameBytes, DIRENT_SIZE);
    return buffer;
  });
  const totalLen = encodedEntries.reduce((acc, b) => acc + b.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const entry of encodedEntries) {
    out.set(entry, offset);
    offset += entry.byteLength;
  }
  return out;
}

// Re-export so consumers don't need the internal path. Used by wasix.ts
// only for lint/types; ALL_RIGHTS currently isn't referenced externally.
export { ALL_RIGHTS };
