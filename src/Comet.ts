import { Vec, v, fromAngle, rand, randInt, TAU, addScaledMut, circleHit } from "./vec";
import { completeEntrance, foldWithEntrance } from "./game/entrance";
import { Trail } from "./Trail";
import { rng } from "./game/rng";
import { ENTITY_CONFIG } from "./game/entityConfig";

// Head bloom: base radius at scale 1, and how far past it the halo fades out.
const HEAD_RADIUS = 26;
const HALO_MULT = 2.6;
// Furthest the head paints from its centre at scale 1 (pulse peak).
export const COMET_HALO_REACH = HEAD_RADIUS * HALO_MULT;

// Ethereal background event that wanders across the field over ~25-40 seconds
// playing a slow melodic phrase locked to the bass-beat grid. Doesn't collide
// with anything — it's purely an audio/visual flourish that decorates the
// rhythm bed.
//
// The melody (COMET_MELODY in Sound.ts) cycles a C-minor pentatonic phrase
// that layers cleanly under the halo ambient pad (C–G–Eb in comet mode) and
// over the bassteroid bed. One note fires every 2 BEAT_GRID ticks (1.0 s)
// — the same pulse as the halo melody — so the two lines hocket into a
// single moving voice across the four-bar phrase rather than fighting at
// different rates.
export class Comet {
  pos: Vec;
  vel: Vec;
  age = 0;
  alive = true;
  // End-of-life: instead of fading off or diving through a departure portal, the
  // comet bursts apart in place — a celestial body coming undone. Set true on the
  // frame it times out so the Game emits exactly one explosion (particles + sound)
  // for this comet, then the comet is gone. See spawnPendingCometExplosions.
  needsExplosion = false;
  // Entrance state — the arrival presentation played on spawn. See game/entrance.ts.
  entering = false;
  enterOffX = 0;
  enterOffY = 0;
  enterTraveled = 0;
  enterMinOvershoot = 0;
  // Trail of past positions for the streak. Newest at index 0.
  trail: { pos: Vec; age: number }[] = [];
  // The current step in the melody. Advanced by the Game on each BEAT_GRID
  // boundary; passed back to Sound.playCometNote so the timbre/octave can
  // be modulated per step.
  noteIndex = 0;
  // Bass-clock time (seconds) at which this comet's next melody note should
  // fire. Set when the comet is spawned to the next BEAT_GRID boundary, then
  // advanced by exactly one BEAT_GRID per note so the melody stays locked
  // to the bass grid for the comet's whole life.
  nextNoteBeatTime = 0;
  // Total lifetime (seconds) — set at spawn so brightness() and the audio
  // fade can both reference it.
  lifetime = 24;
  // Hue drives the colour of the streak and bloom. Picked at spawn from a
  // narrow cyan/violet band so multiple comets in successive waves all read
  // as the same "musical visitor" species.
  hue: number;
  // Shimmer-pad glow trail, layered behind the line-streak head. Multi-LFO
  // pulse mode produces the glittery breathing that visually echoes the
  // shimmer-pad audio. See Trail.ts.
  glowTrail: Trail;
  // How long the comet visibly fades in on spawn. Used for both the streak
  // bloom and the audio shimmer pad amplitude.
  static readonly FADE_IN = ENTITY_CONFIG.comet.fadeIn;

  // Hit radius for the head. Roughly matches the bright pin-prick + halo so
  // a bullet that visually clips the head reads as a hit. The visual halo
  // extends a bit further but isn't part of the body — only the burning
  // core counts.
  static readonly HIT_RADIUS = ENTITY_CONFIG.comet.hitRadius;
  readonly radius: number;

  // A meteor is a smaller, faster, cheaper sibling that arrives in a staggered
  // shower of several at once. It reuses the comet's rendering, collision and
  // scoring, but plays no per-comet melody or shimmer drone (the shower has its
  // own dramatic entrance sound instead) and doesn't shift the halo into comet
  // mode. See spawnMeteorShower.
  isMeteor = false;
  // Uniform visual + hit scale relative to a full comet. 1 for comets; meteors
  // shrink so the shower reads as a flock of lesser bodies.
  scale: number;

  constructor(pos: Vec, vel: Vec, hue: number, scale = 1) {
    this.pos = pos;
    this.vel = vel;
    this.hue = hue;
    this.scale = scale;
    this.radius = Comet.HIT_RADIUS * scale;
    this.glowTrail = new Trail(hue, 18, 0.32, "shimmer", 1.6);
  }

  collidesWith(p: Vec, r: number): boolean {
    const hit = circleHit(this.pos, this.radius, p, r);
    // Real contact ends the entrance presentation (see game/entrance.ts).
    if (hit) completeEntrance(this);
    return hit;
  }

