import type { Ship } from "../../Ship";
import type { Sound } from "../../Sound";
import { Vec, add, mul, TAU } from "../../vec";
import { computeConeFrame } from "./coneGeometry";
import { paintConeBackground, paintRangeArcs } from "./radarCone";
import { paintTrajectoryPreviews, ReticuleTarget, TrajectoryTrackMap, AimHintRender, computeBeatPulseBoost, expireHoverZoneHintIfHoverEnded, paintHoverZoneHint, nearestFirstBeatDot, wrapReticuleVec } from "./trajectoryPreview";
import {
  reticuleOverlapsAnyTarget,
  paintAimDiscs,
} from "./aimDisc";
import { prongOffsets, shotLife, shotTravel, shotVelInherit, shotPositionAt, BOMB_SIGHT_SLOTS } from "../shipWeapons";
import { BULLET_SIGHT_RADIUS_ON_BEAT } from "./trajectoryPreview";
import { bulletCollisionRadius, BOMB_BLAST_RADIUS } from "../../Bullet";
import { toroidalDelta } from "./coneGeometry";

// stationary hover probe — drives the same per-slot ring lock / hum stack as a moving target,
// but proximity is measured directly against the probe's current position (no trajectory walk),
// so parked gems still trigger "First Dot" feedback the trajectory system would miss.
export type ReticuleHoverProbe = { pos: Vec; radius: number };
// matches the dot-trajectory walk's overlap band (BULLET_HIT_RADIUS_ON_BEAT + probe radius);
// the smoothstep pad mirrors TRAJECTORY_FIRST_BEAT_DOT_PROXIMITY_PAD so probe-locks feel the
// same as target-locks. Tight (10px) so the lock animation + drift-shot credit only triggers
// on near-direct overlap, not on a distant graze.
const PROBE_PROXIMITY_PAD = 10;
const PROBE_ZONE_RADIUS = 75;

// hitbox alpha for the not-hovering reticule — this IS the final alpha (no hidden downstream
// multipliers), so tweak these to brighten/dim the resting reticule directly.
const RETICULE_HITBOX_PULSE_MAX = 0.32;
const RETICULE_HITBOX_PULSE_MIN = 0.20;
const RETICULE_HITBOX_PULSE_PERIOD_SEC = 2.0;
// dim during fire cooldown so the player feels the rhythm window even with nothing in sight.
const RETICULE_COOLDOWN_DIM = 0.3;
const RETICULE_RADAR_PULSE_MAX = 1;
const RETICULE_RADAR_PULSE_MIN = 0.7;
const RETICULE_RADAR_PULSE_PERIOD_SEC = 3.0;

// doubletime (rapid powerup) fires every half-beat, so the off-beat bullet
// only travels half as far before the next beat.
const HALF_BEAT_FRACTION = 0.5;

// guidance arrow: a small filled triangle orbiting the reticule that points toward the nearest
// first-beat rhythm dot. Sits just outside the on-beat disc so it reads as part of the sight
// without crowding the crosshair ticks. Hidden the moment the reticule grazes a dot (the lock
// pulse takes over). The arrow only points; it never tells you distance.
// resting hue matches the rest of the reticule; on the beat it flashes toward the brighter
// Pulsar-logo blue (#4cb6ff ≈ hsl(207,100%,65%)) and lightens, so the downbeat reads hard.
// set false to hide the directional guidance triangle entirely (lock pulse still works)
const ARROW_ENABLED = false;
const ARROW_HSL_REST = "195, 100%, 75%";
const ARROW_HSL_BEAT = "207, 100%, 78%";
const ARROW_ORBIT_GAP = 13;
const ARROW_ORBIT_RADIUS = BULLET_SIGHT_RADIUS_ON_BEAT + ARROW_ORBIT_GAP;
const ARROW_HALF_WIDTH = 4;
const ARROW_LENGTH = 20;
// resting → on-beat alpha. The beat boost rides the same square-decay envelope as the reticule
// pulse so the flash spikes on the downbeat and falls off fast.
const ARROW_REST_ALPHA = 0.4;
const ARROW_BEAT_ALPHA = 1.0;
// fade in/out so the arrow doesn't pop when a target appears/disappears or when hover toggles.
const ARROW_FADE_SEC = 0.18;
// once on a dot, a single ring expands outward from the reticule on every beat and fades — the
// "you're locked on" confirmation that replaces the (now hidden) directional arrow.
const HOVER_PULSE_SPAN = 34;
const HOVER_PULSE_LINE_WIDTH = 2;
const HOVER_PULSE_PEAK_ALPHA = 0.8;
// Tier-6 climax (the final tier): the hold pulse stops being "the same ring, wider/whiter" and
// becomes a distinct radiant event — a thick incandescent leading ring trailed by a soft halo,
// plus a slow on-the-downbeat bloom so reaching the top reads as "fully arrived / radiant".
const HOVER_PULSE_FINAL_HSL = "45, 100%, 92%";        // near-white incandescent gold
const HOVER_PULSE_FINAL_CORE_HSL = "0, 0%, 100%";     // pure-white hot core
const HOVER_PULSE_FINAL_LINE_WIDTH = 3.5;
const HOVER_PULSE_FINAL_PEAK_ALPHA = 1.0;
// the halo ring trails the leading ring by this fraction of its travel — a soft wide afterglow.
const HOVER_PULSE_FINAL_HALO_LAG = 0.22;
const HOVER_PULSE_FINAL_HALO_WIDTH = 9;
// module-scoped so the arrow and hover pulse can crossfade across frames.
let arrowFade01 = 0;
let hoverPulseFade01 = 0;
// last heading the arrow pointed at — held so the arrow can keep fading out along its last
// direction after the nearest dot vanishes (hover begins, or the target leaves the cone).
let lastArrowAngle = 0;

// bind ship state to per-target memo so trajectory previews can track entry-flash and fade across frames.
// hoverDotRings: one entry per reachable on-beat slot (index 0 = 1-beat, 1 = 2-beat, ...). Array is
// owned by Ship and grown lazily as bullet range extends; renderer pads it here if it needs more.
type HoverRingState = {
  hoverStartBeatTime: number | null;
  completionBeatTime: number | null;
  zoneEnterBeatTime: number | null;
  fadeOutStartTime: number | null;
  lastRingCenter: Vec | null;
};
type ReticuleState = {
  trajectoryTracks: TrajectoryTrackMap;
  hoverDotRings: HoverRingState[];
};

