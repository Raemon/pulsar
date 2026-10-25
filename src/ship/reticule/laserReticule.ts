import type { Game } from "../../Game";
import { reachableBeamLengths, laserDotCount, maxLaserDots, laserAimFan, laserCooldownFrac, laserReady } from "../../game/laserShot";
import { muzzleOf } from "../shipWeapons";
import { BEAT_GRID } from "../../game/rhythmConstants";
import { drawGlow } from "../../glow";

// Laser-mode reticule. The circular aim disc is a bullet sight — it has no
// meaning for the beam, which fires straight down the ship's heading — so under
// the laser upgrade renderShipReticules skips it and we draw this instead.
// Aim directions come from laserAimFan, the same list fireLaser spawns beams
// from, so prong automatically gets one gate ladder per beam.
//
// Each reachable charge tier has a "range gate" at the end of its reach: a
// glowing pip on the firing line with a dash before and after it, all collinear
// with the beam (line-dot-line). Crucially the gates
// are CHARGE-AWARE: an idle laser shows only the gate its current (0-dot) shot
// reaches; deeper gates appear one at a time, arming into view, only as the
// player actually holds the charge toward them. So the sight never promises range
// the shot doesn't have.

// Gate hue ramps cyan → warm white-gold as the tier climbs toward max charge,
// mirroring the charge-dot / beam escalation so the sight colour tracks power.
const GATE_HSL_NEAR = { h: 195, s: 100, l: 75 }; // cyan, the resting laser hue
const GATE_HSL_MAX = { h: 45, s: 100, l: 88 };   // white-gold at full charge
// Gate geometry: each dash starts GATE_OFFSET from the pip along the firing
// line and runs GATE_TICK_LEN further; the pip marks the exact reach.
const GATE_OFFSET = 6;
const GATE_TICK_LEN = 9;
const GATE_TICK_WIDTH = 2;
const GATE_PIP_R = 2.4;
// Passed tiers (the shot overshoots them) draw faintly as a charge ladder.
const GATE_PASSED_ALPHA = 0.28;
// gentle on-beat breathe so the gates share the rest of the HUD's pulse.
const PULSE_MIN = 0.45;
const PULSE_MAX = 0.9;
const PULSE_PERIOD_SEC = 2.0;
// The refire lockout dims the whole sight by this much right after a shot,
// recovering to full brightness as the lock releases — the re-arm is visible.
const COOLDOWN_DIM = 0.75;

// Armed ring: a bright pip-ring at the muzzle marking "charged and ready". A
// faint steady ring sits there whenever the laser can refire; laserReadyFlash
// pops an expanding burst on the exact locked→ready edge on top of it.
const ARMED_RING_HSL = { h: 45, s: 100, l: 88 }; // white-gold, the full-charge hue
const ARMED_RING_R = 9;
const ARMED_STEADY_ALPHA = 0.32;
const ARMED_BURST_R = 26;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// hue between the near (cyan) and max (gold) gate colours by tier fraction.
const gateHsl = (tierFrac: number): string => {
  const t = clamp01(tierFrac);
  const h = GATE_HSL_NEAR.h + (GATE_HSL_MAX.h - GATE_HSL_NEAR.h) * t;
  const s = GATE_HSL_NEAR.s + (GATE_HSL_MAX.s - GATE_HSL_NEAR.s) * t;
  const l = GATE_HSL_NEAR.l + (GATE_HSL_MAX.l - GATE_HSL_NEAR.l) * t;
  return `${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%`;
};

