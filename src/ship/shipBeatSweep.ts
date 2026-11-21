import { Vec, TAU } from "../vec";
import { drawGlow } from "../glow";
import { BEAT_GRID } from "../game/rhythmConstants";

// A count-in the eye can time a shot against with the sound off. Twin sparks leave the
// middle of the ship's outline at the stern, run out to the rear corners and up both
// flanks, and meet at the nose exactly on the beat, where they burst and drain into the tip. Travel is linear so
// the arrival is predictable from the motion; brightness builds as the sparks climb so
// the launch at the back stays quiet and the eye is led forward to the moment that counts.
const SWEEP_TRAVEL_SEC = 0.3;
const SWEEP_DRAIN_SEC = 0.06;
const SWEEP_FADE_IN = 0.3;
const SWEEP_TAIL_FRACTION = 0.42;
const SWEEP_TAIL_SLICES = 8;
const SWEEP_CORE_WIDTH = 2;
const SWEEP_CORE_ALPHA = 0.95;
const SWEEP_BLOOM_WIDTH = 5.5;
const SWEEP_BLOOM_ALPHA = 0.16;
const SWEEP_HEAD_GLOW_R = 6;
const SWEEP_HEAD_GLOW_ALPHA = 0.5;
const NOSE_BURST_SEC = 0.14;
const NOSE_BURST_GLOW_R = 11;
const NOSE_BURST_ALPHA = 0.75;

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

// verts = [nose, port rear corner, starboard rear corner] in the ship-local frame.
// secondsIntoBeat is time since the last beat the player hears; null = no beat to cue.
export const paintOutlineBeatSweep = (
  ctx: CanvasRenderingContext2D, verts: ReadonlyArray<Vec>, secondsIntoBeat: number | null,
  brightness: number, tint: SweepTint,
) => {
  if (secondsIntoBeat === null || brightness <= 0) return;
  const toNextBeat = BEAT_GRID - secondsIntoBeat;
  const inFlight = toNextBeat <= SWEEP_TRAVEL_SEC;
  const draining = secondsIntoBeat < SWEEP_DRAIN_SEC;
  const bursting = secondsIntoBeat < NOSE_BURST_SEC;
  if (!inFlight && !draining && !bursting) return;
  const [nose, port, starboard] = verts;
  const stern = { x: (port.x + starboard.x) / 2, y: (port.y + starboard.y) / 2 };
  const flanks = [flank([stern, port, nose]), flank([stern, starboard, nose])];
  const length = flankLength(flanks[0]);
  const white = tint.sat < 50;
  // butt caps: round ones would overlap at every slice seam and bead up under additive blending.
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  if (inFlight || draining) {
    const progress = inFlight ? 1 - toNextBeat / SWEEP_TRAVEL_SEC : 1;
    const drain = inFlight ? 0 : secondsIntoBeat / SWEEP_DRAIN_SEC;
    const intensity = Math.min(1, progress / SWEEP_FADE_IN) * (0.65 + 0.35 * progress) * brightness;
    const tail = length * SWEEP_TAIL_FRACTION * (1 - drain);
    for (const f of flanks) {
      const head = progress * flankLength(f);
      paintSpark(ctx, f, head, tail, intensity, tint);
      if (inFlight) {
        const p = pointAlong(f, head);
        drawGlow(ctx, p.x, p.y, SWEEP_HEAD_GLOW_R, tint.hue, SWEEP_HEAD_GLOW_ALPHA * intensity, white);
        ctx.globalAlpha = 1;
      }
    }
  }
  if (bursting) {
    const fade = 1 - secondsIntoBeat / NOSE_BURST_SEC;
    const burst = fade * fade * brightness;
    drawGlow(ctx, nose.x, nose.y, NOSE_BURST_GLOW_R, tint.hue, NOSE_BURST_ALPHA * burst, white);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `hsla(${tint.hue}, ${tint.sat * 0.6}%, 96%, ${(0.9 * burst).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(nose.x, nose.y, 1.8, 0, TAU);
    ctx.fill();
  }
  ctx.lineJoin = "miter";
};
