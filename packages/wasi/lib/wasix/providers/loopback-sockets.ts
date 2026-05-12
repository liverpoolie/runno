// LoopbackSocketsProvider — purely in-process socket fabric.
//
// Implements the synchronous `SocketsProvider` interface. Two `WASIX`
// instances configured with the same provider instance can communicate as
// if over loopback TCP/UDP — the fabric routes connect → listener queue,
// send → peer's rx ring, recv → drain rx ring. No real network is touched.
//
// Scope:
//   - STREAM (TCP-shaped) loopback with bounded ring buffers per direction.
//   - Single-message DGRAM exchange via per-recv datagram queue.
//   - addrResolve: synthesises 127.0.0.1 for "localhost" and any host that
//     matches a registered listener bind address.
//   - Socket options: SO_TYPE / SO_ERROR / SO_REUSEADDR (no-op accept).
//
// Out of scope this slice (return ENOTSUP / ENOPROTOOPT):
//   - Cross-fabric routing, real DNS, IPv6 reachability beyond stub addrs.
//   - Half-closed shutdown propagation past the simple "done writing" flag.
//   - Out-of-band data, MSG_PEEK semantics.
//
// FD allocation: loopback fds start at 1000 to avoid collision with stdio
// (0–2) and any preopens / fs-provider fds the host's program may grow into.
// The provider's fd space is internal — `WASIX` is responsible for any
// guest-visible fd-table mapping it cares to introduce. For Slice 5 we keep
// the mapping 1:1 (the loopback fd IS the guest fd).

import {
  AddressFamily,
  Result,
  ShutdownHow,
  SockLevel,
  SockOpt,
  SockType,
  WASIXError,
} from "../wasix-32v1.js";
import type {
  AddrHints,
  SockAcceptResult,
  SockAddr,
  SockRecvResult,
  SocketsProvider,
} from "../providers.js";

const RX_BUFFER_BYTES = 64 * 1024;
const FD_BASE = 1000;
const EPHEMERAL_PORT_BASE = 49152;

type SocketKind = "unbound" | "bound" | "listening" | "connected" | "closed";

type PendingConn = {
  /** Peer-side fd (the connector's). */
  peerFd: number;
  /** SockAddr the peer claims (synthesised as 127.0.0.1:<ephemeral>). */
  peerAddr: SockAddr;
};

type Datagram = {
  from: SockAddr;
  bytes: Uint8Array;
};

type SocketState = {
  fd: number;
  type: SockType;
  family: AddressFamily;
  proto: number;
  kind: SocketKind;
  local: SockAddr | null;
  peer: SockAddr | null;
  /** Inbound bytes written by the peer's `send` calls (STREAM only). */
  rxStream: Uint8Array;
  rxStreamLen: number;
  /** Inbound datagrams (DGRAM only). */
  rxDatagrams: Datagram[];
  /** The other side of a connected STREAM pair. */
  peerFd: number | null;
  /** Set after `shutdown(WR)` on this fd or `shutdown(RD)` on the peer. */
  peerWriteClosed: boolean;
  /** Set after `shutdown(RD)` on this fd or `shutdown(WR)` on the peer. */
  selfWriteClosed: boolean;
  /** Pending connection backlog when `kind === "listening"`. */
  backlog: PendingConn[];
  /** Last error reported via SO_ERROR — cleared on read. */
  lastError: number;
};

function listenerKey(family: AddressFamily, port: number): string {
  return `${family}:${port}`;
}

/**
 * Internal fabric shared across all sockets in a provider. Pulled out as a
 * separate object so that two `LoopbackSocketsProvider` instances explicitly
 * sharing a fabric can route between each other; the two-instance loopback
 * spec does this by passing the same fabric to both providers.
 */
export class LoopbackFabric {
  /** All sockets keyed by their loopback fd. */
  readonly sockets = new Map<number, SocketState>();
  /** `family:port` → fd of a listening socket bound there. */
  readonly listeners = new Map<string, number>();

  private fdCounter = FD_BASE;
  private portCounter = EPHEMERAL_PORT_BASE;

  allocateFd(): number {
    return this.fdCounter++;
  }

  allocatePort(): number {
    return this.portCounter++;
  }
}

export class LoopbackSocketsProvider implements SocketsProvider {
  readonly fabric: LoopbackFabric;

