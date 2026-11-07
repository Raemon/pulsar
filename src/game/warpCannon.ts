import type { Game } from "../Game";
import type { Bullet } from "../Bullet";
import type { Asteroid } from "../Asteroid";
import { Vec, toroidalDelta, TAU } from "../vec";
import {
  type Wormhole,
  type LensBackdrop,
  type PortalShape,
  renderPortalLens,
  renderThroughPortal,
  spawnWormhole,
  portalLongAxis,
  lensScaleForMouth,
  type Dive,
  planDive,
  diveAt,
} from "./wormhole";

// The Warp Cannon upgrade. Each shot is a small flying wormhole — the same
// lens the departure and skip portals paint (renderPortalLens), its mouth the
// shot's hitbox, wobbling as it flies and shedding ripples behind it. Whatever
// it strikes it swallows whole: the body falls into a portal torn open where
// the shot landed, exactly as the ship falls into a skip portal
// (renderThroughPortal), and the kill pays for the body plus every fragment it
// would have broken into — with none of a break-up's aftermath (killEffects).
//
// All of this is cosmetic beyond the collision rule: the swallowed body leaves
// play the frame it's struck, and the shot's shape and ripples never feed back
// into the sim.

// ── The shot ──────────────────────────────────────────────────────────────────
// Seconds a fresh shot takes to tear fully open off the muzzle.
const TEAR_OPEN_SEC = 0.08;
// The wake: a ripple is shed every RIPPLE_EVERY seconds where the shot is, and
// spreads to RIPPLE_SPREAD× the mouth as it fades over RIPPLE_LIFE.
const RIPPLE_EVERY = 0.03;
const RIPPLE_LIFE = 0.3;
const RIPPLE_SPREAD = 4;
// The far sky through a shot's mouth is small and soft — a coarse map is
// plenty, and a volley of shots can share the screen.
const SHOT_SKY_MAX_PX = 64;

export type WarpRipple = { x: number; y: number; age: number };

export const tickWarpRipples = (b: Bullet, dt: number): void => {
  for (const r of b.warpRipples) r.age += dt;
  while (b.warpRipples.length > 0 && b.warpRipples[0].age >= RIPPLE_LIFE) b.warpRipples.shift();
  b.warpRippleClock += dt;
  if (b.warpRippleClock >= RIPPLE_EVERY) {
    b.warpRippleClock %= RIPPLE_EVERY;
    b.warpRipples.push({ x: b.pos.x, y: b.pos.y, age: 0 });
  }
};

// Full lens scale of a shot: its mouth is exactly its hitbox.
const shotLensScale = (b: Bullet): number => lensScaleForMouth(b.hitRadius());

// Mouth-open fraction: tears open off the muzzle, then closes down across the
// same post-reticule tail a stock shot fades over.
const shotOpen = (b: Bullet): number => {
  const tear = Math.min(1, (b.maxLife - b.life) / TEAR_OPEN_SEC);
  return (1 - (1 - tear) * (1 - tear)) * b.rangeAlpha();
};

// Per-shot phase, from where it was fired — deterministic without touching
// either RNG stream.
const shotPhase = (b: Bullet): number => (b.firedFrom.x * 0.0131 + b.firedFrom.y * 0.0173) % TAU;

// The mouth's wobble: drawn out along its flight, with a second stretch that
// pulses and turns over the first, and a slow breath in its size — a hole in
// space that quivers as it's dragged through it.
const shotShape = (b: Bullet, tSec: number, phase: number): PortalShape => {
  const heading = Math.atan2(b.vel.y, b.vel.x);
  const t = tSec + phase;
  const breathe = 1 + 0.06 * Math.sin(t * 19 + 1.3);
  const along = 0.16;
  const wobble = 0.1 * Math.sin(t * 34);
  const wobbleAxis = heading + Math.PI / 4 + t * 4.5;
  const c = along * Math.cos(2 * heading) + wobble * Math.cos(2 * wobbleAxis);
  const s = along * Math.sin(2 * heading) + wobble * Math.sin(2 * wobbleAxis);
  return { a: breathe * (1 + c), b: breathe * s, d: breathe * (1 - c) };
};

// The shot's tier reads on its limb and wake, in the stock bullet's palette:
// pale cyan off-beat, blue on-beat, gold boosted, white super-boosted.
const tierTint = (b: Bullet): string =>
  b.superBoosted ? "0, 0%" : b.boosted ? "45, 100%" : b.onBeat ? "222, 100%" : b.pierce ? "60, 100%" : "185, 90%";

const strokeRing = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, style: string): void => {
  ctx.strokeStyle = style;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
};

// A wake ripple: a thin crest in the shot's tint, split chromatically like the
// lensed starlight — blue just inside, red just outside.
const renderRipples = (ctx: CanvasRenderingContext2D, b: Bullet, mouth: number, tint: string): void => {
  const fade = b.rangeAlpha();
  ctx.lineWidth = 1;
  for (const r of b.warpRipples) {
    const k = r.age / RIPPLE_LIFE;
    const a = (1 - k) * (1 - k) * 0.32 * fade;
    if (a < 0.01) continue;
    const rad = mouth * (1 + (RIPPLE_SPREAD - 1) * Math.sqrt(k));
    strokeRing(ctx, r.x, r.y, rad * 0.95, `hsla(212, 95%, 70%, ${(a * 0.5).toFixed(3)})`);
    strokeRing(ctx, r.x, r.y, rad, `hsla(${tint}, 84%, ${a.toFixed(3)})`);
    strokeRing(ctx, r.x, r.y, rad * 1.05, `hsla(2, 95%, 64%, ${(a * 0.5).toFixed(3)})`);
  }
};

