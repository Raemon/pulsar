import type { Game } from "../Game";
import { TAU, rand, type Vec, fromAngle, toroidalDelta, wrapMut } from "../vec";
import { alignSplitChildToRhythm, seedAlienFire, seedCometMelody } from "./waveDirector";
import { startAsteroidDrones } from "./killEffects";
import { type Wormhole, spawnWormhole, wormholeEnterable } from "./wormhole";
import { type WarpedBody, renderWarpedThroughPortal, returnVoiceKey } from "./warpCannon";

// What a Warp Cannon shot swallows isn't destroyed — it's sent somewhere. Each
// body falls through its portal (warpCannon.ts) into game.warpedOut, and comes
// back at the start of the next wave: a portal tears open out towards the edge
// of the screen (the camera rides the ship, so well clear of it), off to the side
// of where the ship is heading, and the body climbs back out of it, drifting
// away from the ship.

// A body on its way back: it waits out `delay` (the returns are staggered so
// they read one by one), then its portal opens, and once the mouth is wide it
// climbs out over EMERGE_SEC (t 0→1) and rejoins play.
export type WarpIn = {
  warped: WarpedBody;
  delay: number;
  portal: Wormhole | null;
  t: number;
};

const EMERGE_SEC = 0.6;
const STAGGER_SEC = 0.3;
// Distance from the ship (as a fraction of the shorter screen side) a return
// lands: out near the edge of the screen, never on top of the player.
const RING_MIN = 0.36;
const RING_MAX = 0.45;
// Where a return lands is chosen as its portal opens, from this many spots
// around the ring: the one furthest from the ship's path over the next
// LOOKAHEAD_SEC (where it is now, and where its velocity is carrying it).
const CANDIDATES = 12;
const LOOKAHEAD_SEC = 2;
const LOOKAHEAD_STEPS = 5;
// A returning body drifts out at its old speed, kept within these bounds (px/s)
// so a fast comet doesn't burst straight back out at the player, and heads
// within this much of straight away from the ship.
const MIN_SPEED = 25;
const MAX_SPEED = 110;
const HEADING_SPREAD = 0.7;

// Called as the next wave spawns: queue every body swallowed since the last
// return. Where each lands is picked when its portal opens (placeReturn).
export const releaseWarpedBodies = (game: Game): void => {
  const out = game.warpedOut;
  if (out.length === 0) return;
  game.warpedOut = [];
  // A fall still in flight would keep writing the body's position down its dive.
  game.swallows = game.swallows.filter((s) => !out.includes(s.warped));
  out.forEach((warped, i) => {
    game.warpIns.push({ warped, delay: i * STAGGER_SEC, portal: null, t: 0 });
  });
};

// How close the ship comes to `p` over the lookahead, at its current velocity.
const closestApproach = (game: Game, p: Vec): number => {
  const { pos, vel } = game.ship;
  let closest = Infinity;
  for (let i = 0; i <= LOOKAHEAD_STEPS; i++) {
    const tau = (i / LOOKAHEAD_STEPS) * LOOKAHEAD_SEC;
    const [dx, dy] = toroidalDelta(p.x - (pos.x + vel.x * tau), p.y - (pos.y + vel.y * tau), game.w, game.h);
    closest = Math.min(closest, Math.hypot(dx, dy));
  }
  return closest;
};

// Put a returning body where the ship has the most room to dodge it, heading
// away. Rolls the gameplay RNG — this is sim state.
const placeReturn = (game: Game, wi: WarpIn): void => {
  const { body } = wi.warped;
  const ship = game.ship.pos;
  const base = rand(0, TAU);
  let best = { x: ship.x, y: ship.y, angle: 0, score: -Infinity };
  for (let i = 0; i < CANDIDATES; i++) {
    const angle = base + (i * TAU) / CANDIDATES;
    const at = fromAngle(angle, Math.min(game.w, game.h) * rand(RING_MIN, RING_MAX));
    const p = { x: ship.x + at.x, y: ship.y + at.y };
    // Keep returns from stacking on one another's portals too.
    let score = closestApproach(game, p);
    for (const other of game.warpIns) {
      if (other === wi || !other.portal) continue;
      const [dx, dy] = toroidalDelta(p.x - other.portal.x, p.y - other.portal.y, game.w, game.h);
      score = Math.min(score, Math.hypot(dx, dy) * 1.5);
    }
    if (score > best.score) best = { ...p, angle, score };
  }
  body.pos.x = best.x;
  body.pos.y = best.y;
  wrapMut(body.pos, game.w, game.h);
  const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.hypot(body.vel.x, body.vel.y)));
  const vel = fromAngle(best.angle + rand(-HEADING_SPREAD, HEADING_SPREAD), speed);
  body.vel.x = vel.x;
  body.vel.y = vel.y;
};

// Back into play with whatever per-entity rhythm, voice and travel state a
// fresh spawn would have set up — the swallow silenced it, and it's a wave
// or more out of date.
const rejoinPlay = (game: Game, w: WarpedBody): void => {
  wrapMut(w.body.pos, game.w, game.h);
  if (w.kind === "asteroid") {
    const a = w.body;
    a.alive = true;
    alignSplitChildToRhythm(game, a);
    startAsteroidDrones(game, a);
    game.asteroids.push(a);
  } else if (w.kind === "alien") {
    const al = w.body;
    al.traveled = 0;
    al.trail.clear();
    seedAlienFire(game, al);
    game.aliens.push(al);
    game.sound.startAlienDrone(al, al.size, al.pos);
  } else {
    const c = w.body;
    // A fresh lifetime, so it doesn't burst the moment it's back.
    c.age = 0;
    c.glowTrail.clear();
    seedCometMelody(game, c);
    game.comets.push(c);
    if (!c.isMeteor) game.sound.startCometShimmer(c, c.pos);
  }
};

// musicDt, like the portals, so slow-mo stretches both together.
export const updateWarpIns = (game: Game, dt: number): void => {
  if (game.warpIns.length === 0) return;
  game.warpIns = game.warpIns.filter((wi) => {
    const { body } = wi.warped;
    if (!wi.portal) {
      wi.delay -= dt;
      if (wi.delay > 0) return true;
      placeReturn(game, wi);
      wi.portal = spawnWormhole(game.wormholes, body.pos, body.radius, Math.atan2(body.vel.y, body.vel.x), { holdSec: EMERGE_SEC });
      game.sound.play("warpSwallow", returnVoiceKey(game, body.radius), body.pos);
      return true;
    }
    if (wi.t === 0 && !wormholeEnterable(wi.portal)) return true;
    wi.t += dt / EMERGE_SEC;
    // Unwrapped until it rejoins play, so the climb never jumps the seam
    // away from its portal.
    body.pos.x += body.vel.x * dt;
    body.pos.y += body.vel.y * dt;
    if (wi.t < 1) return true;
    rejoinPlay(game, wi.warped);
    return false;
  });
};

// The climb out: the fall in run backwards, the lens letting go as it rises.
export const renderWarpIns = (ctx: CanvasRenderingContext2D, list: ReadonlyArray<WarpIn>, timeMs: number): void => {
  for (const wi of list) {
    if (!wi.portal || wi.t <= 0) continue;
    renderWarpedThroughPortal(ctx, wi.warped, wi.portal, 1 - Math.min(1, wi.t), wi.portal.x, wi.portal.y, timeMs);
  }
};
