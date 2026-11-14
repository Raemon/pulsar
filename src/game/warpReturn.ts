import type { Game } from "../Game";
import { TAU, fromAngle, wrapMut } from "../vec";
import { rngRange } from "./rng";
import { alignSplitChildToRhythm, seedAlienFire, seedCometMelody } from "./waveDirector";
import { startAsteroidDrones } from "./killEffects";
import { type Wormhole, spawnWormhole, wormholeEnterable } from "./wormhole";
import { type WarpedBody, renderWarpedThroughPortal, swallowSizeTier } from "./warpCannon";
import { warpSwallowKey } from "./warpCharge";

// What a Warp Cannon shot swallows isn't destroyed — it's sent somewhere. Each
// body falls through its portal (warpCannon.ts) into game.warpedOut, and comes
// back at the start of the next wave: a portal tears open somewhere around the
// middle of the screen (the camera rides the ship, so around the ship, at a
// fair distance) and the body climbs back out of it into play.

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
// Distance from the ship (as a fraction of the shorter screen side) a return lands:
// in the middle of the screen, but never on top of the player.
const RING_MIN = 0.2;
const RING_MAX = 0.32;
// A returning body drifts out at its old speed, kept within these bounds (px/s)
// so a fast comet doesn't burst straight back out at the player.
const MIN_SPEED = 25;
const MAX_SPEED = 110;

// Called as the next wave spawns: queue every body swallowed since the last
// return. Positions and headings roll the gameplay RNG — this is sim state.
export const releaseWarpedBodies = (game: Game): void => {
  const out = game.warpedOut;
  if (out.length === 0) return;
  game.warpedOut = [];
  // A fall still in flight would keep writing the body's position down its dive.
  game.swallows = game.swallows.filter((s) => !out.includes(s.warped));
  const ringBase = rngRange(0, TAU);
  out.forEach((warped, i) => {
    const angle = ringBase + (i * TAU) / out.length + rngRange(-0.3, 0.3);
    const dist = Math.min(game.w, game.h) * rngRange(RING_MIN, RING_MAX);
    const { body } = warped;
    const at = fromAngle(angle, dist);
    body.pos.x = game.ship.pos.x + at.x;
    body.pos.y = game.ship.pos.y + at.y;
    wrapMut(body.pos, game.w, game.h);
    const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.hypot(body.vel.x, body.vel.y)));
    const vel = fromAngle(rngRange(0, TAU), speed);
    body.vel.x = vel.x;
    body.vel.y = vel.y;
    game.warpIns.push({ warped, delay: i * STAGGER_SEC, portal: null, t: 0 });
  });
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
      wi.portal = spawnWormhole(game.wormholes, body.pos, body.radius, Math.atan2(body.vel.y, body.vel.x), { holdSec: EMERGE_SEC });
      game.sound.play("warpSwallow", warpSwallowKey(swallowSizeTier(body.radius), game.beatTime), body.pos);
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
