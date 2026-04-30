// HTTPProvider — Fetch-shaped sockets provider.
//
// Translates the guest's socket-level connect/send/recv sequence into a
// Fetch-style request the host can respond to with a `Response`. Only the
// SocketsProvider surface is exposed — the inner WASIX runtime sees a real
// socket; the host sees an HTTP request.
//
// Async by design: responses are produced via `outgoing(request)` whose
// return type is `Response | Promise<Response>`, so guest reads block on
// the bridge until the host's handler resolves. Incoming flow (host →
// guest) is wired but not exhaustively exercised this slice — the wired
// shape is enough for Slice 6/8 to grow real listen/accept tests.
//
// Out of scope (returns ENOTSUP / ENOSYS):
//   - HTTPS / TLS — pass an unencrypted Response and let the host wrap.
//   - Persistent connections / pipelining — every connection is "Connection:
//     close" after the response body.
//   - Chunked request bodies from the guest.

import type { AsyncSocketsProvider } from "../async.js";
import type {
  AddrHints,
  SockAcceptResult,
  SockAddr,
  SockRecvResult,
} from "../../providers.js";
import { Result, WASIXError } from "../../wasix-32v1.js";

export type OutgoingHandler = (
  request: Request,
) => Response | Promise<Response>;

export type IncomingHandler = (port: number) => ReadableStream<Request>;

export type HTTPProviderOptions = {
  outgoing?: OutgoingHandler;
  incoming?: IncomingHandler;
};

const FD_BASE = 5000;
const HTTP_LOOPBACK_ADDRESS = "127.0.0.1";

type ConnectionKind =
  | "outgoing-pending" // connect() called, no request yet sent.
  | "outgoing-streaming" // request fully read, response produced or in-flight.
  | "incoming-listener" // bind() + listen() — accept() drains pending requests.
  | "incoming-conn"; // accept()ed connection — guest reads request, writes resp.

type ConnectionState = {
  fd: number;
  kind: ConnectionKind;
  /** Bytes the guest has written via `send` (request side). */
  inbound: Uint8Array;
  /** Bytes the guest has not yet read via `recv` (response side). */
  outbound: Uint8Array;
  /** Has the host already produced and serialised a Response? */
  responseReady: boolean;
  /** When `responseReady && outbound.byteLength === 0`, recv returns EOF. */
  responseDrained: boolean;
  /** True after `shutdown(WR)` — guest will not send more bytes. */
  guestWriteShut: boolean;
  /** Resolves the next time `outbound` grows or transitions to drained. */
  outboundChanged: Promise<void>;
  /** Notify hooks that a new chunk was appended to `outbound`. */
  notifyOutboundChange: () => void;
  /** Target host, recorded at `connect` time so `send`-time URL building works. */
  targetHost: string;
  /** Target port, recorded at `connect` time. */
  targetPort: number;
  /** Local address (synthetic). */
  local: SockAddr;
  /** Peer address — outgoing: the connect target. Incoming-conn: the requester. */
  peer: SockAddr;
};

export class HTTPProvider implements AsyncSocketsProvider {
  readonly outgoing?: OutgoingHandler;
  readonly incoming?: IncomingHandler;

  private fdCounter = FD_BASE;
  private connections = new Map<number, ConnectionState>();
  /** Listener-fd → port. */
  private listeners = new Map<number, number>();
  /** Synthetic addr key (`127.0.0.1:port`) → original host string. Lets a
   *  follow-up `connect` retrieve the host the guest resolved earlier. */
  private addrToHost = new Map<string, { host: string; port: number }>();

  constructor(options: HTTPProviderOptions = {}) {
    this.outgoing = options.outgoing;
    this.incoming = options.incoming;
  }

  open(_af: number, _type: number, _proto: number): number {
    const fd = this.fdCounter++;
    this.connections.set(fd, makeBlankConnection(fd));
    return fd;
  }

