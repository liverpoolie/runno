import {
  AddressFamily,
  ClockId,
  DIRENT_SIZE,
  FDSTAT_SIZE,
  FILESTAT_SIZE,
  FUTEX_RET_TIMEOUT,
  FUTEX_RET_WOKEN,
  FileType,
  PRESTAT_SIZE,
  PreopenType,
  Result,
  SockLevel,
  WASIXError,
} from "./wasix-32v1.js";
import { WASIXContext, WASIXContextOptions } from "./wasix-context.js";
import {
  WASI,
  InvalidInstanceError,
  InitializationError,
} from "../wasi/wasi.js";
import { WASIContextOptions } from "../wasi/wasi-context.js";
import { WASIXExecutionResult } from "../types.js";
import { SystemClockProvider } from "./providers/system-clock.js";
import { SystemRandomProvider } from "./providers/system-random.js";
import { WASIDriveFileSystemProvider } from "./providers/ergonomic/filesystem-provider.js";
import { MainThreadExit } from "./providers/cooperative-threads.js";
import {
  FUTEX_WAIT_MISMATCH,
  FUTEX_WAIT_OK,
  FUTEX_WAIT_TIMEOUT,
} from "./providers.js";
import type {
  ClockProvider,
  FileSystemProvider,
  FutexProvider,
  RandomProvider,
  SockAddr,
  SocketsProvider,
  ThreadsProvider,
} from "./providers.js";

class WASIXExit extends Error {
  code: number;
  constructor(code: number) {
    super();
    this.code = code;
  }
}

// One-shot warning: emitted on first construction when the host page is
// not cross-origin-isolated. wasix-libc binaries import a shared
// `env.memory`, which `WebAssembly.instantiate` rejects without
// `crossOriginIsolated`. Without this hint the failure looks like a
// generic "imported memory: shared but env doesn't allow shared memory"
// error from the engine.
let warnedNotCrossOriginIsolated = false;

