import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import { Vec, toroidalDelta, nearestImageOf } from "../vec";
// Bolt jag/seed visuals only — cosmetic stream so it can't desync replays.
import { cosmeticRng as rng } from "./rng";
import { comboGrid } from "./rhythmGate";
import { BASS_MEASURE_LENGTH } from "../Asteroid";
import { resonanceValueOf } from "./resonanceBonus";
import { popupBassEcho } from "./popups";
import { superBassInterval } from "./bassClock";

// Bass-echo lightning: when an on-rhythm kill (at a healthy combo) lands on
// the same beat-slot a live bassteroid plays, an arc jumps from that
// bassteroid to the kill. The bolt borrows the SoundwaveRadiator vocabulary —
// an oscilloscope-wobbled core plus perpendicular spectrum bars riding the
// arc — so it reads as the bassteroid's own visualizer reaching out, not a
// generic electric zap. The arc anchors to the bassteroid's live position so
// it stays attached while the rock drifts; the kill end stays where the
// target died.

export type BassLightning = {
  source: { pos: Vec; radius: number };
  target: Vec;
  hue: number;
  life: number;
  maxLife: number;
  seed: number;
  // stable per-sample perpendicular jag (px); wobble animates on top.
  jags: number[];
  // Boss-shard arcs render heavier — wider core, brighter glow, longer tail —
  // so a late-game beat-fragment's echo reads as a bigger discharge than a
  // Bassteroid splinter's.
  big: boolean;
};

const LIGHTNING_LIFE = 0.55;
// Boss-shard bolts hang on longer and jag harder than a Bassteroid arc.
const BIG_LIFE_MUL = 1.45;
const BIG_JAG_MUL = 1.6;
const COMBO_REQUIRED = 4;
const MAX_ARCS_PER_KILL = 3;
const SAMPLE_SPACING = 14;
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 40;
const JAG_AMPLITUDE = 8;
const WOBBLE_AMPLITUDE = 4.5;

const TAU = Math.PI * 2;

// matches SoundwaveRadiator's oscilloscope terms so the arc and the puffs
// squiggle in the same dialect.
const OSC_FREQS = [4, 7, 11];
const OSC_RATES = [7.0, 9.8, 12.3];
const OSC_AMPS = [0.55, 0.3, 0.15];

const BAR_FREQS = [2, 4, 6, 9];
const BAR_RATES = [4.7, 5.9, 7.3, 8.6];
const BAR_AMPS = [0.45, 0.3, 0.2, 0.14];
const BAR_FLOOR = 0.2;
const BAR_MAX_LEN = 9;
const BAR_STEP = 2;

// A source rings once per `period`: a whole measure for Bassteroids and boss
// shards, every 2 beats for the superBassCrystal. A kill echoes off it when
// the kill's beat and the source's next pulse share a slot within that period.
const slotIn = (t: number, period: number): number => {
  const m = t % period;
  return m < 0 ? m + period : m;
};

const onSourceSlot = (a: Asteroid, beatCenter: number): boolean => {
  const period = a.isSuperBassCrystal() ? superBassInterval() : BASS_MEASURE_LENGTH;
  const d = Math.abs(slotIn(a.nextBeatAt, period) - slotIn(beatCenter, period));
  return Math.min(d, period - d) < 0.01;
};

const newBolt = (source: Asteroid, target: Vec): BassLightning => {
  const big = source.isBeatFragment() || source.isSuperBassCrystal();
  const d = Math.hypot(target.x - source.pos.x, target.y - source.pos.y);
  const n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(d / SAMPLE_SPACING)));
  const jagAmp = big ? JAG_AMPLITUDE * BIG_JAG_MUL : JAG_AMPLITUDE;
  const jags: number[] = [];
  for (let i = 0; i < n; i++) jags.push((rng() * 2 - 1) * jagAmp);
  const life = big ? LIGHTNING_LIFE * BIG_LIFE_MUL : LIGHTNING_LIFE;
  return {
    source,
    target: { x: target.x, y: target.y },
    hue: source.hue,
    life,
    maxLife: life,
    seed: rng() * TAU,
    jags,
    big,
  };
};

