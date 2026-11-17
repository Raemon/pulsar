import type { Asteroid } from "../Asteroid";
import { BEAT_GRID, BEAT_WINDOW } from "./rhythmConstants";
import { drawGlow } from "../glow";

// Beat-shield cube's armour: an almost opaque cubic plate that holds between
// beats, gathers as the window approaches, pops for the whole judged window,
// then re-forms. Reads the beatShieldUp / beatShieldPhase fields
// tickBeatShields copies onto the rock, so "plate gone" means "the window is
// open right now".

// Pale cyan steel over the cube's deep blue, so the plate never reads as part
// of the crystal. The cube's half-side is its radius; the plate sits a fixed
// fraction + a few px proud of it.
const SHIELD_HUE = 192;
const PLATE_GAP = 1.12;
const PLATE_GAP_PX = 3;
const CORNER_FRAC = 0.2;
const SPRITE_PAD = 5;
// Fraction of the up-time spent re-forming, and where the gather starts.
const REFORM_FRAC = 0.22;
const GATHER_START = 0.3;
const GATHER_RING_REACH = 0.75;
const POP_FRAC = 0.3;

type PlateSprites = { shell: HTMLCanvasElement; lattice: HTMLCanvasElement | null; half: number };
const plateSpriteCache = new Map<string, PlateSprites>();

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// windowPhase: 0→1 through the open window (only meaningful while down).
// approach: 0→1 from the plate re-forming to the next window opening (only
// meaningful while up). beatShieldPhase is the signed offset from the nearest
// beat in window half-widths.
const plateTiming = (a: Asteroid) => {
  const offset = a.beatShieldPhase * BEAT_WINDOW;
  if (!a.beatShieldUp) return { windowPhase: clamp01((a.beatShieldPhase + 1) / 2), approach: 0 };
  const closedFor = offset > 0 ? offset - BEAT_WINDOW : offset + BEAT_GRID - BEAT_WINDOW;
  return { windowPhase: 0, approach: clamp01(closedFor / (BEAT_GRID - BEAT_WINDOW * 2)) };
};

const roundedSquare = (ctx: CanvasRenderingContext2D, half: number) => {
  ctx.beginPath();
  ctx.roundRect(-half, -half, half * 2, half * 2, half * CORNER_FRAC);
};

// Square energy grid on the raised inner face, brightest toward the lit
// upper-left corner. Blitted additively so it shimmers over the plate.
const paintLattice = (ctx: CanvasRenderingContext2D, S: number) => {
  const inner = S * 0.74;
  ctx.save();
  roundedSquare(ctx, inner);
  ctx.clip();
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = `hsla(${SHIELD_HUE}, 90%, 80%, 1)`;
  ctx.beginPath();
  const step = inner / 2;
  for (let k = -1; k <= 1; k++) {
    ctx.moveTo(k * step, -inner);
    ctx.lineTo(k * step, inner);
    ctx.moveTo(-inner, k * step);
    ctx.lineTo(inner, k * step);
  }
  ctx.stroke();
  ctx.globalCompositeOperation = "destination-in";
  const lit = ctx.createLinearGradient(-inner, -inner, inner, inner);
  lit.addColorStop(0, "rgba(0,0,0,0.9)");
  lit.addColorStop(1, "rgba(0,0,0,0.25)");
  ctx.fillStyle = lit;
  ctx.fillRect(-inner, -inner, inner * 2, inner * 2);
  ctx.restore();
};

// The plate: dark contact rim, a near-opaque steel body lit from the
// upper-left, a raised inner face whose bevel catches light on its top-left
// lip and falls into shadow bottom-right, a bright hairline rim and a crisp
// glint on the lit corner.
const paintShell = (ctx: CanvasRenderingContext2D, S: number, small: boolean) => {
  const H = SHIELD_HUE;
  ctx.lineJoin = "round";
  ctx.lineWidth = small ? 2 : 3;
  ctx.strokeStyle = `hsla(${H + 20}, 50%, 4%, 0.85)`;
  roundedSquare(ctx, S + (small ? 1 : 1.5));
  ctx.stroke();

  const body = ctx.createLinearGradient(-S, -S, S, S);
  body.addColorStop(0, `hsla(${H - 6}, 45%, 62%, 0.9)`);
  body.addColorStop(0.5, `hsla(${H + 4}, 50%, 38%, 0.9)`);
  body.addColorStop(1, `hsla(${H + 14}, 55%, 16%, 0.93)`);
  ctx.fillStyle = body;
  roundedSquare(ctx, S);
  ctx.fill();

  const inner = S * 0.74;
  const face = ctx.createLinearGradient(-inner, -inner, inner, inner);
  face.addColorStop(0, `hsla(${H}, 45%, 50%, 0.55)`);
  face.addColorStop(1, `hsla(${H + 10}, 50%, 28%, 0.55)`);
  ctx.fillStyle = face;
  roundedSquare(ctx, inner);
  ctx.fill();
  const bevel = ctx.createLinearGradient(-inner, -inner, inner, inner);
  bevel.addColorStop(0, `hsla(${H - 10}, 60%, 90%, 0.85)`);
  bevel.addColorStop(0.5, `hsla(${H}, 50%, 60%, 0.25)`);
  bevel.addColorStop(1, `hsla(${H + 16}, 60%, 6%, 0.8)`);
  ctx.lineWidth = small ? 1 : 1.6;
  ctx.strokeStyle = bevel;
  ctx.stroke();

  ctx.lineWidth = small ? 1 : 1.3;
  ctx.strokeStyle = `hsla(${H - 4}, 80%, 84%, 0.85)`;
  roundedSquare(ctx, S);
  ctx.stroke();

  drawGlow(ctx, -S * 0.72, -S * 0.72, S * 0.22, H - 10, 0.6);
  ctx.globalAlpha = 1;
};

