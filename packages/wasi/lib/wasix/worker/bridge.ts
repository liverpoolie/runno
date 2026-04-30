// Generic SharedArrayBuffer-backed syscall bridge.
//
// This is an implementation detail of WASIXWorkerHost — NOT exported from the
// package root. `WASIX` and providers never see it; they stay pointer-free
// and sync. The bridge only exists to let the worker-side WASIX treat an
// async-capable host provider as if it were sync.
//
// ─── Protocol (one request/response pair per worker) ────────────────────────
//
// The worker owns the single bridge buffer; the main thread is handed a
// reference to the same SharedArrayBuffer at worker start.
//
// Buffer layout (little-endian, Int32 indices into the same SAB):
//
//   i32 offset  purpose
//   ──────────  ────────────────────────────────────────────────────────
//   0           STATE word
//                 0 = idle             (nothing pending)
//                 1 = request-pending  (worker wrote a request, waiting
//                                       for main-thread dispatch)
//                 2 = response-ready   (main thread wrote a response,
//                                       worker may read it)
//   1           OPCODE   (see Opcode below — identifies which syscall)
//   2           ARG_LEN  (byte length of payload in request region)
//   3           RESP_LEN (byte length of payload in response region; also
//                         used to carry a structured-error tag — see below)
//
// Header size is 16 bytes (4 × i32). After the header come two regions:
//
//   bytes [HEADER_BYTES, HEADER_BYTES + REQUEST_REGION_BYTES)   request payload
//   bytes [HEADER_BYTES + REQUEST_REGION_BYTES, end)            response payload
//
// Total buffer size is fixed at construction time. The caller is responsible
// for sizing it generously enough for the largest opcode they expect.
//
// ─── Encoding ───────────────────────────────────────────────────────────────
//
// Each payload is a discriminated-union tag byte followed by opcode-specific
// bytes. This lets later slices add new opcodes (or extend existing ones)
// without breaking old bridge peers — a consumer that doesn't understand a
// tag writes back an ENOSYS error tag and every side agrees.
//
// ─── Error model ────────────────────────────────────────────────────────────
//
// When the main-thread provider throws:
//   - If the thrown error is a `WASIXError`, the bridge encodes the numeric
//     `Result` in RESP_LEN's high half (see packRespLen) and writes a single
//     response byte tagged `RESP_TAG_WASIX_ERROR`. The worker re-throws as
//     `new WASIXError(result)`, which `wasix.ts` already maps to the right
//     errno return.
//   - Any other thrown value becomes `RESP_TAG_GENERIC_ERROR` with an optional
//     UTF-8 message. The worker re-throws as a generic `Error`; `wasix.ts`
//     treats it the same as any other thrown non-WASIXError — EIO.
//
// This module contains no runtime imports from outside the worker; both
// sides (main thread and worker thread) share this file to guarantee a
// single source of truth for layout constants and tag values.

import { Result, WASIXError } from "../wasix-32v1.js";
import type { SockAddr, SockRecvResult } from "../providers.js";

// ─── Layout constants ──────────────────────────────────────────────────────

/** Header words (Int32 slots) — state, opcode, argLen, respLen. */
export const HEADER_WORDS = 4;
/** Header size in bytes (= HEADER_WORDS * 4). */
export const HEADER_BYTES = HEADER_WORDS * 4;

/** State word slot indices. */
export const STATE_INDEX = 0;
export const OPCODE_INDEX = 1;
export const ARG_LEN_INDEX = 2;
export const RESP_LEN_INDEX = 3;

/** State word values. */
export const STATE_IDLE = 0;
export const STATE_REQUEST_PENDING = 1;
export const STATE_RESPONSE_READY = 2;

/**
 * Smallest viable per-region byte length. CLOCK_NOW's response is 9 bytes
 * (tag + u64), TTY_GET's response is 20 bytes (tag + 4×u32 + 3×u8), and
 * RANDOM_FILL is variable up to the region cap. 32 bytes leaves a defensible
 * floor for every opcode landed this slice and gives room for an error tag
 * payload (tag + u32 length + ~20 bytes of message) on the smallest legal
 * configuration. Hosts allocating their own buffer below this floor get a
 * construction-time error rather than a wedged worker on first dispatch.
 */
export const MIN_REGION_BYTES = 32;

/** Default region sizes — 64 KiB each is plenty for every opcode landed
 *  this slice (debug strings + stdin chunks + a single random-fill chunk).
 *  Later slices that need bigger payloads can bump this without a protocol
 *  break. */
export const DEFAULT_REQUEST_REGION_BYTES = 64 * 1024;
export const DEFAULT_RESPONSE_REGION_BYTES = 64 * 1024;

/** Total buffer size for the default layout. */
export const DEFAULT_BRIDGE_BUFFER_BYTES =
  HEADER_BYTES + DEFAULT_REQUEST_REGION_BYTES + DEFAULT_RESPONSE_REGION_BYTES;

// ─── Opcode registry ───────────────────────────────────────────────────────

/**
 * Opcodes enumerated here are the minimal set needed to exercise the bridge
 * this slice. Adding an opcode is cheap — append a new enum member, bump the
 * encoder/decoder tables, and plumb it through the worker-side sync shim.
 * DO NOT register opcodes for syscalls that don't exist yet.
 *
 * - `DEBUG` — smoke-test round trip. Guest sends a UTF-8 string, main thread
 *   echoes its length back. Used by the targeted bridge unit spec.
 * - `STDIN_READ` — replaces the bespoke stdin-SAB pattern. Host provides
 *   stdin via its existing `(maxByteLength) => string | null` callback; the
 *   main-thread dispatcher awaits whatever that callback returns.
 * - `CLOCK_NOW` — async-capable `ClockProvider.now(clockId) -> bigint`. The
 *   targeted unit spec uses this to prove the async → sync round trip works
 *   end-to-end with a real Promise-returning provider on the main thread.
 * - `RANDOM_FILL` — async-capable `RandomProvider.fill(buf)`. The host fills
 *   `byteLength` random bytes and returns them; the worker shim copies them
 *   into the caller's buffer (chunking when the buffer exceeds the region
 *   cap).
 * - `TTY_GET` / `TTY_SET` — async-capable `TTYProvider.get()` / `.set(state)`.
 */
/**
 * Reserved numeric ranges (forward-compatible; do NOT renumber):
 *   1–9    : core diagnostics + clock + stdio (Slice 4 / 5).
 *   10–19  : FUTEX / THREADS opcodes (Slice 6/7).
 *   20–29  : PROC opcodes (Slice 8).
 *   30–49  : SOCKETS opcodes (Slice 5 — this enum block).
 *   50–69  : SIGNALS opcodes (Slice 7 grab-bag).
 *   70–89  : TTY / poll / epoll opcodes (Slice 10).
 *   90+    : free for future expansion.
 *
 * `Opcode` is a wire-protocol value — once shipped, an enum member's
 * numeric value is permanent. Add new opcodes by appending to the
 * appropriate range; do not reuse retired numbers.
 */
