// Seeded PRNG (mulberry32) shared by the entire sim so replays reproduce
// every Math.random()-driven decision from a single 32-bit seed.
//
// TWO independent streams, by design:
//   - GAMEPLAY (`rng`): anything that affects the simulation's outcome — spawn
//     positions, kind/size rolls, wave events, split child counts/velocities.
//     A replay re-sims by drawing the SAME sequence from this stream, so its
//     draw count must be identical frame-for-frame.
//   - COSMETIC (`cosmeticRng`): per-entity visual flavour only — crack patterns,
//     shape-fork counts, hues, weave/curve. These draw a VARIABLE number of
//     values per entity, so routing them through the gameplay stream shifts every
//     downstream gameplay draw and desyncs the replay (see replay-resim notes).
//     Kept on their own stream they can vary freely without touching gameplay.
//   - AUDIO PICKS (`audioRng`): audible choices made from sim code — the halo
//     music variation and its 24x swap, the full-halo song and its rollover,
//     the Pilot's Log take. Render code also draws from the cosmetic stream, at
//     whatever rate the display refreshes, so a pick made through it differed
//     between the original run, a replay on another display and the export.
//     This stream is drawn only by those picks, whose count is fixed by the sim,
//     so all three hear the same music.
// All three are seeded from the run seed at startGame, so replays reproduce the
//   same visuals and the same music — the cosmetic draws just can't perturb the
//   gameplay draw sequence anymore.

let state = (Math.random() * 0x100000000) >>> 0;
let cosmeticState = (Math.random() * 0x100000000) >>> 0;
let audioState = (Math.random() * 0x100000000) >>> 0;

const mulberry32 = (s: number): { value: number; next: number } => {
  let t = (s + 0x6D2B79F5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, next };
};

export const seedRng = (seed: number): void => {
  state = seed >>> 0;
  // Derive the cosmetic seed from the same run seed (xor a constant so the two
  //   streams don't march in lockstep) — deterministic, but independent.
  cosmeticState = (state ^ 0x9E3779B9) >>> 0;
  audioState = (state ^ 0x7F4A7C15) >>> 0;
};

export const getRngSeed = (): number => state;

export const rng = (): number => {
  const { value, next } = mulberry32(state);
  state = next;
  return value;
};

// Cosmetic-only draw. NEVER call this from code whose result changes the
//   simulation (positions, counts, scoring, collisions) — only from visual
//   generation (cracks, hues, shape jitter). See the stream note above.
export const cosmeticRng = (): number => {
  const { value, next } = mulberry32(cosmeticState);
  cosmeticState = next;
  return value;
};

export const audioRng = (): number => {
  const { value, next } = mulberry32(audioState);
  audioState = next;
  return value;
};

export const rngInt = (nExclusive: number): number => Math.floor(rng() * nExclusive);

export const rngRange = (min: number, max: number): number => min + rng() * (max - min);

export const rngPick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
