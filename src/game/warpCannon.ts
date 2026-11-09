import type { Game } from "../Game";
import { type Bullet, bulletCollisionRadius } from "../Bullet";
import type { Ship } from "../Ship";
import type { Asteroid, AsteroidKind, AsteroidSize } from "../Asteroid";
import { TAU, fromAngle } from "../vec";
import { ENTITY_CONFIG } from "./entityConfig";
import { BEAT_GRID, BEAT_WINDOW } from "./rhythmConstants";
import { muzzleOf } from "../ship/shipWeapons";
import { type WarpedBody, warpedReach, drawWarpedBody } from "./warpReturn";
import {
  type Wormhole,
  type LensBackdrop,
  type PortalShape,
  type Dive,
  renderPortalLens,
  renderBakedMouth,
  renderThroughPortal,
  spawnWormhole,
  portalLongAxis,
  lensScaleForMouth,
  planDiveInto,
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
// The swallowed body leaves play the frame it's struck. Its fall is ticked in
// the sim (so it's deterministic and replays) but nothing reads it back except
// a skip portal's collapse waiting for it; the shot's wobble and ripples are
// render-only.

// ── The charge ────────────────────────────────────────────────────────────────
// Like the laser, the Warp Cannon is held to charge and fires on release: one
// charge tier ticks in per beat held, up to WARP_MAX_CHARGE. The tier sets the
// pellet's size and how big a body it can swallow whole (warpBite). The press
// and release are both plain trigger edges (shipPhysics.updateFireTrigger), so
// the release is judged on-beat like any other volley.
export const WARP_MAX_CHARGE = 3;
// Pellet mouth (its hitbox) by tier, against a stock shot's hit radius: a tap
// fires a teeny pellet, a full charge a hole wider than a medium rock.
const PELLET_SCALE = [0.5, 1, 1.5, 2.1];
export const warpPelletScale = (charge: number): number =>
  PELLET_SCALE[Math.max(0, Math.min(WARP_MAX_CHARGE, charge))];

// Tiers charged by `beatTime`. A tier lands a beat window early, so a press on
// one beat and a release on a later one counts every beat between, whichever
// side of the beat each edge fell.
export const warpChargeAt = (ship: Ship, beatTime: number): number => {
  if (!ship.warpChargeActive) return 0;
  const beats = (beatTime - ship.warpChargeStartBeatTime + BEAT_WINDOW) / BEAT_GRID;
  return Math.max(0, Math.min(WARP_MAX_CHARGE, Math.floor(beats)));
};

// ── The bite ──────────────────────────────────────────────────────────────────
// A pellet swallows a rock whole only up to its tier's size: tier 0 takes a
// small, tier 1 a medium, and so on. A bigger rock loses a bite of the
// pellet's size and leaves ONE smaller rock behind — tier+1 steps down the
// ladder. Only kinds that break down the plain size ladder (Asteroid's
// splitRegular) can be bitten; every other swallowable body goes whole.
const SIZE_LADDER: ReadonlyArray<AsteroidSize> = ["small", "medium", "large", "huge"];
const BITEABLE_KINDS: ReadonlySet<AsteroidKind> = new Set<AsteroidKind>(["normal", "asteroidWithGem", "chime", "warble"]);

export type WarpBite = { bite: AsteroidSize; leftover: AsteroidSize; kind: AsteroidKind };

// null = the shot swallows `a` whole.
export const warpBite = (a: Asteroid, shot: Bullet): WarpBite | null => {
  if (!BITEABLE_KINDS.has(a.kind)) return null;
  const size = SIZE_LADDER.indexOf(a.size);
  const cap = shot.warpCharge;
  if (size <= cap) return null;
  // A gem-bearer's pieces are plain rock, as in its break-up.
  const kind = a.kind === "asteroidWithGem" ? "normal" : a.kind;
  return { bite: SIZE_LADDER[cap], leftover: SIZE_LADDER[size - cap - 1], kind };
};

// ── The shot ──────────────────────────────────────────────────────────────────
// Seconds a fresh shot takes to tear fully open off the muzzle.
const TEAR_OPEN_SEC = 0.08;
// The wake: a ripple is shed every RIPPLE_EVERY seconds where the shot is, and
// spreads to RIPPLE_SPREAD× the mouth as it fades over RIPPLE_LIFE.
const RIPPLE_EVERY = 0.035;
const RIPPLE_LIFE = 0.3;
const RIPPLE_SPREAD = 4;

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
// same post-reticule tail a stock shot fades over. Reads the shot's life, so a
// swallow must take it before the hit consumes the shot.
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
const shotShape = (b: Bullet, tSec: number): PortalShape => {
  const heading = Math.atan2(b.vel.y, b.vel.x);
  const t = tSec + shotPhase(b);
  const breathe = 1 + 0.06 * Math.sin(t * 19 + 1.3);
  const along = 0.16;
  const wobble = 0.1 * Math.sin(t * 34);
  const wobbleAxis = heading + Math.PI / 4 + t * 4.5;
  const c = along * Math.cos(2 * heading) + wobble * Math.cos(2 * wobbleAxis);
  const s = along * Math.sin(2 * heading) + wobble * Math.sin(2 * wobbleAxis);
  return { a: breathe * (1 + c), b: breathe * s, d: breathe * (1 - c) };
};

// The shot's tier reads on its limb and wake, in the stock bullet's palette:
// pale cyan off-beat, yellow piercing, blue on-beat, gold boosted, white
// super-boosted.
const tierTint = (b: Bullet): string =>
  b.superBoosted ? "0, 0%" : b.boosted ? "45, 100%" : b.onBeat ? "222, 100%" : b.pierce ? "60, 100%" : "185, 90%";

const strokeRing = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, style: string): void => {
  ctx.strokeStyle = style;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
};