  // Brightness envelope: rises during FADE_IN, then holds at full. There's no
  // end-of-life fade — comets AND meteors now burst apart while still bright (the
  // explosion IS the exit), so fading to invisible first would just hide the end.
  brightness(): number {
    return Math.min(1, this.age / Comet.FADE_IN);
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    addScaledMut(this.pos, this.vel, dt);
    // Fold onto the torus; carry both trails across the fold so the streak
    // stays attached instead of resetting at the seam. Meteors fold too —
    // they still despawn on their lifetime clock.
    const off = foldWithEntrance(this, w, h);
    if (off) {
      this.glowTrail.shift(off.x, off.y);
      for (const t of this.trail) {
        t.pos.x += off.x;
        t.pos.y += off.y;
      }
    }
    this.glowTrail.update(dt, this.pos.x, this.pos.y);

    // Sample the current position every frame so the trail is dense enough
    // to read as a smooth streak. Trim the tail when the oldest sample has
    // outlived its visible window.
    this.trail.unshift({ pos: { ...this.pos }, age: 0 });
    for (const t of this.trail) t.age += dt;
    const TAIL_LIFE = 1.1;
    while (this.trail.length > 0 && this.trail[this.trail.length - 1].age > TAIL_LIFE) {
      this.trail.pop();
    }

    // At end-of-life, burst apart rather than just fading off — meteors too.
    // Their staggered lifetimes mean a shower detonates in a rippling sequence,
    // not one wall of particles on a single frame. The Game reads needsExplosion
    // (it owns particles + sound) and drops the comet.
    if (this.age >= this.lifetime) {
      this.needsExplosion = true;
      this.alive = false;
      return;
    }
  }

  render(ctx: CanvasRenderingContext2D) {
    const b = this.brightness();
    if (b <= 0) return;

    const hx = this.pos.x;
    const hy = this.pos.y;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Tail: gradient of soft strokes from the current head back through the
    // recorded positions. Each segment fades with age so the trail tapers
    // to nothing rather than ending in a hard edge.
    const TAIL_LIFE = 1.1;
    for (let i = 0; i < this.trail.length - 1; i++) {
      const a = this.trail[i];
      const c = this.trail[i + 1];
      const aT = 1 - a.age / TAIL_LIFE;
      const segAlpha = Math.max(0, aT) * 0.55 * b;
      if (segAlpha <= 0.002) continue;
      const width = (1.5 + 7 * Math.max(0, aT)) * this.scale;
      ctx.strokeStyle = `hsla(${this.hue}, 95%, 78%, ${segAlpha.toFixed(3)})`;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.pos.x, a.pos.y);
      ctx.lineTo(c.pos.x, c.pos.y);
      ctx.stroke();
    }

