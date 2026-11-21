import type { Game } from "../Game";
// Expansion/wobble seeds only — cosmetic stream so it can't shift the gameplay
// RNG draw count and desync replays.
import { cosmeticRng as rng } from "./rng";
import { driftTierPulseHsl } from "../ship/reticule/reticuleRender";
import { TAU } from "../vec";

// Drift-shot hit burst: a one-shot "sound visualizer explosion" fired when an
// on-beat drift shot lands. Borrows the SoundwaveRadiator / spectrum vocabulary
// — an oscilloscope-wobbled ring, a polar frequency-spectrum bar field, and a
// feathered bloom core — and detonates it outward from the hit point, the way
// the Pulsar's shockwave ring radiates. It reads as the locked drift ring the
// player was holding finally discharging.
//
// Tier scales everything: a tier-1 hit is a small, quick gold ping; the top
// tier is a wide, bright, multi-ring bloom in the same per-tier hue the lock
// pulse climbs through (gold → cyan → magenta → violet → rose → white-gold).
// Each ring expands on an ease-out curve (fast leading edge, trailing into the
// distance) and fades on a squared falloff so the whole event is a flash, not a
// sustained ring — matching bassLightning's flash-not-beam envelope.

// Oscilloscope waveform terms — shared dialect with SoundwaveRadiator and
// bassLightning so the ring squiggles in the same hand.
const OSC_FREQS = [4, 7, 11];
const OSC_RATES = [7.0, 9.8, 12.3];
const OSC_AMPS = [0.55, 0.3, 0.15];
const OSCILLO_SAMPLES = 72;

// Polar spectrum bar terms (matches SoundwaveRadiator's BAR_HEIGHT_* family).
const BAR_FREQS = [2, 4, 6, 9, 12];
const BAR_RATES = [4.7, 5.9, 7.3, 8.6, 9.7];
const BAR_AMPS = [0.45, 0.3, 0.2, 0.14, 0.1];
const BAR_FLOOR = 0.18;

// Life and geometry. Higher tiers live a touch longer and grow much larger so
// the escalation reads at a glance.
const BASE_LIFE = 0.55;
const LIFE_PER_TIER = 0.05;
const BASE_RADIUS = 46;
const RADIUS_PER_TIER = 26;
// Spectrum-bar count scales with tier — a tier-1 ping is a sparse fan; a top
// tier reads as a full polar EQ exploding outward.
const BARS_MIN = 18;
const BARS_PER_TIER = 6;

export type DriftBurst = {
  x: number;
  y: number;
  hue: string; // pre-resolved "H, S%, L%" for the tier
  tier: number;
  life: number;
  maxLife: number;
  maxRadius: number;
  bars: number;
  seed: number;
  // Number of concentric oscilloscope rings; the top tiers stack a couple so
  // the bloom has depth rather than a single lonely circle.
  rings: number;
};

// `hue` lets another bonus (Far Shot) borrow the detonation in its own colour; it must be the
// same integer "H, S%, L%" shape as the tier hues, which is what hslaBoost parses.
export const spawnDriftBurst = (game: Game, x: number, y: number, tier: number, hue?: string) => {
  const t = Math.max(1, tier);
  const life = BASE_LIFE + (t - 1) * LIFE_PER_TIER;
  game.driftBursts.push({
    x,
    y,
    hue: hue ?? driftTierPulseHsl(t),
    tier: t,
    life,
    maxLife: life,
    maxRadius: BASE_RADIUS + (t - 1) * RADIUS_PER_TIER,
    bars: BARS_MIN + (t - 1) * BARS_PER_TIER,
    seed: rng() * TAU,
    rings: 1 + Math.floor((t - 1) / 2),
  });
};

export const updateDriftBursts = (bursts: DriftBurst[], dt: number): DriftBurst[] => {
  for (const b of bursts) b.life -= dt;
  return bursts.filter((b) => b.life > 0);
};

// Oscilloscope-wobbled radius at a given angle for one ring of the burst.
const oscWobble = (ang: number, tSec: number, seed: number): number =>
  OSC_AMPS[0] * Math.sin(OSC_FREQS[0] * ang + tSec * OSC_RATES[0] + seed) +
  OSC_AMPS[1] * Math.sin(OSC_FREQS[1] * ang + tSec * OSC_RATES[1] + seed * 1.618) +
  OSC_AMPS[2] * Math.sin(OSC_FREQS[2] * ang + tSec * OSC_RATES[2] + seed * 2.414);

