import { Vec, TAU } from "../../vec";
import { ConeFrame, clipRayToCone, targetIsInsideCone, toroidalDelta } from "./coneGeometry";
import { RETICULE_DASH_HSL } from "./radarCone";
import { TUTORIAL_CONTROL_ACTIONS, type TutorialControlsUsed } from "../../game/controlBindings";
import { bulletCoreRadius } from "../../Bullet";

// The painted aim discs, for a STOCK bullet. Deliberately smaller than the shot's
// true collision reach (bulletCollisionRadius): the outer on-beat ring is 42% of it
// (10.7 painted vs 25.7 real) and the inner off-beat ring 69% (4.5 vs 6.5), so the
// sight under-promises and a shot you judged as landing always lands. To make a ring
// literally the hit area instead, its multiplier below becomes 6 (on-beat) or 3.6
// (off-beat) — that widens the lock thresholds for every weapon, so it is a
// game-feel decision, not a bug fix.
//
// Derived from the bullet's own core radius rather than copied from it: these used
// to be hand-transcribed numbers, and the moment a weapon changed the bullet's size
// the sight went on drawing the old one.
const BULLET_SIGHT_RADIUS_MUL = 2.5;
export const BULLET_SIGHT_RADIUS_ON_BEAT = bulletCoreRadius({ onBeat: true }) * BULLET_SIGHT_RADIUS_MUL;
export const BULLET_SIGHT_RADIUS_OFF_BEAT = bulletCoreRadius({ onBeat: false }) * BULLET_SIGHT_RADIUS_MUL;

// top-level toggles for individual trajectory-preview overlays — flip to false to hide an
// element without ripping out its code. Useful while tuning the visual language.
const SHOW_AIM_INTERSECTION_X = false;
const SHOW_FIRST_BEAT_DOT = true;
const SHOW_ON_RHYTHM_RETICULE = false;
export const SHOW_SHIP_TRAJECTORY = true;

// where the first beat dot sits:
//   'edge'   — on the trajectory line, one beat past the target's leading edge (always in front).
//   'player' — on the player→target line, on the near body surface (closer to the player; swings
//              with the ship's position).
//   'both'   — draw the 'edge' dot as the primary (interactive) dot plus a dimmed 'player' marker.
// in 'both' the edge dot stays the one that drives proximity/lock-on so the lock cue isn't doubled.
type FirstBeatDotMode = "edge" | "player" | "both";
const FIRST_BEAT_DOT_MODE: FirstBeatDotMode = "player";
// compared via a helper so flipping the const above doesn't trip TS's literal-narrowing on `===`.
const firstDotModeIs = (m: FirstBeatDotMode): boolean => FIRST_BEAT_DOT_MODE === m;

// the on-rhythm reticule overlay for the focused target paints brighter by this factor —
// the focused-sprite glow itself is drawn additively in gameRender (no ctx.filter), but the
// reticule dots still use this multiplier to scale alpha when the on-rhythm spot is shown.
const FOCUSED_TARGET_BRIGHTNESS = 1.65;

const TRAJECTORY_ALPHA = 1;
const TRAJECTORY_PULSE_PERIOD_BEATS = 4;
const TRAJECTORY_PULSE_MIN_ALPHA = 1;
const TRAJECTORY_BEAT_DOT_RADIUS = 0;
const TRAJECTORY_BEAT_DOT_ALPHA = 0.25;
// doubletime: half-beat dots interleave fainter so on-beat dots stay dominant
const TRAJECTORY_HALF_BEAT_DOT_ALPHA_FACTOR = 0.45;
const TRAJECTORY_HALF_BEAT_DOT_RADIUS = 0.8;
// the half-beat first dot glows like the on-beat first dot but at a reduced alpha so the
// on-beat anchor still dominates as the primary "shoot here" cue.
const TRAJECTORY_HALF_BEAT_FIRST_DOT_ALPHA_FACTOR = 0.5;
// the first beat-dot is the most important — slightly larger and brighter than the rest so
// the player's eye is drawn to "this is where to shoot next beat", but still reads as a member
// of the same dot series rather than a separate kind of cue.
const TRAJECTORY_FIRST_BEAT_DOT_RADIUS = 2;
const TRAJECTORY_FIRST_BEAT_DOT_ALPHA = 0.55;
// peak alpha matches the disc's RETICULE_OVERLAP_BRIGHTNESS=3 boost (≈0.75) so
// the first dot "lights up" to the same intensity as the disc when proximity is reached.
const TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA = 0.95;
// when the reticule sits ON the dot, alpha pulses between this floor (between beats) and 1
// (on the beat) so the rhythm is visible even at the brightest state. Floor stays high so the
// "this shot lands" cue never reads as dim.
const TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA = 0.6;
// how far outside the on-beat hit radius the proximity glow starts ramping up — this is
// the "near" band where the first-dot already reads as bright before a direct overlap.
// Tight (10px) so the lock animation + drift-shot credit only triggers on near-direct
// overlap, not on a distant graze that the player wouldn't expect to count.
const TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD = 10;
// approach zone: the wider radius (reticule-center → dot-center) at which giant crosshairs
// appear centered on the dot, plus the soft outer hum starts. Independent of the tight
// proximity-glow band above so the early "you're on the right track" cue reads well before the
// actual target lock. A small white pulse runs inward along each crosshair arm on every beat,
// pointing at the target.
const HOVER_ZONE_RADIUS = 150;
const HOVER_ZONE_RING_PERIOD_BEATS = 1;
const HOVER_ZONE_CROSSHAIR_ARM = 90;
const HOVER_ZONE_CROSSHAIR_INNER_GAP = 8;
const HOVER_ZONE_CROSSHAIR_ALPHA = 0.1;
const HOVER_ZONE_CROSSHAIR_LINE_WIDTH = 1;
const HOVER_ZONE_PULSE_LENGTH = 10;
const HOVER_ZONE_PULSE_LINE_WIDTH = 1.6;
// the pulse is drawn in two additive passes (the crosshair group blends with "lighter"): a uniform
// medium-bright body dash, then a small bright dot at the leading head. Where they overlap the dot
// adds onto the body, so the head reads as a hot point fading into the medium pulse behind it —
// without relying on a gradient across a segment too short to register one.
const HOVER_ZONE_PULSE_BODY_HSL = "0, 0%, 70%";
const HOVER_ZONE_PULSE_BODY_ALPHA = 0.22;
const HOVER_ZONE_PULSE_HEAD_HSL = "0, 0%, 100%";
const HOVER_ZONE_PULSE_HEAD_ALPHA = 0.9;
// radius of the bright head dot, with a wider, fainter halo around it for a touch of bloom.
const HOVER_ZONE_PULSE_HEAD_RADIUS = 1.6;
const HOVER_ZONE_PULSE_HEAD_HALO_RADIUS = 4;
const HOVER_ZONE_PULSE_HEAD_HALO_ALPHA = 0.3;
const HOVER_ZONE_FADE_IN_SEC = 0.05;
// hint text that appears alongside the first crosshair shown per game session — only for
// pre-veteran pilots (anyone who has never hit 6x rhythm). Veterans skip the hint entirely;
// non-veterans see it once per run, anchored to the spot of first appearance, and fade out
// gently after the originating hover ends.
const HOVER_ZONE_HINT_LINES = ["Aim at the target", "to hit on the beat"] as const;
const HOVER_ZONE_HINT_LINE_HEIGHT = 22;
// font size matches FirstWaveHint__line (~18px) so the in-canvas hint reads as part of the
// same hint family rather than a smaller secondary annotation.
const HOVER_ZONE_HINT_FONT = "400 18px 'Space Grotesk', system-ui, sans-serif";
const HOVER_ZONE_HINT_FILL_HSL = "197, 100%, 86%"; // matches #c8efff used by .first-wave-hint__line
const HOVER_ZONE_HINT_SHADOW = "rgba(0, 0, 0, 0.8)";
const HOVER_ZONE_HINT_OFFSET_X = 18;
const HOVER_ZONE_HINT_FADE_OUT_SEC = 3;
const HOVER_ZONE_HINT_FADE_IN_SEC = 0.1;
// hoverZoneHintZoneEnter pins the hint to the very first hover of this game session:
//   null = no hover has shown the hint yet → next paint will claim the hint for itself
//   number = the zoneEnter value of the in-progress hover currently displaying the hint
//   -1 = the first hover has ended → hint is fading out or fully retired
let hoverZoneHintZoneEnter: number | null = null;
// anchor frozen at first paint so the text stays put even as the target dot drifts
let hoverZoneHintAnchor: { x: number; y: number } | null = null;
// beat-time the hint first appeared; null until claimed. Drives the fade-in ramp.
let hoverZoneHintShownAt: number | null = null;
// beat-time the originating hover ended; null while still active. Drives the fade-out window.
let hoverZoneHintRetiredAt: number | null = null;
// veteran flag is stamped persistently by waveDirector when the player ever hits 6x rhythm;
// read it inline to avoid pulling the whole waveDirector module (heavy import graph) just for
// this gate.
const HOVER_ZONE_HINT_VETERAN_KEY = "pulsar.veteran";
const playerIsVeteran = (): boolean => {
  try { return localStorage.getItem(HOVER_ZONE_HINT_VETERAN_KEY) === "1"; }
  catch { return false; }
};
// gate the hint behind the same "all controls used" milestone that retires the controls
// hint panel — we don't want to stack a second instructional overlay on top of the first.
// gameUpdate emits "tutorial:controls" every time a key transitions to used.
let allCoreControlsUsed = false;
// also gate behind FirstWaveHint stage 4 ("Fire (and hit) on the beat") — the drift cue only
// makes sense once the player has been taught the rhythm-hit loop it's optimizing for.
// lifecycle.ts broadcasts "first-wave-hint:stage" every transition; stages are monotonic, so
// remembering the high-water mark is enough.
const HOVER_ZONE_HINT_REQUIRED_FIRST_WAVE_STAGE = 4;
let fireAndHitStageReached = false;
if (typeof window !== "undefined") {
  window.addEventListener("tutorial:controls", (e: Event) => {
    const d = (e as CustomEvent<TutorialControlsUsed>).detail;
    if (d && TUTORIAL_CONTROL_ACTIONS.every((a) => d[a])) allCoreControlsUsed = true;
  });
  window.addEventListener("first-wave-hint:stage", (e: Event) => {
    const stage = (e as CustomEvent<{ stage: number }>).detail?.stage ?? 0;
    if (stage >= HOVER_ZONE_HINT_REQUIRED_FIRST_WAVE_STAGE) fireAndHitStageReached = true;
  });
}
// called once per frame by the renderer after slot zone-entry stamps have been updated; stamps
// the retirement beat-time the moment the originating hover ends (kicking off fade-out).
// Idempotent / safe to call every frame.
export const expireHoverZoneHintIfHoverEnded = (
  activeZoneEnters: ReadonlyArray<number | null>, beatTime: number,
) => {
  if (typeof hoverZoneHintZoneEnter !== "number" || hoverZoneHintZoneEnter < 0) return;
  for (const z of activeZoneEnters) { if (z === hoverZoneHintZoneEnter) return; }
  hoverZoneHintZoneEnter = -1;
  hoverZoneHintRetiredAt = beatTime;
};

