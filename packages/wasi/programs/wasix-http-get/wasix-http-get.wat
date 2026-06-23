;; Slice 5 HTTPProvider smoke test.
;;
;; Issues a literal `GET / HTTP/1.1\r\nHost: example.com\r\n\r\n` over a
;; connected socket, then drains the response into stdout. The spec wires
;; an `outgoing` handler that returns `Response("hello\n", { status: 200 })`,
;; so the guest's stdout ends up containing the full HTTP/1.1 response —
;; including "hello" in the body. The Playwright assertion checks for
;; that substring.
;;
;; Build: wat2wasm wasix-http-get.wat -o wasix-http-get.wasm

(module
  (import "wasix_32v1" "sock_open"
    (func $sock_open (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_connect"
    (func $sock_connect (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_send"
    (func $sock_send (param i32 i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_recv"
    (func $sock_recv (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout:
  ;;   0..7    addr_port_t for connect (family=1, port=8080, 127.0.0.1)
  ;;   64..67  ret_fd
  ;;   80..87  iovec_send  ptr=200, len=38
  ;;   88..95  iovec_recv  ptr=400, len=2048
  ;;   96..103 iovec_write ptr=400, len=<bytes_read> (rebuilt each iter)
  ;;   200..   GET request bytes (38 bytes: "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")
  ;;   400..   recv buffer (2048 bytes)
  ;;   2500..2503 ret_size_send
  ;;   2504..2507 ret_size_recv
  ;;   2508..2509 ret_flags
  ;;   2520..2523 ret_size_write
  (data (i32.const 0)
    "\01\00\90\1f\7f\00\00\01")
  (data (i32.const 200)
    "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")

  (func $start
    (local $fd i32)
    (local $err i32)
    (local $bytes_read i32)

    ;; iovec_send: [80]=200 (ptr), [84]=38 (len)
    i32.const 80
    i32.const 200
    i32.store
    i32.const 84
    i32.const 38
    i32.store

    ;; iovec_recv: [88]=400 (ptr), [92]=2048 (len)
    i32.const 88
    i32.const 400
    i32.store
    i32.const 92
    i32.const 2048
    i32.store

    ;; sock_open(af=1, type=1, proto=6, retfd=64)
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

    ;; sock_send(fd, iovec=80, count=1, flags=0, retsize=2500)
    local.get $fd
    i32.const 80
    i32.const 1
    i32.const 0
    i32.const 2500
    call $sock_send
    local.set $err
    local.get $err
    if
      i32.const 3
      call $proc_exit
      unreachable
    end

    ;; recv loop — drain until 0 bytes (EOF).
    block $recv_break
      loop $recv_loop
        ;; sock_recv(fd, iovec=88, count=1, flags=0, retsize=2504, retflags=2508)
        local.get $fd
        i32.const 88
        i32.const 1
        i32.const 0
        i32.const 2504
        i32.const 2508
        call $sock_recv
        local.set $err
        local.get $err
        if
          i32.const 4
          call $proc_exit
          unreachable
        end
        i32.const 2504
        i32.load
        local.set $bytes_read

        ;; If 0 bytes read (EOF), break.
        local.get $bytes_read
        i32.eqz
        br_if $recv_break

        ;; iovec_write: [96]=400, [100]=$bytes_read
        i32.const 96
        i32.const 400
        i32.store
        i32.const 100
        local.get $bytes_read
        i32.store

        ;; fd_write(stdout=1, ciovs=96, ciovs_len=1, retsize=2520)
        i32.const 1
        i32.const 96
        i32.const 1
        i32.const 2520
        call $fd_write
        local.set $err
        local.get $err
        if
          i32.const 5
          call $proc_exit
          unreachable
        end

        br $recv_loop
      end
    end

    i32.const 0
    call $proc_exit
  )
)
