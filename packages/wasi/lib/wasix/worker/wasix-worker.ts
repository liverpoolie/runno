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

import { WASIX, type ParsedEnvImports } from "../wasix.js";
import { WASIXContext } from "../wasix-context.js";
import {
  WASIDriveFileSystemProvider,
  type ProviderPreopen,
} from "../providers/ergonomic/filesystem-provider.js";
import type { WASIFS, WASIXExecutionResult } from "../../types.js";
import type {
  ClockProvider,
  DirEntry,
  Fdstat,
  FileSystemProvider,
  Filestat,
  PreopenInfo,
  RandomProvider,
  TTYProvider,
  TTYState,
} from "../providers.js";
import { ClockId, Result } from "../wasix-32v1.js";
import {
  Opcode,
  callBridgeSync,
  requestRegionByteLength,
  type BridgeResponse,
  type TTYStateWire,
} from "./bridge.js";

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
 *
 * The host rejects at startup any slot listed here whose opcode set hasn't
 * landed yet (see `assertAsyncSlotsSupported` in `wasix-worker-host.ts`),
 * so by the time the worker reads `asyncSlots` every entry maps to a
 * bridge-backed shim below.
 */
export type AsyncBridgedSlot =
  | "clock"
  | "random"
  | "tty"
  | "threads"
  | "futex"
  | "signals"
  | "sockets"
  | "proc"
  | "fs";

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
  /** Parsed `env.memory` / `env.__indirect_function_table` descriptors. The
   *  host pre-parses these from the wasm bytes (when bytes are available)
   *  and ships them so the worker can construct matching
   *  `WebAssembly.Memory` / `Table` instances and pass them as `env` imports
   *  — wasix-libc binaries import `env.memory` and refuse to instantiate
   *  without a matching one. Absent when the host was given a pre-compiled
   *  `WebAssembly.Module` (no bytes to parse) or when neither import is
   *  present in the binary. */
  envDescriptors?: ParsedEnvImports;
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

/**
 * Assert the bridge response's opcode matches what the shim requested. The
 * encoded request and the encoded response carry the opcode independently;
 * a protocol-drift bug on either side would otherwise be silently
 * misinterpreted (we'd decode a CLOCK_NOW response into a STDIN_READ shape
 * because the type system erased the union narrowing). This runtime check
 * surfaces it as a clear error.
 */
function expectOpcode<O extends Opcode>(
  response: BridgeResponse,
  opcode: O,
): Extract<BridgeResponse, { opcode: O }> {
  if (response.opcode !== opcode) {
    throw new Error(
      `bridge: mismatched response opcode (got ${response.opcode}, expected ${opcode})`,
    );
  }
  return response as Extract<BridgeResponse, { opcode: O }>;
}

