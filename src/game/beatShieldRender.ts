import type { Asteroid } from "../Asteroid";
import { BEAT_CUBE_TABLE } from "../Asteroid";
import { drawGlow } from "../glow";
import { TAU, Vec } from "../vec";
import { ENTITY_STATS } from "./entityConfig";

// Beat cube's fragility. Every other body on the field lights up on the beat
// (beatLight.ts); the cube is the one that breaks open instead. Solid sapphire
// between beats; for one short instant on the beat its body thins to a baked
// clear-glass twin whose four bevels lift apart along their seams, and a hot
// core shows through the gaps — armour visibly off — then it shuts and goes
// solid again. The cubes nest: the blue cube's core is the ruby its pieces are
// made of, and a ruby piece cracks open on a core of molten gold. The instant is narrower than the judged window on purpose:
// it marks the beat itself, not the tolerance.
// Reads the beatShieldPhase field tickBeatShields copies onto the rock.

// Envelope in judged-window half-widths (the window is ±110ms; one 60fps
// frame ≈ 0.15): full glass inside ±HOLD, ramping back to solid by ±FADE.
const GLASS_HOLD = 0.2;
const GLASS_FADE = 0.55;
// What's left of the solid body at full glass.
const SOLID_FLOOR = 0.04;
// The glass twin runs a little cooler than the cube's own body colour.
const GLASS_HUE_SHIFT = -27;
const LIGHT_X = -0.7, LIGHT_Y = -0.72;
// How far each bevel lifts off the table at full open, as a fraction of the radius.
const BEVEL_LIFT = 0.17;
const FRAGMENT_CORE_HUE = 44;

const coreHue = (a: Asteroid): number =>
  a.kind === "beatShieldCrystal" ? ENTITY_STATS.beatShieldCrystalSmall!.hue! : FRAGMENT_CORE_HUE;

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
  const GLASS_HUE = a.hue + GLASS_HUE_SHIFT;
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

// The core the shield keeps covered, in the next tier's own material: the cube's
// interior fills with it, with a hot point at the centre and light leaking out along
// the four seams from the centre to each corner.
const paintExposedCore = (ctx: CanvasRenderingContext2D, a: Asteroid, v: number) => {
  const R = a.radius;
  const H = coreHue(a);
  const fill = ctx.createRadialGradient(0, 0, R * 0.05, 0, 0, R * 1.1);
  fill.addColorStop(0, `hsla(${H}, 95%, 52%, ${(0.95 * v).toFixed(3)})`);
  fill.addColorStop(0.6, `hsla(${H + 4}, 90%, 30%, ${(0.8 * v).toFixed(3)})`);
  fill.addColorStop(1, `hsla(${H + 8}, 90%, 15%, ${(0.6 * v).toFixed(3)})`);
  ctx.fillStyle = fill;
  a.tracePath(ctx, 1);
  ctx.fill();
  drawGlow(ctx, 0, 0, R * 0.55, H, 0.6 * v);
  drawGlow(ctx, 0, 0, R * 0.25, 0, 0.6 * v, true);
  ctx.globalAlpha = 1;
  ctx.lineCap = "round";
  ctx.strokeStyle = `hsla(${H}, 100%, 78%, ${(0.8 * v).toFixed(3)})`;
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const o = a.cubeCorner(k, R * 1.05);
    ctx.moveTo(0, 0);
    ctx.lineTo(o.x, o.y);
  }
  ctx.stroke();
};

const traceQuad = (ctx: CanvasRenderingContext2D, p: Vec[]) => {
  ctx.beginPath();
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
  ctx.closePath();
};

// Drawn in the asteroid's local (translated + rotated) frame, last, over the
// faded body: the exposed core, then the glass twin cut into its table and four
// bevels, each bevel pushed out along its own face normal so the seams gape.
export const renderBeatFragility = (ctx: CanvasRenderingContext2D, a: Asteroid) => {
  const v = beatFragility(a);
  if (v <= 0.01) return;
  const R = a.radius;
  const table = R * BEAT_CUBE_TABLE;
  const sprite = getGlassSprite(a);
  const lift = R * BEVEL_LIFT * v;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  paintExposedCore(ctx, a, v);
  ctx.globalAlpha = v;

  ctx.save();
  traceQuad(ctx, [0, 1, 2, 3].map((k) => a.cubeCorner(k, table)));
  ctx.clip();
  ctx.drawImage(sprite.canvas, -sprite.half, -sprite.half);
  ctx.restore();

  // Each bevel's clip reaches a touch past the outline so the baked rim strokes come with it.
  for (let k = 0; k < 4; k++) {
    const o0 = a.cubeCorner(k, R * 1.12), o1 = a.cubeCorner(k + 1, R * 1.12);
    const i0 = a.cubeCorner(k, table), i1 = a.cubeCorner(k + 1, table);
    const nx = o0.x + o1.x, ny = o0.y + o1.y;
    const nl = Math.hypot(nx, ny) || 1;
    ctx.save();
    ctx.translate((nx / nl) * lift, (ny / nl) * lift);
    traceQuad(ctx, [o0, o1, i1, i0]);
    ctx.clip();
    ctx.drawImage(sprite.canvas, -sprite.half, -sprite.half);
    ctx.restore();
  }
  ctx.restore();
};