const renderWarpShot = (
  ctx: CanvasRenderingContext2D, b: Bullet, backdrop: LensBackdrop | null, tSec: number,
): void => {
  const tint = tierTint(b);
  const mouth = b.hitRadius();
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  renderRipples(ctx, b, mouth, tint);
  ctx.restore();
  // A reticule-crossing flash swells the mouth for a beat.
  const flash = b.flashTimer > 0 ? Math.min(1, b.flashTimer / 0.06) : 0;
  const open = shotOpen(b) * (1 + 0.25 * flash);
  if (open < 0.02) return;
  const phase = shotPhase(b);
  const shape = shotShape(b, tSec, phase);
  renderPortalLens(
    ctx, { x: b.pos.x, y: b.pos.y, radius: shotLensScale(b), seed: phase, hueShift: 0 },
    open, backdrop, shape, SHOT_SKY_MAX_PX,
  );
  // The limb in the tier's colour — a soft band and a fine bright edge, drawn
  // through the same wobble so they hug the mouth.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(b.pos.x, b.pos.y);
  ctx.transform(shape.a, shape.b, shape.b, shape.d, 0, 0);
  const r = mouth * open;
  ctx.lineWidth = Math.max(1.5, r * 0.35);
  strokeRing(ctx, 0, 0, r * 1.1, `hsla(${tint}, 65%, ${(0.2 + 0.25 * flash).toFixed(3)})`);
  ctx.lineWidth = Math.max(0.8, r * 0.08);
  strokeRing(ctx, 0, 0, r, `hsla(${tint}, 88%, ${(0.7 + 0.3 * flash).toFixed(3)})`);
  ctx.restore();
};

export const renderWarpShots = (
  ctx: CanvasRenderingContext2D, bullets: ReadonlyArray<Bullet>, backdrop: LensBackdrop | null, timeMs: number,
): void => {
  for (const b of bullets) if (b.warp && b.life > 0) renderWarpShot(ctx, b, backdrop, timeMs * 0.001);
};

// ── The swallow ───────────────────────────────────────────────────────────────
// A body a shot has swallowed, plunging through the portal it tore open. Same
// plunge as an alien warping out or the ship diving into a skip portal: it
// carries its own drift into the throat rather than stopping at the lip.
export type Swallow = {
  portal: Wormhole;
  // The body itself; its pos is moved down the dive in place.
  body: { pos: Vec };
  dive: Dive;
  // Warp progress 0→1 over dive.sec.
  t: number;
  reach: number;
  draw: (g: CanvasRenderingContext2D, timeMs: number) => void;
};

// Cap on the per-pixel lens buffer — a big rock's fall spans a lot of screen,
// and a prong volley can swallow several at once.
const SWALLOW_MAX_PX = 240;

// Bosses and the Sepulchre's bier party are encounters, not rocks: too massive
// to swallow, a Warp Cannon shot lands on them as an ordinary hit.
export const canSwallow = (a: Asteroid): boolean => !a.isBossFamily() && !a.isSepulchreFamily();

// Mouth-open fraction a portal sized for `bodyRadius` is born at so it grows
// straight out of the shot's own mouth.
export const swallowOpenFrom = (shot: Bullet, bodyRadius: number): number =>
  Math.min(1, (shotOpen(shot) * shotLensScale(shot)) / portalLongAxis(bodyRadius));

// Drop `body` into `portal` — or, by default, a fresh one torn open where the
// shot struck.
export const swallowIntoWarp = (
  game: Game, body: { pos: Vec; vel: Vec; radius: number }, shot: Bullet,
  draw: Swallow["draw"], portal: Wormhole | null = null,
): void => {
  if (!portal) {
    game.sound.play("canisterAppear", 1, shot.pos);
    portal = spawnWormhole(
      game.wormholes, shot.pos, body.radius, Math.atan2(shot.vel.y, shot.vel.x),
      { openFrom: swallowOpenFrom(shot, body.radius) },
    );
  }
  const [dx, dy] = toroidalDelta(portal.x - body.pos.x, portal.y - body.pos.y, game.w, game.h);
  game.swallows.push({
    portal,
    body,
    dive: planDive(body.pos, body.vel, { x: body.pos.x + dx, y: body.pos.y + dy }),
    t: 0,
    reach: body.radius * 1.6,
    draw,
  });
};

// musicDt, like the portals and every other dive, so slow-mo stretches both.
export const updateSwallows = (list: Swallow[], dt: number): Swallow[] => {
  for (const s of list) {
    s.t += dt / s.dive.sec;
    const p = diveAt(s.dive, Math.min(1, s.t));
    s.body.pos.x = p.x;
    s.body.pos.y = p.y;
  }
  return list.filter((s) => s.t < 1);
};

export const renderSwallows = (ctx: CanvasRenderingContext2D, list: ReadonlyArray<Swallow>, timeMs: number): void => {
  for (const s of list) {
    const { pos } = s.body;
    renderThroughPortal(
      ctx, s.portal, Math.min(1, s.t), { x: pos.x, y: pos.y, reach: s.reach },
      s.dive.x1 - pos.x, s.dive.y1 - pos.y, (g) => s.draw(g, timeMs), SWALLOW_MAX_PX,
    );
  }
};