// Fires the arcs (and the "+N" tag beside each source bassteroid) for one
// on-beat kill. `killed` excludes the dying rock from arcing to itself.
export const triggerBassLightning = (game: Game, targetPos: Vec, killed?: Asteroid) => {
  if (game.beatCombo < COMBO_REQUIRED) return;
  const grid = comboGrid(game);
  const beatCenter = Math.round(game.perceivedBeatTime / grid) * grid;
  const sources: Asteroid[] = [];
  for (const a of game.asteroids) {
    if ((!a.isBass() && !a.isBeatFragment() && !a.isSuperBassCrystal()) || a === killed) continue;
    if (onSourceSlot(a, beatCenter)) sources.push(a);
  }
  if (sources.length === 0) return;
  const dist2 = (a: Asteroid) => {
    const [dx, dy] = toroidalDelta(a.pos.x - targetPos.x, a.pos.y - targetPos.y, game.w, game.h);
    return dx * dx + dy * dy;
  };
  sources.sort((a, b) => dist2(a) - dist2(b));
  for (const src of sources.slice(0, MAX_ARCS_PER_KILL)) {
    // arc to the target image nearest this source so it never spans the seam.
    game.bassLightnings.push(newBolt(src, nearestImageOf(targetPos, src.pos, game.w, game.h)));
    const value = resonanceValueOf(src);
    if (value > 0) game.popups.push(popupBassEcho(src, value));
  }
};

export const updateBassLightnings = (bolts: BassLightning[], dt: number): BassLightning[] => {
  for (const l of bolts) l.life -= dt;
  return bolts.filter((l) => l.life > 0);
};

// Anchor-agnostic bolt sampler: a chord from (sx,sy) to (tx,ty), displaced
// perpendicular by each stable jag plus the animated oscilloscope wobble, both
// pinned to zero at the ends. `startD` insets the start off the source so the
// arc leaves a rim rather than the centre. Shared by bass lightning and the
// laser crackle so both squiggle in the same dialect.
export const buildJaggedBolt = (
  sx: number, sy: number, tx: number, ty: number,
  jags: number[], seed: number, tSec: number, startD: number,
): number[] => {
  const n = jags.length;
  let ax = tx - sx;
  let ay = ty - sy;
  const d = Math.hypot(ax, ay) || 1;
  ax /= d;
  ay /= d;
  const px = -ay;
  const py = ax;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const ti = i / (n - 1);
    const pin = Math.sin(Math.PI * ti);
    const w =
      OSC_AMPS[0] * Math.sin(OSC_FREQS[0] * ti * TAU + tSec * OSC_RATES[0] + seed) +
      OSC_AMPS[1] * Math.sin(OSC_FREQS[1] * ti * TAU + tSec * OSC_RATES[1] + seed * 1.618) +
      OSC_AMPS[2] * Math.sin(OSC_FREQS[2] * ti * TAU + tSec * OSC_RATES[2] + seed * 2.414);
    const off = (jags[i] + w * WOBBLE_AMPLITUDE) * pin;
    const along = startD + (d - startD) * ti;
    pts.push(sx + ax * along + px * off, sy + ay * along + py * off);
  }
  return pts;
};

// Polyline samples for one bass bolt: the bassteroid's rim to the kill point.
const buildBoltPoints = (l: BassLightning, tSec: number): number[] => {
  const d = Math.hypot(l.target.x - l.source.pos.x, l.target.y - l.source.pos.y) || 1;
  const startD = Math.min(l.source.radius * 0.9, d * 0.4);
  return buildJaggedBolt(
    l.source.pos.x, l.source.pos.y, l.target.x, l.target.y, l.jags, l.seed, tSec, startD,
  );
};

export const strokePolyline = (
  ctx: CanvasRenderingContext2D, pts: number[], width: number, style: string,
) => {
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
};

