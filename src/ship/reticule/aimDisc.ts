import { Vec, TAU } from "../../vec";
import { BULLET_SIGHT_RADIUS_ON_BEAT, BULLET_SIGHT_RADIUS_OFF_BEAT, ReticuleTarget, slotCrosshairLengthTrajectory } from "./trajectoryPreview";
import { toroidalDelta } from "./coneGeometry";

// matches the ship trajectory chevron hue so the reticule reads as "yours"
const RETICULE_DASH_HSL = "195, 100%, 90%";

const RETICULE_LINE_DASH: [number, number] = [4, 4];
// dashed crosshair sticking out past the outer disc — reads as "this is a targeting sight",
// matching the lock-circle crosshair used on the on-rhythm aim spot. The reticule's tick length
// shadows its matching trajectory-dot tick length (1-beat reticule pairs with 1-beat dot, etc.)
// so the player can scan "small ticks pair with small ticks" to know which to drift-lock.
const RETICULE_CROSSHAIR_GAP = 3;
// reticule ticks extend the matching dot's ticks by this much so the reticule still reads as the
// larger sight while preserving the per-slot pairing.
const RETICULE_TICK_BONUS = 1;
const RETICULE_CROSSHAIR_DASH: [number, number] = [2, 2];
// brightness boost when the disc covers a target tells the player "this shot will land".
const RETICULE_OVERLAP_BRIGHTNESS = 3;

// tutorial highlight ("Use your targeting tools to aim.") — repaints the dashed ring
// in white with a steady yellow shadow-blur halo so the player's eye is pulled to it.
const TUTORIAL_HIGHLIGHT_HSL = "0, 0%, 100%";
const TUTORIAL_HIGHLIGHT_GLOW_HSL = "52, 100%, 60%";
const TUTORIAL_HIGHLIGHT_GLOW_ALPHA = 0.9;

// pre-check whether any target's silhouette overlaps the on-beat disc before painting anything.
export const reticuleOverlapsAnyTarget = (
  reticulePos: Vec, targets: ReadonlyArray<ReticuleTarget>, w: number, h: number,
): boolean => {
  for (const t of targets) {
    const [dx, dy] = toroidalDelta(reticulePos.x - t.pos.x, reticulePos.y - t.pos.y, w, h);
    const rSum = (t.radius ?? 0) + BULLET_SIGHT_RADIUS_ON_BEAT;
    if (dx * dx + dy * dy <= rSum * rSum) return true;
  }
  return false;
};

// two concentric dashed circles — inner is off-beat hit radius, outer is on-beat (larger).
// Bright only when a first-beat dot sits under the reticule (or tutorial highlight); otherwise
// at the baseAlpha set by the caller, so the bright state means "this shot lands on the next
// beat" unambiguously. The per-beat pulse already lives in `baseAlpha` via the caller.
export const paintAimDiscs = (
  ctx: CanvasRenderingContext2D, reticulePos: Vec, baseAlpha: number,
  overlapsTarget: boolean, onFirstBeatDot: boolean,
  tutorialHighlight: boolean = false,
  slot: number = 1,
) => {
  // slot ≤ 0 (e.g. prong fans the shot off-axis) falls back to the default 1-beat tick length.
  const tickLength = (slot >= 1 ? slotCrosshairLengthTrajectory(slot) : slotCrosshairLengthTrajectory(1)) + RETICULE_TICK_BONUS;
  const locked = onFirstBeatDot || tutorialHighlight;
  const overlapBoost = overlapsTarget || locked ? RETICULE_OVERLAP_BRIGHTNESS : 1;
  const hitAlpha = Math.min(1, baseAlpha * overlapBoost);
  ctx.globalAlpha = 1;
  const prevShadowColor = ctx.shadowColor;
  if (tutorialHighlight) {
    ctx.shadowColor = `hsla(${TUTORIAL_HIGHLIGHT_GLOW_HSL}, ${TUTORIAL_HIGHLIGHT_GLOW_ALPHA})`;
  }
  const dashHsl = tutorialHighlight ? TUTORIAL_HIGHLIGHT_HSL : RETICULE_DASH_HSL;
  ctx.strokeStyle = `hsla(${dashHsl}, ${tutorialHighlight ? Math.max(hitAlpha, 0.85) : hitAlpha})`;
  ctx.lineWidth = 1;
  ctx.setLineDash(RETICULE_LINE_DASH);
  const isSecondary = slot >= 2;
  // secondary reticules (farshot / high-rhythm 2nd & 3rd) are just the crosshair
  // ticks — no circles — so only the primary reads as the full targeting disc.
  if (!isSecondary) {
    ctx.beginPath();
    ctx.arc(reticulePos.x, reticulePos.y, BULLET_SIGHT_RADIUS_OFF_BEAT, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(reticulePos.x, reticulePos.y, BULLET_SIGHT_RADIUS_ON_BEAT, 0, TAU);
    ctx.stroke();
  }
  if (isSecondary) ctx.setLineDash([]);
  else ctx.setLineDash(RETICULE_CROSSHAIR_DASH);
  const ringRadius = isSecondary ? BULLET_SIGHT_RADIUS_OFF_BEAT : BULLET_SIGHT_RADIUS_ON_BEAT;
  const cInner = ringRadius + RETICULE_CROSSHAIR_GAP;
  const cOuter = cInner + tickLength;
  ctx.beginPath();
  ctx.moveTo(reticulePos.x - cOuter, reticulePos.y); ctx.lineTo(reticulePos.x - cInner, reticulePos.y);
  ctx.moveTo(reticulePos.x + cInner, reticulePos.y); ctx.lineTo(reticulePos.x + cOuter, reticulePos.y);
  ctx.moveTo(reticulePos.x, reticulePos.y - cOuter); ctx.lineTo(reticulePos.x, reticulePos.y - cInner);
  ctx.moveTo(reticulePos.x, reticulePos.y + cInner); ctx.lineTo(reticulePos.x, reticulePos.y + cOuter);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowColor = prevShadowColor;
};
