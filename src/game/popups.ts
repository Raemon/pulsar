// Popup drift velocity is purely visual — cosmetic stream so it can't shift the
//   gameplay RNG draw count and desync replays.
import { Vec, cosmeticRand as rand, toroidalDelta } from "../vec";
import { PowerupKind, POWERUP_HUE } from "../Canister";
import { formatScore } from "./formatScore";
import { driftTierPulseHsl } from "../ship/reticule/reticuleRender";
import { BEAT_GRID, FAR_SHOT_BIG_BEATS } from "./rhythmConstants";

// one shape powers combo/pickup/debug overlays so all three share the tick + render loop.
export type Popup = {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  text: string;
  font: string;
  fill: string;
  shadowColor: string;
  decayX: number;
  decayY: number;
  popPeak: number;
  popDuration: number;
  holdUntil: number;
  fadeGain: number;
  // when set, the popup tracks this entity's position each frame (plus the
  // followOffset) instead of drifting on its own vel — used for the resonance
  // "+N" tags that ride along with a freshly-split bassteroid fragment. The
  // target is dropped from tracking once it leaves the field (see updatePopups).
  follow?: { pos: Vec };
  followOffset?: Vec;
  // when set, replaces the default text fill at render time — lets a popup
  // composite its own glyphs (e.g. keycaps for the Side Engines pickup).
  draw?: (ctx: CanvasRenderingContext2D, p: Popup, alpha: number, scale: number) => void;
  // approximate half-extents of the rendered text, used by the anti-overlap
  // pass — only set where the font/text derivation is wrong (multi-line draws).
  halfW?: number;
  halfH?: number;
};

const COMBO_POPUP_LIFE = 0.9;
const PICKUP_POPUP_LIFE = 1.6;
const BEAT_DEBUG_POPUP_LIFE = 1.2;
const SCORE_POPUP_LIFE = 1.0;
const BONUS_LIFE_POPUP_LIFE = 2.2;

const POWERUP_LABEL: Record<PowerupKind, string> = {
  prong: "PRONG",
  rapid: "RAPID FIRE",
  pierce: "PIERCE",
  shield: "SHIELD",
  slow: "SLOW-MO",
  radar: "RADAR",
  longshot: "FARSHOT",
  sideEngines: "SIDE ENGINES",
  lasershot: "LASER SHOT",
  bomb: "BOMB",
};

// anchors the multiplier feedback at the spot the player actually struck, not a corner pulse.
export const popupCombo = (pos: Vec, multiplier: number): Popup => ({
  pos: { x: pos.x, y: pos.y - 6 },
  vel: { x: rand(-12, 12), y: -70 },
  life: COMBO_POPUP_LIFE,
  maxLife: COMBO_POPUP_LIFE,
  text: `x${multiplier % 1 === 0 ? multiplier.toFixed(0) : multiplier.toFixed(1)}`,
  font: "600 22px 'Space Grotesk', system-ui, sans-serif",
  fill: "#ffd86a",
  shadowColor: "rgba(255, 200, 80, 0.85)",
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.375, popDuration: 0.15,
  holdUntil: 0, fadeGain: 1.4,
});

// The two staged combo numbers a drift shot shows: the first ("Nx") rides the hit itself (the
//   on-beat bump that already landed), the second ("N+1x") fires one beat later when the drift
//   rhythm bonus applies — offset down-right of the first so the player reads the streak climbing
//   one step at a time. Same gold combo styling as popupCombo so they read as combo readouts.
const DRIFT_COMBO_FILL = "#ffd86a";
const DRIFT_COMBO_SHADOW = "rgba(255, 200, 80, 0.85)";
export const popupDriftCombo = (pos: Vec, combo: number, second: boolean): Popup => {
  // second number sits to the lower-right of the first.
  const ox = second ? 26 : 0;
  const oy = second ? 8 : -6;
  // The first number holds full opacity through the beat-gap so it's still solid when the
  //   second pops in, then fades over the same span as the second — both clear together.
  //   Its life spans the gap plus the fade; holdUntil is the fraction (final-life ratio) over
  //   which it fades, so hold-full lasts the first BEAT_GRID and the fade fills the rest.
  const life = second ? COMBO_POPUP_LIFE : BEAT_GRID + COMBO_POPUP_LIFE;
  const holdUntil = second ? 0 : COMBO_POPUP_LIFE / (BEAT_GRID + COMBO_POPUP_LIFE);
  return {
    pos: { x: pos.x + ox, y: pos.y + oy },
    vel: { x: rand(-10, 10) + (second ? 14 : 0), y: -70 },
    life,
    maxLife: life,
    text: `x${combo}`,
    font: "600 22px 'Space Grotesk', system-ui, sans-serif",
    fill: DRIFT_COMBO_FILL,
    shadowColor: DRIFT_COMBO_SHADOW,
    decayX: 0.94, decayY: 0.94,
    popPeak: 0.375, popDuration: 0.15,
    holdUntil, fadeGain: 1.4,
  };
};

