;; Tiny WASIX guest for Slice-4 bridge stdin-overflow test.
;;
;; Calls `fd_read(fd=0, iov_ptr, iov_count, nread_ptr)` once with a single
;; 32-byte iovec into linear memory and exits with the syscall's return
;; code (errno).
;;
;; When the host's stdin callback returns a string larger than the bridge
;; response region (~64 KiB), the dispatcher catches `encodeResponse`'s
;; throw, ships back a GENERIC_ERROR — the guest's fd_read returns EIO=29.
;;
;; Build: wat2wasm wasix-bridge-stdin.wat -o wasix-bridge-stdin.wasm

(module
  ;; fd_read(fd: i32, iovs: i32, iovs_len: i32, nread: i32) -> errno: i32
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout:
  ;;   offset 0 : iovec.buf_ptr  (u32) = 16
  ;;   offset 4 : iovec.buf_len  (u32) = 32
  ;;   offset 8 : nread_out      (u32)
  ;;   offset 16..47 : read buffer (32 bytes)

  (func $start
    ;; iovec[0].buf = 16
    i32.const 0
    i32.const 16
    i32.store
    ;; iovec[0].len = 32
    i32.const 4
    i32.const 32
    i32.store

    ;; fd_read(0, iovs=0, iovs_len=1, nread_out=8)
    i32.const 0
    i32.const 0
    i32.const 1
    i32.const 8
    call $fd_read
    call $proc_exit
  )
)
