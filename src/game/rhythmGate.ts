import type { Game } from "../Game";
import { Vec } from "../vec";
import { BEAT_GRID, BEAT_WINDOW, DEBUG_BEAT_TIMING } from "./rhythmConstants";
import { syncComboHud } from "./hud";
import { popupBeatDebug, popupComboLost } from "./popups";
import { resetStreak } from "./streakBurst";

export const beatWindow = (_game: Game): number => {
  return BEAT_WINDOW;
};

// pure predicate — classifies fire / hit as on-beat without side effects on combo state.
export const isInBeatWindow = (game: Game, time: number): boolean => {
  const grid = BEAT_GRID;
  const beatIndex = Math.round(time / grid);
  const beatCenter = beatIndex * grid;
  return Math.abs(time - beatCenter) <= beatWindow(game);
};

// debug logging needs the signed offset even when the event sits outside the on-beat window.
export const beatOffsetFor = (_game: Game, time: number): number => {
  const grid = BEAT_GRID;
  const beatIndex = Math.round(time / grid);
  return time - beatIndex * grid;
};

// 0 → snap to 1 at the beat → squared release. No ramp-up — the onset is the visual hit.
const beatPulseEnvelope = (normalized: number): number => {
  if (normalized < 0 || normalized > 1) return 0;
  return (1 - normalized) * (1 - normalized);
};

// ship's visual pulse is a literal preview of the rhythm window so the player can time shots.
//   Reads perceivedBeatTime so the pulse peaks on the beat the player *hears* (latency-shifted),
//   matching the judged window rather than the raw audio grid.
export const currentBeatPulse = (game: Game): number => {
  if (game.state !== "playing" && game.state !== "dying") return 0;
  const grid = BEAT_GRID;
  const beatPhase = game.perceivedBeatTime / grid;
  const signedBeatsFromNearestBeat = beatPhase - Math.round(beatPhase);
  const windowFractionOfGrid = beatWindow(game) / grid;
  return beatPulseEnvelope(signedBeatsFromNearestBeat / windowFractionOfGrid);
};

// every wave body flashes brighter the instant the beat lands, then tapers over ~100ms.
//   Keyed to perceivedBeatTime so the flash peaks on the beat the player *hears*. Unlike
//   currentBeatPulse this isn't gated to the judge window — it's pure decoration on each beat,
//   so the taper is a fixed wall-clock 100ms rather than a fraction of the beat slot.
const BEAT_FLASH_DECAY = 0.1;
export const currentBeatFlash = (game: Game): number => {
  if (game.state !== "playing" && game.state !== "dying") return 0;
  const grid = BEAT_GRID;
  const beatPhase = game.perceivedBeatTime / grid;
  const secondsSinceBeat = (beatPhase - Math.floor(beatPhase)) * grid;
  if (secondsSinceBeat >= BEAT_FLASH_DECAY) return 0;
  const normalized = 1 - secondsSinceBeat / BEAT_FLASH_DECAY;
  return normalized * normalized;
};

// dev-only timing log, gated on DEBUG_BEAT_TIMING so it costs nothing in production.
export const logBeatEvent = (game: Game, kind: string, time: number, extra?: string) => {
  if (!DEBUG_BEAT_TIMING) return;
  const offset = beatOffsetFor(game, time);
  const offsetMs = (offset * 1000).toFixed(1);
  const within = isInBeatWindow(game, time) ? "ON" : "OFF";
  const beatTimeStr = time.toFixed(4);
  console.log(kind.toLowerCase(), within);
  console.log(beatTimeStr, offsetMs, extra ?? "");
};

// wraps the DEBUG_BEAT_TIMING gate so callers don't thread it through every fire/hit site.
export const spawnBeatDebugPopup = (game: Game, pos: Vec, time: number, prefix: string) => {
  if (!DEBUG_BEAT_TIMING) return;
  const onBeat = isInBeatWindow(game, time);
  const offsetMs = (beatOffsetFor(game, time) * 1000).toFixed(0);
  game.popups.push(popupBeatDebug(pos, prefix, onBeat, offsetMs));
};