// +1-beat reward for landing an on-beat hit while a hover ring is locked.
//   The label always reads in the End-of-Wave summary's light blue (#9be8ff) so "DRIFT SHOT"
//   is instantly recognizable regardless of tier. withSubtitle adds the "N× DAMAGE" line,
//   coloured to match the tier's drift-animation hue — shown on a new run-best multiplier so
//   each escalation announces its worth without nagging on repeats.
const DRIFT_POPUP_FILL = "#9be8ff";
const DRIFT_POPUP_SHADOW = "rgba(120, 220, 255, 0.7)";
export const popupDriftBonus = (pos: Vec, tier = 1, withSubtitle = false): Popup => {
  const labelFont = "700 18px 'Space Grotesk', system-ui, sans-serif";
  const subFont = "600 13px 'Space Grotesk', system-ui, sans-serif";
  const fill = DRIFT_POPUP_FILL;
  const shadow = DRIFT_POPUP_SHADOW;
  const dmgMult = tier + 1; // tier 1..6 → 2×..7× damage
  // match the damage line to the colour the drift lock/animation reached for this tier.
  const dmgFill = `hsl(${driftTierPulseHsl(tier)})`;
  const dmgShadow = `hsla(${driftTierPulseHsl(tier)}, 0.85)`;
  const life = withSubtitle ? 1.6 : COMBO_POPUP_LIFE;
  return {
    pos: { x: pos.x, y: pos.y - 18 },
    vel: { x: rand(-10, 10), y: -65 },
    life,
    maxLife: life,
    text: "DRIFT SHOT",
    font: labelFont,
    fill,
    shadowColor: shadow,
    decayX: 0.94, decayY: 0.94,
    popPeak: 0.4, popDuration: 0.15,
    holdUntil: 0, fadeGain: 1.4,
    halfH: withSubtitle ? 20 : undefined,
    draw: withSubtitle ? (ctx) => {
      ctx.font = labelFont;
      ctx.fillStyle = fill;
      ctx.shadowColor = shadow;
      ctx.fillText("DRIFT SHOT", 0, -8);
      ctx.font = subFont;
      ctx.fillStyle = dmgFill;
      ctx.shadowColor = dmgShadow;
      ctx.fillText(`${dmgMult}× DAMAGE`, 0, 12);
    } : undefined,
  };
};

// shown when a shot glances off an armoured crystal — teaches the player that
//   under-powered hits bounce. Red label over a cyan hint line, mirroring
//   DRIFT SHOT's two-line shape; the caller picks the hint (see collisions.ts).
const INSUFFICIENT_DAMAGE_POPUP_LIFE = 4;
export const popupInsufficientDamage = (pos: Vec, hint: string): Popup => {
  const labelFont = "700 17px 'Space Grotesk', system-ui, sans-serif";
  const subFont = "600 13px 'Space Grotesk', system-ui, sans-serif";
  const fill = "#ff6a6a";
  const shadow = "rgba(255, 90, 90, 0.85)";
  return {
    pos: { x: pos.x, y: pos.y - 18 },
    vel: { x: rand(-8, 8), y: -55 },
    life: INSUFFICIENT_DAMAGE_POPUP_LIFE,
    maxLife: INSUFFICIENT_DAMAGE_POPUP_LIFE,
    text: "INSUFFICIENT DAMAGE",  
    font: labelFont,
    fill,
    shadowColor: shadow,
    decayX: 0.94, decayY: 0.94,
    popPeak: 0.4, popDuration: 0.15,
    holdUntil: 0.55, fadeGain: 1.4,
    halfH: 20,
    draw: (ctx) => {
      ctx.font = labelFont;
      ctx.fillStyle = fill;
      ctx.shadowColor = shadow;
      ctx.fillText("INSUFFICIENT DAMAGE", 0, -8);
      ctx.font = subFont;
      ctx.fillStyle = "#9be8ff";
      ctx.shadowColor = "rgba(120, 220, 255, 0.85)";
      ctx.fillText(hint, 0, 12);
    },
  };
};

