import { ClockId, Result, WASIXError } from "./wasix-32v1.js";
import { WASIXContext, WASIXContextOptions } from "./wasix-context.js";
import {
  WASI,
  InvalidInstanceError,
  InitializationError,
} from "../wasi/wasi.js";
import { WASIXExecutionResult } from "../types.js";
import { SystemClockProvider } from "./providers/system-clock.js";
import { SystemRandomProvider } from "./providers/system-random.js";
import type { ClockProvider, RandomProvider } from "./providers.js";

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
 * service wasi_snapshot_preview1 and wasi_unstable imports; all wasix_32v1
 * imports are stubbed to ENOSYS this slice. Memory is owned by WASIX and
 * shared with the internal WASI instance.
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
    // Internal WASI shares the same fs / args / env / stdio as WASIX.
    // It services wasi_snapshot_preview1 and wasi_unstable imports.
    this.wasi = new WASI(context);
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
      wasix_32v1: this.getWasix32v1Stubs(),
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
          fs: this.wasi.drive.fs,
        };
      } else if (e instanceof WebAssembly.RuntimeError) {
        return {
          exitCode: 134,
          fs: this.wasi.drive.fs,
        };
      } else {
        throw e;
      }
    }

    return {
      exitCode: 0,
      fs: this.wasi.drive.fs,
    };
  }

  //
  // Provider accessors — lazy-init system defaults when context slot is unset.
  //

  private get clock(): ClockProvider {
    return this.context.clock ?? (this._clock ??= new SystemClockProvider());
  }

  private get random(): RandomProvider {
    return this.context.random ?? (this._random ??= new SystemRandomProvider());
  }

  //
  // wasix_32v1 syscall handlers — clock + random wired; all others ENOSYS.
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

  private getWasix32v1Stubs(): WebAssembly.ModuleImports {
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
      fd_close: enosys,
      fd_datasync: enosys,
      fd_dup: enosys,
      fd_event: enosys,
      fd_fdstat_get: enosys,
      fd_fdstat_set_flags: enosys,
      fd_fdstat_set_rights: enosys,
      fd_filestat_get: enosys,
      fd_filestat_set_size: enosys,
      fd_filestat_set_times: enosys,
      fd_pread: enosys,
      fd_prestat_dir_name: enosys,
      fd_prestat_get: enosys,
      fd_pwrite: enosys,
      fd_read: enosys,
      fd_readdir: enosys,
      fd_renumber: enosys,
      fd_seek: enosys,
      fd_sync: enosys,
      fd_tell: enosys,
      fd_write: enosys,
      fd_pipe: enosys,

      // Paths
      path_create_directory: enosys,
      path_filestat_get: enosys,
      path_filestat_set_times: enosys,
      path_link: enosys,
      path_open: enosys,
      path_readlink: enosys,
      path_remove_directory: enosys,
      path_rename: enosys,
      path_symlink: enosys,
      path_unlink_file: enosys,

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
