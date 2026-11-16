import type { Asteroid } from "../Asteroid";
import { TAU } from "../vec";
import { BEAT_GRID, BEAT_WINDOW } from "./rhythmConstants";
import { drawGlow } from "../glow";

// Beat-shield crystal's energy bubble: holds between beats, gathers as the
// window approaches, pops for the whole judged window, then re-forms. Reads the
// beatShieldUp / beatShieldPhase fields tickBeatShields copies onto the rock,
// so "bubble gone" means "the window is open right now".

// Cyan energy against the crystal's magenta, so the field never reads as part
// of the gem. Bubble sits just off the crystal's spikiest vertex (the clamped
// outline reaches 1.55× radius), not off the nominal radius.
const SHIELD_HUE = 190;
const BUBBLE_GAP = 1.1;
const BUBBLE_GAP_PX = 3;
// Fraction of the up-time spent re-forming, and where the gather starts.
const REFORM_FRAC = 0.22;
const GATHER_START = 0.3;
const GATHER_RING_REACH = 0.75;
const POP_FRAC = 0.3;
const LATTICE_SPIN = 0.35;

type BubbleSprites = { shell: HTMLCanvasElement; lattice: HTMLCanvasElement | null; half: number };
const bubbleSpriteCache = new Map<string, BubbleSprites>();

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// windowPhase: 0→1 through the open window (only meaningful while down).
// approach: 0→1 from the bubble re-forming to the next window opening (only
// meaningful while up). beatShieldPhase is the signed offset from the nearest
// beat in window half-widths.
const bubbleTiming = (a: Asteroid) => {
  const offset = a.beatShieldPhase * BEAT_WINDOW;
  if (!a.beatShieldUp) return { windowPhase: clamp01((a.beatShieldPhase + 1) / 2), approach: 0 };
  const closedFor = offset > 0 ? offset - BEAT_WINDOW : offset + BEAT_GRID - BEAT_WINDOW;
  return { windowPhase: 0, approach: clamp01(closedFor / (BEAT_GRID - BEAT_WINDOW * 2)) };
};