// shared shape for the streak-bonus labels — sized/animated like DRIFT SHOT
//   but each gets its own color so the three bonuses read distinctly.
const popupBonusLabel = (pos: Vec, text: string, fill: string, shadowColor: string): Popup => ({
  pos: { x: pos.x, y: pos.y - 18 },
  vel: { x: rand(-10, 10), y: -65 },
  life: COMBO_POPUP_LIFE,
  maxLife: COMBO_POPUP_LIFE,
  text,
  font: "700 18px 'Space Grotesk', system-ui, sans-serif",
  fill,
  shadowColor,
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.4, popDuration: 0.15,
  holdUntil: 0, fadeGain: 1.4,
});

// combo hits on two back-to-back beats — label rides the second hit.
export const popupRapidRhythm = (pos: Vec): Popup =>
  popupBonusLabel(pos, "RAPID RHYTHM", "#ff9ee0", "rgba(255, 130, 210, 0.85)");

// prong pair landing two combo hits on one beat — label sits between the two.
export const popupTwinShot = (pos: Vec): Popup =>
  popupBonusLabel(pos, "TWIN SHOT", "#c9a6ff", "rgba(180, 140, 255, 0.85)");

// a combo hit that landed two beats or more after firing — the 2-beat reticule or deeper. The
//   label carries the flat points it paid ("FAR SHOT +50"), as the streak tag does, so the payout
//   is attributed on the field and not only flashed on the HUD.
//   Mint, so it reads apart from the pink/violet/blue bonus family. From FAR_SHOT_BIG_BEATS the
//   label grows a "N BEATS OUT" line, snaps in larger and holds longer: the longer lead is the
//   bigger achievement and its popup should look it.
const FAR_SHOT_POPUP_FILL = "#9dffb0";
const FAR_SHOT_POPUP_SHADOW = "rgba(120, 255, 170, 0.85)";
const FAR_SHOT_SUB_FILL = "#e6fff0";
const FAR_SHOT_SUB_SHADOW = "rgba(200, 255, 225, 0.85)";
const FAR_SHOT_BIG_POPUP_LIFE = 1.6;
export const popupFarShot = (pos: Vec, beatsAway: number, points: number): Popup => {
  const label = `FAR SHOT +${formatScore(points)}`;
  if (beatsAway < FAR_SHOT_BIG_BEATS) {
    return popupBonusLabel(pos, label, FAR_SHOT_POPUP_FILL, FAR_SHOT_POPUP_SHADOW);
  }
  const labelFont = "700 22px 'Space Grotesk', system-ui, sans-serif";
  const subFont = "600 13px 'Space Grotesk', system-ui, sans-serif";
  return {
    pos: { x: pos.x, y: pos.y - 18 },
    vel: { x: rand(-10, 10), y: -65 },
    life: FAR_SHOT_BIG_POPUP_LIFE,
    maxLife: FAR_SHOT_BIG_POPUP_LIFE,
    text: label,
    font: labelFont,
    fill: FAR_SHOT_POPUP_FILL,
    shadowColor: FAR_SHOT_POPUP_SHADOW,
    decayX: 0.94, decayY: 0.94,
    popPeak: 0.55, popDuration: 0.18,
    holdUntil: 0, fadeGain: 1.4,
    halfH: 22,
    draw: (ctx) => {
      ctx.font = labelFont;
      ctx.fillStyle = FAR_SHOT_POPUP_FILL;
      ctx.shadowColor = FAR_SHOT_POPUP_SHADOW;
      ctx.fillText(label, 0, -9);
      ctx.font = subFont;
      ctx.fillStyle = FAR_SHOT_SUB_FILL;
      ctx.shadowColor = FAR_SHOT_SUB_SHADOW;
      ctx.fillText(`${beatsAway} BEATS OUT`, 0, 12);
    },
  };
};