// called once per frame after the crosshair pass; renders the hint at its frozen anchor (if any)
// with a long fade-out after retirement. Safe to call when no hint is active.
export const paintHoverZoneHint = (ctx: CanvasRenderingContext2D, beatTime: number) => {
  if (hoverZoneHintAnchor === null) return;
  if (playerIsVeteran()) return;
  let alpha = 1;
  if (hoverZoneHintShownAt !== null) {
    const sinceShown = Math.max(0, beatTime - hoverZoneHintShownAt);
    alpha *= Math.min(1, sinceShown / HOVER_ZONE_HINT_FADE_IN_SEC);
  }
  if (hoverZoneHintRetiredAt !== null) {
    const since = beatTime - hoverZoneHintRetiredAt;
    if (since >= HOVER_ZONE_HINT_FADE_OUT_SEC) { hoverZoneHintAnchor = null; return; }
    const t01 = Math.max(0, 1 - since / HOVER_ZONE_HINT_FADE_OUT_SEC);
    alpha *= t01 * t01;
  }
  const prevFont = ctx.font;
  const prevFill = ctx.fillStyle;
  const prevAlign = ctx.textAlign;
  const prevBaseline = ctx.textBaseline;
  const prevShadowColor = ctx.shadowColor;
  ctx.font = HOVER_ZONE_HINT_FONT;
  ctx.fillStyle = `hsla(${HOVER_ZONE_HINT_FILL_HSL}, ${0.95 * alpha})`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.shadowColor = HOVER_ZONE_HINT_SHADOW;
  // vertical-center the multi-line block on the anchor point so the crosshair sits next to the
  // midline rather than the top of the first line.
  const totalH = (HOVER_ZONE_HINT_LINES.length - 1) * HOVER_ZONE_HINT_LINE_HEIGHT;
  const startY = hoverZoneHintAnchor.y - totalH / 2;
  for (let i = 0; i < HOVER_ZONE_HINT_LINES.length; i++) {
    ctx.fillText(HOVER_ZONE_HINT_LINES[i], hoverZoneHintAnchor.x, startY + i * HOVER_ZONE_HINT_LINE_HEIGHT);
  }
  ctx.font = prevFont;
  ctx.fillStyle = prevFill;
  ctx.textAlign = prevAlign;
  ctx.textBaseline = prevBaseline;
  ctx.shadowColor = prevShadowColor;
};
// faint dashed halo around the first-beat dot — subtle "this is the next-beat lock" cue.
// Picks up the same beat-pulse boost as the dot itself so it brightens on the beat in sync.
const TRAJECTORY_FIRST_BEAT_HALO_RADIUS = 6;
const TRAJECTORY_FIRST_BEAT_HALO_ALPHA = 0.18;
const TRAJECTORY_FIRST_BEAT_HALO_LINE_WIDTH = 0.75;
const TRAJECTORY_FIRST_BEAT_HALO_DASH: number[] = [2, 2];
// tutorial highlight repaints the first-beat dot in solid white so it reads as the focal
// point of the wave-1 "use your targeting tools" cue.
const TUTORIAL_FIRST_DOT_HSL = "0, 0%, 100%";
const TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA = 0.85;
const TRAJECTORY_AIM_INTERSECTION_X_RADIUS = 5;
const TRAJECTORY_AIM_INTERSECTION_X_ALPHA = 0.55;
const TRAJECTORY_AIM_INTERSECTION_X_LINE_WIDTH = 1.5;
// on-rhythm aim-spot reticule — dashed circle with crosshair, sized for visibility on the
// target. Its own constants (no longer tied to the first beat-dot's size).
const TRAJECTORY_ON_RHYTHM_SPOT_RADIUS = 8;
const TRAJECTORY_ON_RHYTHM_SPOT_LINE_WIDTH = 1;
const TRAJECTORY_ON_RHYTHM_SPOT_DASH: number[] = [2, 2];
const TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_REACHABLE = TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA;
// dim state needs to read as "you're not aimed at the on-beat hit yet" — significantly
// fainter than the bright state so the brightness jump is unmistakeable when you line it up.
const TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_UNREACHABLE = 0.22;
// dashed crosshair tick that sticks out past the lock circle — reads as "this is a sight".
const TRAJECTORY_LOCK_CROSSHAIR_GAP = 3;
const TRAJECTORY_LOCK_CROSSHAIR_LENGTH = 7;
const TRAJECTORY_LOCK_CROSSHAIR_DASH: number[] = [2, 2];
// first-beat dot crosshair — same sight visual as the lock crosshair, sized to clear the halo
// ring so the ticks read as separate marks rather than overlapping the dashed halo. Tick length
// grows per slot so the 1-beat dot pairs visually with the 1-beat reticule, 2-beat with 2-beat,
// etc. — the player can scan "small ticks pair with small ticks" to know which to drift-lock.
const TRAJECTORY_FIRST_BEAT_CROSSHAIR_INNER = TRAJECTORY_FIRST_BEAT_HALO_RADIUS + 2;
const TRAJECTORY_FIRST_BEAT_CROSSHAIR_DASH: number[] = [2, 2];
const TRAJECTORY_FIRST_BEAT_CROSSHAIR_LINE_WIDTH = 0.75;
// shared with aimDisc.ts via SLOT_CROSSHAIR_LENGTHS_TRAJECTORY; one entry per slot starting at 1-beat.
export const SLOT_CROSSHAIR_LENGTHS_TRAJECTORY = [5, 9, 13, 17] as const;
export const slotCrosshairLengthTrajectory = (slot: number): number =>
  SLOT_CROSSHAIR_LENGTHS_TRAJECTORY[Math.min(SLOT_CROSSHAIR_LENGTHS_TRAJECTORY.length - 1, Math.max(0, slot - 1))];
// the centermost-target's first-beat dot upgrades its halo + crosshair to bright white at full
// alpha so the player can instantly see which target their on-beat shot is locked to.
// Geometry matches the ship's aim disc (outer ring + crosshair from aimDisc.ts) so the focused
// lock and the player's reticule read as the same kind of mark — kept in sync by inlining the
// same numeric constants here rather than cross-importing.
const FOCUSED_FIRST_DOT_HSL = "0, 0%, 100%";
const FOCUSED_FIRST_DOT_RING_RADIUS = BULLET_SIGHT_RADIUS_ON_BEAT;
const FOCUSED_FIRST_DOT_RING_LINE_WIDTH = 1;
const FOCUSED_FIRST_DOT_RING_DASH: number[] = [4, 4];
const FOCUSED_FIRST_DOT_CROSSHAIR_GAP = 3;
const FOCUSED_FIRST_DOT_CROSSHAIR_LENGTH = 6;
const FOCUSED_FIRST_DOT_CROSSHAIR_DASH: number[] = [2, 2];

// reticule brightens on beat (PEAK) and decays to 1 — visual rhythm gate
const RETICULE_BEAT_PULSE_PEAK = 4.0;
export const computeBeatPulseBoost = (beatTime: number, beatGrid: number): number => {
  if (beatGrid <= 0) return 1;
  const phase = ((beatTime % beatGrid) + beatGrid) % beatGrid / beatGrid;
  const decay = (1 - phase) * (1 - phase);
  return 1 + (RETICULE_BEAT_PULSE_PEAK - 1) * decay;
};

// when a target first enters the cone, briefly boost alpha so the appearance reads as a flash.
const TRAJECTORY_ENTRY_FLASH_DURATION_SEC = 0.35;
const TRAJECTORY_ENTRY_FLASH_PEAK_BOOST = 2.5;
// after a target leaves the cone, keep the last-seen trajectory visible for this long, fading out.
const TRAJECTORY_FADE_OUT_DURATION_SEC = 2;

// target shape covers everything the reticule might lock onto (asteroids, comets, aliens, canisters).
// Entrance fields (see game/entrance.ts) are present on entities that stage
// entrances; canisters never do. Overlays anchored to a target's world pos
// (focus glow) must draw at pos + enterOff while it's entering.
export type ReticuleTarget = {
  pos: Vec;
  vel: Vec;
  radius?: number;
  entering?: boolean;
  enterOffX?: number;
  enterOffY?: number;
};

// snapshot the last in-cone state so fade-out can keep rendering even if the target dies/leaves.
type TrajectorySnapshot = { posX: number; posY: number; velX: number; velY: number; radius: number };

// per-target tracking for entry flash phase and post-exit fade lingering. imageDx/imageDy is
//   the apex-relative displacement of the toroidal image the preview last painted for this
//   target, so the fade ghost keeps to the side of the screen the radar last showed it instead
//   of snapping to the opposite edge when the nearest image flips at the seam (candidateImages).
export type TrajectoryTrack = {
  firstSeen: number;
  lastInConeAt: number;
  snapshot: TrajectorySnapshot;
  imageDx: number;
  imageDy: number;
};

// strong Map (not WeakMap) is required because we need to keep rendering a target's fade-out
//   snapshot even after the target itself is gone (e.g. asteroid destroyed mid-cone). Entries are
//   cleaned up by renderFadingTrajectories once the 2s fade completes, and the whole map is
//   discarded when the Ship instance is replaced on respawn/restart, so the leak is bounded.
export type TrajectoryTrackMap = Map<object, TrajectoryTrack>;

export type TrajectoryContext = {
  // null = COMPUTE-ONLY pass: run all geometry + proximity (the DotWalkResult the
  //   hover-lock state machine needs) but skip every paint + cosmetic side-effect.
  //   The sim runs this headless each frame so drift-lock eligibility is deterministic
  //   (it used to be computed only during render → invisible to the muted replay re-sim).
  ctx: CanvasRenderingContext2D | null;
  apex: Vec;
  beatGrid: number;
  beatTime: number;
  w: number;
  h: number;
  frame: ConeFrame;
  reticulePos: Vec;
  // one entry per reachable on-beat slot — index 0 = 1-beat slot, 1 = 2-beat, ...
  //   each entry lists every reticule for that slot (1 centred, or 2 prongs). Empty array
  //   means no reticule reaches that slot.
  reticulesBySlot: Array<Vec[]>;
  aimCircleCenter: Vec;
  aimCircleRadius: number;
  trajectoryTracks: TrajectoryTrackMap;
  doubletime: boolean;
  tutorialHighlight: boolean;
  // The live weapon's true collision reach for an on-beat shot. Each on-beat aim dot
  // is pulled this far toward the ship so the shell's leading edge — not its center —
  // meets the target surface ON the beat; aim the center at the surface and contact
  // happens one full reach early, before the beat, and the impact gate rejects it.
  collisionRadiusOnBeat: number;
  // per-slot beat-time the reticule first entered that slot's 75px approach zone (null = not in
  // zone). Drives the contracting approach ring's beat-aligned launch. Index 0 = 1-beat slot.
  hoverZoneEnterBySlot: Array<number | null>;
  // live targeting hint, render-pass only (the headless sim pass leaves it undefined so the
  //   forced preview + focus override stay purely cosmetic and can't reach the simulation).
  aimHint?: AimHintRender | null;
};