// Whether any of the shot — its ripples reach furthest — lands on the canvas
// in this wrap copy of the world layer (the scroll camera paints up to four).
const shotOnCanvas = (ctx: CanvasRenderingContext2D, b: Bullet): boolean => {
  const m = ctx.getTransform();
  const sx = m.a * b.pos.x + m.e;
  const sy = m.d * b.pos.y + m.f;
  const ext = b.hitRadius() * RIPPLE_SPREAD * 1.6 * Math.abs(m.a) + RIPPLE_LIFE * Math.hypot(b.vel.x, b.vel.y) * Math.abs(m.a);
  return sx + ext >= 0 && sy + ext >= 0 && sx - ext <= ctx.canvas.width && sy - ext <= ctx.canvas.height;
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

// A reticule-crossing flash swells the mouth for a beat.
const shotFlash = (b: Bullet): number => (b.flashTimer > 0 ? Math.min(1, b.flashTimer / 0.06) : 0);


const shotLook = (b: Bullet) => ({ x: b.pos.x, y: b.pos.y, radius: shotLensScale(b), seed: shotPhase(b), hueShift: 0 });

// The front of a shot: wake ripples, the far-sky mouth (a baked view, turning
// slowly), and its limb in the tier's colour — a soft band and a fine bright
// edge, drawn through the same wobble so they hug the mouth.
const renderWarpShotFront = (ctx: CanvasRenderingContext2D, b: Bullet, tSec: number): void => {
  const tint = tierTint(b);
  const mouth = b.hitRadius();
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  renderRipples(ctx, b, mouth, tint);
  ctx.restore();
  const flash = shotFlash(b);
  const open = shotOpen(b) * (1 + 0.25 * flash);
  if (open < 0.02) return;
  const shape = shotShape(b, tSec);
  renderBakedMouth(ctx, shotLook(b), open, shape, (tSec + shotPhase(b)) * 1.6);
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

// The lens a shot drags through the starfield — the dark lens body and the
// starlight it bends. It stands in for the starfield, so it's painted with the
// portals, under the bodies: a shot brushing a rock mustn't black it out.
export const renderWarpShotLenses = (
  ctx: CanvasRenderingContext2D, bullets: ReadonlyArray<Bullet>, backdrop: LensBackdrop | null, timeMs: number,
): void => {
  const tSec = timeMs * 0.001;
  for (const b of bullets) {
    if (!b.warp || b.life <= 0 || !shotOnCanvas(ctx, b)) continue;
    const open = shotOpen(b) * (1 + 0.25 * shotFlash(b));
    renderPortalLens(ctx, shotLook(b), open, backdrop, shotShape(b, tSec), "lens");
  }
};

// The shots themselves, with the other bullets.
export const renderWarpShots = (ctx: CanvasRenderingContext2D, bullets: ReadonlyArray<Bullet>, timeMs: number): void => {
  for (const b of bullets) {
    if (b.warp && b.life > 0 && shotOnCanvas(ctx, b)) renderWarpShotFront(ctx, b, timeMs * 0.001);
  }
};

// The pellet forming on the nose while the trigger is held: the mouth it will
// fire at the tier charged so far, swelling a little toward the next tier
// across each beat, with one faint ring per tier banked around it. Uses the
// sim's perceived beat clock, the same one the release is judged on.
export const renderWarpCharge = (ctx: CanvasRenderingContext2D, ship: Ship, beatTime: number, timeMs: number): void => {
  if (!ship.alive || !ship.warpChargeActive) return;
  const charge = warpChargeAt(ship, beatTime);
  const toNext = charge < WARP_MAX_CHARGE
    ? Math.max(0, Math.min(1, (beatTime - ship.warpChargeStartBeatTime) / BEAT_GRID - charge))
    : 0;
  const base = bulletCollisionRadius({ onBeat: false, superBoosted: false });
  const scale = warpPelletScale(charge);
  const mouth = base * (scale + (warpPelletScale(charge + 1) - scale) * 0.3 * toNext * toNext);
  const pos = { ...muzzleOf(ship) };
  const ahead = fromAngle(ship.heading, mouth);
  pos.x += ahead.x;
  pos.y += ahead.y;
  const tSec = timeMs * 0.001;
  const spin = tSec * 1.6;
  const breathe = 1 + 0.06 * Math.sin(tSec * 19);
  renderBakedMouth(ctx, { x: pos.x, y: pos.y, radius: lensScaleForMouth(mouth), seed: 0, hueShift: 0 }, breathe, null, spin);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const tint = "185, 90%";
  ctx.lineWidth = Math.max(0.8, mouth * 0.1);
  strokeRing(ctx, pos.x, pos.y, mouth * breathe, `hsla(${tint}, 88%, 0.75)`);
  ctx.lineWidth = 1;
  for (let i = 1; i <= charge; i++) {
    strokeRing(ctx, pos.x, pos.y, mouth * (1 + 0.35 * i), `hsla(${tint}, 80%, ${(0.4 - 0.08 * i).toFixed(3)})`);
  }
  ctx.restore();
};

// ── The swallow ───────────────────────────────────────────────────────────────
// A body a shot has swallowed, plunging through the portal it tore open. Same
// plunge as an alien warping out or the ship diving into a skip portal: it
// carries its own drift into the throat rather than stopping at the lip. It
// comes back next wave (warpReturn.ts).
export type Swallow = {
  portal: Wormhole;
  // The body itself; its pos is moved down the dive in place.
  warped: WarpedBody;
  dive: Dive;
  // Warp progress 0→1 over dive.sec.
  t: number;
};

// Cap on the per-pixel lens buffer — a big rock's fall spans a lot of screen,
// and a prong volley can swallow several at once.
const SWALLOW_MAX_PX = 200;

// Bosses and the Sepulchre's bier party are encounters, not rocks: too massive
// to swallow, a Warp Cannon shot lands on them as an ordinary hit.
export const canSwallow = (a: Asteroid): boolean => !a.isEncounter();

// Mouth-open fraction a portal sized for `bodyRadius` is born at so it grows
// straight out of the shot's own mouth. Take it before the hit consumes the shot.
export const swallowOpenFrom = (shot: Bullet, bodyRadius: number): number =>
  Math.min(1, (shotOpen(shot) * shotLensScale(shot)) / portalLongAxis(bodyRadius));

// The swallow's voice tier: the body's radius against the rock sizes, split halfway.
const ROCK_RADIUS = ENTITY_CONFIG.asteroid.radius;
const swallowSizeTier = (radius: number): number =>
  radius < (ROCK_RADIUS.small + ROCK_RADIUS.medium) / 2 ? 0 : radius < (ROCK_RADIUS.medium + ROCK_RADIUS.large) / 2 ? 1 : 2;

// Drop `warped` into `portal` — or, by default, a fresh one torn open where the
// shot struck — and hold it for its return next wave. Call before the hit
// consumes the shot (see swallowOpenFrom).
export const swallowIntoWarp = (game: Game, warped: WarpedBody, shot: Bullet, portal: Wormhole | null = null): void => {
  const { body } = warped;
  game.sound.play("warpSwallow", swallowSizeTier(body.radius), shot.pos);
  if (!portal) {
    portal = spawnWormhole(
      game.wormholes, shot.pos, body.radius, Math.atan2(shot.vel.y, shot.vel.x),
      { openFrom: swallowOpenFrom(shot, body.radius) },
    );
  }
  game.swallows.push({ portal, warped, dive: planDiveInto(body.pos, body.vel, portal, game.w, game.h), t: 0 });
  game.warpedOut.push(warped);
};

// Seconds until every body still falling into `portal` is through — how long
// its mouth must stay wide before it may start to collapse.
export const swallowTimeLeft = (game: Game, portal: Wormhole): number => {
  let left = 0;
  for (const s of game.swallows) if (s.portal === portal) left = Math.max(left, (1 - s.t) * s.dive.sec);
  return left;
};

// musicDt, like the portals and every other dive, so slow-mo stretches both.
export const updateSwallows = (list: Swallow[], dt: number): Swallow[] => {
  for (const s of list) {
    s.t += dt / s.dive.sec;
    const p = diveAt(s.dive, Math.min(1, s.t));
    s.warped.body.pos.x = p.x;
    s.warped.body.pos.y = p.y;
  }
  return list.filter((s) => s.t < 1);
};

export const renderSwallows = (ctx: CanvasRenderingContext2D, list: ReadonlyArray<Swallow>, timeMs: number): void => {
  for (const s of list) {
    const { pos } = s.warped.body;
    renderThroughPortal(
      ctx, s.portal, Math.min(1, s.t), { x: pos.x, y: pos.y, reach: warpedReach(s.warped) },
      s.dive.x1 - pos.x, s.dive.y1 - pos.y, (g) => drawWarpedBody(s.warped, g, timeMs), SWALLOW_MAX_PX,
    );
  }
};