// 16 arcs filled evenly across HOVER_RING_FILL_SEC — completion lines up with the tutorial
// gate (fill + completion-flare animation = TUTORIAL_HOVER_SEC).
const HOVER_DOT_COUNT = 16;
// each slot is TAU/16; arc fills half the slot so arc-length == gap-length around the ring.
const HOVER_ARC_SWEEP = (TAU / HOVER_DOT_COUNT) * 0.5;
const HOVER_ARC_LINE_WIDTH = 1.5;
// sits just past the crosshair tips so arcs don't crowd the aim disc.
const HOVER_DOT_RING_RADIUS = 26;
const HOVER_DOT_BUILDING_ALPHA = 0.45;
// ring fills in HOVER_RING_FILL_SEC; per-arc fade-in is just under one slot so the leading edge
// sweeps before the next arc starts. Completion flare runs for FLARE_SEC afterward. The fill time
// IS the tier-1 (basic) drift-shot hold (DRIFT_TIER_HOLD_SEC[0]) — lowering it speeds the whole
// fill animation in lockstep, since every per-arc duration derives from HOVER_RING_SLOT_SEC.
const HOVER_RING_FILL_SEC = 0.5;
const HOVER_RING_SLOT_SEC = HOVER_RING_FILL_SEC / HOVER_DOT_COUNT;
const HOVER_ARC_FADE_IN_SEC = HOVER_RING_SLOT_SEC * 0.9;
// once complete, arcs breathe 1.0 → reticule's hovered base alpha so peak = "this shot lands".
const HOVER_DOT_PULSE_PEAK_ALPHA = 1.0;
const HOVER_DOT_PULSE_MIN_ALPHA = 0.28;
const HOVER_DOT_PULSE_PERIOD_SEC = 2.0;
// after the lock flare resolves, the dashed dot ring fades to a low resting alpha so the
// player's eye is no longer drawn to the wider circle — the actual hit zone is the inner
// aim disc, and the soundwaves carry the rhythmic pulse.
const HOVER_DOT_RESTING_ALPHA = 0.18;
const HOVER_DOT_FADE_SEC = 0.4;
const HOVER_DOT_FADEOUT_SEC = 0.1;
// white while the hold is still short of the drift-shot threshold, gold once it would trigger one
// — the colour flip is the "release now and you get a drift shot" cue. Gold matches
// HOVER_FLARE_WARM_HSL so the fill's armed colour and the lock flare read as one hue.
const HOVER_DOT_HSL_UNARMED = "0, 0%, 100%";
const HOVER_DOT_HSL_ARMED = "48, 100%, 70%";
// lock flare: brightens the dot-ring arcs briefly at lock acquisition. Marks "lock acquired"
// — the octave-up hum starts here too. Tutorial gate fires on elapsed >= TUTORIAL_HOVER_SEC
// independently; the flare visual can outrun it.
const HOVER_FLARE_SEC = 0.7;
const HOVER_FLARE_PEAK_BOOST = 4.0;
// white center-flash on lock — soft swell rather than a hard pop so the player's ear stays
// anchored to the song beat instead of treating the flash as a "fire NOW" cue.
const HOVER_CENTER_FLASH_SEC = 0.55;
const HOVER_CENTER_FLASH_PEAK_ALPHA = 0.5;
// soundwave rings: one new concentric ring emitted every WAVE_PERIOD_BEATS while the player
// holds hover. Each ring expands outward from the dot ring and fades — reads as a radar ping
// pulsing in time with the music. WAVE_LIFETIME_BEATS controls how long a single wave lives
// before fully fading; > PERIOD means consecutive waves overlap for a continuous feel.
const HOVER_WAVE_PERIOD_BEATS = 2;
const HOVER_WAVE_LIFETIME_BEATS = 3.0;
// fire the first soundwave one beat before the ring finishes filling — the pulse anticipates
// the lock instead of trailing it.
const HOVER_WAVE_LEAD_BEATS = 1;
// soundwaves emanate from the inner aim disc (bullet-sized) so the radar ping reads as
// "this is the actual hit zone" — not the larger dashed dot-ring, which used to misleadingly
// suggest a wider target.
const HOVER_WAVE_END_GAP = 44;
const HOVER_WAVE_LINE_WIDTH = 2.0;
const HOVER_WAVE_PEAK_ALPHA = 0.7;
// lock-event wave: a single brighter wave fired the moment the ring completes filling, so
// lock acquisition still reads as a distinct beat even though the steady soundwave pulse
// is already running.
const HOVER_LOCK_WAVE_PEAK_ALPHA = 0.95;
const HOVER_LOCK_WAVE_LINE_WIDTH = 2.8;
// gold hue at the peak — drift the dash colour toward warm/white so the lock reads as "reward".
const HOVER_FLARE_WARM_HSL = "48, 100%, 70%";

// Drift-shot tiers: keep hovering past the basic lock to climb tiers, each one raising the
// damage and rhythm-bonus multipliers (+1 per tier: 2× … 7× damage) and shifting the lock
// visuals + hum stack. Hold time is measured from hover START (total), so index 0 == the
// ring-fill time == the basic lock. Tier number returned is 1-based (0 = not yet locked).
// Gaps widen as you climb (+2,+2,+4,+4,+6) so the top tiers are a real commitment. Each added
// hum is a fresh chord tone so the stack RESOLVES as it grows: triad → add9 → 6/9 → 6/9+octave.
const DRIFT_TIER_HOLD_SEC = [HOVER_RING_FILL_SEC, 2.5, 4.5, 8.5, 12.5, 18.5] as const;
const DRIFT_TIER_MAX = DRIFT_TIER_HOLD_SEC.length;
// elapsed = beatTime - hoverStartBeatTime. 0 below the first threshold, else the highest tier reached.
const driftTierForElapsed = (elapsed: number): number => {
  let tier = 0;
  for (let i = 0; i < DRIFT_TIER_HOLD_SEC.length; i++) {
    if (elapsed >= DRIFT_TIER_HOLD_SEC[i]) tier = i + 1;
  }
  return tier;
};
// tier from a ring's hover-lock state: 0 unless the ring has actually completed its lock
// (completionBeatTime set), so an un-built ring never reports a tier even if hover has run long.
type HoverLockReadState = { hoverStartBeatTime: number | null; completionBeatTime: number | null };
export const driftTierForRing = (ring: HoverLockReadState, beatTime: number): number => {
  if (ring.completionBeatTime === null || ring.hoverStartBeatTime === null) return 0;
  return Math.max(1, driftTierForElapsed(beatTime - ring.hoverStartBeatTime));
};
// per-tier pulse colour: gold → cyan → magenta → violet, then as the chord RESOLVES the light
// blooms warm — rose-violet → near-white incandescent gold — so the final tiers read as "fully
// radiant / arrived" rather than just more saturated hue.
export const DRIFT_TIER_PULSE_HSL = ["48, 100%, 70%", "195, 100%, 65%", "300, 100%, 68%", "270, 100%, 75%", "320, 100%, 80%", "45, 100%, 92%"] as const;
// higher tiers widen the pulse/soundwave circles so the escalation is legible at a glance.
const DRIFT_TIER_WIDTH_MULT = [1.0, 1.35, 1.7, 2.05, 2.4, 2.8] as const;
// shared so the drift-shot hit burst (driftBurst.ts) colours its soundwave explosion in the same
// per-tier hue the lock pulse uses — the hit reads as that exact ring detonating outward.
export const driftTierPulseHsl = (tier: number): string => DRIFT_TIER_PULSE_HSL[Math.max(0, Math.min(DRIFT_TIER_MAX - 1, tier - 1))];
const driftTierWidthMult = (tier: number): number => DRIFT_TIER_WIDTH_MULT[Math.max(0, Math.min(DRIFT_TIER_MAX - 1, tier - 1))];

// one-shot hint that surfaces the first time the player ever holds a hover long enough to
// complete the lock ring fill. Persistence via localStorage so it only appears on the player's
// very first Drift Shot lock-in, ever — re-runs after that show nothing.
const DRIFT_LOCK_HINT_KEY = "pulsar.driftLockHintSeen";
const DRIFT_LOCK_HINT_LINES = ["Drift and hold", "for x2 damage"] as const;
const DRIFT_LOCK_HINT_FONT = "400 18px 'Space Grotesk', system-ui, sans-serif";
const DRIFT_LOCK_HINT_FILL_HSL = "197, 100%, 86%";
const DRIFT_LOCK_HINT_SHADOW = "rgba(0, 0, 0, 0.8)";
const DRIFT_LOCK_HINT_LINE_HEIGHT = 22;
const DRIFT_LOCK_HINT_OFFSET_Y = HOVER_DOT_RING_RADIUS + 22;
const DRIFT_LOCK_HINT_FADE_IN_SEC = 0.15;
const DRIFT_LOCK_HINT_HOLD_SEC = 2.5;
const DRIFT_LOCK_HINT_FADE_OUT_SEC = 1.2;
let driftLockHintAnchor: { x: number; y: number } | null = null;
let driftLockHintShownAt: number | null = null;
const driftLockHintAlreadySeen = (): boolean => {
  try { return localStorage.getItem(DRIFT_LOCK_HINT_KEY) === "1"; }
  catch { return false; }
};
const markDriftLockHintSeen = () => {
  try { localStorage.setItem(DRIFT_LOCK_HINT_KEY, "1"); } catch {}
};
const tryClaimDriftLockHint = (center: Vec, beatTime: number) => {
  if (driftLockHintAlreadySeen()) return;
  if (driftLockHintAnchor !== null) return;
  driftLockHintAnchor = { x: center.x, y: center.y + DRIFT_LOCK_HINT_OFFSET_Y };
  driftLockHintShownAt = beatTime;
  markDriftLockHintSeen();
};
const paintDriftLockHint = (ctx: CanvasRenderingContext2D, beatTime: number) => {
  if (driftLockHintAnchor === null || driftLockHintShownAt === null) return;
  const since = beatTime - driftLockHintShownAt;
  const total = DRIFT_LOCK_HINT_FADE_IN_SEC + DRIFT_LOCK_HINT_HOLD_SEC + DRIFT_LOCK_HINT_FADE_OUT_SEC;
  if (since >= total) { driftLockHintAnchor = null; driftLockHintShownAt = null; return; }
  let alpha: number;
  if (since < DRIFT_LOCK_HINT_FADE_IN_SEC) {
    alpha = since / DRIFT_LOCK_HINT_FADE_IN_SEC;
  } else if (since < DRIFT_LOCK_HINT_FADE_IN_SEC + DRIFT_LOCK_HINT_HOLD_SEC) {
    alpha = 1;
  } else {
    const t = (since - DRIFT_LOCK_HINT_FADE_IN_SEC - DRIFT_LOCK_HINT_HOLD_SEC) / DRIFT_LOCK_HINT_FADE_OUT_SEC;
    alpha = Math.max(0, 1 - t) * Math.max(0, 1 - t);
  }
  const prevFont = ctx.font;
  const prevFill = ctx.fillStyle;
  const prevAlign = ctx.textAlign;
  const prevBaseline = ctx.textBaseline;
  const prevShadowColor = ctx.shadowColor;
  const prevComposite = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "source-over";
  ctx.font = DRIFT_LOCK_HINT_FONT;
  ctx.fillStyle = `hsla(${DRIFT_LOCK_HINT_FILL_HSL}, ${0.95 * alpha})`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = DRIFT_LOCK_HINT_SHADOW;
  for (let i = 0; i < DRIFT_LOCK_HINT_LINES.length; i++) {
    ctx.fillText(DRIFT_LOCK_HINT_LINES[i], driftLockHintAnchor.x, driftLockHintAnchor.y + i * DRIFT_LOCK_HINT_LINE_HEIGHT);
  }
  ctx.font = prevFont;
  ctx.fillStyle = prevFill;
  ctx.textAlign = prevAlign;
  ctx.textBaseline = prevBaseline;
  ctx.shadowColor = prevShadowColor;
  ctx.globalCompositeOperation = prevComposite;
};

