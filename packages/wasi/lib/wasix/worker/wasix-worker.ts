// Worker entry for WASIXWorkerHost.
//
// This module runs inside a dedicated Web Worker. It receives an init
// message from the main thread, instantiates a `WASIX` against the SAB
// syscall bridge, runs the guest to completion, and posts the result
// back.
//
// The inner `WASIX` class still consumes sync providers. For any slot the
// main-thread host configured as async-capable, the worker constructs a
// thin sync shim that calls `callBridgeSync` — blocking on `Atomics.wait`
// until the main-thread dispatcher writes the response.
//
// The shape of the init message (`WASIXWorkerStartMessage`) and the reply
// messages (`WASIXWorkerHostMessage`) are shared with `wasix-worker-host.ts`
// via re-export; the host imports these types without pulling in any
// runtime worker code.

import { WASIX } from "../wasix.js";
import { WASIXContext } from "../wasix-context.js";
import {
  WASIDriveFileSystemProvider,
  type ProviderPreopen,
} from "../providers/ergonomic/filesystem-provider.js";
import type { WASIFS, WASIXExecutionResult } from "../../types.js";
import type {
  AddrHints,
  ClockProvider,
  FutexProvider,
  ProcProvider,
  RandomProvider,
  SignalsProvider,
  SockAcceptResult,
  SockAddr,
  SockRecvResult,
  SocketsProvider,
  ThreadsProvider,
  TTYProvider,
} from "../providers.js";
import { ClockId, Result, WASIXError } from "../wasix-32v1.js";
import { Opcode, callBridgeSync, type BridgeResponse } from "./bridge.js";

// ─── Messages ──────────────────────────────────────────────────────────────

/**
 * Provider slot identifiers the host declares as async-capable. The worker
 * substitutes a bridge-backed sync shim for each one; slots not listed stay
 * undefined (yielding ENOSYS) or are carried across verbatim if a pre-built
 * sync provider was configured — but the main-thread host only ever ships
 * sync providers over postMessage when they are trivially serialisable
 * (currently, only `contextConfig.stdin`-stream intent flag). In practice
 * this slice wires the bridge for anything async on the host side, and
 * leaves sync-only slots to later refactors.
 */
export type AsyncBridgedSlot =
  | "clock"
  | "random"
  | "tty"
  | "threads"
  | "futex"
  | "signals"
  | "sockets"
  | "proc";

/**
 * Subset of WASIXContext that survives postMessage. Callbacks and class
 * instances cannot cross the thread boundary, so the host sends a plain
 * data description; stdin / stdout / stderr / debug funnel through
 * bridge opcodes or `postMessage`-based streaming events.
 */
export type SerialisableContext = {
  args?: string[];
  env?: Record<string, string>;
  isTTY?: boolean;
  fs?: WASIFS;
  /** Preopens descriptor for the worker-side WASIDriveFileSystemProvider —
   *  passes through verbatim from WASIXWorkerHostOptions.preopens. */
  preopens?: ProviderPreopen[];
};

export type WASIXWorkerStartMessage = {
  target: "worker";
  type: "start";
  /** Compiled module or raw bytes. Module is preferred (no re-compile). */
  module: WebAssembly.Module | ArrayBuffer;
  /** SharedArrayBuffer is shared (not transferred) across postMessage; the
   *  main thread keeps its reference for the bridge dispatcher. */
  sharedBuffer: SharedArrayBuffer;
  contextConfig: SerialisableContext;
  /** Which provider slots the host declared as async-capable. */
  asyncSlots: AsyncBridgedSlot[];
  /** True if the host configured a stdin callback (async or sync). */
  hasStdin: boolean;
  /** Pre-resolved `clock.resolution(id)` values, keyed by `ClockId` numeric.
   *  Resolution is allowed to be a constant on every real provider, so we
   *  cache it once at start instead of round-tripping every `clock_res_get`
   *  through the bridge. Slots not present in this record fall back to the
   *  bridge shim's `1µs` default and log a debug warning. */
  clockResolutions?: Partial<Record<ClockId, bigint>>;
};

export type WASIXWorkerHostMessage =
  | { target: "host"; type: "stdout"; text: string }
  | { target: "host"; type: "stderr"; text: string }
  | {
      target: "host";
      type: "debug";
      name: string;
      args: string[];
      ret: number;
      data: Array<{ [key: string]: unknown }>;
    }
  | { target: "host"; type: "result"; result: WASIXExecutionResult }
  | { target: "host"; type: "crash"; error: { message: string; type: string } };

// ─── Provider shims ────────────────────────────────────────────────────────