// per-shot streak payout tag — a single "Streak +N" line naming the points it
//   paid. Cyan-white to match the spark ring carrying the streak and stand
//   apart from the gold combo readouts. A kill can stack three readouts on one
//   strike point (combo "xN" at the hit, score "+N" above it, this tag on
//   top), so the tag spawns above the score popup's band and rises in lockstep
//   with it — same vel + decay — keeping the stack's gaps constant instead of
//   converging.
const STREAK_BONUS_POPUP_LIFE = 1.1;
export const popupStreakBonus = (pos: Vec, points: number): Popup => ({
  pos: { x: pos.x, y: pos.y - 52 },
  vel: { x: rand(-6, 6), y: -60 },
  life: STREAK_BONUS_POPUP_LIFE,
  maxLife: STREAK_BONUS_POPUP_LIFE,
  text: `Streak +${formatScore(points)}`,
  font: "700 18px 'Space Grotesk', system-ui, sans-serif",
  fill: "#bff4ff",
  shadowColor: "rgba(140, 230, 255, 0.85)",
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.35, popDuration: 0.15,
  holdUntil: 0.4, fadeGain: 1,
});

export const COMBO_LOST_POPUP_LIFE = 5;
// surfaces the streak break at the spot that caused it (ship fire / target hit).
//   reason names which half of the rhythm gate failed so the player can correct it.
//   Distinct hues so a glance tells you which: crimson = mistimed *press* (the
//   action you most control), amber = off-beat *hit* (a softer near-miss). Amber
//   stays clear of the saturated gold combo halo so a loss never looks like a
//   reward.
export const popupComboLost = (pos: Vec, reason: "fire" | "hit", timing?: "early" | "late"): Popup => {
  const labelFont = "700 16px 'Space Grotesk', system-ui, sans-serif";
  // off-beat *hits* also name which side of the beat missed — with travel time between
  //   press and impact, "early"/"late" is the correction the player can act on. A
  //   mistimed press needs no such hint (the press *is* the moment), and it's dropped
  //   when the event landed inside the window anyway (a stale off-beat bullet), where
  //   early/late would point the wrong way.
  const base = reason === "fire" ? "Didn't fire on beat" : "Didn't hit on beat";
  // the timed hit-miss rotates through a few phrasings — repetition dulls the
  //   correction, so varied wording keeps the hint readable across a session.
  const hitTimingVariants = timing ? [
    `Didn't hit on beat (${timing})`,
    `Hit too ${timing}`,
    "Aim for the target",
    "Didn't hit on beat",
  ] : [];
  const subtitle = reason === "hit" && timing
    ? hitTimingVariants[Math.floor(Math.random() * hitTimingVariants.length)]
    : `(${base})`;
  const titleFill = reason === "fire" ? "#ff6a6a" : "#ffae4d";
  const titleShadow = reason === "fire" ? "rgba(255, 90, 90, 0.85)" : "rgba(255, 150, 50, 0.85)";
  const subFill = reason === "fire" ? "#ffb3b3" : "#ffd9a8";
  const subShadow = reason === "fire" ? "rgba(255, 130, 130, 0.85)" : "rgba(255, 185, 110, 0.85)";
  return {
    pos: { x: pos.x, y: pos.y - 6 },
    vel: { x: rand(-10, 10), y: -55 },
    life: COMBO_LOST_POPUP_LIFE,
    maxLife: COMBO_LOST_POPUP_LIFE,
    text: "RHYTHM LOST",
    font: labelFont,
    fill: titleFill,
    shadowColor: titleShadow,
    decayX: 0.94, decayY: 0.94,
    popPeak: 0.4, popDuration: 0.15,
    holdUntil: 0.15, fadeGain: 1.4,
    halfH: 20,
    draw: (ctx) => {
      ctx.font = labelFont;
      ctx.fillStyle = titleFill;
      ctx.shadowColor = titleShadow;
      ctx.fillText("RHYTHM LOST", 0, -10);
      ctx.fillStyle = subFill;
      ctx.shadowColor = subShadow;
      ctx.fillText(subtitle, 0, 12);
    },
  };
};