// dots pulse from 0→1 the first beat, then sinusoidally — gives a "lock-on" feel as targets enter.
const computeTargetPulse = (firstSeenBeat: number, beatTime: number, beatGrid: number, pulsePeriod: number): number => {
  const firstPeakBeat = Math.ceil((firstSeenBeat + 1e-6) / beatGrid) * beatGrid;
  let pulse01: number;
  if (beatTime < firstPeakBeat) {
    const rampSpan = firstPeakBeat - firstSeenBeat;
    pulse01 = rampSpan > 0 ? (beatTime - firstSeenBeat) / rampSpan : 1;
  } else {
    pulse01 = 0.5 + 0.5 * Math.cos(((beatTime - firstPeakBeat) / pulsePeriod) * TAU);
  }
  const floor = beatTime < firstPeakBeat ? 0 : TRAJECTORY_PULSE_MIN_ALPHA;
  return floor + (1 - floor) * pulse01;
};

// alpha multiplier that spikes to PEAK_BOOST when target just entered the cone, decays to 1 over
// ENTRY_FLASH_DURATION_SEC — gives an unmistakable "new contact" flash on first appearance.
const computeEntryFlashBoost = (firstSeen: number, beatTime: number): number => {
  const age = beatTime - firstSeen;
  if (age < 0 || age >= TRAJECTORY_ENTRY_FLASH_DURATION_SEC) return 1;
  const t01 = 1 - age / TRAJECTORY_ENTRY_FLASH_DURATION_SEC;
  return 1 + (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1) * t01 * t01;
};

// trajectory lingers for FADE_OUT_DURATION_SEC after leaving cone — returns 1→0 fade or 1 if in-cone.
const computeFadeAlpha = (lastInConeAt: number, beatTime: number): number => {
  const since = beatTime - lastInConeAt;
  if (since <= 0) return 1;
  if (since >= TRAJECTORY_FADE_OUT_DURATION_SEC) return 0;
  const t01 = 1 - since / TRAJECTORY_FADE_OUT_DURATION_SEC;
  return t01 * t01;
};

// when the on-beat hit is unreachable (target running away too fast, or too close for any
// shot to land on the beat) we recolor the on-rhythm reticule red so the player gets the cue
// directly on the lock element they're already watching, instead of tinting the whole sprite.
const ON_RHYTHM_UNREACHABLE_HSL = "0, 90%, 60%";

// dashed crosshair sticking out beyond the on-rhythm aim-spot circle in the 4 cardinal
// directions — reads as "targeting sight". Drawn under the caller's current strokeStyle/lineWidth.
const paintOnRhythmCrosshair = (ctx: CanvasRenderingContext2D, px: number, py: number) => {
  const prevDash = ctx.getLineDash();
  ctx.setLineDash(TRAJECTORY_LOCK_CROSSHAIR_DASH);
  const inner = TRAJECTORY_ON_RHYTHM_SPOT_RADIUS + TRAJECTORY_LOCK_CROSSHAIR_GAP;
  const outer = inner + TRAJECTORY_LOCK_CROSSHAIR_LENGTH;
  ctx.beginPath();
  ctx.moveTo(px - outer, py); ctx.lineTo(px - inner, py);
  ctx.moveTo(px + inner, py); ctx.lineTo(px + outer, py);
  ctx.moveTo(px, py - outer); ctx.lineTo(px, py - inner);
  ctx.moveTo(px, py + inner); ctx.lineTo(px, py + outer);
  ctx.stroke();
  ctx.setLineDash(prevDash);
};

// Once-a-run targeting lesson (game/aimHint.ts): rings bloom outward from ONE target's
// 1-beat dot — the ringed "shoot here next beat" reticule — while a popup beside it spells
// out the correction. `key` is the target object the pulse belongs to; `anchor` is rewritten
// each frame with that dot's world position so the popup can ride along with it.
export type AimHintRender = {
  key: object;
  anchor: { pos: Vec };
  elapsed: number;
  duration: number;
};

// Amber, matching the off-beat-hit popup this replaces — the cyan of the reticule
// itself stays the "aim here" colour, and the warm ring reads as the correction on top.
const AIM_HINT_HSL = "33, 100%, 65%";
const AIM_HINT_RING_PERIOD = 0.75;
// starts just outside the focused first-beat dot's own ring + crosshair so the bloom reads as
// coming off that reticule rather than through it.
const AIM_HINT_RING_INNER_GAP = 6;
const AIM_HINT_RING_COUNT = 2;
const AIM_HINT_RING_SPAN = 34;
const AIM_HINT_RING_LINE_WIDTH = 2.5;
const AIM_HINT_RING_PEAK_ALPHA = 0.9;
const AIM_HINT_ENVELOPE_IN_SEC = 0.3;
const AIM_HINT_ENVELOPE_OUT_SEC = 0.7;

// ramps in on arrival and out on expiry so neither the rings nor a faded-in preview pops.
export const aimHintEnvelope = (elapsed: number, duration: number): number => {
  if (elapsed < 0 || elapsed > duration) return 0;
  const inRamp = Math.min(1, elapsed / AIM_HINT_ENVELOPE_IN_SEC);
  const outRamp = Math.min(1, (duration - elapsed) / AIM_HINT_ENVELOPE_OUT_SEC);
  return Math.min(inRamp, outRamp);
};

// staggered rings expanding out of the reticule circle, each fading as it grows.
const paintAimHintPulse = (
  ctx: CanvasRenderingContext2D, px: number, py: number, hint: AimHintRender,
) => {
  const envelope = aimHintEnvelope(hint.elapsed, hint.duration);
  if (envelope <= 0) return;
  const phase = hint.elapsed / AIM_HINT_RING_PERIOD;
  const inner = FOCUSED_FIRST_DOT_RING_RADIUS + FOCUSED_FIRST_DOT_CROSSHAIR_GAP
    + FOCUSED_FIRST_DOT_CROSSHAIR_LENGTH + AIM_HINT_RING_INNER_GAP;
  ctx.lineWidth = AIM_HINT_RING_LINE_WIDTH;
  ctx.setLineDash([]);
  for (let i = 0; i < AIM_HINT_RING_COUNT; i++) {
    const p = (phase + i / AIM_HINT_RING_COUNT) % 1;
    const alpha = AIM_HINT_RING_PEAK_ALPHA * envelope * (1 - p) * (1 - p);
    if (alpha <= 0.01) continue;
    ctx.strokeStyle = `hsla(${AIM_HINT_HSL}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, inner + p * AIM_HINT_RING_SPAN, 0, TAU);
    ctx.stroke();
  }
};

// dashed lock-circle + crosshair for the on-rhythm aim spot — the "where to aim NOW to hit
// on the next beat" reticule. Caller passes alpha/lineWidth/glow so reachable vs. unreachable and
// entry-flash state can modulate brightness without changing the geometry.
const paintOnRhythmReticule = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  alpha: number, lineWidth: number, glow01: number, unreachable: boolean,
) => {
  const hsl = unreachable ? ON_RHYTHM_UNREACHABLE_HSL : RETICULE_DASH_HSL;
  const prevShadowColor = ctx.shadowColor;
  if (glow01 > 0) {
    ctx.shadowColor = `hsla(${hsl}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * glow01})`;
  }
  ctx.strokeStyle = `hsla(${hsl}, ${alpha})`;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(TRAJECTORY_ON_RHYTHM_SPOT_DASH);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_ON_RHYTHM_SPOT_RADIUS, 0, TAU);
  ctx.stroke();
  paintOnRhythmCrosshair(ctx, px, py);
  ctx.setLineDash([]);
  ctx.shadowColor = prevShadowColor;
};

// first beat-dot is a filled dot like the others — just bigger and brighter so it stands out
// as "shoot here next beat". It still picks up proximity glow, direct-flash flicker, entry-flash,
// and the per-beat pulse so it reads as part of the same lock-on language.
// dimFactor < 1 is used for the doubletime half-beat "first dot" — still glows, but fainter.
const paintFirstBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  proximity01: number, entryFlashBoost: number, beatPulseBoost: number, focusBoost: number,
  dimFactor: number = 1, tutorialHighlight: boolean = false, focused: boolean = false,
  tickLength: number = SLOT_CROSSHAIR_LENGTHS_TRAJECTORY[0],
) => {
  const proximityAlpha = TRAJECTORY_FIRST_BEAT_DOT_ALPHA
    + (TRAJECTORY_FIRST_BEAT_DOT_PEAK_ALPHA - TRAJECTORY_FIRST_BEAT_DOT_ALPHA) * proximity01;
  // multiplicative pulse is the default; on top of the dot (or on the focused target's dot,
  // which is the bright "you're aimed at this target" cue) we'd saturate to 1 and lose the
  // pulse, so blend toward a normalized [LIT_MIN, 1] pulse so the rhythm stays visible at the
  // bright state with a high minimum opacity.
  const beatPulse01 = (beatPulseBoost - 1) / (RETICULE_BEAT_PULSE_PEAK - 1);
  const lit01 = focused ? 1 : proximity01;
  const multiplicativeAlpha = proximityAlpha * entryFlashBoost * beatPulseBoost * focusBoost * dimFactor;
  const litAlpha = (TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA
    + (1 - TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA) * beatPulse01)
    * entryFlashBoost * focusBoost * dimFactor;
  const rawAlpha = multiplicativeAlpha * (1 - lit01) + litAlpha * lit01;
  const alpha = Math.min(1, tutorialHighlight ? Math.max(rawAlpha, 0.95) : rawAlpha);
  const glow01 = Math.max(0, Math.min(1, (entryFlashBoost - 1) / (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1)));
  const prevShadowColor = ctx.shadowColor;
  const dotHsl = tutorialHighlight ? TUTORIAL_FIRST_DOT_HSL : RETICULE_DASH_HSL;
  if (glow01 > 0) {
    ctx.shadowColor = `hsla(${RETICULE_DASH_HSL}, ${TRAJECTORY_DIRECT_FLASH_GLOW_ALPHA * glow01})`;
  }
  ctx.fillStyle = `hsla(${dotHsl}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
  // for the focused (centermost) target, swap the dim halo + crosshair for a bright-white
  // outer ring + crosshair sized to match the ship's aim disc, so the locked-on target reads
  // as a mirror of the player's reticule. Non-focused dots keep the faint dashed halo cue.
  if (focused) {
    const focusedAlpha = TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA
      + (1 - TRAJECTORY_FIRST_BEAT_DOT_LIT_MIN_ALPHA) * beatPulse01;
    ctx.strokeStyle = `hsla(${FOCUSED_FIRST_DOT_HSL}, ${focusedAlpha})`;
    ctx.lineWidth = FOCUSED_FIRST_DOT_RING_LINE_WIDTH;
    ctx.setLineDash(FOCUSED_FIRST_DOT_RING_DASH);
    ctx.beginPath();
    ctx.arc(px, py, FOCUSED_FIRST_DOT_RING_RADIUS, 0, TAU);
    ctx.stroke();
    ctx.setLineDash(FOCUSED_FIRST_DOT_CROSSHAIR_DASH);
    const fInner = FOCUSED_FIRST_DOT_RING_RADIUS + FOCUSED_FIRST_DOT_CROSSHAIR_GAP;
    const fOuter = fInner + FOCUSED_FIRST_DOT_CROSSHAIR_LENGTH;
    ctx.beginPath();
    ctx.moveTo(px - fOuter, py); ctx.lineTo(px - fInner, py);
    ctx.moveTo(px + fInner, py); ctx.lineTo(px + fOuter, py);
    ctx.moveTo(px, py - fOuter); ctx.lineTo(px, py - fInner);
    ctx.moveTo(px, py + fInner); ctx.lineTo(px, py + fOuter);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor = prevShadowColor;
    return;
  }
  const rawHaloAlpha = TRAJECTORY_FIRST_BEAT_HALO_ALPHA
    * entryFlashBoost * beatPulseBoost * focusBoost * dimFactor;
  const haloAlpha = Math.min(1, tutorialHighlight ? Math.max(rawHaloAlpha, 0.6) : rawHaloAlpha);
  ctx.strokeStyle = `hsla(${dotHsl}, ${haloAlpha})`;
  ctx.lineWidth = TRAJECTORY_FIRST_BEAT_HALO_LINE_WIDTH;
  ctx.setLineDash(TRAJECTORY_FIRST_BEAT_HALO_DASH);
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_FIRST_BEAT_HALO_RADIUS, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = TRAJECTORY_FIRST_BEAT_CROSSHAIR_LINE_WIDTH;
  ctx.setLineDash(TRAJECTORY_FIRST_BEAT_CROSSHAIR_DASH);
  const inner = TRAJECTORY_FIRST_BEAT_CROSSHAIR_INNER;
  const outer = inner + tickLength;
  ctx.beginPath();
  ctx.moveTo(px - outer, py); ctx.lineTo(px - inner, py);
  ctx.moveTo(px + inner, py); ctx.lineTo(px + outer, py);
  ctx.moveTo(px, py - outer); ctx.lineTo(px, py - inner);
  ctx.moveTo(px, py + inner); ctx.lineTo(px, py + outer);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowColor = prevShadowColor;
};

const paintBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  entryFlashBoost: number, focusBoost: number,
) => {
  const alpha = Math.min(1, TRAJECTORY_BEAT_DOT_ALPHA * entryFlashBoost * focusBoost);
  ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
};

