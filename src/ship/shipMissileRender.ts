import type { Ship } from "../Ship";
import { TAU } from "../vec";
import { drawGlow } from "../glow";
import { MAGAZINE_SIZE, usesMagazine } from "./shipMagazine";

// The magazine's two shots, slung under the hull's flanks in the gap between
// the hull and its halo (so they never widen the visible hitbox). Ship-local:
// +x along the heading, +y to starboard. Pylon 0 is port, pylon 1 starboard;
// the first shot spends pylon 1.
const PYLON_X = -2.5;
const PYLON_Y = 12;

// Missile geometry in px, nose along +x.
const LEN = 11;
const R = 1.9;
const FIN = 1.7;
const TAIL = -LEN / 2;
const TIP = LEN / 2;
const SHOULDER = TIP - 3.6;
const WARHEAD_HUE = 8;

// The sprite is baked at this many texels per px so it stays crisp through the
// refill pop and on hi-dpi canvases.
const SPRITE_SCALE = 4;
const PAD = 1.5;
const HALF_W = LEN / 2 + PAD;
const HALF_H = R + FIN + PAD;

const traceBody = (g: CanvasRenderingContext2D) => {
  g.beginPath();
  g.moveTo(TAIL, -R);
  g.lineTo(SHOULDER, -R);
  g.quadraticCurveTo(TIP - 0.9, -R, TIP, 0);
  g.quadraticCurveTo(TIP - 0.9, R, SHOULDER, R);
  g.lineTo(TAIL, R);
  g.closePath();
};

const traceFins = (g: CanvasRenderingContext2D) => {
  g.beginPath();
  for (const s of [-1, 1]) {
    g.moveTo(TAIL + 3.2, s * R);
    g.lineTo(TAIL - 0.6, s * (R + FIN));
    g.lineTo(TAIL + 0.3, s * R);
    g.closePath();
  }
};

// Steel body shaded as a cylinder (lit stripe toward -y, hue cooling into the
// shadow side), a coral warhead in the bullets' colour, swept fins behind,
// dark-outer + bright-inner rims and a nose glint.
const buildMissileSprite = (): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(HALF_W * 2 * SPRITE_SCALE);
  canvas.height = Math.ceil(HALF_H * 2 * SPRITE_SCALE);
  const g = canvas.getContext("2d")!;
  g.scale(SPRITE_SCALE, SPRITE_SCALE);
  g.translate(HALF_W, HALF_H);

  const finGrad = g.createLinearGradient(0, -R - FIN, 0, R + FIN);
  finGrad.addColorStop(0, `hsla(${WARHEAD_HUE + 6}, 85%, 62%, 1)`);
  finGrad.addColorStop(1, `hsla(${WARHEAD_HUE - 10}, 80%, 30%, 1)`);
  traceFins(g);
  g.fillStyle = finGrad;
  g.fill();
  g.lineWidth = 0.6;
  g.strokeStyle = "hsla(230, 40%, 6%, 0.85)";
  g.stroke();

  const body = g.createLinearGradient(0, -R, 0, R);
  body.addColorStop(0, "hsla(200, 30%, 72%, 1)");
  body.addColorStop(0.3, "hsla(195, 35%, 92%, 1)");
  body.addColorStop(0.65, "hsla(212, 28%, 50%, 1)");
  body.addColorStop(1, "hsla(226, 38%, 22%, 1)");
  traceBody(g);
  g.fillStyle = body;
  g.fill();

  g.save();
  traceBody(g);
  g.clip();
  const warhead = g.createLinearGradient(0, -R, 0, R);
  warhead.addColorStop(0, `hsla(${WARHEAD_HUE + 14}, 100%, 82%, 1)`);
  warhead.addColorStop(0.35, `hsla(${WARHEAD_HUE + 6}, 100%, 66%, 1)`);
  warhead.addColorStop(1, `hsla(${WARHEAD_HUE - 12}, 85%, 30%, 1)`);
  g.fillStyle = warhead;
  g.fillRect(SHOULDER - 0.7, -R, TIP - SHOULDER + 0.7, 2 * R);
  g.fillStyle = "hsla(225, 40%, 10%, 0.7)";
  g.fillRect(SHOULDER - 0.95, -R, 0.35, 2 * R);
  g.fillRect(TAIL, -R, 0.7, 2 * R);
  g.restore();

  traceBody(g);
  g.lineWidth = 0.9;
  g.strokeStyle = "hsla(230, 40%, 6%, 0.9)";
  g.stroke();
  g.lineWidth = 0.35;
  g.strokeStyle = "hsla(190, 90%, 90%, 0.9)";
  g.stroke();

  g.fillStyle = "hsla(40, 100%, 97%, 0.95)";
  g.beginPath();
  g.arc(TIP - 1.9, -R * 0.4, 0.45, 0, TAU);
  g.fill();
  return canvas;
};