    // Head bloom — soft halo that pulses subtly with the melody step so the
    // visual feels coupled to the audio. Pulse amplitude is gentle (±15%)
    // because the bass kit already supplies the strong rhythmic accents.
    const pulse = 0.85 + 0.15 * Math.sin(this.noteIndex * 1.3 + this.age * 2);
    const radius = HEAD_RADIUS * pulse * this.scale;
    if (radius < 0.5) { ctx.restore(); return; }
    const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, radius * HALO_MULT);
    halo.addColorStop(0, `hsla(${this.hue}, 100%, 92%, ${(0.85 * b).toFixed(3)})`);
    halo.addColorStop(0.4, `hsla(${this.hue}, 95%, 80%, ${(0.35 * b).toFixed(3)})`);
    halo.addColorStop(1, `hsla(${this.hue}, 95%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(hx, hy, radius * HALO_MULT, 0, TAU);
    ctx.fill();

    // Bright pin-prick at the head — sells the "burning ice" core. Pure
    // white centre so the hue reads as bloom around a hot point.
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * b).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(hx, hy, radius * 0.32, 0, TAU);
    ctx.fill();

    ctx.restore();
  }
}

// Lifetime (seconds) for a body that should drift in from one screen edge,
// cross, and drift back off the far side at the given speed — then be gone,
// rather than wander and wrap around the torus. The travel target is a bit over
// one screen-diagonal so it clears the far edge from any spawn point/heading;
// the FADE_IN window eases the streak on at entry. Callers compute this AFTER
// any rhythm speed adjustment so the on-screen time matches the body's actual
// velocity.
export const crossingLifetime = (w: number, h: number, speed: number): number =>
  speed > 0 ? (Math.hypot(w, h) * 1.5) / speed : 24;

// Seconds a comet flies before it bursts apart. The comet ends on this fixed
// timer — wherever it happens to be, mid-flight — NOT by reaching a screen edge
// (that old edge-despawn is what this replaces). A comet crosses the visible
// frame in well under 30s and then keeps drifting through the wrapped world, so
// it stays in play the full duration and explodes on the clock, on-screen or
// off, while still (with the fade-out removed) bright.
export const COMET_LIFETIME = 30;

// Spawn a comet drifting in from one edge across the screen. Velocity is
// slow (≈ 1 screen-width per ~12 seconds) so the comet feels like a
// distant celestial object rather than a fast-moving threat. The exact
// path is randomised but always crosses near (not through) the centre so
// the player can see it during play.
export const spawnComet = (w: number, h: number): Comet => {
  // Pick an off-screen origin and a target somewhere in the central band,
  // then derive velocity to traverse between them in ~14-18 seconds.
  const edge = Math.floor(rng() * 4);
  const offset = 80;
  let from: Vec;
  if (edge === 0) from = v(-offset, rand(h * 0.15, h * 0.85));
  else if (edge === 1) from = v(w + offset, rand(h * 0.15, h * 0.85));
  else if (edge === 2) from = v(rand(w * 0.15, w * 0.85), -offset);
  else from = v(rand(w * 0.15, w * 0.85), h + offset);

  const target = v(rand(w * 0.25, w * 0.75), rand(h * 0.25, h * 0.75));
  const angle = Math.atan2(target.y - from.y, target.x - from.x);
  const traversalSeconds = rand(14, 18);
  const distance = Math.hypot(target.x - from.x, target.y - from.y) * 2.4;
  // speedMult makes the comet harder to babysit on-screen for combo farming
  // — see ENTITY_CONFIG.comet.speedMult.
  const speed = (distance / traversalSeconds) * ENTITY_CONFIG.comet.speedMult;
  const vel = fromAngle(angle, speed);

  // Narrow band of cool hues (cyan → violet) keeps every comet feeling
  // like the same celestial visitor across runs.
  const hue = rand(180, 290);
  const c = new Comet(from, vel, hue);
  // Fixed 30s in play, then burst apart mid-flight (see COMET_LIFETIME) —
  // independent of speed or where it is on the map.
  c.lifetime = COMET_LIFETIME;
  return c;
};

// A meteor shower: several smaller, faster meteors streaking the same way
// across the field, staggered so they fan out into a moving flock rather than
// arriving as one clump. Unlike the lone comet — a slow musical visitor — the
// shower is a brief spectacle: each meteor is worth less but there are many,
// and they cross fast, so the player has a tight window to comb through them.
//
// All meteors share one heading (same angle, 2× comet speed). They start on a
// line perpendicular to that heading, spread across the entry edge, and each is
// nudged back along the heading by a growing amount so the flock trails itself
// diagonally instead of crossing the screen as a flat wall.
const MS = ENTITY_CONFIG.meteorShower;
export const spawnMeteorShower = (w: number, h: number, countOverride?: number): Comet[] => {
  const count = countOverride ?? randInt(MS.count[0], MS.count[1]);

  // Same edge-to-centre framing as a comet so the flock crosses the play area.
  const edge = Math.floor(rng() * 4);
  const offset = 120;
  let origin: Vec;
  if (edge === 0) origin = v(-offset, rand(h * 0.15, h * 0.85));
  else if (edge === 1) origin = v(w + offset, rand(h * 0.15, h * 0.85));
  else if (edge === 2) origin = v(rand(w * 0.15, w * 0.85), -offset);
  else origin = v(rand(w * 0.15, w * 0.85), h + offset);

  const target = v(rand(w * 0.3, w * 0.7), rand(h * 0.3, h * 0.7));
  const angle = Math.atan2(target.y - origin.y, target.x - origin.x);
  // Match the comet's traversal speed, then double it — meteors move fast.
  const distance = Math.hypot(target.x - origin.x, target.y - origin.y) * 2.4;
  const speed = (distance / rand(14, 18)) * MS.speedMult;
  const vel = fromAngle(angle, speed);

  // Tight hue band, warmer than the comet's cyan/violet, so a shower reads as
  // its own species at a glance.
  const baseHue = rand(28, 60);

  // Unit vectors along + perpendicular to the heading, for laying the flock out.
  const along = fromAngle(angle, 1);
  const perp = v(-along.y, along.x);

  const meteors: Comet[] = [];
  for (let i = 0; i < count; i++) {
    // Spread across the perpendicular (centred on the origin) and stagger back
    // along the heading so later meteors trail the leaders.
    const spread = (i - (count - 1) / 2) * rand(40, 70);
    const lag = i * rand(50, 110);
    const pos = v(
      origin.x + perp.x * spread - along.x * lag,
      origin.y + perp.y * spread - along.y * lag,
    );
    const m = new Comet(pos, { ...vel }, baseHue + rand(-8, 8), MS.scale);
    m.isMeteor = true;
    // Cross-and-leave lifetime (see crossingLifetime), plus the time to cover
    // this meteor's stagger lag so the trailing ones still fully clear the far
    // edge rather than fading out mid-screen. Capped by MS.lifetime so a very
    // slow/laggy member can't linger far longer than the shower's window.
    const cross = crossingLifetime(w, h, speed) + (speed > 0 ? lag / speed : 0);
    m.lifetime = Math.min(cross, MS.lifetime[1]);
    meteors.push(m);
  }
  return meteors;
};