// The once-a-run targeting lesson (see game/aimHint.ts): shown instead of the usual
//   "RHYTHM LOST / Didn't hit on beat" popup when the player is pressing in time but
//   shooting at the rock rather than at the lead reticule. Pinned to the reticule the
//   pulse is blooming around, so text and target read as one instruction, and it holds
//   AIM_HINT_LIFE_MUL longer than the popup it replaces since it asks for two changes.
export const AIM_HINT_LIFE_MUL = 1.3;
const AIM_HINT_FILL = "#ffd9a8";
const AIM_HINT_SHADOW = "rgba(255, 185, 110, 0.85)";
export const popupAimHint = (anchor: { pos: Vec }, targetRadius: number): Popup => {
  // same face/size as the off-beat-hit correction line this replaces.
  const font = "700 16px 'Space Grotesk', system-ui, sans-serif";
  const life = COMBO_LOST_POPUP_LIFE * AIM_HINT_LIFE_MUL;
  return {
    pos: { x: anchor.pos.x, y: anchor.pos.y },
    vel: { x: 0, y: 0 },
    life,
    maxLife: life,
    text: "Aim for the target.",
    font,
    fill: AIM_HINT_FILL,
    shadowColor: AIM_HINT_SHADOW,
    decayX: 1, decayY: 1,
    popPeak: 0.35, popDuration: 0.15,
    holdUntil: 0.35, fadeGain: 1,
    follow: anchor,
    // The reticule this pins to sits on the target's player-facing surface, so the body
    //   extends a full diameter past it — anything less than that plus the text's own height
    //   lands the lines on the lit rock.
    followOffset: { x: 0, y: -(2 * targetRadius + 56) },
    halfH: 22,
    draw: (ctx) => {
      ctx.font = font;
      ctx.fillStyle = AIM_HINT_FILL;
      ctx.shadowColor = AIM_HINT_SHADOW;
      ctx.fillText("Aim for the target.", 0, -10);
      ctx.fillText("Hit on the beat.", 0, 12);
    },
  };
};

// "+N" readout at the kill site so the player sees exactly what their hit was worth.
export const popupScore = (pos: Vec, points: number): Popup => ({
  pos: { x: pos.x, y: pos.y - 22 },
  vel: { x: rand(-10, 10), y: -60 },
  life: SCORE_POPUP_LIFE,
  maxLife: SCORE_POPUP_LIFE,
  text: `+${formatScore(points)}`,
  font: "600 18px 'Space Grotesk', system-ui, sans-serif",
  fill: "#e6f4ff",
  shadowColor: "rgba(200, 230, 255, 0.85)",
  decayX: 0.94, decayY: 0.94,
  popPeak: 0.3, popDuration: 0.15,
  holdUntil: 0, fadeGain: 1.4,
});

// "+N" tag pinned just above a bassteroid whose beat-slot the player struck
//   on — paired with the bass-echo lightning arc, it announces that piece's
//   resonance payout at the moment it actually pays. Tinted with the bass
//   kind's own hue so the tag, the arc, and the rock all read as one voice.
//   No vel — the follow target supplies all the motion.
const BASS_ECHO_POPUP_LIFE = 1.0;
export const popupBassEcho = (
  target: { pos: Vec; radius: number; hue: number }, value: number,
): Popup => ({
  pos: { x: target.pos.x, y: target.pos.y },
  vel: { x: 0, y: 0 },
  life: BASS_ECHO_POPUP_LIFE,
  maxLife: BASS_ECHO_POPUP_LIFE,
  text: `+${formatScore(value)}`,
  font: "700 15px 'Space Grotesk', system-ui, sans-serif",
  fill: `hsl(${target.hue}, 95%, 78%)`,
  shadowColor: `hsla(${target.hue}, 95%, 65%, 0.85)`,
  decayX: 1, decayY: 1,
  popPeak: 0.35, popDuration: 0.15,
  holdUntil: 0.4, fadeGain: 1,
  follow: target,
  followOffset: { x: 0, y: -(target.radius + 16) },
});
// bright milestone against the cyan/gold of the combat HUD.
export const popupBonusLife = (pos: Vec): Popup => ({
  pos: { x: pos.x + 26, y: pos.y - 4 },
  vel: { x: 18, y: -28 },
  life: BONUS_LIFE_POPUP_LIFE,
  maxLife: BONUS_LIFE_POPUP_LIFE,
  text: "Bonus Life",
  font: "700 36px 'Space Grotesk', system-ui, sans-serif",
  fill: "#ffffff",
  shadowColor: "rgba(255, 255, 255, 0.9)",
  decayX: 0.96, decayY: 0.96,
  popPeak: 0.5, popDuration: 0.2,
  holdUntil: 0.5, fadeGain: 1,
});