// Short spectrum bars perpendicular to the arc — the radiator's polar EQ
// unrolled along the bolt, so the visualizer reads "up and down" the arc.
const drawSpectrumBars = (
  ctx: CanvasRenderingContext2D, l: BassLightning, pts: number[],
  tSec: number, env: number, lightness: number,
) => {
  const n = pts.length / 2;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = `hsla(${l.hue}, 100%, ${Math.min(95, lightness + 18)}%, ${0.4 * env})`;
  ctx.beginPath();
  for (let i = 1; i < n - 1; i += BAR_STEP) {
    const ti = i / (n - 1);
    const pin = Math.sin(Math.PI * ti);
    const raw =
      BAR_AMPS[0] * Math.sin(BAR_FREQS[0] * ti * TAU + tSec * BAR_RATES[0] + l.seed) +
      BAR_AMPS[1] * Math.sin(BAR_FREQS[1] * ti * TAU + tSec * BAR_RATES[1] + l.seed * 1.618) +
      BAR_AMPS[2] * Math.sin(BAR_FREQS[2] * ti * TAU + tSec * BAR_RATES[2] + l.seed * 2.414) +
      BAR_AMPS[3] * Math.sin(BAR_FREQS[3] * ti * TAU + tSec * BAR_RATES[3] + l.seed * 3.302);
    const energy = BAR_FLOOR + (1 - BAR_FLOOR) * Math.min(1, Math.abs(raw));
    const h = energy * BAR_MAX_LEN * pin;
    if (h < 0.6) continue;
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    // local tangent from neighbours; bars sit perpendicular to it.
    const txv = pts[(i + 1) * 2] - pts[(i - 1) * 2];
    const tyv = pts[(i + 1) * 2 + 1] - pts[(i - 1) * 2 + 1];
    const tl = Math.hypot(txv, tyv) || 1;
    const bx = -tyv / tl;
    const by = txv / tl;
    ctx.moveTo(x - bx * h, y - by * h);
    ctx.lineTo(x + bx * h, y + by * h);
  }
  ctx.stroke();
};

// Caller does NOT need to set composite mode — handled here. `sup` is the
// overdrive factor (0→1 as rhythm climbs above 12): past the point the combo
// halo saturates to white, the bolt's core crackles a hotter, whiter discharge
// around its own hue while the coloured glow stays as the surrounding aura.
export const renderBassLightnings = (
  ctx: CanvasRenderingContext2D, bolts: BassLightning[], tSec: number, sup = 0,
) => {
  if (bolts.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const l of bolts) {
    const k = l.life / l.maxLife;
    // sharp attack, squared release — flash, not a sustained beam. The slow
    // shimmer keeps the tail alive without reading as a second pulse. Past 12
    // rhythm the shimmer bites deeper + faster so the bolt visibly crackles.
    const crackle = 0.15 + 0.35 * sup;
    const rate = 23 + 26 * sup;
    const env = k * k * (1 - crackle + crackle * Math.sin(tSec * rate + l.seed));
    if (env < 0.02) continue;
    const pts = buildBoltPoints(l, tSec);
    const lightness = 70 + 12 * sup;
    // Boss-shard bolts get a fatter glow halo + brighter core so the larger
    // discharge reads at a glance; a Bassteroid splinter's stays a thin zap.
    const wMul = l.big ? 1.9 : 1;
    const glowA = l.big ? 0.16 : 0.1;
    strokePolyline(ctx, pts, 6.5 * wMul, `hsla(${l.hue}, 100%, ${lightness}%, ${glowA * env})`);
    strokePolyline(ctx, pts, 2.6 * wMul, `hsla(${l.hue}, 100%, ${lightness + 8}%, ${0.3 * env})`);
    strokePolyline(ctx, pts, 1.2 * (l.big ? 1.5 : 1), `hsla(${l.hue}, 100%, 92%, ${0.75 * env})`);
    // Overdrive core: a fatter, near-white filament riding the same jag, tinted
    // only faintly with the bolt's hue so it reads as white lightning "around
    // the core colour" rather than a colour-shifted bolt.
    if (sup > 0.001) {
      strokePolyline(ctx, pts, 3.6 * wMul, `hsla(${l.hue}, 60%, 96%, ${0.28 * sup * env})`);
      strokePolyline(ctx, pts, 1.6 * (l.big ? 1.5 : 1), `hsla(${l.hue}, 30%, 100%, ${0.85 * sup * env})`);
    }
    drawSpectrumBars(ctx, l, pts, tSec, env, lightness);
  }
  ctx.restore();
};