// the aim circle = locus of shot positions at t=beatGrid over all headings. Single source
// of truth so the reticule painter and the gameRender red-tint check agree on geometry.
export const computeAimCircle = (ship: Ship, beatGrid: number) => ({
  center: add(ship.pos, mul(ship.vel, shotVelInherit(ship) * beatGrid)),
  radius: ship.radius + 4 + shotTravel(ship, beatGrid),
});

// Where a shot fired with the given heading offset lands after `beatFraction` of a
// beat, in RAW apex-relative world space (NOT folded into [0,w)). The trajectory
// dots it's matched against live in the same raw space (apex + toroidalDelta), so
// the Euclidean proximity/lock math only lines up if the reticule isn't
// pre-wrapped — folding it here was the seam-crossing lock+visual dropout.
// Draw-time folding is handled by wrapToCanvas (anchor-aware per camera).
const computeReticulePosition = (ship: Ship, beatGrid: number, headingOffset: number, beatFraction: number): Vec =>
  shotPositionAt(ship, headingOffset, beatGrid * beatFraction);

// One reticule per beat slot the shot reaches. A bomb gets BOMB_SIGHT_SLOTS — it
// doesn't run out of range so much as come to rest.
const reticuleSlotCount = (ship: Ship, beatGrid: number, superBoosted: boolean): number =>
  ship.bombActive ? BOMB_SIGHT_SLOTS : Math.max(1, Math.floor(shotLife(ship, superBoosted) / beatGrid));

// prong fans the aim into one angle per prongOffsets entry; doubletime adds a half-beat preview at
// half distance (not for a bomb, which only pulses on whole beats); integer-k reticules
// mark every beat-slot the bullet actually crosses
// (t = beatGrid*k < life), so the count adapts to longshot/pierce/superBoosted range and to
// the rhythm-gate tempo (eighth-grid at combo ≥ 12 or under rapid). slotPositionIndices[k-1]
// lists every position index that anchors the k-beat slot — one entry per prong angle.
// The slot's hover ring locks the moment the trajectory dot grazes ANY of them.
type ReticulePositions = { positions: Vec[]; primaryIndex: number; slotPositionIndices: number[][] };
const computeReticulePositions = (
  ship: Ship, beatGrid: number, doubletime: boolean, superBoosted: boolean,
): ReticulePositions => {
  const angleOffsets = prongOffsets(ship.prongCount);
  const primaryOffset = angleOffsets[0];
  const slotCount = reticuleSlotCount(ship, beatGrid, superBoosted);
  const integerFractions: number[] = [];
  for (let k = 1; k <= slotCount; k++) integerFractions.push(k);
  const beatFractions = doubletime && !ship.bombActive ? [HALF_BEAT_FRACTION, ...integerFractions] : integerFractions;
  const positions: Vec[] = [];
  let primaryIndex = -1;
  const slotPositionIndices: number[][] = Array.from({ length: slotCount }, () => []);
  for (const frac of beatFractions) {
    for (const off of angleOffsets) {
      const idx = positions.length;
      positions.push(computeReticulePosition(ship, beatGrid, off, frac));
      if (off === primaryOffset && frac === 1) primaryIndex = idx;
      if (Number.isInteger(frac) && frac >= 1 && frac <= slotCount) {
        slotPositionIndices[frac - 1].push(idx);
      }
    }
  }
  return { positions, primaryIndex, slotPositionIndices };
};

// Folded screen position of the primary ("shoot now to hit next beat") reticule —
//   the anchor the streak orbs orbit. Falls back to the ship apex if no slot exists.
export const primaryReticulePosition = (
  ship: Ship, beatGrid: number, w: number, h: number, doubletime: boolean, superBoosted: boolean,
): Vec => {
  const { positions, primaryIndex } = computeReticulePositions(ship, beatGrid, doubletime, superBoosted);
  const raw = primaryIndex >= 0 ? positions[primaryIndex]
    : positions.length > 0 ? positions[0] : ship.pos;
  return wrapReticuleVec(raw, w, h);
};

// Pure predicate: has the dashed lock ring finished building at this `elapsed`? This is the
//   GAMEPLAY-relevant edge — it stamps completionBeatTime, which gates drift-shot eligibility
//   (+1 combo). Extracted from paintHoverDotRing so the SIM can run the hover-lock state machine
//   without rendering (replay re-sims headless; if this only ran in paint the lock never fired
//   in replay → drift bonus desync). Painting reuses the same expression.
const hoverRingFullyBuilt = (elapsed: number): boolean =>
  Math.min(HOVER_DOT_COUNT, Math.floor(elapsed / HOVER_RING_SLOT_SEC) + 1) >= HOVER_DOT_COUNT
  && (elapsed - (HOVER_DOT_COUNT - 1) * HOVER_RING_SLOT_SEC) >= HOVER_ARC_FADE_IN_SEC;

// arcs fill across HOVER_RING_FILL_SEC, then a brief HOVER_FLARE_SEC arc-brightening marks
// lock acquisition. While the ring is fully built, concentric soundwave rings radiate
// outward in time with the beat for as long as the player holds hover. Returns whether the
// The exact reach the collision pass will use for an on-beat shot — what the aim
// dots are pulled back by. A bomb shell is stock-sized, so it shares this: aimed
// there, the shell meets the target on the beat instead of bouncing off it early.
const onBeatCollisionRadius = (superBoosted: boolean): number =>
  bulletCollisionRadius({ onBeat: true, superBoosted });

// A bomb's sight also previews the blast: a dashed ring at BOMB_BLAST_RADIUS around
// the first-beat slot, the same ring the shell itself will carry — anything inside
// it when the mine first pulses is caught. Only the first: the later slots sit
// close enough that their rings would overlap into one blob, and by then the
// thrown mine is showing its own live ring.
const BOMB_PREVIEW_DASH = [6, 6];
const paintBombBlastPreview = (ctx: CanvasRenderingContext2D, pos: Vec, alpha: number) => {
  ctx.save();
  ctx.setLineDash(BOMB_PREVIEW_DASH);
  ctx.strokeStyle = `hsla(4, 100%, 72%, ${alpha})`;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, BOMB_BLAST_RADIUS, 0, TAU);
  ctx.stroke();
  ctx.restore();
};

// The drift-lock flourish — dashed ring, soundwaves, lock flash, lock-on pulse — is a REWARD
// cue, not a readout of the hit zone, so it doesn't have to match the stock bullet's sight.
// Scaled above the stock sight so the lock reads as a flourish around it, not a ring on it.
const LOCK_VISUAL_SCALE = 1.6;

const LOCK_SIGHT_RADIUS = BULLET_SIGHT_RADIUS_ON_BEAT * LOCK_VISUAL_SCALE;
const LOCK_DOT_RING_RADIUS = HOVER_DOT_RING_RADIUS * LOCK_VISUAL_SCALE;
const HOVER_PULSE_START_R = LOCK_SIGHT_RADIUS;
const HOVER_PULSE_END_R = (BULLET_SIGHT_RADIUS_ON_BEAT + HOVER_PULSE_SPAN) * LOCK_VISUAL_SCALE;
const HOVER_WAVE_START_R = LOCK_SIGHT_RADIUS;
const HOVER_WAVE_END_R = (HOVER_DOT_RING_RADIUS + HOVER_WAVE_END_GAP) * LOCK_VISUAL_SCALE;