// name-tag lets the player read what they grabbed even after the pickup burst clears.
export const popupPickup = (pos: Vec, kind: PowerupKind): Popup => {
  const hue = POWERUP_HUE[kind];
  return {
    pos: { x: pos.x, y: pos.y - 24 },
    vel: { x: 0, y: -18 },
    life: PICKUP_POPUP_LIFE,
    maxLife: PICKUP_POPUP_LIFE,
    text: POWERUP_LABEL[kind],
    font: "700 18px 'Space Grotesk', system-ui, sans-serif",
    fill: `hsl(${hue}, 90%, 70%)`,
    shadowColor: `hsla(${hue}, 95%, 65%, 0.9)`,
    decayX: 1, decayY: 0.96,
    popPeak: 0.3, popDuration: 0.15,
    holdUntil: 0.3, fadeGain: 1,
  };
};

// dev-only readout to diagnose drift between the rhythm gate and what the player hears.
export const popupBeatDebug = (pos: Vec, prefix: string, onBeat: boolean, offsetMs: string): Popup => ({
  pos: { x: pos.x, y: pos.y - 10 },
  vel: { x: rand(-8, 8), y: -40 },
  life: BEAT_DEBUG_POPUP_LIFE,
  maxLife: BEAT_DEBUG_POPUP_LIFE,
  text: `${prefix} ${onBeat ? "ON" : "OFF"} ${offsetMs}ms`,
  font: "600 14px 'Space Grotesk', system-ui, sans-serif",
  fill: onBeat ? "#7cffb0" : "#ff6a6a",
  shadowColor: onBeat ? "rgba(100, 255, 160, 0.7)" : "rgba(255, 100, 100, 0.7)",
  decayX: 0.94, decayY: 0.94,
  popPeak: 0, popDuration: 0,
  holdUntil: 0, fadeGain: 1.4,
});

// box half-extents for the anti-overlap pass — estimated from the font size
//   and text length unless the popup declared its own (multi-line draws).
const popupHalfW = (p: Popup): number => {
  if (p.halfW !== undefined) return p.halfW;
  const m = /(\d+)px/.exec(p.font);
  return p.text.length * (m ? Number(m[1]) : 16) * 0.31;
};
const popupHalfH = (p: Popup): number => {
  if (p.halfH !== undefined) return p.halfH;
  const m = /(\d+)px/.exec(p.font);
  return (m ? Number(m[1]) : 16) * 0.55;
};

// A single strike point can anchor several hints at once (combo "xN", score
//   "+N", "Streak +N", DRIFT SHOT, RAPID RHYTHM…). Rather than hand-tuning
//   every spawn offset against every combination, slide vertically-overlapping
//   popups apart: pairs with a fresh (just-spawned) member snap fully clear
//   before that popup's first visible frame, while popups that converge
//   mid-flight ease apart. Ghosts that have mostly faded don't shove anyone.
//   Vertical-only so every hint stays column-aligned with the spot it names.
const POPUP_STACK_GAP = 4;
const POPUP_EASE_RATE = 14;
const POPUP_SOLID_ALPHA = 0.3;
const FRESH_SETTLE_PASSES = 4;

const liftPopup = (p: Popup, dy: number) => {
  // follow popups re-pin to their target every tick, so shift the pin itself.
  if (p.follow) {
    p.followOffset = p.followOffset ?? { x: 0, y: 0 };
    p.followOffset.y += dy;
  }
  p.pos.y += dy;
};

