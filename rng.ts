// Tiny deterministic PRNG, used exactly once per run (at createInitialState)
// to pick which power families this run exposes. Keeping randomness here and
// out of step() means the rules engine stays a pure function of
// (state, input, dt) --- a fixed seed reproduces an entire run.

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickIndex<T>(rng: Rng, items: readonly T[]): number {
  return Math.floor(rng() * items.length) % items.length;
}