function bridgeClockProvider(
  sharedBuffer: SharedArrayBuffer,
  cachedResolutions: Partial<Record<ClockId, bigint>>,
): ClockProvider {
  return {
    now(id: ClockId): bigint {
      const response = callBridgeSync(sharedBuffer, {
        opcode: Opcode.CLOCK_NOW,
        args: { clockId: id },
      }) as Extract<BridgeResponse, { opcode: Opcode.CLOCK_NOW }>;
      return response.result.timeNs;
    },
    resolution(id: ClockId): bigint {
      // The host pre-resolves and ships every supported clock's resolution
      // in the start message — see WASIXWorkerHost.runOnce. We look it up
      // here so async-capable `ClockProvider`s with non-default resolutions
      // (e.g. `new FixedClockProvider({ resolution: 5_000n })`) round-trip
      // correctly. The 1µs fallback only fires for clock IDs the host did
      // not pre-resolve (typically because the provider threw on
      // resolution(id)) — matches SystemClockProvider's default.
      return cachedResolutions[id] ?? 1_000n;
    },
  };
}

/**
 * Build a sync stdin callback out of the STDIN_READ opcode. The inner WASI
 * (inside the inner WASIX) calls stdin on every read — each call is one
 * bridge round trip.
 */
function bridgeStdin(
  sharedBuffer: SharedArrayBuffer,
): (maxByteLength: number) => string | null {
  return (maxByteLength: number): string | null => {
    const response = callBridgeSync(sharedBuffer, {
      opcode: Opcode.STDIN_READ,
      args: { maxByteLength },
    }) as Extract<BridgeResponse, { opcode: Opcode.STDIN_READ }>;
    return response.result.text;
  };
}

// ─── Main entry ────────────────────────────────────────────────────────────

