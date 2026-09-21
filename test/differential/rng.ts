// Deterministic pseudo-random source for the differential fuzzer.
//
// mulberry32 is a tiny integer-only PRNG. It is implemented here instead of
// relying on Math.random(), Date, crypto, or Array.prototype.sort() without an
// explicit comparator, so the generated case sequence is byte-for-byte
// identical regardless of file enumeration order, locale, platform, or Node
// minor version.

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Coerce the seed to an unsigned 32-bit integer.
    this.state = seed >>> 0;
  }

  // Uniform float in [0, 1), identical to the reference mulberry32 algorithm.
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Uniform integer in [min, max] inclusive.
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  bool(): boolean {
    return this.next() < 0.5;
  }
}