  constructor(fabric?: LoopbackFabric) {
    this.fabric = fabric ?? new LoopbackFabric();
  }

  open(af: number, type: number, proto: number): number {
    if (af !== AddressFamily.INET4 && af !== AddressFamily.INET6) {
      throw new WASIXError(Result.EAFNOSUPPORT);
    }
    if (type !== SockType.STREAM && type !== SockType.DGRAM) {
      throw new WASIXError(Result.EPROTOTYPE);
    }
    const fd = this.fabric.allocateFd();
    this.fabric.sockets.set(fd, {
      fd,
      type: type as SockType,
      family: af as AddressFamily,
      proto,
      kind: "unbound",
      local: null,
      peer: null,
      rxStream: new Uint8Array(RX_BUFFER_BYTES),
      rxStreamLen: 0,
      rxDatagrams: [],
      peerFd: null,
      peerWriteClosed: false,
      selfWriteClosed: false,
      backlog: [],
      lastError: 0,
    });
    return fd;
  }

  bind(fd: number, addr: SockAddr): Result {
    const sock = this.lookup(fd);
    if (sock.kind !== "unbound") {
      throw new WASIXError(Result.EINVAL);
    }
    if (addr.family === "unix") {
      throw new WASIXError(Result.EAFNOSUPPORT);
    }
    const port = addr.port === 0 ? this.fabric.allocatePort() : addr.port;
    sock.local = { ...addr, port };
    sock.kind = "bound";
    return Result.SUCCESS;
  }

  connect(fd: number, addr: SockAddr): Result {
    const sock = this.lookup(fd);
    if (sock.kind === "connected" || sock.kind === "listening") {
      throw new WASIXError(Result.EISCONN);
    }
    if (addr.family === "unix") {
      throw new WASIXError(Result.EAFNOSUPPORT);
    }
    const family =
      addr.family === "inet4" ? AddressFamily.INET4 : AddressFamily.INET6;

    if (sock.type === SockType.DGRAM) {
      // Connecting a DGRAM socket just records the default destination.
      if (sock.local === null) {
        sock.local = makeLoopbackAddr(family, this.fabric.allocatePort());
      }
      sock.peer = { ...addr };
      sock.kind = "connected";
      return Result.SUCCESS;
    }

    // STREAM connect — find a listener and queue a pending connection.
    const listenerFd = this.fabric.listeners.get(
      listenerKey(family, addr.port),
    );
    if (listenerFd === undefined) {
      throw new WASIXError(Result.ECONNREFUSED);
    }
    const listener = this.fabric.sockets.get(listenerFd);
    if (!listener || listener.kind !== "listening") {
      throw new WASIXError(Result.ECONNREFUSED);
    }

    if (sock.local === null) {
      sock.local = makeLoopbackAddr(family, this.fabric.allocatePort());
    }
    // Allocate the listener-side accepted fd up-front; it materialises
    // for the host as a fully-formed connected socket, mirrored to ours.
    const acceptedFd = this.fabric.allocateFd();
    const acceptedLocal: SockAddr = makeLoopbackAddr(family, addr.port);
    this.fabric.sockets.set(acceptedFd, {
      fd: acceptedFd,
      type: SockType.STREAM,
      family,
      proto: sock.proto,
      kind: "connected",
      local: acceptedLocal,
      peer: { ...sock.local },
      rxStream: new Uint8Array(RX_BUFFER_BYTES),
      rxStreamLen: 0,
      rxDatagrams: [],
      peerFd: sock.fd,
      peerWriteClosed: false,
      selfWriteClosed: false,
      backlog: [],
      lastError: 0,
    });
    sock.peer = acceptedLocal;
    sock.peerFd = acceptedFd;
    sock.kind = "connected";
    listener.backlog.push({ peerFd: acceptedFd, peerAddr: { ...sock.local } });
    return Result.SUCCESS;
  }

  listen(fd: number, _backlog: number): Result {
    const sock = this.lookup(fd);
    if (sock.kind !== "bound") {
      throw new WASIXError(Result.EINVAL);
    }
    if (sock.type !== SockType.STREAM) {
      throw new WASIXError(Result.ENOTSUP);
    }
    if (sock.local === null || sock.local.family === "unix") {
      throw new WASIXError(Result.EINVAL);
    }
    sock.kind = "listening";
    const family =
      sock.local.family === "inet4" ? AddressFamily.INET4 : AddressFamily.INET6;
    this.fabric.listeners.set(listenerKey(family, sock.local.port), fd);
    return Result.SUCCESS;
  }

