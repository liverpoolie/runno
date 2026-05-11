;; WASIX guest exercising the chunked fdRead path in the Slice 4.1 FS bridge
;; worker shim. The shim splits a single read iovec larger than ~60 KiB
;; (default chunk limit) across multiple SAB round trips, so a 100_000-byte
;; iovec proves the per-buf cumulative-offset tracking is correct.
;;
;; Calls `fd_read(fd=5, iovs=0, iovs_len=1, retptr=8)` with one iovec that
;; describes a 100_000-byte buffer at memory offset 32. The async
;; FileSystemProvider on the main thread fills each batch with a known
;; pattern (`byte[file_offset] = (file_offset + 1) mod 256`). After the call
;; the guest verifies:
;;   - rc == SUCCESS (else exit 1)
;;   - retptr value == 100_000 (else exit 2 — short read or stuck-at-chunk)
;;   - byte at file offset 0     == 1     (else exit 3)
;;   - byte at file offset 40000 == 65    (else exit 4 — bug zero-fills here)
;;   - byte at file offset 99999 == 160   (else exit 5)
;; Exit 0 on every check passing.
;;
;; Build: wat2wasm wasix-bridge-fs-chunked-read.wat -o wasix-bridge-fs-chunked-read.wasm

(module
  ;; Use the wasix_32v1 namespace for fd_read so the call routes through the
  ;; WASIX provider (and thus the worker FS bridge), not the wasi_preview1
  ;; in-memory drive. proc_exit is fine from either namespace — the WASIX
  ;; instance overrides both.
  (import "wasix_32v1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  ;; 4 pages = 256 KiB — plenty for one 100_000-byte buffer plus headers.
  (memory (;0;) 4)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  (func $start
    (local $rc i32)

    ;; iovec[0].buf = 32
    i32.const 0
    i32.const 32
    i32.store

    ;; iovec[0].buf_len = 100000
    i32.const 4
    i32.const 100000
    i32.store

    ;; fd_read(fd=5, iovs=0, iovs_len=1, retptr=8)
    i32.const 5
    i32.const 0
    i32.const 1
    i32.const 8
    call $fd_read
    local.set $rc

    ;; rc != SUCCESS → exit 1
    local.get $rc
    if
      i32.const 1
      call $proc_exit
    end

    ;; retptr != 100000 → exit 2
    i32.const 8
    i32.load
    i32.const 100000
    i32.ne
    if
      i32.const 2
      call $proc_exit
    end

    ;; byte[32+0] != 1 → exit 3
    i32.const 32
    i32.load8_u
    i32.const 1
    i32.ne
    if
      i32.const 3
      call $proc_exit
    end

    ;; byte[32+40000] != 65 → exit 4  (boundary right after first chunk)
    i32.const 40032
    i32.load8_u
    i32.const 65
    i32.ne
    if
      i32.const 4
      call $proc_exit
    end

    ;; byte[32+99999] != 160 → exit 5  (last byte of the 100_000-byte read)
    i32.const 100031
    i32.load8_u
    i32.const 160
    i32.ne
    if
      i32.const 5
      call $proc_exit
    end

    i32.const 0
    call $proc_exit
  )
)
