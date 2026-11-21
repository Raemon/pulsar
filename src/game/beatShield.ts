import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import { isBeatShieldKind } from "../Asteroid";
import { Vec, toroidalDelta } from "../vec";
import { beatOffsetFor, beatWindow } from "./rhythmGate";
import { emitBounceSparks } from "./particleBursts";

// The beat-shield crystal's shield is down exactly when the rhythm gate's own
// on-beat window is open (rhythmGate.isInBeatWindow on perceivedBeatTime), so
// the shield opens and closes on the same beat the player hears and is judged on.

// Signed distance from the nearest beat in window half-widths: −1 as the window
// opens, 0 on the beat, +1 as it closes; |x| > 1 while the shield is up.
export const beatShieldPhase = (game: Game, time: number = game.perceivedBeatTime): number =>
  beatOffsetFor(game, time) / beatWindow(game);

// Copies the shield state onto every beat-shield crystal for render(), which
// has no Game. Runs right after beatTime advances (bassClock.tickBassBeats).
export const tickBeatShields = (game: Game) => {
  for (const a of game.asteroids) {
    if (!isBeatShieldKind(a.kind)) continue;
    a.beatShieldPhase = beatShieldPhase(game);
  }
};

// Feedback for a hit the shield ate (strikes, ram, alien fire — bullets go
// through collisions.deflectBulletOff): the same glance flash, tink and spark
// spray an armour-blocked hit gets, and no damage or knockback.
export const pingBeatShield = (game: Game, a: Asteroid, hitPos: Vec) => {
  let [nx, ny] = toroidalDelta(hitPos.x - a.pos.x, hitPos.y - a.pos.y, game.w, game.h);
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  a.flashAmount = Math.max(a.flashAmount, 0.5);
  game.sound.play("tink", 0.7, a.pos);
  emitBounceSparks(game.particles, hitPos, { x: nx, y: ny }, a.hue, 0.5);
};
