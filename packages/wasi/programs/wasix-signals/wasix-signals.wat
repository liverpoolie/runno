;; Hand-rolled WASIX signals smoke test.
;;
;; Mirrors the slice-6 hand-rolled threads/futex smoke style. Exercises
;; the synchronous-delivery contract of `proc_raise`:
;;
;;   1. Register a handler via `callback_signal("signal_handler", 14)` —
;;      the universal-callback slot. SelfSignalProvider keys this on
;;      signo === 0, which falls back when no per-signal handler is
;;      registered for the raised signo.
;;   2. Call `proc_raise(SIGINT=2)`. The runtime must invoke
;;      `signal_handler(2)` synchronously inside the syscall frame —
;;      the handler runs to completion before `proc_raise` returns.
;;   3. The handler bumps a u32 counter at offset 0; the assertion
;;      after `proc_raise` returns reads the counter and exits
;;      0 only if it equals 1.
;;
;; Exit codes:
;;   0  — handler ran exactly once before proc_raise returned (golden path).
;;   1  — proc_raise returned non-zero errno (SUCCESS expected).
;;   2  — counter != 1 (handler not invoked synchronously, or invoked twice).
;;
;; Build: wat2wasm wasix-signals.wat -o wasix-signals.wasm
;;
;; WAT rather than cargo-wasix: cargo-wasix is not available in this repo.

(module
  ;; callback_signal(name_ptr: i32, name_len: i32) -> i32
  (import "wasix_32v1" "callback_signal"
    (func $callback_signal (param i32 i32) (result i32)))
  ;; proc_raise(signo: i32) -> i32
  (import "wasix_32v1" "proc_raise"
    (func $proc_raise (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))
  (export "signal_handler" (func $signal_handler))

  ;; Memory layout:
  ;;   offset 0 – 3 : counter (u32, bumped by signal_handler).
  ;;   offset 4 – 5 : "signal_handler" name bytes (14 chars, big-endian
  ;;                  text — see below). Stored at offset 32 to avoid
  ;;                  overlapping the counter.
  ;;
  ;; "signal_handler" = 14 bytes ASCII. Place at offset 32.
  (data (i32.const 32) "signal_handler")

  ;; Universal callback. wasix-libc would normally hand this an i32 signo
  ;; argument; for synchronous delivery we accept it and bump the counter.
  ;; (signo: i32) -> ()
  (func $signal_handler (param $signo i32)
    i32.const 0
    i32.const 0
    i32.load
    i32.const 1
    i32.add
    i32.store
  )

  (func $start
    ;; ── callback_signal("signal_handler", 14) ────────────────────────
    i32.const 32  ;; name_ptr
    i32.const 14  ;; name_len
    call $callback_signal
    ;; If non-zero, exit 1. Discard otherwise.
    i32.const 0
    i32.eq
    i32.eqz
    if
      i32.const 1
      call $proc_exit
      unreachable
    end

    ;; ── proc_raise(SIGINT=2) ────────────────────────────────────────
    i32.const 2
    call $proc_raise
    ;; If non-zero errno, exit 1.
    i32.const 0
    i32.eq
    i32.eqz
    if
      i32.const 1
      call $proc_exit
      unreachable
    end

    ;; ── assert counter == 1 ─────────────────────────────────────────
    i32.const 0
    i32.load
    i32.const 1
    i32.eq
    i32.eqz
    if
      i32.const 2
      call $proc_exit
      unreachable
    end

    ;; success
    i32.const 0
    call $proc_exit
  )
)
