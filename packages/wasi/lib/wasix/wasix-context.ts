import { DebugFn } from "../wasi/wasi.js";
import {
  ClockProvider,
  FileSystemProvider,
  FutexProvider,
  ProcProvider,
  RandomProvider,
  SignalsProvider,
  SocketsProvider,
  ThreadsProvider,
  TTYProvider,
} from "./providers.js";
import { WASIDriveFileSystemProvider } from "./providers/ergonomic/filesystem-provider.js";

export type WASIXContextOptions = {
  // File / process basics — same semantics as WASIContext
  fs: FileSystemProvider;
  args: string[];
  env: Record<string, string>;
  stdin: (maxByteLength: number) => string | null;
  stdout: (out: string) => void;
  stderr: (err: string) => void;
  isTTY: boolean;
  debug?: DebugFn;

  // Providers — all sync. Async variants are configured via
  // WASIXWorkerHostOptions; see providers/async.ts.
  clock?: ClockProvider;
  random?: RandomProvider;
  tty?: TTYProvider;
  threads?: ThreadsProvider;
  futex?: FutexProvider;
  signals?: SignalsProvider;
  sockets?: SocketsProvider;
  proc?: ProcProvider;

  // Optional overrides for the import surface that WASIX otherwise
  // auto-detects from the module's import section. Hosts pass these
  // when reusing a `WebAssembly.Memory` / `WebAssembly.Table` across
  // sibling instances (the threaded configuration). When unset the
  // runtime constructs new ones to match the import descriptor.
  memory?: WebAssembly.Memory;
  indirectFunctionTable?: WebAssembly.Table;
};

/**
 * WASIXContext
 *
 * The context in which a WASIX binary is executed.
 * Mirrors WASIContext but adds optional provider slots for the
 * WASIX-specific syscall surface (clock, random, TTY, threads, futex,
 * signals, sockets, proc). All provider methods are synchronous.
 *
 * Provider slots that are not supplied return ENOSYS from the
 * corresponding wasix_32v1 syscall handler.
 */
export class WASIXContext {
  fs: FileSystemProvider;
  args: string[];
  env: Record<string, string>;
  stdin: WASIXContextOptions["stdin"];
  stdout: WASIXContextOptions["stdout"];
  stderr: WASIXContextOptions["stderr"];
  debug?: WASIXContextOptions["debug"];
  isTTY: WASIXContextOptions["isTTY"];

  clock?: ClockProvider;
  random?: RandomProvider;
  tty?: TTYProvider;
  threads?: ThreadsProvider;
  futex?: FutexProvider;
  signals?: SignalsProvider;
  sockets?: SocketsProvider;
  proc?: ProcProvider;

  memory?: WebAssembly.Memory;
  indirectFunctionTable?: WebAssembly.Table;

  constructor(options?: Partial<WASIXContextOptions>) {
    this.fs = options?.fs ?? new WASIDriveFileSystemProvider({});
    this.args = options?.args ?? [];
    this.env = options?.env ?? {};

    this.stdin = options?.stdin ?? (() => null);
    this.stdout = options?.stdout ?? (() => {});
    this.stderr = options?.stderr ?? (() => {});
    this.debug = options?.debug;
    this.isTTY = !!options?.isTTY;

    this.clock = options?.clock;
    this.random = options?.random;
    this.tty = options?.tty;
    this.threads = options?.threads;
    this.futex = options?.futex;
    this.signals = options?.signals;
    this.sockets = options?.sockets;
    this.proc = options?.proc;

    this.memory = options?.memory;
    this.indirectFunctionTable = options?.indirectFunctionTable;
  }
}