export enum Opcode {
  DEBUG = 1,
  STDIN_READ = 2,
  CLOCK_NOW = 3,
  RANDOM_FILL = 4,
  TTY_GET = 5,
  TTY_SET = 6,

  // Sockets — Slice 5.
  SOCK_OPEN = 30,
  SOCK_BIND = 31,
  SOCK_CONNECT = 32,
  SOCK_LISTEN = 33,
  SOCK_ACCEPT = 34,
  SOCK_SEND = 35,
  SOCK_RECV = 36,
  SOCK_SHUTDOWN = 37,
  SOCK_ADDR_RESOLVE = 38,
  SOCK_ADDR_LOCAL = 39,
  SOCK_ADDR_PEER = 40,
  SOCK_STATUS = 41,
  SOCK_GET_OPT = 42,
  SOCK_SET_OPT = 43,
}

// ─── Response tags ─────────────────────────────────────────────────────────

/** First byte of the response region — what kind of answer this is. */
export enum ResponseTag {
  /** Ordinary payload followed by opcode-specific bytes. */
  OK = 0,
  /** Provider threw a WASIXError. Numeric Result is in response byte 1..5. */
  WASIX_ERROR = 1,
  /** Provider threw something else. Remaining bytes are a UTF-8 message. */
  GENERIC_ERROR = 2,
}

/** First byte of the request region — identifies the argument encoding. */
export enum RequestTag {
  /** Opcode-specific args follow the tag byte. */
  ARGS = 0,
}

// ─── Encoder / decoder helpers ─────────────────────────────────────────────

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Helper: write a UTF-8 string into a Uint8Array starting at `offset`.
 * Returns bytes written. Throws if the string would overflow the buffer.
 */
function writeUtf8(dst: Uint8Array, offset: number, value: string): number {
  const bytes = textEncoder.encode(value);
  if (offset + bytes.byteLength > dst.byteLength) {
    throw new Error(
      `bridge: payload exceeds region (${offset + bytes.byteLength} > ${dst.byteLength})`,
    );
  }
  dst.set(bytes, offset);
  return bytes.byteLength;
}

function readUtf8(src: Uint8Array, offset: number, length: number): string {
  // Chromium throws "The provided ArrayBufferView value must not be shared"
  // when `TextDecoder.decode` is handed a Uint8Array view of a
  // SharedArrayBuffer. Both sides of the bridge run on SAB-backed regions,
  // so copy into an owned ArrayBuffer first. Cheap — the bridge regions
  // hand-process payloads in the dozens-to-low-thousands of bytes.
  const owned = new Uint8Array(length);
  owned.set(src.subarray(offset, offset + length));
  return textDecoder.decode(owned);
}

// ─── SockAddr encoding for the bridge wire ────────────────────────────────
//
// Slice-internal compact form (NOT mirroring the wasix in-memory struct —
// see plan § "SockAddr wire layout in bridge protocol"):
//
//   [0]    family u8          (1=INET4, 2=INET6, 3=UNIX, 0=UNSPEC)
//   [1]    addr_len u8        (4 for INET4, 16 for INET6, ≤255 for UNIX)
//   [2..4] port u16 LE        (0 for UNIX / UNSPEC)
//   [4..]  addr_len bytes     (raw IP bytes / UTF-8 unix path)
//
// Returns the number of bytes written. Caller advances by `4 + addr_len`.

const SOCK_ADDR_FAMILY_UNSPEC = 0;
const SOCK_ADDR_FAMILY_INET4 = 1;
const SOCK_ADDR_FAMILY_INET6 = 2;
const SOCK_ADDR_FAMILY_UNIX = 3;

function encodeSockAddr(
  region: Uint8Array,
  view: DataView,
  offset: number,
  addr: SockAddr,
): number {
  if (addr.family === "inet4") {
    region[offset] = SOCK_ADDR_FAMILY_INET4;
    region[offset + 1] = 4;
    view.setUint16(offset + 2, addr.port, true);
    const parts = addr.address.split(".").map((s) => Number.parseInt(s, 10));
    for (let i = 0; i < 4; i++) region[offset + 4 + i] = parts[i] ?? 0;
    return 8;
  }
  if (addr.family === "inet6") {
    region[offset] = SOCK_ADDR_FAMILY_INET6;
    region[offset + 1] = 16;
    view.setUint16(offset + 2, addr.port, true);
    const groups = expandIPv6(addr.address);
    for (let i = 0; i < 8; i++) {
      region[offset + 4 + i * 2] = (groups[i] >> 8) & 0xff;
      region[offset + 4 + i * 2 + 1] = groups[i] & 0xff;
    }
    return 20;
  }
  // unix
  region[offset] = SOCK_ADDR_FAMILY_UNIX;
  const bytes = textEncoder.encode(addr.path);
  const len = Math.min(bytes.byteLength, 255);
  region[offset + 1] = len;
  view.setUint16(offset + 2, 0, true);
  region.set(bytes.subarray(0, len), offset + 4);
  return 4 + len;
}

function decodeSockAddr(
  region: Uint8Array,
  view: DataView,
  offset: number,
): { addr: SockAddr; size: number } {
  const family = region[offset];
  const addrLen = region[offset + 1];
  const port = view.getUint16(offset + 2, true);
  if (family === SOCK_ADDR_FAMILY_INET4) {
    const a = region[offset + 4];
    const b = region[offset + 5];
    const c = region[offset + 6];
    const d = region[offset + 7];
    return {
      addr: { family: "inet4", address: `${a}.${b}.${c}.${d}`, port },
      size: 4 + addrLen,
    };
  }
  if (family === SOCK_ADDR_FAMILY_INET6) {
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const hi = region[offset + 4 + i * 2];
      const lo = region[offset + 4 + i * 2 + 1];
      parts.push(((hi << 8) | lo).toString(16));
    }
    return {
      addr: { family: "inet6", address: parts.join(":"), port },
      size: 4 + addrLen,
    };
  }
  if (family === SOCK_ADDR_FAMILY_UNIX) {
    const path = readUtf8(region, offset + 4, addrLen);
    return { addr: { family: "unix", path }, size: 4 + addrLen };
  }
  if (family === SOCK_ADDR_FAMILY_UNSPEC) {
    // Decode unspec as a zero-IPv4 sentinel — the caller knows what to do.
    return {
      addr: { family: "inet4", address: "0.0.0.0", port: 0 },
      size: 4 + addrLen,
    };
  }
  throw new Error(`bridge: unknown sock_addr family ${family}`);
}

