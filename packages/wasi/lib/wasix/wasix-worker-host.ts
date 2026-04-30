// WASIXWorkerHost
//
// Main-thread counterpart to `wasix-worker.ts`. Owns a dedicated Web
// Worker, the SharedArrayBuffer bridge to that worker, and the per-slot
// provider map the host supplied.
//
// Unlike `WASIX(...)` (which only accepts synchronous providers), this host
// accepts either `ClockProvider` OR `AsyncClockProvider` on every provider
// slot, and so on. Async-capable provider methods may return `Promise<T>`;
// the worker-side guest sees a sync return, because the round trip goes
// through the bridge.
//
// Performance note: every configured provider slot routes through the
// bridge, regardless of whether the host supplied a sync or async-capable
// provider. Each invocation incurs one `Atomics.wait`/`notify` round trip
// + one main-thread dispatcher tick. For slices 4–8's opcode set this is
// fine; for hot-path syscalls in later slices, hosts that supply purely
// sync providers should prefer `WASIX.start(...)` on the main thread —
// they avoid the bridge entirely and pay zero overhead.
//
// Responsibilities:
//   1. Compile the wasm module (main thread — workers can't fetch on their
//      own without network access in every browser).
//   2. Spawn the dedicated worker, hand it the module + shared buffer +
//      serialisable context config + the names of async slots.
//   3. Stream stdout / stderr / debug events from the worker.
//   4. Run the bridge dispatcher loop: await a request, invoke the
//      appropriate provider, await its return, write the response, notify.
//   5. Resolve the Promise returned from `.start()` with the final exit code.

import type { WASIFS, WASIXExecutionResult } from "../types.js";
import type {
  ClockProvider,
  FutexProvider,
  ProcProvider,
  RandomProvider,
  SignalsProvider,
  SocketsProvider,
  ThreadsProvider,
  TTYProvider,
  TTYState,
} from "./providers.js";
import type { ProviderPreopen } from "./providers/ergonomic/filesystem-provider.js";
import type {
  AsyncClockProvider,
  AsyncFutexProvider,
  AsyncProcProvider,
  AsyncRandomProvider,
  AsyncSignalsProvider,
  AsyncSocketsProvider,
  AsyncThreadsProvider,
  AsyncTTYProvider,
} from "./providers/async.js";
import { ClockId, Result, WASIXError } from "./wasix-32v1.js";
import { parseEnvImportDescriptors, type ParsedEnvImports } from "./wasix.js";
import {
  DEFAULT_BRIDGE_BUFFER_BYTES,
  Opcode,
  awaitBridgeRequest,
  createBridgeBuffer,
  writeBridgeGenericError,
  writeBridgeResponse,
  writeBridgeWasixError,
  type BridgeRequest,
  type TTYStateWire,
} from "./worker/bridge.js";
import type {
  AsyncBridgedSlot,
  SerialisableContext,
  WASIXWorkerHostMessage,
  WASIXWorkerStartMessage,
} from "./worker/wasix-worker.js";

import WASIXWorkerEntry from "./worker/wasix-worker?worker&inline";

/**
 * The main-thread counterpart to `WASIXContextOptions`. Accepts
 * async-capable providers on every slot, and also accepts an async stdin
 * callback (host may return a Promise from its stdin handler).
 *
 * stdout / stderr are intentionally **sync-only** (no `Promise<void>`).
 * They run on the main thread inside a `postMessage` event handler — the
 * worker's stdout/stderr emissions are fire-and-forget `postMessage`s, not
 * bridge round trips, so there is no back-pressure channel for an async
 * sink to feed back into the guest. If your sink is async (e.g. you want
 * to await a network write), call it and fire-and-forget the Promise from
 * inside the sync callback; expect to lose any unflushed output if the
 * page unloads. If you need back-pressure, buffer in your callback and
 * drain externally.
 */
