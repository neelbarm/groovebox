/**
 * Deterministic pseudo-random numbers.
 *
 * Every musical decision in groovebox is driven by one of these, so a given
 * seed always produces a byte-identical render. `mulberry32` is a tiny, fast,
 * well-distributed 32-bit generator; `xmur3` turns arbitrary strings into a
 * seed so we can fork independent-but-reproducible streams per instrument.
 */

/** Hash a string into a 32-bit seed (xmur3). */
export function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Weighted choice. `weights` must be the same length as `items` and sum > 0. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i] ?? 0);
      if (r <= 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /** A derived, independent stream. Same parent + label => same child stream. */
  fork(label: string): Rng {
    return new Rng((xmur3(label) ^ Math.floor(this.next() * 0xffffffff)) >>> 0);
  }
}

/** Convenience: build a top-level stream from a numeric seed and a label. */
export function streamFor(seed: number, label: string): Rng {
  return new Rng((Math.imul(seed >>> 0, 2654435761) ^ xmur3(label)) >>> 0);
}