function expandIPv6(address: string): number[] {
  // Mirror of wasix.ts's expander — minimal RFC 4291 subset (handles "::").
  const halves = address.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fillCount = 8 - head.length - tail.length;
  const middle = new Array<string>(fillCount).fill("0");
  const all = [...head, ...middle, ...tail].slice(0, 8);
  return all.map((g) => Number.parseInt(g || "0", 16));
}

// ─── Per-opcode request / response shapes ──────────────────────────────────

export type DebugRequest = { message: string };
export type DebugResponse = { length: number };

export type StdinReadRequest = { maxByteLength: number };
/** `text === null` signals EOF (stdin callback returned null). */
export type StdinReadResponse = { text: string | null };

export type ClockNowRequest = { clockId: number };
export type ClockNowResponse = { timeNs: bigint };

export type RandomFillRequest = { byteLength: number };
/** Random bytes filled by the host. Length is implicit in `bytes.byteLength`. */
export type RandomFillResponse = { bytes: Uint8Array };

export type TTYStateWire = {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  echo: boolean;
  lineBuffered: boolean;
  raw: boolean;
};

export type TTYGetRequest = Record<string, never>;
export type TTYGetResponse = { state: TTYStateWire };

export type TTYSetRequest = { state: TTYStateWire };
export type TTYSetResponse = { result: Result };

// ─── Sockets opcodes ──────────────────────────────────────────────────────

export type SockOpenRequest = {
  af: number;
  type: number;
  proto: number;
};
export type SockOpenResponse = { fd: number };

export type SockBindRequest = { fd: number; addr: SockAddr };
export type SockBindResponse = { result: Result };

export type SockConnectRequest = { fd: number; addr: SockAddr };
export type SockConnectResponse = { result: Result };

export type SockListenRequest = { fd: number; backlog: number };
export type SockListenResponse = { result: Result };

export type SockAcceptRequest = { fd: number };
export type SockAcceptResponse = { fd: number; addr: SockAddr };

export type SockSendRequest = {
  fd: number;
  flags: number;
  /** Concatenated bytes — provider sees a single Uint8Array iovec. */
  data: Uint8Array;
};
export type SockSendResponse = { written: number };

export type SockRecvRequest = {
  fd: number;
  flags: number;
  /** Total iovec capacity — host provider allocates a single buffer of this
   *  size and returns the prefix bytes that fit. */
  maxLen: number;
};
export type SockRecvResponse = {
  data: Uint8Array;
  flags: number;
};

export type SockShutdownRequest = { fd: number; how: number };
export type SockShutdownResponse = { result: Result };

export type SockAddrResolveRequest = {
  host: string;
  port: number;
  maxAddrs: number;
};
export type SockAddrResolveResponse = {
  addrs: SockAddr[];
};

export type SockAddrAccessorRequest = { fd: number };
export type SockAddrAccessorResponse = { addr: SockAddr };

export type SockStatusRequest = { fd: number };
export type SockStatusResponse = { status: number };

export type SockOptKind = "flag" | "size" | "time";

export type SockGetOptRequest = {
  fd: number;
  level: number;
  name: number;
  kind: SockOptKind;
};
export type SockGetOptResponse =
  | { kind: "flag"; value: boolean }
  | { kind: "size"; value: number }
  | { kind: "time"; value: bigint | null };

export type SockSetOptRequest =
  | { fd: number; level: number; name: number; kind: "flag"; value: boolean }
  | { fd: number; level: number; name: number; kind: "size"; value: number }
  | {
      fd: number;
      level: number;
      name: number;
      kind: "time";
      value: bigint | null;
    };
export type SockSetOptResponse = { result: Result };

export type BridgeRequest =
  | { opcode: Opcode.DEBUG; args: DebugRequest }
  | { opcode: Opcode.STDIN_READ; args: StdinReadRequest }
  | { opcode: Opcode.CLOCK_NOW; args: ClockNowRequest }
  | { opcode: Opcode.RANDOM_FILL; args: RandomFillRequest }
  | { opcode: Opcode.TTY_GET; args: TTYGetRequest }
  | { opcode: Opcode.TTY_SET; args: TTYSetRequest }
  | { opcode: Opcode.SOCK_OPEN; args: SockOpenRequest }
  | { opcode: Opcode.SOCK_BIND; args: SockBindRequest }
  | { opcode: Opcode.SOCK_CONNECT; args: SockConnectRequest }
  | { opcode: Opcode.SOCK_LISTEN; args: SockListenRequest }
  | { opcode: Opcode.SOCK_ACCEPT; args: SockAcceptRequest }
  | { opcode: Opcode.SOCK_SEND; args: SockSendRequest }
  | { opcode: Opcode.SOCK_RECV; args: SockRecvRequest }
  | { opcode: Opcode.SOCK_SHUTDOWN; args: SockShutdownRequest }
  | { opcode: Opcode.SOCK_ADDR_RESOLVE; args: SockAddrResolveRequest }
  | { opcode: Opcode.SOCK_ADDR_LOCAL; args: SockAddrAccessorRequest }
  | { opcode: Opcode.SOCK_ADDR_PEER; args: SockAddrAccessorRequest }
  | { opcode: Opcode.SOCK_STATUS; args: SockStatusRequest }
  | { opcode: Opcode.SOCK_GET_OPT; args: SockGetOptRequest }
  | { opcode: Opcode.SOCK_SET_OPT; args: SockSetOptRequest };

export type BridgeResponse =
  | { opcode: Opcode.DEBUG; result: DebugResponse }
  | { opcode: Opcode.STDIN_READ; result: StdinReadResponse }
  | { opcode: Opcode.CLOCK_NOW; result: ClockNowResponse }
  | { opcode: Opcode.RANDOM_FILL; result: RandomFillResponse }
  | { opcode: Opcode.TTY_GET; result: TTYGetResponse }
  | { opcode: Opcode.TTY_SET; result: TTYSetResponse }
  | { opcode: Opcode.SOCK_OPEN; result: SockOpenResponse }
  | { opcode: Opcode.SOCK_BIND; result: SockBindResponse }
  | { opcode: Opcode.SOCK_CONNECT; result: SockConnectResponse }
  | { opcode: Opcode.SOCK_LISTEN; result: SockListenResponse }
  | { opcode: Opcode.SOCK_ACCEPT; result: SockAcceptResponse }
  | { opcode: Opcode.SOCK_SEND; result: SockSendResponse }
  | { opcode: Opcode.SOCK_RECV; result: SockRecvResponse }
  | { opcode: Opcode.SOCK_SHUTDOWN; result: SockShutdownResponse }
  | { opcode: Opcode.SOCK_ADDR_RESOLVE; result: SockAddrResolveResponse }
  | { opcode: Opcode.SOCK_ADDR_LOCAL; result: SockAddrAccessorResponse }
  | { opcode: Opcode.SOCK_ADDR_PEER; result: SockAddrAccessorResponse }
  | { opcode: Opcode.SOCK_STATUS; result: SockStatusResponse }
  | { opcode: Opcode.SOCK_GET_OPT; result: SockGetOptResponse }
  | { opcode: Opcode.SOCK_SET_OPT; result: SockSetOptResponse };