// Hex lattice wrapped onto the visible hemisphere: each flat point at arc
// length s from centre lands at Rb·sin(s/Rb), so cells crowd toward the rim
// the way a real sphere foreshortens. Fresnel + upper-left light are masked in
// afterwards with destination-in so the bake stays one pass of strokes.
const paintLattice = (ctx: CanvasRenderingContext2D, Rb: number, cell: number, lineWidth: number) => {
  const reach = Rb * Math.PI / 2;
  const project = (x: number, y: number) => {
    const s = Math.hypot(x, y);
    if (s < 1e-6) return { x, y };
    const r = Rb * Math.sin(Math.min(s / Rb, Math.PI / 2));
    return { x: (x / s) * r, y: (y / s) * r };
  };
  const colStep = cell * 1.5;
  const rowStep = cell * Math.sqrt(3);
  const cols = Math.ceil(reach / colStep) + 1;
  const rows = Math.ceil(reach / rowStep) + 1;
  const hexCorners = [0, 1, 2, 3, 4, 5].map((k) => ({ x: Math.cos(k * TAU / 6) * cell, y: Math.sin(k * TAU / 6) * cell }));
  const edgeSubdivisions = 4;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.strokeStyle = `hsla(${SHIELD_HUE}, 90%, 78%, 1)`;
  ctx.beginPath();
  for (let c = -cols; c <= cols; c++) {
    for (let r = -rows; r <= rows; r++) {
      const cx = c * colStep;
      const cy = r * rowStep + (c & 1 ? rowStep / 2 : 0);
      if (Math.hypot(cx, cy) > reach + cell) continue;
      for (let k = 0; k < hexCorners.length; k++) {
        const a = hexCorners[k];
        const b = hexCorners[(k + 1) % hexCorners.length];
        for (let i = 0; i <= edgeSubdivisions; i++) {
          const f = i / edgeSubdivisions;
          const p = project(cx + a.x + (b.x - a.x) * f, cy + a.y + (b.y - a.y) * f);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
      }
    }
  }
  ctx.stroke();
  ctx.globalCompositeOperation = "destination-in";
  const fresnel = ctx.createRadialGradient(0, 0, 0, 0, 0, Rb);
  fresnel.addColorStop(0, "rgba(0,0,0,0.1)");
  fresnel.addColorStop(0.6, "rgba(0,0,0,0.28)");
  fresnel.addColorStop(0.9, "rgba(0,0,0,0.85)");
  fresnel.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = fresnel;
  ctx.beginPath();
  ctx.arc(0, 0, Rb, 0, TAU);
  ctx.fill();
  const lit = ctx.createLinearGradient(-Rb, -Rb, Rb, Rb);
  lit.addColorStop(0, "rgba(0,0,0,1)");
  lit.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = lit;
  ctx.fillRect(-Rb, -Rb, Rb * 2, Rb * 2);
  ctx.globalCompositeOperation = "source-over";
};

// The membrane: a near-clear fresnel veil (thicker toward the rim, so it reads
// as a sphere, and dims the crystal a touch so the bare gem pops when it
// drops), a dark contact ring + bright hairline rim, a specular crescent on the
// upper-left shoulder and a faint bounce arc on the shadow side.
const paintShell = (ctx: CanvasRenderingContext2D, Rb: number, small: boolean) => {
  const H = SHIELD_HUE;
  ctx.lineWidth = small ? 2 : 3;
  ctx.strokeStyle = `hsla(${H + 20}, 40%, 4%, 0.4)`;
  ctx.beginPath();
  ctx.arc(0, 0, Rb + (small ? 1 : 1.5), 0, TAU);
  ctx.stroke();

  const veil = ctx.createRadialGradient(-Rb * 0.12, -Rb * 0.15, 0, 0, 0, Rb);
  veil.addColorStop(0, `hsla(${H - 6}, 80%, 62%, 0.05)`);
  veil.addColorStop(0.65, `hsla(${H}, 80%, 55%, 0.09)`);
  veil.addColorStop(0.9, `hsla(${H + 6}, 85%, 58%, 0.24)`);
  veil.addColorStop(1, `hsla(${H + 10}, 90%, 66%, 0.42)`);
  ctx.fillStyle = veil;
  ctx.beginPath();
  ctx.arc(0, 0, Rb, 0, TAU);
  ctx.fill();

  ctx.lineWidth = small ? 1 : 1.3;
  ctx.strokeStyle = `hsla(${H}, 90%, 82%, 0.8)`;
  ctx.beginPath();
  ctx.arc(0, 0, Rb, 0, TAU);
  ctx.stroke();

  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.4, Rb * 0.07);
  ctx.strokeStyle = `hsla(${H - 10}, 60%, 96%, 0.75)`;
  ctx.beginPath();
  ctx.arc(0, 0, Rb * 0.84, -2.65, -1.55);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, Rb * 0.04);
  ctx.strokeStyle = `hsla(${H + 14}, 80%, 70%, 0.3)`;
  ctx.beginPath();
  ctx.arc(0, 0, Rb * 0.88, 0.35, 1.25);
  ctx.stroke();
  drawGlow(ctx, -Rb * 0.5, -Rb * 0.52, Rb * 0.16, H - 10, 0.55);
  ctx.globalAlpha = 1;
};

// Keyed on a 4px-bucketed bubble radius so a field of slightly different
// crystals shares a handful of bakes instead of one per rock.
const getBubbleSprites = (rawRb: number, small: boolean): BubbleSprites => {
  const Rb = Math.ceil(rawRb / 4) * 4;
  const key = `${Rb}|${small ? 1 : 0}`;
  let sprites = bubbleSpriteCache.get(key);
  if (sprites) return sprites;
  const half = Math.ceil(Rb + 5);
  const bake = (paint: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = half * 2;
    canvas.height = half * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.translate(half, half);
    paint(ctx);
    return canvas;
  };
  // Small tier drops the lattice: at ~22px it's a moiré smudge, and the rim +
  // crescent alone already read as "bubble".
  sprites = {
    shell: bake((ctx) => paintShell(ctx, Rb, small)),
    lattice: small ? null : bake((ctx) => paintLattice(ctx, Rb, Rb * 0.3, 0.9)),
    half,
  };
  bubbleSpriteCache.set(key, sprites);
  return sprites;
};

