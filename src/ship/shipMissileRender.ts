import type { Ship } from "../Ship";
import { TAU } from "../vec";
import { drawGlow } from "../glow";
import { MAGAZINE_SIZE } from "./shipMagazine";

// Ship-local, +x = heading. Sits between hull and halo so the hitbox doesn't widen.
const PYLON_X = -2.5;
const PYLON_Y = 12;
// Port, starboard. The first shot spends the starboard missile.
const PYLON_SIDES = [-1, 1];

const LEN = 11;
const BODY_R = 1.9;
const FIN = 1.7;
const TAIL = -LEN / 2;
const TIP = LEN / 2;
const SHOULDER = TIP - 3.6;
const WARHEAD_HUE = 8;

const EMPTY_GHOST_ALPHA = 0.16;
const LAUNCH_SLIDE_PX = 9;

// Baked at 4x so the refill pop and hi-dpi canvases stay crisp.
const SPRITE_SCALE = 4;
const PAD = 1.5;
const SPRITE_HALF_W = LEN / 2 + PAD;
const SPRITE_HALF_H = BODY_R + FIN + PAD;

const traceBody = (g: CanvasRenderingContext2D) => {
  g.beginPath();
  g.moveTo(TAIL, -BODY_R);
  g.lineTo(SHOULDER, -BODY_R);
  g.quadraticCurveTo(TIP - 0.9, -BODY_R, TIP, 0);
  g.quadraticCurveTo(TIP - 0.9, BODY_R, SHOULDER, BODY_R);
  g.lineTo(TAIL, BODY_R);
  g.closePath();
};

const traceFins = (g: CanvasRenderingContext2D) => {
  g.beginPath();
  for (const s of PYLON_SIDES) {
    g.moveTo(TAIL + 3.2, s * BODY_R);
    g.lineTo(TAIL - 0.6, s * (BODY_R + FIN));
    g.lineTo(TAIL + 0.3, s * BODY_R);
    g.closePath();
  }
};

const verticalGradient = (g: CanvasRenderingContext2D, halfH: number, stops: Array<[number, string]>) => {
  const grad = g.createLinearGradient(0, -halfH, 0, halfH);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  return grad;
};

const paintFins = (g: CanvasRenderingContext2D) => {
  traceFins(g);
  g.fillStyle = verticalGradient(g, BODY_R + FIN, [
    [0, `hsla(${WARHEAD_HUE + 6}, 85%, 62%, 1)`],
    [1, `hsla(${WARHEAD_HUE - 10}, 80%, 30%, 1)`],
  ]);
  g.fill();
  g.lineWidth = 0.6;
  g.strokeStyle = "hsla(230, 40%, 6%, 0.85)";
  g.stroke();
};

// Shaded as a cylinder in the hull's cyan, so the coral warhead is the one warm accent.
const paintBody = (g: CanvasRenderingContext2D) => {
  traceBody(g);
  g.fillStyle = verticalGradient(g, BODY_R, [
    [0, "hsla(198, 55%, 62%, 1)"],
    [0.3, "hsla(195, 60%, 78%, 1)"],
    [0.65, "hsla(205, 50%, 42%, 1)"],
    [1, "hsla(220, 45%, 18%, 1)"],
  ]);
  g.fill();
};

const paintWarheadAndNozzle = (g: CanvasRenderingContext2D) => {
  g.save();
  traceBody(g);
  g.clip();
  g.fillStyle = verticalGradient(g, BODY_R, [
    [0, `hsla(${WARHEAD_HUE + 14}, 100%, 82%, 1)`],
    [0.35, `hsla(${WARHEAD_HUE + 6}, 100%, 66%, 1)`],
    [1, `hsla(${WARHEAD_HUE - 12}, 85%, 30%, 1)`],
  ]);
  g.fillRect(SHOULDER - 0.7, -BODY_R, TIP - SHOULDER + 0.7, 2 * BODY_R);
  g.fillStyle = "hsla(225, 40%, 10%, 0.7)";
  g.fillRect(SHOULDER - 0.95, -BODY_R, 0.35, 2 * BODY_R);
  g.fillRect(TAIL, -BODY_R, 0.7, 2 * BODY_R);
  g.restore();
};

