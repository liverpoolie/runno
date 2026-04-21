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

/** Default region sizes — 64 KiB each is plenty for every opcode landed
 *  this slice (debug strings + stdin chunks). Later slices that need bigger
 *  payloads can bump this without a protocol break. */
export const DEFAULT_REQUEST_REGION_BYTES = 64 * 1024;
export const DEFAULT_RESPONSE_REGION_BYTES = 64 * 1024;

/** Total buffer size for the default layout. */
export const DEFAULT_BRIDGE_BUFFER_BYTES =
  HEADER_BYTES + DEFAULT_REQUEST_REGION_BYTES + DEFAULT_RESPONSE_REGION_BYTES;

// ─── Opcode registry ───────────────────────────────────────────────────────

/**
 * Opcodes enumerated here are the minimal set needed to exercise the bridge
 * this slice. Adding an opcode is cheap — append a new enum member, bump the
 * encoder/decoder tables in `bridge-codec.ts`, and plumb it through the
 * worker-side sync shim. DO NOT register opcodes for syscalls that don't
 * exist yet.
 *
 * - `DEBUG` — smoke-test round trip. Guest sends a UTF-8 string, main thread
 *   echoes its length back. Used by the targeted bridge unit spec.
 * - `STDIN_READ` — replaces the bespoke stdin-SAB pattern. Host provides
 *   stdin via its existing `(maxByteLength) => string | null` callback; the
 *   main-thread dispatcher awaits whatever that callback returns.
 * - `CLOCK_NOW` — async-capable `ClockProvider.now(clockId) -> bigint`. The
 *   targeted unit spec uses this to prove the async → sync round trip works
 *   end-to-end with a real Promise-returning provider on the main thread.
 */
export enum Opcode {
  DEBUG = 1,
  STDIN_READ = 2,
  CLOCK_NOW = 3,
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
  return textDecoder.decode(src.subarray(offset, offset + length));
}

// ─── Per-opcode request / response shapes ──────────────────────────────────

export type DebugRequest = { message: string };
export type DebugResponse = { length: number };

export type StdinReadRequest = { maxByteLength: number };
/** `text === null` signals EOF (stdin callback returned null). */
export type StdinReadResponse = { text: string | null };

export type ClockNowRequest = { clockId: number };
export type ClockNowResponse = { timeNs: bigint };

export type BridgeRequest =
  | { opcode: Opcode.DEBUG; args: DebugRequest }
  | { opcode: Opcode.STDIN_READ; args: StdinReadRequest }
  | { opcode: Opcode.CLOCK_NOW; args: ClockNowRequest };

export type BridgeResponse =
  | { opcode: Opcode.DEBUG; result: DebugResponse }
  | { opcode: Opcode.STDIN_READ; result: StdinReadResponse }
  | { opcode: Opcode.CLOCK_NOW; result: ClockNowResponse };

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
 */
export function requestRegionByteLength(buffer: SharedArrayBuffer): number {
  const usable = buffer.byteLength - HEADER_BYTES;
  const half = Math.floor(usable / 2);
  return half - (half % 4);
}

/**
 * Create a bridge buffer with default region sizes. Hosts that need more
 * room per region can allocate their own `SharedArrayBuffer` of the right
 * size — the layout logic above only depends on the total byte length.
 */
export function createBridgeBuffer(
  totalBytes: number = DEFAULT_BRIDGE_BUFFER_BYTES,
): SharedArrayBuffer {
  if (totalBytes < HEADER_BYTES + 16) {
    throw new Error(`bridge: buffer too small (${totalBytes} bytes)`);
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
 *   DEBUG      | u32 length | UTF-8 bytes
 *   STDIN_READ | u32 maxByteLength
 *   CLOCK_NOW  | u32 clockId
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
      view.setUint32(1, request.args.maxByteLength, true);
      return 5;
    }
    case Opcode.CLOCK_NOW: {
      view.setUint32(1, request.args.clockId, true);
      return 5;
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
    default: {
      const neverCheck: never = opcode;
      throw new Error(`bridge: unknown opcode (${String(neverCheck)})`);
    }
  }
}

/**
 * Encode a successful response into the response region. Returns bytes
 * written.
 *
 *   DEBUG      | u32 length
 *   STDIN_READ | u8 hasText (0 = null/EOF, 1 = string) | u32 length? | UTF-8?
 *   CLOCK_NOW  | u64 timeNs
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
  const written = writeUtf8(region, 5, message);
  view.setUint32(1, written, true);
  return 5 + written;
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
    default: {
      const neverCheck: never = opcode;
      throw new Error(`bridge: unknown opcode (${String(neverCheck)})`);
    }
  }
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
    // Reset to idle so the next request finds a clean slate.
    Atomics.store(state, STATE_INDEX, STATE_IDLE);
    Atomics.notify(state, STATE_INDEX);
  }
}

/**
 * Main-thread side: wait until the worker posts a request (non-blocking — uses
 * `Atomics.waitAsync` when available, otherwise a microtask poll).
 *
 * The wait races the abort signal so `kill()` tear-down is deterministic — a
 * dispatcher promise that's parked inside `Atomics.waitAsync` returns within
 * one event-loop turn of `signal.abort()`, not at the next idle-poll
 * boundary.
 *
 * Returns the decoded request. The caller is responsible for dispatching to
 * its provider, then calling `writeBridgeResponse` / `writeBridgeWasixError`
 * / `writeBridgeGenericError` and notifying.
 */
export async function awaitBridgeRequest(
  buffer: SharedArrayBuffer,
  signal: AbortSignal,
): Promise<BridgeRequest | null> {
  const state = new Int32Array(buffer);
  while (!signal.aborted) {
    const current = Atomics.load(state, STATE_INDEX);
    if (current === STATE_REQUEST_PENDING) {
      const opcode = Atomics.load(state, OPCODE_INDEX) as Opcode;
      const argLen = Atomics.load(state, ARG_LEN_INDEX);
      return decodeRequest(opcode, requestRegion(buffer), argLen);
    }
    await raceAbort(waitAsync(state, STATE_INDEX, current), signal);
  }
  return null;
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