let missileSprite: HTMLCanvasElement | null = null;

const drawMissile = (ctx: CanvasRenderingContext2D, x: number, alpha: number, scale = 1) => {
  missileSprite ??= buildMissileSprite();
  ctx.globalAlpha = alpha;
  ctx.drawImage(missileSprite, x - HALF_W * scale, -HALF_H * scale, HALF_W * 2 * scale, HALF_H * 2 * scale);
};

// An empty pylon holds a faint ghost of its missile that fills in from the
// tail one quarter per beat of the reload, so the count-in to the refill is
// readable at a glance.
const paintEmptyPylon = (ctx: CanvasRenderingContext2D, ship: Ship, fade: number) => {
  drawMissile(ctx, 0, 0.16 * fade);
  const fill = ship.magazineReloadFill;
  if (fill <= 0.01) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-HALF_W, -HALF_H, PAD + 0.6 + fill * LEN, HALF_H * 2);
  ctx.clip();
  drawMissile(ctx, 0, 0.5 * fade);
  ctx.restore();
};

// A spent missile slides off the front of its pylon and fades, with a flare at
// its tail, alongside the bullet leaving the nose.
const paintLaunch = (ctx: CanvasRenderingContext2D, flash: number, fade: number) => {
  const x = (1 - flash) * 9;
  ctx.globalCompositeOperation = "source-over";
  drawMissile(ctx, x, flash * fade);
  ctx.globalCompositeOperation = "lighter";
  drawGlow(ctx, x + TAIL, 0, 6, 32, 0.9 * flash * fade);
};

// The refill pulse: each missile pops in oversized and white-hot, blooms, and
// throws two rings off its hull, the second just behind the first.
const paintRefillPulse = (ctx: CanvasRenderingContext2D, flash: number, fade: number) => {
  const age = 1 - flash;
  ctx.globalCompositeOperation = "lighter";
  drawMissile(ctx, 0, flash * fade, 1 + 0.45 * flash * flash);
  drawGlow(ctx, 0, 0, 9 + 5 * age, WARHEAD_HUE + 12, 0.75 * flash * fade);
  for (const lag of [0, 0.3]) {
    const p = (age - lag) / (1 - lag);
    if (p < 0 || p >= 1) continue;
    const a = (1 - p) * (1 - p) * fade;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `hsla(${WARHEAD_HUE + 20}, 100%, 85%, ${(0.85 * a).toFixed(3)})`;
    ctx.lineWidth = 0.6 + 1.6 * (1 - p);
    ctx.beginPath();
    ctx.ellipse(0, 0, 5 + 11 * p, 3 + 9 * p, 0, 0, TAU);
    ctx.stroke();
  }
};

// `fade` carries the hull's invulnerability flicker so the pylons blink with it.
export const paintMissilePylons = (ctx: CanvasRenderingContext2D, ship: Ship, beatPulse: number, fade: number) => {
  if (!usesMagazine(ship)) return;
  ctx.save();
  ctx.rotate(ship.heading);
  for (let i = 0; i < MAGAZINE_SIZE; i++) {
    ctx.save();
    ctx.translate(PYLON_X, (i === 0 ? -1 : 1) * PYLON_Y);
    if (i < ship.shotsLoaded) {
      ctx.globalCompositeOperation = "lighter";
      drawGlow(ctx, SHOULDER, 0, 5, WARHEAD_HUE + 12, (0.2 + 0.3 * beatPulse) * fade);
      ctx.globalCompositeOperation = "source-over";
      drawMissile(ctx, 0, fade);
      if (ship.magazineRefillFlash > 0) paintRefillPulse(ctx, ship.magazineRefillFlash, fade);
    } else {
      ctx.globalCompositeOperation = "source-over";
      paintEmptyPylon(ctx, ship, fade);
      if (ship.missileSpentFlash[i] > 0) paintLaunch(ctx, ship.missileSpentFlash[i], fade);
    }
    ctx.restore();
  }
  ctx.restore();
};