export type { SockRecvResult };

// ─── Region accessors ──────────────────────────────────────────────────────

/**
 * Get the request-region Uint8Array view. Bytes [0, ARG_LEN) are valid data.
 */
export function requestRegion(buffer: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(buffer, HEADER_BYTES, requestRegionByteLength(buffer));
}

/**
 * Get the response-region Uint8Array view. Bytes [0, RESP_LEN) are valid data
 * once the state word is STATE_RESPONSE_READY.
 */
export function responseRegion(buffer: SharedArrayBuffer): Uint8Array {
  const start = HEADER_BYTES + requestRegionByteLength(buffer);
  return new Uint8Array(buffer, start, buffer.byteLength - start);
}

/**
 * The split between request and response regions is fixed at buffer
 * construction time via `createBridgeBuffer`. We store the split inside the
 * buffer itself so both sides agree without an out-of-band size message.
 *
 * Layout: the buffer is `[ HEADER | request-region | response-region ]`.
 * The request region is always `(buffer.byteLength - HEADER_BYTES) / 2`
 * rounded down to a 4-byte boundary. Symmetric halves keep reasoning simple
 * — we don't have opcodes this slice with asymmetric payload sizes.
 *
 * Throws if the resulting region would be smaller than `MIN_REGION_BYTES` —
 * a host mis-sizing the buffer at construction is much easier to debug as a
 * constructor error than as a wedged worker on first dispatch.
 */
export function requestRegionByteLength(buffer: SharedArrayBuffer): number {
  const usable = buffer.byteLength - HEADER_BYTES;
  const half = Math.floor(usable / 2);
  const aligned = half - (half % 4);
  if (aligned < MIN_REGION_BYTES) {
    throw new Error(
      `bridge: per-region size (${aligned} bytes) below MIN_REGION_BYTES (${MIN_REGION_BYTES})`,
    );
  }
  return aligned;
}

/**
 * Create a bridge buffer with default region sizes. Hosts that need more
 * room per region can allocate their own `SharedArrayBuffer` of the right
 * size — the layout logic above only depends on the total byte length.
 *
 * Enforces a floor of `HEADER_BYTES + 2 * MIN_REGION_BYTES` so each region
 * is at least `MIN_REGION_BYTES` wide. Catch host misconfiguration here,
 * not at first opcode dispatch.
 */
export function createBridgeBuffer(
  totalBytes: number = DEFAULT_BRIDGE_BUFFER_BYTES,
): SharedArrayBuffer {
  const minTotal = HEADER_BYTES + 2 * MIN_REGION_BYTES;
  if (totalBytes < minTotal) {
    throw new Error(
      `bridge: buffer too small (${totalBytes} bytes; needs at least ${minTotal})`,
    );
  }
  return new SharedArrayBuffer(totalBytes);
}

// ─── Encoding ──────────────────────────────────────────────────────────────

/**
 * Encode a request into the request region. Returns the number of bytes
 * written (to be stored in ARG_LEN).
 *
 * Layout per opcode:
 *   [0]      RequestTag.ARGS
 *   [1..]    opcode-specific args
 *
 *   DEBUG       | u32 length | UTF-8 bytes
 *   STDIN_READ  | u32 maxByteLength
 *   CLOCK_NOW   | u32 clockId
 *   RANDOM_FILL | u32 byteLength
 *   TTY_GET     | (no args)
 *   TTY_SET     | TTYStateWire (4×u32 + 3×u8)
 */
export function encodeRequest(
  region: Uint8Array,
  request: BridgeRequest,
): number {
  region[0] = RequestTag.ARGS;
  const view = new DataView(
    region.buffer,
    region.byteOffset,
    region.byteLength,
  );
  switch (request.opcode) {
    case Opcode.DEBUG: {
      const written = writeUtf8(region, 5, request.args.message);
      view.setUint32(1, written, true);
      return 5 + written;
    }
    case Opcode.STDIN_READ: {
      // The wire is u32. Anything bigger than that is misuse — the bridge
      // can't honour the request, so fail loudly rather than silently
      // truncating to the low 32 bits.
      if (
        request.args.maxByteLength < 0 ||
        request.args.maxByteLength > 0xffffffff ||
        !Number.isFinite(request.args.maxByteLength)
      ) {
        throw new Error(
          `bridge: STDIN_READ maxByteLength out of u32 range (${request.args.maxByteLength})`,
        );
      }
      view.setUint32(1, request.args.maxByteLength, true);
      return 5;
    }
    case Opcode.CLOCK_NOW: {
      view.setUint32(1, request.args.clockId, true);
      return 5;
    }
    case Opcode.RANDOM_FILL: {
      if (
        request.args.byteLength < 0 ||
        request.args.byteLength > 0xffffffff ||
        !Number.isFinite(request.args.byteLength)
      ) {
        throw new Error(
          `bridge: RANDOM_FILL byteLength out of u32 range (${request.args.byteLength})`,
        );
      }
      view.setUint32(1, request.args.byteLength, true);
      return 5;
    }
    case Opcode.TTY_GET: {
      return 1;
    }
    case Opcode.TTY_SET: {
      return 1 + encodeTTYState(view, region, 1, request.args.state);
    }
    case Opcode.SOCK_OPEN: {
      view.setUint32(1, request.args.af, true);
      view.setUint32(5, request.args.type, true);
      view.setUint32(9, request.args.proto, true);
      return 13;
    }
    case Opcode.SOCK_BIND:
    case Opcode.SOCK_CONNECT: {
      view.setUint32(1, request.args.fd, true);
      const addrSize = encodeSockAddr(region, view, 5, request.args.addr);
      return 5 + addrSize;
    }
    case Opcode.SOCK_LISTEN: {
      view.setUint32(1, request.args.fd, true);
      view.setUint32(5, request.args.backlog, true);
      return 9;
    }
    case Opcode.SOCK_ACCEPT:
    case Opcode.SOCK_ADDR_LOCAL:
    case Opcode.SOCK_ADDR_PEER:
    case Opcode.SOCK_STATUS: {
      view.setUint32(1, request.args.fd, true);
      return 5;
    }
    case Opcode.SOCK_SEND: {
      view.setUint32(1, request.args.fd, true);
      view.setUint32(5, request.args.flags, true);
      view.setUint32(9, request.args.data.byteLength, true);
      if (13 + request.args.data.byteLength > region.byteLength) {
        throw new Error(
          `bridge: SOCK_SEND payload exceeds region (${request.args.data.byteLength} bytes, max ${region.byteLength - 13})`,
        );
      }
      region.set(request.args.data, 13);
      return 13 + request.args.data.byteLength;
    }
    case Opcode.SOCK_RECV: {
      view.setUint32(1, request.args.fd, true);
      view.setUint32(5, request.args.flags, true);
      view.setUint32(9, request.args.maxLen, true);
      return 13;
    }
    case Opcode.SOCK_SHUTDOWN: {
      view.setUint32(1, request.args.fd, true);
      view.setUint32(5, request.args.how, true);
      return 9;
    }
    case Opcode.SOCK_ADDR_RESOLVE: {
      view.setUint32(1, request.args.port, true);
      view.setUint32(5, request.args.maxAddrs, true);
      const written = writeUtf8(region, 13, request.args.host);
      view.setUint32(9, written, true);
      return 13 + written;
    }
    case Opcode.SOCK_GET_OPT: {
      view.setUint32(1, request.args.fd, true);
      view.setUint32(5, request.args.level, true);
      view.setUint32(9, request.args.name, true);
      region[13] = optKindTag(request.args.kind);
      return 14;
    }
    case Opcode.SOCK_SET_OPT: {
      view.setUint32(1, request.args.fd, true);
      view.setUint32(5, request.args.level, true);
      view.setUint32(9, request.args.name, true);
      region[13] = optKindTag(request.args.kind);
      if (request.args.kind === "flag") {
        region[14] = request.args.value ? 1 : 0;
        return 15;
      }
      if (request.args.kind === "size") {
        view.setUint32(14, request.args.value >>> 0, true);
        return 18;
      }
      // time
      region[14] = request.args.value === null ? 0 : 1;
      view.setBigInt64(22, request.args.value ?? 0n, true);
      return 30;
    }
  }
}