// ring just crossed into "filled" this frame (rising-edge signal for the audio companion).
const paintHoverDotRing = (
  ctx: CanvasRenderingContext2D, center: Vec, elapsed: number, beatTime: number, beatGrid: number,
  fadeOutAlpha: number = 1,
): { fillJustCompleted: boolean } => {
  const slotDuration = HOVER_RING_SLOT_SEC;
  const visibleCount = Math.min(HOVER_DOT_COUNT, Math.floor(elapsed / slotDuration) + 1);
  const fullyBuilt = visibleCount >= HOVER_DOT_COUNT
    && (elapsed - (HOVER_DOT_COUNT - 1) * slotDuration) >= HOVER_ARC_FADE_IN_SEC;
  const fillCompleteSec = HOVER_RING_FILL_SEC;
  const flareAge = fullyBuilt ? Math.max(0, elapsed - fillCompleteSec) : -1;
  const flareT = flareAge >= 0 ? Math.min(1, flareAge / HOVER_FLARE_SEC) : 0;
  // burst envelope: very fast rise, long fall — drives the brief arc brightening at lock.
  const burstEnvelope = flareT > 0 && flareT < 1
    ? Math.pow(Math.sin(flareT * Math.PI), 0.6) * Math.pow(1 - flareT, 0.5)
    : 0;
  // pulsing alpha while filling/flaring; once the flare resolves, ease down to a low resting
  // alpha so the dashed ring stops competing with the inner bullet-sized reticule for the eye.
  const postFlareAge = fullyBuilt ? Math.max(0, elapsed - fillCompleteSec - HOVER_FLARE_SEC) : 0;
  const fadeT = Math.min(1, postFlareAge / HOVER_DOT_FADE_SEC);
  const pulsing = cosineEnvelope(beatTime, HOVER_DOT_PULSE_PERIOD_SEC, HOVER_DOT_PULSE_MIN_ALPHA, HOVER_DOT_PULSE_PEAK_ALPHA);
  const baseAlpha = fullyBuilt
    ? pulsing + (HOVER_DOT_RESTING_ALPHA - pulsing) * fadeT
    : HOVER_DOT_BUILDING_ALPHA;
  const arcAlphaBoost = 1 + (HOVER_FLARE_PEAK_BOOST - 1) * burstEnvelope;
  // tier from total hold — drives the warm flare/soundwave colour + soundwave width so the
  // lock visuals shift gold → cyan → magenta as the player keeps holding past each threshold.
  const tier = fullyBuilt ? Math.max(1, driftTierForElapsed(elapsed)) : 0;
  const tierWarmHsl = tier > 0 ? driftTierPulseHsl(tier) : HOVER_FLARE_WARM_HSL;
  const tierWidth = tier > 0 ? driftTierWidthMult(tier) : 1;
  // arcs read white while the hold is too short to trigger a drift shot, then flip to gold the
  // instant the ring completes (would trigger). The lock flare blooms from that gold base toward
  // the tier hue.
  const arcBaseHsl = fullyBuilt ? HOVER_DOT_HSL_ARMED : HOVER_DOT_HSL_UNARMED;
  const arcHsl = burstEnvelope > 0
    ? lerpHsl(arcBaseHsl, tierWarmHsl, burstEnvelope)
    : arcBaseHsl;
  // apply overall fadeOut multiplier (used when reticule leaves the trigger zone)
  const effectiveAlphaMultiplier = fadeOutAlpha;
  // soundwaves emit BEFORE arcs so the arcs and the dot/aim disc paint on top of them.
  // The first wave fires one beat before fill completes (HOVER_WAVE_LEAD_BEATS), so the
  // pulse is already underway by the time the arcs finish locking in.
  const wavesStartSec = fillCompleteSec - HOVER_WAVE_LEAD_BEATS * beatGrid;
  if (elapsed >= wavesStartSec) {
    // soundwaves track the arc colour: white while the hold hasn't yet armed a drift shot,
    // then the warm tier hue once it would trigger — so nothing reads gold before the lock.
    const waveHsl = fullyBuilt ? tierWarmHsl : HOVER_DOT_HSL_UNARMED;
    paintSoundwaves(ctx, center, elapsed - wavesStartSec, beatTime, beatGrid, fadeOutAlpha, waveHsl, tierWidth);
  }
  // white center flash on lock acquisition — anchored on the aim disc rather than the wider
  // dashed dot ring, at the shared lock-visual scale so a stock shot's lock still lands as an event.
  if (flareAge >= 0 && flareAge < HOVER_CENTER_FLASH_SEC) {
    const t = flareAge / HOVER_CENTER_FLASH_SEC;
    // sin-shaped swell-and-fade instead of front-loaded pop, so the flash reads as a glow
    // settling in rather than a strobe.
    const env = Math.sin(t * Math.PI);
    ctx.save();
    ctx.fillStyle = `hsla(0, 0%, 100%, ${HOVER_CENTER_FLASH_PEAK_ALPHA * env * fadeOutAlpha})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, LOCK_SIGHT_RADIUS, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(0, 0%, 100%, ${0.6 * env * fadeOutAlpha})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(center.x, center.y, LOCK_SIGHT_RADIUS * (1 + 0.4 * t), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  ctx.lineWidth = HOVER_ARC_LINE_WIDTH;
  ctx.lineCap = "round";
  ctx.setLineDash([]);
  const slot = TAU / HOVER_DOT_COUNT;
  const start = -Math.PI / 2;
  for (let i = 0; i < visibleCount; i++) {
    const age = elapsed - i * slotDuration;
    const t = Math.min(1, Math.max(0, age / HOVER_ARC_FADE_IN_SEC));
    const sweepEase = 1 - Math.pow(1 - t, 3);
    const alphaEase = Math.sqrt(t);
    const alpha = Math.min(1, baseAlpha * alphaEase * arcAlphaBoost * effectiveAlphaMultiplier);
    ctx.strokeStyle = `hsla(${arcHsl}, ${alpha})`;
    const mid = start + i * slot;
    const ccwEnd = mid - HOVER_ARC_SWEEP / 2;
    const cwEnd = ccwEnd + HOVER_ARC_SWEEP * sweepEase;
    ctx.beginPath();
    ctx.arc(center.x, center.y, LOCK_DOT_RING_RADIUS, ccwEnd, cwEnd);
    ctx.stroke();
  }
  return { fillJustCompleted: fullyBuilt };
};

// concentric soundwave rings that radiate outward from the dot ring in time with the beat.
// A new wave is emitted every HOVER_WAVE_PERIOD_BEATS and lives for HOVER_WAVE_LIFETIME_BEATS,
// so consecutive waves overlap for a continuous radar-ping feel. The wave that fires at
// lock acquisition is brighter so lock still reads as a distinct moment.
// `lockAge` is seconds since the ring filled (≥0 when fully built).
const paintSoundwaves = (
  ctx: CanvasRenderingContext2D, center: Vec, lockAge: number, beatTime: number, beatGrid: number,
  fadeOutAlpha: number = 1, tierHsl: string = HOVER_FLARE_WARM_HSL, widthMult: number = 1,
) => {
  if (beatGrid <= 0) return;
  ctx.lineCap = "round";
  // waves emit on every PERIOD-th integer beat downbeat. Walk back from the most recent such
  // beat and draw any wave still within its lifetime window.
  const beatsSinceLock = lockAge / beatGrid;
  const currentBeat = Math.floor(beatTime / beatGrid);
  const mostRecentEmitBeat = currentBeat - ((currentBeat % HOVER_WAVE_PERIOD_BEATS) + HOVER_WAVE_PERIOD_BEATS) % HOVER_WAVE_PERIOD_BEATS;
  const maxOverlap = Math.ceil(HOVER_WAVE_LIFETIME_BEATS / HOVER_WAVE_PERIOD_BEATS) + 1;
  for (let back = 0; back < maxOverlap; back++) {
    const beatIndex = mostRecentEmitBeat - back * HOVER_WAVE_PERIOD_BEATS;
    const emitTime = beatIndex * beatGrid;
    const ageSec = beatTime - emitTime;
    if (ageSec < 0) continue;
    const ageBeats = ageSec / beatGrid;
    if (ageBeats > HOVER_WAVE_LIFETIME_BEATS) continue;
    // skip waves that would have been emitted before the lock — keeps the radiation tied
    // to the moment the player actually achieved hover.
    if (ageBeats > beatsSinceLock + 0.01) continue;
    const t = ageBeats / HOVER_WAVE_LIFETIME_BEATS;
    // higher tiers push the soundwaves out wider so the escalation reads at a glance.
    const r = HOVER_WAVE_START_R + (HOVER_WAVE_END_R - HOVER_WAVE_START_R) * t * widthMult;
    // fade-in over the first ~10% so a newly-emitted wave doesn't pop in too hard, then
    // fade out the rest of its life. Quadratic falloff feels like a soundwave dissipating.
    const fadeIn = Math.min(1, t / 0.1);
    const fadeOut = Math.pow(1 - t, 1.8);
    const envelope = fadeIn * fadeOut;
    // the first wave fired after lock is brighter so lock acquisition still reads as a
    // distinct beat. After one full emit period every wave settles to the steady look.
    const beatsBetweenWaveAndLock = beatsSinceLock - ageBeats;
    const isLockWave = beatsBetweenWaveAndLock >= 0 && beatsBetweenWaveAndLock < HOVER_WAVE_PERIOD_BEATS;
    const peakAlpha = isLockWave ? HOVER_LOCK_WAVE_PEAK_ALPHA : HOVER_WAVE_PEAK_ALPHA;
    const lineWidth = isLockWave ? HOVER_LOCK_WAVE_LINE_WIDTH : HOVER_WAVE_LINE_WIDTH;
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = `hsla(${tierHsl}, ${peakAlpha * envelope * fadeOutAlpha})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, TAU);
    ctx.stroke();
  }
};

