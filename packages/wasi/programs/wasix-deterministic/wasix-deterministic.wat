;; Hand-rolled WASIX determinism smoke test.
;;
;; Calls random_get for 8 bytes and clock_time_get(REALTIME) for 8 bytes,
;; then writes all 16 bytes to stdout as a 32-character lowercase hex string
;; via fd_write. Hex-encoding (rather than raw bytes) keeps the byte sequence
;; intact through TextDecoder so the spec can pin a golden string.
;; Playwright runs this binary under FixedClockProvider(0n) +
;; SeededRandomProvider(42) and asserts the exact hex output.
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
  ;;   offset  8 – 15 : clock_time_get result (u64 little-endian, 8 bytes)
  ;;   offset 16 – 47 : hex-encoded output (32 ASCII chars)
  ;;   offset 48 – 51 : iov[0].buf  (u32) — pointer to hex output (= 16)
  ;;   offset 52 – 55 : iov[0].len  (u32) — 32 bytes
  ;;   offset 56 – 59 : nwritten    (u32)
  ;;   offset 64 – 79 : "0123456789abcdef" hex digit table

  (data (i32.const 64) "0123456789abcdef")

  (func $start
    (local $i i32)        ;; loop index over 16 input bytes
    (local $b i32)        ;; current byte
    (local $hi i32)       ;; high nibble
    (local $lo i32)       ;; low nibble

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

    ;; Hex-encode 16 input bytes (offset 0..15) into 32 ASCII chars (offset 16..47).
    ;; for (i = 0; i < 16; i++) {
    ;;   b  = mem[i];
    ;;   hi = b >> 4;
    ;;   lo = b & 0xf;
    ;;   mem[16 + i*2]     = hex_table[hi];
    ;;   mem[16 + i*2 + 1] = hex_table[lo];
    ;; }
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

        ;; mem[16 + i*2] = mem[64 + hi]
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

        ;; mem[16 + i*2 + 1] = mem[64 + lo]
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

    ;; Set up iov: buf_ptr=16, buf_len=32
    i32.const 48
    i32.const 16
    i32.store
    i32.const 52
    i32.const 32
    i32.store

    ;; fd_write(fd=1, iovs=48, iovs_len=1, nwritten=56)
    i32.const 1
    i32.const 48
    i32.const 1
    i32.const 56
    call $fd_write
    drop

    ;; Exit 0
    i32.const 0
    call $proc_exit
  )
)
