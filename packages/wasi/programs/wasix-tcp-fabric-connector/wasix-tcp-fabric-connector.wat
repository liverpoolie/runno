;; Slice 5 cross-instance loopback — connector half.
;;
;; Companion to `wasix-tcp-fabric-listener.wat`. Runs on a SECOND `WASIX`
;; instance whose `LoopbackSocketsProvider` shares a `LoopbackFabric`
;; with the listener instance. Connects to 127.0.0.1:8000 — the fabric
;; finds the registered listener (from the prior listener-half run),
;; allocates the accepted-side fd, mirrors the connector socket onto it,
;; and the `send` call appends bytes onto the accepted fd's rx ring.
;;
;; The spec then inspects the fabric directly to verify those bytes
;; landed on the listener-side socket: that's the cross-instance
;; integration check the single-instance smoke test cannot make.
;;
;; Payload: the 8-byte ASCII string "x-fabric" — short enough to fit
;; in one iovec, distinctive enough that the spec can compare it
;; byte-for-byte against the rx ring without ambiguity.
;;
;; Exit codes:
;;   0  → connect + send accepted by the fabric.
;;   1  → sock_open failed.
;;   2  → sock_connect failed (typically ECONNREFUSED if the listener
;;        instance never ran, i.e. the fabric isn't actually shared).
;;   3  → sock_send failed.
;;
;; Build: wat2wasm wasix-tcp-fabric-connector.wat -o wasix-tcp-fabric-connector.wasm

(module
  (import "wasix_32v1" "sock_open"
    (func $sock_open (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_connect"
    (func $sock_connect (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_send"
    (func $sock_send (param i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout:
  ;;   0..7   addr_port_t for connect (family=INET4, port=8000, 127.0.0.1)
  ;;   64..67 ret slot for sock_open
  ;;   80..87 iovec (ptr=100, len=8)
  ;;   100..107 send payload "x-fabric"
  ;;   220..223 ret slot for sock_send written-bytes count
  (data (i32.const 0)
    "\01\00\40\1f\7f\00\00\01")
  (data (i32.const 100)
    "x-fabric")

  (func $start
    (local $fd i32)
    (local $err i32)

    ;; iovec: [80]=100 (ptr), [84]=8 (len)
    i32.const 80
    i32.const 100
    i32.store
    i32.const 84
    i32.const 8
    i32.store

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

    ;; sock_connect(fd, addr=0)
    local.get $fd
    i32.const 0
    call $sock_connect
    local.set $err
    local.get $err
    if
      i32.const 2
      call $proc_exit
      unreachable
    end

    ;; sock_send(fd, iovec=80, count=1, flags=0, retsize=220)
    local.get $fd
    i32.const 80
    i32.const 1
    i32.const 0
    i32.const 220
    call $sock_send
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
