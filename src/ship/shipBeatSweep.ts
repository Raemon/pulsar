import { Vec } from "../vec";
import { drawGlow } from "../glow";
import { BEAT_GRID } from "../game/rhythmConstants";

// A count-in the eye can time a shot against with the sound off. Twin sparks leave the
// middle of the ship's outline at the stern, run out to the rear corners and up both
// flanks to the nose, crossing the line of the loaded rounds exactly on the beat. They
// travel at a constant speed so the crossing is predictable from the motion, ride at a
// medium glow, and flare to full brightness the instant they cross before settling back.
const SWEEP_TRAVEL_SEC = 0.48;
const SWEEP_MEDIUM = 0.45;
const SWEEP_FLASH_SEC = 0.12;
const SWEEP_FADE_IN = 0.15;
const SWEEP_FADE_OUT = 0.2;
const SWEEP_TAIL_FRACTION = 0.3;
const SWEEP_TAIL_SLICES = 8;
const SWEEP_CORE_WIDTH = 2;
const SWEEP_CORE_ALPHA = 1;
const SWEEP_BLOOM_WIDTH = 5.5;
const SWEEP_BLOOM_ALPHA = 0.2;
const SWEEP_HEAD_GLOW_R = 6;
const SWEEP_HEAD_FLASH_GLOW_R = 11;
const SWEEP_HEAD_GLOW_ALPHA = 0.6;

// hue/sat of the outline the sparks ride, so they read as that outline lighting up.
export type SweepTint = { hue: number; sat: number };

type Flank = { pts: Vec[]; cum: number[] };

const flank = (pts: Vec[]): Flank => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, cum };
};

const flankLength = (f: Flank): number => f.cum[f.cum.length - 1];

const pointAlong = (f: Flank, s: number): Vec => {
  for (let i = 1; i < f.pts.length; i++) {
    if (s <= f.cum[i] || i === f.pts.length - 1) {
      const span = f.cum[i] - f.cum[i - 1] || 1;
      const k = Math.max(0, Math.min(1, (s - f.cum[i - 1]) / span));
      const a = f.pts[i - 1];
      const b = f.pts[i];
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return f.pts[f.pts.length - 1];
};

// distance along the flank at which it first reaches `forward`, measured stern → nose on `axis`.
const distanceAtForward = (f: Flank, axis: Vec, forward: number): number => {
  const origin = f.pts[0];
  const along = (p: Vec) => (p.x - origin.x) * axis.x + (p.y - origin.y) * axis.y;
  for (let i = 1; i < f.pts.length; i++) {
    const a = along(f.pts[i - 1]);
    const b = along(f.pts[i]);
    if (forward <= b && b > a) {
      const k = Math.max(0, Math.min(1, (forward - a) / (b - a)));
      return f.cum[i - 1] + k * (f.cum[i] - f.cum[i - 1]);
    }
  }
  return flankLength(f);
};

// the slice [s0, s1] of a flank, keeping any corner it wraps so the tail bends with the outline.
const traceSlice = (ctx: CanvasRenderingContext2D, f: Flank, s0: number, s1: number) => {
  const start = pointAlong(f, s0);
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < f.pts.length - 1; i++) {
    if (f.cum[i] > s0 && f.cum[i] < s1) ctx.lineTo(f.pts[i].x, f.pts[i].y);
  }
  const end = pointAlong(f, s1);
  ctx.lineTo(end.x, end.y);
};

const paintSpark = (
  ctx: CanvasRenderingContext2D, f: Flank, head: number, tail: number, intensity: number, tint: SweepTint,
) => {
  for (let k = 0; k < SWEEP_TAIL_SLICES; k++) {
    const s1 = head - (tail * k) / SWEEP_TAIL_SLICES;
    const s0 = Math.max(0, head - (tail * (k + 1)) / SWEEP_TAIL_SLICES);
    if (s1 <= s0) break;
    const falloff = Math.pow(1 - k / SWEEP_TAIL_SLICES, 1.6) * intensity;
    ctx.beginPath();
    traceSlice(ctx, f, s0, s1);
    ctx.lineWidth = SWEEP_BLOOM_WIDTH;
    ctx.strokeStyle = `hsla(${tint.hue}, ${tint.sat}%, 70%, ${(SWEEP_BLOOM_ALPHA * falloff).toFixed(3)})`;
    ctx.stroke();
    ctx.lineWidth = SWEEP_CORE_WIDTH;
    ctx.strokeStyle = `hsla(${tint.hue}, ${tint.sat}%, 90%, ${(SWEEP_CORE_ALPHA * falloff).toFixed(3)})`;
    ctx.stroke();
  }
};

// 1 the instant the sparks cross the beat mark, easing back to medium over SWEEP_FLASH_SEC.
const flashAt = (secondsSinceBeat: number): number => {
  if (secondsSinceBeat < 0 || secondsSinceBeat >= SWEEP_FLASH_SEC) return 0;
  const k = 1 - secondsSinceBeat / SWEEP_FLASH_SEC;
  return k * k;
};

// verts = [nose, port rear corner, starboard rear corner] in the ship-local frame; the sparks
// cross level with beatMark (a point in that frame) exactly on the beat.
// secondsIntoBeat is time since the last beat the player hears; null = no beat to cue.
export const paintOutlineBeatSweep = (
  ctx: CanvasRenderingContext2D, verts: ReadonlyArray<Vec>, beatMark: Vec, secondsIntoBeat: number | null,
  brightness: number, tint: SweepTint,
) => {
  if (secondsIntoBeat === null || brightness <= 0) return;
  const [nose, port, starboard] = verts;
  const stern = { x: (port.x + starboard.x) / 2, y: (port.y + starboard.y) / 2 };
  const axisLen = Math.hypot(nose.x - stern.x, nose.y - stern.y) || 1;
  const axis = { x: (nose.x - stern.x) / axisLen, y: (nose.y - stern.y) / axisLen };
  const markForward = (beatMark.x - stern.x) * axis.x + (beatMark.y - stern.y) * axis.y;
  const flanks = [flank([stern, port, nose]), flank([stern, starboard, nose])];
  const length = flankLength(flanks[0]);
  const speed = length / SWEEP_TRAVEL_SEC;
  const atBeat = distanceAtForward(flanks[0], axis, markForward);
  const tail = length * SWEEP_TAIL_FRACTION;
  const white = tint.sat < 50;
  // butt caps: round ones would overlap at every slice seam and bead up under additive blending.
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  // the spark that crossed on the last beat, and the one heading for the next.
  for (const sinceBeat of [secondsIntoBeat, secondsIntoBeat - BEAT_GRID]) {
    const head = atBeat + sinceBeat * speed;
    if (head <= 0 || head >= length) continue;
    const travel = head / length;
    const edges = Math.min(1, travel / SWEEP_FADE_IN, (1 - travel) / SWEEP_FADE_OUT);
    const flash = flashAt(sinceBeat);
    const intensity = (SWEEP_MEDIUM + (1 - SWEEP_MEDIUM) * flash) * edges * brightness;
    const glowR = SWEEP_HEAD_GLOW_R + (SWEEP_HEAD_FLASH_GLOW_R - SWEEP_HEAD_GLOW_R) * flash;
    for (const f of flanks) {
      paintSpark(ctx, f, head, tail, intensity, tint);
      const p = pointAlong(f, head);
      drawGlow(ctx, p.x, p.y, glowR, tint.hue, SWEEP_HEAD_GLOW_ALPHA * intensity, white);
      ctx.globalAlpha = 1;
    }
  }
  ctx.lineJoin = "miter";
};