export type WASIXWorkerHostOptions = {
  fs?: WASIFS;
  /** Preopens beyond the implicit fd 3 = ".". Crosses postMessage as plain
   *  data; the worker rebuilds the WASIDriveFileSystemProvider with this
   *  list. Mirror of WASIDriveFileSystemProviderOptions.preopens. */
  preopens?: ProviderPreopen[];
  args?: string[];
  env?: Record<string, string>;
  stdin?: (maxByteLength: number) => string | null | Promise<string | null>;
  /** Sync callback. See class-level JSDoc above for async-sink guidance. */
  stdout?: (out: string) => void;
  /** Sync callback. See class-level JSDoc above for async-sink guidance. */
  stderr?: (err: string) => void;
  debug?: (
    name: string,
    args: string[],
    ret: number,
    data: Array<{ [key: string]: unknown }>,
  ) => void;
  isTTY?: boolean;

  clock?: ClockProvider | AsyncClockProvider;
  random?: RandomProvider | AsyncRandomProvider;
  tty?: TTYProvider | AsyncTTYProvider;
  threads?: ThreadsProvider | AsyncThreadsProvider;
  futex?: FutexProvider | AsyncFutexProvider;
  signals?: SignalsProvider | AsyncSignalsProvider;
  sockets?: SocketsProvider | AsyncSocketsProvider;
  proc?: ProcProvider | AsyncProcProvider;
};

export class WASIXWorkerHostKilledError extends Error {
  constructor(message?: string) {
    super(message);
    // Name defaults to "Error" without this — `instanceof` works in-realm
    // but cross-realm (e.g. worker → main) or structured-clone callers
    // need a stable `name` to identify the class.
    this.name = "WASIXWorkerHostKilledError";
  }
}

/**
 * Single-use host. Construct one per guest invocation; `.start()` is a
 * one-shot — a second call (or a retry after `start()` rejected on
 * compile failure) throws. If you need to retry, instantiate a new
 * `WASIXWorkerHost`. This avoids an entire class of "did the previous
 * dispatcher / worker get cleaned up?" reasoning at the cost of one
 * cheap allocation per attempt.
 */
export class WASIXWorkerHost {
  private options: WASIXWorkerHostOptions;
  private moduleSource: Response | PromiseLike<Response> | WebAssembly.Module;

  private worker?: Worker;
  private sharedBuffer?: SharedArrayBuffer;
  private dispatcherAbort?: AbortController;
  private result?: Promise<WASIXExecutionResult>;
  private rejectResult?: (reason?: unknown) => void;
  private killed = false;

  /**
   * @param moduleSource  Either a fetch `Response` (or `Promise<Response>`)
   *                      pointing at a wasm binary, or a pre-compiled
   *                      `WebAssembly.Module`.
   * @param options       Context options. Any provider may be sync or
   *                      async-capable — the host awaits Promise returns
   *                      on the main thread before writing the bridge
   *                      response.
   */
  constructor(
    moduleSource: Response | PromiseLike<Response> | WebAssembly.Module,
    options: WASIXWorkerHostOptions = {},
  ) {
    this.moduleSource = moduleSource;
    this.options = options;
  }

  /**
   * Compile the module, spawn the worker, start the guest, start the
   * dispatcher loop. Resolves when the guest exits (or rejects on crash
   * or kill()).
   *
   * **Single-use:** calling `start()` twice throws, even after a previous
   * compile-time rejection. Construct a new `WASIXWorkerHost` to retry.
   */
  async start(): Promise<WASIXExecutionResult> {
    if (this.result) {
      throw new Error(
        "WASIXWorkerHost is single-use; construct a new instance to retry",
      );
    }
    this.result = this.runOnce();
    return this.result;
  }

