// SystemRandomProvider: browser-native random using crypto.getRandomValues.
// Processes the buffer in 65536-byte chunks (the maximum chunk size accepted
// by crypto.getRandomValues per call).

import type { RandomProvider } from "../providers.js";

const MAX_CHUNK = 65536;

export class SystemRandomProvider implements RandomProvider {
  fill(buf: Uint8Array): void {
    for (let offset = 0; offset < buf.length; offset += MAX_CHUNK) {
      crypto.getRandomValues(buf.subarray(offset, offset + MAX_CHUNK));
    }
  }
}