  accept(fd: number): SockAcceptResult {
    const sock = this.lookup(fd);
    if (sock.kind !== "listening") {
      throw new WASIXError(Result.EINVAL);
    }
    const next = sock.backlog.shift();
    if (next === undefined) {
      throw new WASIXError(Result.EAGAIN);
    }
    return { fd: next.peerFd, addr: next.peerAddr };
  }

  send(fd: number, bufs: Uint8Array[], _flags: number): number {
    const sock = this.lookup(fd);
    if (sock.kind === "closed") {
      throw new WASIXError(Result.EBADF);
    }

    if (sock.type === SockType.DGRAM) {
      if (sock.peer === null || sock.peer.family === "unix") {
        throw new WASIXError(Result.EDESTADDRREQ);
      }
      const family =
        sock.peer.family === "inet4"
          ? AddressFamily.INET4
          : AddressFamily.INET6;
      const peerFd = this.fabric.listeners.get(
        listenerKey(family, sock.peer.port),
      );
      if (peerFd === undefined) {
        // Datagram dropped silently when no listener — match BSD.
        return totalBytes(bufs);
      }
      const peer = this.fabric.sockets.get(peerFd);
      if (!peer) return totalBytes(bufs);
      const total = totalBytes(bufs);
      const flat = flatten(bufs, total);
      peer.rxDatagrams.push({
        from: sock.local ?? makeLoopbackAddr(family, 0),
        bytes: flat,
      });
      return total;
    }

    // STREAM
    if (sock.kind !== "connected" || sock.peerFd === null) {
      throw new WASIXError(Result.ENOTCONN);
    }
    if (sock.selfWriteClosed) {
      throw new WASIXError(Result.EPIPE);
    }
    const peer = this.fabric.sockets.get(sock.peerFd);
    if (!peer) {
      throw new WASIXError(Result.EPIPE);
    }
    const free = peer.rxStream.byteLength - peer.rxStreamLen;
    if (free === 0) {
      throw new WASIXError(Result.EAGAIN);
    }
    let written = 0;
    for (const buf of bufs) {
      const room = peer.rxStream.byteLength - peer.rxStreamLen;
      if (room === 0) break;
      const n = Math.min(room, buf.byteLength);
      peer.rxStream.set(buf.subarray(0, n), peer.rxStreamLen);
      peer.rxStreamLen += n;
      written += n;
      if (n < buf.byteLength) break;
    }
    return written;
  }

  recv(fd: number, bufs: Uint8Array[], _flags: number): SockRecvResult {
    const sock = this.lookup(fd);
    if (sock.kind === "closed") {
      throw new WASIXError(Result.EBADF);
    }
    if (sock.type === SockType.DGRAM) {
      const dgram = sock.rxDatagrams.shift();
      if (dgram === undefined) {
        throw new WASIXError(Result.EAGAIN);
      }
      const bytesRead = scatter(dgram.bytes, bufs);
      return { bytesRead, flags: 0 };
    }

    // STREAM
    if (sock.kind !== "connected") {
      throw new WASIXError(Result.ENOTCONN);
    }
    if (sock.rxStreamLen === 0) {
      // Peer closed write half ⇒ EOF (return 0 bytes).
      if (sock.peerWriteClosed) {
        return { bytesRead: 0, flags: 0 };
      }
      throw new WASIXError(Result.EAGAIN);
    }
    let read = 0;
    let cursor = 0;
    for (const buf of bufs) {
      if (cursor >= sock.rxStreamLen) break;
      const available = sock.rxStreamLen - cursor;
      const n = Math.min(available, buf.byteLength);
      buf.set(sock.rxStream.subarray(cursor, cursor + n));
      cursor += n;
      read += n;
    }
    // Compact the ring.
    if (cursor < sock.rxStreamLen) {
      sock.rxStream.copyWithin(0, cursor, sock.rxStreamLen);
    }
    sock.rxStreamLen -= cursor;
    return { bytesRead: read, flags: 0 };
  }

