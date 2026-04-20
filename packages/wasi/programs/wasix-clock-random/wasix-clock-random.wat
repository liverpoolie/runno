;; Hand-rolled WASIX clock + random smoke test.
;;
;; Exercises clock_time_get(MONOTONIC) twice — asserts the second reading is
;; strictly greater than the first (exit code 1 on failure). Then exercises
;; random_get for 32 bytes — asserts at least one byte is non-zero (exit 2).
;;
;; Build: wat2wasm wasix-clock-random.wat -o wasix-clock-random.wasm
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
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; Memory layout:
  ;;   offset  0 –  7 : first  clock result (u64 little-endian)
  ;;   offset  8 – 15 : second clock result (u64 little-endian)
  ;;   offset 16 – 47 : 32-byte random buffer

  (func $start
    (local $t1    i64)
    (local $t2    i64)
    (local $i     i32)
    (local $sum   i32)

    ;; ── first clock_time_get(MONOTONIC=1, precision=0, retptr=0) ─────────
    i32.const 1
    i64.const 0
    i32.const 0
    call $clock_time_get
    drop

    ;; Spin ~5 000 000 iterations so wall time advances measurably even in
    ;; browsers (e.g. WebKit) that clamp performance.now() to 1 ms resolution.
    i32.const 0
    local.set $i
    block $burn_break
      loop $burn_loop
        local.get $i
        i32.const 5000000
        i32.ge_u
        br_if $burn_break
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $burn_loop
      end
    end

    ;; ── second clock_time_get(MONOTONIC=1, precision=0, retptr=8) ────────
    i32.const 1
    i64.const 0
    i32.const 8
    call $clock_time_get
    drop

    ;; ── assert t2 > t1 (exit 1 on failure) ───────────────────────────────
    i32.const 0
    i64.load
    local.set $t1
    i32.const 8
    i64.load
    local.set $t2

    local.get $t2
    local.get $t1
    i64.le_u
    if
      i32.const 1
      call $proc_exit
      unreachable
    end

    ;; ── random_get(buf=16, buf_len=32) ───────────────────────────────────
    i32.const 16
    i32.const 32
    call $random_get
    drop

    ;; ── assert at least one byte non-zero (exit 2 if all zeros) ──────────
    i32.const 0
    local.set $sum
    i32.const 0
    local.set $i
    block $check_break
      loop $check_loop
        local.get $i
        i32.const 32
        i32.ge_u
        br_if $check_break
        local.get $sum
        i32.const 16
        local.get $i
        i32.add
        i32.load8_u
        i32.or
        local.set $sum
        local.get $i
        i32.const 1
        i32.add
        local.set $i
        br $check_loop
      end
    end

    local.get $sum
    i32.eqz
    if
      i32.const 2
      call $proc_exit
      unreachable
    end

    ;; ── success ───────────────────────────────────────────────────────────
    i32.const 0
    call $proc_exit
  )
)
