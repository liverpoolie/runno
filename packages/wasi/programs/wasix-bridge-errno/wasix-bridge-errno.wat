;; Tiny WASIX guest for Slice-4 bridge error-path unit specs.
;;
;; Calls `clock_time_get(MONOTONIC=1)` once and exits with the syscall's
;; return code (the errno). The bridge unit spec configures a host
;; `ClockProvider.now()` that rejects with a specific WASIXError or a plain
;; Error so the test can assert the guest sees the right errno end to end:
;;
;;   - `new WASIXError(Result.EBADF=8)`  →  exit code 8
;;   - `new Error("boom")`               →  exit code 29 (Result.EIO)
;;
;; Build: wat2wasm wasix-bridge-errno.wat -o wasix-bridge-errno.wasm

(module
  (import "wasix_32v1" "clock_time_get"
    (func $clock_time_get (param i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  (func $start
    i32.const 1
    i64.const 0
    i32.const 0
    call $clock_time_get
    call $proc_exit
  )
)