/**
 * Decode a request from the request region. `argLen` is the ARG_LEN word.
 * The `opcode` is read from the OPCODE header word by the caller.
 */
export function decodeRequest(
  opcode: Opcode,
  region: Uint8Array,
  argLen: number,
): BridgeRequest {
  if (argLen < 1 || region[0] !== RequestTag.ARGS) {
    throw new Error(`bridge: malformed request tag (opcode=${opcode})`);
  }
  const view = new DataView(
    region.buffer,
    region.byteOffset,
    region.byteLength,
  );
  switch (opcode) {
    case Opcode.DEBUG: {
      const length = view.getUint32(1, true);
      const message = readUtf8(region, 5, length);
      return { opcode, args: { message } };
    }
    case Opcode.STDIN_READ: {
      const maxByteLength = view.getUint32(1, true);
      return { opcode, args: { maxByteLength } };
    }
    case Opcode.CLOCK_NOW: {
      const clockId = view.getUint32(1, true);
      return { opcode, args: { clockId } };
    }
    case Opcode.RANDOM_FILL: {
      const byteLength = view.getUint32(1, true);
      return { opcode, args: { byteLength } };
    }
    case Opcode.TTY_GET: {
      return { opcode, args: {} };
    }
    case Opcode.TTY_SET: {
      const state = decodeTTYState(view, region, 1);
      return { opcode, args: { state } };
    }
    case Opcode.SOCK_OPEN: {
      const af = view.getUint32(1, true);
      const type = view.getUint32(5, true);
      const proto = view.getUint32(9, true);
      return { opcode, args: { af, type, proto } };
    }
    case Opcode.SOCK_BIND:
    case Opcode.SOCK_CONNECT: {
      const fd = view.getUint32(1, true);
      const { addr } = decodeSockAddr(region, view, 5);
      return { opcode, args: { fd, addr } };
    }
    case Opcode.SOCK_LISTEN: {
      const fd = view.getUint32(1, true);
      const backlog = view.getUint32(5, true);
      return { opcode, args: { fd, backlog } };
    }
    case Opcode.SOCK_ACCEPT:
    case Opcode.SOCK_ADDR_LOCAL:
    case Opcode.SOCK_ADDR_PEER:
    case Opcode.SOCK_STATUS: {
      const fd = view.getUint32(1, true);
      return { opcode, args: { fd } };
    }
    case Opcode.SOCK_SEND: {
      const fd = view.getUint32(1, true);
      const flags = view.getUint32(5, true);
      const len = view.getUint32(9, true);
      // Slice over the region — the host immediately consumes the bytes,
      // so a non-copying view is fine within `handleRequest`.
      const data = region.slice(13, 13 + len);
      return { opcode, args: { fd, flags, data } };
    }
    case Opcode.SOCK_RECV: {
      const fd = view.getUint32(1, true);
      const flags = view.getUint32(5, true);
      const maxLen = view.getUint32(9, true);
      return { opcode, args: { fd, flags, maxLen } };
    }
    case Opcode.SOCK_SHUTDOWN: {
      const fd = view.getUint32(1, true);
      const how = view.getUint32(5, true);
      return { opcode, args: { fd, how } };
    }
    case Opcode.SOCK_ADDR_RESOLVE: {
      const port = view.getUint32(1, true);
      const maxAddrs = view.getUint32(5, true);
      const hostLen = view.getUint32(9, true);
      const host = readUtf8(region, 13, hostLen);
      return { opcode, args: { host, port, maxAddrs } };
    }
    case Opcode.SOCK_GET_OPT: {
      const fd = view.getUint32(1, true);
      const level = view.getUint32(5, true);
      const name = view.getUint32(9, true);
      const kind = optKindFromTag(region[13]);
      return { opcode, args: { fd, level, name, kind } };
    }
    case Opcode.SOCK_SET_OPT: {
      const fd = view.getUint32(1, true);
      const level = view.getUint32(5, true);
      const name = view.getUint32(9, true);
      const kind = optKindFromTag(region[13]);
      if (kind === "flag") {
        return {
          opcode,
          args: { fd, level, name, kind, value: region[14] !== 0 },
        };
      }
      if (kind === "size") {
        return {
          opcode,
          args: { fd, level, name, kind, value: view.getUint32(14, true) },
        };
      }
      const hasValue = region[14] !== 0;
      const value = hasValue ? view.getBigInt64(22, true) : null;
      return { opcode, args: { fd, level, name, kind, value } };
    }
    default: {
      const neverCheck: never = opcode;
      throw new Error(`bridge: unknown opcode (${String(neverCheck)})`);
    }
  }
}