  bind(fd: number, addr: SockAddr): Result {
    const conn = this.lookup(fd);
    if (addr.family === "unix") {
      throw new WASIXError(Result.EAFNOSUPPORT);
    }
    conn.local = { ...addr };
    return Result.SUCCESS;
  }

  connect(fd: number, addr: SockAddr): Result {
    const conn = this.lookup(fd);
    if (addr.family === "unix") {
      throw new WASIXError(Result.EAFNOSUPPORT);
    }
    if (conn.kind === "incoming-listener") {
      throw new WASIXError(Result.EINVAL);
    }
    const key = `${addr.address}:${addr.port}`;
    const stashed = this.addrToHost.get(key);
    conn.targetHost = stashed?.host ?? addr.address;
    conn.targetPort = stashed?.port ?? addr.port;
    conn.peer = { ...addr };
    conn.kind = "outgoing-pending";
    return Result.SUCCESS;
  }

  listen(fd: number, _backlog: number): Result {
    const conn = this.lookup(fd);
    if (!this.incoming) {
      throw new WASIXError(Result.ENOSYS);
    }
    if (conn.local.family === "unix") {
      throw new WASIXError(Result.EAFNOSUPPORT);
    }
    conn.kind = "incoming-listener";
    this.listeners.set(fd, conn.local.port);
    // Side-effect: kick off the incoming() stream so accept() has something
    // to drain. The actual queueing of accepted connections lives off the
    // ReadableStream; not wiring it here keeps the skeleton focused —
    // Slice 6+ will expand this with a real accept loop.
    return Result.SUCCESS;
  }

  async accept(fd: number): Promise<SockAcceptResult> {
    const conn = this.lookup(fd);
    if (conn.kind !== "incoming-listener") {
      throw new WASIXError(Result.EINVAL);
    }
    // Skeleton: no in-flight stream consumer yet. A real implementation
    // would await the next `Request` from `this.incoming(port)` and
    // synthesize an `incoming-conn`. Slice 6 will wire that.
    throw new WASIXError(Result.EAGAIN);
  }

  async send(fd: number, bufs: Uint8Array[], _flags: number): Promise<number> {
    const conn = this.lookup(fd);
    if (conn.kind === "incoming-listener") {
      throw new WASIXError(Result.EINVAL);
    }
    const written = appendBufs(conn, bufs);

    if (
      conn.kind === "outgoing-pending" ||
      conn.kind === "outgoing-streaming"
    ) {
      // Try to parse a complete HTTP/1.1 request out of the inbound buffer.
      const parsed = tryParseRequest(conn.inbound);
      if (parsed && !conn.responseReady) {
        conn.kind = "outgoing-streaming";
        const url = `http://${conn.targetHost}:${conn.targetPort}${parsed.path}`;
        const init: RequestInit = {
          method: parsed.method,
          headers: parsed.headers,
        };
        // GET / HEAD must not carry a body; `Request` rejects them.
        if (
          parsed.body !== null &&
          parsed.method !== "GET" &&
          parsed.method !== "HEAD"
        ) {
          init.body = parsed.body;
        }
        const request = new Request(url, init);
        if (!this.outgoing) {
          throw new WASIXError(Result.ECONNREFUSED);
        }
        const response = await this.outgoing(request);
        const bytes = await serialiseResponse(response);
        appendOutbound(conn, bytes);
        conn.responseReady = true;
        conn.notifyOutboundChange();
      }
    }

    return written;
  }

