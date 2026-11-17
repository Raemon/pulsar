import type { Asteroid } from "../Asteroid";
import { drawGlow } from "../glow";

// Beat cube's fragility: solid sapphire between beats, and for one sharp
// instant on the beat it thins to near-clear glass — a pale edge and a ghost
// of its table face — then snaps solid again. The fade is narrower than the
// judged window on purpose: it marks the beat itself, not the tolerance.
// Reads the beatShieldPhase field tickBeatShields copies onto the rock.

// Half-width of the fade, in judged-window half-widths (the window is ±110ms,
// so 0.4 ≈ ±45ms around the beat).
const FADE_HALF_WIDTH = 0.4;
// How far the solid body fades at the peak (1 = fully invisible).
const FADE_DEPTH = 0.88;
const GLASS_HUE = 205;

// 0 while solid, rising to 1 dead on the beat; smoothstepped so the cube eases
// into glass and back rather than blinking.
export const beatFragility = (a: Asteroid): number => {
  const x = Math.max(0, 1 - Math.abs(a.beatShieldPhase) / FADE_HALF_WIDTH);
  return x * x * (3 - 2 * x);
};

export const beatBodyAlpha = (a: Asteroid): number => 1 - FADE_DEPTH * beatFragility(a);

// Drawn in the asteroid's local (translated + rotated) frame, last, over the
// faded body: a cool glow behind, then the glass edge — a thin bright rim and
// a fainter inset — so the silhouette still reads while the body is clear.
export const renderBeatFragility = (ctx: CanvasRenderingContext2D, a: Asteroid) => {
  const v = beatFragility(a);
  if (v <= 0.01) return;
  const small = a.kind === "beatShieldCrystalSmall";
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  drawGlow(ctx, 0, 0, a.radius * 1.6, GLASS_HUE, 0.3 * v);
  ctx.globalAlpha = 1;
  ctx.lineJoin = "miter";
  ctx.lineWidth = small ? 1.1 : 1.6;
  ctx.strokeStyle = `hsla(${GLASS_HUE - 10}, 80%, 88%, ${0.9 * v})`;
  a.tracePath(ctx, 1);
  ctx.stroke();
  ctx.lineWidth = small ? 0.7 : 1;
  ctx.strokeStyle = `hsla(${GLASS_HUE}, 80%, 80%, ${0.35 * v})`;
  a.tracePath(ctx, 0.55);
  ctx.stroke();
  ctx.restore();
};
