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

import { FileType, Result, WASIXError } from "../wasix-32v1.js";
import type { DirEntry, Fdstat, Filestat, PreopenInfo } from "../providers.js";

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
export enum Opcode {
  DEBUG = 1,
  STDIN_READ = 2,
  CLOCK_NOW = 3,
  RANDOM_FILL = 4,
  TTY_GET = 5,
  TTY_SET = 6,

  // Filesystem opcodes — one per `FileSystemProvider` method. The worker
  // shim exposes each as a sync method (`FileSystemProvider`), translating
  // each call into one bridge round trip so the host's
  // `AsyncFileSystemProvider` can resolve a Promise return on the main
  // thread before the worker continues.
  FS_FD_READ = 7,
  FS_FD_WRITE = 8,
  FS_FD_SEEK = 9,
  FS_FD_CLOSE = 10,
  FS_FD_FDSTAT_GET = 11,
  FS_FD_FDSTAT_SET_FLAGS = 12,
  FS_FD_FILESTAT_GET = 13,
  FS_FD_PRESTAT_GET = 14,
  FS_FD_PRESTAT_DIR_NAME = 15,
  FS_FD_READDIR = 16,
  FS_PATH_OPEN = 17,
  FS_PATH_FILESTAT_GET = 18,
  FS_PATH_CREATE_DIRECTORY = 19,
  FS_PATH_UNLINK_FILE = 20,
  FS_PATH_REMOVE_DIRECTORY = 21,
  FS_PATH_RENAME = 22,
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

/**
 * Length-prefixed UTF-8 string write: `u32 length | <bytes>`. Returns the
 * total bytes written (4 + length).
 */
function writeLpString(
  dst: Uint8Array,
  view: DataView,
  offset: number,
  value: string,
): number {
  const written = writeUtf8(dst, offset + 4, value);
  view.setUint32(offset, written, true);
  return 4 + written;
}

/**
 * Length-prefixed UTF-8 string read. Returns `[value, bytesConsumed]`.
 */
function readLpString(
  src: Uint8Array,
  view: DataView,
  offset: number,
): [string, number] {
  const length = view.getUint32(offset, true);
  return [readUtf8(src, offset + 4, length), 4 + length];
}

/** Write a `Uint8Array` blob with a u32 length prefix. */
function writeLpBytes(
  dst: Uint8Array,
  view: DataView,
  offset: number,
  value: Uint8Array,
): number {
  if (offset + 4 + value.byteLength > dst.byteLength) {
    throw new Error(
      `bridge: payload exceeds region (${offset + 4 + value.byteLength} > ${dst.byteLength})`,
    );
  }
  view.setUint32(offset, value.byteLength, true);
  dst.set(value, offset + 4);
  return 4 + value.byteLength;
}

/** Read a length-prefixed blob. Returns `[bytes, bytesConsumed]`. The
 *  returned `Uint8Array` is a copy so the caller may keep it past the next
 *  bridge round trip. */
function readLpBytes(
  src: Uint8Array,
  view: DataView,
  offset: number,
): [Uint8Array, number] {
  const length = view.getUint32(offset, true);
  const bytes = new Uint8Array(length);
  bytes.set(src.subarray(offset + 4, offset + 4 + length));
  return [bytes, 4 + length];
}

/**
 * Fdstat is a flat 24-byte LE record:
 *   u8  filetype | 1 byte pad to 2
 *   u16 fsFlags  | 4 bytes pad to 8
 *   u64 fsRightsBase
 *   u64 fsRightsInheriting
 */
const FDSTAT_BYTES = 24;
function writeFdstat(view: DataView, offset: number, stat: Fdstat): number {
  view.setUint8(offset, stat.filetype);
  view.setUint16(offset + 2, stat.fsFlags, true);
  view.setBigUint64(offset + 8, stat.fsRightsBase, true);
  view.setBigUint64(offset + 16, stat.fsRightsInheriting, true);
  return FDSTAT_BYTES;
}
function readFdstat(view: DataView, offset: number): Fdstat {
  return {
    filetype: view.getUint8(offset) as FileType,
    fsFlags: view.getUint16(offset + 2, true),
    fsRightsBase: view.getBigUint64(offset + 8, true),
    fsRightsInheriting: view.getBigUint64(offset + 16, true),
  };
}

/**
 * Filestat is a flat 64-byte LE record:
 *   u64 dev | u64 ino | u8 filetype | 7 bytes pad | u64 nlink | u64 size
 *   u64 atim | u64 mtim | u64 ctim
 */
const FILESTAT_BYTES = 64;
function writeFilestat(view: DataView, offset: number, stat: Filestat): number {
  view.setBigUint64(offset + 0, stat.dev, true);
  view.setBigUint64(offset + 8, stat.ino, true);
  view.setUint8(offset + 16, stat.filetype);
  view.setBigUint64(offset + 24, stat.nlink, true);
  view.setBigUint64(offset + 32, stat.size, true);
  view.setBigUint64(offset + 40, stat.timestamps.access, true);
  view.setBigUint64(offset + 48, stat.timestamps.modification, true);
  view.setBigUint64(offset + 56, stat.timestamps.change, true);
  return FILESTAT_BYTES;
}
function readFilestat(view: DataView, offset: number): Filestat {
  return {
    dev: view.getBigUint64(offset + 0, true),
    ino: view.getBigUint64(offset + 8, true),
    filetype: view.getUint8(offset + 16) as FileType,
    nlink: view.getBigUint64(offset + 24, true),
    size: view.getBigUint64(offset + 32, true),
    timestamps: {
      access: view.getBigUint64(offset + 40, true),
      modification: view.getBigUint64(offset + 48, true),
      change: view.getBigUint64(offset + 56, true),
    },
  };
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

// ─── Filesystem request / response shapes ──────────────────────────────────
//
// The bridge encoding is host↔worker only — it doesn't need to match the
// guest preview1 ABI. Shapes mirror `FileSystemProvider` signatures verbatim,
// with one wrinkle for the buffer-list reads/writes: guest-side `Uint8Array`
// buffers don't survive a SAB round trip individually, so the worker shim
// concatenates writes and splits reads back out from a single payload.

export type FsFdReadRequest = { fd: number; sizes: number[] };
export type FsFdReadResponse = { bytes: Uint8Array };

export type FsFdWriteRequest = { fd: number; bytes: Uint8Array };
export type FsFdWriteResponse = { written: number };

export type FsFdSeekRequest = { fd: number; offset: bigint; whence: number };
export type FsFdSeekResponse = { position: bigint };

export type FsFdCloseRequest = { fd: number };
export type FsVoidResponse = Record<string, never>;

export type FsFdFdstatGetRequest = { fd: number };
export type FsFdFdstatGetResponse = { fdstat: Fdstat };

export type FsFdFdstatSetFlagsRequest = { fd: number; flags: number };

export type FsFdFilestatGetRequest = { fd: number };
export type FsFdFilestatGetResponse = { filestat: Filestat };

export type FsFdPrestatGetRequest = { fd: number };
export type FsFdPrestatGetResponse = { prestat: PreopenInfo | null };

export type FsFdPrestatDirNameRequest = { fd: number };
export type FsFdPrestatDirNameResponse = { name: string };

export type FsFdReaddirRequest = { fd: number; cookie: bigint };
export type FsFdReaddirResponse = { entries: DirEntry[] };

export type FsPathOpenRequest = {
  fdDir: number;
  dirflags: number;
  path: string;
  oflags: number;
  rightsBase: bigint;
  rightsInheriting: bigint;
  fdflags: number;
};
export type FsPathOpenResponse = { fd: number };

export type FsPathFilestatGetRequest = {
  fdDir: number;
  dirflags: number;
  path: string;
};
export type FsPathFilestatGetResponse = { filestat: Filestat };

export type FsPathCreateDirectoryRequest = { fdDir: number; path: string };
export type FsPathUnlinkFileRequest = { fdDir: number; path: string };
export type FsPathRemoveDirectoryRequest = { fdDir: number; path: string };

export type FsPathRenameRequest = {
  fdDir: number;
  oldPath: string;
  fdNewDir: number;
  newPath: string;
};


export type BridgeRequest =
  | { opcode: Opcode.DEBUG; args: DebugRequest }
  | { opcode: Opcode.STDIN_READ; args: StdinReadRequest }
  | { opcode: Opcode.CLOCK_NOW; args: ClockNowRequest }
  | { opcode: Opcode.RANDOM_FILL; args: RandomFillRequest }
  | { opcode: Opcode.TTY_GET; args: TTYGetRequest }
  | { opcode: Opcode.TTY_SET; args: TTYSetRequest }
  | { opcode: Opcode.FS_FD_READ; args: FsFdReadRequest }
  | { opcode: Opcode.FS_FD_WRITE; args: FsFdWriteRequest }
  | { opcode: Opcode.FS_FD_SEEK; args: FsFdSeekRequest }
  | { opcode: Opcode.FS_FD_CLOSE; args: FsFdCloseRequest }
  | { opcode: Opcode.FS_FD_FDSTAT_GET; args: FsFdFdstatGetRequest }
  | { opcode: Opcode.FS_FD_FDSTAT_SET_FLAGS; args: FsFdFdstatSetFlagsRequest }
  | { opcode: Opcode.FS_FD_FILESTAT_GET; args: FsFdFilestatGetRequest }
  | { opcode: Opcode.FS_FD_PRESTAT_GET; args: FsFdPrestatGetRequest }
  | { opcode: Opcode.FS_FD_PRESTAT_DIR_NAME; args: FsFdPrestatDirNameRequest }
  | { opcode: Opcode.FS_FD_READDIR; args: FsFdReaddirRequest }
  | { opcode: Opcode.FS_PATH_OPEN; args: FsPathOpenRequest }
  | { opcode: Opcode.FS_PATH_FILESTAT_GET; args: FsPathFilestatGetRequest }
  | {
      opcode: Opcode.FS_PATH_CREATE_DIRECTORY;
      args: FsPathCreateDirectoryRequest;
    }
  | { opcode: Opcode.FS_PATH_UNLINK_FILE; args: FsPathUnlinkFileRequest }
  | {
      opcode: Opcode.FS_PATH_REMOVE_DIRECTORY;
      args: FsPathRemoveDirectoryRequest;
    }
  | { opcode: Opcode.FS_PATH_RENAME; args: FsPathRenameRequest };

export type BridgeResponse =
  | { opcode: Opcode.DEBUG; result: DebugResponse }
  | { opcode: Opcode.STDIN_READ; result: StdinReadResponse }
  | { opcode: Opcode.CLOCK_NOW; result: ClockNowResponse }
  | { opcode: Opcode.RANDOM_FILL; result: RandomFillResponse }
  | { opcode: Opcode.TTY_GET; result: TTYGetResponse }
  | { opcode: Opcode.TTY_SET; result: TTYSetResponse }
  | { opcode: Opcode.FS_FD_READ; result: FsFdReadResponse }
  | { opcode: Opcode.FS_FD_WRITE; result: FsFdWriteResponse }
  | { opcode: Opcode.FS_FD_SEEK; result: FsFdSeekResponse }
  | { opcode: Opcode.FS_FD_CLOSE; result: FsVoidResponse }
  | { opcode: Opcode.FS_FD_FDSTAT_GET; result: FsFdFdstatGetResponse }
  | { opcode: Opcode.FS_FD_FDSTAT_SET_FLAGS; result: FsVoidResponse }
  | { opcode: Opcode.FS_FD_FILESTAT_GET; result: FsFdFilestatGetResponse }
  | { opcode: Opcode.FS_FD_PRESTAT_GET; result: FsFdPrestatGetResponse }
  | {
      opcode: Opcode.FS_FD_PRESTAT_DIR_NAME;
      result: FsFdPrestatDirNameResponse;
    }
  | { opcode: Opcode.FS_FD_READDIR; result: FsFdReaddirResponse }
  | { opcode: Opcode.FS_PATH_OPEN; result: FsPathOpenResponse }
  | { opcode: Opcode.FS_PATH_FILESTAT_GET; result: FsPathFilestatGetResponse }
  | { opcode: Opcode.FS_PATH_CREATE_DIRECTORY; result: FsVoidResponse }
  | { opcode: Opcode.FS_PATH_UNLINK_FILE; result: FsVoidResponse }
  | { opcode: Opcode.FS_PATH_REMOVE_DIRECTORY; result: FsVoidResponse }
  | { opcode: Opcode.FS_PATH_RENAME; result: FsVoidResponse };

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
    case Opcode.FS_FD_READ: {
      const { fd, sizes } = request.args;
      view.setUint32(1, fd, true);
      view.setUint32(5, sizes.length, true);
      let cursor = 9;
      for (const size of sizes) {
        view.setUint32(cursor, size, true);
        cursor += 4;
      }
      return cursor;
    }
    case Opcode.FS_FD_WRITE: {
      view.setUint32(1, request.args.fd, true);
      const consumed = writeLpBytes(region, view, 5, request.args.bytes);
      return 5 + consumed;
    }
    case Opcode.FS_FD_SEEK: {
      view.setUint32(1, request.args.fd, true);
      view.setBigInt64(5, request.args.offset, true);
      view.setUint32(13, request.args.whence, true);
      return 17;
    }
    case Opcode.FS_FD_CLOSE:
    case Opcode.FS_FD_FDSTAT_GET:
    case Opcode.FS_FD_FILESTAT_GET:
    case Opcode.FS_FD_PRESTAT_GET:
    case Opcode.FS_FD_PRESTAT_DIR_NAME: {
      view.setUint32(1, request.args.fd, true);
      return 5;
    }
    case Opcode.FS_FD_FDSTAT_SET_FLAGS: {
      view.setUint32(1, request.args.fd, true);
      view.setUint32(5, request.args.flags, true);
      return 9;
    }
    case Opcode.FS_FD_READDIR: {
      view.setUint32(1, request.args.fd, true);
      view.setBigUint64(5, request.args.cookie, true);
      return 13;
    }
    case Opcode.FS_PATH_OPEN: {
      view.setUint32(1, request.args.fdDir, true);
      view.setUint32(5, request.args.dirflags, true);
      view.setUint32(9, request.args.oflags, true);
      view.setBigUint64(13, request.args.rightsBase, true);
      view.setBigUint64(21, request.args.rightsInheriting, true);
      view.setUint32(29, request.args.fdflags, true);
      const consumed = writeLpString(region, view, 33, request.args.path);
      return 33 + consumed;
    }
    case Opcode.FS_PATH_FILESTAT_GET: {
      view.setUint32(1, request.args.fdDir, true);
      view.setUint32(5, request.args.dirflags, true);
      const consumed = writeLpString(region, view, 9, request.args.path);
      return 9 + consumed;
    }
    case Opcode.FS_PATH_CREATE_DIRECTORY:
    case Opcode.FS_PATH_UNLINK_FILE:
    case Opcode.FS_PATH_REMOVE_DIRECTORY: {
      view.setUint32(1, request.args.fdDir, true);
      const consumed = writeLpString(region, view, 5, request.args.path);
      return 5 + consumed;
    }
    case Opcode.FS_PATH_RENAME: {
      view.setUint32(1, request.args.fdDir, true);
      view.setUint32(5, request.args.fdNewDir, true);
      const oldConsumed = writeLpString(region, view, 9, request.args.oldPath);
      const newConsumed = writeLpString(
        region,
        view,
        9 + oldConsumed,
        request.args.newPath,
      );
      return 9 + oldConsumed + newConsumed;
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
    case Opcode.FS_FD_READ: {
      const fd = view.getUint32(1, true);
      const count = view.getUint32(5, true);
      const sizes: number[] = [];
      for (let i = 0; i < count; i++) {
        sizes.push(view.getUint32(9 + i * 4, true));
      }
      return { opcode, args: { fd, sizes } };
    }
    case Opcode.FS_FD_WRITE: {
      const fd = view.getUint32(1, true);
      const [bytes] = readLpBytes(region, view, 5);
      return { opcode, args: { fd, bytes } };
    }
    case Opcode.FS_FD_SEEK: {
      const fd = view.getUint32(1, true);
      const offset = view.getBigInt64(5, true);
      const whence = view.getUint32(13, true);
      return { opcode, args: { fd, offset, whence } };
    }
    case Opcode.FS_FD_CLOSE:
    case Opcode.FS_FD_FDSTAT_GET:
    case Opcode.FS_FD_FILESTAT_GET:
    case Opcode.FS_FD_PRESTAT_GET:
    case Opcode.FS_FD_PRESTAT_DIR_NAME: {
      const fd = view.getUint32(1, true);
      return { opcode, args: { fd } };
    }
    case Opcode.FS_FD_FDSTAT_SET_FLAGS: {
      const fd = view.getUint32(1, true);
      const flags = view.getUint32(5, true);
      return { opcode, args: { fd, flags } };
    }
    case Opcode.FS_FD_READDIR: {
      const fd = view.getUint32(1, true);
      const cookie = view.getBigUint64(5, true);
      return { opcode, args: { fd, cookie } };
    }
    case Opcode.FS_PATH_OPEN: {
      const fdDir = view.getUint32(1, true);
      const dirflags = view.getUint32(5, true);
      const oflags = view.getUint32(9, true);
      const rightsBase = view.getBigUint64(13, true);
      const rightsInheriting = view.getBigUint64(21, true);
      const fdflags = view.getUint32(29, true);
      const [path] = readLpString(region, view, 33);
      return {
        opcode,
        args: {
          fdDir,
          dirflags,
          path,
          oflags,
          rightsBase,
          rightsInheriting,
          fdflags,
        },
      };
    }
    case Opcode.FS_PATH_FILESTAT_GET: {
      const fdDir = view.getUint32(1, true);
      const dirflags = view.getUint32(5, true);
      const [path] = readLpString(region, view, 9);
      return { opcode, args: { fdDir, dirflags, path } };
    }
    case Opcode.FS_PATH_CREATE_DIRECTORY:
    case Opcode.FS_PATH_UNLINK_FILE:
    case Opcode.FS_PATH_REMOVE_DIRECTORY: {
      const fdDir = view.getUint32(1, true);
      const [path] = readLpString(region, view, 5);
      return { opcode, args: { fdDir, path } };
    }
    case Opcode.FS_PATH_RENAME: {
      const fdDir = view.getUint32(1, true);
      const fdNewDir = view.getUint32(5, true);
      const [oldPath, oldConsumed] = readLpString(region, view, 9);
      const [newPath] = readLpString(region, view, 9 + oldConsumed);
      return { opcode, args: { fdDir, oldPath, fdNewDir, newPath } };
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
    case Opcode.FS_FD_READ: {
      const consumed = writeLpBytes(region, view, 1, response.result.bytes);
      return 1 + consumed;
    }
    case Opcode.FS_FD_WRITE: {
      view.setUint32(1, response.result.written, true);
      return 5;
    }
    case Opcode.FS_FD_SEEK: {
      view.setBigInt64(1, response.result.position, true);
      return 9;
    }
    case Opcode.FS_FD_CLOSE:
    case Opcode.FS_FD_FDSTAT_SET_FLAGS:
    case Opcode.FS_PATH_CREATE_DIRECTORY:
    case Opcode.FS_PATH_UNLINK_FILE:
    case Opcode.FS_PATH_REMOVE_DIRECTORY:
    case Opcode.FS_PATH_RENAME: {
      return 1;
    }
    case Opcode.FS_FD_FDSTAT_GET: {
      writeFdstat(view, 1, response.result.fdstat);
      return 1 + FDSTAT_BYTES;
    }
    case Opcode.FS_FD_FILESTAT_GET:
    case Opcode.FS_PATH_FILESTAT_GET: {
      writeFilestat(view, 1, response.result.filestat);
      return 1 + FILESTAT_BYTES;
    }
    case Opcode.FS_FD_PRESTAT_GET: {
      if (response.result.prestat === null) {
        region[1] = 0;
        return 2;
      }
      region[1] = 1;
      const consumed = writeLpString(
        region,
        view,
        2,
        response.result.prestat.name,
      );
      return 2 + consumed;
    }
    case Opcode.FS_FD_PRESTAT_DIR_NAME: {
      const consumed = writeLpString(region, view, 1, response.result.name);
      return 1 + consumed;
    }
    case Opcode.FS_FD_READDIR: {
      view.setUint32(1, response.result.entries.length, true);
      let cursor = 5;
      for (const entry of response.result.entries) {
        view.setBigUint64(cursor, entry.next, true);
        view.setBigUint64(cursor + 8, entry.ino, true);
        view.setUint8(cursor + 16, entry.filetype);
        cursor += 17;
        cursor += writeLpString(region, view, cursor, entry.name);
      }
      return cursor;
    }
    case Opcode.FS_PATH_OPEN: {
      view.setUint32(1, response.result.fd, true);
      return 5;
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
    case Opcode.FS_FD_READ: {
      const [bytes] = readLpBytes(region, view, 1);
      return { opcode, result: { bytes } };
    }
    case Opcode.FS_FD_WRITE: {
      const written = view.getUint32(1, true);
      return { opcode, result: { written } };
    }
    case Opcode.FS_FD_SEEK: {
      const position = view.getBigInt64(1, true);
      return { opcode, result: { position } };
    }
    case Opcode.FS_FD_CLOSE:
    case Opcode.FS_FD_FDSTAT_SET_FLAGS:
    case Opcode.FS_PATH_CREATE_DIRECTORY:
    case Opcode.FS_PATH_UNLINK_FILE:
    case Opcode.FS_PATH_REMOVE_DIRECTORY:
    case Opcode.FS_PATH_RENAME: {
      return { opcode, result: {} };
    }
    case Opcode.FS_FD_FDSTAT_GET: {
      const fdstat = readFdstat(view, 1);
      return { opcode, result: { fdstat } };
    }
    case Opcode.FS_FD_FILESTAT_GET:
    case Opcode.FS_PATH_FILESTAT_GET: {
      const filestat = readFilestat(view, 1);
      return { opcode, result: { filestat } };
    }
    case Opcode.FS_FD_PRESTAT_GET: {
      const hasPrestat = region[1];
      if (hasPrestat === 0) {
        return { opcode, result: { prestat: null } };
      }
      const [name] = readLpString(region, view, 2);
      return { opcode, result: { prestat: { name } } };
    }
    case Opcode.FS_FD_PRESTAT_DIR_NAME: {
      const [name] = readLpString(region, view, 1);
      return { opcode, result: { name } };
    }
    case Opcode.FS_FD_READDIR: {
      const count = view.getUint32(1, true);
      const entries: DirEntry[] = [];
      let cursor = 5;
      for (let i = 0; i < count; i++) {
        const next = view.getBigUint64(cursor, true);
        const ino = view.getBigUint64(cursor + 8, true);
        const filetype = view.getUint8(cursor + 16) as FileType;
        cursor += 17;
        const [name, consumed] = readLpString(region, view, cursor);
        cursor += consumed;
        entries.push({ next, ino, filetype, name });
      }
      return { opcode, result: { entries } };
    }
    case Opcode.FS_PATH_OPEN: {
      const fd = view.getUint32(1, true);
      return { opcode, result: { fd } };
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