const easeOutBack = (x: number) => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2);

// Drawn in the asteroid's local (translated + rotated) frame, last, over the
// body. The bubble counter-rotates so its baked upper-left light stays put.
// Per frame: two sprite blits + one ring stroke while up; while down, the
// fading pop blits + the crystal's outline stroke + one glow blit.
export const renderBeatShield = (ctx: CanvasRenderingContext2D, a: Asteroid, time: number) => {
  const timing = bubbleTiming(a);
  const small = a.kind === "beatShieldCrystalSmall";
  const Rb = Math.max(...a.outline) * BUBBLE_GAP + BUBBLE_GAP_PX;
  const sprites = getBubbleSprites(Rb, small);
  const fit = Rb / (sprites.half - 5);
  ctx.save();
  ctx.rotate(-a.rotation);

  const blit = (sprite: HTMLCanvasElement, scale: number, alpha: number, spin: number) => {
    if (alpha <= 0.01) return;
    ctx.save();
    if (spin) ctx.rotate(spin);
    ctx.scale(scale * fit, scale * fit);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, -sprites.half, -sprites.half);
    ctx.restore();
  };

  if (a.beatShieldUp) {
    // Re-form: snaps back in from 80% with a small overshoot and a flash, never
    // from zero — the rock is immune again on this very frame, so it must
    // already look shielded. Gather: the bubble tightens + brightens while a
    // ring closes in from outside and touches the rim exactly as the window opens.
    const reform = clamp01(timing.approach / REFORM_FRAC);
    const presence = 0.45 + 0.55 * reform;
    const gather = clamp01((timing.approach - GATHER_START) / (1 - GATHER_START));
    const g2 = gather * gather;
    const scale = (0.8 + 0.2 * easeOutBack(reform)) * (1 - 0.07 * g2);
    const shimmer = 0.06 * Math.sin(time * 11 + a.membranePhase);
    ctx.globalCompositeOperation = "source-over";
    blit(sprites.shell, scale, presence * (0.8 + 0.2 * g2), 0);
    ctx.globalCompositeOperation = "lighter";
    blit(sprites.shell, scale, 0.6 * (1 - reform), 0);
    if (sprites.lattice) blit(sprites.lattice, scale, presence * (0.3 + 0.6 * g2 + shimmer), time * LATTICE_SPIN + a.membranePhase);
    if (gather > 0) {
      const ringR = Rb * scale * (1 + GATHER_RING_REACH * (1 - gather));
      ctx.globalAlpha = 1;
      ctx.lineWidth = (small ? 0.8 : 1) + (small ? 0.8 : 1.4) * g2;
      ctx.strokeStyle = `hsla(${SHIELD_HUE - 10}, 90%, ${70 + 22 * g2}%, ${0.15 + 0.75 * g2})`;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, TAU);
      ctx.stroke();
    }
  } else {
    // Pop: the bubble flings outward and thins away in the first third of the
    // window. Exposed: the crystal's own edge lights up hot for the whole
    // window and fades over its last fifth, so the closing is readable too.
    const wp = timing.windowPhase;
    const pop = clamp01(wp / POP_FRAC);
    const popFade = (1 - pop) * (1 - pop);
    ctx.globalCompositeOperation = "lighter";
    blit(sprites.shell, 1 + 0.3 * pop, popFade * 0.9, 0);
    if (sprites.lattice) blit(sprites.lattice, 1 + 0.45 * pop, popFade, time * LATTICE_SPIN + a.membranePhase);
    const expose = wp < 0.8 ? 1 : (1 - wp) / 0.2;
    drawGlow(ctx, 0, 0, a.radius * 1.5, a.hue, 0.45 * (1 - wp) * (1 - wp) + 0.12 * expose);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.rotate(a.rotation);
    ctx.lineJoin = "miter";
    ctx.lineWidth = small ? 1.2 : 1.8;
    ctx.strokeStyle = `hsla(${a.hue + 20}, 90%, 86%, ${0.85 * expose})`;
    a.tracePath(ctx, 1);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
};