// Keyed on a 2px-bucketed half-side so a field of slightly different cubes
// shares a handful of bakes instead of one per rock.
const getPlateSprites = (rawS: number, small: boolean): PlateSprites => {
  const S = Math.ceil(rawS / 2) * 2;
  const key = `${S}|${small ? 1 : 0}`;
  let sprites = plateSpriteCache.get(key);
  if (sprites) return sprites;
  const half = Math.ceil(S + SPRITE_PAD);
  const bake = (paint: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = half * 2;
    canvas.height = half * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.translate(half, half);
    paint(ctx);
    return canvas;
  };
  // Small tier drops the lattice: at ~15px it's a smudge, and the bevel +
  // glint alone already read as "armour plate".
  sprites = {
    shell: bake((ctx) => paintShell(ctx, S, small)),
    lattice: small ? null : bake((ctx) => paintLattice(ctx, S)),
    half,
  };
  plateSpriteCache.set(key, sprites);
  return sprites;
};

const easeOutBack = (x: number) => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2);

// Drawn in the asteroid's local (translated + rotated) frame, last, over the
// body, squared up to the cube's own tilt so the plate's faces stay parallel to
// the cube's. Per frame: two sprite blits + one ring stroke while up; while
// down, the fading pop blits + the cube's outline stroke + one glow blit.
export const renderBeatShield = (ctx: CanvasRenderingContext2D, a: Asteroid, time: number) => {
  const timing = plateTiming(a);
  const small = a.kind === "beatShieldCrystalSmall";
  const S = a.radius * PLATE_GAP + PLATE_GAP_PX;
  const sprites = getPlateSprites(S, small);
  const fit = S / (sprites.half - SPRITE_PAD);
  ctx.save();
  ctx.rotate(a.squareTilt());

  const blit = (sprite: HTMLCanvasElement, scale: number, alpha: number) => {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.scale(scale * fit, scale * fit);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, -sprites.half, -sprites.half);
    ctx.restore();
  };

  if (a.beatShieldUp) {
    // Re-form: snaps back in from 80% with a small overshoot and a flash, never
    // from zero — the rock is immune again on this very frame, so it must
    // already look shielded. Gather: the plate tightens + brightens while a
    // square closes in from outside and touches the rim exactly as the window opens.
    const reform = clamp01(timing.approach / REFORM_FRAC);
    const presence = 0.55 + 0.45 * reform;
    const gather = clamp01((timing.approach - GATHER_START) / (1 - GATHER_START));
    const g2 = gather * gather;
    const scale = (0.8 + 0.2 * easeOutBack(reform)) * (1 - 0.06 * g2);
    const shimmer = 0.08 * Math.sin(time * 11 + a.membranePhase);
    ctx.globalCompositeOperation = "source-over";
    blit(sprites.shell, scale, presence);
    ctx.globalCompositeOperation = "lighter";
    blit(sprites.shell, scale, 0.5 * (1 - reform) + 0.25 * g2);
    if (sprites.lattice) blit(sprites.lattice, scale, presence * (0.25 + 0.6 * g2 + shimmer));
    if (gather > 0) {
      ctx.globalAlpha = 1;
      ctx.lineJoin = "round";
      ctx.lineWidth = (small ? 0.8 : 1) + (small ? 0.8 : 1.4) * g2;
      ctx.strokeStyle = `hsla(${SHIELD_HUE - 10}, 90%, ${70 + 22 * g2}%, ${0.15 + 0.75 * g2})`;
      roundedSquare(ctx, S * scale * (1 + GATHER_RING_REACH * (1 - gather)));
      ctx.stroke();
    }
    ctx.restore();
  } else {
    // Pop: the plate flings outward and thins away in the first third of the
    // window. Exposed: the cube's own edge lights up hot for the whole window
    // and fades over its last fifth, so the closing is readable too.
    const wp = timing.windowPhase;
    const pop = clamp01(wp / POP_FRAC);
    const popFade = (1 - pop) * (1 - pop);
    ctx.globalCompositeOperation = "lighter";
    blit(sprites.shell, 1 + 0.3 * pop, popFade * 0.9);
    if (sprites.lattice) blit(sprites.lattice, 1 + 0.45 * pop, popFade);
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const expose = wp < 0.8 ? 1 : (1 - wp) / 0.2;
    drawGlow(ctx, 0, 0, a.radius * 1.5, a.hue, 0.45 * (1 - wp) * (1 - wp) + 0.12 * expose);
    ctx.globalAlpha = 1;
    ctx.lineJoin = "miter";
    ctx.lineWidth = small ? 1.2 : 1.8;
    ctx.strokeStyle = `hsla(${a.hue - 12}, 90%, 80%, ${0.85 * expose})`;
    a.tracePath(ctx, 1);
    ctx.stroke();
    ctx.restore();
  }
};