// half-beat dot interleaves between regular beat dots when doubletime is active — visually
// reads as the same kind of cue but fainter and slightly smaller, so on-beat dots still anchor.
const paintHalfBeatDot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  entryFlashBoost: number, focusBoost: number,
) => {
  const alpha = Math.min(1, TRAJECTORY_BEAT_DOT_ALPHA * TRAJECTORY_HALF_BEAT_DOT_ALPHA_FACTOR * entryFlashBoost * focusBoost);
  ctx.fillStyle = `hsla(${RETICULE_DASH_HSL}, ${alpha})`;
  ctx.beginPath();
  ctx.arc(px, py, TRAJECTORY_HALF_BEAT_DOT_RADIUS, 0, TAU);
  ctx.fill();
};

const paintAimIntersectionX = (
  ctx: CanvasRenderingContext2D, px: number, py: number, entryFlashBoost: number, focusBoost: number,
) => {
  const r = TRAJECTORY_AIM_INTERSECTION_X_RADIUS;
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${Math.min(1, TRAJECTORY_AIM_INTERSECTION_X_ALPHA * entryFlashBoost * focusBoost)})`;
  ctx.lineWidth = TRAJECTORY_AIM_INTERSECTION_X_LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(px - r, py - r);
  ctx.lineTo(px + r, py + r);
  ctx.moveTo(px + r, py - r);
  ctx.lineTo(px - r, py + r);
  ctx.stroke();
};

// detect whether the first-beat lock dot overlaps the aim disc, so the disc can brighten.
const firstDotOverlapsReticule = (px: number, py: number, retX: number, retY: number): boolean => {
  const R = BULLET_SIGHT_RADIUS_ON_BEAT;
  const ddx = px - retX;
  const ddy = py - retY;
  return ddx * ddx + ddy * ddy <= (R + TRAJECTORY_FIRST_BEAT_DOT_RADIUS) * (R + TRAJECTORY_FIRST_BEAT_DOT_RADIUS);
};

// 0 = far away (no glow), 1 = touching the disc (full lit). Smooth ramp through the proximity pad.
const firstDotProximity01 = (px: number, py: number, retX: number, retY: number): number => {
  const ddx = px - retX;
  const ddy = py - retY;
  const dist = Math.hypot(ddx, ddy);
  const overlapDist = BULLET_SIGHT_RADIUS_ON_BEAT + TRAJECTORY_FIRST_BEAT_DOT_RADIUS;
  if (dist <= overlapDist) return 1;
  const outerDist = overlapDist + TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD;
  if (dist >= outerDist) return 0;
  const t = 1 - (dist - overlapDist) / TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD;
  return t * t * (3 - 2 * t);
};

// true when a reticule sits within the wider approach zone of a dot (center-to-center).
const withinApproachZone = (px: number, py: number, retX: number, retY: number): boolean => {
  const ddx = px - retX;
  const ddy = py - retY;
  return ddx * ddx + ddy * ddy <= HOVER_ZONE_RADIUS * HOVER_ZONE_RADIUS;
};

// giant + crosshair centered on the target dot, with a small white pulse running inward along
// each arm on every beat — "pointing at the target". Phase is locked directly to the beat grid,
// so the pulse appears already mid-flight at whatever beat-fraction the crosshair shows up at.
// Overall opacity ramps 0→1 over HOVER_ZONE_FADE_IN_SEC from zoneEnter so the appearance reads
// as a soft fade-in rather than a pop. zoneEnter=null means "appeared this frame" → start at 0.
const paintApproachCrosshair = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  beatTime: number, beatGrid: number, zoneEnter: number | null,
) => {
  if (beatGrid <= 0) return;
  const sinceEnter = zoneEnter === null ? 0 : Math.max(0, beatTime - zoneEnter);
  const fadeIn = Math.min(1, sinceEnter / HOVER_ZONE_FADE_IN_SEC);
  if (fadeIn <= 0) return;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * fadeIn;
  const inner = HOVER_ZONE_CROSSHAIR_INNER_GAP;
  const outer = inner + HOVER_ZONE_CROSSHAIR_ARM;
  ctx.strokeStyle = `hsla(${RETICULE_DASH_HSL}, ${HOVER_ZONE_CROSSHAIR_ALPHA})`;
  ctx.lineWidth = HOVER_ZONE_CROSSHAIR_LINE_WIDTH;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(px - outer, py); ctx.lineTo(px - inner, py);
  ctx.moveTo(px + inner, py); ctx.lineTo(px + outer, py);
  ctx.moveTo(px, py - outer); ctx.lineTo(px, py - inner);
  ctx.moveTo(px, py + inner); ctx.lineTo(px, py + outer);
  ctx.stroke();

  const period = beatGrid * HOVER_ZONE_RING_PERIOD_BEATS;
  const phase = ((beatTime % period) + period) % period / period;
  const armSpan = outer - inner;
  const headDist = outer - phase * (armSpan + HOVER_ZONE_PULSE_LENGTH);
  const tailDist = headDist + HOVER_ZONE_PULSE_LENGTH;
  const segStart = Math.max(inner, headDist);
  const segEnd = Math.min(outer, tailDist);
  if (segEnd > segStart) {
    // the pulse travels inward, so headDist (nearer the center) is the leading head. Pass 1: a
    // uniform medium body dash over the visible [segStart, segEnd] slice. Pass 2: a bright dot at
    // the head — only when the head itself is inside the arm (headDist >= inner), so the spark
    // doesn't keep glowing after the pulse has run off the inner gap.
    ctx.lineWidth = HOVER_ZONE_PULSE_LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.strokeStyle = `hsla(${HOVER_ZONE_PULSE_BODY_HSL}, ${HOVER_ZONE_PULSE_BODY_ALPHA})`;
    ctx.beginPath();
    const armBody = (dirX: number, dirY: number) => {
      ctx.moveTo(px + dirX * segStart, py + dirY * segStart);
      ctx.lineTo(px + dirX * segEnd, py + dirY * segEnd);
    };
    armBody(-1, 0); armBody(1, 0); armBody(0, -1); armBody(0, 1);
    ctx.stroke();
    if (headDist >= inner) {
      const headDot = (dirX: number, dirY: number) => {
        const hx = px + dirX * headDist;
        const hy = py + dirY * headDist;
        ctx.fillStyle = `hsla(${HOVER_ZONE_PULSE_HEAD_HSL}, ${HOVER_ZONE_PULSE_HEAD_HALO_ALPHA})`;
        ctx.beginPath();
        ctx.arc(hx, hy, HOVER_ZONE_PULSE_HEAD_HALO_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsla(${HOVER_ZONE_PULSE_HEAD_HSL}, ${HOVER_ZONE_PULSE_HEAD_ALPHA})`;
        ctx.beginPath();
        ctx.arc(hx, hy, HOVER_ZONE_PULSE_HEAD_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      };
      headDot(-1, 0); headDot(1, 0); headDot(0, -1); headDot(0, 1);
    }
    ctx.lineCap = "butt";
  }
  // hint: only claim the anchor for the very first hover of this session, and freeze it on the
  // first paint of that hover. Veterans skip the hint pipeline; pre-veterans only see it once
  // they've cleared the controls hint (rotate + thrust + reverse + fire each used at least once)
  // AND reached the FirstWaveHint "Fire (and hit) on the beat" stage so the cues don't stack.
  if (zoneEnter !== null && !playerIsVeteran() && allCoreControlsUsed && fireAndHitStageReached && hoverZoneHintZoneEnter === null) {
    hoverZoneHintZoneEnter = zoneEnter;
    hoverZoneHintAnchor = { x: px + outer + HOVER_ZONE_HINT_OFFSET_X, y: py };
    hoverZoneHintShownAt = beatTime;
    hoverZoneHintRetiredAt = null;
  }
  ctx.globalAlpha = prevAlpha;
};

// overlapsReticule = strict hit (powers reticule lock-on visuals); slotProximities[k-1] = soft
// 0..1 proximity between the k-beat trajectory dot and whichever of the slot's reticules sits
// closest, used by the per-slot hover rings. slotWinnerReticuleIdx[k-1] is the index INTO the
// slot's reticule list of the winner (so renderer knows which prong to anchor the ring on);
// -1 when no reticule is close.
type DotWalkResult = {
  overlapsReticule: boolean;
  slotProximities: number[];
  slotWinnerReticuleIdx: number[];
  // slotWithin75[k-1] = true when any of slot k's reticules sits inside the wider 75px approach
  // zone of that slot's on-beat dot — drives the soft outer hum + the contracting approach ring.
  slotWithin75: boolean[];
};

