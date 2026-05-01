// In-memory pipes for the in-process proc simulation.
//
// A `PipeRingBuffer` is a SPSC ring backing a parent/child fd pair. Each
// end is exposed as a `PipeReadEnd` / `PipeWriteEnd` that satisfies the
// fd-table-descriptor surface the WASIX runtime calls into for
// `fd_read` / `fd_write` / `fd_close` / `fd_fdstat_get` / `fd_seek`.
//
// ─── Behaviour ──────────────────────────────────────────────────────────────
//
// Synchronous, non-blocking. Exhaustion semantics:
//
// - `fdRead` on an empty pipe with the writer still open throws
//   `EAGAIN`. wasmer tests that genuinely depend on **blocking** pipe
//   reads need the cooperative scheduler's yield-point hook (Slice 6)
//   to spin until the writer publishes — otherwise they are flagged
//   `requires-asyncify`. The Slice 8 simulation does not block inside
//   the syscall frame: hosts that want host-blocking pipes wire their
//   own `ProcProvider` over a real OS pipe.
// - `fdRead` on an empty pipe with writer closed returns `0` (EOF).
// - `fdWrite` on a full ring throws `EAGAIN`; partial writes are
//   surfaced by returning the number of bytes that fit.
// - `fdWrite` after the reader closed throws `EPIPE` (matches POSIX).
// - `fdClose` on either end is idempotent and toggles the matching
//   `closedByReader` / `closedByWriter` flag on the shared ring.
//
// ─── Filetype ──────────────────────────────────────────────────────────────
//
// `fd_fdstat_get` reports `FILETYPE = SOCKET_STREAM`, matching wasix-libc's
// pipe-as-socket convention (see `wasix-org/wasix-libc` headers — pipes
// are wrapped as anonymous unix-domain stream sockets in v1).

import {
  ALL_RIGHTS,
  FdFlags,
  FileType,
  Result,
  WASIXError,
} from "../wasix-32v1.js";
import type { Fdstat, Filestat } from "../providers.js";

const DEFAULT_PIPE_CAPACITY = 64 * 1024;

/**
 * SPSC ring buffer shared between a `PipeReadEnd` and a `PipeWriteEnd`.
 *
 * Read and write happen on the same JS event loop in the in-process
 * simulation, so we don't need atomics — just plain indices into a
 * `Uint8Array`. Capacity is fixed at construction; backpressure is
 * surfaced as `EAGAIN`.
 */
export class PipeRingBuffer {
  private readonly buffer: Uint8Array;
  private readIndex = 0;
  private writeIndex = 0;
  private size = 0;

  /** True once the read end has called `close()`. */
  closedByReader = false;
  /** True once the write end has called `close()`. */
  closedByWriter = false;

  constructor(capacity: number = DEFAULT_PIPE_CAPACITY) {
    this.buffer = new Uint8Array(capacity);
  }

  get capacity(): number {
    return this.buffer.byteLength;
  }

  get available(): number {
    return this.size;
  }

  get free(): number {
    return this.capacity - this.size;
  }

  /**
   * Read up to `dst.byteLength` bytes into `dst`. Returns the number of
   * bytes read. Zero means EOF (writer closed and ring empty); the
   * runtime treats a `WASIXError(EAGAIN)` throw as "would block".
   */
  read(dst: Uint8Array): number {
    if (this.size === 0) {
      if (this.closedByWriter) return 0;
      throw new WASIXError(Result.EAGAIN);
    }
    const n = Math.min(dst.byteLength, this.size);
    let written = 0;
    while (written < n) {
      const chunkLen = Math.min(n - written, this.capacity - this.readIndex);
      dst.set(
        this.buffer.subarray(this.readIndex, this.readIndex + chunkLen),
        written,
      );
      this.readIndex = (this.readIndex + chunkLen) % this.capacity;
      written += chunkLen;
    }
    this.size -= n;
    return n;
  }

  /**
   * Write up to `src.byteLength` bytes. Returns the number of bytes
   * written. Throws `EPIPE` if the reader has closed; `EAGAIN` if the
   * ring is full.
   */
  write(src: Uint8Array): number {
    if (this.closedByReader) {
      throw new WASIXError(Result.EPIPE);
    }
    if (this.free === 0) {
      throw new WASIXError(Result.EAGAIN);
    }
    const n = Math.min(src.byteLength, this.free);
    let read = 0;
    while (read < n) {
      const chunkLen = Math.min(n - read, this.capacity - this.writeIndex);
      this.buffer.set(src.subarray(read, read + chunkLen), this.writeIndex);
      this.writeIndex = (this.writeIndex + chunkLen) % this.capacity;
      read += chunkLen;
    }
    this.size += n;
    return n;
  }
}

