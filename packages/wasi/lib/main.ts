export * from "./types.js";
export * from "./wasi/wasi.js";
export * from "./wasi/wasi-context.js";
export * from "./worker/wasi-host.js";
export * as WASISnapshotPreview1 from "./wasi/snapshot-preview1.js";

// ─── WASIX ────────────────────────────────────────────────────────────────────

// Core
export * from "./wasix/wasix.js";
export * from "./wasix/wasix-context.js";
export * from "./wasix/wasix-worker-host.js";
export * as WASIX32v1 from "./wasix/wasix-32v1.js";

// Raw provider interfaces — always synchronous, consumed by `WASIX`.
export type {
  ClockProvider,
  RandomProvider,
  TTYProvider,
  ThreadsProvider,
  FutexProvider,
  SignalsProvider,
  SignalHandler,
  SocketsProvider,
  ProcProvider,
  FileSystemProvider,
  SockAddr,
  SockAcceptResult,
  AddrHints,
  SockRecvResult,
  TTYState,
  ProcForkResult,
  ProcSpawnRequest,
  ProcExecRequest,
  ProcExitInfo,
  ProcFdTableEntry,
  ProcFdTableSlot,
  Filestat,
  Fdstat,
  FsTimestamps,
  PreopenInfo,
  DirEntry,
} from "./wasix/providers.js";

// Async-capable provider variants — accepted only by `WASIXWorkerHost`.
export type {
  AsyncCapable,
  AsyncClockProvider,
  AsyncRandomProvider,
  AsyncTTYProvider,
  AsyncThreadsProvider,
  AsyncFutexProvider,
  AsyncSignalsProvider,
  AsyncSocketsProvider,
  AsyncProcProvider,
} from "./wasix/providers/async.js";

// Bundled simulations — drop-in implementations of the raw interfaces.
export { SystemClockProvider } from "./wasix/providers/system-clock.js";
export { SystemRandomProvider } from "./wasix/providers/system-random.js";
export { FixedClockProvider } from "./wasix/providers/fixed-clock.js";
export { SeededRandomProvider } from "./wasix/providers/seeded-random.js";
export { CooperativeThreadsProvider } from "./wasix/providers/cooperative-threads.js";
export { SimulatedFutexProvider } from "./wasix/providers/simulated-futex.js";
export {
  LoopbackSocketsProvider,
  LoopbackFabric,
} from "./wasix/providers/loopback-sockets.js";
export { SelfSignalProvider } from "./wasix/providers/self-signal.js";
export { InProcessProcProvider } from "./wasix/providers/in-process-proc.js";
export type {
  ChildRunner,
  ExecRunner,
  InProcessProcProviderOptions,
  ModuleResolver,
} from "./wasix/providers/in-process-proc.js";
export {
  PipeReadEnd,
  PipeWriteEnd,
  PipeRingBuffer,
  createPipe,
} from "./wasix/providers/pipes.js";
export type { PipeEnd } from "./wasix/providers/pipes.js";
export { startThread } from "./wasix/thread-start.js";
export type { ThreadStartResult } from "./wasix/thread-start.js";

// Ergonomic providers — concrete classes hosts can drop in.
// Re-exported through the `./wasix/providers/ergonomic.js` barrel to mirror
// `WASIX-PLAN.md` § Public surface literally.
export {
  ConsoleTTYProvider,
  type ConsoleTTYOptions,
  WASIDriveFileSystemProvider,
  HTTPProvider,
  type HTTPProviderOptions,
  type OutgoingHandler,
  type IncomingHandler,
} from "./wasix/providers/ergonomic.js";
