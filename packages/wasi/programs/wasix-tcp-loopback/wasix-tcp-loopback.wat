;; Slice 5 loopback sockets smoke test.
;;
;; Single-process flow that exercises the full sock_* stack against the
;; LoopbackSocketsProvider:
;;
;;   1. sock_open  → listen-fd (STREAM/TCP, INET4)
;;   2. sock_bind  listen-fd → 127.0.0.1:8000
;;   3. sock_listen listen-fd
;;   4. sock_open  → connect-fd
;;   5. sock_connect connect-fd → 127.0.0.1:8000
;;        (loopback fabric synchronously creates a connected pair AND
;;         enqueues a pending entry on the listener)
;;   6. sock_accept listen-fd → accepted-fd + remote addr
;;   7. sock_send  connect-fd ← 12-byte payload "hello-socket"
;;   8. sock_recv  accepted-fd → buffer at 200..212
;;   9. compare bytes — exit 0 on match, 9 on mismatch.
;;
;; Earlier exit codes (1..8) tag which syscall returned non-zero so a
;; failed run still reveals where it broke.
;;
;; Build: wat2wasm wasix-tcp-loopback.wat -o wasix-tcp-loopback.wasm

(module
  (import "wasix_32v1" "sock_open"
    (func $sock_open (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_bind"
    (func $sock_bind (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_listen"
    (func $sock_listen (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_connect"
    (func $sock_connect (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_accept"
    (func $sock_accept (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_send"
    (func $sock_send (param i32 i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_recv"
    (func $sock_recv (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout:
  ;;   0..23   addr_port_t for bind/connect (family=INET4, port=8000, 127.0.0.1)
  ;;     [0]   family u8 = 1
  ;;     [2-3] port u16 LE = 8000 = 0x1F40 → 0x40, 0x1F
  ;;     [4-7] address bytes 7F 00 00 01
  ;;   32..55  addr_port_t for accept output (zero-init)
  ;;   64..67  ret slot for sock_open #1 (listen fd)
  ;;   68..71  ret slot for sock_open #2 (connect fd)
  ;;   72..75  ret slot for sock_accept (accepted fd)
  ;;   80..87  iovec for send  (ptr=100, len=12)
  ;;   88..95  iovec for recv  (ptr=200, len=12)
  ;;   100..111 send payload "hello-socket"
  ;;   200..211 recv buffer
  ;;   220..223 ret_size (sock_send / sock_recv)
  ;;   228..229 ret_flags (sock_recv)
  (data (i32.const 0)
    "\01\00\40\1f\7f\00\00\01")
  (data (i32.const 100)
    "hello-socket")

  (func $start
    (local $listen_fd i32)
    (local $connect_fd i32)
    (local $accepted_fd i32)
    (local $err i32)
    (local $i i32)

    ;; iovec_send: [80]=100 (ptr), [84]=12 (len)
    i32.const 80
    i32.const 100
    i32.store
    i32.const 84
    i32.const 12
    i32.store

    ;; iovec_recv: [88]=200 (ptr), [92]=12 (len)
    i32.const 88
    i32.const 200
    i32.store
    i32.const 92
    i32.const 12
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
    local.set $listen_fd

    ;; sock_bind(listen_fd, addr=0)
    local.get $listen_fd
    i32.const 0
    call $sock_bind
    local.set $err
    local.get $err
    if
      i32.const 2
      call $proc_exit
      unreachable
    end

    ;; sock_listen(listen_fd, backlog=4)
    local.get $listen_fd
    i32.const 4
    call $sock_listen
    local.set $err
    local.get $err
    if
      i32.const 3
      call $proc_exit
      unreachable
    end

    ;; sock_open(af=1, type=1, proto=6, retfd=68) — connect side
    i32.const 1
    i32.const 1
    i32.const 6
    i32.const 68
    call $sock_open
    local.set $err
    local.get $err
    if
      i32.const 4
      call $proc_exit
      unreachable
    end
    i32.const 68
    i32.load
    local.set $connect_fd

    ;; sock_connect(connect_fd, addr=0)
    local.get $connect_fd
    i32.const 0
    call $sock_connect
    local.set $err
    local.get $err
    if
      i32.const 5
      call $proc_exit
      unreachable
    end

    ;; sock_accept(listen_fd, fdflags=0, retfd=72, retaddr=32)
    local.get $listen_fd
    i32.const 0
    i32.const 72
    i32.const 32
    call $sock_accept
    local.set $err
    local.get $err
    if
      i32.const 6
      call $proc_exit
      unreachable
    end
    i32.const 72
    i32.load
    local.set $accepted_fd

    ;; sock_send(connect_fd, iovec=80, count=1, flags=0, retsize=220)
    local.get $connect_fd
    i32.const 80
    i32.const 1
    i32.const 0
    i32.const 220
    call $sock_send
    local.set $err
    local.get $err
    if
      i32.const 7
      call $proc_exit
      unreachable
    end

    ;; sock_recv(accepted_fd, iovec=88, count=1, flags=0, retsize=220, retflags=228)
    local.get $accepted_fd
    i32.const 88
    i32.const 1
    i32.const 0
    i32.const 220
    i32.const 228
    call $sock_recv
    local.set $err
    local.get $err
    if
      i32.const 8
      call $proc_exit
      unreachable
    end

    ;; Verify the 12-byte payload at offset 200 matches the source at 100.
    i32.const 0
    local.set $i
    block $check_break
      loop $check_loop
        local.get $i
        i32.const 12
        i32.ge_u
        br_if $check_break

        i32.const 100
        local.get $i
        i32.add
        i32.load8_u
        i32.const 200
        local.get $i
        i32.add
        i32.load8_u
        i32.ne
        if
          i32.const 9
          call $proc_exit
          unreachable
        end

        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $check_loop
      end
    end

    i32.const 0
    call $proc_exit
  )
)
