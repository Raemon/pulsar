// Explosion/burst particles are purely visual AND draw a variable number of
//   values per call (loops over count) — exactly the case the rng.ts contract
//   says must use the cosmetic stream, or the per-burst draw count shifts every
//   downstream gameplay draw and desyncs replays. Aliased so call sites read clean.
import { Vec, fromAngle, cosmeticRand as rand, TAU } from "../vec";
import { ParticleSystem } from "../Particle";
import { Asteroid } from "../Asteroid";
import { Comet } from "../Comet";
import { Alien } from "../Alien";
import { Canister } from "../Canister";
import { Gem } from "../Gem";
import { Shard, shatterAsteroid } from "../Shard";

// every burst in the game shares this shape; differences live in tuning, not code structure.
export type BurstSpec = {
  pos: Vec;
  count: number;
  speedRange: [number, number];
  lifeRange: [number, number];
  maxLife: number;
  sizeRange: [number, number];
  hue: number;
  hueSpread: [number, number];
  drag: number;
  angleMode: "random" | "uniform";
  angleJitter: number;
};

// one emit-loop replaces ~8 duplicated Array.from + emit blocks across kill/pop sites.
export const emitBurst = (particles: ParticleSystem, s: BurstSpec) => {
  for (let i = 0; i < s.count; i++) {
    const angle = s.angleMode === "uniform"
      ? (i / s.count) * TAU + rand(-s.angleJitter, s.angleJitter)
      : rand(0, TAU);
    const speed = rand(s.speedRange[0], s.speedRange[1]);
    particles.emit({
      pos: { ...s.pos },
      vel: fromAngle(angle, speed),
      life: rand(s.lifeRange[0], s.lifeRange[1]),
      maxLife: s.maxLife,
      size: rand(s.sizeRange[0], s.sizeRange[1]),
      hue: s.hue + rand(s.hueSpread[0], s.hueSpread[1]),
      shrink: 1,
      drag: s.drag,
    });
  }
};

// gold ring shared by every on-beat impact so the rhythm bonus reads consistently.
const emitOnBeatSparkleRing = (particles: ParticleSystem, pos: Vec, count: number, speedRange: [number, number], lifeMax: number, sizeRange: [number, number], drag: number) => {
  emitBurst(particles, {
    pos, count,
    speedRange,
    lifeRange: [lifeMax * 0.5, lifeMax],
    maxLife: lifeMax,
    sizeRange,
    hue: 48, hueSpread: [-6, 12],
    drag,
    angleMode: "uniform", angleJitter: 0.05,
  });
};

// shards carry "rock physically breaks"; particles + sparkle reinforce on-beat rhythm credit.
export const emitExplosion = (particles: ParticleSystem, shards: Shard[], a: Asteroid, onBeat: boolean) => {
  for (const s of shatterAsteroid(a)) shards.push(s);
  const baseCount = a.size === "huge" ? 90 : a.size === "large" ? 60 : a.size === "medium" ? 40 : 24;
  emitBurst(particles, {
    pos: a.pos,
    count: onBeat ? Math.round(baseCount * 1.6) : baseCount,
    speedRange: [80, 320],
    lifeRange: [0.5, 1.4], maxLife: 1.4,
    sizeRange: [1, 2.6],
    hue: a.hue, hueSpread: [-15, 25],
    drag: 1.5,
    angleMode: "random", angleJitter: 0,
  });
  if (onBeat) {
    emitOnBeatSparkleRing(particles, a.pos, 18, [220, 360], 0.7, [1.6, 2.4], 1.8);
  }
};

// a shot too weak to break armour bounces off — a tight, bright spray fired back
// along the impact normal reads as "deflected" rather than "absorbed".
// A blocked shot doesn't chip the crystal, so the bounce has to carry the
// felt-impact on its own: a fan of sparks back along the surface normal plus a
// short ring of white-hot flecks at the contact point that read as a hard,
// non-damaging clang. `impact` (0..1) scales the spray width and brightness so
// a heavier blocked hit visibly hits harder.
export const emitBounceSparks = (particles: ParticleSystem, pos: Vec, normal: Vec, hue: number, impact = 0.5) => {
  const baseAngle = Math.atan2(normal.y, normal.x);
  const count = 9 + Math.round(impact * 8);
  for (let i = 0; i < count; i++) {
    const angle = baseAngle + rand(-0.8, 0.8);
    particles.emit({
      pos: { ...pos },
      vel: fromAngle(angle, rand(140, 320 + impact * 200)),
      life: rand(0.14, 0.34),
      maxLife: 0.34,
      size: rand(1.4, 2.6),
      hue: hue + rand(-10, 14),
      shrink: 1,
      drag: 4.5,
    });
  }
  // Contact flash — a tight ring of bright flecks at the point of impact, very
  // short-lived and densely overlapping so additive blending stacks them to a
  // white-hot core. Sells the metallic "clang" without dust/debris.
  const flecks = 5 + Math.round(impact * 6);
  for (let i = 0; i < flecks; i++) {
    particles.emit({
      pos: { ...pos },
      vel: fromAngle(rand(0, TAU), rand(40, 120)),
      life: rand(0.06, 0.16),
      maxLife: 0.16,
      size: rand(1.6, 3.0),
      hue: hue + rand(-6, 6),
      shrink: 1,
      drag: 7.0,
    });
  }
};