// Scroll (locked-center) camera: when set, dot draw-positions are wrapped to the
// nearest toroidal copy of THIS anchor (the ship/apex) rather than folded into
// [0,w). Set per-frame around the reticule paint by gameRender; null in the
// snapshot-tiled / non-scroll modes. Render-only — it shifts where dots draw,
// never the proximity/lock math (which uses raw px,py), so it can't touch sim
// determinism. See wrapToCanvas + setReticuleWrapAnchor.
let reticuleWrapAnchor: { x: number; y: number } | null = null;
export const setReticuleWrapAnchor = (anchor: { x: number; y: number } | null): void => {
  reticuleWrapAnchor = anchor;
};

// the cone is computed in the apex's "virtual" frame (toroidalDelta-remapped), so dot
// positions can land outside [0,w)×[0,h). In the non-scroll camera, canvas == world, so we
// fold them into [0,w) — dots reappear on the opposite edge, matching the wrapped target
// sprite. In scroll mode the world is wrap-REPLICATED behind a camera translate that pins the
// ship to centre, so we pass the raw apex-relative coordinate straight through and let the
// camera translate place it: every point that reaches here already belongs to a chosen image —
// target dots are walked per on-screen toroidal image upstream (candidateImages), and the
// forward reticule ray is an intentional projection from the ship. Folding the offset into ±w/2 here was the bug:
// a fast ship's 1-beat reticule projects past half a screen, and the fold snapped it a full
// screen back toward the ship while the bullet (drawn at its true offset by the world layer)
// kept going — so the shot visibly overshot its own sight. Unfolded, the sight tracks the
// bullet at any range. The world layer's tileCopies still covers the wrap visually.
const wrapToCanvas = (x: number, y: number, w: number, h: number): [number, number] => {
  if (reticuleWrapAnchor) return [x, y];
  return [((x % w) + w) % w, ((y % h) + h) % h];
};

// Public wrapper for reticule-disc/ring/pulse/arrow draws, which live in the same
// raw apex-relative space as the dots and must fold the same way at paint time.
export const wrapReticuleVec = (p: Vec, w: number, h: number): Vec => {
  const [x, y] = wrapToCanvas(p.x, p.y, w, h);
  return { x, y };
};

// dots mark target position at successive beats — direct preview of where the player needs to aim.
// in doubletime, an extra fainter dot is interleaved at each half-beat between the beat dots,
// and a second, fainter "first dot" precedes the on-beat first dot at the half-beat lead.
const drawBeatDotsAlongRay = (
  ctx: CanvasRenderingContext2D | null,
  rawStartX: number, rawStartY: number, ux: number, uy: number,
  reticulesBySlot: Array<Array<[number, number]>>,
  sMin: number, sMax: number, dotStep: number, dotOffset: number,
  entryFlashBoost: number, beatPulseBoost: number, focusBoost: number,
  w: number, h: number, doubletime: boolean, tutorialHighlight: boolean, focused: boolean,
  beatTime: number, beatGrid: number, hoverZoneEnterBySlot: Array<number | null>,
  onBeatDotOverrides: Array<[number, number] | null>,
  firstDotSecondary: [number, number] | null,
): DotWalkResult => {
  let overlapsReticule = false;
  const slotCount = reticulesBySlot.length;
  const slotProximities: number[] = new Array(slotCount).fill(0);
  const slotWinnerReticuleIdx: number[] = new Array(slotCount).fill(-1);
  const slotWithin75: boolean[] = new Array(slotCount).fill(false);
  // doubletime halves the spacing and marks every other k as a half-beat (off-beat) dot.
  const step = doubletime ? dotStep * 0.5 : dotStep;
  const isHalfBeatK = (k: number): boolean => doubletime && (k % 2 === 1);
  // on-beat dot indices are anchored to the target (next-beat future position), not to the wedge —
  // letting cone clipping exclude them produces a worse "lock cue lies about position" bug than
  // the cosmetic spill it would prevent. Each slot's on-beat dot (and the doubletime half-beat
  // first-dot lead) always paints, regardless of cone clipping.
  const firstHalfBeatK = 1;
  // 1-indexed slot → k value at which that slot's on-beat dot appears
  const slotToK = (slot: number): number => doubletime ? slot * 2 : slot;
  const maxSlotK = slotCount > 0 ? slotToK(slotCount) : 0;
  const isAnchorK = (k: number): boolean => {
    if (doubletime && k === firstHalfBeatK) return true;
    if (k <= 0 || k > maxSlotK) return false;
    if (doubletime && k % 2 !== 0) return false;
    const slot = doubletime ? k / 2 : k;
    return reticulesBySlot[slot - 1].length > 0;
  };
  let drawnOnBeatDots = 0;
  let drawnHalfBeatDots = 0;
  for (let k = 1; ; k++) {
    const sK = dotOffset + step * k;
    const isFirstBeatDot = isAnchorK(k);
    if (sK > sMax && k > maxSlotK) break;
    if (sK > sMax && !isFirstBeatDot) continue;
    if (sK < sMin && !isFirstBeatDot) continue;
    const halfBeat = isHalfBeatK(k);
    // each on-beat dot uses its slot's pulled-back aim point (override index = how many on-beat dots
    // drawn so far, i.e. this dot's 0-based slot). Half-beat dots and out-of-range trail dots stay on
    // the raw velocity trail.
    const slotOverride = !halfBeat && drawnOnBeatDots < onBeatDotOverrides.length
      ? onBeatDotOverrides[drawnOnBeatDots]
      : null;
    const px = slotOverride ? slotOverride[0] : rawStartX + ux * sK;
    const py = slotOverride ? slotOverride[1] : rawStartY + uy * sK;
    const [drawX, drawY] = wrapToCanvas(px, py, w, h);
    if (halfBeat) {
      if (drawnHalfBeatDots === 0) {
        // dimmed first-dot glow — no proximity check against the on-beat reticule, since
        // this dot represents a different bullet endpoint (half-beat shot, not on-beat shot).
        if (ctx && SHOW_FIRST_BEAT_DOT) {
          paintFirstBeatDot(
            ctx, drawX, drawY, 0, entryFlashBoost, beatPulseBoost, focusBoost,
            TRAJECTORY_HALF_BEAT_FIRST_DOT_ALPHA_FACTOR, false, focused,
          );
        }
      } else if (ctx) {
        paintHalfBeatDot(ctx, drawX, drawY, entryFlashBoost, focusBoost);
      }
      drawnHalfBeatDots++;
    } else {
      const slotIdx = drawnOnBeatDots; // 0-based slot for this on-beat dot
      const slotReticules = slotIdx < slotCount ? reticulesBySlot[slotIdx] : [];
      if (slotReticules.length > 0) {
        let bestProximity = 0;
        let bestRetIdx = -1;
        let anyStrictOverlap = false;
        let within75 = false;
        for (let r = 0; r < slotReticules.length; r++) {
          const [retXk, retYk] = slotReticules[r];
          const proximityR = firstDotProximity01(px, py, retXk, retYk);
          if (proximityR > bestProximity) { bestProximity = proximityR; bestRetIdx = r; }
          if (slotIdx === 0 && firstDotOverlapsReticule(px, py, retXk, retYk)) anyStrictOverlap = true;
          if (withinApproachZone(px, py, retXk, retYk)) within75 = true;
        }
        if (within75) slotWithin75[slotIdx] = true;
        // giant approach crosshairs sit centered on the dot; pulse phase is locked to the beat
        // grid so it's always mid-flight, with a 50ms opacity ramp from zoneEnter for a soft fade-in.
        if (ctx && within75) {
          const zoneEnter = slotIdx < hoverZoneEnterBySlot.length ? hoverZoneEnterBySlot[slotIdx] : null;
          paintApproachCrosshair(ctx, drawX, drawY, beatTime, beatGrid, zoneEnter);
        }
        const tickLength = slotCrosshairLengthTrajectory(slotIdx + 1);
        if (ctx && SHOW_FIRST_BEAT_DOT) {
          // tutorial highlight + the 1st-dot strict-overlap signal only apply to the 1-beat slot.
          paintFirstBeatDot(
            ctx, drawX, drawY, bestProximity, entryFlashBoost, beatPulseBoost, focusBoost,
            1, slotIdx === 0 ? tutorialHighlight : false, slotIdx === 0 ? focused : false,
            tickLength,
          );
        }
        if (anyStrictOverlap) overlapsReticule = true;
        if (bestProximity > slotProximities[slotIdx]) {
          slotProximities[slotIdx] = bestProximity;
          slotWinnerReticuleIdx[slotIdx] = bestRetIdx;
        }
      } else if (ctx) {
        paintBeatDot(ctx, drawX, drawY, entryFlashBoost, focusBoost);
      }
      drawnOnBeatDots++;
    }
  }
  // 'both' mode: a dimmed player-relative marker alongside the primary (edge) dot. Purely visual —
  // no proximity/lock-on so the lock cue isn't doubled; the edge dot stays the interactive one.
  if (ctx && firstDotSecondary !== null && SHOW_FIRST_BEAT_DOT) {
    const [sx, sy] = wrapToCanvas(firstDotSecondary[0], firstDotSecondary[1], w, h);
    paintFirstBeatDot(
      ctx, sx, sy, 0, entryFlashBoost, beatPulseBoost, focusBoost,
      TRAJECTORY_HALF_BEAT_FIRST_DOT_ALPHA_FACTOR, false, false,
    );
  }
  return { overlapsReticule, slotProximities, slotWinnerReticuleIdx, slotWithin75 };
};

const drawAimIntersectionsAlongRay = (
  ctx: CanvasRenderingContext2D,
  rawStartX: number, rawStartY: number, ux: number, uy: number,
  centerX: number, centerY: number, radius: number,
  sMin: number, sMax: number, entryFlashBoost: number, focusBoost: number,
  w: number, h: number,
) => {
  const dx = rawStartX - centerX;
  const dy = rawStartY - centerY;
  const q = dx * ux + dy * uy;
  const c = dx * dx + dy * dy - radius * radius;
  const disc = q * q - c;
  if (disc < 0) return;
  const root = Math.sqrt(disc);
  const intersectionDistances = root <= 1e-6 ? [-q] : [-q - root, -q + root];
  for (const s of intersectionDistances) {
    if (s < sMin || s > sMax) continue;
    const [drawX, drawY] = wrapToCanvas(rawStartX + ux * s, rawStartY + uy * s, w, h);
    paintAimIntersectionX(ctx, drawX, drawY, entryFlashBoost, focusBoost);
  }
};

// reticule pos may live on a different toroidal image of the world; remap before overlap checks.
const remapReticuleToTarget = (apex: Vec, reticulePos: Vec, w: number, h: number): [number, number] => {
  const [retDx, retDy] = toroidalDelta(reticulePos.x - apex.x, reticulePos.y - apex.y, w, h);
  return [apex.x + retDx, apex.y + retDy];
};

