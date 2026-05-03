;; Hand-rolled WASI preview1 determinism smoke test.
;;
;; Mirror of `programs/wasix-deterministic/wasix-deterministic.wat` but
;; with all imports under `wasi_snapshot_preview1` so the binary loads
;; under the preview1 runtime alone. Calls random_get for 8 bytes and
;; clock_time_get(REALTIME) for 8 bytes, then writes all 16 bytes to
;; stdout as a 32-character lowercase hex string via fd_write.
;;
;; Playwright runs this under FixedClockProvider(0n) +
;; SeededRandomProvider(42) wired through `WASIContext`'s new provider
;; slots, asserting byte-identical stdout across two runs.
;;
;; Build: wat2wasm wasi-deterministic.wat -o wasi-deterministic.wasm

(module
  ;; clock_time_get(clock_id: i32, precision: i64, retptr: i32) -> i32
  (import "wasi_snapshot_preview1" "clock_time_get"
    (func $clock_time_get (param i32 i64 i32) (result i32)))
  ;; random_get(buf: i32, buf_len: i32) -> i32
  (import "wasi_snapshot_preview1" "random_get"
    (func $random_get (param i32 i32) (result i32)))
  ;; fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout matches wasix-deterministic.wat:
  ;;   offset  0 –  7 : random_get result (8 bytes)
  ;;   offset  8 – 15 : clock_time_get result (u64 little-endian, 8 bytes)
  ;;   offset 16 – 47 : hex-encoded output (32 ASCII chars)
  ;;   offset 48 – 51 : iov[0].buf  (u32) — pointer to hex output (= 16)
  ;;   offset 52 – 55 : iov[0].len  (u32) — 32 bytes
  ;;   offset 56 – 59 : nwritten    (u32)
  ;;   offset 64 – 79 : "0123456789abcdef" hex digit table

  (data (i32.const 64) "0123456789abcdef")

  (func $start
    (local $i i32)
    (local $b i32)
    (local $hi i32)
    (local $lo i32)

    i32.const 0
    i32.const 8
    call $random_get
    drop

    i32.const 0
    i64.const 0
    i32.const 8
    call $clock_time_get
    drop

    i32.const 0
    local.set $i
    (block $break
      (loop $loop
        local.get $i
        i32.const 16
        i32.ge_u
        br_if $break

        local.get $i
        i32.load8_u
        local.set $b

        local.get $b
        i32.const 4
        i32.shr_u
        local.set $hi

        local.get $b
        i32.const 0xf
        i32.and
        local.set $lo

        i32.const 16
        local.get $i
        i32.const 1
        i32.shl
        i32.add
        local.get $hi
        i32.const 64
        i32.add
        i32.load8_u
        i32.store8

        i32.const 17
        local.get $i
        i32.const 1
        i32.shl
        i32.add
        local.get $lo
        i32.const 64
        i32.add
        i32.load8_u
        i32.store8

        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $loop
      )
    )

    i32.const 48
    i32.const 16
    i32.store
    i32.const 52
    i32.const 32
    i32.store

    i32.const 1
    i32.const 48
    i32.const 1
    i32.const 56
    call $fd_write
    drop

    i32.const 0
    call $proc_exit
  )
)