// heavier dark debris reads "cracked, not killed" — distinguishes a chip from a kill.
export const emitCrackParticles = (particles: ParticleSystem, a: Asteroid, onBeat: boolean) => {
  emitBurst(particles, {
    pos: a.pos,
    count: onBeat ? 14 : 9,
    speedRange: [60, 180],
    lifeRange: [0.35, 0.7], maxLife: 0.7,
    sizeRange: [1.6, 2.8],
    hue: a.hue, hueSpread: [-8, 12],
    drag: 3.0,
    angleMode: "random", angleJitter: 0,
  });
  if (onBeat) {
    emitOnBeatSparkleRing(particles, a.pos, 8, [140, 220], 0.5, [1.4, 2.0], 2.2);
  }
};

// sparks + slow dust cloud reads "celestial" — distinguishes comet kill from rock
// kill. Burst counts + spread scale with the body (a scale-0.45 meteor throws a
// proportionally smaller gout than a full comet), so a whole shower detonating at
// once doesn't dump a full-comet spray per member.
export const emitCometExplosion = (particles: ParticleSystem, c: Comet) => {
  const s = c.scale;
  emitBurst(particles, {
    pos: c.pos, count: Math.round(90 * s),
    speedRange: [160 * s, 520 * s],
    lifeRange: [0.6, 1.6], maxLife: 1.6,
    sizeRange: [1.4, 2.8],
    hue: c.hue, hueSpread: [-15, 25],
    drag: 1.2,
    angleMode: "random", angleJitter: 0,
  });
  emitBurst(particles, {
    pos: c.pos, count: Math.round(40 * s),
    speedRange: [40 * s, 180 * s],
    lifeRange: [1.5, 3.0], maxLife: 3.0,
    sizeRange: [2.0, 3.4],
    hue: c.hue, hueSpread: [-40, 40],
    drag: 0.7,
    angleMode: "random", angleJitter: 0,
  });
};

// count scales with size so a 4-HP big saucer's death feels meatier than a 1-HP small one's.
export const emitAlienExplosion = (particles: ParticleSystem, a: Alien) => {
  const count = a.size === "big" ? 70 : a.size === "medium" ? 48 : 30;
  emitBurst(particles, {
    pos: a.pos, count,
    speedRange: [80, 340],
    lifeRange: [0.5, 1.2], maxLife: 1.2,
    sizeRange: [1, 2.6],
    hue: a.hue, hueSpread: [-15, 25],
    drag: 1.4,
    angleMode: "random", angleJitter: 0,
  });
};

// white = "wasted pod"; tints the destruction differently from the celebratory pickup burst.
// Also used for off-beat gem shots, so accepts any object with a position.
export const emitCanisterPop = (particles: ParticleSystem, c: { pos: Vec }) => {
  emitBurst(particles, {
    pos: c.pos, count: 30,
    speedRange: [120, 320],
    lifeRange: [0.4, 0.9], maxLife: 0.9,
    sizeRange: [1.2, 2.4],
    hue: 0, hueSpread: [0, 0],
    drag: 1.8,
    angleMode: "random", angleJitter: 0,
  });
};

// Shot-down alien bullet pops in its own hue — fast hot spray so the player
// reads "I cancelled that shot" rather than a generic white puff.
export const emitAlienBulletPop = (particles: ParticleSystem, pos: Vec, hue: number) => {
  emitBurst(particles, {
    pos, count: 18,
    speedRange: [140, 360],
    lifeRange: [0.25, 0.6], maxLife: 0.6,
    sizeRange: [1.2, 2.6],
    hue, hueSpread: [-12, 24],
    drag: 2.2,
    angleMode: "random", angleJitter: 0,
  });
};