// linear interp between two HSL strings of the form "H, S%, L%". Used to drift the ring colour
// from cyan to warm gold at the peak of the lock-in flare.
const lerpHsl = (a: string, b: string, t: number): string => {
  const pa = a.split(",").map((s) => parseFloat(s));
  const pb = b.split(",").map((s) => parseFloat(s));
  const h = pa[0] + (pb[0] - pa[0]) * t;
  const s = pa[1] + (pb[1] - pa[1]) * t;
  const l = pa[2] + (pb[2] - pa[2]) * t;
  return `${h}, ${s}%, ${l}%`;
};

// cosine envelope between min/max produces a smooth, predictable visual pulse over time.
const cosineEnvelope = (beatTime: number, period: number, min: number, max: number): number => {
  const v = 0.5 + 0.5 * Math.cos((beatTime / period) * TAU);
  return min + (max - min) * v;
};

// filled pointy triangle orbiting the reticule, pointing along `angle` toward the nearest rhythm
// dot. The tip sits past ARROW_ORBIT_RADIUS; the base spans ARROW_HALF_WIDTH on each side. On the
// downbeat it flashes brighter and shifts toward the Pulsar-logo blue, decaying fast over the
// beat. Painted under the caller's additive composite so the flash glows without shadowBlur.
const paintReticuleArrow = (
  ctx: CanvasRenderingContext2D, center: Vec, angle: number,
  beatTime: number, beatGrid: number, fade01: number,
) => {
  if (fade01 <= 0) return;
  // square-decay beat envelope: 1 on the downbeat, falling to 0 just before the next beat —
  // same shape the reticule's own beat pulse uses, so the flash lands with the rest of the sight.
  const phase = beatGrid > 0 ? ((beatTime % beatGrid) + beatGrid) % beatGrid / beatGrid : 0;
  const beat01 = (1 - phase) * (1 - phase);
  const alpha = (ARROW_REST_ALPHA + (ARROW_BEAT_ALPHA - ARROW_REST_ALPHA) * beat01) * fade01;
  const hsl = beat01 > 0 ? lerpHsl(ARROW_HSL_REST, ARROW_HSL_BEAT, beat01) : ARROW_HSL_REST;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // tip points outward along `angle`; the two base corners sit on the orbit circle either side.
  const tipX = center.x + cos * (ARROW_ORBIT_RADIUS + ARROW_LENGTH);
  const tipY = center.y + sin * (ARROW_ORBIT_RADIUS + ARROW_LENGTH);
  const baseX = center.x + cos * ARROW_ORBIT_RADIUS;
  const baseY = center.y + sin * ARROW_ORBIT_RADIUS;
  const px = -sin * ARROW_HALF_WIDTH;
  const py = cos * ARROW_HALF_WIDTH;
  ctx.fillStyle = `hsla(${hsl}, ${alpha})`;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + px, baseY + py);
  ctx.lineTo(baseX - px, baseY - py);
  ctx.closePath();
  ctx.fill();
};

// Tier-6 climax pulse — the FINAL drift tier reads as a radiant event rather than just a wider,
// whiter copy of the lower-tier ring. Three layered strokes ride the same per-beat expansion:
//   • a soft wide HALO trailing the leading edge (the afterglow that makes it feel "lit"),
//   • the incandescent white-gold LEADING ring (thick), and
//   • a pure-white hot CORE hairline just inside it for the bright filament look.
// A slow downbeat BLOOM lifts the whole thing brighter and slightly larger on the beat, so the
// final tier visibly breathes light in time with the music. Painted under the caller's additive
// composite, so overlapping the three strokes sums into a glow (no shadowBlur — house rule).
const paintFinalHoverPulse = (
  ctx: CanvasRenderingContext2D, center: Vec, phase: number, beatTime: number, beatGrid: number,
  fade01: number,
) => {
  const startR = HOVER_PULSE_START_R;
  const endR = startR + (HOVER_PULSE_END_R - startR) * driftTierWidthMult(DRIFT_TIER_MAX);
  // downbeat bloom: cosine swell peaking on the beat (1.0) and easing to a floor between beats,
  // so the radiance pulses with the song instead of sitting at a constant brightness.
  const bloom = cosineEnvelope(beatTime, beatGrid, 0.78, 1.0);
  const fadeIn = Math.min(1, phase / 0.12);
  const fadeOut = (1 - phase) * (1 - phase);
  const env = fadeIn * fadeOut * fade01 * bloom;
  const leadR = startR + (endR - startR) * phase;
  ctx.setLineDash([]);
  // 1) trailing halo — sits behind the leading edge, wide and soft, biggest contributor to the glow.
  const haloR = startR + (endR - startR) * Math.max(0, phase - HOVER_PULSE_FINAL_HALO_LAG);
  ctx.strokeStyle = `hsla(${HOVER_PULSE_FINAL_HSL}, ${0.35 * env})`;
  ctx.lineWidth = HOVER_PULSE_FINAL_HALO_WIDTH * (0.85 + 0.3 * bloom);
  ctx.beginPath();
  ctx.arc(center.x, center.y, haloR, 0, TAU);
  ctx.stroke();
  // 2) incandescent leading ring — the main bright body of the pulse.
  ctx.strokeStyle = `hsla(${HOVER_PULSE_FINAL_HSL}, ${HOVER_PULSE_FINAL_PEAK_ALPHA * env})`;
  ctx.lineWidth = HOVER_PULSE_FINAL_LINE_WIDTH * (0.9 + 0.25 * bloom);
  ctx.beginPath();
  ctx.arc(center.x, center.y, leadR, 0, TAU);
  ctx.stroke();
  // 3) pure-white hot-core hairline just inside the leading ring — the bright filament.
  ctx.strokeStyle = `hsla(${HOVER_PULSE_FINAL_CORE_HSL}, ${0.9 * env})`;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(center.x, center.y, leadR - HOVER_PULSE_FINAL_LINE_WIDTH * 0.6, 0, TAU);
  ctx.stroke();
};

// single ring expanding outward from the reticule, re-launched every beat — the lock-on pulse
// shown while the reticule sits on a rhythm dot (replacing the directional arrow). Phase rides
// the song grid so the pulse always lands on the beat. At the final drift tier the single ring
// is replaced by the layered radiant climax (paintFinalHoverPulse).
const paintHoverPulse = (
  ctx: CanvasRenderingContext2D, center: Vec, beatTime: number, beatGrid: number, fade01: number,
  tier: number = 0,
) => {
  if (fade01 <= 0 || beatGrid <= 0) return;
  const phase = ((beatTime % beatGrid) + beatGrid) % beatGrid / beatGrid;
  if (tier >= DRIFT_TIER_MAX) {
    paintFinalHoverPulse(ctx, center, phase, beatTime, beatGrid, fade01);
    return;
  }
  // white until the hold arms a drift shot (tier 0), then the tier hue tints the pulse gold →
  // cyan → magenta as the player holds deeper — so the pulse only reads warm once a drift shot
  // would actually trigger, matching the dot-ring arcs and soundwaves.
  const hsl = tier > 0 ? driftTierPulseHsl(tier) : HOVER_DOT_HSL_UNARMED;
  const widthMult = tier > 0 ? driftTierWidthMult(tier) : 1;
  const startR = HOVER_PULSE_START_R;
  const endR = startR + (HOVER_PULSE_END_R - startR) * widthMult;
  const r = startR + (endR - startR) * phase;
  // ease in over the first sliver so a freshly-launched ring doesn't pop, then fade as it expands.
  const fadeIn = Math.min(1, phase / 0.12);
  const fadeOut = (1 - phase) * (1 - phase);
  const alpha = HOVER_PULSE_PEAK_ALPHA * fadeIn * fadeOut * fade01;
  ctx.strokeStyle = `hsla(${hsl}, ${alpha})`;
  ctx.lineWidth = HOVER_PULSE_LINE_WIDTH;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(center.x, center.y, r, 0, TAU);
  ctx.stroke();
};

