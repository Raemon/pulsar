import type { Ship } from "../Ship";
import { TAU } from "../vec";
import { drawGlow } from "../glow";
import {
  BULLET_CORE_RADIUS, bulletHeadGlowMul, OFF_BEAT_HUE, OFF_BEAT_HEAD_ALPHA,
  OFF_BEAT_TRAIL_ALPHA, OFF_BEAT_CORE_FILL, TRAIL_RADIUS_MUL,
} from "../Bullet";
import { MAGAZINE_SIZE } from "./shipMagazine";

// Ship-local, +x = heading. Sits between hull and halo so the hitbox doesn't widen.
const PYLON_X = -2.5;
const PYLON_Y = 12;
// Port, starboard. The first shot spends the starboard round.
const PYLON_SIDES = [-1, 1];

// A loaded round is an off-beat bullet in miniature, its trail streaming back along the hull.
const ROUND_SCALE = 0.8;
const CORE_R = BULLET_CORE_RADIUS * ROUND_SCALE;
const HEAD_R = CORE_R * bulletHeadGlowMul({ onBeat: false });
const TRAIL_BLOBS = 4;
const TRAIL_SPACING = 2.2;
const SOCKET_R = 3;
const LAUNCH_SLIDE_PX = 9;

// Count-in to the refill: an empty socket ticks on each reload beat, harder as the refill nears;
// through the last beat a ring contracts and motes spiral in, landing on the refill beat itself.
const TICK_STRENGTH_BY_BEATS_LEFT = [1, 0.65, 0.4];
const TICK_BEATS = 0.35;
const APPROACH_R = 9;
const MOTES = 5;
const POP_BEATS = 0.6;

const paintCore = (ctx: CanvasRenderingContext2D, x: number, r: number, fill: string, alpha: number) => {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, 0, r, 0, TAU);
  ctx.fill();
};

const strokeRing = (ctx: CanvasRenderingContext2D, r: number, alpha: number, width: number) => {
  ctx.globalAlpha = 1;
  ctx.strokeStyle = `hsla(${OFF_BEAT_HUE}, 100%, 85%, ${alpha.toFixed(3)})`;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();
};

const paintRound = (ctx: CanvasRenderingContext2D, x: number, alpha: number) => {
  for (let i = TRAIL_BLOBS; i >= 1; i--) {
    const t = 1 - i / (TRAIL_BLOBS + 1);
    const r = CORE_R * t * 1.5 * TRAIL_RADIUS_MUL;
    drawGlow(ctx, x - i * TRAIL_SPACING, 0, r, OFF_BEAT_HUE, OFF_BEAT_TRAIL_ALPHA * t * alpha);
  }
  drawGlow(ctx, x, 0, HEAD_R, OFF_BEAT_HUE, OFF_BEAT_HEAD_ALPHA * alpha);
  paintCore(ctx, x, CORE_R, OFF_BEAT_CORE_FILL, alpha);
};

// 0..1, peaking as each reload beat lands.
const countInTick = (beatsToRefill: number): number => {
  const beatsLeft = Math.ceil(beatsToRefill);
  const strength = TICK_STRENGTH_BY_BEATS_LEFT[beatsLeft - 1] ?? 0;
  const since = (beatsLeft - beatsToRefill) / TICK_BEATS;
  return since < 1 ? strength * (1 - since) * (1 - since) : 0;
};

const paintFinalBeatGather = (ctx: CanvasRenderingContext2D, beatsToRefill: number, invuln: number) => {
  const near = 1 - beatsToRefill;
  strokeRing(ctx, SOCKET_R + APPROACH_R * beatsToRefill, (0.15 + 0.75 * near) * invuln, 0.6 + 1.2 * near);
  const moteR = SOCKET_R + APPROACH_R * beatsToRefill ** 1.3;
  for (let j = 0; j < MOTES; j++) {
    const a = (j / MOTES) * TAU + beatsToRefill * 2.4;
    drawGlow(ctx, Math.cos(a) * moteR, Math.sin(a) * moteR, 4, OFF_BEAT_HUE, Math.min(1, 1.5 * near) * invuln);
  }
  drawGlow(ctx, 0, 0, HEAD_R * (0.4 + 0.6 * near), OFF_BEAT_HUE, 0.5 * near * near * invuln);
};

const paintEmptySocket = (ctx: CanvasRenderingContext2D, beatsToRefill: number, invuln: number) => {
  const tick = countInTick(beatsToRefill);
  strokeRing(ctx, SOCKET_R + tick, (0.22 + 0.6 * tick) * invuln, 0.8 + tick);
  if (beatsToRefill > 0 && beatsToRefill <= 1) paintFinalBeatGather(ctx, beatsToRefill, invuln);
};

// The same white flash an on-beat bullet makes as it crosses a beat.
const paintRefillPop = (ctx: CanvasRenderingContext2D, beatsSince: number, invuln: number) => {
  const k = 1 - beatsSince / POP_BEATS;
  const env = k * k * invuln;
  drawGlow(ctx, 0, 0, HEAD_R * 1.8, 0, env, true);
  paintCore(ctx, 0, CORE_R * (1 + 2 * env), "hsla(0, 0%, 100%, 1)", env);
  strokeRing(ctx, SOCKET_R + 10 * (1 - k), 0.7 * env, 0.5 + 1.5 * env);
};

// The sim refills as the refill beat's window opens; the round waits for the beat to show.
const awaitsRefillBeat = (ship: Ship, i: number) =>
  i >= ship.magazineRefilledFrom && ship.magazineBeatsToRefill > 0;

const paintPylon = (ctx: CanvasRenderingContext2D, ship: Ship, i: number, invuln: number) => {
  const beatsToRefill = ship.magazineBeatsToRefill;
  if (i >= ship.shotsLoaded || awaitsRefillBeat(ship, i)) {
    paintEmptySocket(ctx, beatsToRefill, invuln);
    const slide = i === ship.shotsLoaded ? ship.magazineSpentFlash : 0;
    if (slide > 0) paintRound(ctx, (1 - slide) * LAUNCH_SLIDE_PX, slide * invuln);
    return;
  }
  paintRound(ctx, 0, invuln);
  if (i >= ship.magazineRefilledFrom && -beatsToRefill < POP_BEATS) paintRefillPop(ctx, -beatsToRefill, invuln);
};

export const paintMagazine = (ctx: CanvasRenderingContext2D, ship: Ship, invuln: number) => {
  if (ship.lasershotActive) return;
  ctx.save();
  ctx.rotate(ship.heading);
  for (let i = 0; i < MAGAZINE_SIZE; i++) {
    ctx.save();
    ctx.translate(PYLON_X, PYLON_SIDES[i] * PYLON_Y);
    paintPylon(ctx, ship, i, invuln);
    ctx.restore();
  }
  ctx.restore();
};
