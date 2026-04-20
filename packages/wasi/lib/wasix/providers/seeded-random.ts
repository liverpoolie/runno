// SeededRandomProvider: deterministic PRNG for testing and simulation.
//
// Uses SFC32 (Small Fast Counting, 32-bit variant) — a high-quality PRNG
// whose output depends only on integer arithmetic, making it identical across
// all JavaScript engines. The algorithm is fully specified as:
//   t = (a + b + counter) >>> 0
//   counter = (counter + 1) >>> 0
//   a = b ^ (b >>> 9)
//   b = (c + (c << 3)) >>> 0
//   c = rotl32(c, 21) + t >>> 0
// Fifteen warm-up rounds are run after seeding to disperse low-entropy seeds.

import type { RandomProvider } from "../providers.js";

export class SeededRandomProvider implements RandomProvider {
  private a: number;
  private b: number;
  private c: number;
  private counter: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
    this.b = seed >>> 0;
    this.c = seed >>> 0;
    this.counter = 1;
    for (let i = 0; i < 15; i++) this.next();
  }

  private next(): number {
    const t = (this.a + this.b + this.counter) >>> 0;
    this.counter = (this.counter + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) >>> 0;
    return t;
  }

  fill(buf: Uint8Array): void {
    for (let i = 0; i < buf.length; i += 4) {
      const v = this.next();
      buf[i] = v & 0xff;
      if (i + 1 < buf.length) buf[i + 1] = (v >>> 8) & 0xff;
      if (i + 2 < buf.length) buf[i + 2] = (v >>> 16) & 0xff;
      if (i + 3 < buf.length) buf[i + 3] = (v >>> 24) & 0xff;
    }
  }
}