// crossfade the arrow ↔ hover-pulse toward their targets at a beatTime-derived rate so neither
// pops on hover toggle / target appearance. dt is clamped (paused frames or big jumps shouldn't
// snap the fade). Mutates the module-scoped fade accumulators.
let lastFadeBeatTime: number | null = null;
const stepReticuleGuidanceFades = (beatTime: number, arrowVisible: boolean, pulseVisible: boolean) => {
  const dt = lastFadeBeatTime === null ? 0 : Math.min(0.05, Math.max(0, beatTime - lastFadeBeatTime));
  lastFadeBeatTime = beatTime;
  const stepUp = ARROW_FADE_SEC > 0 ? dt / ARROW_FADE_SEC : 1;
  arrowFade01 = arrowVisible ? Math.min(1, arrowFade01 + stepUp) : Math.max(0, arrowFade01 - stepUp);
  hoverPulseFade01 = pulseVisible ? Math.min(1, hoverPulseFade01 + stepUp) : Math.max(0, hoverPulseFade01 - stepUp);
};

// hover hum: holds silent for DELAY (so a passing graze doesn't ping audio), then eases from
// 0 to 1 with a smoothstep so the entrance feels like a swell rising in rather than a switch
// flipping on. The two-stage release is handled inside Sound.stopFirstDotHum.
const HOVER_HUM_DELAY_SEC = 0.15;
const HOVER_HUM_RAMP_SEC = 2.5;

// single entry point — composes background, range arcs, trajectory previews, then aim discs in order.
export const renderShipReticules = (
  ship: Ship, state: ReticuleState,
  ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>, beatTime: number, doubletime: boolean,
  tutorialHighlight: boolean = false,
  sound: Sound | null = null,
  // beatTime here is the latency-shifted (perceived) clock that all the visuals ride.
  //   The hum's accent, by contrast, is *audio* and must land with the rest of the
  //   heard mix on the true grid, so the caller passes the raw clock separately.
  audioBeatTime: number = beatTime,
  superBoosted: boolean = false,
  // stationary "First Dot" probes (e.g. gold crystals). Trajectory walk skips speed<1
  // targets, so parked objects need a direct reticule-proximity pass.
  hoverProbes: ReadonlyArray<ReticuleHoverProbe> = [],
  // once-a-run targeting lesson; null whenever no hint is live (game/aimHint.ts).
  aimHint: AimHintRender | null = null,
) => {
  if (!ship.alive) return;
  // The bullet sight (circular aim disc + trajectory previews + drift-hover) has no
  // meaning under the laser, which fires a straight beam — gameRender draws the
  // laser's own dash-line reticule (renderLaserReticule) instead.
  if (ship.lasershotActive) return;
  const { positions: reticulePositions, primaryIndex, slotPositionIndices } = computeReticulePositions(ship, beatGrid, doubletime, superBoosted);
  // trajectory preview anchors on the "shoot now to hit next beat" spot. primaryIndex always
  // exists now (anchors on the first prong offset under prong), but keep the fallback for safety.
  const primaryReticule = primaryIndex >= 0
    ? reticulePositions[primaryIndex]
    : computeReticulePosition(ship, beatGrid, 0, 1);
  // each reachable slot may have multiple reticules (prong = 2 angles, centred = 1). The slot's
  // hover ring locks if the trajectory dot grazes ANY of them, so the player can drift-lock off
  // either prong.
  const reticulesBySlot: Vec[][] = slotPositionIndices.map(idxs => idxs.map(i => reticulePositions[i]));
  // grow the Ship's hover-ring array to match if range extended this frame; never shrink (so a
  // brief range loss doesn't wipe a partially-locked ring).
  while (state.hoverDotRings.length < slotPositionIndices.length) {
    state.hoverDotRings.push({ hoverStartBeatTime: null, completionBeatTime: null, zoneEnterBeatTime: null, fadeOutStartTime: null, lastRingCenter: null });
  }
  const apex = ship.pos;
  const collisionRadiusOnBeat = onBeatCollisionRadius(superBoosted);
  const { center: aimCircleCenter, radius: aimCircleRadius } = computeAimCircle(ship, beatGrid);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const hitboxPulse = cosineEnvelope(beatTime, RETICULE_HITBOX_PULSE_PERIOD_SEC, RETICULE_HITBOX_PULSE_MIN, RETICULE_HITBOX_PULSE_MAX);
  const radarPulse = cosineEnvelope(beatTime, RETICULE_RADAR_PULSE_PERIOD_SEC, RETICULE_RADAR_PULSE_MIN, RETICULE_RADAR_PULSE_MAX);
  const beatPulseBoost = computeBeatPulseBoost(beatTime, beatGrid);
  const cooldownDim = ship.fireCooldown > 0 ? RETICULE_COOLDOWN_DIM : 1;
  const baseHitAlpha = hitboxPulse * cooldownDim * beatPulseBoost;
  paintConeBackground(ctx, ship, apex, beatTime, beatGrid);
  paintRangeArcs(ctx, ship, apex, beatTime, radarPulse);
  const frame = computeConeFrame(ship);
  const trajectoryResult = paintTrajectoryPreviews({
    ctx, apex, beatGrid, beatTime, w, h, frame, reticulePos: primaryReticule,
    reticulesBySlot, aimCircleCenter, aimCircleRadius,
    trajectoryTracks: state.trajectoryTracks, doubletime, tutorialHighlight,
    hoverZoneEnterBySlot: state.hoverDotRings.map(r => r.zoneEnterBeatTime),
    collisionRadiusOnBeat, aimHint,
  }, targets);
  const fromTrajectory = trajectoryResult.overlapsReticule;
  // reverse map: position-index → slot number (1-indexed). Every reticule that belongs to a slot
  // tags as that slot so the aim disc renders the right tick length on each prong.
  const slotByPosIndex = new Array<number>(reticulePositions.length).fill(-1);
  for (let s = 0; s < slotPositionIndices.length; s++) {
    for (const idx of slotPositionIndices[s]) slotByPosIndex[idx] = s + 1;
  }
  for (let i = 0; i < reticulePositions.length; i++) {
    const pos = reticulePositions[i];
    const onFirstBeatDot = fromTrajectory && i === primaryIndex;
    // overlap test on the RAW position (toroidal-correct); only the draw folds.
    const overlaps = onFirstBeatDot
      ? true
      : reticuleOverlapsAnyTarget(pos, targets, w, h);
    const slot = slotByPosIndex[i];
    paintAimDiscs(ctx, wrapReticuleVec(pos, w, h), baseHitAlpha, overlaps, onFirstBeatDot, tutorialHighlight, slot);
    if (ship.bombActive && slot === 1) paintBombBlastPreview(ctx, wrapReticuleVec(pos, w, h), baseHitAlpha);
  }
  // each slot's ring uses the softer proximity halo (>0 anywhere in the dot glow ramp) so the
  // player gets feedback the moment the reticule grazes the visible circle, not just on strict
  // hit. Per-slot rings are independent; audio is collapsed into one voice that follows the
  // strongest hover and stays locked as long as ANY ring is locked. Under prong, the ring
  // renders at whichever prong reticule the trajectory dot is closest to (the winner).
  // three escalating tiers of feedback as the reticule closes in on a dot:
  //   zoneIntensity (75px approach zone) → soft outer C4 hum + contracting approach ring
  //   anyHover (tight target area)       → octave-up C5 hum + the dashed lock ring begins filling
  //   anyLocked (ring finished filling)  → the perfect-fifth G4 hum joins
  // probe pass: fold each stationary probe's reticule-proximity into the same per-slot
  // arrays the trajectory walk produced, so a parked gem drives the same lock + hum stack.
  const probeMerged = mergeProbeProximities(
    trajectoryResult, hoverProbes, reticulesBySlot, w, h,
  );
  let zoneIntensity = 0;
  let anyHover = false;
  let anyLocked = false;
  // highest drift tier among locked rings this frame — drives the live pulse colour/width and
  // the tier-2/3 hum layering, so what the player sees and hears tracks their current hold depth.
  let maxLiveTier = 0;
  for (let slot = 0; slot < slotPositionIndices.length; slot++) {
    const proximity = probeMerged.slotProximities[slot] ?? 0;
    const within75 = probeMerged.slotWithin75[slot] ?? false;
    const winnerIdx = probeMerged.slotWinnerReticuleIdx[slot] ?? -1;
    const positionIdxs = slotPositionIndices[slot];
    const ringPosIdx = winnerIdx >= 0 && winnerIdx < positionIdxs.length ? positionIdxs[winnerIdx] : -1;
    const ringState = state.hoverDotRings[slot];
    // stamp the zone-entry beat on the rising edge so the approach ring launches on a clean beat;
    // clear it the moment the reticule leaves the zone so re-entry re-arms a fresh contraction.
    if (within75) {
      if (ringState.zoneEnterBeatTime === null) ringState.zoneEnterBeatTime = beatTime;
    } else {
      ringState.zoneEnterBeatTime = null;
    }
    if (ringState.zoneEnterBeatTime !== null) {
      zoneIntensity = Math.max(zoneIntensity, hoverSwell(beatTime - ringState.zoneEnterBeatTime));
    }
    const hovering = proximity > 0 && ringPosIdx >= 0;
    // The hover-lock STATE MACHINE now runs in the sim (tickHoverLockState) so it's deterministic
    //   for replay; render only PAINTS the ring from the state the sim already set this frame.
    paintHoverRingFromState(ringState, ctx, beatTime, beatGrid, w, h);
    if (hovering) anyHover = true;
    if (ringState.completionBeatTime !== null) {
      anyLocked = true;
      maxLiveTier = Math.max(maxLiveTier, driftTierForRing(ringState, beatTime));
    }
  }
  expireHoverZoneHintIfHoverEnded(state.hoverDotRings.map(r => r.zoneEnterBeatTime), beatTime);
  paintHoverZoneHint(ctx, beatTime);
  paintDriftLockHint(ctx, beatTime);
  if (sound) {
    const beatPhase01 = ((audioBeatTime % beatGrid) + beatGrid) % beatGrid / beatGrid;
    if (zoneIntensity > 0) sound.updateFirstDotHum(zoneIntensity, beatPhase01, beatGrid);
    else sound.updateFirstDotHum(0);
    if (anyHover) sound.updateFirstDotOctaveHum(beatPhase01, beatGrid);
    else sound.stopFirstDotOctaveHum();
    if (anyLocked) sound.updateFirstDotLockHum(beatPhase01, beatGrid);
    else sound.stopFirstDotLockHum();
    // major-third harmony joins only while the drift shot is enabled (ring locked) AND the
    // reticule is still in the tight hover radius — it drops the instant either gate opens.
    if (anyLocked && anyHover) sound.updateFirstDotHarmonyHum(beatPhase01, beatGrid);
    else sound.stopFirstDotHarmonyHum();
    // each tier layers a fresh chord tone so the stack RESOLVES as the player holds deeper:
    //   t2 sub root C3, t3 bright fifth G5, t4 major-9th D5 (→ Cadd9), t5 major-third E5 (→ full
    //   bright C-major), t6 deep-root C2 (grounds the spread an octave below the sub root). Gated on
    //   the live tier + still hovering, so they fade the moment the reticule slips off.
    if (anyHover && maxLiveTier >= 2) sound.updateFirstDotSubHum(beatPhase01, beatGrid);
    else sound.stopFirstDotSubHum();
    if (anyHover && maxLiveTier >= 3) sound.updateFirstDotShimmerHum(beatPhase01, beatGrid);
    else sound.stopFirstDotShimmerHum();
    if (anyHover && maxLiveTier >= 4) sound.updateFirstDotNinthHum(beatPhase01, beatGrid);
    else sound.stopFirstDotNinthHum();
    if (anyHover && maxLiveTier >= 5) sound.updateFirstDotSixthHum(beatPhase01, beatGrid);
    else sound.stopFirstDotSixthHum();
    if (anyHover && maxLiveTier >= 6) sound.updateFirstDotHaloHum(beatPhase01, beatGrid);
    else sound.stopFirstDotHaloHum();
  }
  // guidance overlay on the player's reticule: a chevron pointing at the nearest first-beat
  // rhythm dot, which swaps for an expanding lock pulse the moment the reticule grazes a dot.
  // anyHover is the same "reticule is on a dot" signal that drives the octave hum, so the
  // visual and audio cues flip together.
  const nearestDot = anyHover
    ? null
    : nearestFirstBeatDot(apex, frame, w, h, beatGrid, aimCircleCenter, primaryReticule, targets, collisionRadiusOnBeat);
  stepReticuleGuidanceFades(beatTime, !anyHover && nearestDot !== null, anyHover);
  if (nearestDot !== null) {
    // angle from RAW positions (both in apex space); only the draw anchor folds.
    lastArrowAngle = Math.atan2(nearestDot.y - primaryReticule.y, nearestDot.x - primaryReticule.x);
  }
  const primaryReticuleDraw = wrapReticuleVec(primaryReticule, w, h);
  if (ARROW_ENABLED && arrowFade01 > 0) {
    paintReticuleArrow(ctx, primaryReticuleDraw, lastArrowAngle, beatTime, beatGrid, arrowFade01);
  }
  paintHoverPulse(ctx, primaryReticuleDraw, beatTime, beatGrid, hoverPulseFade01, maxLiveTier);
  ctx.restore();
};