// on-rhythm aim spot uses the same lock-circle + crosshair visual as the first-beat dot so the
// player reads them as the same kind of cue ("targeting reticule"). Brightens ONLY when firing
// now would actually hit the target on the next beat (player's reticule is on the spot AND the
// geometry works out for an on-beat hit); dim otherwise.
const paintOnRhythmSpot = (
  ctx: CanvasRenderingContext2D, px: number, py: number,
  willHitOnBeat: boolean, reachable: boolean,
  entryFlashBoost: number, beatPulseBoost: number, focusBoost: number,
) => {
  const baseAlpha = willHitOnBeat ? TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_REACHABLE : TRAJECTORY_ON_RHYTHM_SPOT_ALPHA_UNREACHABLE;
  const alpha = Math.min(1, baseAlpha * entryFlashBoost * beatPulseBoost * focusBoost);
  const entryGlow01 = Math.max(0, Math.min(1, (entryFlashBoost - 1) / (TRAJECTORY_ENTRY_FLASH_PEAK_BOOST - 1)));
  paintOnRhythmReticule(ctx, px, py, alpha, TRAJECTORY_ON_RHYTHM_SPOT_LINE_WIDTH + (entryFlashBoost - 1), entryGlow01, !reachable);
};

// the aim circle is the locus of bullet endpoints at t=beatGrid over all headings —
// radius = bulletSpeed*beat, center accounts for inherited ship velocity. For an on-beat hit
// the bullet endpoint at t=beatGrid must land EXACTLY on the target's future body surface:
// land outside the body and you miss; land inside and the bullet collided BEFORE the beat
// (early/off-beat hit) since it passed through the body en route. So the aim point is the
// intersection of the aim circle with the target's predicted body circle on the player's side.
//
// Reachability ladder (D = aimCenter→C_future, |D| = dist between centers):
//   |D| > aimRadius + r : target running away — bullet can't reach it at all.
//   |D| < aimRadius - r : target too close/slow — every heading overshoots → only early hits.
//   ||D| - aimRadius| ≤ r : the two circles cross → on-beat hit reachable on the near surface.
//
// When reachable, the aim point is C_future - r·D̂ (near surface). When NOT reachable, we still
// place the spot at the target's predicted center so the player sees where the lead would be,
// but `reachable` is false so the renderer can tint the target red.
// the 'edge' first beat dot: on the trajectory line, one full beat of travel past the target's
// leading EDGE (center + velDir·(radius + speed·beat)). Measuring from the edge — not the center —
// keeps the dot clear of the body so a bullet aimed at it lands a clean on-beat hit instead of
// clipping the near edge early. Stays on the straight velocity trail, so it doesn't swing with the
// player's position. Returns null for a stationary target (no travel direction).
const computeFirstDotEdge = (
  cx: number, cy: number, velX: number, velY: number, radius: number, beatGrid: number,
  beatsAhead: number = 1,
): [number, number] | null => {
  const speed = Math.hypot(velX, velY);
  if (speed < 1e-6) return null;
  const ux = velX / speed;
  const uy = velY / speed;
  const reach = radius + speed * beatGrid * beatsAhead;
  return [cx + ux * reach, cy + uy * reach];
};

// the 'player' on-beat dot: the point on the target's predicted body surface that faces the player
// (C_future at `beatsAhead` beats), then pulled a further `edgePull` toward the aim center along the
// same D̂. With edgePull = the real on-beat collision radius, a bullet whose center lands here at the
// beat has its leading EDGE on the surface at the beat → a clean on-beat hit (without the pull the
// oversized hitbox connects ~one bullet-reach before the beat). Swings as the player moves. Returns
// null on degenerate geometry (no separation between aim center and future center).
const computeFirstDotPlayer = (
  cx: number, cy: number, velX: number, velY: number, radius: number,
  aimCenterX: number, aimCenterY: number, beatGrid: number,
  beatsAhead: number = 1, edgePull: number = 0,
): [number, number] | null => {
  const futureX = cx + velX * beatGrid * beatsAhead;
  const futureY = cy + velY * beatGrid * beatsAhead;
  const dx = futureX - aimCenterX;
  const dy = futureY - aimCenterY;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1e-6) return null;
  const pull = radius + edgePull;
  return [futureX - (dx / dist) * pull, futureY - (dy / dist) * pull];
};

// primary (interactive) aim-dot position for the on-beat dot `beatsAhead` beats out, per
// FIRST_BEAT_DOT_MODE. player/both pull the surface point one real bullet-reach toward the ship so
// the locked shot lands ON the beat; edge keeps the velocity-trail lead. Shared by the per-slot
// override builder and the guidance arrow so every consumer agrees on dot placement.
const computeOnBeatDotPrimary = (
  cx: number, cy: number, velX: number, velY: number, radius: number,
  aimCenterX: number, aimCenterY: number, beatGrid: number, beatsAhead: number,
  collisionRadiusOnBeat: number,
): [number, number] | null => {
  if (firstDotModeIs("edge")) return computeFirstDotEdge(cx, cy, velX, velY, radius, beatGrid, beatsAhead);
  return computeFirstDotPlayer(
    cx, cy, velX, velY, radius, aimCenterX, aimCenterY, beatGrid, beatsAhead, collisionRadiusOnBeat,
  );
};

// one primary override per reachable slot (index 0 = 1-beat dot, 1 = 2-beat, ...), plus the optional
// dimmed secondary marker for the first dot in 'both' mode. EVERY on-beat lock dot gets the same
// surface-minus-bullet-reach pull, so a locked shot at any slot lands on the beat — previously only
// the 1-beat dot was corrected, so deeper (multi-beat) drift locks landed early.
const computeOnBeatDotOverrides = (
  cx: number, cy: number, velX: number, velY: number, radius: number,
  aimCenterX: number, aimCenterY: number, beatGrid: number, slotCount: number,
  collisionRadiusOnBeat: number,
): { primaries: Array<[number, number] | null>; secondary: [number, number] | null } => {
  const primaries: Array<[number, number] | null> = [];
  for (let slot = 1; slot <= slotCount; slot++) {
    primaries.push(computeOnBeatDotPrimary(cx, cy, velX, velY, radius, aimCenterX, aimCenterY, beatGrid, slot, collisionRadiusOnBeat));
  }
  const secondary = firstDotModeIs("both")
    ? computeFirstDotPlayer(cx, cy, velX, velY, radius, aimCenterX, aimCenterY, beatGrid, 1, collisionRadiusOnBeat)
    : null;
  return { primaries, secondary };
};

type OnBeatAim = { x: number; y: number; reachable: boolean; willHitOnBeat: boolean };
const computeOnBeatAim = (
  cx: number, cy: number, velX: number, velY: number, radius: number,
  aimCenterX: number, aimCenterY: number, aimRadius: number, beatGrid: number,
  retX: number, retY: number,
): OnBeatAim => {
  const futureX = cx + velX * beatGrid;
  const futureY = cy + velY * beatGrid;
  const dx = futureX - aimCenterX;
  const dy = futureY - aimCenterY;
  const dist = Math.hypot(dx, dy);
  const reachable = dist >= Math.max(0, aimRadius - radius) && dist <= aimRadius + radius;
  let spotX: number;
  let spotY: number;
  if (reachable && dist > 1e-6) {
    spotX = futureX - (dx / dist) * radius;
    spotY = futureY - (dy / dist) * radius;
  } else {
    spotX = futureX;
    spotY = futureY;
  }
  // hit detection compares the aim disc (bullet at t=beatGrid) to the target's future
  // CENTER with combined radii — same logic the actual collision test uses — not to the spot,
  // since the spot sits on the body surface and would under-detect by the target's radius.
  const hitTol = radius + BULLET_SIGHT_RADIUS_ON_BEAT;
  const retDx = retX - futureX;
  const retDy = retY - futureY;
  const willHitOnBeat = reachable && retDx * retDx + retDy * retDy <= hitTol * hitTol;
  return { x: spotX, y: spotY, reachable, willHitOnBeat };
};

// core trajectory renderer — operates on a position/velocity snapshot, with optional cone clipping.
// alphaMultiplier folds in entry-flash boost and exit-fade decay; clipToCone is false during fade so the
// lingering ghost remains visible even after the target has left the radar wedge.
const EMPTY_DOT_WALK_RESULT: DotWalkResult = { overlapsReticule: false, slotProximities: [], slotWinnerReticuleIdx: [], slotWithin75: [] };

const emptySlotProximities = (n: number): number[] => new Array(n).fill(0);
const emptyWinnerIdx = (n: number): number[] => new Array(n).fill(-1);
const emptyWithin75 = (n: number): boolean[] => new Array(n).fill(false);
const emptyDotWalk = (slotCount: number): DotWalkResult => ({
  overlapsReticule: false,
  slotProximities: emptySlotProximities(slotCount),
  slotWinnerReticuleIdx: emptyWinnerIdx(slotCount),
  slotWithin75: emptyWithin75(slotCount),
});

// fold one walk (a target, or one toroidal image of it) into the running per-slot maxima:
//   strictly greater proximity wins and carries its winning reticule index; the booleans OR.
//   `r` is never mutated — EMPTY_DOT_WALK_RESULT is shared.
const mergeDotWalkInto = (acc: DotWalkResult, r: DotWalkResult) => {
  if (r.overlapsReticule) acc.overlapsReticule = true;
  const n = Math.min(acc.slotProximities.length, r.slotProximities.length);
  for (let i = 0; i < n; i++) {
    if (r.slotProximities[i] > acc.slotProximities[i]) {
      acc.slotProximities[i] = r.slotProximities[i];
      acc.slotWinnerReticuleIdx[i] = r.slotWinnerReticuleIdx[i];
    }
    if (i < r.slotWithin75.length && r.slotWithin75[i]) acc.slotWithin75[i] = true;
  }
};

