/**
 * Deterministic RNG. The whole world derives from one seed, so a given seed
 * always replays to the same history. Never use Math.random() in the engine.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Approximately normal, mean 0 sd 1 (sum of 3 uniforms). */
  normal(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }

  /** Poisson-ish integer draw around a mean, for small counts. */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    if (mean > 20) return Math.max(0, Math.round(mean + this.normal() * Math.sqrt(mean)));
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }
}

/** Stable hash → seed, so sub-systems can fork independent streams from one world seed. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  const str = parts.join(":");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