  async recv(
    fd: number,
    bufs: Uint8Array[],
    _flags: number,
  ): Promise<SockRecvResult> {
    const conn = this.lookup(fd);
    if (conn.kind === "incoming-listener") {
      throw new WASIXError(Result.EINVAL);
    }
    // Wait for at least one byte of response, or for the response to be
    // fully drained (EOF).
    while (conn.outbound.byteLength === 0 && !conn.responseDrained) {
      if (conn.responseReady) {
        // Buffer happens to be empty but no more bytes will land — EOF.
        conn.responseDrained = true;
        break;
      }
      await conn.outboundChanged;
    }
    if (conn.outbound.byteLength === 0) {
      return { bytesRead: 0, flags: 0 };
    }
    const bytesRead = scatter(conn.outbound, bufs);
    conn.outbound = conn.outbound.subarray(bytesRead);
    if (conn.outbound.byteLength === 0 && conn.responseReady) {
      conn.responseDrained = true;
    }
    return { bytesRead, flags: 0 };
  }

  shutdown(fd: number, how: number): Result {
    const conn = this.lookup(fd);
    if (how === 2 /* WR */ || how === 3 /* RDWR */) {
      conn.guestWriteShut = true;
    }
    return Result.SUCCESS;
  }

  addrResolve(host: string, port: number, _hints: AddrHints): SockAddr[] {
    // HTTPProvider isn't a DNS resolver — we synthesise a loopback addr
    // and stash the original host so `connect(fd, addr)` can rebuild the
    // request URL.
    const synth: SockAddr = {
      family: "inet4",
      address: HTTP_LOOPBACK_ADDRESS,
      port,
    };
    this.addrToHost.set(`${HTTP_LOOPBACK_ADDRESS}:${port}`, { host, port });
    return [synth];
  }

  getOptFlag(_fd: number, _level: number, _name: number): boolean {
    // Most flag options are no-ops for HTTP; default to false.
    return false;
  }

  getOptSize(_fd: number, _level: number, _name: number): number {
    return 0;
  }

  getOptTime(_fd: number, _level: number, _name: number): bigint | null {
    return null;
  }

  setOptFlag(
    _fd: number,
    _level: number,
    _name: number,
    _value: boolean,
  ): Result {
    return Result.SUCCESS;
  }

  setOptSize(
    _fd: number,
    _level: number,
    _name: number,
    _value: number,
  ): Result {
    return Result.SUCCESS;
  }

  setOptTime(
    _fd: number,
    _level: number,
    _name: number,
    _value: bigint | null,
  ): Result {
    return Result.SUCCESS;
  }

  addrLocal(fd: number): SockAddr {
    return this.lookup(fd).local;
  }

  addrPeer(fd: number): SockAddr {
    return this.lookup(fd).peer;
  }

  status(fd: number): number {
    const conn = this.lookup(fd);
    if (conn.kind === "incoming-listener") return 2; // listening
    if (conn.kind === "outgoing-streaming" || conn.kind === "incoming-conn") {
      return 3; // connected
    }
    return 1; // bound
  }

  private lookup(fd: number): ConnectionState {
    const conn = this.connections.get(fd);
    if (!conn) {
      throw new WASIXError(Result.EBADF);
    }
    return conn;
  }
}

// ─── HTTP/1.1 parser ────────────────────────────────────────────────────────

type ParsedRequest = {
  method: string;
  path: string;
  headers: Headers;
  body: Uint8Array | null;
  consumed: number;
};

function tryParseRequest(buf: Uint8Array): ParsedRequest | null {
  // Locate the end of headers (`\r\n\r\n`).
  let headersEnd = -1;
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      headersEnd = i + 4;
      break;
    }
  }
  if (headersEnd === -1) return null;

  const headerText = new TextDecoder().decode(buf.subarray(0, headersEnd - 4));
  const lines = headerText.split("\r\n");
  if (lines.length === 0 || !lines[0]) return null;
  const startLineTokens = lines[0].split(" ");
  if (startLineTokens.length < 2) return null;
  const method = startLineTokens[0];
  const path = startLineTokens[1];

  const headers = new Headers();
  let contentLength = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!name) continue;
    headers.append(name, value);
    if (name.toLowerCase() === "content-length") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed >= 0) contentLength = parsed;
    }
  }

  if (contentLength > 0) {
    if (buf.byteLength < headersEnd + contentLength) return null;
    const body = buf.slice(headersEnd, headersEnd + contentLength);
    return {
      method,
      path,
      headers,
      body,
      consumed: headersEnd + contentLength,
    };
  }

  return { method, path, headers, body: null, consumed: headersEnd };
}