  shutdown(fd: number, how: number): Result {
    const sock = this.lookup(fd);
    const closeWrite = how === ShutdownHow.WR || how === ShutdownHow.RDWR;
    const closeRead = how === ShutdownHow.RD || how === ShutdownHow.RDWR;
    if (closeWrite) {
      sock.selfWriteClosed = true;
      if (sock.peerFd !== null) {
        const peer = this.fabric.sockets.get(sock.peerFd);
        if (peer) peer.peerWriteClosed = true;
      }
    }
    if (closeRead && sock.peerFd !== null) {
      const peer = this.fabric.sockets.get(sock.peerFd);
      if (peer) peer.selfWriteClosed = true;
    }
    return Result.SUCCESS;
  }

  addrResolve(host: string, port: number, _hints: AddrHints): SockAddr[] {
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") {
      return [makeLoopbackAddr(AddressFamily.INET4, port)];
    }
    // Allow resolving any host that has a registered listener — useful for
    // loopback tests that bind to a synthetic address.
    for (const key of this.fabric.listeners.keys()) {
      if (key.endsWith(`:${port}`)) {
        return [makeLoopbackAddr(AddressFamily.INET4, port)];
      }
    }
    // Empty array signals NXDOMAIN-equivalent at the syscall layer.
    return [];
  }

  getOptFlag(fd: number, level: number, name: number): boolean {
    this.lookup(fd);
    if (level !== SockLevel.SOCKET) {
      throw new WASIXError(Result.ENOPROTOOPT);
    }
    if (name === SockOpt.REUSE_ADDR || name === SockOpt.REUSE_PORT) {
      return true;
    }
    throw new WASIXError(Result.ENOPROTOOPT);
  }

  getOptSize(fd: number, level: number, name: number): number {
    const sock = this.lookup(fd);
    if (level !== SockLevel.SOCKET) {
      throw new WASIXError(Result.ENOPROTOOPT);
    }
    if (name === SockOpt.TYPE) return sock.type;
    if (name === SockOpt.LAST_ERROR) {
      const err = sock.lastError;
      sock.lastError = 0;
      return err;
    }
    throw new WASIXError(Result.ENOPROTOOPT);
  }

  getOptTime(_fd: number, _level: number, _name: number): bigint | null {
    throw new WASIXError(Result.ENOPROTOOPT);
  }

  setOptFlag(fd: number, level: number, name: number, _value: boolean): Result {
    this.lookup(fd);
    if (level !== SockLevel.SOCKET) {
      throw new WASIXError(Result.ENOPROTOOPT);
    }
    if (name === SockOpt.REUSE_ADDR || name === SockOpt.REUSE_PORT) {
      return Result.SUCCESS;
    }
    throw new WASIXError(Result.ENOPROTOOPT);
  }

  setOptSize(
    _fd: number,
    _level: number,
    _name: number,
    _value: number,
  ): Result {
    // Accept silently — many programs blindly set SO_RCVBUF / SO_SNDBUF.
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
    const sock = this.lookup(fd);
    if (sock.local === null) {
      throw new WASIXError(Result.EINVAL);
    }
    return sock.local;
  }

  addrPeer(fd: number): SockAddr {
    const sock = this.lookup(fd);
    if (sock.peer === null) {
      throw new WASIXError(Result.ENOTCONN);
    }
    return sock.peer;
  }

  status(fd: number): number {
    const sock = this.lookup(fd);
    switch (sock.kind) {
      case "unbound":
        return 0;
      case "bound":
        return 1;
      case "listening":
        return 2;
      case "connected":
        return 3;
      case "closed":
        return 4;
    }
  }

  private lookup(fd: number): SocketState {
    const sock = this.fabric.sockets.get(fd);
    if (!sock) {
      throw new WASIXError(Result.EBADF);
    }
    return sock;
  }
}

function makeLoopbackAddr(family: AddressFamily, port: number): SockAddr {
  if (family === AddressFamily.INET6) {
    return { family: "inet6", address: "::1", port };
  }
  return { family: "inet4", address: "127.0.0.1", port };
}

function totalBytes(bufs: Uint8Array[]): number {
  let total = 0;
  for (const buf of bufs) total += buf.byteLength;
  return total;
}

function flatten(bufs: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const buf of bufs) {
    out.set(buf, offset);
    offset += buf.byteLength;
  }
  return out;
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