// only meaningful losses (combo ≥2 → 0) fire wrrr + red halo; primed-only loss is too noisy.
//   sourcePos anchors the popup at whatever caused the break (ship fire / target hit).
export const loseCombo = (game: Game, sourcePos?: Vec, reason: "fire" | "hit" = "fire") => {
  if (game.beatCombo === 0) return;
  const prev = game.beatCombo;
  const wasMeaningful = prev >= 2;
  const haloActive = game.ship.comboHaloTier >= 2;
  // Reaching the 32x cap is a real achievement — a single off-beat doesn't wipe it,
  // it drops back to the 4x halo tier so the player keeps the yellow halo and music bed.
  game.beatCombo = prev >= 32 ? 4 : 0;
  // a post-loss hit must not pair with a pre-loss one for Rapid Rhythm / Twin Shot.
  //   Set inline (no rhythmBonus.ts import) to avoid an import cycle.
  game.lastRhythmHitBeatCenter = -1;
  game.rhythmHitsThisBeat = 0;
  game.lastRhythmHitPos = null;
  // a broken combo also ends any same-interval streak — the ring clears.
  resetStreak(game);
  if (wasMeaningful) {
    // sharper sour wrrr for a mistimed press, deflating wrrr for an off-beat hit.
    game.sound.play(reason === "fire" ? "comboLostFire" : "comboLost");
    game.ship.comboLossFlash = 1;
    // aimHint.ts has already taken over this miss with its own pulse + correction text.
    if (sourcePos && !game.aimHintSuppressLossPopup && (!game.hasLostComboEver || haloActive)) {
      // the hit was judged against perceivedBeatTime at the moment of impact (see
      //   collisions.ts), so the signed offset here is the same one the gate rejected:
      //   before the beat = too early, after it = too late. Only hits show it.
      const offset = beatOffsetFor(game, game.perceivedBeatTime);
      const halfWindow = beatWindow(game);
      const timing = offset < -halfWindow ? "early" : offset > halfWindow ? "late" : undefined;
      game.popups.push(popupComboLost(sourcePos, reason, timing));
    }
    // Show the "fire and hit on the beat to gain rhythm" hint once per game,
    // on the first meaningful loss outside the tutorial. The tutorial's own
    // FirstWaveHint owns the screen while a stage is up, so suppress then.
    // killEffects fires `rhythm-loss-hint:dismiss` on the next on-beat hit.
    if (!game.hasLostComboEver && game.firstWaveHintStage === 0 && !game.aimHintSuppressLossPopup) {
      // If the start-of-run controls pane is still up, defer the hint instead
      //   of stacking it on top — dismissControlsHint fires it once the pane
      //   fades (all controls used, or Wave 1 ends first).
      if (game.controlsHintActive) game.rhythmLossHintPending = true;
      else window.dispatchEvent(new CustomEvent("rhythm-loss-hint:show"));
    }
    game.hasLostComboEver = true;
  }
  rebaseBeatEval(game);
  syncComboHud(game);
  // build-to-4x diamond row mirrors live rhythm; an off-beat fire wipes both.
  //   Dispatched inline (no lifecycle.ts import) to avoid the cycle between
  //   rhythmGate.ts and lifecycle.ts.
  if (game.firstWaveHintStage === 5) {
    window.dispatchEvent(new CustomEvent("first-wave-hint:rhythmProgress", { detail: { count: 0 } }));
  }
};

// Off-beat fires now drop the combo immediately (registerOffBeatFire), so the
// latch stays false and the loss branch below is a dormant backstop. This still
// marches nextBeatToEvaluate so rebaseBeatEval keeps a valid index.
export const evaluateClosedBeats = (game: Game) => {
  const grid = BEAT_GRID;
  const window = beatWindow(game);
  while (game.nextBeatToEvaluate * grid + window <= game.perceivedBeatTime) {
    if (game.firedOffBeatSinceLastBeat && game.beatCombo !== 0) loseCombo(game, game.ship.pos);
    game.firedOffBeatSinceLastBeat = false;
    game.nextBeatToEvaluate += 1;
  }
};

// resyncs the evaluator index to now, so it neither stalls nor fires a burst of phantom closures.
export const rebaseBeatEval = (game: Game) => {
  game.nextBeatToEvaluate = Math.max(0, Math.floor((game.perceivedBeatTime - beatWindow(game)) / BEAT_GRID) + 1);
};
