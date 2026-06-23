;; Slice 5 cross-instance loopback — listener half.
;;
;; Companion to `wasix-tcp-fabric-connector.wat`. Together they exercise
;; the design point of the loopback fabric: two `WASIX` instances, each
;; with their own `LoopbackSocketsProvider`, both wired to the same
;; `LoopbackFabric`. The listener binds + listens on 127.0.0.1:8000 and
;; exits 0; the listening fd persists in the shared fabric so a separate
;; instance running the connector can find the listener via
;; `fabric.listeners` and append a pending connection.
;;
;; Why no accept here: Slice 5 main-thread `WASIX.start` runs each
;; instance synchronously to proc_exit before the next instance starts.
;; A spinning accept would deadlock since the connector hasn't run yet.
;; Accept is verified separately by the single-instance round-trip
;; (`wasix-tcp-loopback.wat`) and by the spec's direct fabric inspection
;; after both instances have exited.
;;
;; Exit codes:
;;   0  → bind + listen accepted by the fabric.
;;   1  → sock_open failed.
;;   2  → sock_bind failed.
;;   3  → sock_listen failed.
;;
;; Build: wat2wasm wasix-tcp-fabric-listener.wat -o wasix-tcp-fabric-listener.wasm

(module
  (import "wasix_32v1" "sock_open"
    (func $sock_open (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_bind"
    (func $sock_bind (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_listen"
    (func $sock_listen (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout:
  ;;   0..7   addr_port_t for bind (family=INET4, port=8000, 127.0.0.1)
  ;;   64..67 ret slot for sock_open
  (data (i32.const 0)
    "\01\00\40\1f\7f\00\00\01")

  (func $start
    (local $fd i32)
    (local $err i32)

    ;; sock_open(af=1, type=1 STREAM, proto=6 TCP, retfd=64)
    i32.const 1
    i32.const 1
    i32.const 6
    i32.const 64
    call $sock_open
    local.set $err
    local.get $err
    if
      i32.const 1
      call $proc_exit
      unreachable
    end
    i32.const 64
    i32.load
    local.set $fd

    ;; sock_bind(fd, addr=0)
    local.get $fd
    i32.const 0
    call $sock_bind
    local.set $err
    local.get $err
    if
      i32.const 2
      call $proc_exit
      unreachable
    end

    ;; sock_listen(fd, backlog=4)
    local.get $fd
    i32.const 4
    call $sock_listen
    local.set $err
    local.get $err
    if
      i32.const 3
      call $proc_exit
      unreachable
    end

    i32.const 0
    call $proc_exit
  )
)