const paintRimAndGlint = (g: CanvasRenderingContext2D) => {
  traceBody(g);
  g.lineWidth = 0.9;
  g.strokeStyle = "hsla(230, 40%, 6%, 0.9)";
  g.stroke();
  g.lineWidth = 0.35;
  g.strokeStyle = "hsla(190, 90%, 90%, 0.9)";
  g.stroke();
  g.fillStyle = "hsla(40, 100%, 97%, 0.95)";
  g.beginPath();
  g.arc(TIP - 1.9, -BODY_R * 0.4, 0.45, 0, TAU);
  g.fill();
};

const bakeMissileSprite = (): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(SPRITE_HALF_W * 2 * SPRITE_SCALE);
  canvas.height = Math.ceil(SPRITE_HALF_H * 2 * SPRITE_SCALE);
  const g = canvas.getContext("2d")!;
  g.scale(SPRITE_SCALE, SPRITE_SCALE);
  g.translate(SPRITE_HALF_W, SPRITE_HALF_H);
  paintFins(g);
  paintBody(g);
  paintWarheadAndNozzle(g);
  paintRimAndGlint(g);
  return canvas;
};

let missileSprite: HTMLCanvasElement | null = null;
const getMissileSprite = (): HTMLCanvasElement => (missileSprite ??= bakeMissileSprite());

const drawMissile = (ctx: CanvasRenderingContext2D, x: number, alpha: number, scale = 1) => {
  ctx.globalAlpha = alpha;
  const w = SPRITE_HALF_W * scale;
  const h = SPRITE_HALF_H * scale;
  ctx.drawImage(getMissileSprite(), x - w, -h, w * 2, h * 2);
};

const paintLoadedMissile = (ctx: CanvasRenderingContext2D, refillFlash: number, invuln: number) => {
  drawGlow(ctx, SHOULDER, 0, 5, WARHEAD_HUE + 12, 0.25 * invuln);
  ctx.globalCompositeOperation = "source-over";
  drawMissile(ctx, 0, invuln);
  if (refillFlash > 0) paintRefillPulse(ctx, refillFlash, invuln);
};

// The missile pops in oversized and white-hot, blooms, and throws one ring.
const paintRefillPulse = (ctx: CanvasRenderingContext2D, flash: number, invuln: number) => {
  const age = 1 - flash;
  ctx.globalCompositeOperation = "lighter";
  drawMissile(ctx, 0, flash * invuln, 1 + 0.3 * flash * flash);
  drawGlow(ctx, 0, 0, 7 + 4 * age, WARHEAD_HUE + 12, 0.75 * flash * invuln);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = `hsla(${WARHEAD_HUE + 30}, 100%, 92%, ${(0.8 * flash * flash * invuln).toFixed(3)})`;
  ctx.lineWidth = 0.6 + 1.4 * flash;
  ctx.beginPath();
  ctx.ellipse(0, 0, 5 + 6 * age, 3 + 5 * age, 0, 0, TAU);
  ctx.stroke();
};

// A spent missile slides off the front of its pylon as it fades.
const paintEmptyPylon = (ctx: CanvasRenderingContext2D, spentFlash: number, invuln: number) => {
  ctx.globalCompositeOperation = "source-over";
  drawMissile(ctx, 0, EMPTY_GHOST_ALPHA * invuln);
  if (spentFlash > 0) drawMissile(ctx, (1 - spentFlash) * LAUNCH_SLIDE_PX, spentFlash * invuln);
};

export const paintMissilePylons = (ctx: CanvasRenderingContext2D, ship: Ship, invuln: number) => {
  if (ship.lasershotActive) return;
  ctx.save();
  ctx.rotate(ship.heading);
  for (let i = 0; i < MAGAZINE_SIZE; i++) {
    ctx.save();
    ctx.translate(PYLON_X, PYLON_SIDES[i] * PYLON_Y);
    if (i < ship.shotsLoaded) paintLoadedMissile(ctx, ship.magazineRefillFlash, invuln);
    else paintEmptyPylon(ctx, i === ship.shotsLoaded ? ship.magazineSpentFlash : 0, invuln);
    ctx.restore();
  }
  ctx.restore();
};