// SIM-side hover-lock tick (the determinism fix). Runs the SAME geometry as renderShipReticules
//   (reticule positions + trajectory-walk proximity + probe merge) but COMPUTE-ONLY (ctx=null), then
//   drives the per-slot hover-lock state machine (hoverStartBeatTime/completionBeatTime). Render no
//   longer owns that state — it paints from it. Called every frame from updatePlaying so drift-shot
//   eligibility (which reads completionBeatTime) is deterministic and reproduces in the muted replay
//   re-sim. `emit` true on live, false on replay (replay plays the recorded lock hum, doesn't re-fire).
//   Mutates only the hoverDotRings state machine fields (NOT zoneEnterBeatTime — that's a render-only
//   approach-ring visual). Uses a throwaway trajectoryTracks map so the fade-ghost cache stays render-owned.
export const tickHoverLockState = (
  ship: Ship, state: ReticuleState,
  beatGrid: number, w: number, h: number,
  targets: ReadonlyArray<ReticuleTarget>, beatTime: number, doubletime: boolean,
  superBoosted: boolean, hoverProbes: ReadonlyArray<ReticuleHoverProbe>,
  sound: Sound | null, emit: boolean,
): void => {
  if (!ship.alive) return;
  const { positions: reticulePositions, slotPositionIndices } = computeReticulePositions(ship, beatGrid, doubletime, superBoosted);
  while (state.hoverDotRings.length < slotPositionIndices.length) {
    state.hoverDotRings.push({ hoverStartBeatTime: null, completionBeatTime: null, zoneEnterBeatTime: null, fadeOutStartTime: null, lastRingCenter: null });
  }
  const apex = ship.pos;
  const collisionRadiusOnBeat = onBeatCollisionRadius(superBoosted);
  const primaryReticule = reticulePositions.length > 0 ? reticulePositions[0] : apex;
  const { center: aimCircleCenter, radius: aimCircleRadius } = computeAimCircle(ship, beatGrid);
  const frame = computeConeFrame(ship);
  const reticulesBySlot: Vec[][] = slotPositionIndices.map(idxs => idxs.map(i => reticulePositions[i]));
  // ctx: null → compute-only. Throwaway tracks map so refreshTrack's mutations don't touch the
  //   render-owned fade-ghost cache.
  const trajectoryResult = paintTrajectoryPreviews({
    ctx: null, apex, beatGrid, beatTime, w, h, frame, reticulePos: primaryReticule,
    reticulesBySlot, aimCircleCenter, aimCircleRadius,
    trajectoryTracks: new Map(), doubletime, tutorialHighlight: false,
    hoverZoneEnterBySlot: state.hoverDotRings.map(r => r.zoneEnterBeatTime),
    collisionRadiusOnBeat,
  }, targets);
  const probeMerged = mergeProbeProximities(trajectoryResult, hoverProbes, reticulesBySlot, w, h);
  for (let slot = 0; slot < slotPositionIndices.length; slot++) {
    const proximity = probeMerged.slotProximities[slot] ?? 0;
    const winnerIdx = probeMerged.slotWinnerReticuleIdx[slot] ?? -1;
    const positionIdxs = slotPositionIndices[slot];
    const ringPosIdx = winnerIdx >= 0 && winnerIdx < positionIdxs.length ? positionIdxs[winnerIdx] : -1;
    const ringState = state.hoverDotRings[slot];
    const hovering = proximity > 0 && ringPosIdx >= 0;
    const center = hovering ? reticulePositions[ringPosIdx] : null;
    updateHoverRing(ringState, hovering, center, beatTime, beatGrid, sound, emit);
  }
};

