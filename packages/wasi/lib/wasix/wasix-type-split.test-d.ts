// Type-level tests for the sync / async-capable split on the two public
// entry points:
//
//   - `new WASIX(...)` + `WASIXContextOptions` accept sync providers only.
//     Passing an `AsyncCapable<T>` variant on any slot MUST be a type error.
//   - `new WASIXWorkerHost(...)` + `WASIXWorkerHostOptions` accept either
//     sync or async-capable providers on every slot.
//
// These tests run under the normal `tsc --noEmit` pass; any accidental
// widening on either side breaks the build.
//
// File suffix `.test-d.ts` matches the TSD convention; tsc picks it up
// because the package `tsconfig.json` includes `lib/**`.

import type { WASIXContextOptions } from "./wasix-context.js";
import type { WASIXWorkerHostOptions } from "./wasix-worker-host.js";
import type {
  ClockProvider,
  RandomProvider,
  TTYProvider,
  ThreadsProvider,
  FutexProvider,
  SignalsProvider,
  SocketsProvider,
  ProcProvider,
} from "./providers.js";
import type {
  AsyncClockProvider,
  AsyncRandomProvider,
  AsyncTTYProvider,
  AsyncThreadsProvider,
  AsyncFutexProvider,
  AsyncSignalsProvider,
  AsyncSocketsProvider,
  AsyncProcProvider,
} from "./providers/async.js";

// ─── Positive cases — sync providers on both entry points ──────────────────

declare const syncClock: ClockProvider;
declare const syncRandom: RandomProvider;
declare const syncTTY: TTYProvider;
declare const syncThreads: ThreadsProvider;
declare const syncFutex: FutexProvider;
declare const syncSignals: SignalsProvider;
declare const syncSockets: SocketsProvider;
declare const syncProc: ProcProvider;

const mainSync: Partial<WASIXContextOptions> = {
  clock: syncClock,
  random: syncRandom,
  tty: syncTTY,
  threads: syncThreads,
  futex: syncFutex,
  signals: syncSignals,
  sockets: syncSockets,
  proc: syncProc,
};

const workerSync: WASIXWorkerHostOptions = {
  clock: syncClock,
  random: syncRandom,
  tty: syncTTY,
  threads: syncThreads,
  futex: syncFutex,
  signals: syncSignals,
  sockets: syncSockets,
  proc: syncProc,
};

// ─── Positive cases — async-capable on WASIXWorkerHost ─────────────────────

declare const asyncClock: AsyncClockProvider;
declare const asyncRandom: AsyncRandomProvider;
declare const asyncTTY: AsyncTTYProvider;
declare const asyncThreads: AsyncThreadsProvider;
declare const asyncFutex: AsyncFutexProvider;
declare const asyncSignals: AsyncSignalsProvider;
declare const asyncSockets: AsyncSocketsProvider;
declare const asyncProc: AsyncProcProvider;

const workerAsync: WASIXWorkerHostOptions = {
  clock: asyncClock,
  random: asyncRandom,
  tty: asyncTTY,
  threads: asyncThreads,
  futex: asyncFutex,
  signals: asyncSignals,
  sockets: asyncSockets,
  proc: asyncProc,
};

// ─── Negative cases — async-capable on WASIX(...) is a type error ──────────

// Async providers with at least one non-void return-type method are
// rejected. The ones marshalled below cover every slot that returns a
// typed value; `AsyncRandomProvider` is intentionally omitted because
// its only method returns `void`, and TypeScript's void-subtyping rule
// (any function whose declared return is `void` accepts a Promise return
// at the call site) makes the negative case unenforceable at the type
// level — this is a known, documented limitation. The bridge still
// awaits Promise returns at runtime.

// @ts-expect-error — AsyncClockProvider is not assignable to Sync<ClockProvider>
const badClock: Partial<WASIXContextOptions> = { clock: asyncClock };
// @ts-expect-error — AsyncTTYProvider rejected (get() returns TTYState)
const badTTY: Partial<WASIXContextOptions> = { tty: asyncTTY };
// @ts-expect-error — AsyncThreadsProvider rejected (spawn() returns number)
const badThreads: Partial<WASIXContextOptions> = { threads: asyncThreads };
// @ts-expect-error — AsyncFutexProvider rejected (wait() returns number)
const badFutex: Partial<WASIXContextOptions> = { futex: asyncFutex };
// @ts-expect-error — AsyncSignalsProvider rejected (register() returns Result)
const badSignals: Partial<WASIXContextOptions> = { signals: asyncSignals };
// @ts-expect-error — AsyncSocketsProvider rejected (open() returns number)
const badSockets: Partial<WASIXContextOptions> = { sockets: asyncSockets };
// @ts-expect-error — AsyncProcProvider rejected (id() returns number)
const badProc: Partial<WASIXContextOptions> = { proc: asyncProc };

// Silence unused-local diagnostics; these declarations exist purely so
// their assignment sites are compiled.
export const _types = {
  mainSync,
  workerSync,
  workerAsync,
  // asyncRandom in mainSync is structurally identical to syncRandom at
  // the type level because RandomProvider.fill returns void; this is a
  // known void-subtyping gap and is covered at runtime by the bridge.
  asyncRandomOk: { random: asyncRandom } satisfies Partial<WASIXContextOptions>,
  badClock,
  badTTY,
  badThreads,
  badFutex,
  badSignals,
  badSockets,
  badProc,
};
