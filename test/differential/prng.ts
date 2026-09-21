/**
 * Deterministic PRNG (mulberry32) used by the differential test harness.
 *
 * Pure 32-bit integer arithmetic only: no Math.random, no Date, no
 * platform-dependent behaviour, so a fixed seed produces the same case
 * sequence on every Node minor version and in every browser.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next unsigned 32-bit integer. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + (this.next() % (max - min + 1));
  }

  /** True with probability p. */
  bool(p: number): boolean {
    return this.next() / 0x100000000 < p;
  }

  /** Uniformly pick one element. */
  pick<T>(items: readonly T[]): T {
    return items[this.next() % items.length];
  }
}
