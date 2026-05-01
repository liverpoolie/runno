// Shared memory-marshalling helpers used by both the preview1 (`lib/wasi/`)
// and WASIX (`lib/wasix/`) syscall handlers. Only helpers that have
// genuinely-duplicated callers across both specs live here — ABI constants
// and per-spec struct encoders stay in their respective modules.

/**
 * Decode a UTF-8 string from linear memory at `ptr` of length `len`.
 *
 * Copies the bytes before decoding: when the underlying memory is a
 * SharedArrayBuffer (the threaded wasix-libc default), TextDecoder
 * rejects views over it. `.slice()` returns a Uint8Array backed by a
 * fresh non-shared ArrayBuffer.
 */
export function readString(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): string {
  return new TextDecoder().decode(
    new Uint8Array(memory.buffer, ptr, len).slice(),
  );
}

/**
 * Read an array of `{buf, len}` (iovec / ciovec) pairs from linear memory
 * and return Uint8Array views over the underlying buffers for convenient
 * read/write.
 */
export function readIOVectors(
  view: DataView,
  iovsPtr: number,
  iovsLen: number,
): Array<Uint8Array> {
  const result: Array<Uint8Array> = new Array(iovsLen);
  let ptr = iovsPtr;
  for (let i = 0; i < iovsLen; i++) {
    const bufferPtr = view.getUint32(ptr, true);
    ptr += 4;
    const bufferLen = view.getUint32(ptr, true);
    ptr += 4;
    result[i] = new Uint8Array(view.buffer, bufferPtr, bufferLen);
  }
  return result;
}