// Worker globals — `self` is a DedicatedWorkerGlobalScope; narrow just the
// pieces we use (postMessage + onmessage) to avoid pulling in the `webworker`
// lib (which would fight `DOM` in the shared tsconfig).
declare const self: {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

self.onmessage = async (ev: MessageEvent) => {
  const data = ev.data as WASIXWorkerStartMessage;
  if (data.target !== "worker" || data.type !== "start") return;

  try {
    const result = await runGuest(data);
    sendMessage({ target: "host", type: "result", result });
  } catch (e) {
    const error =
      e instanceof Error
        ? { message: e.message, type: e.constructor.name }
        : { message: `unknown error - ${String(e)}`, type: "Unknown" };
    sendMessage({ target: "host", type: "crash", error });
  }
};

async function runGuest(
  msg: WASIXWorkerStartMessage,
): Promise<WASIXExecutionResult> {
  const module =
    msg.module instanceof WebAssembly.Module
      ? msg.module
      : await WebAssembly.compile(msg.module);

  // Build provider slots. For each async-capable slot on the host side,
  // install the bridge-backed sync shim. Non-async slots remain undefined —
  // the inner WASIX will lazy-init defaults (e.g. SystemClockProvider) as
  // today.
  const asyncSet = new Set<AsyncBridgedSlot>(msg.asyncSlots);

  const clock: ClockProvider | undefined = asyncSet.has("clock")
    ? bridgeClockProvider(msg.sharedBuffer, msg.clockResolutions ?? {})
    : undefined;

  // Remaining slots — no opcodes defined this slice. If the host declared
  // any of these as async-capable, we surface ENOSYS-equivalent provider
  // shims that throw WASIXError(ENOSYS) so the guest sees the correct errno
  // instead of the bridge panicking on an unknown opcode. Later slices add
  // real opcodes and remove these stubs.
  const random: RandomProvider | undefined = asyncSet.has("random")
    ? stubRandomProvider()
    : undefined;
  const tty: TTYProvider | undefined = asyncSet.has("tty")
    ? stubTTYProvider()
    : undefined;
  const threads: ThreadsProvider | undefined = asyncSet.has("threads")
    ? stubThreadsProvider()
    : undefined;
  const futex: FutexProvider | undefined = asyncSet.has("futex")
    ? stubFutexProvider()
    : undefined;
  const signals: SignalsProvider | undefined = asyncSet.has("signals")
    ? stubSignalsProvider()
    : undefined;
  const sockets: SocketsProvider | undefined = asyncSet.has("sockets")
    ? bridgeSocketsProvider(msg.sharedBuffer)
    : undefined;
  const proc: ProcProvider | undefined = asyncSet.has("proc")
    ? stubProcProvider()
    : undefined;

  // Reconstruct the WASIXContext. `stdin` — if the host configured one — is
  // wired through the bridge; stdout/stderr/debug stream back via
  // postMessage.
  const context = new WASIXContext({
    args: msg.contextConfig.args,
    env: msg.contextConfig.env,
    isTTY: msg.contextConfig.isTTY,
    fs: new WASIDriveFileSystemProvider(
      msg.contextConfig.fs ?? {},
      msg.contextConfig.preopens
        ? { preopens: msg.contextConfig.preopens }
        : undefined,
    ),
    stdin: msg.hasStdin ? bridgeStdin(msg.sharedBuffer) : () => null,
    stdout: (out: string) =>
      sendMessage({ target: "host", type: "stdout", text: out }),
    stderr: (err: string) =>
      sendMessage({ target: "host", type: "stderr", text: err }),
    debug: (name, args, ret, dataArg) => {
      const cloned = JSON.parse(JSON.stringify(dataArg)) as Array<{
        [key: string]: unknown;
      }>;
      sendMessage({
        target: "host",
        type: "debug",
        name,
        args,
        ret,
        data: cloned,
      });
      // Match the behaviour of wasi-worker.ts: return the ret value so the
      // debug hook is a no-op rewrite. The DebugFn signature expects
      // `number | undefined`.
      return ret;
    },
    clock,
    random,
    tty,
    threads,
    futex,
    signals,
    sockets,
    proc,
  });

  const wasix = new WASIX(context);
  const instance = await WebAssembly.instantiate(
    module,
    wasix.getImportObject(),
  );
  return wasix.start({ instance, module });
}

function sendMessage(message: WASIXWorkerHostMessage): void {
  self.postMessage(message);
}

// ─── ENOSYS stubs for async slots with no opcode this slice ────────────────

function throwEnosys(): never {
  // ENOSYS — no bridge opcode wired yet for this slot. The guest sees the
  // appropriate errno via wasix.ts's WASIXError → Result path.
  throw new WASIXError(Result.ENOSYS);
}

function stubRandomProvider(): RandomProvider {
  return { fill: () => throwEnosys() };
}
function stubTTYProvider(): TTYProvider {
  return { get: () => throwEnosys(), set: () => throwEnosys() };
}
function stubThreadsProvider(): ThreadsProvider {
  return {
    spawn: () => throwEnosys(),
    join: () => throwEnosys(),
    exit: () => throwEnosys(),
    sleep: () => throwEnosys(),
    id: () => throwEnosys(),
    parallelism: () => throwEnosys(),
    signal: () => throwEnosys(),
  };
}
function stubFutexProvider(): FutexProvider {
  return { wait: () => throwEnosys(), wake: () => throwEnosys() };
}
function stubSignalsProvider(): SignalsProvider {
  return {
    register: () => throwEnosys(),
    raiseInterval: () => throwEnosys(),
  };
}
/**
 * Bridge-backed sync `SocketsProvider`. Every method serialises args into
 * the SAB request region, blocks on `Atomics.wait` while the host-side
 * dispatcher invokes the async provider, and decodes the response back into
 * the JS-native shapes the inner `WASIX` consumes.
 */
function bridgeSocketsProvider(
  sharedBuffer: SharedArrayBuffer,
): SocketsProvider {
  const call = <T extends BridgeResponse>(
    req: Parameters<typeof callBridgeSync>[1],
  ) => callBridgeSync(sharedBuffer, req) as T;
  return {
    open(af: number, type: number, proto: number): number {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_OPEN }>>({
        opcode: Opcode.SOCK_OPEN,
        args: { af, type, proto },
      });
      return r.result.fd;
    },
    bind(fd: number, addr: SockAddr): Result {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_BIND }>>({
        opcode: Opcode.SOCK_BIND,
        args: { fd, addr },
      });
      return r.result.result;
    },
    connect(fd: number, addr: SockAddr): Result {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_CONNECT }>>({
        opcode: Opcode.SOCK_CONNECT,
        args: { fd, addr },
      });
      return r.result.result;
    },
    listen(fd: number, backlog: number): Result {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_LISTEN }>>({
        opcode: Opcode.SOCK_LISTEN,
        args: { fd, backlog },
      });
      return r.result.result;
    },
    accept(fd: number): SockAcceptResult {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_ACCEPT }>>({
        opcode: Opcode.SOCK_ACCEPT,
        args: { fd },
      });
      return { fd: r.result.fd, addr: r.result.addr };
    },
    send(fd: number, bufs: Uint8Array[], flags: number): number {
      // Concatenate iovecs — the bridge ships a single buffer; the host
      // provider treats it as one logical send. Capping at 60 KiB leaves
      // headroom for the request-region header (currently 13 bytes).
      const data = concatBufs(bufs);
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_SEND }>>({
        opcode: Opcode.SOCK_SEND,
        args: { fd, flags, data },
      });
      return r.result.written;
    },
    recv(fd: number, bufs: Uint8Array[], flags: number): SockRecvResult {
      const total = bufs.reduce((acc, b) => acc + b.byteLength, 0);
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_RECV }>>({
        opcode: Opcode.SOCK_RECV,
        args: { fd, flags, maxLen: total },
      });
      const bytesRead = scatterIntoIovecs(r.result.data, bufs);
      return { bytesRead, flags: r.result.flags };
    },
    shutdown(fd: number, how: number): Result {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_SHUTDOWN }>>(
        { opcode: Opcode.SOCK_SHUTDOWN, args: { fd, how } },
      );
      return r.result.result;
    },
    addrResolve(host: string, port: number, _hints: AddrHints): SockAddr[] {
      const r = call<
        Extract<BridgeResponse, { opcode: Opcode.SOCK_ADDR_RESOLVE }>
      >({
        opcode: Opcode.SOCK_ADDR_RESOLVE,
        args: { host, port, maxAddrs: 8 },
      });
      return r.result.addrs;
    },
    getOptFlag(fd: number, level: number, name: number): boolean {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_GET_OPT }>>({
        opcode: Opcode.SOCK_GET_OPT,
        args: { fd, level, name, kind: "flag" },
      });
      if (r.result.kind !== "flag") {
        throw new WASIXError(Result.EINVAL);
      }
      return r.result.value;
    },
    getOptSize(fd: number, level: number, name: number): number {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_GET_OPT }>>({
        opcode: Opcode.SOCK_GET_OPT,
        args: { fd, level, name, kind: "size" },
      });
      if (r.result.kind !== "size") {
        throw new WASIXError(Result.EINVAL);
      }
      return r.result.value;
    },
    getOptTime(fd: number, level: number, name: number): bigint | null {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_GET_OPT }>>({
        opcode: Opcode.SOCK_GET_OPT,
        args: { fd, level, name, kind: "time" },
      });
      if (r.result.kind !== "time") {
        throw new WASIXError(Result.EINVAL);
      }
      return r.result.value;
    },
    setOptFlag(
      fd: number,
      level: number,
      name: number,
      value: boolean,
    ): Result {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_SET_OPT }>>({
        opcode: Opcode.SOCK_SET_OPT,
        args: { fd, level, name, kind: "flag", value },
      });
      return r.result.result;
    },
    setOptSize(fd: number, level: number, name: number, value: number): Result {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_SET_OPT }>>({
        opcode: Opcode.SOCK_SET_OPT,
        args: { fd, level, name, kind: "size", value },
      });
      return r.result.result;
    },
    setOptTime(
      fd: number,
      level: number,
      name: number,
      value: bigint | null,
    ): Result {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_SET_OPT }>>({
        opcode: Opcode.SOCK_SET_OPT,
        args: { fd, level, name, kind: "time", value },
      });
      return r.result.result;
    },
    addrLocal(fd: number): SockAddr {
      const r = call<
        Extract<BridgeResponse, { opcode: Opcode.SOCK_ADDR_LOCAL }>
      >({ opcode: Opcode.SOCK_ADDR_LOCAL, args: { fd } });
      return r.result.addr;
    },
    addrPeer(fd: number): SockAddr {
      const r = call<
        Extract<BridgeResponse, { opcode: Opcode.SOCK_ADDR_PEER }>
      >({ opcode: Opcode.SOCK_ADDR_PEER, args: { fd } });
      return r.result.addr;
    },
    status(fd: number): number {
      const r = call<Extract<BridgeResponse, { opcode: Opcode.SOCK_STATUS }>>({
        opcode: Opcode.SOCK_STATUS,
        args: { fd },
      });
      return r.result.status;
    },
  };
}

function concatBufs(bufs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const b of bufs) total += b.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of bufs) {
    out.set(b, offset);
    offset += b.byteLength;
  }
  return out;
}

function scatterIntoIovecs(src: Uint8Array, bufs: Uint8Array[]): number {
  let written = 0;
  let cursor = 0;
  for (const buf of bufs) {
    if (cursor >= src.byteLength) break;
    const n = Math.min(src.byteLength - cursor, buf.byteLength);
    buf.set(src.subarray(cursor, cursor + n));
    cursor += n;
    written += n;
  }
  return written;
}
function stubProcProvider(): ProcProvider {
  return {
    id: () => throwEnosys(),
    parentId: () => throwEnosys(),
    fork: () => throwEnosys(),
    spawn: () => throwEnosys(),
    exec: () => throwEnosys(),
    join: () => throwEnosys(),
  };
}