/**
 * WASIX runtime for the browser.
 *
 * Sibling of WASI (not a subclass). Composes a WASI instance internally
 * to service wasi_snapshot_preview1 and wasi_unstable imports.
 * Filesystem syscalls route through a `FileSystemProvider`; clock and
 * random go through their respective providers. Memory marshalling lives
 * in this class — providers only ever see decoded JS-native values.
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

  /**
   * Current working directory as an absolute, normalised path. Mutated
   * by `chdir`, read by `getcwd`. Default `/home` mirrors wasix-libc's
   * compiled-in default (the wasmer runner mounts the test dir there).
   */
  private cwd: string = "/home";

  /**
   * Start a WASIX command.
   *
   * Buffers the module bytes so we can parse the import section
   * ourselves: `WebAssembly.Module.imports(module)` returns only the
   * `{ module, name, kind }` triple — descriptors (memory limits,
   * shared flag, table element type) are not in the standard surface.
   * We need those to construct a matching `WebAssembly.Memory` /
   * `WebAssembly.Table` for `env.memory` / `env.__indirect_function_table`,
   * so the parse runs over the raw bytes before compile.
   */
  static async start(
    wasmSource: Response | PromiseLike<Response>,
    context: Partial<WASIXContextOptions> = {},
  ): Promise<WASIXExecutionResult> {
    const wasix = new WASIX(context);
    const response = await wasmSource;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const envDescriptors = parseEnvImportDescriptors(bytes);
    const { memory, indirectFunctionTable } =
      wasix.resolveEnvImports(envDescriptors);
    const module = await WebAssembly.compile(bytes);
    const imports = wasix.getImportObject({ memory, indirectFunctionTable });
    const instance = await WebAssembly.instantiate(module, imports);
    return wasix.start({ module, instance }, { memory });
  }

  constructor(context: Partial<WASIXContextOptions>) {
    this.context = new WASIXContext(context);

    if (
      !warnedNotCrossOriginIsolated &&
      typeof globalThis !== "undefined" &&
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
        false
    ) {
      warnedNotCrossOriginIsolated = true;
      console.warn(
        "WASIX: page is not cross-origin-isolated; shared-memory imports " +
          "will fail at WebAssembly.instantiate. Configure COOP " +
          "(`Cross-Origin-Opener-Policy: same-origin`) and COEP " +
          "(`Cross-Origin-Embedder-Policy: require-corp`) on the host page.",
      );
    }
    // The internal WASI shares args / env / stdio with WASIX. wasix-libc
    // binaries reach for both `wasix_32v1` and `wasi_snapshot_preview1`
    // filesystem imports — preopen discovery (`fd_prestat_get`) lives in
    // preview1 — so the inner WASI must see the same drive as the WASIX
    // FileSystemProvider, not a separate empty drive. When the host hands
    // us the bundled `WASIDriveFileSystemProvider` we reuse its drive
    // directly; for opaque providers the inner preview1 fs stays empty
    // (those hosts shouldn't have wasix-libc binaries reaching for
    // preview1 fs in the first place).
    const wasiContext: Partial<WASIContextOptions> = {
      args: context.args,
      env: context.env,
      stdin: context.stdin,
      stdout: context.stdout,
      stderr: context.stderr,
      isTTY: context.isTTY,
      debug: context.debug,
      fs: {},
    };
    this.wasi = new WASI(wasiContext);
    if (this.context.fs instanceof WASIDriveFileSystemProvider) {
      this.wasi.drive = this.context.fs.drive;
    }
  }

  /**
   * Convert the parsed `env.*` import descriptors into concrete
   * `WebAssembly.Memory` / `WebAssembly.Table` instances, honouring any
   * host overrides on the context. Either result may be undefined when
   * the binary doesn't import the corresponding entry (preview1-style
   * binaries that export their own memory, for example).
   */
  resolveEnvImports(descriptors: ParsedEnvImports): {
    memory?: WebAssembly.Memory;
    indirectFunctionTable?: WebAssembly.Table;
  } {
    let memory: WebAssembly.Memory | undefined;
    let indirectFunctionTable: WebAssembly.Table | undefined;

    if (descriptors.memory) {
      const { initial, maximum, shared } = descriptors.memory;
      const override = this.context.memory;
      if (override) {
        validateMemoryOverride(override, { initial, maximum, shared });
        memory = override;
      } else {
        memory = new WebAssembly.Memory({
          initial,
          ...(maximum !== undefined ? { maximum } : {}),
          ...(shared ? { shared: true } : {}),
        } as WebAssembly.MemoryDescriptor);
      }
    }

    if (descriptors.table) {
      const { element, initial, maximum } = descriptors.table;
      const override = this.context.indirectFunctionTable;
      if (override) {
        validateTableOverride(override, { element, initial, maximum });
        indirectFunctionTable = override;
      } else {
        indirectFunctionTable = new WebAssembly.Table({
          element,
          initial,
          ...(maximum !== undefined ? { maximum } : {}),
        } as WebAssembly.TableDescriptor);
      }
    }

    return { memory, indirectFunctionTable };
  }

  getImportObject(
    env: {
      memory?: WebAssembly.Memory;
      indirectFunctionTable?: WebAssembly.Table;
    } = {},
  ) {
    const preview1 = this.wasi.getImports("preview1", this.context.debug);
    const unstable = this.wasi.getImports("unstable", this.context.debug);

    // Override proc_exit in both preview1 and unstable so that WASIXExit
    // is thrown instead of WASIExit (which is private to wasi.ts).
    const procExit = (code: number) => {
      throw new WASIXExit(code);
    };

    const envImports: WebAssembly.ModuleImports = {};
    if (env.memory) envImports.memory = env.memory;
    if (env.indirectFunctionTable)
      envImports.__indirect_function_table = env.indirectFunctionTable;

    // wasix-libc binaries discover preopens via preview1's
    // `fd_prestat_get` / `fd_prestat_dir_name`, not the wasix_32v1
    // surface. Override the preview1 entries so the FS provider's
    // preopen map (e.g. fd 4 = "/home") is visible to the libc startup
    // walk; otherwise it stops after fd 3 and never finds /home.
    const preview1Overrides = {
      ...preview1,
      proc_exit: procExit,
      fd_prestat_get: this.wasix_fd_prestat_get.bind(this),
      fd_prestat_dir_name: this.wasix_fd_prestat_dir_name.bind(this),
    };
    return {
      env: envImports,
      wasix_32v1: this.getWasix32v1Imports(),
      wasi_snapshot_preview1: preview1Overrides,
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
    // so that preview1/unstable syscalls can access guest memory.
    this.wasi.instance = wasm.instance;
    this.wasi.module = wasm.module;
    this.wasi.memory = this.memory;
    this.wasi.hasBeenInitialized = true;

    // Plumb the resolved memory + the guest's `wasi_thread_start` export
    // (if any) through to the provider slots that need them. Both hooks
    // are optional — providers that don't need them implement neither.
    maybeSetMemory(this.context.futex, this.memory);
    const threadStart = this.instance.exports.wasi_thread_start as
      | ((tid: number, startArg: number) => void)
      | undefined;
    if (typeof threadStart === "function") {
      maybeSetThreadStart(this.context.threads, threadStart);
    }

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
        return { exitCode: e.code };
      } else if (e instanceof MainThreadExit) {
        // The main thread invoked `thread_exit`. wasix-libc treats this
        // as a process exit with the supplied code.
        return { exitCode: e.exitCode };
      } else if (e instanceof WebAssembly.RuntimeError) {
        return { exitCode: 134 };
      } else {
        throw e;
      }
    }

    return { exitCode: 0 };
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

  private get sockets(): SocketsProvider | undefined {
    return this.context.sockets;
  }

  private get fs(): FileSystemProvider {
    return this.context.fs;
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

  // path_open2 is the wasix v2 variant: same as preview1 path_open
  // plus an extended fdflags2 word (the last i32 before retptr). The
  // extra flag bits are not yet modelled, but ignoring them and routing
  // through the existing pathOpen unblocks every wasix-libc binary
  // that calls open()/opendir() — those use path_open2 unconditionally.
  // TODO(slice-9): honour fdflags2 once the fd-table extraction surfaces
  //   semantics for the new bits (close-on-exec etc.).
  private wasix_path_open2(
    fdDir: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    _fdflags2: number,
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
      return mapError(e, this.context.debug, "path_open2");
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

  //
  // Working directory — getcwd / chdir. wasix-libc binaries call these
  // directly; preview1 has no cwd surface. wasix-libc's `__wasilibc_resolve_path`
  // reads getcwd to turn relative paths absolute before walking the
  // preopen table, so the cwd lives entirely as runtime state — there is
  // no per-syscall cwd-relative resolution further down the path stack.
  //
  // ABI:
  //   getcwd(path_buf: *mut u8, path_buf_len: *mut u32) -> errno
  //     - On entry, *path_buf_len is the buffer's capacity.
  //     - On exit, *path_buf_len is set to the cwd's byte length and
  //       up to that many bytes are copied into path_buf. EOVERFLOW is
  //       returned (and the length is still written) when the buffer is
  //       too small, mirroring upstream wasmer behaviour so callers can
  //       grow the buffer and retry.
  //   chdir(path: *const u8, path_len: u32) -> errno
  //     - The string is treated as either absolute or relative-to-cwd
  //       and validated by checking that the resolved path lives under
  //       a known preopen and resolves to a directory in the FS provider.
  //

  private wasix_getcwd(pathBufPtr: number, pathLenPtr: number): number {
    try {
      const view = new DataView(this.memory.buffer);
      const maxLen = view.getUint32(pathLenPtr, true);
      const bytes = new TextEncoder().encode(this.cwd);
      // Always write the actual length first — upstream wasmer does the
      // same so callers can retry with a larger buffer after EOVERFLOW.
      view.setUint32(pathLenPtr, bytes.byteLength, true);
      if (bytes.byteLength > maxLen) {
        return Result.EOVERFLOW;
      }
      new Uint8Array(this.memory.buffer, pathBufPtr, bytes.byteLength).set(
        bytes,
      );
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "getcwd");
    }
  }

  private wasix_chdir(pathPtr: number, pathLen: number): number {
    try {
      const path = readString(this.memory, pathPtr, pathLen);
      const resolved = resolveAbsolute(this.cwd, path);
      const match = this.findPreopenFor(resolved);
      if (match === null) {
        return Result.ENOENT;
      }
      // The preopen root itself is always a directory; only validate
      // when there's a non-trivial relative component to look up.
      if (match.relativePath !== "" && match.relativePath !== ".") {
        const stat = this.fs.pathFilestatGet(match.fd, 0, match.relativePath);
        if (stat.filetype !== FileType.DIRECTORY) {
          return Result.ENOTDIR;
        }
      }
      this.cwd = resolved;
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "chdir");
    }
  }

  /**
   * Find which preopen owns an absolute path. Iterates fds starting at
   * 3 until `fdPrestatGet` returns null, picking the longest matching
   * preopen name so nested mounts (e.g. "/home" vs "/") resolve to the
   * more specific fd. The "." preopen is treated as the implicit root
   * — it matches every absolute path but loses to any named match.
   */
  private findPreopenFor(
    absPath: string,
  ): { fd: number; relativePath: string } | null {
    let best: { fd: number; relativePath: string; nameLen: number } | null =
      null;
    for (let fd = 3; fd < 256; fd++) {
      const info = this.fs.fdPrestatGet(fd);
      if (info === null) break;
      const name = info.name;
      if (name === "." || name === "/") {
        if (best === null) {
          best = {
            fd,
            relativePath: stripLeadingSlash(absPath),
            nameLen: 0,
          };
        }
        continue;
      }
      if (absPath === name) {
        if (best === null || best.nameLen < name.length) {
          best = { fd, relativePath: ".", nameLen: name.length };
        }
        continue;
      }
      if (absPath.startsWith(name + "/")) {
        if (best === null || best.nameLen < name.length) {
          best = {
            fd,
            relativePath: absPath.slice(name.length + 1),
            nameLen: name.length,
          };
        }
      }
    }
    return best;
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

  //
  // Sockets syscalls (Slice 5).
  //
  // The provider sees decoded JS-native shapes; pointer arithmetic stays
  // here. `requireSockets` returns ENOTSUP — wasix's "no sockets" sentinel —
  // when no provider is configured. WASIXError → its errno; anything else →
  // EIO via `mapError`.

  private requireSockets(): SocketsProvider {
    if (!this.sockets) {
      throw new WASIXError(Result.ENOTSUP);
    }
    return this.sockets;
  }

  private wasix_sock_open(
    af: number,
    type: number,
    proto: number,
    retfdPtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const fd = provider.open(af, type, proto);
      new DataView(this.memory.buffer).setUint32(retfdPtr, fd, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_open");
    }
  }

  private wasix_sock_bind(fd: number, addrPtr: number): number {
    try {
      const provider = this.requireSockets();
      const addr = readSockAddrPort(this.memory, addrPtr);
      const result = provider.bind(fd, addr);
      return result;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_bind");
    }
  }

  private wasix_sock_connect(fd: number, addrPtr: number): number {
    try {
      const provider = this.requireSockets();
      const addr = readSockAddrPort(this.memory, addrPtr);
      const result = provider.connect(fd, addr);
      return result;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_connect");
    }
  }

  private wasix_sock_listen(fd: number, backlog: number): number {
    try {
      const provider = this.requireSockets();
      return provider.listen(fd, backlog);
    } catch (e) {
      return mapError(e, this.context.debug, "sock_listen");
    }
  }

  private wasix_sock_accept(
    fd: number,
    _fdflags: number,
    retfdPtr: number,
    retaddrPtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const { fd: newFd, addr } = provider.accept(fd);
      const view = new DataView(this.memory.buffer);
      view.setUint32(retfdPtr, newFd, true);
      writeSockAddrPort(this.memory, retaddrPtr, addr);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_accept");
    }
  }

  private wasix_sock_send(
    fd: number,
    siDataPtr: number,
    siDataLen: number,
    siFlags: number,
    retSizePtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const view = new DataView(this.memory.buffer);
      const iovs = readIOVectors(view, siDataPtr, siDataLen);
      const written = provider.send(fd, iovs, siFlags);
      view.setUint32(retSizePtr, written, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_send");
    }
  }

  private wasix_sock_recv(
    fd: number,
    riDataPtr: number,
    riDataLen: number,
    riFlags: number,
    retSizePtr: number,
    retFlagsPtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const view = new DataView(this.memory.buffer);
      const iovs = readIOVectors(view, riDataPtr, riDataLen);
      const result = provider.recv(fd, iovs, riFlags);
      view.setUint32(retSizePtr, result.bytesRead, true);
      view.setUint16(retFlagsPtr, result.flags, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_recv");
    }
  }

  private wasix_sock_shutdown(fd: number, how: number): number {
    try {
      const provider = this.requireSockets();
      return provider.shutdown(fd, how);
    } catch (e) {
      return mapError(e, this.context.debug, "sock_shutdown");
    }
  }

  // ABI: 6 i32 args, no `hints_ptr`. Confirmed against wasix-libc's
  // generated import (`__imported_wasix_32v1_resolve` in
  // `libc-bottom-half/sources/__wasixlibc_real.c`) and the wasmer host
  // signature (`lib/wasix/src/syscalls/wasix/resolve.rs`); both expose
  // (host_ptr, host_len, port, retaddrs_ptr, naddrs_max, retnaddrs_ptr).
  // The earlier draft of WASIX-PLAN.md listing 7 args with a `hints_ptr`
  // was wrong. Hints are accepted by the provider for API symmetry but
  // never reach the wasm boundary in this revision of the spec.
  private wasix_sock_addr_resolve(
    hostPtr: number,
    hostLen: number,
    port: number,
    retaddrsPtr: number,
    naddrsMax: number,
    retNaddrsPtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const host = readString(this.memory, hostPtr, hostLen);
      const addrs = provider.addrResolve(host, port, {});
      const view = new DataView(this.memory.buffer);
      const count = Math.min(addrs.length, naddrsMax);
      let cursor = retaddrsPtr;
      for (let i = 0; i < count; i++) {
        writeSockAddrNoPort(this.memory, cursor, addrs[i]);
        cursor += SOCK_ADDR_BYTES;
      }
      view.setUint32(retNaddrsPtr, count, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_addr_resolve");
    }
  }

  private wasix_sock_get_opt_flag(
    fd: number,
    name: number,
    retPtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const value = provider.getOptFlag(fd, SockLevel.SOCKET, name);
      new DataView(this.memory.buffer).setUint8(retPtr, value ? 1 : 0);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_get_opt_flag");
    }
  }

  private wasix_sock_set_opt_flag(
    fd: number,
    name: number,
    flag: number,
  ): number {
    try {
      const provider = this.requireSockets();
      return provider.setOptFlag(fd, SockLevel.SOCKET, name, flag !== 0);
    } catch (e) {
      return mapError(e, this.context.debug, "sock_set_opt_flag");
    }
  }

  private wasix_sock_get_opt_size(
    fd: number,
    name: number,
    retPtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const value = provider.getOptSize(fd, SockLevel.SOCKET, name);
      new DataView(this.memory.buffer).setBigUint64(
        retPtr,
        BigInt(value >>> 0),
        true,
      );
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_get_opt_size");
    }
  }

  private wasix_sock_set_opt_size(
    fd: number,
    name: number,
    size: bigint,
  ): number {
    try {
      const provider = this.requireSockets();
      // size arrives as i64; truncate to 32-bit unsigned for the provider.
      const sizeNum = Number(size & 0xffffffffn);
      return provider.setOptSize(fd, SockLevel.SOCKET, name, sizeNum);
    } catch (e) {
      return mapError(e, this.context.debug, "sock_set_opt_size");
    }
  }

  private wasix_sock_get_opt_time(
    fd: number,
    name: number,
    retPtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const value = provider.getOptTime(fd, SockLevel.SOCKET, name);
      const view = new DataView(this.memory.buffer);
      // Layout: [tag u8][_pad u8 × 7][value i64 LE]. tag=0 → no timeout.
      view.setUint8(retPtr, value === null ? 0 : 1);
      view.setBigInt64(retPtr + 8, value ?? 0n, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_get_opt_time");
    }
  }

  private wasix_sock_set_opt_time(
    fd: number,
    name: number,
    timePtr: number,
  ): number {
    try {
      const provider = this.requireSockets();
      const view = new DataView(this.memory.buffer);
      const tag = view.getUint8(timePtr);
      const value = tag === 0 ? null : view.getBigInt64(timePtr + 8, true);
      return provider.setOptTime(fd, SockLevel.SOCKET, name, value);
    } catch (e) {
      return mapError(e, this.context.debug, "sock_set_opt_time");
    }
  }

  private wasix_sock_addr_local(fd: number, retPtr: number): number {
    try {
      const provider = this.requireSockets();
      const addr = provider.addrLocal(fd);
      writeSockAddrPort(this.memory, retPtr, addr);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_addr_local");
    }
  }

  private wasix_sock_addr_peer(fd: number, retPtr: number): number {
    try {
      const provider = this.requireSockets();
      const addr = provider.addrPeer(fd);
      writeSockAddrPort(this.memory, retPtr, addr);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_addr_peer");
    }
  }

  private wasix_sock_status(fd: number, retPtr: number): number {
    try {
      const provider = this.requireSockets();
      const status = provider.status(fd);
      new DataView(this.memory.buffer).setUint8(retPtr, status);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "sock_status");
    }
  }

  //
  // Threads syscalls (Slice 6).
  //

  private get threads(): ThreadsProvider | undefined {
    return this.context.threads;
  }

  private get futex(): FutexProvider | undefined {
    return this.context.futex;
  }

  private requireThreads(): ThreadsProvider {
    if (!this.threads) {
      throw new WASIXError(Result.ENOSYS);
    }
    return this.threads;
  }

  private requireFutex(): FutexProvider {
    if (!this.futex) {
      throw new WASIXError(Result.ENOSYS);
    }
    return this.futex;
  }

  private wasix_thread_spawn(startArgPtr: number, retTidPtr: number): number {
    try {
      const tid = this.requireThreads().spawn(startArgPtr);
      new DataView(this.memory.buffer).setUint32(retTidPtr, tid >>> 0, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "thread_spawn");
    }
  }

  private wasix_thread_join(tid: number, retPtr: number): number {
    try {
      const code = this.requireThreads().join(tid >>> 0);
      // wasix-libc's join writes the exit code (i32) at retPtr. -1 is
      // surfaced verbatim — the guest can detect a missing tid.
      new DataView(this.memory.buffer).setInt32(retPtr, code | 0, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "thread_join");
    }
  }

  private wasix_thread_exit(code: number): number {
    // `exit()` is documented to unwind via throw — the provider raises
    // a sentinel that the cooperative scheduler (or, for the main
    // thread, `WASIX.start`) catches up the JS call stack. We do NOT
    // wrap the call in `try/catch`: a `WASIXError` on a missing-provider
    // path is the only "ordinary error" possible here, so surface it
    // explicitly and let everything else propagate.
    if (!this.threads) {
      this.context.debug?.("thread_exit", [], Result.ENOSYS, []);
      return Result.ENOSYS;
    }
    this.threads.exit(code | 0);
    // Defensive: providers that return without throwing surface ENOSYS
    // so the guest sees a clear signal rather than silent fall-through.
    return Result.ENOSYS;
  }

  private wasix_thread_sleep(durationNs: bigint): number {
    try {
      this.requireThreads().sleep(durationNs);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "thread_sleep");
    }
  }

  private wasix_thread_id(retPtr: number): number {
    try {
      const tid = this.requireThreads().id();
      new DataView(this.memory.buffer).setUint32(retPtr, tid >>> 0, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "thread_id");
    }
  }

  private wasix_thread_parallelism(retPtr: number): number {
    try {
      const n = this.requireThreads().parallelism();
      new DataView(this.memory.buffer).setUint32(retPtr, n >>> 0, true);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "thread_parallelism");
    }
  }

  private wasix_thread_signal(tid: number, signo: number): number {
    try {
      return this.requireThreads().signal(tid >>> 0, signo | 0);
    } catch (e) {
      return mapError(e, this.context.debug, "thread_signal");
    }
  }

  //
  // Futex syscalls (Slice 6).
  //
  // The wasix `futex_wait` ABI is:
  //   futex_wait(futex_ptr, expected, timeout_ptr, ret_woken_ptr) -> errno
  // where `timeout_ptr` is an `__wasi_optional_timestamp_t` (tag byte +
  // 7 bytes pad + i64 ns). On a value mismatch the host returns EAGAIN
  // and does not touch `ret_woken_ptr`. Otherwise it returns SUCCESS and
  // writes 1 (woken) or 0 (timeout) to `ret_woken_ptr`.
  //
  // `futex_wake(futex_ptr, ret_woken_ptr) -> errno` wakes one waiter
  // (provider sees `wake(addr, 1)`). `futex_wake_all(futex_ptr,
  // ret_woken_ptr) -> errno` wakes all (`wake(addr, MAX_SAFE_INTEGER)`).
  // `ret_woken_ptr` receives 1 if at least one waiter was woken, else 0.

  private wasix_futex_wait(
    futexPtr: number,
    expected: number,
    timeoutPtr: number,
    retWokenPtr: number,
  ): number {
    try {
      const provider = this.requireFutex();
      const timeoutNs = readOptionalTimestamp(this.memory, timeoutPtr);
      const result = provider.wait(futexPtr, expected | 0, timeoutNs);
      if (result === FUTEX_WAIT_MISMATCH) {
        return Result.EAGAIN;
      }
      const view = new DataView(this.memory.buffer);
      if (result === FUTEX_WAIT_OK) {
        view.setUint8(retWokenPtr, FUTEX_RET_WOKEN);
      } else if (result === FUTEX_WAIT_TIMEOUT) {
        view.setUint8(retWokenPtr, FUTEX_RET_TIMEOUT);
      } else {
        // Unknown discriminant — treat as an internal error.
        return Result.EIO;
      }
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "futex_wait");
    }
  }

  private wasix_futex_wake(futexPtr: number, retWokenPtr: number): number {
    try {
      const provider = this.requireFutex();
      const woken = provider.wake(futexPtr, 1);
      new DataView(this.memory.buffer).setUint8(retWokenPtr, woken > 0 ? 1 : 0);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "futex_wake");
    }
  }

  private wasix_futex_wake_all(futexPtr: number, retWokenPtr: number): number {
    try {
      const provider = this.requireFutex();
      const woken = provider.wake(futexPtr, Number.MAX_SAFE_INTEGER);
      new DataView(this.memory.buffer).setUint8(retWokenPtr, woken > 0 ? 1 : 0);
      return Result.SUCCESS;
    } catch (e) {
      return mapError(e, this.context.debug, "futex_wake_all");
    }
  }

  private getWasix32v1Imports(): WebAssembly.ModuleImports {
    const enosys = () => Result.ENOSYS;
    // proc_exit2 mirrors proc_exit semantics: terminate the run with the
    // supplied code. wasix-libc's exit path always goes through proc_exit2;
    // proc_exit (v1) is left wired ENOSYS until a binary surfaces it.
    const procExit2 = (code: number) => {
      throw new WASIXExit(code);
    };
    return {
      // Args / environ — share the internal WASI's preview1 implementations
      // so wasix-libc's argv/environ setup sees the values that were passed
      // to the WASIXContext.
      args_get: this.wasi.args_get.bind(this.wasi),
      args_sizes_get: this.wasi.args_sizes_get.bind(this.wasi),
      environ_get: this.wasi.environ_get.bind(this.wasi),
      environ_sizes_get: this.wasi.environ_sizes_get.bind(this.wasi),

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

      // wasix_32v1 v2 fd surface — flag-extended variants. Stubbed
      // ENOSYS until the fd-table extraction (Slice 9) lifts the
      // backing semantics out of WASIDrive.
      fd_dup2: enosys, // TODO(slice-9): alias of fd_renumber
      fd_fdflags_get: enosys, // TODO(slice-9): mirrors fd_fdstat_get fs_flags
      fd_fdflags_set: enosys, // TODO(slice-9): mirrors fd_fdstat_set_flags

      // Paths
      path_create_directory: this.wasix_path_create_directory.bind(this),
      path_filestat_get: this.wasix_path_filestat_get.bind(this),
      path_filestat_set_times: enosys,
      path_link: enosys,
      path_open: this.wasix_path_open.bind(this),
      path_open2: this.wasix_path_open2.bind(this),
      path_readlink: enosys,
      path_remove_directory: this.wasix_path_remove_directory.bind(this),
      path_rename: this.wasix_path_rename.bind(this),
      path_symlink: enosys,
      path_unlink_file: this.wasix_path_unlink_file.bind(this),

      // Process
      proc_exit: enosys,
      proc_exit2: procExit2,
      proc_fork: enosys,
      proc_fork_env: enosys, // TODO(slice-7): proc/fork provider
      proc_exec: enosys,
      proc_exec3: enosys, // TODO(slice-7): proc/exec provider
      proc_join: enosys,
      proc_signal: enosys,
      // proc_signals_get / _sizes_get land with the signals provider in
      // Slice 8. Until then we report "zero registered signals" instead
      // of ENOSYS — wasix-libc's startup path treats ENOSYS as a fatal
      // init error and exits with 71 before reaching `main`, but a
      // size-0 signals table is the well-formed "no signals" answer
      // that lets early init complete.
      proc_signals_get: () => Result.SUCCESS,
      proc_signals_sizes_get: (sizePtr: number) => {
        new DataView(this.memory.buffer).setUint32(sizePtr, 0, true);
        return Result.SUCCESS;
      },
      proc_raise: enosys,
      proc_spawn: enosys,
      proc_spawn2: enosys, // TODO(slice-7): proc/spawn provider
      proc_id: enosys,
      proc_parent: enosys,

      // Random
      random_get: this.wasix_random_get.bind(this),

      // Scheduling
      sched_yield: enosys,

      // Sockets
      sock_accept: this.wasix_sock_accept.bind(this),
      sock_addr_local: this.wasix_sock_addr_local.bind(this),
      sock_addr_peer: this.wasix_sock_addr_peer.bind(this),
      sock_addr_resolve: this.wasix_sock_addr_resolve.bind(this),
      sock_bind: this.wasix_sock_bind.bind(this),
      sock_connect: this.wasix_sock_connect.bind(this),
      sock_get_opt_flag: this.wasix_sock_get_opt_flag.bind(this),
      sock_get_opt_size: this.wasix_sock_get_opt_size.bind(this),
      sock_get_opt_time: this.wasix_sock_get_opt_time.bind(this),
      sock_listen: this.wasix_sock_listen.bind(this),
      sock_open: this.wasix_sock_open.bind(this),
      sock_recv: this.wasix_sock_recv.bind(this),
      sock_recv_from: enosys,
      sock_send: this.wasix_sock_send.bind(this),
      sock_send_file: enosys,
      sock_send_to: enosys,
      sock_set_opt_flag: this.wasix_sock_set_opt_flag.bind(this),
      sock_set_opt_size: this.wasix_sock_set_opt_size.bind(this),
      sock_set_opt_time: this.wasix_sock_set_opt_time.bind(this),
      sock_shutdown: this.wasix_sock_shutdown.bind(this),
      sock_status: this.wasix_sock_status.bind(this),

      // Threads
      thread_exit: this.wasix_thread_exit.bind(this),
      thread_id: this.wasix_thread_id.bind(this),
      thread_join: this.wasix_thread_join.bind(this),
      thread_parallelism: this.wasix_thread_parallelism.bind(this),
      thread_signal: this.wasix_thread_signal.bind(this),
      thread_sleep: this.wasix_thread_sleep.bind(this),
      thread_spawn: this.wasix_thread_spawn.bind(this),

      // Futex
      futex_wait: this.wasix_futex_wait.bind(this),
      futex_wake: this.wasix_futex_wake.bind(this),
      futex_wake_all: this.wasix_futex_wake_all.bind(this),
      futex_wake_bitset: enosys,

      // Signals
      signal_register: enosys,
      proc_raise_interval: enosys,
      callback_signal: enosys,

      // TTY
      tty_get: enosys,
      tty_set: enosys,

      // Working directory
      getcwd: this.wasix_getcwd.bind(this),
      chdir: this.wasix_chdir.bind(this),

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

/**
 * Descriptor info for the two `env.*` imports that drive WASIX module
 * instantiation. Either field is absent when the binary doesn't import
 * the corresponding entity.
 */
type ParsedEnvImports = {
  memory?: { initial: number; maximum?: number; shared: boolean };
  table?: {
    element: "funcref" | "externref";
    initial: number;
    maximum?: number;
  };
};

/**
 * Walk the wasm import section just far enough to extract the descriptor
 * for `env.memory` and `env.__indirect_function_table`. The standard
 * `WebAssembly.Module.imports()` API only returns `{ module, name, kind }`
 * — limits and the shared flag are not exposed — so we read them out of
 * the binary directly. Returns descriptors for whichever of the two are
 * present; missing entries map to undefined fields.
 *
 * The parser only descends into section id 2 (Imports) and stops as soon
 * as the imports run out. It tolerates unknown leading custom sections.
 *
 * Wasm binary layout (relevant subset):
 *   magic+version (8 bytes), then a sequence of sections:
 *     section: id:byte, size:varuint32, content:bytes[size]
 *   Imports section content:
 *     count:varuint32, entries:Import[count]
 *   Import:
 *     module:vec<u8>, name:vec<u8>, kind:byte, descriptor
 *   Memory descriptor (kind=2):
 *     limits-flag:byte (bit0=has_max, bit1=shared, bit2=memory64)
 *     min:varuint32 (or varuint64 if memory64)
 *     max:varuint32 (or varuint64) if has_max
 *   Table descriptor (kind=1):
 *     elem-type:byte (0x70=funcref, 0x6f=externref)
 *     limits-flag:byte (bit0=has_max), then min, then max if has_max
 */
function parseEnvImportDescriptors(bytes: Uint8Array): ParsedEnvImports {
  const out: ParsedEnvImports = {};

  // Magic 0x00 0x61 0x73 0x6d ('\0asm') and version 1.
  if (bytes.length < 8) return out;
  if (
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    return out;
  }

  let offset = 8;
  const decoder = new TextDecoder();

  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const [sectionSize, sizeOffset] = readVarUint32(bytes, offset);
    offset = sizeOffset;
    const sectionEnd = offset + sectionSize;

    if (sectionId !== 2) {
      offset = sectionEnd;
      continue;
    }

    const [importCount, countOffset] = readVarUint32(bytes, offset);
    offset = countOffset;

    for (let i = 0; i < importCount; i++) {
      const [modLen, modLenEnd] = readVarUint32(bytes, offset);
      offset = modLenEnd;
      const modName = decoder.decode(bytes.subarray(offset, offset + modLen));
      offset += modLen;

      const [nmLen, nmLenEnd] = readVarUint32(bytes, offset);
      offset = nmLenEnd;
      const importName = decoder.decode(bytes.subarray(offset, offset + nmLen));
      offset += nmLen;

      const kind = bytes[offset++];

      // 0=function, 1=table, 2=memory, 3=global. We only care about
      // env.memory and env.__indirect_function_table; everything else
      // gets skipped past by reading just enough of its descriptor to
      // advance the cursor.
      if (kind === 0) {
        // function: typeidx
        const [, end] = readVarUint32(bytes, offset);
        offset = end;
      } else if (kind === 1) {
        // table: reftype + limits
        const elemTypeByte = bytes[offset++];
        const flags = bytes[offset++];
        const [initial, afterInitial] = readVarUint32(bytes, offset);
        offset = afterInitial;
        let maximum: number | undefined;
        if (flags & 0x01) {
          const [max, afterMax] = readVarUint32(bytes, offset);
          maximum = max;
          offset = afterMax;
        }
        if (modName === "env" && importName === "__indirect_function_table") {
          const element = elemTypeByte === 0x6f ? "externref" : "funcref";
          out.table = { element, initial, maximum };
        }
      } else if (kind === 2) {
        // memory: limits with shared bit
        const flags = bytes[offset++];
        const isMemory64 = (flags & 0x04) !== 0;
        const [initial, afterInitial] = isMemory64
          ? readVarUint64AsNumber(bytes, offset)
          : readVarUint32(bytes, offset);
        offset = afterInitial;
        let maximum: number | undefined;
        if (flags & 0x01) {
          const [max, afterMax] = isMemory64
            ? readVarUint64AsNumber(bytes, offset)
            : readVarUint32(bytes, offset);
          maximum = max;
          offset = afterMax;
        }
        if (modName === "env" && importName === "memory") {
          out.memory = {
            initial,
            maximum,
            shared: (flags & 0x02) !== 0,
          };
        }
      } else if (kind === 3) {
        // global: valtype + mutability
        offset += 2;
      } else {
        // Unknown kind — bail to be safe rather than misalign the parse.
        return out;
      }
    }

    return out;
  }

  return out;
}

function readVarUint32(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (true) {
    const b = bytes[offset++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) {
      throw new Error("WASIX: malformed varuint32 in module import section");
    }
  }
  return [result >>> 0, offset];
}

function readVarUint64AsNumber(
  bytes: Uint8Array,
  offset: number,
): [number, number] {
  let result = 0n;
  let shift = 0n;
  while (true) {
    const b = bytes[offset++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) {
      throw new Error("WASIX: malformed varuint64 in module import section");
    }
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("WASIX: memory64 limit exceeds Number.MAX_SAFE_INTEGER");
  }
  return [Number(result), offset];
}

function validateMemoryOverride(
  memory: WebAssembly.Memory,
  descriptor: { initial: number; maximum?: number; shared: boolean },
): void {
  // Engines expose memory.buffer as a SharedArrayBuffer when the
  // underlying memory is shared.
  const overrideShared =
    typeof SharedArrayBuffer !== "undefined" &&
    memory.buffer instanceof SharedArrayBuffer;
  if (overrideShared !== descriptor.shared) {
    throw new Error(
      `WASIX: provided memory.shared=${overrideShared} does not match ` +
        `module's env.memory.shared=${descriptor.shared}`,
    );
  }
  const overrideInitial = memory.buffer.byteLength / 65536;
  if (overrideInitial < descriptor.initial) {
    throw new Error(
      `WASIX: provided memory has ${overrideInitial} pages but ` +
        `module's env.memory requires initial=${descriptor.initial}`,
    );
  }
  // Maximum is not directly observable on the JS side without a private
  // grow attempt, so we rely on the engine to reject at instantiation
  // time if the override's max is below the descriptor's max.
}

function validateTableOverride(
  table: WebAssembly.Table,
  descriptor: { element: string; initial: number; maximum?: number },
): void {
  if (table.length < descriptor.initial) {
    throw new Error(
      `WASIX: provided indirect function table has length ${table.length} ` +
        `but module's env.__indirect_function_table requires ` +
        `initial=${descriptor.initial}`,
    );
  }
  // Element type is not introspectable from JS; the engine rejects on
  // mismatch at instantiation time. Maximum likewise.
  void descriptor.element;
  void descriptor.maximum;
}

/**
 * Resolve a guest-supplied path against the current working directory.
 * Absolute paths (leading `/`) bypass the cwd join. The result is
 * normalised so `..` segments fold correctly and trailing slashes are
 * dropped (except for the root).
 *
 * Used by `chdir` to compute the absolute target of a relative cwd
 * change. Other syscalls do not call this — wasix-libc resolves
 * relative paths against `getcwd()` itself before calling `path_*`,
 * so by the time a path reaches the runtime it is already preopen-
 * relative.
 */
function resolveAbsolute(cwd: string, path: string): string {
  const joined = path.startsWith("/") ? path : `${cwd}/${path}`;
  const segments = joined.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return "/" + out.join("/");
}

function stripLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function readString(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): string {
  // Copy out before decoding: when env.memory is a SharedArrayBuffer
  // (the threaded wasix-libc default) TextDecoder rejects views over it.
  // `slice` returns a Uint8Array backed by a fresh non-shared ArrayBuffer.
  return new TextDecoder().decode(
    new Uint8Array(memory.buffer, ptr, len).slice(),
  );
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

// ─── Sockets address marshalling ────────────────────────────────────────────
//
// Compact wire layout (slice-internal — see plan § "Risks / judgement
// calls flagged for review"). The wasix in-memory `__wasi_addr_port_t`
// struct varies across libc versions; we pick a single layout here and
// document it so Slice 6/8 can find it. The loopback test harness's WAT
// guest uses the same layout — when the wasmer suite is rebuilt under
// wasixcc, this layout may need to track upstream's actual struct.
//
// __wasi_addr_t (no port) — 20 bytes:
//   offset 0  : family tag u8 (0=UNSPEC, 1=INET4, 2=INET6, 3=UNIX)
//   offset 4..: address bytes — 4 for INET4, 16 for INET6, 16 for UNIX
//
// __wasi_addr_port_t (with port) — 22 bytes (laid out as 24 with padding):
//   offset 0  : family tag u8
//   offset 2  : port u16 LE
//   offset 4..: address bytes (same as above)

const SOCK_ADDR_BYTES = 20;
const SOCK_ADDR_PORT_BYTES = 24;

function readSockAddrPort(memory: WebAssembly.Memory, ptr: number): SockAddr {
  const view = new DataView(memory.buffer);
  const tag = view.getUint8(ptr);
  const port = view.getUint16(ptr + 2, true);
  return readSockAddrBody(memory, ptr + 4, tag, port);
}

function writeSockAddrPort(
  memory: WebAssembly.Memory,
  ptr: number,
  addr: SockAddr,
): void {
  const view = new DataView(memory.buffer);
  const buf = new Uint8Array(memory.buffer, ptr, SOCK_ADDR_PORT_BYTES);
  buf.fill(0);
  view.setUint8(ptr, familyTag(addr));
  view.setUint16(ptr + 2, sockAddrPort(addr), true);
  writeSockAddrBody(memory, ptr + 4, addr);
}

function writeSockAddrNoPort(
  memory: WebAssembly.Memory,
  ptr: number,
  addr: SockAddr,
): void {
  const view = new DataView(memory.buffer);
  const buf = new Uint8Array(memory.buffer, ptr, SOCK_ADDR_BYTES);
  buf.fill(0);
  view.setUint8(ptr, familyTag(addr));
  writeSockAddrBody(memory, ptr + 4, addr);
}

function readSockAddrBody(
  memory: WebAssembly.Memory,
  ptr: number,
  tag: number,
  port: number,
): SockAddr {
  if (tag === AddressFamily.INET4) {
    const buf = new Uint8Array(memory.buffer, ptr, 4);
    return {
      family: "inet4",
      address: `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`,
      port,
    };
  }
  if (tag === AddressFamily.INET6) {
    const buf = new Uint8Array(memory.buffer, ptr, 16);
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(((buf[i] << 8) | buf[i + 1]).toString(16));
    }
    return { family: "inet6", address: parts.join(":"), port };
  }
  if (tag === AddressFamily.UNIX) {
    const buf = new Uint8Array(memory.buffer, ptr, 16);
    let len = 0;
    while (len < buf.byteLength && buf[len] !== 0) len++;
    return {
      family: "unix",
      path: new TextDecoder().decode(buf.subarray(0, len)),
    };
  }
  throw new WASIXError(Result.EAFNOSUPPORT);
}

function writeSockAddrBody(
  memory: WebAssembly.Memory,
  ptr: number,
  addr: SockAddr,
): void {
  if (addr.family === "inet4") {
    const buf = new Uint8Array(memory.buffer, ptr, 4);
    const parts = addr.address.split(".").map((s) => Number.parseInt(s, 10));
    for (let i = 0; i < 4; i++) buf[i] = parts[i] ?? 0;
    return;
  }
  if (addr.family === "inet6") {
    const buf = new Uint8Array(memory.buffer, ptr, 16);
    const groups = expandIPv6(addr.address);
    for (let i = 0; i < 8; i++) {
      buf[i * 2] = (groups[i] >> 8) & 0xff;
      buf[i * 2 + 1] = groups[i] & 0xff;
    }
    return;
  }
  // unix
  const buf = new Uint8Array(memory.buffer, ptr, 16);
  const bytes = new TextEncoder().encode(addr.path);
  buf.set(bytes.subarray(0, Math.min(bytes.byteLength, 16)));
}

function familyTag(addr: SockAddr): number {
  if (addr.family === "inet4") return AddressFamily.INET4;
  if (addr.family === "inet6") return AddressFamily.INET6;
  return AddressFamily.UNIX;
}

function sockAddrPort(addr: SockAddr): number {
  return addr.family === "unix" ? 0 : addr.port;
}

function expandIPv6(address: string): number[] {
  // Minimal IPv6 expander — enough for the synthesised "::1" / "fe80::1"
  // shapes the loopback fabric emits. Not a full RFC 4291 implementation.
  const halves = address.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fillCount = 8 - head.length - tail.length;
  const middle = new Array<string>(fillCount).fill("0");
  const all = [...head, ...middle, ...tail].slice(0, 8);
  return all.map((g) => Number.parseInt(g || "0", 16));
}

// ─── Provider hook helpers ───────────────────────────────────────────────────

function maybeSetMemory(
  provider: FutexProvider | undefined,
  memory: WebAssembly.Memory,
): void {
  if (
    provider &&
    typeof (provider as { setMemory?: unknown }).setMemory === "function"
  ) {
    (provider as { setMemory: (m: WebAssembly.Memory) => void }).setMemory(
      memory,
    );
  }
}

function maybeSetThreadStart(
  provider: ThreadsProvider | undefined,
  fn: (tid: number, startArg: number) => void,
): void {
  if (
    provider &&
    typeof (provider as { setThreadStart?: unknown }).setThreadStart ===
      "function"
  ) {
    (
      provider as {
        setThreadStart: (f: (tid: number, startArg: number) => void) => void;
      }
    ).setThreadStart(fn);
  }
}

// ─── Optional-timestamp marshalling ──────────────────────────────────────────
//
// `__wasi_optional_timestamp_t` (wasix-libc):
//   layout (size 16, alignment 8):
//     tag  offset 0 size 1   (0 = none, 1 = some)
//     pad  offset 1 size 7
//     u    offset 8 size 8   (i64 nanoseconds; only meaningful when tag = 1)
//
// `timeoutPtr === 0` is also accepted as "no timeout" — wasix-libc passes
// `nullptr` when the application omitted a timeout.

function readOptionalTimestamp(
  memory: WebAssembly.Memory,
  ptr: number,
): bigint | null {
  if (ptr === 0) return null;
  const view = new DataView(memory.buffer);
  const tag = view.getUint8(ptr);
  if (tag === 0) return null;
  return view.getBigInt64(ptr + 8, true);
}
