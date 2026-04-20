// HTTPProvider — ENOSYS skeleton.
//
// First "async-capable" ergonomic provider bundled with @runno/wasi. It
// presents an HTTP-shaped surface (outgoing Fetch-like requests, incoming
// Request streams on bound ports) that translates down to the
// `AsyncSocketsProvider` interface the WASIX runtime consumes.
//
// This slice ships the class shape, constructor, and method surface —
// every socket method throws `WASIXError(ENOSYS)`. The real implementation
// lands in Slice 5; landing the skeleton now lets the async-capable type
// path have a concrete demo provider for type-checking and docs without
// tying Slice 4 to a networking implementation.
//
// HTTPProvider is explicitly designed for `WASIXWorkerHost` — the methods
// return Promises (Fetch always does), so a main-thread `WASIX(...)` cannot
// accept it. The `AsyncSocketsProvider` type (from
// `providers/async.ts`) is the contract we implement.

import type {
  AddrHints,
  SockAddr,
  SockRecvResult,
  SocketsProvider,
} from "../../providers.js";
import { Result, WASIXError } from "../../wasix-32v1.js";

/**
 * Handler a host wires up for guest-initiated outgoing requests. The
 * provider translates the guest's socket-level `connect` / `send` /
 * `recv` sequence into a Fetch-style request; the host responds with a
 * `Response` (sync or async).
 */
export type OutgoingHandler = (
  request: Request,
) => Response | Promise<Response>;

/**
 * Handler a host wires up for guest-bound services. When the guest calls
 * `listen` on a port, the provider registers with this stream; each
 * inbound `Request` becomes a virtual accepted connection the guest can
 * `recv` from.
 */
export type IncomingHandler = (port: number) => ReadableStream<Request>;

export type HTTPProviderOptions = {
  outgoing?: OutgoingHandler;
  incoming?: IncomingHandler;
};

/**
 * `HTTPProvider` implements the `SocketsProvider` interface. Because every
 * method is synchronous in its type signature but the real implementation
 * (Slice 5) returns Promises, the exported concrete class is valid as
 * `AsyncSocketsProvider` — the async-capable superset.
 *
 * This slice: all methods throw `WASIXError(ENOSYS)`. Hosts that want
 * HTTP today continue to wire their own `SocketsProvider`.
 */
export class HTTPProvider implements SocketsProvider {
  readonly outgoing?: OutgoingHandler;
  readonly incoming?: IncomingHandler;

  constructor(options: HTTPProviderOptions = {}) {
    this.outgoing = options.outgoing;
    this.incoming = options.incoming;
  }

  open(_af: number, _type: number, _proto: number): number {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  bind(_fd: number, _addr: SockAddr): Result {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  connect(_fd: number, _addr: SockAddr): Result {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  listen(_fd: number, _backlog: number): Result {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  accept(_fd: number): number {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  send(_fd: number, _bufs: Uint8Array[], _flags: number): number {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  recv(_fd: number, _bufs: Uint8Array[], _flags: number): SockRecvResult {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  shutdown(_fd: number, _how: number): Result {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }

  addrResolve(_host: string, _port: number, _hints: AddrHints): SockAddr[] {
    throw new WASIXError(
      Result.ENOSYS,
      "HTTPProvider is a skeleton — real implementation lands in Slice 5.",
    );
  }
}
