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
} from "./providers.js";
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
import {
  DEFAULT_BRIDGE_BUFFER_BYTES,
  Opcode,
  awaitBridgeRequest,
  createBridgeBuffer,
  writeBridgeGenericError,
  writeBridgeResponse,
  writeBridgeWasixError,
  type BridgeRequest,
} from "./worker/bridge.js";
import type {
  AsyncBridgedSlot,
  SerialisableContext,
  WASIXWorkerHostMessage,
  WASIXWorkerStartMessage,
} from "./worker/wasix-worker.js";

import WASIXWorkerEntry from "./worker/wasix-worker?worker&inline";

/** The main-thread counterpart to `WASIXContextOptions`. Accepts
 *  async-capable providers on every slot, and also accepts an async stdin
 *  callback (host may return a Promise from its stdin handler). */
export type WASIXWorkerHostOptions = {
  fs?: WASIFS;
  args?: string[];
  env?: Record<string, string>;
  stdin?: (maxByteLength: number) => string | null | Promise<string | null>;
  stdout?: (out: string) => void;
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

export class WASIXWorkerHostKilledError extends Error {}

export class WASIXWorkerHost {
  private options: WASIXWorkerHostOptions;
  private moduleSource: Response | PromiseLike<Response> | WebAssembly.Module;

  private worker?: Worker;
  private sharedBuffer?: SharedArrayBuffer;
  private dispatcherAbort?: AbortController;
  private result?: Promise<WASIXExecutionResult>;
  private rejectResult?: (reason?: unknown) => void;

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
   */
  async start(): Promise<WASIXExecutionResult> {
    if (this.result) {
      throw new Error("WASIXWorkerHost can only be started once");
    }
    this.result = this.runOnce();
    return this.result;
  }

  private async runOnce(): Promise<WASIXExecutionResult> {
    const module = await this.compileModule();
    this.sharedBuffer = createBridgeBuffer(DEFAULT_BRIDGE_BUFFER_BYTES);
    const sharedBuffer = this.sharedBuffer;

    const { worker, completion } = this.spawnWorker();
    this.worker = worker;

    // Launch the dispatcher loop — awaits requests, dispatches them to the
    // host's providers, posts responses. It runs until `stop()` triggers
    // the abort or the worker completes.
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

    // Send the start message. Transfer the module when available to avoid
    // a re-compile in the worker.
    const startMessage: WASIXWorkerStartMessage = {
      target: "worker",
      type: "start",
      module,
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
   * Kill the worker. The outstanding Promise returned from `.start()` is
   * rejected with `WASIXWorkerHostKilledError`.
   */
  kill(): void {
    if (!this.worker) {
      throw new Error("WASIXWorkerHost has not started");
    }
    this.dispatcherAbort?.abort();
    this.worker.terminate();
    this.rejectResult?.(
      new WASIXWorkerHostKilledError("WASIX worker was killed"),
    );
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async compileModule(): Promise<WebAssembly.Module> {
    if (this.moduleSource instanceof WebAssembly.Module) {
      return this.moduleSource;
    }
    const response = await Promise.resolve(this.moduleSource);
    return WebAssembly.compileStreaming(response);
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
      const request = await awaitBridgeRequest(sharedBuffer, signal);
      if (request === null) return;

      try {
        await this.handleRequest(sharedBuffer, request);
      } catch (e) {
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
        const text = await this.options.stdin(request.args.maxByteLength);
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.STDIN_READ,
          result: { text },
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
        const value = await this.options.clock.now(
          request.args.clockId as ClockId,
        );
        writeBridgeResponse(sharedBuffer, {
          opcode: Opcode.CLOCK_NOW,
          result: { timeNs: value },
        });
        return;
      }
    }
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
    // pass a plain WASIFS.
    fs: options.fs,
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