const drawOscilloRing = (
  ctx: CanvasRenderingContext2D, b: DriftBurst, radius: number, ampPx: number,
  tSec: number, width: number, lightnessBoost: number, alpha: number, seed: number,
) => {
  ctx.lineWidth = width;
  // hue string is "H, S%, L%"; lift lightness for the bright core line.
  ctx.strokeStyle = hslaBoost(b.hue, lightnessBoost, alpha);
  ctx.beginPath();
  for (let s = 0; s <= OSCILLO_SAMPLES; s++) {
    const ang = (s / OSCILLO_SAMPLES) * TAU;
    const r = radius + oscWobble(ang, tSec, seed) * ampPx;
    const px = b.x + Math.cos(ang) * r;
    const py = b.y + Math.sin(ang) * r;
    if (s === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
};

// "H, S%, L%" → "hsla(H, S%, min(96, L+boost)%, a)".
const hslaBoost = (hue: string, lightBoost: number, alpha: number): string => {
  const m = hue.match(/^(\d+),\s*(\d+)%,\s*(\d+)%$/);
  if (!m) return `hsla(${hue}, ${alpha})`;
  const h = m[1];
  const s = m[2];
  const l = Math.min(96, parseInt(m[3], 10) + lightBoost);
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
};

// Polar spectrum bars radiating from just outside the ring — the radiator's EQ
// unrolled around the blast. Bars elongate with tier and the leading-edge
// growth so the explosion reads as energy flung outward.
const drawSpectrumBars = (
  ctx: CanvasRenderingContext2D, b: DriftBurst, innerR: number, span: number,
  tSec: number, env: number,
) => {
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.strokeStyle = hslaBoost(b.hue, 20, 0.5 * env);
  ctx.beginPath();
  for (let i = 0; i < b.bars; i++) {
    const ang = (i / b.bars) * TAU + b.seed;
    const baseA = (i / b.bars) * TAU;
    const raw =
      BAR_AMPS[0] * Math.sin(BAR_FREQS[0] * baseA + tSec * BAR_RATES[0] + b.seed) +
      BAR_AMPS[1] * Math.sin(BAR_FREQS[1] * baseA + tSec * BAR_RATES[1] + b.seed * 1.618) +
      BAR_AMPS[2] * Math.sin(BAR_FREQS[2] * baseA + tSec * BAR_RATES[2] + b.seed * 2.414) +
      BAR_AMPS[3] * Math.sin(BAR_FREQS[3] * baseA + tSec * BAR_RATES[3] + b.seed * 3.302) +
      BAR_AMPS[4] * Math.sin(BAR_FREQS[4] * baseA + tSec * BAR_RATES[4] + b.seed * 4.236);
    const energy = BAR_FLOOR + (1 - BAR_FLOOR) * Math.min(1, Math.abs(raw));
    const h = energy * span;
    if (h < 0.6) continue;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    ctx.moveTo(b.x + dx * innerR, b.y + dy * innerR);
    ctx.lineTo(b.x + dx * (innerR + h), b.y + dy * (innerR + h));
  }
  ctx.stroke();
};

// Caller does NOT need to set composite mode — handled here.
export const renderDriftBursts = (
  ctx: CanvasRenderingContext2D, bursts: DriftBurst[], tSec: number,
) => {
  if (bursts.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";
  for (const b of bursts) {
    const k = b.life / b.maxLife; // 1 → 0
    // Ease-out expansion: leading edge lunges out fast, then trails — same
    // wavefront feel as the Pulsar shockwave.
    const grow = 1 - k * k;
    // Squared release so the burst is a flash, not a sustained ring; a slow
    // shimmer keeps the tail alive without reading as a second pulse.
    const env = k * k * (0.85 + 0.15 * Math.sin(tSec * 23 + b.seed));
    if (env < 0.02) continue;

    const leadR = b.maxRadius * grow;
    const ampPx = b.maxRadius * 0.07 * k; // wobble settles as the ring stretches

    // Feathered bloom core — a soft radial wash centred on the hit, brightest
    // at birth, that sells the "detonation" before the rings race out.
    const bloomR = b.maxRadius * (0.55 + 0.5 * grow);
    const bloomA = env * (0.18 + 0.05 * b.tier);
    const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, bloomR);
    grad.addColorStop(0, hslaBoost(b.hue, 24, bloomA));
    grad.addColorStop(0.5, hslaBoost(b.hue, 0, bloomA * 0.4));
    grad.addColorStop(1, hslaBoost(b.hue, -10, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(b.x, b.y, bloomR, 0, TAU);
    ctx.fill();

    // Concentric oscilloscope rings — the outer (older) ones lag behind the
    // leading edge so the blast reads as a stack of wavefronts, not one circle.
    for (let r = 0; r < b.rings; r++) {
      const ringR = leadR * (1 - r * 0.22);
      if (ringR < 2) continue;
      const ringEnv = env * (1 - r * 0.25);
      const ringSeed = b.seed + r * 1.7;
      // Wide soft glow line, then a bright thin core line on top.
      drawOscilloRing(ctx, b, ringR, ampPx, tSec, 6 * (1 + 0.15 * b.tier), 0, 0.12 * ringEnv, ringSeed);
      drawOscilloRing(ctx, b, ringR, ampPx, tSec, 1.4, 26, 0.8 * ringEnv, ringSeed);
    }

    // Polar spectrum bars riding just outside the leading edge.
    drawSpectrumBars(ctx, b, leadR * 1.02, b.maxRadius * 0.34 * (0.4 + 0.6 * k), tSec, env);
  }
  ctx.restore();
};