const separatePopups = (popups: Popup[], dt: number, w: number, h: number, fresh: boolean[]) => {
  const passes = fresh.some(Boolean) ? FRESH_SETTLE_PASSES : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < popups.length; i++) {
      for (let j = i + 1; j < popups.length; j++) {
        // extra settle passes only chase the fresh snaps; eased pairs move once.
        if (pass > 0 && !fresh[i] && !fresh[j]) continue;
        const a = popups[i], b = popups[j];
        if (a.follow && b.follow) continue;
        if (popupAlpha(a, a.life / a.maxLife) < POPUP_SOLID_ALPHA) continue;
        if (popupAlpha(b, b.life / b.maxLife) < POPUP_SOLID_ALPHA) continue;
        const [dx, dy] = toroidalDelta(b.pos.x - a.pos.x, b.pos.y - a.pos.y, w, h);
        if (Math.abs(dx) >= popupHalfW(a) + popupHalfW(b)) continue;
        const needY = popupHalfH(a) + popupHalfH(b) + POPUP_STACK_GAP;
        if (Math.abs(dy) >= needY) continue;
        const k = fresh[i] || fresh[j] ? 1 : Math.min(1, dt * POPUP_EASE_RATE);
        const push = (needY - Math.abs(dy)) * k;
        // keep current vertical order; a same-spot tie sends the older one up,
        //   matching the rising motion the earlier spawn already has.
        const dir = dy >= 0 ? 1 : -1;
        // pinned follow tags hold their target, and a snapping fresh popup
        //   slots around what's already on screen instead of shoving it.
        const moveA = !a.follow && !(fresh[j] && !fresh[i]);
        const moveB = !b.follow && !(fresh[i] && !fresh[j]);
        if (moveA && moveB) {
          liftPopup(a, -dir * push / 2);
          liftPopup(b, dir * push / 2);
        } else if (moveA) {
          liftPopup(a, -dir * push);
        } else if (moveB) {
          liftPopup(b, dir * push);
        }
      }
    }
  }
};

// returns surviving array so callers can reassign (matches the codebase filter pattern).
export const updatePopups = (popups: Popup[], dt: number, w: number, h: number): Popup[] => {
  // a popup pushed since the last tick hasn't aged yet — snap it clear of
  //   neighbours in one go before the player ever sees it overlapped.
  const fresh = popups.map((p) => p.life === p.maxLife);
  for (const p of popups) {
    p.life -= dt;
    if (p.follow) {
      // Pin to the tracked fragment (+ offset). If that rock is destroyed it's
      // removed from the field but the popup keeps its stale ref — its pos stops
      // updating, so the tag simply freezes where the piece died and fades out.
      p.pos.x = p.follow.pos.x + (p.followOffset?.x ?? 0);
      p.pos.y = p.follow.pos.y + (p.followOffset?.y ?? 0);
    } else {
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.vel.x *= p.decayX;
      p.vel.y *= p.decayY;
    }
  }
  separatePopups(popups, dt, w, h, fresh);
  return popups.filter((p) => p.life > 0);
};

// pickup holds full alpha then fades; combo/debug fade proportionally — one branch covers both.
const popupAlpha = (p: Popup, t: number): number => {
  if (p.holdUntil > 0) return t < p.holdUntil ? t / p.holdUntil : 1;
  return Math.min(1, t * p.fadeGain);
};

// birth-time pop-in scale draws the eye to the popup before settling to baseline size.
const popupScale = (p: Popup, age: number): number => {
  if (p.popPeak <= 0 || age >= p.popDuration) return 1;
  return 1 + (p.popDuration - age) * (p.popPeak / p.popDuration);
};