function optKindTag(kind: SockOptKind): number {
  if (kind === "flag") return 0;
  if (kind === "size") return 1;
  return 2;
}

function optKindFromTag(tag: number): SockOptKind {
  if (tag === 0) return "flag";
  if (tag === 1) return "size";
  if (tag === 2) return "time";
  throw new Error(`bridge: unknown sock-opt kind tag ${tag}`);
}

/**
 * Encode a successful response into the response region. Returns bytes
 * written.
 *
 *   DEBUG       | u32 length
 *   STDIN_READ  | u8 hasText (0 = null/EOF, 1 = string) | u32 length? | UTF-8?
 *   CLOCK_NOW   | u64 timeNs
 *   RANDOM_FILL | u32 byteLength | raw bytes
 *   TTY_GET     | TTYStateWire (4×u32 + 3×u8)
 *   TTY_SET     | u32 result
 */
export function encodeResponse(
  region: Uint8Array,
  response: BridgeResponse,
): number {
  region[0] = ResponseTag.OK;
  const view = new DataView(
    region.buffer,
    region.byteOffset,
    region.byteLength,
  );
  switch (response.opcode) {
    case Opcode.DEBUG: {
      view.setUint32(1, response.result.length, true);
      return 5;
    }
    case Opcode.STDIN_READ: {
      if (response.result.text === null) {
        region[1] = 0;
        return 2;
      }
      region[1] = 1;
      const written = writeUtf8(region, 6, response.result.text);
      view.setUint32(2, written, true);
      return 6 + written;
    }
    case Opcode.CLOCK_NOW: {
      view.setBigUint64(1, response.result.timeNs, true);
      return 9;
    }
    case Opcode.RANDOM_FILL: {
      const bytes = response.result.bytes;
      if (5 + bytes.byteLength > region.byteLength) {
        throw new Error(
          `bridge: RANDOM_FILL response exceeds region (${5 + bytes.byteLength} > ${region.byteLength})`,
        );
      }
      view.setUint32(1, bytes.byteLength, true);
      region.set(bytes, 5);
      return 5 + bytes.byteLength;
    }
    case Opcode.TTY_GET: {
      return 1 + encodeTTYState(view, region, 1, response.result.state);
    }
    case Opcode.TTY_SET: {
      view.setUint32(1, response.result.result, true);
      return 5;
    }
    case Opcode.SOCK_OPEN: {
      view.setUint32(1, response.result.fd, true);
      return 5;
    }
    case Opcode.SOCK_BIND:
    case Opcode.SOCK_CONNECT:
    case Opcode.SOCK_LISTEN:
    case Opcode.SOCK_SHUTDOWN:
    case Opcode.SOCK_SET_OPT: {
      view.setUint32(1, response.result.result, true);
      return 5;
    }
    case Opcode.SOCK_ACCEPT:
    case Opcode.SOCK_ADDR_LOCAL:
    case Opcode.SOCK_ADDR_PEER: {
      const addr =
        "fd" in response.result ? response.result.addr : response.result.addr;
      const fd = "fd" in response.result ? response.result.fd : 0;
      view.setUint32(1, fd, true);
      const size = encodeSockAddr(region, view, 5, addr);
      return 5 + size;
    }
    case Opcode.SOCK_SEND: {
      view.setUint32(1, response.result.written, true);
      return 5;
    }
    case Opcode.SOCK_RECV: {
      const data = response.result.data;
      view.setUint32(1, data.byteLength, true);
      view.setUint32(5, response.result.flags, true);
      if (9 + data.byteLength > region.byteLength) {
        throw new Error(
          `bridge: SOCK_RECV payload exceeds region (${data.byteLength} bytes, max ${region.byteLength - 9})`,
        );
      }
      region.set(data, 9);
      return 9 + data.byteLength;
    }
    case Opcode.SOCK_ADDR_RESOLVE: {
      const addrs = response.result.addrs;
      view.setUint32(1, addrs.length, true);
      let cursor = 5;
      for (const addr of addrs) {
        cursor += encodeSockAddr(region, view, cursor, addr);
      }
      return cursor;
    }
    case Opcode.SOCK_STATUS: {
      view.setUint32(1, response.result.status, true);
      return 5;
    }
    case Opcode.SOCK_GET_OPT: {
      const result = response.result;
      region[1] = optKindTag(result.kind);
      if (result.kind === "flag") {
        region[2] = result.value ? 1 : 0;
        return 3;
      }
      if (result.kind === "size") {
        view.setUint32(2, result.value >>> 0, true);
        return 6;
      }
      // time
      region[2] = result.value === null ? 0 : 1;
      view.setBigInt64(10, result.value ?? 0n, true);
      return 18;
    }
  }
}

/**
 * Encode a WASIXError response. Byte layout:
 *
 *   [0] ResponseTag.WASIX_ERROR
 *   [1..5] u32 Result value
 */
export function encodeWasixError(region: Uint8Array, result: Result): number {
  region[0] = ResponseTag.WASIX_ERROR;
  const view = new DataView(
    region.buffer,
    region.byteOffset,
    region.byteLength,
  );
  view.setUint32(1, result, true);
  return 5;
}

/**
 * Encode a generic-error response. Byte layout:
 *
 *   [0] ResponseTag.GENERIC_ERROR
 *   [1..5] u32 message length
 *   [5..]  UTF-8 message
 *
 * The message is silently truncated to fit the region. A long error message
 * is not worth wedging the worker over — the truncated prefix is still more
 * useful than a generic-error-encoding-failure that escapes the dispatcher's
 * catch and parks the worker in REQUEST_PENDING forever.
 */
export function encodeGenericError(
  region: Uint8Array,
  message: string,
): number {
  region[0] = ResponseTag.GENERIC_ERROR;
  const view = new DataView(
    region.buffer,
    region.byteOffset,
    region.byteLength,
  );
  const maxBytes = Math.max(0, region.byteLength - 5);
  let bytes = textEncoder.encode(message);
  if (bytes.byteLength > maxBytes) {
    bytes = bytes.subarray(0, maxBytes);
  }
  region.set(bytes, 5);
  view.setUint32(1, bytes.byteLength, true);
  return 5 + bytes.byteLength;
}

/**
 * Decode a response from the response region. Throws `WASIXError` on
 * `WASIX_ERROR`-tagged responses and a plain `Error` on `GENERIC_ERROR`. The
 * caller is responsible for consuming the STATE word — this function only
 * touches the payload.
 */
