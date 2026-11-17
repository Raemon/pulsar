import type { Asteroid } from "../Asteroid";
import { BEAT_CUBE_TABLE } from "../Asteroid";
import { TAU } from "../vec";

// Beat cube's fragility: solid sapphire between beats; for one short instant
// on the beat it crossfades to a baked clear-glass twin — bright bevel seams,
// a lit edge, a barely-there volume tint — while a specular glint sweeps
// across the face, then snaps solid again. The instant is narrower than the
// judged window on purpose: it marks the beat itself, not the tolerance.
// Reads the beatShieldPhase field tickBeatShields copies onto the rock.

// Envelope in judged-window half-widths (the window is ±110ms; one 60fps
// frame ≈ 0.15): full glass inside ±HOLD, ramping back to solid by ±FADE.
const GLASS_HOLD = 0.2;
const GLASS_FADE = 0.55;
// What's left of the solid body at full glass.
const SOLID_FLOOR = 0.04;
const GLASS_HUE = 195;
const LIGHT_X = -0.7, LIGHT_Y = -0.72;

const glassSprites = new WeakMap<Asteroid, { canvas: HTMLCanvasElement; half: number }>();

export const beatFragility = (a: Asteroid): number => {
  const d = Math.abs(a.beatShieldPhase);
  if (d <= GLASS_HOLD) return 1;
  const x = Math.max(0, 1 - (d - GLASS_HOLD) / (GLASS_FADE - GLASS_HOLD));
  return x * x * (3 - 2 * x);
};

export const beatBodyAlpha = (a: Asteroid): number => 1 - (1 - SOLID_FLOOR) * beatFragility(a);

// The glass twin, in the rock's local frame: each bevel a faint tint by its
// facing (so the clear block still has volume), seams from every corner to
// the table, the table's edge, a two-stroke lit rim, a static streak on the
// table and a glint on the lit corner.
const paintGlass = (ctx: CanvasRenderingContext2D, a: Asteroid) => {
  const R = a.radius;
  const table = R * BEAT_CUBE_TABLE;
  const outer = (k: number) => a.cubeCorner(k, R);
  const inner = (k: number) => a.cubeCorner(k, table);

  a.tracePath(ctx, 1);
  const tint = ctx.createLinearGradient(-R, -R, R, R);
  tint.addColorStop(0, `hsla(${GLASS_HUE - 10}, 70%, 80%, 0.14)`);
  tint.addColorStop(1, `hsla(${GLASS_HUE + 10}, 70%, 55%, 0.05)`);
  ctx.fillStyle = tint;
  ctx.fill();

  for (let k = 0; k < 4; k++) {
    const o0 = outer(k), o1 = outer(k + 1), i0 = inner(k), i1 = inner(k + 1);
    const nx = o0.x + o1.x, ny = o0.y + o1.y;
    const f = (nx * LIGHT_X + ny * LIGHT_Y) / (Math.hypot(nx, ny) || 1);
    ctx.fillStyle = f > 0
      ? `hsla(${GLASS_HUE - 10}, 80%, 88%, ${0.06 + 0.12 * f})`
      : `hsla(${GLASS_HUE + 15}, 60%, 30%, ${0.08 - 0.1 * f})`;
    ctx.beginPath();
    ctx.moveTo(o0.x, o0.y);
    ctx.lineTo(o1.x, o1.y);
    ctx.lineTo(i1.x, i1.y);
    ctx.lineTo(i0.x, i0.y);
    ctx.closePath();
    ctx.fill();
  }

  ctx.lineCap = "round";
  ctx.lineWidth = 1;
  ctx.strokeStyle = `hsla(${GLASS_HUE - 10}, 70%, 92%, 0.6)`;
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const o = outer(k), i = inner(k);
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(i.x, i.y);
  }
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = `hsla(${GLASS_HUE - 10}, 70%, 92%, 0.75)`;
  a.tracePath(ctx, BEAT_CUBE_TABLE);
  ctx.stroke();

  ctx.lineJoin = "miter";
  ctx.lineWidth = 3;
  ctx.strokeStyle = `hsla(${GLASS_HUE + 15}, 60%, 6%, 0.55)`;
  a.tracePath(ctx, 1);
  ctx.stroke();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = `hsla(${GLASS_HUE - 15}, 80%, 94%, 0.95)`;
  a.tracePath(ctx, 1);
  ctx.stroke();

  ctx.save();
  a.tracePath(ctx, BEAT_CUBE_TABLE);
  ctx.clip();
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = "hsla(190, 60%, 97%, 0.5)";
  ctx.fillRect(-table * 1.5, -table * 0.62, table * 3, table * 0.14);
  ctx.fillStyle = "hsla(190, 60%, 97%, 0.25)";
  ctx.fillRect(-table * 1.5, -table * 0.36, table * 3, table * 0.06);
  ctx.restore();

  let glint = outer(0), best = -Infinity;
  for (let k = 0; k < 4; k++) {
    const p = outer(k);
    const f = p.x * LIGHT_X + p.y * LIGHT_Y;
    if (f > best) { best = f; glint = p; }
  }
  ctx.fillStyle = "hsla(190, 60%, 98%, 0.95)";
  ctx.beginPath();
  ctx.arc(glint.x * 0.92, glint.y * 0.92, Math.max(1.2, R * 0.06), 0, TAU);
  ctx.fill();
};

const getGlassSprite = (a: Asteroid) => {
  let sprite = glassSprites.get(a);
  if (sprite) return sprite;
  const half = Math.ceil(a.radius * Math.SQRT2 + 4);
  const canvas = document.createElement("canvas");
  canvas.width = half * 2;
  canvas.height = half * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(half, half);
  paintGlass(ctx, a);
  sprite = { canvas, half };
  glassSprites.set(a, sprite);
  return sprite;
};

// Drawn in the asteroid's local (translated + rotated) frame, last, over the
// faded body: the glass twin, then a bright band sweeping corner to corner
// across the instant (the phase drives it, so it crosses the centre exactly on
// the beat) — light running over glass is what makes "clear" read as glass
// rather than as the rock vanishing.
export const renderBeatFragility = (ctx: CanvasRenderingContext2D, a: Asteroid) => {
  const v = beatFragility(a);
  if (v <= 0.01) return;
  const R = a.radius;
  const sprite = getGlassSprite(a);
  ctx.save();
  ctx.globalAlpha = v;
  ctx.drawImage(sprite.canvas, -sprite.half, -sprite.half);

  const sweep = Math.max(-1, Math.min(1, a.beatShieldPhase / GLASS_FADE));
  a.tracePath(ctx, 1);
  ctx.clip();
  ctx.rotate(-Math.PI / 4);
  ctx.globalCompositeOperation = "lighter";
  const cx = sweep * R * 1.3;
  const band = ctx.createLinearGradient(cx - R * 0.35, 0, cx + R * 0.35, 0);
  band.addColorStop(0, "hsla(190, 80%, 85%, 0)");
  band.addColorStop(0.5, "hsla(190, 80%, 92%, 0.55)");
  band.addColorStop(1, "hsla(190, 80%, 85%, 0)");
  ctx.fillStyle = band;
  ctx.fillRect(cx - R * 0.35, -R * 1.5, R * 0.7, R * 3);
  ctx.restore();
};
