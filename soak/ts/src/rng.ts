/** mulberry32: a seeded 32-bit generator, so a run is reproduced by its seed. */
export function rng(seed: number): { next(): number; int(lo: number, hi: number): number; pick<T>(a: readonly T[]): T; chance(p: number): boolean } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (a2) => a2[Math.floor(next() * a2.length)]!,
    chance: (p) => next() < p,
  };
}