// canister-hue tint makes each pickup kind read visually distinct (vs. white "wasted" burst).
export const emitCanisterPickup = (particles: ParticleSystem, c: Canister) => {
  emitBurst(particles, {
    pos: c.pos, count: 36,
    speedRange: [80, 260],
    lifeRange: [0.5, 1.0], maxLife: 1.0,
    sizeRange: [1.4, 2.6],
    hue: c.hue, hueSpread: [-10, 20],
    drag: 1.6,
    angleMode: "random", angleJitter: 0,
  });
};

// Cyan splash for a fuel orb pickup — same shape as the canister burst, tinted
// to the orb's coolant hue so it reads as "fuel grabbed", not a powerup.
export const emitFuelOrbPickup = (particles: ParticleSystem, pos: Vec, hue: number) => {
  emitBurst(particles, {
    pos, count: 32,
    speedRange: [70, 230],
    lifeRange: [0.5, 1.1], maxLife: 1.1,
    sizeRange: [1.4, 2.8],
    hue, hueSpread: [-8, 12],
    drag: 1.5,
    angleMode: "random", angleJitter: 0,
  });
};

// Bigger, slower-fading gold burst for the crystal pickup — reads as a richer
// reward than the standard canister pickup since the player had to spot the
// embedded crystal in the first place.
export const emitGemPickup = (particles: ParticleSystem, g: Gem) => {
  emitBurst(particles, {
    pos: g.pos, count: 56,
    speedRange: [120, 340],
    lifeRange: [0.7, 1.4], maxLife: 1.4,
    sizeRange: [1.6, 3.0],
    hue: g.hue, hueSpread: [-6, 14],
    drag: 1.4,
    angleMode: "random", angleJitter: 0,
  });
};

// uniformly spaced ring reads as a deflected wavefront, not a chaotic kill explosion.
export const emitShieldPop = (particles: ParticleSystem, pos: Vec) => {
  emitBurst(particles, {
    pos, count: 28,
    speedRange: [180, 260],
    lifeRange: [0.35, 0.65], maxLife: 0.65,
    sizeRange: [1.6, 2.4],
    hue: 200, hueSpread: [-8, 12],
    drag: 1.8,
    angleMode: "uniform", angleJitter: 0,
  });
};

// cyan-leaning hue ties debris to the ship's own hull palette so it reads as personal loss.
export const emitShipDebris = (particles: ParticleSystem, pos: Vec) => {
  emitBurst(particles, {
    pos, count: 70,
    speedRange: [60, 280],
    lifeRange: [0.7, 1.6], maxLife: 1.6,
    sizeRange: [1.2, 2.6],
    hue: 195, hueSpread: [-10, 30],
    drag: 1.2,
    angleMode: "random", angleJitter: 0,
  });
};

// Glass-prison shatter: a quick outward ring of pale-blue glass chips +
// a slower expanding cloud of dark purple wisps (the captive's breath
// escaping). Two layers so the impact reads as both "the shell broke"
// and "something just got out".
export const emitGlassPrisonShatter = (particles: ParticleSystem, shards: Shard[], a: Asteroid) => {
  // Physical Shard objects — the prison's shell is real glass that should
  // break into chunks rather than only fading particles.
  for (const s of shatterAsteroid(a)) shards.push(s);
  // (1) Bright glass shards — pale indigo, fast, short-lived.
  emitBurst(particles, {
    pos: a.pos, count: 70,
    speedRange: [180, 480],
    lifeRange: [0.5, 1.1], maxLife: 1.1,
    sizeRange: [1.2, 2.6],
    hue: a.hue, hueSpread: [-12, 18],
    drag: 1.6,
    angleMode: "random", angleJitter: 0,
  });
  // (2) Dark exhale — slow, deep purple wisps. Different drag so they
  // bloom outward and linger after the bright shards have faded.
  emitBurst(particles, {
    pos: a.pos, count: 36,
    speedRange: [40, 140],
    lifeRange: [1.4, 2.4], maxLife: 2.4,
    sizeRange: [2.4, 3.6],
    hue: 290, hueSpread: [-12, 18],
    drag: 0.7,
    angleMode: "random", angleJitter: 0,
  });
};

// Wraith death: no bright sparks — a dispersing cloud of dark purple wisps
// that drift outward then dissolve. Reads as "it came apart" rather than
// "it exploded".
export const emitWraithDeath = (particles: ParticleSystem, a: Asteroid) => {
  emitBurst(particles, {
    pos: a.pos, count: 50,
    speedRange: [60, 200],
    lifeRange: [1.0, 2.2], maxLife: 2.2,
    sizeRange: [2.0, 3.4],
    hue: a.hue, hueSpread: [-16, 24],
    drag: 1.0,
    angleMode: "random", angleJitter: 0,
  });
  // A faint reddish flicker at the centre — the eyes going out.
  emitBurst(particles, {
    pos: a.pos, count: 14,
    speedRange: [40, 120],
    lifeRange: [0.4, 0.9], maxLife: 0.9,
    sizeRange: [1.4, 2.4],
    hue: 0, hueSpread: [-10, 18],
    drag: 1.8,
    angleMode: "random", angleJitter: 0,
  });
};