// smoothstep proximity ramp from "touching the probe" (1) out to PROBE_PROXIMITY_PAD past it (0).
// Mirrors firstDotProximity01 in trajectoryPreview, but uses the probe's own radius so the lock
// fires when the reticule grazes the visible gem rather than a fixed dot-size budget.
const probeProximity01 = (retX: number, retY: number, px: number, py: number, probeRadius: number): number => {
  const dx = px - retX;
  const dy = py - retY;
  const dist = Math.hypot(dx, dy);
  const overlapDist = BULLET_SIGHT_RADIUS_ON_BEAT + probeRadius;
  if (dist <= overlapDist) return 1;
  const outerDist = overlapDist + PROBE_PROXIMITY_PAD;
  if (dist >= outerDist) return 0;
  const t = 1 - (dist - overlapDist) / PROBE_PROXIMITY_PAD;
  return t * t * (3 - 2 * t);
};

// merge probe contributions into the trajectory result's per-slot proximity/zone/winner arrays.
// Each probe is tested against every reticule of every slot; the maximum proximity wins. Uses
// toroidalDelta so probes near the wrapped edge still register against the corresponding reticule.
const mergeProbeProximities = (
  base: { slotProximities: number[]; slotWithin75: boolean[]; slotWinnerReticuleIdx: number[] },
  probes: ReadonlyArray<ReticuleHoverProbe>,
  reticulesBySlot: Vec[][],
  w: number, h: number,
): { slotProximities: number[]; slotWithin75: boolean[]; slotWinnerReticuleIdx: number[] } => {
  if (probes.length === 0) return base;
  const slotCount = reticulesBySlot.length;
  const slotProximities = base.slotProximities.slice();
  const slotWithin75 = base.slotWithin75.slice();
  const slotWinnerReticuleIdx = base.slotWinnerReticuleIdx.slice();
  for (let slot = 0; slot < slotCount; slot++) {
    const reticules = reticulesBySlot[slot];
    if (reticules.length === 0) continue;
    for (let r = 0; r < reticules.length; r++) {
      const ret = reticules[r];
      for (const probe of probes) {
        const [dx, dy] = toroidalDelta(probe.pos.x - ret.x, probe.pos.y - ret.y, w, h);
        const px = ret.x + dx;
        const py = ret.y + dy;
        const proximity = probeProximity01(ret.x, ret.y, px, py, probe.radius);
        if (proximity > slotProximities[slot]) {
          slotProximities[slot] = proximity;
          slotWinnerReticuleIdx[slot] = r;
        }
        const zoneEdge = PROBE_ZONE_RADIUS + probe.radius;
        if (dx * dx + dy * dy <= zoneEdge * zoneEdge) slotWithin75[slot] = true;
      }
    }
  }
  return { slotProximities, slotWithin75, slotWinnerReticuleIdx };
};

// soft swell 0→1 from time-in-zone: holds silent for DELAY (so a passing graze doesn't ping),
// then smoothsteps in over RAMP. Drives the outer C4 hum's gain off the 75px approach zone.
const hoverSwell = (elapsed: number): number => {
  const afterDelay = Math.max(0, elapsed - HOVER_HUM_DELAY_SEC);
  const swellLinear = Math.min(1, afterDelay / HOVER_HUM_RAMP_SEC);
  return swellLinear * swellLinear * (3 - 2 * swellLinear);
};

// snap forward to the next song-grid boundary. Used to defer the lock-cue trigger so the
// lock flare/hum/wave land on a downbeat instead of whenever the fill mechanically finished.
const snapToNextBeat = (beatTime: number, beatGrid: number): number => {
  if (beatGrid <= 0) return beatTime;
  return Math.ceil(beatTime / beatGrid) * beatGrid;
};

// snap backward to the previous quarter-of-a-beat tick. Used as the fill animation's anchor
// so each arc-tick is phase-aligned to a fine sub-beat grid without causing more than a tiny
// visible "pre-fill jump" when hover starts mid-beat (worst case ~2 arcs at quarter snap).
const HOVER_FILL_SNAP_FRACTION = 1 / 4;
const snapToPrevSubBeat = (beatTime: number, beatGrid: number): number => {
  if (beatGrid <= 0) return beatTime;
  const step = beatGrid * HOVER_FILL_SNAP_FRACTION;
  return Math.floor(beatTime / step) * step;
};

// The hover-lock STATE MACHINE — drives the dashed clockwise fill's lifecycle and stamps
//   completionBeatTime (+ hoverStartBeatTime). The SIM owns it (runs every frame via
//   tickHoverLockState), because completionBeatTime gates drift-shot eligibility (+1 combo) — a
//   gameplay outcome that must be deterministic and reproduce in the muted replay re-sim. It does
//   NOT paint; render draws the ring from this state via paintHoverRingFromState.
//     emit — true only on the LIVE pass: fires the lock hum + drift-lock hint on the lock edge.
//            Replay passes false (it plays the recorded audio stream, doesn't re-emit).
//   Transitions are pure fns of (hovering, ringCenter, beatTime).
const updateHoverRing = (
  ring: { hoverStartBeatTime: number | null; completionBeatTime: number | null; fadeOutStartTime: number | null; lastRingCenter: Vec | null },
  hovering: boolean, ringCenter: Vec | null,
  beatTime: number, beatGrid: number, sound: Sound | null,
  emit: boolean,
): void => {
  // start fade-out if we were hovering and now we're not
  if (!hovering && ring.hoverStartBeatTime !== null && ring.fadeOutStartTime === null) {
    ring.fadeOutStartTime = beatTime;
  }

  // handle fade-out animation (the fade timing lives here; render paints it from state)
  if (ring.fadeOutStartTime !== null) {
    const fadeT = Math.min(1, (beatTime - ring.fadeOutStartTime) / HOVER_DOT_FADEOUT_SEC);
    if (fadeT >= 1) {
      ring.hoverStartBeatTime = null;
      ring.completionBeatTime = null;
      ring.fadeOutStartTime = null;
      ring.lastRingCenter = null;
    }
    return;
  }

  if (!hovering || ringCenter === null) {
    ring.hoverStartBeatTime = null;
    ring.completionBeatTime = null;
    ring.lastRingCenter = null;
    return;
  }

  ring.lastRingCenter = ringCenter;

  if (ring.hoverStartBeatTime === null) {
    // anchor the fill's internal clock to the previous quarter-of-a-beat tick so each arc-tick
    // is phase-aligned to the song's sub-beat grid. Snapping backward (vs forward) avoids any
    // draw delay; using a 1/4-beat fraction keeps the "pre-fill jump" to at most ~2 arcs.
    ring.hoverStartBeatTime = snapToPrevSubBeat(beatTime, beatGrid);
    ring.completionBeatTime = null;
  }
  const elapsed = beatTime - ring.hoverStartBeatTime;
  const fillJustCompleted = hoverRingFullyBuilt(elapsed);
  if (fillJustCompleted && ring.completionBeatTime === null) {
    // defer the lock cue (flare + hum + bright wave) to the next beat boundary so it lands
    // on-grid even if the fill mechanically finished mid-beat. With the back-snap above the
    // fill *should* already complete on a beat, but this is a guard against subgrid drift.
    ring.completionBeatTime = snapToNextBeat(beatTime, beatGrid);
    // Lock-cue audio + hint fire on the LIVE sim pass (emit=true); replay (emit=false) plays the
    //   recorded audio stream and must not re-emit. The drift-lock hint is live-UX only.
    if (emit) {
      if (sound) sound.startFirstDotLockHum();
      tryClaimDriftLockHint(ringCenter, beatTime);
    }
  }
};

// Paint the hover-lock ring purely from the state the SIM's updateHoverRing already set this
//   frame — render no longer runs the state machine (that's sim-owned for determinism). Mirrors
//   the two paint branches of updateHoverRing (fade-out vs active fill) using only ring state.
const paintHoverRingFromState = (
  ring: { hoverStartBeatTime: number | null; completionBeatTime: number | null; fadeOutStartTime: number | null; lastRingCenter: Vec | null },
  ctx: CanvasRenderingContext2D, beatTime: number, beatGrid: number, w: number, h: number,
): void => {
  // lastRingCenter is stored in raw apex space (sim-owned); fold it for the draw.
  if (ring.fadeOutStartTime !== null) {
    if (ring.lastRingCenter !== null && ring.hoverStartBeatTime !== null) {
      const fadeT = Math.min(1, (beatTime - ring.fadeOutStartTime) / HOVER_DOT_FADEOUT_SEC);
      const elapsed = beatTime - ring.hoverStartBeatTime;
      paintHoverDotRing(ctx, wrapReticuleVec(ring.lastRingCenter, w, h), elapsed, beatTime, beatGrid, 1 - fadeT);
    }
    return;
  }
  if (ring.hoverStartBeatTime !== null && ring.lastRingCenter !== null) {
    const elapsed = beatTime - ring.hoverStartBeatTime;
    paintHoverDotRing(ctx, wrapReticuleVec(ring.lastRingCenter, w, h), elapsed, beatTime, beatGrid);
  }
};