export const renderPopups = (ctx: CanvasRenderingContext2D, popups: Popup[]) => {
  if (popups.length === 0) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const p of popups) {
    const t = p.life / p.maxLife;
    const alpha = popupAlpha(p, t);
    const scale = popupScale(p, 1 - t);
    ctx.globalAlpha = alpha;
    ctx.font = p.font;
    ctx.fillStyle = p.fill;
    ctx.shadowColor = p.shadowColor;
    ctx.save();
    ctx.translate(p.pos.x, p.pos.y);
    ctx.scale(scale, scale);
    if (p.draw) p.draw(ctx, p, alpha, scale);
    else ctx.fillText(p.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
};

// rounded-square keycap glyph rendered at the popup's local origin.
// x is the cap's center; returns the cap's full width (so the caller can
// advance the cursor).
const drawKeyCap = (
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  label: string,
  color: string, shadow: string,
): number => {
  const w = 22, h = 22, r = 5;
  const x = cx - w / 2, y = cy - h / 2;
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = color;
  ctx.shadowColor = shadow;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "700 14px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, cy + 1);
  ctx.restore();
  return w;
};

// "LASER SHOT" name + a two-line "HOLD TO CHARGE / RELEASE TO FIRE" hint so
// the player learns the charge-up interaction at pickup time. Anchored on the
// ship — caller passes the ship's position, not the canister's — so the hint
// stays next to where the player is looking. Lives a bit longer than a normal
// pickup popup since it carries more text.
const LASER_PICKUP_LIFE = 3.0;
export const popupLaserShotPickup = (shipPos: Vec): Popup => {
  const hue = 195;
  const fill = `hsl(${hue}, 95%, 75%)`;
  const shadow = `hsla(${hue}, 95%, 65%, 0.9)`;
  const labelFont = "700 18px 'Space Grotesk', system-ui, sans-serif";
  const hintFont = "600 13px 'Space Grotesk', system-ui, sans-serif";
  return {
    pos: { x: shipPos.x, y: shipPos.y - 44 },
    vel: { x: 0, y: -8 },
    life: LASER_PICKUP_LIFE,
    maxLife: LASER_PICKUP_LIFE,
    text: "LASER SHOT",
    font: labelFont,
    fill,
    shadowColor: shadow,
    decayX: 1, decayY: 0.97,
    popPeak: 0.3, popDuration: 0.15,
    holdUntil: 0.65, fadeGain: 1.2,
    halfH: 28,
    draw: (ctx) => {
      ctx.font = labelFont;
      ctx.fillStyle = fill;
      ctx.shadowColor = shadow;
      ctx.fillText("LASER SHOT", 0, -12);
      ctx.font = hintFont;
      ctx.fillStyle = "#cfeaff";
      ctx.shadowColor = "rgba(180, 230, 255, 0.7)";
      ctx.fillText("HOLD TO CHARGE", 0, 8);
      ctx.fillText("RELEASE TO FIRE", 0, 24);
    },
  };
};

// "SIDE ENGINES (Z X)" — label text, then a parens-wrapped pair of keycaps
// for the Z and X bindings so the player learns the controls at pickup time.
export const popupSideEnginesPickup = (pos: Vec): Popup => {
  const hue = POWERUP_HUE.sideEngines;
  const fill = `hsl(${hue}, 95%, 72%)`;
  const shadow = `hsla(${hue}, 95%, 65%, 0.9)`;
  const labelFont = "700 18px 'Space Grotesk', system-ui, sans-serif";
  const parenFont = "700 20px 'Space Grotesk', system-ui, sans-serif";
  return {
    pos: { x: pos.x, y: pos.y - 24 },
    vel: { x: 0, y: -18 },
    life: PICKUP_POPUP_LIFE,
    maxLife: PICKUP_POPUP_LIFE,
    text: "SIDE ENGINES (Z X)",
    font: labelFont,
    fill,
    shadowColor: shadow,
    decayX: 1, decayY: 0.96,
    popPeak: 0.3, popDuration: 0.15,
    holdUntil: 0.3, fadeGain: 1,
    draw: (ctx) => {
      // measure piece widths so the whole row centers around the popup origin.
      ctx.save();
      ctx.font = labelFont;
      const labelW = ctx.measureText("SIDE ENGINES ").width;
      ctx.font = parenFont;
      const parenLW = ctx.measureText("(").width;
      const parenRW = ctx.measureText(")").width;
      const capW = 22;
      const capGap = 6;
      const groupW = parenLW + capW + capGap + capW + parenRW;
      const total = labelW + groupW;
      let cursor = -total / 2;

      // label
      ctx.font = labelFont;
      ctx.fillStyle = fill;
      ctx.shadowColor = shadow;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("SIDE ENGINES ", cursor, 0);
      cursor += labelW;

      // "("
      ctx.font = parenFont;
      ctx.fillText("(", cursor, 0);
      cursor += parenLW;

      // [Z]
      drawKeyCap(ctx, cursor + capW / 2, 0, "Z", fill, shadow);
      cursor += capW + capGap;

      // [X]
      drawKeyCap(ctx, cursor + capW / 2, 0, "X", fill, shadow);
      cursor += capW;

      // ")"
      ctx.font = parenFont;
      ctx.fillStyle = fill;
      ctx.shadowColor = shadow;
      ctx.fillText(")", cursor, 0);
      ctx.restore();
    },
  };
};