// outward-radiating sparks sell the shockwave as physical mass, not a pure light effect.
export const emitShockwaveSparks = (particles: ParticleSystem, pos: Vec) => {
  emitBurst(particles, {
    pos, count: 64,
    speedRange: [280, 520],
    lifeRange: [0.5, 1.1], maxLife: 1.1,
    sizeRange: [1.4, 2.6],
    hue: 200, hueSpread: [-10, 20],
    drag: 0.9,
    angleMode: "random", angleJitter: 0,
  });
};

// Where a laser beam connects with a target — layered ON TOP of that target's
// normal kill/crack burst so a beam strike reads hotter than a bullet's. Two
// stacked rings: a tight white-hot flash core (additive overlap → blown-out
// centre) plus a wider cyan plasma spray kicked back along the beam direction,
// so the hit looks like superheated material blasting off the surface. `tier`
// (0..1 charge ramp) scales count, speed, and spread so a max-charge beam
// throws a far bigger gout than a tap. Cosmetic-only (cosmetic rng) → replay-safe.
export const emitLaserImpact = (particles: ParticleSystem, pos: Vec, dir: Vec, tier: number) => {
  const back = Math.atan2(-dir.y, -dir.x); // spray back toward the muzzle
  // White-hot contact flash — dense, short, slow so additive stacking whites out.
  const flecks = 7 + Math.round(tier * 10);
  for (let i = 0; i < flecks; i++) {
    particles.emit({
      pos: { ...pos },
      vel: fromAngle(rand(0, TAU), rand(30, 110 + tier * 90)),
      life: rand(0.06, 0.18),
      maxLife: 0.18,
      size: rand(2.0, 3.4 + tier * 1.4),
      hue: 190 + rand(-8, 8),
      shrink: 1,
      drag: 6.5,
    });
  }
  // Plasma spray — a fan of fast cyan-white sparks kicked back along the beam,
  // wider and faster with charge so the gout reads as "the beam blew a chunk off".
  const spray = 10 + Math.round(tier * 18);
  const spread = 0.7 + tier * 0.5;
  for (let i = 0; i < spray; i++) {
    particles.emit({
      pos: { ...pos },
      vel: fromAngle(back + rand(-spread, spread), rand(160, 360 + tier * 320)),
      life: rand(0.18, 0.5 + tier * 0.3),
      maxLife: 0.5 + tier * 0.3,
      size: rand(1.4, 2.8 + tier * 1.2),
      hue: 195 + rand(-12, 18),
      shrink: 1,
      drag: 2.6,
    });
  }
};

// A bomb's detonation: an even ring of sparks that coasts out to (about) the
// blast radius and fades there, tracing the reach the player saw the mine's ring
// promise, plus a hot scatter at the centre. Coasting under drag d for life t
// covers v0·(1 − e^(−d·t))/d, so the ring speed is solved from the radius.
const BOMB_BLAST_RING_DRAG = 6;
const BOMB_BLAST_RING_LIFE = 0.45;
export const emitBombBlast = (particles: ParticleSystem, pos: Vec, hue: number, radius: number) => {
  const ringSpeed = (radius * BOMB_BLAST_RING_DRAG) / (1 - Math.exp(-BOMB_BLAST_RING_DRAG * BOMB_BLAST_RING_LIFE));
  emitBurst(particles, {
    pos, count: 48,
    speedRange: [ringSpeed * 0.97, ringSpeed * 1.03],
    lifeRange: [BOMB_BLAST_RING_LIFE * 0.9, BOMB_BLAST_RING_LIFE], maxLife: BOMB_BLAST_RING_LIFE,
    sizeRange: [1.6, 2.6],
    hue, hueSpread: [-8, 12],
    drag: BOMB_BLAST_RING_DRAG,
    angleMode: "uniform", angleJitter: 0.04,
  });
  emitBurst(particles, {
    pos, count: 22,
    speedRange: [60, ringSpeed * 0.5],
    lifeRange: [0.15, 0.35], maxLife: 0.35,
    sizeRange: [1.8, 3.2],
    hue: hue + 20, hueSpread: [-10, 10],
    drag: BOMB_BLAST_RING_DRAG,
    angleMode: "random", angleJitter: 0,
  });
};
