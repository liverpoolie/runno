;; Hand-rolled WASIX determinism smoke test.
;;
;; Calls random_get for 8 bytes and clock_time_get(REALTIME) for 8 bytes,
;; then writes all 16 bytes to stdout via fd_write. Playwright runs this
;; binary twice with identical FixedClockProvider(0n) + SeededRandomProvider(42)
;; and asserts that the stdout bytes are equal across both runs.
;;
;; Build: wat2wasm wasix-deterministic.wat -o wasix-deterministic.wasm
;;
;; WAT rather than cargo-wasix: cargo-wasix is not available in this repo.
;; Hand-rolled WAT follows the same pattern as wasix-hello.

(module
  ;; clock_time_get(clock_id: i32, precision: i64, retptr: i32) -> i32
  (import "wasix_32v1" "clock_time_get"
    (func $clock_time_get (param i32 i64 i32) (result i32)))
  ;; random_get(buf: i32, buf_len: i32) -> i32
  (import "wasix_32v1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  ;; fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout:
  ;;   offset  0 –  7 : random_get result (8 bytes)
  ;;   offset  8 – 15 : clock_time_get result (u64 little-endian)
  ;;   offset 16 – 19 : iov[0].buf  (u32) — pointer to output data
  ;;   offset 20 – 23 : iov[0].len  (u32) — 16 bytes total
  ;;   offset 24 – 27 : nwritten    (u32)

  (func $start
    ;; random_get(buf=0, buf_len=8) → 8 bytes at offset 0
    i32.const 0
    i32.const 8
    call $random_get
    drop

    ;; clock_time_get(REALTIME=0, precision=0, retptr=8) → 8 bytes at offset 8
    i32.const 0
    i64.const 0
    i32.const 8
    call $clock_time_get
    drop

    ;; Set up iov: buf_ptr=0, buf_len=16
    i32.const 16
    i32.const 0
    i32.store
    i32.const 20
    i32.const 16
    i32.store

    ;; fd_write(fd=1, iovs=16, iovs_len=1, nwritten=24)
    i32.const 1
    i32.const 16
    i32.const 1
    i32.const 24
    call $fd_write
    drop

    ;; Exit 0
    i32.const 0
    call $proc_exit
  )
)
