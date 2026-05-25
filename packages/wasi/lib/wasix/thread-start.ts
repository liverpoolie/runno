// Optional helper for hosts wiring a "real worker" `ThreadsProvider`.
//
// The cooperative scheduler in `providers/cooperative-threads.ts` does
// NOT use this helper — cooperative threads share the original wasm
// instance and call `instance.exports.wasi_thread_start(tid, startArg)`
// directly. This module exists for hosts that want the multi-realm
// model: each thread runs in its own Worker, with its own
// `WebAssembly.Instance` against a shared `WebAssembly.Memory({ shared:
// true })`. The helper handles the per-instance plumbing — instantiate
// the module, find `wasi_thread_start`, invoke it, capture the exit.
//
// Runno itself does not ship a real-worker `ThreadsProvider`; that is
// explicitly out of scope for the WASIX slices. Hosts that want true
// parallelism own that piece and use this helper inside their worker
// entry.

/**
 * Outcome of running a single guest thread to completion.
 */
export type ThreadStartResult = {
  /** 0 on normal return, the explicit code passed to `thread_exit`,
   *  134 on a wasm runtime trap. */
  exitCode: number;
};

/**
 * Run a single guest thread.
 *
 * Instantiates `module` against the supplied import object (which MUST
 * include the shared `env.memory` the parent realm provided), looks up
 * the `wasi_thread_start(tid, startArg)` export, and invokes it.
 *
 * The helper does not do any cross-realm bookkeeping — joiners,
 * pending-signal queues, futex-wake routing are the host-side
 * `ThreadsProvider`'s responsibility. This function is a single
 * `instantiate → call → catch → return` glue path.
 *
 * Errors:
 *   - missing `wasi_thread_start` export — throws `Error`.
 *   - guest trap (`WebAssembly.RuntimeError`) — caught, exitCode = 134.
 *   - guest `proc_exit` / `thread_exit` — host translates via the
 *     `imports.wasix_32v1.proc_exit` / `thread_exit` callbacks; if the
 *     callback throws an Error with a numeric `exitCode`, the helper
 *     uses it. Otherwise unrecognised throws propagate.
 */
export async function startThread(opts: {
  /** Compiled module to instantiate per-thread. */
  module: WebAssembly.Module;
  /** Memory shared with the parent realm; must match the import shape. */
  sharedMemory: WebAssembly.Memory;
  /** Thread ID assigned by the host's `ThreadsProvider`. */
  tid: number;
  /** Opaque pointer the guest passed to `thread_spawn`. */
  startArg: number;
  /** Import object — host wires `wasix_32v1`, `wasi_snapshot_preview1`,
   *  etc. The helper merges `env.memory` into `imports.env`. */
  imports: WebAssembly.Imports;
}): Promise<ThreadStartResult> {
  const env = (opts.imports.env ?? {}) as Record<string, unknown>;
  const importObject: WebAssembly.Imports = {
    ...opts.imports,
    env: { ...env, memory: opts.sharedMemory },
  };

  const instance = await WebAssembly.instantiate(opts.module, importObject);
  const start = instance.exports.wasi_thread_start as
    | ((tid: number, startArg: number) => void)
    | undefined;
  if (typeof start !== "function") {
    throw new Error(
      "thread-start: instantiated module has no `wasi_thread_start` export",
    );
  }

  try {
    start(opts.tid, opts.startArg);
    return { exitCode: 0 };
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      return { exitCode: 134 };
    }
    if (
      typeof e === "object" &&
      e !== null &&
      typeof (e as { exitCode?: unknown }).exitCode === "number"
    ) {
      return { exitCode: (e as { exitCode: number }).exitCode };
    }
    throw e;
  }
}
