export type Vec = { x: number; y: number };

// The torus is exactly one viewport: world coords live in [0,W)x[0,H).
export const WORLD_W = 1920;
export const WORLD_H = 1080;

export const v = (x: number, y: number): Vec => ({ x, y });

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec): number => Math.hypot(a.x, a.y);

export const fromAngle = (theta: number, mag = 1): Vec => ({
  x: Math.cos(theta) * mag,
  y: Math.sin(theta) * mag,
});

export const wrap = (a: Vec, w: number, h: number): Vec => ({
  x: ((a.x % w) + w) % w,
  y: ((a.y % h) + h) % h,
});

// Shortest separation on the torus: each axis folds to within a half-world.
export const toroidalDelta = (dx: number, dy: number, w: number, h: number): [number, number] =>
  [dx - Math.round(dx / w) * w, dy - Math.round(dy / h) * h];

// The image (unfolded copy) of `p` nearest to `ref` on the torus.
export const nearestImageOf = (p: Vec, ref: Vec, w: number, h: number): Vec => {
  const [dx, dy] = toroidalDelta(p.x - ref.x, p.y - ref.y, w, h);
  return { x: ref.x + dx, y: ref.y + dy };
};

// Toroidal (world ≡ viewport) — these funnel nearly all cross-entity
// proximity tests, so distance is measured across the seam automatically.
export const dist = (a: Vec, b: Vec): number => {
  const [dx, dy] = toroidalDelta(a.x - b.x, a.y - b.y, WORLD_W, WORLD_H);
  return Math.hypot(dx, dy);
};

// Circle-vs-circle overlap test for round-hitbox entities (pickups, comets,
// aliens). Entities with an angle-aware silhouette (Asteroid) sample their
// own surface instead.
export const circleHit = (center: Vec, radius: number, point: Vec, pointRadius: number): boolean =>
  dist(center, point) < radius + pointRadius;

// Mutating variants — for per-frame hot paths (entity update loops, particles)
// where the functional helpers' fresh {x,y} object per call dominates GC.
// `addScaledMut(a, b, s)` does `a += b * s`. `addMut(a, b)` does `a += b`.
// `scaleMut(a, s)` does `a *= s`. `wrapMut(a, w, h)` wraps `a` in place.
export const addMut = (a: Vec, b: Vec): void => { a.x += b.x; a.y += b.y; };
export const addScaledMut = (a: Vec, b: Vec, s: number): void => {
  a.x += b.x * s;
  a.y += b.y * s;
};
export const scaleMut = (a: Vec, s: number): void => { a.x *= s; a.y *= s; };
// Returns the applied fold offset (folded = old + offset) so callers can
// shift position-history buffers alongside; null when nothing folded (the
// common case — avoids a per-frame allocation).
export const wrapMut = (a: Vec, w: number, h: number): { x: number; y: number } | null => {
  const x = ((a.x % w) + w) % w;
  const y = ((a.y % h) + h) % h;
  if (x === a.x && y === a.y) return null;
  const off = { x: x - a.x, y: y - a.y };
  a.x = x;
  a.y = y;
  return off;
};

export const TAU = Math.PI * 2;

import { rng, cosmeticRng } from "./game/rng";

export const rand = (min: number, max: number): number => min + rng() * (max - min);
export const randInt = (min: number, max: number): number => Math.floor(rand(min, max + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

// Cosmetic-stream twins of rand/randInt/pick — for visual-only randomness that
//   must not consume gameplay-rng draws (cracks, shape jitter, hues). See rng.ts.
export const cosmeticRand = (min: number, max: number): number => min + cosmeticRng() * (max - min);
export const cosmeticRandInt = (min: number, max: number): number => Math.floor(cosmeticRand(min, max + 1));