// imageDx/imageDy: the apex-relative displacement of the ONE toroidal image of the target this
//   walk runs at (callers choose it — see candidateImages). Everything downstream stays in the raw
//   apex frame, so an image past the seam simply yields dots at their true unfolded coordinates and
//   the camera translate places the on-screen ones.
const paintTrajectoryFromSnapshot = (
  ctx: TrajectoryContext, snap: TrajectorySnapshot, imageDx: number, imageDy: number,
  firstSeen: number, alphaMultiplier: number, clipToCone: boolean,
  showOnRhythmSpot: boolean,
  aimHint: AimHintRender | null = null,
): DotWalkResult => {
  const speed = Math.hypot(snap.velX, snap.velY);
  if (speed < 1) return EMPTY_DOT_WALK_RESULT;
  const cx = ctx.apex.x + imageDx;
  const cy = ctx.apex.y + imageDy;
  const ux = snap.velX / speed;
  const uy = snap.velY / speed;
  const r = snap.radius;
  const edgePad = 6;
  const rawStartX = cx + ux * (r + edgePad);
  const rawStartY = cy + uy * (r + edgePad);
  let sMin: number;
  let sMax: number;
  if (clipToCone) {
    const clip = clipRayToCone(rawStartX - ctx.apex.x, rawStartY - ctx.apex.y, ux, uy, ctx.frame);
    if (clip.sMax <= clip.sMin) return EMPTY_DOT_WALK_RESULT;
    sMin = clip.sMin;
    sMax = clip.sMax;
  } else {
    sMin = -(r + edgePad);
    sMax = ctx.frame.length;
  }

  const pulsePeriod = TRAJECTORY_PULSE_PERIOD_BEATS * ctx.beatGrid;
  const pulse = computeTargetPulse(firstSeen, ctx.beatTime, ctx.beatGrid, pulsePeriod);
  const entryFlashBoost = computeEntryFlashBoost(firstSeen, ctx.beatTime);
  const beatPulseBoost = computeBeatPulseBoost(ctx.beatTime, ctx.beatGrid);
  // the centermost target (the one with the on-rhythm reticule) gets a uniform alpha boost
  // applied to every preview element on its trajectory, so the player can spot which target their
  // next on-beat shot is locked onto at a glance.
  const focusBoost = showOnRhythmSpot ? FOCUSED_TARGET_BRIGHTNESS : 1;
  // during the entry-flash window, override the pulse ramp so brightness peaks immediately rather
  // than easing in — the flash is the visual cue that the contact JUST appeared.
  const effectivePulse = entryFlashBoost > 1 ? Math.max(pulse, 1) : pulse;
  const c = ctx.ctx; // null on the compute-only (sim) pass — paints below are skipped
  if (c) c.globalAlpha = Math.min(1, TRAJECTORY_ALPHA * effectivePulse * alphaMultiplier);

  const [retX, retY] = remapReticuleToTarget(ctx.apex, ctx.reticulePos, ctx.w, ctx.h);
  const reticulesBySlot: Array<Array<[number, number]>> = ctx.reticulesBySlot.map(slotRets =>
    slotRets.map(p => remapReticuleToTarget(ctx.apex, p, ctx.w, ctx.h)),
  );
  const [aimCenterX, aimCenterY] = remapReticuleToTarget(ctx.apex, ctx.aimCircleCenter, ctx.w, ctx.h);
  const dotStep = speed * ctx.beatGrid;
  const dotOffset = -(r + edgePad);
  // relocate EVERY on-beat dot off the raw trail per FIRST_BEAT_DOT_MODE (edge / player / both).
  // `primaries[slot]` is the interactive dot the draw loop uses for proximity + lock-on; in 'both'
  // mode `secondary` is the dimmed player-relative marker for the first dot. null entries leave the
  // dot on the trail.
  const { primaries: onBeatDotOverrides, secondary: firstDotSecondary } = computeOnBeatDotOverrides(
    cx, cy, snap.velX, snap.velY, r, aimCenterX, aimCenterY, ctx.beatGrid, ctx.reticulesBySlot.length,
    ctx.collisionRadiusOnBeat,
  );
  if (c) {
    c.save();
    c.setLineDash([]);
    if (SHOW_AIM_INTERSECTION_X) {
      drawAimIntersectionsAlongRay(
        c, rawStartX, rawStartY, ux, uy, aimCenterX, aimCenterY,
        ctx.aimCircleRadius, sMin, sMax, entryFlashBoost, focusBoost, ctx.w, ctx.h,
      );
    }
  }
  // drawBeatDotsAlongRay computes the DotWalkResult (proximities/overlap — the lock inputs)
  //   regardless of ctx; it only paints when c is non-null.
  const result = drawBeatDotsAlongRay(
    c, rawStartX, rawStartY, ux, uy, reticulesBySlot,
    sMin, sMax, dotStep, dotOffset, entryFlashBoost, beatPulseBoost, focusBoost,
    ctx.w, ctx.h, ctx.doubletime, ctx.tutorialHighlight, showOnRhythmSpot,
    ctx.beatTime, ctx.beatGrid, ctx.hoverZoneEnterBySlot, onBeatDotOverrides, firstDotSecondary,
  );
  if (c && SHOW_ON_RHYTHM_RETICULE && showOnRhythmSpot) {
    const aim = computeOnBeatAim(
      cx, cy, snap.velX, snap.velY, r,
      aimCenterX, aimCenterY, ctx.aimCircleRadius, ctx.beatGrid, retX, retY,
    );
    const [aimDrawX, aimDrawY] = wrapToCanvas(aim.x, aim.y, ctx.w, ctx.h);
    paintOnRhythmSpot(c, aimDrawX, aimDrawY, aim.willHitOnBeat, aim.reachable, entryFlashBoost, beatPulseBoost, focusBoost);
  }
  if (c && aimHint) {
    // The reticule the lesson is about is the 1-beat dot — the ringed "shoot here next beat"
    //   marker. Under doubletime it sits at k=2 on a half-width step, so the on-beat dot is one
    //   full beat of travel out either way; the slot-0 override is the same point pulled back by
    //   the shell's reach, which is exactly where the player should put their sight.
    const [hintX, hintY] = onBeatDotOverrides[0]
      ?? [rawStartX + ux * (dotOffset + dotStep), rawStartY + uy * (dotOffset + dotStep)];
    const [hintDrawX, hintDrawY] = wrapToCanvas(hintX, hintY, ctx.w, ctx.h);
    // the popup pins to this spot, so publish it in wrapped world coordinates (the foreground
    //   layer is drawn under the same camera offset as the popups).
    aimHint.anchor.pos.x = ((hintX % ctx.w) + ctx.w) % ctx.w;
    aimHint.anchor.pos.y = ((hintY % ctx.h) + ctx.h) % ctx.h;
    c.globalAlpha = 1;
    paintAimHintPulse(c, hintDrawX, hintDrawY, aimHint);
  }
  if (c) c.restore();
  return result;
};

// refresh the track for an in-cone target — entry flash starts when no track existed, or when the
// target had fully faded out and re-enters; otherwise re-arming preserves the existing pulse phase.
const refreshTrack = (
  tracks: TrajectoryTrackMap, t: ReticuleTarget, beatTime: number, imageDx: number, imageDy: number,
): TrajectoryTrack => {
  const key = t as unknown as object;
  const existing = tracks.get(key);
  const radius = t.radius ?? 0;
  const snapshot: TrajectorySnapshot = {
    posX: t.pos.x, posY: t.pos.y, velX: t.vel.x, velY: t.vel.y, radius,
  };
  if (!existing) {
    const fresh: TrajectoryTrack = { firstSeen: beatTime, lastInConeAt: beatTime, snapshot, imageDx, imageDy };
    tracks.set(key, fresh);
    return fresh;
  }
  existing.snapshot = snapshot;
  existing.lastInConeAt = beatTime;
  existing.imageDx = imageDx;
  existing.imageDy = imageDy;
  return existing;
};

// the trajectory ray itself overlaps the cone when its forward path (from just ahead of the
// target, in the velocity direction) clips to a non-empty segment inside the wedge — keeps the
// preview "live" even after the asteroid leaves the cone, so long as its path still crosses it.
const trajectoryRayOverlapsCone = (
  dx: number, dy: number, t: ReticuleTarget, frame: ConeFrame,
): boolean => {
  const speed = Math.hypot(t.vel.x, t.vel.y);
  if (speed < 1) return false;
  const ux = t.vel.x / speed;
  const uy = t.vel.y / speed;
  const r = t.radius ?? 0;
  const edgePad = 6;
  const rsx = dx + ux * (r + edgePad);
  const rsy = dy + uy * (r + edgePad);
  const clip = clipRayToCone(rsx, rsy, ux, uy, frame);
  return clip.sMax > clip.sMin;
};

// The torus is exactly one screen wide, so a target's nearest toroidal image is the on-screen
// one — until the body crosses the seam, when "nearest" flips to the opposite edge and every dot
// computed from it jumps a full screen (or vanishes, because the flipped image's path no longer
// crosses the cone). So the preview does not commit to one image: it walks EVERY image whose body
// or on-beat dots are on screen. Each physical future position is then drawn at most once, never
// jumps, and a rock that just left one edge keeps its dots on that side for as long as the radar
// still covers its path — the same treatment the world layer's wrap copies give the sprite.
// Nearest image first, so the ordinary single-image case keeps its order and cost.
type ImageDelta = { dx: number; dy: number };
const candidateImages = (t: ReticuleTarget, apex: Vec, w: number, h: number): ImageDelta[] => {
  // An entering body is drawn at exactly one image (pos + enterOff, gameRender.paintEntrances)
  //   while it slides in, so that is the only image its dots may follow. enterOff is always a
  //   whole multiple of w/h (entrance.ts), i.e. one of the nine images below.
  if (t.entering) {
    return [{ dx: t.pos.x + (t.enterOffX ?? 0) - apex.x, dy: t.pos.y + (t.enterOffY ?? 0) - apex.y }];
  }
  const [dx0, dy0] = toroidalDelta(t.pos.x - apex.x, t.pos.y - apex.y, w, h);
  const images: ImageDelta[] = [{ dx: dx0, dy: dy0 }];
  for (let ky = -1; ky <= 1; ky++) {
    for (let kx = -1; kx <= 1; kx++) {
      if (kx !== 0 || ky !== 0) images.push({ dx: dx0 + kx * w, dy: dy0 + ky * h });
    }
  }
  return images;
};

// An image counts as radar contact only if its body, or one of its on-beat dots, is on screen.
//   Without this a wrap-around copy whose path crosses the cone from off screen would consume the
//   entry flash and keep refreshing lastInConeAt — which the aim hint reads as "the player can
//   see this one". The pad covers the dot's pull-back toward the ship plus its halo + crosshair.
const IMAGE_ON_SCREEN_PAD = 30;
const imageIsOnScreen = (ctx: TrajectoryContext, t: ReticuleTarget, img: ImageDelta): boolean => {
  const pad = (t.radius ?? 0) + ctx.collisionRadiusOnBeat + IMAGE_ON_SCREEN_PAD;
  const halfW = ctx.w / 2 + pad;
  const halfH = ctx.h / 2 + pad;
  if (Math.abs(img.dx) <= halfW && Math.abs(img.dy) <= halfH) return true;
  const dotOnScreen = (beatsAhead: number): boolean => {
    const fx = img.dx + t.vel.x * ctx.beatGrid * beatsAhead;
    const fy = img.dy + t.vel.y * ctx.beatGrid * beatsAhead;
    return Math.abs(fx) <= halfW && Math.abs(fy) <= halfH;
  };
  if (ctx.doubletime && dotOnScreen(0.5)) return true;
  const slotCount = ctx.reticulesBySlot.length;
  for (let k = 1; k <= slotCount; k++) if (dotOnScreen(k)) return true;
  return false;
};

