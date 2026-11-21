import type { Ship } from "../Ship";
import { haloVertices } from "./shipHitbox";
import type { SweepTint } from "./shipBeatSweep";

// combo tier <2 hides halo entirely; 2–3 cyan; 4–11 gold; ≥12 white (matches white bullets).
export const setComboFromValue = (ship: Ship, combo: number) => {
  if (combo >= 12) ship.comboHaloTier = 3;
  else if (combo >= 4) ship.comboHaloTier = 2;
  else if (combo >= 2) ship.comboHaloTier = 1;
  else ship.comboHaloTier = 0;
};

// shows the player where the hitbox actually sits even when no combo halo is active.
const paintDullHaloOutline = (ctx: CanvasRenderingContext2D, dullAlpha: number) => {
  if (dullAlpha <= 0.001) return;
  ctx.strokeStyle = `hsla(210, 30%, 70%, ${dullAlpha})`;
  ctx.lineWidth = 1.2;
  ctx.stroke();
};

const haloTiers = (ship: Ship) => {
  const i = ship.comboHaloIntensity;
  return {
    tier1: Math.min(1, i),
    tier2: Math.max(0, Math.min(1, i - 1)),
    tier3: Math.max(0, Math.min(1, i - 2)),
  };
};
const haloHue = (tier2: number): number => 195 + (45 - 195) * tier2;
const haloSat = (tier3: number): number => 100 * (1 - tier3);

// the beat sweep rides the halo, so it takes the halo's live colour (cyan below any combo).
export const comboHaloTint = (ship: Ship): SweepTint => {
  const { tier2, tier3 } = haloTiers(ship);
  return { hue: haloHue(tier2), sat: haloSat(tier3) };
};

// cyan→gold→white colour shift signals tier crossover; alpha pulses on beat so the rhythm reads at a glance.
const paintActiveHalo = (ctx: CanvasRenderingContext2D, tier1: number, tier2: number, tier3: number, beatPulse: number) => {
  if (tier1 <= 0.001) return;
  const hue = haloHue(tier2);
  const sat = haloSat(tier3);
  const light = 78 + (100 - 78) * tier3;
  const alpha = (0.45 + 0.35 * beatPulse) * tier1;
  ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = `hsla(${hue}, ${sat}%, ${70 + 30 * tier3}%, 1)`;
  ctx.stroke();
};

// red wash exactly where the cyan/gold halo just was, so the loss is felt visually as well as audibly.
const paintComboLossFlash = (ctx: CanvasRenderingContext2D, lossFlash: number) => {
  if (lossFlash <= 0.001) return;
  const alpha = 0.85 * lossFlash;
  ctx.strokeStyle = `hsla(0, 95%, 62%, ${alpha})`;
  ctx.lineWidth = 1.8;
  ctx.shadowColor = `hsla(0, 100%, 55%, 1)`;
  ctx.stroke();
};

// tracing the actual collision silhouette guarantees the halo == hitbox visually and physically.
const traceHaloPath = (ctx: CanvasRenderingContext2D, ship: Ship) => {
  const halo = haloVertices(ship);
  ctx.beginPath();
  ctx.moveTo(halo[0][0], halo[0][1]);
  ctx.lineTo(halo[1][0], halo[1][1]);
  ctx.lineTo(halo[2][0], halo[2][1]);
  ctx.closePath();
};

// single ship-shaped outline that pulses with the beat and shows combo state in one visual.
export const renderComboHalo = (ctx: CanvasRenderingContext2D, ship: Ship, beatPulse: number) => {
  const { tier1, tier2, tier3 } = haloTiers(ship);
  traceHaloPath(ctx, ship);
  paintDullHaloOutline(ctx, 0.4 * (1 - tier1));
  paintActiveHalo(ctx, tier1, tier2, tier3, beatPulse);
  paintComboLossFlash(ctx, ship.comboLossFlash);
};