async function serialiseResponse(response: Response): Promise<Uint8Array> {
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  if (!headers.has("Content-Length")) {
    headers.set("Content-Length", String(body.byteLength));
  }
  if (!headers.has("Connection")) {
    headers.set("Connection", "close");
  }
  let head = `HTTP/1.1 ${response.status} ${response.statusText || statusText(response.status)}\r\n`;
  headers.forEach((value, name) => {
    head += `${name}: ${value}\r\n`;
  });
  head += "\r\n";
  const headBytes = new TextEncoder().encode(head);
  const out = new Uint8Array(headBytes.byteLength + body.byteLength);
  out.set(headBytes, 0);
  out.set(body, headBytes.byteLength);
  return out;
}

function statusText(status: number): string {
  // Minimal status-text fallback for the common cases — Response.statusText
  // is "" by default unless the host set one.
  if (status === 200) return "OK";
  if (status === 204) return "No Content";
  if (status === 301) return "Moved Permanently";
  if (status === 302) return "Found";
  if (status === 400) return "Bad Request";
  if (status === 404) return "Not Found";
  if (status === 500) return "Internal Server Error";
  return "OK";
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeBlankConnection(fd: number): ConnectionState {
  const local: SockAddr = {
    family: "inet4",
    address: HTTP_LOOPBACK_ADDRESS,
    port: 0,
  };
  const peer: SockAddr = {
    family: "inet4",
    address: HTTP_LOOPBACK_ADDRESS,
    port: 0,
  };
  let notifyOutboundChange = () => {};
  const outboundChanged = new Promise<void>((resolve) => {
    notifyOutboundChange = resolve;
  });
  return {
    fd,
    kind: "outgoing-pending",
    inbound: new Uint8Array(0),
    outbound: new Uint8Array(0),
    responseReady: false,
    responseDrained: false,
    guestWriteShut: false,
    outboundChanged,
    notifyOutboundChange,
    targetHost: "localhost",
    targetPort: 0,
    local,
    peer,
  };
}

function appendBufs(conn: ConnectionState, bufs: Uint8Array[]): number {
  let total = 0;
  for (const buf of bufs) total += buf.byteLength;
  if (total === 0) return 0;
  const next = new Uint8Array(conn.inbound.byteLength + total);
  next.set(conn.inbound, 0);
  let cursor = conn.inbound.byteLength;
  for (const buf of bufs) {
    next.set(buf, cursor);
    cursor += buf.byteLength;
  }
  conn.inbound = next;
  return total;
}

function appendOutbound(conn: ConnectionState, data: Uint8Array): void {
  if (data.byteLength === 0) return;
  const next = new Uint8Array(conn.outbound.byteLength + data.byteLength);
  next.set(conn.outbound, 0);
  next.set(data, conn.outbound.byteLength);
  conn.outbound = next;
  // Refresh the wakeup latch so a follow-up `recv` after this point can
  // also block until the next change. The first awaiter is unblocked via
  // the previous notify.
  let nextNotify = () => {};
  conn.outboundChanged = new Promise<void>((resolve) => {
    nextNotify = resolve;
  });
  conn.notifyOutboundChange = nextNotify;
}

function scatter(src: Uint8Array, bufs: Uint8Array[]): number {
  let read = 0;
  let cursor = 0;
  for (const buf of bufs) {
    if (cursor >= src.byteLength) break;
    const n = Math.min(src.byteLength - cursor, buf.byteLength);
    buf.set(src.subarray(cursor, cursor + n));
    cursor += n;
    read += n;
  }
  return read;
}