/**
 * Common shape for either end of a pipe — the WASIX runtime dispatches
 * fd operations through this minimal interface when an fd is registered
 * in its pipe table.
 */
export interface PipeEnd {
  readonly ring: PipeRingBuffer;
  readonly direction: "read" | "write";
  fdRead(bufs: Uint8Array[]): number;
  fdWrite(bufs: Uint8Array[]): number;
  fdClose(): void;
  fdFdstatGet(): Fdstat;
  fdFilestatGet(): Filestat;
  fdFdstatSetFlags(flags: number): void;
  /** `EPIPE`/`ESPIPE` semantics — pipes are not seekable. */
  fdSeek(): bigint;
  /** Current FD-flags (NONBLOCK / APPEND / …). */
  flags: number;
}

abstract class BasePipeEnd implements PipeEnd {
  abstract readonly direction: "read" | "write";
  flags = 0;

  constructor(readonly ring: PipeRingBuffer) {}

  fdRead(_bufs: Uint8Array[]): number {
    throw new WASIXError(Result.EBADF);
  }

  fdWrite(_bufs: Uint8Array[]): number {
    throw new WASIXError(Result.EBADF);
  }

  abstract fdClose(): void;

  fdFdstatGet(): Fdstat {
    return {
      filetype: FileType.SOCKET_STREAM,
      fsFlags: this.flags,
      fsRightsBase: ALL_RIGHTS,
      fsRightsInheriting: ALL_RIGHTS,
    };
  }

  fdFilestatGet(): Filestat {
    return {
      dev: 0n,
      ino: 0n,
      filetype: FileType.SOCKET_STREAM,
      nlink: 1n,
      size: BigInt(this.ring.available),
      timestamps: {
        access: 0n,
        modification: 0n,
        change: 0n,
      },
    };
  }

  fdFdstatSetFlags(flags: number): void {
    // Only NONBLOCK / APPEND / DSYNC / RSYNC / SYNC are meaningful — but
    // pipes only honour NONBLOCK in this simulation; the rest are no-ops.
    void FdFlags;
    this.flags = flags;
  }

  fdSeek(): bigint {
    throw new WASIXError(Result.ESPIPE);
  }
}

/** Read end of a pipe. */
export class PipeReadEnd extends BasePipeEnd {
  readonly direction = "read";
  private closed = false;

  override fdRead(bufs: Uint8Array[]): number {
    if (this.closed) throw new WASIXError(Result.EBADF);
    let total = 0;
    for (const buf of bufs) {
      if (buf.byteLength === 0) continue;
      // Empty ring with writer still open: surface EAGAIN unless we
      // already filled at least one byte across earlier iovecs.
      if (this.ring.available === 0) {
        if (this.ring.closedByWriter) break;
        if (total > 0) break;
        throw new WASIXError(Result.EAGAIN);
      }
      const n = this.ring.read(buf);
      total += n;
      if (n < buf.byteLength) break;
    }
    return total;
  }

  override fdClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.ring.closedByReader = true;
  }
}

/** Write end of a pipe. */
export class PipeWriteEnd extends BasePipeEnd {
  readonly direction = "write";
  private closed = false;

  override fdWrite(bufs: Uint8Array[]): number {
    if (this.closed) throw new WASIXError(Result.EBADF);
    let total = 0;
    for (const buf of bufs) {
      if (buf.byteLength === 0) continue;
      if (this.ring.free === 0) {
        if (total > 0) break;
        // PipeRingBuffer.write throws EPIPE/EAGAIN on saturation; let
        // the throw propagate so the runtime maps it to the right errno.
      }
      const n = this.ring.write(buf);
      total += n;
      if (n < buf.byteLength) break;
    }
    return total;
  }

  override fdClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.ring.closedByWriter = true;
  }
}

/**
 * Allocate a fresh pipe pair. The ring buffer is shared between the
 * two ends; closing either end flips the matching half-closed flag on
 * the shared ring so the other side sees EOF / EPIPE on its next op.
 */
export function createPipe(capacity: number = DEFAULT_PIPE_CAPACITY): {
  read: PipeReadEnd;
  write: PipeWriteEnd;
} {
  const ring = new PipeRingBuffer(capacity);
  return {
    read: new PipeReadEnd(ring),
    write: new PipeWriteEnd(ring),
  };
}
