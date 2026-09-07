import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import { Vec, toroidalDelta } from "../vec";
import type { AimHintRender } from "../ship/reticule/trajectoryPreview";
import { COMBO_LOST_POPUP_LIFE, AIM_HINT_LIFE_MUL, popupAimHint } from "./popups";

// A player who presses in time but keeps connecting off-beat has the rhythm and is
// missing the *lead*: they're shooting at the rock instead of at the reticule that
// marks where the rock will be on the next beat. Telling them "didn't hit on beat"
// again doesn't name that gap, so once per run we swap that popup for a pulse
// drawn around the reticule itself plus the two-line correction beside it.
//
// Timing: after five such misses the pattern is established; a miss that breaks a
// streak of 2+ proves they can already do it, so that lands the lesson sooner.
const MISSES_BEFORE_HINT = 5;
const RHYTHM_FOR_EARLY_HINT = 2;
export const AIM_HINT_DURATION = COMBO_LOST_POPUP_LIFE * AIM_HINT_LIFE_MUL;
// how stale a target's radar track may be and still count as "on screen right now".
const RADAR_CONTACT_FRESH_SEC = 0.25;

export type AimHint = {
  target: Asteroid;
  // the reticule renderer rewrites this each frame with the target's on-rhythm aim
  //   spot; the popup follows it, so the text tracks the thing it's pointing at.
  anchor: { pos: Vec };
  elapsed: number;
  duration: number;
};

// The trajectory preview skips near-stationary targets, so a parked rock has no reticule for
//   the pulse to bloom around — leave the hint unspent and let a later miss find a live one.
const isLockable = (a: Asteroid): boolean =>
  !a.isDormantSilhouette() && !a.isPhasedOut() && Math.hypot(a.vel.x, a.vel.y) >= 1;

const distanceTo = (game: Game, from: Vec, a: Asteroid): number => {
  const [dx, dy] = toroidalDelta(a.pos.x - from.x, a.pos.y - from.y, game.w, game.h);
  return Math.hypot(dx, dy);
};

const nearestTo = (game: Game, from: Vec, candidates: Asteroid[]): Asteroid | null => {
  let best: Asteroid | null = null;
  let bestDist = Infinity;
  for (const a of candidates) {
    const d = distanceTo(game, from, a);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
};

// Prefer a rock the radar is already drawing — the lesson lands hardest on a reticule
//   the player can see right now. With nothing in the cone, fall back to whatever sits
//   closest to where the shot actually landed; the renderer fades that one's preview in.
const pickHintTarget = (game: Game, hitPos: Vec): Asteroid | null => {
  const lockable = game.asteroids.filter(isLockable);
  const onRadar = lockable.filter((a) => {
    const age = game.ship.secondsSinceRadarContact(a, game.perceivedBeatTime);
    return age !== null && age <= RADAR_CONTACT_FRESH_SEC;
  });
  if (onRadar.length > 0) return nearestTo(game, game.ship.pos, onRadar);
  return nearestTo(game, hitPos, lockable);
};

const startAimHint = (game: Game, target: Asteroid) => {
  const anchor = { pos: { x: target.pos.x, y: target.pos.y } };
  game.aimHint = { target, anchor, elapsed: 0, duration: AIM_HINT_DURATION };
  game.aimHintShown = true;
  game.popups.push(popupAimHint(anchor, target.radius));
};

// Called for every hit that was fired inside the beat window but landed outside it.
//   Sets aimHintSuppressLossPopup when it takes over, so the combo-loss path skips the
//   text this replaces. The flag is cleared by the caller before each judgement.
export const registerFiredOnBeatMiss = (game: Game, hitPos: Vec) => {
  if (game.aimHintShown) return;
  game.firedOnBeatMissCount += 1;
  const earned = game.firedOnBeatMissCount >= MISSES_BEFORE_HINT || game.beatCombo >= RHYTHM_FOR_EARLY_HINT;
  if (!earned) return;
  // the wave-1 tutorial owns the screen while a stage is up; let a later miss carry it.
  if (game.firstWaveHintStage !== 0) return;
  const target = pickHintTarget(game, hitPos);
  if (!target) return;
  startAimHint(game, target);
  game.aimHintSuppressLossPopup = true;
};

// render-side view of the hint: the reticule renderer keys off the target object itself
//   and writes the live reticule position back into the shared anchor.
export const aimHintRender = (game: Game): AimHintRender | null => {
  const hint = game.aimHint;
  if (!hint) return null;
  return { key: hint.target, anchor: hint.anchor, elapsed: hint.elapsed, duration: hint.duration };
};

export const updateAimHint = (game: Game, dt: number) => {
  const hint = game.aimHint;
  if (!hint) return;
  hint.elapsed += dt;
  // the popup keeps fading on its own timer; only the pulse needs a live rock.
  if (hint.elapsed >= hint.duration || !game.asteroids.includes(hint.target)) game.aimHint = null;
};

export const resetAimHint = (game: Game) => {
  game.aimHint = null;
  game.aimHintShown = false;
  game.aimHintSuppressLossPopup = false;
  game.firedOnBeatMissCount = 0;
};