export function decodeResponse(
  opcode: Opcode,
  region: Uint8Array,
  respLen: number,
): BridgeResponse {
  if (respLen < 1) {
    throw new Error(`bridge: empty response (opcode=${opcode})`);
  }
  const tag = region[0];
  const view = new DataView(
    region.buffer,
    region.byteOffset,
    region.byteLength,
  );
  if (tag === ResponseTag.WASIX_ERROR) {
    const result = view.getUint32(1, true) as Result;
    throw new WASIXError(result);
  }
  if (tag === ResponseTag.GENERIC_ERROR) {
    const len = view.getUint32(1, true);
    const message = readUtf8(region, 5, len);
    throw new Error(message || "bridge: generic error");
  }
  if (tag !== ResponseTag.OK) {
    throw new Error(`bridge: unknown response tag (${tag})`);
  }
  switch (opcode) {
    case Opcode.DEBUG: {
      const length = view.getUint32(1, true);
      return { opcode, result: { length } };
    }
    case Opcode.STDIN_READ: {
      const hasText = region[1];
      if (hasText === 0) {
        return { opcode, result: { text: null } };
      }
      const length = view.getUint32(2, true);
      const text = readUtf8(region, 6, length);
      return { opcode, result: { text } };
    }
    case Opcode.CLOCK_NOW: {
      const timeNs = view.getBigUint64(1, true);
      return { opcode, result: { timeNs } };
    }
    case Opcode.RANDOM_FILL: {
      const byteLength = view.getUint32(1, true);
      // Copy out — the response region is shared with the next round trip,
      // so we don't hand the caller a view into a buffer about to be reused.
      const bytes = new Uint8Array(byteLength);
      bytes.set(region.subarray(5, 5 + byteLength));
      return { opcode, result: { bytes } };
    }
    case Opcode.TTY_GET: {
      const state = decodeTTYState(view, region, 1);
      return { opcode, result: { state } };
    }
    case Opcode.TTY_SET: {
      const result = view.getUint32(1, true) as Result;
      return { opcode, result: { result } };
    }
    case Opcode.SOCK_OPEN: {
      const fd = view.getUint32(1, true);
      return { opcode, result: { fd } };
    }
    case Opcode.SOCK_BIND:
    case Opcode.SOCK_CONNECT:
    case Opcode.SOCK_LISTEN:
    case Opcode.SOCK_SHUTDOWN:
    case Opcode.SOCK_SET_OPT: {
      const result = view.getUint32(1, true) as Result;
      return { opcode, result: { result } };
    }
    case Opcode.SOCK_ACCEPT: {
      const fd = view.getUint32(1, true);
      const { addr } = decodeSockAddr(region, view, 5);
      return { opcode, result: { fd, addr } };
    }
    case Opcode.SOCK_ADDR_LOCAL:
    case Opcode.SOCK_ADDR_PEER: {
      const { addr } = decodeSockAddr(region, view, 5);
      return { opcode, result: { addr } };
    }
    case Opcode.SOCK_SEND: {
      const written = view.getUint32(1, true);
      return { opcode, result: { written } };
    }
    case Opcode.SOCK_RECV: {
      const len = view.getUint32(1, true);
      const flags = view.getUint32(5, true);
      const data = region.slice(9, 9 + len);
      return { opcode, result: { data, flags } };
    }
    case Opcode.SOCK_ADDR_RESOLVE: {
      const count = view.getUint32(1, true);
      const addrs: SockAddr[] = [];
      let cursor = 5;
      for (let i = 0; i < count; i++) {
        const decoded = decodeSockAddr(region, view, cursor);
        addrs.push(decoded.addr);
        cursor += decoded.size;
      }
      return { opcode, result: { addrs } };
    }
    case Opcode.SOCK_STATUS: {
      const status = view.getUint32(1, true);
      return { opcode, result: { status } };
    }
    case Opcode.SOCK_GET_OPT: {
      const kind = optKindFromTag(region[1]);
      if (kind === "flag") {
        return { opcode, result: { kind, value: region[2] !== 0 } };
      }
      if (kind === "size") {
        return { opcode, result: { kind, value: view.getUint32(2, true) } };
      }
      const hasValue = region[2] !== 0;
      const value = hasValue ? view.getBigInt64(10, true) : null;
      return { opcode, result: { kind, value } };
    }
    default: {
      const neverCheck: never = opcode;
      throw new Error(`bridge: unknown opcode (${String(neverCheck)})`);
    }
  }
}

/**
 * TTYState wire format — 4 little-endian u32s (cols, rows, pixelWidth,
 * pixelHeight) followed by 3 u8 flags (echo, lineBuffered, raw). Returns
 * bytes written (always 19).
 */
function encodeTTYState(
  view: DataView,
  region: Uint8Array,
  offset: number,
  state: TTYStateWire,
): number {
  view.setUint32(offset, state.cols, true);
  view.setUint32(offset + 4, state.rows, true);
  view.setUint32(offset + 8, state.pixelWidth, true);
  view.setUint32(offset + 12, state.pixelHeight, true);
  region[offset + 16] = state.echo ? 1 : 0;
  region[offset + 17] = state.lineBuffered ? 1 : 0;
  region[offset + 18] = state.raw ? 1 : 0;
  return 19;
}

function decodeTTYState(
  view: DataView,
  region: Uint8Array,
  offset: number,
): TTYStateWire {
  return {
    cols: view.getUint32(offset, true),
    rows: view.getUint32(offset + 4, true),
    pixelWidth: view.getUint32(offset + 8, true),
    pixelHeight: view.getUint32(offset + 12, true),
    echo: region[offset + 16] !== 0,
    lineBuffered: region[offset + 17] !== 0,
    raw: region[offset + 18] !== 0,
  };
}

// ─── Sync / async call primitives ──────────────────────────────────────────

/**
 * Post a request from the worker side and block-wait for the response.
 *
 * Worker: writes opcode + payload, CAS STATE from IDLE → REQUEST_PENDING,
 * Atomics.notify, then Atomics.wait until STATE becomes RESPONSE_READY.
 *
 * This function MUST NOT be called from the main thread — Atomics.wait with
 * a nonzero timeout on the main thread is a hard error in several browsers
 * (deadlock risk). The main thread uses `Atomics.waitAsync` where available
 * (see `WASIXWorkerHost`).
 */