// Paint a range gate with its pip on the beam endpoint. A dash on either side
// of the pip, collinear with the beam. `scale` (0..1) grows the glyph in for arming.
const paintGate = (
  ctx: CanvasRenderingContext2D,
  endX: number, endY: number, dx: number, dy: number,
  alpha: number, hsl: string, scale: number,
) => {
  if (alpha <= 0.001 || scale <= 0.001) return;
  const off = GATE_OFFSET * scale;
  const len = GATE_TICK_LEN * scale;
  ctx.save();
  ctx.translate(endX, endY);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.strokeStyle = `hsla(${hsl}, ${alpha})`;
  ctx.lineWidth = GATE_TICK_WIDTH;
  ctx.lineCap = "round";
  // Local +x runs along the beam; one dash short of the pip, one beyond it.
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(off * sign, 0);
    ctx.lineTo((off + len) * sign, 0);
    ctx.stroke();
  }
  // centre pip with a soft glow — the precise endpoint the shot reaches.
  // drawGlow leaves globalAlpha set; reset before the pip fill so it isn't dimmed.
  drawGlow(ctx, 0, 0, GATE_PIP_R * 3 * scale, GATE_HSL_NEAR.h, alpha * 0.5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = `hsla(${hsl}, ${Math.min(1, alpha * 1.2)})`;
  ctx.beginPath();
  ctx.arc(0, 0, GATE_PIP_R * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// Paint the "charged and ready" indicator at a beam's muzzle: a steady faint
// ring while the laser can refire (alpha scaled by `ready`, so it fades in as
// the lockout releases), plus an expanding one-shot burst driven by `flash`
// (1→0) that pops on the exact locked→ready edge.
const paintArmedRing = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, breathe: number, ready01: number, flash: number,
) => {
  const hsl = `${ARMED_RING_HSL.h}, ${ARMED_RING_HSL.s}%, ${ARMED_RING_HSL.l}%`;
  // Steady armed ring — a soft loaded-and-waiting pulse, dim until fully ready.
  const steady = ARMED_STEADY_ALPHA * ready01 * breathe;
  if (steady > 0.001) {
    ctx.strokeStyle = `hsla(${hsl}, ${steady})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, ARMED_RING_R, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Ready burst — a bright ring expanding out and fading as the flash decays.
  if (flash > 0.001) {
    const r = ARMED_RING_R + (ARMED_BURST_R - ARMED_RING_R) * (1 - flash);
    drawGlow(ctx, x, y, r * 0.6, ARMED_RING_HSL.h, flash * 0.5);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = `hsla(${hsl}, ${flash})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
};

export const renderLaserReticule = (
  ctx: CanvasRenderingContext2D, game: Game, beatTime: number,
) => {
  const ship = game.ship;
  if (!ship.alive || !ship.lasershotActive) return;
  const lengths = reachableBeamLengths(game);
  if (lengths.length === 0) return;
  const maxDots = maxLaserDots(game);
  // live charge tier (0 when idle); the gate it reaches is the ACTIVE one.
  const dots = laserDotCount(ship, beatTime, maxDots);
  const charging = ship.laserChargeActive;
  // progress 0..1 toward the next dot — drives the arming gate growing in.
  const nextDotFrac = charging
    ? clamp01((beatTime - (ship.laserChargeStartBeatTime + dots * BEAT_GRID)) / BEAT_GRID)
    : 0;
  const pulse = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * (0.5 + 0.5 * Math.cos((beatTime / PULSE_PERIOD_SEC) * Math.PI * 2));
  const ready = 1 - COOLDOWN_DIM * laserCooldownFrac(game);
  // Muzzle "armed" indicator: steady ring only when loaded and waiting (ready +
  // not mid-charge — a charge already shows its own gate ladder); the burst pops
  // on the ready edge regardless. Both are cosmetic reads of the same lockout.
  const armedSteady = !charging && laserReady(game) ? 1 : 0;
  const readyFlash = ship.laserReadyFlash;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const maxTier = lengths.length - 1;
  // One gate ladder per aim-fan beam, so prong shows a sight on every beam.
  for (const aim of laserAimFan(ship)) {
    const muzzle = muzzleOf(ship, aim.headingOffset);
    paintArmedRing(ctx, muzzle.x, muzzle.y, pulse, armedSteady, readyFlash);
    for (let tier = 0; tier < lengths.length; tier++) {
      const end = aim.endpointAt(lengths[tier]);
      const hsl = gateHsl(maxTier > 0 ? tier / maxTier : 0);
      if (tier < dots) {
        // passed tier — the shot overshoots it; draw a dim ladder rung.
        paintGate(ctx, end.x, end.y, aim.dir.x, aim.dir.y, GATE_PASSED_ALPHA * ready, hsl, 1);
      } else if (tier === dots) {
        // ACTIVE gate — where a release right now lands; full brightness + breathe.
        paintGate(ctx, end.x, end.y, aim.dir.x, aim.dir.y, pulse * ready, hsl, 1);
      } else if (tier === dots + 1 && charging) {
        // ARMING gate — the next tier locking in as the dot lands; grows from 0.
        paintGate(ctx, end.x, end.y, aim.dir.x, aim.dir.y, pulse * nextDotFrac * ready, hsl, 0.4 + 0.6 * nextDotFrac);
      }
      // deeper tiers (tier > dots + 1) are not drawn — they only appear once charge
      // reaches them, so the sight never promises range the shot doesn't have.
    }
  }
  ctx.restore();
};