  private async runOnce(): Promise<WASIXExecutionResult> {
    // Validate provider slots before doing any expensive work — a host that
    // configured an unsupported async slot gets ENOSYS at construction
    // time, not after a worker has been spawned and parked.
    assertAsyncSlotsSupported(this.options);

    const compiled = await this.compileModule();
    if (this.killed) {
      throw new WASIXWorkerHostKilledError("WASIX worker was killed");
    }
    const { module, envDescriptors } = compiled;
    this.sharedBuffer = createBridgeBuffer(DEFAULT_BRIDGE_BUFFER_BYTES);
    const sharedBuffer = this.sharedBuffer;

    const { worker, completion } = this.spawnWorker();
    this.worker = worker;

    if (this.killed) {
      worker.terminate();
      throw new WASIXWorkerHostKilledError("WASIX worker was killed");
    }

    // Launch the dispatcher loop — awaits requests, dispatches them to the
    // host's providers, posts responses. It runs until kill() / abort or
    // the worker completes.
    this.dispatcherAbort = new AbortController();
    const dispatcher = this.runDispatcher(
      sharedBuffer,
      this.dispatcherAbort.signal,
    );

    // Pre-resolve clock resolutions on the host so the worker's
    // bridge-backed `ClockProvider.resolution(id)` returns the host's
    // configured value without a per-call bridge round trip. Async-capable
    // providers may return a Promise<bigint>; we await each. Errors are
    // tolerated (a clock id the provider doesn't support throws — we omit
    // it from the cache and the worker shim falls back to 1µs).
    const clockResolutions = await resolveClockResolutions(this.options.clock);
    if (this.killed) {
      this.dispatcherAbort.abort();
      worker.terminate();
      throw new WASIXWorkerHostKilledError("WASIX worker was killed");
    }

    // Send the start message. Transfer the module when available to avoid
    // a re-compile in the worker.
    const startMessage: WASIXWorkerStartMessage = {
      target: "worker",
      type: "start",
      module,
      envDescriptors,
      sharedBuffer,
      contextConfig: serialisableContext(this.options),
      asyncSlots: detectAsyncSlots(this.options),
      hasStdin: !!this.options.stdin,
      clockResolutions,
    };
    worker.postMessage(startMessage);

    try {
      return await completion;
    } finally {
      this.dispatcherAbort?.abort();
      // Surface dispatcher errors if any. We `await` but don't throw — a
      // dispatcher failure after the guest exits is not actionable.
      await dispatcher.catch(() => {});
      worker.terminate();
    }
  }

  /**
   * Kill the worker. Idempotent — safe to call before `start()`, during
   * compilation, mid-bridge-call, or after the guest has already exited.
   * The outstanding Promise returned from `.start()` (if any) is rejected
   * with `WASIXWorkerHostKilledError`.
   */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.dispatcherAbort?.abort();
    this.worker?.terminate();
    this.rejectResult?.(
      new WASIXWorkerHostKilledError("WASIX worker was killed"),
    );
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * Compile the wasm module on the main thread (workers can't fetch on
   * their own in every browser). When the source is a `Response`, we read
   * the bytes once so we can also parse the `env.*` import descriptors
   * here — the worker needs the descriptors to construct matching
   * `WebAssembly.Memory` / `Table` instances at instantiation time. When
   * the source is a pre-compiled `WebAssembly.Module` we have no bytes,
   * so descriptors are absent and the worker falls back to passing no
   * `env` imports — fine for preview1 binaries that export their own
   * memory, but wasix-libc binaries handed in module form would fail to
   * instantiate. Callers wanting wasix-libc support should pass a
   * `Response` (or `Promise<Response>`) instead.
   */
  private async compileModule(): Promise<{
    module: WebAssembly.Module;
    envDescriptors?: ParsedEnvImports;
  }> {
    if (this.moduleSource instanceof WebAssembly.Module) {
      return { module: this.moduleSource };
    }
    const response = await Promise.resolve(this.moduleSource);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const envDescriptors = parseEnvImportDescriptors(bytes);
    const module = await WebAssembly.compile(bytes);
    return { module, envDescriptors };
  }

