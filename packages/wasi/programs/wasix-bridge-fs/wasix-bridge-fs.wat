;; Tiny WASIX guest for the Slice 4.1 FS bridge unit spec.
;;
;; Calls `fd_prestat_get(fd=3, retptr=0)` once on the preopen fd. The spec
;; configures an `AsyncFileSystemProvider` on `WASIXWorkerHost` whose
;; `fdPrestatGet` returns `Promise.resolve({ name: "/probe" })` after a
;; `setTimeout(0)`. If the bridge round trip works end to end:
;;   - the host dispatcher receives the FS_FD_PRESTAT_GET request,
;;   - awaits the Promise,
;;   - encodes the prestat into the response region,
;;   - the worker-side shim decodes it,
;;   - wasix.ts writes the prestat struct into guest memory,
;;   - returns SUCCESS (0).
;;
;; The guest then calls fd_prestat_dir_name(fd=3, bufPtr=16, bufLen=6) to
;; exercise a string-returning opcode and exits with the SUCCESS code from
;; whichever call returns nonzero first (so a failure on either leg shows
;; up as a non-zero exit).
;;
;; Build: wat2wasm wasix-bridge-fs.wat -o wasix-bridge-fs.wasm

(module
  (import "wasi_snapshot_preview1" "fd_prestat_get"
    (func $fd_prestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name"
    (func $fd_prestat_dir_name (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory (;0;) 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  (func $start
    (local $rc i32)

    ;; fd_prestat_get(fd=3, retptr=0). Writes an 8-byte prestat record to
    ;; offset 0: byte 0 = tag (0 = dir), bytes 4..8 = name byte length.
    i32.const 3
    i32.const 0
    call $fd_prestat_get
    local.set $rc
    local.get $rc
    i32.const 0
    i32.ne
    if
      local.get $rc
      call $proc_exit
    end

    ;; fd_prestat_dir_name(fd=3, bufPtr=16, bufLen=6). Writes "/probe" to
    ;; bytes [16, 22).
    i32.const 3
    i32.const 16
    i32.const 6
    call $fd_prestat_dir_name
    local.set $rc
    local.get $rc
    call $proc_exit
  )
)