function bridgeClockProvider(
  sharedBuffer: SharedArrayBuffer,
  cachedResolutions: Partial<Record<ClockId, bigint>>,
): ClockProvider {
  return {
    now(id: ClockId): bigint {
      const response = expectOpcode(
        callBridgeSync(sharedBuffer, {
          opcode: Opcode.CLOCK_NOW,
          args: { clockId: id },
        }),
        Opcode.CLOCK_NOW,
      );
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

function bridgeRandomProvider(sharedBuffer: SharedArrayBuffer): RandomProvider {
  return {
    fill(buf: Uint8Array): void {
      // The bridge response region caps a single fill at < region byte size.
      // We chunk so a guest-side fill of >region bytes still works — the
      // shim issues multiple round trips and stitches them together.
      let offset = 0;
      while (offset < buf.byteLength) {
        // Conservative chunk size: 16 KiB. Smaller than the 64 KiB region,
        // leaves headroom for tag + length header, and avoids pathologically
        // large host allocations for a runaway guest.
        const chunk = Math.min(buf.byteLength - offset, 16 * 1024);
        const response = expectOpcode(
          callBridgeSync(sharedBuffer, {
            opcode: Opcode.RANDOM_FILL,
            args: { byteLength: chunk },
          }),
          Opcode.RANDOM_FILL,
        );
        buf.set(response.result.bytes, offset);
        offset += chunk;
      }
    },
  };
}

function bridgeTTYProvider(sharedBuffer: SharedArrayBuffer): TTYProvider {
  return {
    get(): TTYState {
      const response = expectOpcode(
        callBridgeSync(sharedBuffer, {
          opcode: Opcode.TTY_GET,
          args: {},
        }),
        Opcode.TTY_GET,
      );
      return wireToTTYState(response.result.state);
    },
    set(state: TTYState): Result {
      const response = expectOpcode(
        callBridgeSync(sharedBuffer, {
          opcode: Opcode.TTY_SET,
          args: { state: ttyStateToWire(state) },
        }),
        Opcode.TTY_SET,
      );
      return response.result.result;
    },
  };
}

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

/**
 * Build a sync stdin callback out of the STDIN_READ opcode. The inner WASI
 * (inside the inner WASIX) calls stdin on every read — each call is one
 * bridge round trip.
 */
function bridgeStdin(
  sharedBuffer: SharedArrayBuffer,
): (maxByteLength: number) => string | null {
  return (maxByteLength: number): string | null => {
    const response = expectOpcode(
      callBridgeSync(sharedBuffer, {
        opcode: Opcode.STDIN_READ,
        args: { maxByteLength },
      }),
      Opcode.STDIN_READ,
    );
    return response.result.text;
  };
}

/**
 * Build a sync `FileSystemProvider` whose every method routes through the
 * bridge to the main thread. The host-side dispatcher awaits the Promise
 * return of each `AsyncFileSystemProvider` method before writing the
 * response back to this worker.
 *
 * Chunking: `fdRead` / `fdWrite` payloads are bounded by the request /
 * response region size. The region is symmetric, so we use the request side
 * as the per-call ceiling for both directions. The shim reserves ~4 KiB of
 * headroom for codec framing (per the bridge layout's length-prefix +
 * `RequestTag.ARGS` byte) and breaks larger transfers into successive
 * round trips.
 */
function bridgeFileSystemProvider(
  sharedBuffer: SharedArrayBuffer,
): FileSystemProvider {
  const regionBytes = requestRegionByteLength(sharedBuffer);
  const CHUNK_OVERHEAD = 4 * 1024; // Conservative headroom for codec framing.
  const chunkLimit = Math.max(1024, regionBytes - CHUNK_OVERHEAD);

  // Path-opcode budget: the request region carries opcode-specific fixed
  // args (≤ 32 bytes for FS_PATH_OPEN), a tag byte, and one length prefix
  // per path. 64 bytes of overhead is comfortably more than any path opcode
  // needs and leaves the encoded path room to fail with the right errno
  // before `writeUtf8` would throw a generic RangeError.
  const PATH_OVERHEAD = 64;
  const pathBudget = Math.max(0, regionBytes - PATH_OVERHEAD);
  const pathEncoder = new TextEncoder();
  function ensurePathFits(...paths: string[]): void {
    let total = 0;
    for (const p of paths) total += pathEncoder.encode(p).byteLength;
    if (total > pathBudget) {
      throw new WASIXError(Result.ENAMETOOLONG);
    }
  }

  // Single-call helper. Each caller passes the opcode + args shape it expects
  // and reads back the matching result. The cast is local to this helper so
  // call sites stay strongly-typed on the surrounding shim's signatures.
  type CallResult<O extends Opcode> = Extract<
    BridgeResponse,
    { opcode: O }
  >["result"];
  function call<O extends Opcode>(opcode: O, args: unknown): CallResult<O> {
    const response = callBridgeSync(sharedBuffer, {
      opcode,
      args,
    } as unknown as Parameters<typeof callBridgeSync>[1]);
    // The cast survives the lifetime of one call — the dispatcher is the
    // only writer of `result` and it always matches `opcode`.
    return (response as unknown as { result: CallResult<O> }).result;
  }

  return {
    fdRead(fd: number, bufs: Uint8Array[]): number {
      // Loop: each round trip may cover one or more bufs, or a single slice
      // of one buf when that buf is larger than chunkLimit. We track per-buf
      // cumulative bytes already placed so a buf split across multiple round
      // trips lands its chunks at consecutive offsets, not always at the
      // tail.
      let total = 0;
      let bufIndex = 0;
      let writtenInBuf = 0;
      while (bufIndex < bufs.length) {
        // Skip already-full or zero-length bufs.
        if (bufs[bufIndex].byteLength - writtenInBuf === 0) {
          bufIndex++;
          writtenInBuf = 0;
          continue;
        }

        // Build a batch: each slot records (target bufIndex, offset, length).
        const batchSizes: number[] = [];
        const batchPlacements: { bufIndex: number; offset: number }[] = [];
        let batchTotal = 0;
        let probeIndex = bufIndex;
        let probeOffset = writtenInBuf;
        while (probeIndex < bufs.length && batchTotal < chunkLimit) {
          const remainingInBuf = bufs[probeIndex].byteLength - probeOffset;
          if (remainingInBuf === 0) {
            probeIndex++;
            probeOffset = 0;
            continue;
          }
          const remainingInChunk = chunkLimit - batchTotal;
          const slotSize = Math.min(remainingInBuf, remainingInChunk);
          batchSizes.push(slotSize);
          batchPlacements.push({ bufIndex: probeIndex, offset: probeOffset });
          batchTotal += slotSize;
          if (slotSize === remainingInBuf) {
            probeIndex++;
            probeOffset = 0;
          } else {
            // Hit chunk limit mid-buf — this slot is the tail of the batch.
            break;
          }
        }
        if (batchSizes.length === 0) break;

        const { bytes } = call(Opcode.FS_FD_READ, { fd, sizes: batchSizes });
        if (bytes.byteLength === 0) break;

        let bytesCursor = 0;
        let shortRead = false;
        for (let i = 0; i < batchSizes.length; i++) {
          const wantSize = batchSizes[i];
          const slice = bytes.subarray(
            bytesCursor,
            bytesCursor + Math.min(wantSize, bytes.byteLength - bytesCursor),
          );
          if (slice.byteLength === 0) {
            shortRead = true;
            break;
          }
          const { bufIndex: targetIndex, offset } = batchPlacements[i];
          bufs[targetIndex].set(slice, offset);
          bytesCursor += slice.byteLength;
          total += slice.byteLength;

          // Advance the persistent cursor.
          bufIndex = targetIndex;
          writtenInBuf = offset + slice.byteLength;
          if (writtenInBuf === bufs[targetIndex].byteLength) {
            bufIndex++;
            writtenInBuf = 0;
          }
          if (slice.byteLength < wantSize) {
            // Short read on this slot — done.
            shortRead = true;
            break;
          }
        }
        if (shortRead) return total;
        // Host returned fewer bytes than the full batch asked for — stop.
        if (bytes.byteLength < batchTotal) return total;
      }
      return total;
    },

    fdWrite(fd: number, bufs: Uint8Array[]): number {
      // Concatenate up to one chunk's worth at a time. Short write returns
      // immediately with the partial total.
      const flattened = concatBufs(bufs);
      let written = 0;
      while (written < flattened.byteLength) {
        const slice = flattened.subarray(
          written,
          Math.min(flattened.byteLength, written + chunkLimit),
        );
        // Copy into a fresh Uint8Array — bytes are encoded with a fresh
        // length-prefix copy in the bridge codec, so a subarray view is
        // fine, but bytes that hand the codec a shared-memory view make
        // the spec brittle. The copy here is at most chunkLimit bytes.
        const { written: n } = call(Opcode.FS_FD_WRITE, {
          fd,
          bytes: new Uint8Array(slice),
        });
        written += n;
        if (n < slice.byteLength) break;
      }
      return written;
    },

    fdSeek(fd: number, offset: bigint, whence: number): bigint {
      return call(Opcode.FS_FD_SEEK, { fd, offset, whence }).position;
    },

    fdClose(fd: number): void {
      call(Opcode.FS_FD_CLOSE, { fd });
    },

    fdFdstatGet(fd: number): Fdstat {
      return call(Opcode.FS_FD_FDSTAT_GET, { fd }).fdstat;
    },

    fdFdstatSetFlags(fd: number, flags: number): void {
      call(Opcode.FS_FD_FDSTAT_SET_FLAGS, { fd, flags });
    },

    fdFilestatGet(fd: number): Filestat {
      return call(Opcode.FS_FD_FILESTAT_GET, { fd }).filestat;
    },

    fdPrestatGet(fd: number): PreopenInfo | null {
      return call(Opcode.FS_FD_PRESTAT_GET, { fd }).prestat;
    },

    fdPrestatDirName(fd: number): string {
      return call(Opcode.FS_FD_PRESTAT_DIR_NAME, { fd }).name;
    },

    fdReaddir(fd: number, cookie: bigint): DirEntry[] {
      return call(Opcode.FS_FD_READDIR, { fd, cookie }).entries;
    },

    pathOpen(
      fdDir: number,
      dirflags: number,
      path: string,
      oflags: number,
      rightsBase: bigint,
      rightsInheriting: bigint,
      fdflags: number,
    ): number {
      ensurePathFits(path);
      return call(Opcode.FS_PATH_OPEN, {
        fdDir,
        dirflags,
        path,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
      }).fd;
    },

    pathFilestatGet(fdDir: number, dirflags: number, path: string): Filestat {
      ensurePathFits(path);
      return call(Opcode.FS_PATH_FILESTAT_GET, { fdDir, dirflags, path })
        .filestat;
    },

    pathCreateDirectory(fdDir: number, path: string): void {
      ensurePathFits(path);
      call(Opcode.FS_PATH_CREATE_DIRECTORY, { fdDir, path });
    },

    pathUnlinkFile(fdDir: number, path: string): void {
      ensurePathFits(path);
      call(Opcode.FS_PATH_UNLINK_FILE, { fdDir, path });
    },

    pathRemoveDirectory(fdDir: number, path: string): void {
      ensurePathFits(path);
      call(Opcode.FS_PATH_REMOVE_DIRECTORY, { fdDir, path });
    },

    pathRename(
      fdDir: number,
      oldPath: string,
      fdNewDir: number,
      newPath: string,
    ): void {
      ensurePathFits(oldPath, newPath);
      call(Opcode.FS_PATH_RENAME, { fdDir, oldPath, fdNewDir, newPath });
    },
  };
}

function concatBufs(bufs: Uint8Array[]): Uint8Array {
  if (bufs.length === 0) return new Uint8Array(0);
  if (bufs.length === 1) return bufs[0];
  let total = 0;
  for (const buf of bufs) total += buf.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const buf of bufs) {
    out.set(buf, cursor);
    cursor += buf.byteLength;
  }
  return out;
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
  //
  // Slots without bridge opcodes (threads / futex / signals / sockets /
  // proc) cannot appear here — the host's `assertAsyncSlotsSupported`
  // rejects them at startup with ENOSYS, so they never reach the worker.
  const asyncSet = new Set<AsyncBridgedSlot>(msg.asyncSlots);

  const clock: ClockProvider | undefined = asyncSet.has("clock")
    ? bridgeClockProvider(msg.sharedBuffer, msg.clockResolutions ?? {})
    : undefined;
  const random: RandomProvider | undefined = asyncSet.has("random")
    ? bridgeRandomProvider(msg.sharedBuffer)
    : undefined;
  const tty: TTYProvider | undefined = asyncSet.has("tty")
    ? bridgeTTYProvider(msg.sharedBuffer)
    : undefined;

  // Filesystem slot. If the host passed a `FileSystemProvider` (sync) or an
  // `AsyncFileSystemProvider`, it lives on the main thread and the worker
  // routes through the bridge — `fs` appears in `asyncSlots`. Otherwise the
  // host passed a serialisable `WASIFS`, which the worker reconstructs into
  // a local `WASIDriveFileSystemProvider`.
  const fs = asyncSet.has("fs")
    ? bridgeFileSystemProvider(msg.sharedBuffer)
    : new WASIDriveFileSystemProvider(
        msg.contextConfig.fs ?? {},
        msg.contextConfig.preopens
          ? { preopens: msg.contextConfig.preopens }
          : undefined,
      );

  // Reconstruct the WASIXContext. `stdin` — if the host configured one — is
  // wired through the bridge; stdout/stderr/debug stream back via
  // postMessage.
  const context = new WASIXContext({
    args: msg.contextConfig.args,
    env: msg.contextConfig.env,
    isTTY: msg.contextConfig.isTTY,
    fs,
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
  });

  const wasix = new WASIX(context);
  // Mirror WASIX.start's slice-3.5 env-import surface: wasix-libc binaries
  // import `env.memory` (often shared) and `env.__indirect_function_table`
  // and refuse to instantiate without matching descriptors. The host parses
  // them from the wasm bytes before postMessage; here we turn them into
  // concrete `WebAssembly.Memory` / `Table` instances and feed them into
  // both the import object and `wasix.start`'s memory option (so the
  // SharedArrayBuffer-aware TextDecoder path in `readString` sees the right
  // memory before any export memory exists). When the host had no bytes
  // (e.g. it was handed a pre-compiled `WebAssembly.Module`) descriptors
  // are absent and resolveEnvImports returns an empty object — preview1
  // binaries that export their own memory still instantiate fine.
  const { memory, indirectFunctionTable } = wasix.resolveEnvImports(
    msg.envDescriptors ?? {},
  );
  const instance = await WebAssembly.instantiate(
    module,
    wasix.getImportObject({ memory, indirectFunctionTable }),
  );
  return wasix.start({ instance, module }, { memory });
}

function sendMessage(message: WASIXWorkerHostMessage): void {
  self.postMessage(message);
}