  private spawnWorker(): {
    worker: Worker;
    completion: Promise<WASIXExecutionResult>;
  } {
    const worker = new WASIXWorkerEntry();

    const completion = new Promise<WASIXExecutionResult>((resolve, reject) => {
      this.rejectResult = reject;

      worker.addEventListener("message", (event: MessageEvent) => {
        const message = event.data as WASIXWorkerHostMessage;
        switch (message.type) {
          case "stdout":
            this.options.stdout?.(message.text);
            break;
          case "stderr":
            this.options.stderr?.(message.text);
            break;
          case "debug":
            this.options.debug?.(
              message.name,
              message.args,
              message.ret,
              message.data,
            );
            break;
          case "result":
            resolve(message.result);
            break;
          case "crash":
            reject(
              Object.assign(new Error(message.error.message), {
                name: message.error.type,
              }),
            );
            break;
        }
      });

      worker.addEventListener("error", (event: ErrorEvent) => {
        reject(event.error ?? new Error(event.message));
      });
    });

    return { worker, completion };
  }

  /**
   * The dispatcher loop. Awaits a request from the worker, calls the
   * corresponding provider method, awaits any Promise return, writes back
   * either an OK response or a structured error.
   */
  private async runDispatcher(
    sharedBuffer: SharedArrayBuffer,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const awaited = await awaitBridgeRequest(sharedBuffer, signal);
      if (awaited.kind === "aborted") return;
      if (awaited.kind === "decode-error") {
        // Worker sent malformed bytes or an unknown opcode. Surface a
        // generic error so the guest unblocks; the bridge stays usable for
        // the next request.
        writeBridgeGenericError(
          sharedBuffer,
          `bridge: decode failure (opcode=${awaited.opcode}): ${awaited.message}`,
        );
        continue;
      }

      try {
        await this.handleRequest(sharedBuffer, awaited.request, signal);
      } catch (e) {
        if (signal.aborted) {
          // Provider call lost the race against `kill()`. Worker is about
          // to be terminated — writing a response is unnecessary and risks
          // racing against the terminate.
          return;
        }
        // Order matters: WASIXError extends Error, so the WASIXError arm
        // must come first or every WASIXError would fall into the generic
        // arm and lose its `Result` payload.
        if (e instanceof WASIXError) {
          writeBridgeWasixError(sharedBuffer, e.result);
        } else if (e instanceof Error) {
          writeBridgeGenericError(sharedBuffer, e.message);
        } else {
          writeBridgeGenericError(sharedBuffer, `dispatcher: ${String(e)}`);
        }
      }
    }
  }

  private async handleRequest(
    sharedBuffer: SharedArrayBuffer,
    request: BridgeRequest,
    signal: AbortSignal,
  ): Promise<void> {
    switch (request.opcode) {
      case Opcode.DEBUG: {
        // Smoke-test opcode: echo the message length back.
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.DEBUG,
          result: { length: request.args.message.length },
        });
        return;
      }
      case Opcode.STDIN_READ: {
        if (!this.options.stdin) {
          // No stdin configured — return EOF.
          writeBridgeResponse(sharedBuffer, {
            opcode: Opcode.STDIN_READ,
            result: { text: null },
          });
          return;
        }
        const text = await raceSignal(
          this.options.stdin(request.args.maxByteLength),
          signal,
        );
        // Defensive clamp: a host whose stdin callback ignores
        // maxByteLength and returns a 100 KiB string would otherwise blow
        // encodeResponse's region check. The dispatcher's catch arm would
        // ship a GENERIC_ERROR back, but the worker-side inner-WASI
        // fd_read doesn't catch stdin throws, so the worker crashes.
        // Clamping here keeps WASI semantics (a short-read is allowed —
        // the guest will call fd_read again) and matches the worker
        // shim's maxByteLength promise.
        const clamped = clampStdinText(text, request.args.maxByteLength);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.STDIN_READ,
          result: { text: clamped },
        });
        return;
      }
      case Opcode.CLOCK_NOW: {
        if (!this.options.clock) {
          // Slot declared async but no provider — should not happen because
          // detectAsyncSlots keys off the slot being present. Defensive:
          // treat as ENOSYS.
          throw new WASIXError(Result.ENOSYS);
        }
        const value = await raceSignal(
          this.options.clock.now(request.args.clockId as ClockId),
          signal,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.CLOCK_NOW,
          result: { timeNs: value },
        });
        return;
      }
      case Opcode.RANDOM_FILL: {
        if (!this.options.random) {
          throw new WASIXError(Result.ENOSYS);
        }
        const tmp = new Uint8Array(request.args.byteLength);
        await raceSignal(this.options.random.fill(tmp), signal);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.RANDOM_FILL,
          result: { bytes: tmp },
        });
        return;
      }
      case Opcode.TTY_GET: {
        if (!this.options.tty) {
          throw new WASIXError(Result.ENOSYS);
        }
        const state = await raceSignal(this.options.tty.get(), signal);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.TTY_GET,
          result: { state: ttyStateToWire(state) },
        });
        return;
      }
      case Opcode.TTY_SET: {
        if (!this.options.tty) {
          throw new WASIXError(Result.ENOSYS);
        }
        const result = await raceSignal(
          this.options.tty.set(wireToTTYState(request.args.state)),
          signal,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.TTY_SET,
          result: { result },
        });
        return;
      }
      case Opcode.SOCK_OPEN: {
        const sockets = this.requireSockets();
        const fd = await sockets.open(
          request.args.af,
          request.args.type,
          request.args.proto,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_OPEN,
          result: { fd },
        });
        return;
      }
      case Opcode.SOCK_BIND: {
        const sockets = this.requireSockets();
        const result = await sockets.bind(request.args.fd, request.args.addr);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_BIND,
          result: { result },
        });
        return;
      }
      case Opcode.SOCK_CONNECT: {
        const sockets = this.requireSockets();
        const result = await sockets.connect(
          request.args.fd,
          request.args.addr,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_CONNECT,
          result: { result },
        });
        return;
      }
      case Opcode.SOCK_LISTEN: {
        const sockets = this.requireSockets();
        const result = await sockets.listen(
          request.args.fd,
          request.args.backlog,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_LISTEN,
          result: { result },
        });
        return;
      }
      case Opcode.SOCK_ACCEPT: {
        const sockets = this.requireSockets();
        const accepted = await sockets.accept(request.args.fd);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_ACCEPT,
          result: { fd: accepted.fd, addr: accepted.addr },
        });
        return;
      }
      case Opcode.SOCK_SEND: {
        const sockets = this.requireSockets();
        const written = await sockets.send(
          request.args.fd,
          [request.args.data],
          request.args.flags,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_SEND,
          result: { written },
        });
        return;
      }
      case Opcode.SOCK_RECV: {
        const sockets = this.requireSockets();
        const buf = new Uint8Array(request.args.maxLen);
        const result = await sockets.recv(
          request.args.fd,
          [buf],
          request.args.flags,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_RECV,
          result: {
            data: buf.subarray(0, result.bytesRead),
            flags: result.flags,
          },
        });
        return;
      }
      case Opcode.SOCK_SHUTDOWN: {
        const sockets = this.requireSockets();
        const result = await sockets.shutdown(
          request.args.fd,
          request.args.how,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_SHUTDOWN,
          result: { result },
        });
        return;
      }
      case Opcode.SOCK_ADDR_RESOLVE: {
        const sockets = this.requireSockets();
        const all = await sockets.addrResolve(
          request.args.host,
          request.args.port,
          {},
        );
        const addrs = all.slice(0, request.args.maxAddrs);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_ADDR_RESOLVE,
          result: { addrs },
        });
        return;
      }
      case Opcode.SOCK_ADDR_LOCAL: {
        const sockets = this.requireSockets();
        const addr = await sockets.addrLocal(request.args.fd);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_ADDR_LOCAL,
          result: { addr },
        });
        return;
      }
      case Opcode.SOCK_ADDR_PEER: {
        const sockets = this.requireSockets();
        const addr = await sockets.addrPeer(request.args.fd);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_ADDR_PEER,
          result: { addr },
        });
        return;
      }
      case Opcode.SOCK_STATUS: {
        const sockets = this.requireSockets();
        const status = await sockets.status(request.args.fd);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_STATUS,
          result: { status },
        });
        return;
      }
      case Opcode.SOCK_GET_OPT: {
        const sockets = this.requireSockets();
        const { fd, level, name, kind } = request.args;
        if (kind === "flag") {
          const value = await sockets.getOptFlag(fd, level, name);
          writeBridgeResponse(sharedBuffer, {
            opcode: Opcode.SOCK_GET_OPT,
            result: { kind: "flag", value },
          });
          return;
        }
        if (kind === "size") {
          const value = await sockets.getOptSize(fd, level, name);
          writeBridgeResponse(sharedBuffer, {
            opcode: Opcode.SOCK_GET_OPT,
            result: { kind: "size", value },
          });
          return;
        }
        const value = await sockets.getOptTime(fd, level, name);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_GET_OPT,
          result: { kind: "time", value },
        });
        return;
      }
      case Opcode.SOCK_SET_OPT: {
        const sockets = this.requireSockets();
        const { fd, level, name, kind } = request.args;
        if (kind === "flag") {
          const result = await sockets.setOptFlag(
            fd,
            level,
            name,
            request.args.value,
          );
          writeBridgeResponse(sharedBuffer, {
            opcode: Opcode.SOCK_SET_OPT,
            result: { result },
          });
          return;
        }
        if (kind === "size") {
          const result = await sockets.setOptSize(
            fd,
            level,
            name,
            request.args.value,
          );
          writeBridgeResponse(sharedBuffer, {
            opcode: Opcode.SOCK_SET_OPT,
            result: { result },
          });
          return;
        }
        const result = await sockets.setOptTime(
          fd,
          level,
          name,
          request.args.value,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.SOCK_SET_OPT,
          result: { result },
        });
        return;
      }
    }
  }

  private requireSockets(): SocketsProvider | AsyncSocketsProvider {
    if (!this.options.sockets) {
      throw new WASIXError(Result.ENOSYS);
    }
    return this.options.sockets;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function serialisableContext(
  options: WASIXWorkerHostOptions,
): SerialisableContext {
  return {
    args: options.args,
    env: options.env,
    isTTY: options.isTTY,
    // `fs` across postMessage must be a WASIFS — FileSystemProvider class
    // instances can't cross the thread boundary. Future slices may add a
    // bridge opcode set for FileSystemProvider; for now, worker-mode hosts
    // pass a plain WASIFS plus a preopens descriptor that the worker
    // re-applies when reconstructing the provider.
    fs: options.fs,
    preopens: options.preopens,
  };
}

/**
 * Pre-resolve `clock.resolution(id)` for every supported `ClockId`. Async
 * providers may return a Promise; we await each. Errors throw out per-id —
 * an id the provider can't service is omitted from the cache and the
 * worker shim's 1µs fallback applies.
 */
async function resolveClockResolutions(
  clock?: ClockProvider | AsyncClockProvider,
): Promise<Partial<Record<ClockId, bigint>>> {
  if (!clock) return {};
  const ids: ClockId[] = [
    ClockId.REALTIME,
    ClockId.MONOTONIC,
    ClockId.PROCESS_CPUTIME,
    ClockId.THREAD_CPUTIME,
  ];
  const out: Partial<Record<ClockId, bigint>> = {};
  for (const id of ids) {
    try {
      const value = await clock.resolution(id);
      out[id] = value;
    } catch {
      // Provider doesn't support this clock id at construction-time —
      // leave it out of the cache. The bridge shim's 1µs fallback applies.
    }
  }
  return out;
}

/**
 * Scan the provider slots and return the list the worker needs to know
 * about. A slot is considered async-capable whenever the host set it — the
 * type system gives the host the option to pass either sync or async-capable
 * providers, and at runtime we always assume the worker should bridge it
 * through the main thread so the host's provider is awaited regardless of
 * sync-vs-async. Hosts wanting zero bridge overhead for a known-sync
 * provider can use `WASIX.start(...)` on the main thread instead.
 */
function detectAsyncSlots(options: WASIXWorkerHostOptions): AsyncBridgedSlot[] {
  const slots: AsyncBridgedSlot[] = [];
  if (options.clock) slots.push("clock");
  if (options.random) slots.push("random");
  if (options.tty) slots.push("tty");
  if (options.threads) slots.push("threads");
  if (options.futex) slots.push("futex");
  if (options.signals) slots.push("signals");
  if (options.sockets) slots.push("sockets");
  if (options.proc) slots.push("proc");
  return slots;
}

/**
 * The set of provider slots that have bridge opcodes wired this slice. A
 * host can configure any slot the type system allows, but if a slot has no
 * opcode plumbed, dispatching a guest call against it would hit the
 * default-arm of the dispatcher switch and wedge the worker. Reject the
 * configuration at startup with a named ENOSYS instead.
 *
 * Each later slice that lands its opcode set adds its slot to this list.
 * Slice 4: clock, random, tty.
 * Slice 5+ (planned): threads, futex, signals, sockets, proc.
 */
const SLICE_4_SUPPORTED_SLOTS: ReadonlySet<AsyncBridgedSlot> = new Set([
  "clock",
  "random",
  "tty",
]);

function assertAsyncSlotsSupported(options: WASIXWorkerHostOptions): void {
  const slots = detectAsyncSlots(options);
  for (const slot of slots) {
    if (!SLICE_4_SUPPORTED_SLOTS.has(slot)) {
      throw new WASIXError(
        Result.ENOSYS,
        `WASIXWorkerHost: provider slot "${slot}" has no bridge opcode this slice`,
      );
    }
  }
}

/**
 * Race a (possibly-Promise) value against the dispatcher abort signal.
 *
 * If the signal fires before the value settles, the returned promise
 * rejects so the dispatcher's loop unwinds — without this, a hung
 * provider would hold `runOnce()` open past `kill()` until it eventually
 * settled. The original promise is left to settle on its own (we cannot
 * cancel an arbitrary host callback).
 */
/**
 * Clamp a host stdin response to the worker's requested maxByteLength.
 *
 * The contract: stdin's `maxByteLength` is an upper bound, not a target —
 * hosts are encouraged to return less. WASI short-reads are a normal
 * fd_read outcome (the guest re-issues). The clamp protects the bridge
 * from a host that ignores the limit and returns megabytes — without it,
 * encodeResponse trips its region-overflow check and the dispatcher
 * compensates with a GENERIC_ERROR that the worker-side inner-WASI
 * fd_read doesn't catch (it propagates as a worker crash).
 *
 * Clamps in UTF-8 code-unit space (JS string `length`), not byte space —
 * the inner-WASI fd_read re-encodes to UTF-8 and chops to iov.byteLength
 * itself, so being conservative with code units is sufficient and avoids
 * splitting a multi-byte sequence here.
 */
function clampStdinText(
  text: string | null,
  maxByteLength: number,
): string | null {
  if (text === null) return null;
  if (text.length <= maxByteLength) return text;
  return text.slice(0, maxByteLength);
}

function raceSignal<T>(value: T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("dispatcher: aborted"));
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new Error("dispatcher: aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Wire ↔ TTYState conversion. The two types are structurally identical;
 *  this exists so a future TTYState additions doesn't silently misalign
 *  the bridge encoding. */
function ttyStateToWire(state: TTYState): TTYStateWire {
  return {
    cols: state.cols,
    rows: state.rows,
    pixelWidth: state.pixelWidth,
    pixelHeight: state.pixelHeight,
    echo: state.echo,
    lineBuffered: state.lineBuffered,
    raw: state.raw,
  };
}

function wireToTTYState(wire: TTYStateWire): TTYState {
  return {
    cols: wire.cols,
    rows: wire.rows,
    pixelWidth: wire.pixelWidth,
    pixelHeight: wire.pixelHeight,
    echo: wire.echo,
    lineBuffered: wire.lineBuffered,
    raw: wire.raw,
  };
}