// per-target live render — checks radar membership at every on-screen toroidal image of the
// target and updates its track. An image counts if EITHER its body overlaps the cone OR its
// forward path crosses the cone; the player can still aim the radar at the trajectory line
// itself. Every qualifying image is walked and their lock proximities merge per slot, so a dot
// that is physically near a reticule through the seam locks the same as one beside it.
const previewLiveTarget = (
  ctx: TrajectoryContext, t: ReticuleTarget, rendered: Set<object>,
  showSpot: boolean, aimHint: AimHintRender | null = null,
): DotWalkResult => {
  const tr = t.radius ?? 0;
  const qualifying: Array<ImageDelta & { targetInCone: boolean }> = [];
  for (const img of candidateImages(t, ctx.apex, ctx.w, ctx.h)) {
    if (!imageIsOnScreen(ctx, t, img)) continue;
    const targetInCone = targetIsInsideCone(img.dx, img.dy, tr, ctx.frame);
    if (!targetInCone && !trajectoryRayOverlapsCone(img.dx, img.dy, t, ctx.frame)) continue;
    qualifying.push({ dx: img.dx, dy: img.dy, targetInCone });
  }
  if (qualifying.length === 0) return EMPTY_DOT_WALK_RESULT;
  const key = t as unknown as object;
  // The primary image carries the hint pulse and the track's remembered side. Keep it on the
  //   side the track already showed so neither hops when the nearest image flips at the seam; a
  //   fresh track (and the headless sim pass, whose map is always empty) takes the nearest image.
  //   The choice only steers render-only state — every qualifying image is walked below either way.
  const existing = ctx.trajectoryTracks.get(key);
  let primary = qualifying[0];
  if (existing) {
    let bestDist = Infinity;
    for (const q of qualifying) {
      const d = Math.abs(q.dx - existing.imageDx) + Math.abs(q.dy - existing.imageDy);
      if (d < bestDist) { bestDist = d; primary = q; }
    }
  }
  const track = refreshTrack(ctx.trajectoryTracks, t, ctx.beatTime, primary.dx, primary.dy);
  rendered.add(key);
  const acc = emptyDotWalk(ctx.reticulesBySlot.length);
  for (const q of qualifying) {
    // when only the ray (not the body) is in the cone, disable cone clipping so the visible dots
    //   span the full forward path — clipping would chop the line back inside the wedge and could
    //   omit the section the radar is actually overlapping.
    mergeDotWalkInto(acc, paintTrajectoryFromSnapshot(
      ctx, track.snapshot, q.dx, q.dy, track.firstSeen, 1, q.targetInCone, showSpot,
      q === primary ? aimHint : null,
    ));
  }
  return acc;
};

// The hinted target may be nowhere near the radar cone — the shot that earned the hint could
// have landed anywhere. Draw its preview anyway (uncone-clipped, ramped in by the hint
// envelope) so there is a reticule for the pulse to bloom around and for the text to name.
const previewAimHintTarget = (
  ctx: TrajectoryContext, t: ReticuleTarget, hint: AimHintRender, rendered: Set<object>,
) => {
  const [dx, dy] = toroidalDelta(t.pos.x - ctx.apex.x, t.pos.y - ctx.apex.y, ctx.w, ctx.h);
  const track = refreshTrack(ctx.trajectoryTracks, t, ctx.beatTime, dx, dy);
  rendered.add(t as unknown as object);
  paintTrajectoryFromSnapshot(
    ctx, track.snapshot, dx, dy, track.firstSeen, aimHintEnvelope(hint.elapsed, hint.duration), false, true, hint,
  );
};

// drain expired fade entries and render fading-out trajectories for targets that left the cone or
// were destroyed while in it — keeps a 2s "ghost" of the last-seen path that decays to invisible.
// If the target is still alive, refresh the snapshot from its live pos/vel each frame so the ghost
// animates with the target instead of freezing where the radar last saw it.
const renderFadingTrajectories = (
  ctx: TrajectoryContext, rendered: Set<object>,
  liveByKey: Map<object, ReticuleTarget>,
) => {
  for (const [key, track] of ctx.trajectoryTracks) {
    if (rendered.has(key)) continue;
    const fade = computeFadeAlpha(track.lastInConeAt, ctx.beatTime);
    if (fade <= 0) {
      ctx.trajectoryTracks.delete(key);
      continue;
    }
    const live = liveByKey.get(key);
    if (live) {
      track.snapshot = {
        posX: live.pos.x, posY: live.pos.y, velX: live.vel.x, velY: live.vel.y,
        radius: live.radius ?? track.snapshot.radius,
      };
    }
    // keep the ghost on the side of the screen the radar last showed it: of the snapshot's
    //   images take the one nearest the remembered displacement, and remember that instead, so
    //   it follows the body (or the moving apex, for a dead target) continuously rather than
    //   snapping to the opposite edge when the nearest image flips at the seam.
    const [dx0, dy0] = toroidalDelta(track.snapshot.posX - ctx.apex.x, track.snapshot.posY - ctx.apex.y, ctx.w, ctx.h);
    const dx = dx0 + Math.round((track.imageDx - dx0) / ctx.w) * ctx.w;
    const dy = dy0 + Math.round((track.imageDy - dy0) / ctx.h) * ctx.h;
    track.imageDx = dx;
    track.imageDy = dy;
    paintTrajectoryFromSnapshot(ctx, track.snapshot, dx, dy, track.firstSeen, fade, false, false);
  }
};

// of all visible targets, pick the one whose center sits nearest the radar axis line — that's
// the single target the on-rhythm aim spot will be drawn for. Returns null if no eligible target.
// Exported so the main render loop can give that same target a brightness boost on its sprite.
export const pickCenterMostTargetForFocus = (
  apex: Vec, frame: ConeFrame, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>,
): ReticuleTarget | null => {
  if (frame.length <= 0) return null;
  let best: ReticuleTarget | null = null;
  let bestPerp = Infinity;
  for (const t of targets) {
    const [dx, dy] = toroidalDelta(t.pos.x - apex.x, t.pos.y - apex.y, w, h);
    const tr = t.radius ?? 0;
    const targetInCone = targetIsInsideCone(dx, dy, tr, frame);
    const rayInCone = !targetInCone && trajectoryRayOverlapsCone(dx, dy, t, frame);
    if (!targetInCone && !rayInCone) continue;
    const forward = dx * frame.axisX + dy * frame.axisY;
    if (forward <= 0) continue;
    const perp = Math.abs(dx * frame.axisY - dy * frame.axisX);
    if (perp < bestPerp) { bestPerp = perp; best = t; }
  }
  return best;
};

const pickCenterMostTarget = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): ReticuleTarget | null =>
  pickCenterMostTargetForFocus(ctx.apex, ctx.frame, ctx.w, ctx.h, targets);

// canvas-space position of the first-beat (1-beat) rhythm dot nearest to `from`, across all
// visible (in-cone or path-crossing) targets — the same on-beat hit surface the drawn dots use,
// so an arrow aimed here points at a dot the player can actually see. Returns null when no target
// is visible. Distance is measured toroidally so a dot wrapped to the far edge still wins if it's
// genuinely closer across the seam.
export const nearestFirstBeatDot = (
  apex: Vec, frame: ConeFrame, w: number, h: number, beatGrid: number,
  aimCenter: Vec, from: Vec, targets: ReadonlyArray<ReticuleTarget>,
  collisionRadiusOnBeat: number,
): Vec | null => {
  if (frame.length <= 0) return null;
  const [aimDx, aimDy] = toroidalDelta(aimCenter.x - apex.x, aimCenter.y - apex.y, w, h);
  const aimX = apex.x + aimDx;
  const aimY = apex.y + aimDy;
  let best: Vec | null = null;
  let bestD2 = Infinity;
  for (const t of targets) {
    const speed = Math.hypot(t.vel.x, t.vel.y);
    if (speed < 1) continue;
    const [dx, dy] = toroidalDelta(t.pos.x - apex.x, t.pos.y - apex.y, w, h);
    const tr = t.radius ?? 0;
    const targetInCone = targetIsInsideCone(dx, dy, tr, frame);
    const rayInCone = !targetInCone && trajectoryRayOverlapsCone(dx, dy, t, frame);
    if (!targetInCone && !rayInCone) continue;
    const cx = apex.x + dx;
    const cy = apex.y + dy;
    // arrow tracks the primary (interactive) 1-beat dot the draw loop uses, per FIRST_BEAT_DOT_MODE.
    const primary = computeOnBeatDotPrimary(cx, cy, t.vel.x, t.vel.y, tr, aimX, aimY, beatGrid, 1, collisionRadiusOnBeat);
    const dotX = primary ? primary[0] : cx + t.vel.x * beatGrid;
    const dotY = primary ? primary[1] : cy + t.vel.y * beatGrid;
    const [drawX, drawY] = wrapToCanvas(dotX, dotY, w, h);
    const [toDx, toDy] = toroidalDelta(drawX - from.x, drawY - from.y, w, h);
    const d2 = toDx * toDx + toDy * toDy;
    if (d2 < bestD2) { bestD2 = d2; best = { x: from.x + toDx, y: from.y + toDy }; }
  }
  return best;
};

// walks every visible target; returns strict overlap (for the 1-beat reticule lock-on visual),
// the max soft proximity per slot (0..1, used by each slot's hover-commit ring), and which
// reticule index inside the slot's reticule list won (so the renderer knows which prong to
// anchor the hover ring on). Slot k's data is at index k-1; entries beyond the renderer's slot
// count are absent.
export type TrajectoryPreviewResult = {
  overlapsReticule: boolean;
  slotProximities: number[];
  slotWinnerReticuleIdx: number[];
  slotWithin75: boolean[];
};

export const paintTrajectoryPreviews = (
  ctx: TrajectoryContext, targets: ReadonlyArray<ReticuleTarget>,
): TrajectoryPreviewResult => {
  const slotCount = ctx.reticulesBySlot.length;
  const acc = emptyDotWalk(slotCount);
  if (ctx.frame.length <= 0) return acc;
  const c = ctx.ctx; // null on the compute-only (sim) pass
  if (c) { c.save(); c.setLineDash([]); c.lineWidth = 1.5; }
  const rendered = new Set<object>();
  const hint = ctx.aimHint ?? null;
  const hintTarget = hint ? targets.find((t) => (t as unknown as object) === hint.key) ?? null : null;
  // while the hint is up its target takes the focus — the bright ringed first-beat dot is the
  //   spot the lesson is about, and it can't be sitting on a different rock behind the pulse.
  const spotTarget = hintTarget ?? pickCenterMostTarget(ctx, targets);
  const liveByKey = new Map<object, ReticuleTarget>();
  for (const t of targets) liveByKey.set(t as unknown as object, t);
  for (const t of targets) {
    mergeDotWalkInto(acc, previewLiveTarget(ctx, t, rendered, t === spotTarget, t === hintTarget ? hint : null));
  }
  if (c && hint && hintTarget && !rendered.has(hint.key)) previewAimHintTarget(ctx, hintTarget, hint, rendered);
  // Fade-out ghosts are render-only and mutate trajectoryTracks (delete) — skip on the
  //   compute pass so the sim never touches that cosmetic map.
  if (c) { renderFadingTrajectories(ctx, rendered, liveByKey); c.restore(); }
  return acc;
};
