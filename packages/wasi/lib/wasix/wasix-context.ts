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

/**
 * Sync<T> — structural assertion that every method of `T` returns a
 * non-Promise value. Applying this to a provider slot causes TypeScript to
 * reject any `AsyncCapable<T>` variant at the call site of `new WASIX(…)`.
 *
 * Implementation: walk each method, and if its declared return type contains
 * `Promise<unknown>` as a union member, collapse the slot to `never` so
 * assignment fails. We use `Extract<R, Promise<unknown>>` rather than
 * `[R] extends [Promise<unknown>]` so methods declared `void | Promise<void>`
 * (e.g. `AsyncCapable<RandomProvider>.fill`) are caught — `void`'s
 * subtyping rule means a bare-extends check passes through them silently.
 */
export type Sync<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? [Extract<R, Promise<unknown>>] extends [never]
      ? (...args: A) => R
      : never
    : T[K];
};

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

  // Providers — all sync. Each slot is wrapped in `Sync<T>` so that passing
  // an `AsyncCapable<T>` fails typecheck at the `new WASIX(…)` call site.
  // Async variants are accepted exclusively by `WASIXWorkerHost(...)`.
  clock?: Sync<ClockProvider>;
  random?: Sync<RandomProvider>;
  tty?: Sync<TTYProvider>;
  threads?: Sync<ThreadsProvider>;
  futex?: Sync<FutexProvider>;
  signals?: Sync<SignalsProvider>;
  sockets?: Sync<SocketsProvider>;
  proc?: Sync<ProcProvider>;

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
