;; Tiny WASIX guest for the Slice 4 bridge unit spec.
;;
;; Calls `clock_time_get(MONOTONIC=1)` once, then exits with the low 8 bits
;; of the returned nanosecond value. The spec configures an async
;; `ClockProvider` on `WASIXWorkerHost` whose `now()` returns a
;; `Promise<bigint>` that resolves to `42n` after a `setTimeout(0)`. If the
;; bridge round trip works end to end, the guest exits with 42 — proof that
;; the async provider on the main thread was called, its Promise awaited,
;; and the value delivered to the worker-side guest synchronously.
;;
;; Build: wat2wasm wasix-bridge-clock.wat -o wasix-bridge-clock.wasm

(module
  (import "wasix_32v1" "clock_time_get"
    (func $clock_time_get (param i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  (func $start
    (local $t i64)

    ;; clock_time_get(MONOTONIC=1, precision=0, retptr=0). Ignore return.
    i32.const 1
    i64.const 0
    i32.const 0
    call $clock_time_get
    drop

    ;; Load the bigint written at offset 0 (little-endian u64).
    i32.const 0
    i64.load
    local.set $t

    ;; Mask to low 8 bits and exit with that value.
    local.get $t
    i64.const 0xff
    i64.and
    i32.wrap_i64
    call $proc_exit
  )
)