export function callBridgeSync(
  buffer: SharedArrayBuffer,
  request: BridgeRequest,
): BridgeResponse {
  const state = new Int32Array(buffer);
  const reqRegion = requestRegion(buffer);
  const respRegion = responseRegion(buffer);

  const argLen = encodeRequest(reqRegion, request);
  Atomics.store(state, OPCODE_INDEX, request.opcode);
  Atomics.store(state, ARG_LEN_INDEX, argLen);
  Atomics.store(state, RESP_LEN_INDEX, 0);
  Atomics.store(state, STATE_INDEX, STATE_REQUEST_PENDING);
  Atomics.notify(state, STATE_INDEX);

  // Wait for main thread to flip STATE to RESPONSE_READY.
  while (Atomics.load(state, STATE_INDEX) !== STATE_RESPONSE_READY) {
    Atomics.wait(state, STATE_INDEX, STATE_REQUEST_PENDING);
  }

  const respLen = Atomics.load(state, RESP_LEN_INDEX);
  try {
    return decodeResponse(request.opcode, respRegion, respLen);
  } finally {
    // Reset to idle so the next request finds a clean slate. We also zero
    // the OPCODE / ARG_LEN / RESP_LEN words: those are only meaningful when
    // STATE != IDLE, but a peer reading them during IDLE for debugging
    // (or a future opcode that reuses the header) should see a clean zero
    // rather than the previous request's residue.
    Atomics.store(state, OPCODE_INDEX, 0);
    Atomics.store(state, ARG_LEN_INDEX, 0);
    Atomics.store(state, RESP_LEN_INDEX, 0);
    Atomics.store(state, STATE_INDEX, STATE_IDLE);
    Atomics.notify(state, STATE_INDEX);
  }
}

/**
 * Result of `awaitBridgeRequest` — discriminated so the dispatcher can
 * distinguish a normal request from a decode failure (the worker wrote
 * garbage / an unknown opcode) without letting the throw escape its
 * try/catch and wedge the bridge in REQUEST_PENDING.
 *
 * `kind: "aborted"` is returned when the abort signal fires before a request
 * arrives. The dispatcher's loop reads it as "stop cleanly".
 */
export type AwaitedBridgeRequest =
  | { kind: "request"; request: BridgeRequest }
  | { kind: "decode-error"; opcode: number; message: string }
  | { kind: "aborted" };

/**
 * Main-thread side: wait until the worker posts a request (non-blocking — uses
 * `Atomics.waitAsync` when available, otherwise a microtask poll).
 *
 * The wait races the abort signal so `kill()` tear-down is deterministic — a
 * dispatcher promise that's parked inside `Atomics.waitAsync` returns within
 * one event-loop turn of `signal.abort()`, not at the next idle-poll
 * boundary.
 *
 * Decoding the request happens inside this function, so malformed payloads
 * or unknown opcodes surface as `{ kind: "decode-error" }` rather than
 * throwing through the dispatcher and leaving the state word stuck at
 * REQUEST_PENDING.
 */
export async function awaitBridgeRequest(
  buffer: SharedArrayBuffer,
  signal: AbortSignal,
): Promise<AwaitedBridgeRequest> {
  const state = new Int32Array(buffer);
  while (!signal.aborted) {
    const current = Atomics.load(state, STATE_INDEX);
    if (current === STATE_REQUEST_PENDING) {
      const opcode = Atomics.load(state, OPCODE_INDEX);
      const argLen = Atomics.load(state, ARG_LEN_INDEX);
      try {
        const request = decodeRequest(
          opcode as Opcode,
          requestRegion(buffer),
          argLen,
        );
        return { kind: "request", request };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { kind: "decode-error", opcode, message };
      }
    }
    await raceAbort(waitAsync(state, STATE_INDEX, current), signal);
  }
  return { kind: "aborted" };
}

/**
 * Await a state-word change using `Atomics.waitAsync` when available; fall
 * back to `setTimeout(0)` polling otherwise. Either way, the returned
 * Promise resolves to inform the caller the state MAY have changed — the
 * caller re-reads under `Atomics.load` to confirm.
 *
 * Defensive fallback: Chromium, Firefox (≥ 119), and Safari all ship
 * `Atomics.waitAsync` natively, so this fallback is dead in the browsers
 * Slice 4's test suite runs against. It exists for embedders (older worker
 * shells, bundled runtimes) that expose `Atomics` without `waitAsync`.
 * Such embedders typically also lack `SharedArrayBuffer` (because COOP/COEP
 * gates both), so the fallback path should be unreachable in practice — but
 * keeping it costs nothing and makes the bridge robust to one fewer
 * environmental variable.
 *
 * The `Atomics.waitAsync` timeout is left at `Infinity` (omitted): the
 * worker side always `Atomics.notify`s after every state-word write, so
 * there is no need for the dispatcher to wake periodically just to re-read
 * the state. `kill()` interrupts the wait via `signal` (see
 * `awaitBridgeRequest`'s `raceAbort`).
 */
function waitAsync(
  state: Int32Array,
  index: number,
  expected: number,
): Promise<void> {
  const anyAtomics = Atomics as unknown as {
    waitAsync?: (
      typedArray: Int32Array,
      index: number,
      value: number,
      timeout?: number,
    ) =>
      | { async: true; value: Promise<"ok" | "timed-out"> }
      | {
          async: false;
          value: "not-equal" | "timed-out" | "ok";
        };
  };
  if (typeof anyAtomics.waitAsync === "function") {
    const res = anyAtomics.waitAsync(state, index, expected);
    if (res.async) {
      return res.value.then(() => undefined);
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Race a promise against an `AbortSignal`. If the signal fires first, the
 * returned promise resolves immediately so the caller's loop can re-check
 * `signal.aborted` and exit cleanly. The original promise is left to
 * resolve (or reject) on its own — it is not cancelled, but the caller no
 * longer awaits it.
 */
function raceAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    promise.then(finish, finish);
  });
}

/**
 * Main-thread: commit a successful response and wake the worker.
 */
export function writeBridgeResponse(
  buffer: SharedArrayBuffer,
  response: BridgeResponse,
): void {
  const state = new Int32Array(buffer);
  const region = responseRegion(buffer);
  const respLen = encodeResponse(region, response);
  Atomics.store(state, RESP_LEN_INDEX, respLen);
  Atomics.store(state, STATE_INDEX, STATE_RESPONSE_READY);
  Atomics.notify(state, STATE_INDEX);
}

/** Main-thread: commit a WASIXError response and wake the worker. */
export function writeBridgeWasixError(
  buffer: SharedArrayBuffer,
  result: Result,
): void {
  const state = new Int32Array(buffer);
  const region = responseRegion(buffer);
  const respLen = encodeWasixError(region, result);
  Atomics.store(state, RESP_LEN_INDEX, respLen);
  Atomics.store(state, STATE_INDEX, STATE_RESPONSE_READY);
  Atomics.notify(state, STATE_INDEX);
}

/** Main-thread: commit a generic-error response and wake the worker. */
export function writeBridgeGenericError(
  buffer: SharedArrayBuffer,
  message: string,
): void {
  const state = new Int32Array(buffer);
  const region = responseRegion(buffer);
  const respLen = encodeGenericError(region, message);
  Atomics.store(state, RESP_LEN_INDEX, respLen);
  Atomics.store(state, STATE_INDEX, STATE_RESPONSE_READY);
  Atomics.notify(state, STATE_INDEX);
}
