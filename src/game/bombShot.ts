import type { Game } from "../Game";
import { Bullet, BOMB_BLAST_RADIUS } from "../Bullet";
import { toroidalDelta } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { isInBeatWindow } from "./rhythmGate";
import { registerOnBeatFire, registerOffBeatFire } from "./gameUpdate";
import { isLiveBomb } from "../ship/shipWeapons";
import { applyStrikes, strikeShot, strikeTargets, StrikeTarget } from "./weaponStrike";
import { emitBounceSparks, emitBombBlast } from "./particleBursts";

// The Bomb upgrade turns fire into a two-press weapon. The first press throws a
// mine: the shell glides out, settles under drag (Bullet.update), and never
// detonates on contact — it bounces off whatever it touches. The next press
// detonates it, striking every target inside its blast ring at once. Only one
// volley (one mine per prong) is in play at a time: while it's live, fire is
// its detonator (shipPhysics.updateFireTrigger), so presses alternate throw,
// blow, throw, blow.
//
// The detonating press is judged on the beat like any fire press; the ring
// flashes on every beat as the metronome for it.

// Fraction of the closing speed a bounce returns. Low, so a mine that hits a
// rock rebounds a short way and still has it in range when it's detonated.
const BOMB_RESTITUTION = 0.35;
// Closing speed at which a bounce rings and sparks at full strength.
const BOUNCE_FULL_IMPACT_SPEED = 400;
// Speed of the blast's push on each target. It sets the direction kill fragments
// fly (straight out from the blast) and the knockback on survivors.
const BLAST_PUSH_SPEED = 300;

// A mine's blast never strikes pickups: a canister caught in it would be a
// powerup wasted by a shot the player never aimed at it.
const INCLUDE_PICKUPS = false;

const blastReaches = (b: Bullet, target: StrikeTarget): boolean =>
  target.collidesWith(b.pos, BOMB_BLAST_RADIUS);

// Rebound off a touched target, in its frame: the target's own velocity carries
// over, so a rock that rolls into a resting mine shoves it ahead rather than
// passing through. Only the closing part of the motion reflects; a mine already
// separating keeps going.
const bounceOff = (game: Game, b: Bullet, target: StrikeTarget) => {
  const [dx, dy] = toroidalDelta(b.pos.x - target.pos.x, b.pos.y - target.pos.y, game.w, game.h);
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const closing = (b.vel.x - target.vel.x) * nx + (b.vel.y - target.vel.y) * ny;
  if (closing >= 0) return;
  b.vel.x -= (1 + BOMB_RESTITUTION) * closing * nx;
  b.vel.y -= (1 + BOMB_RESTITUTION) * closing * ny;
  b.trail.length = 0;
  const impact = Math.min(1, -closing / BOUNCE_FULL_IMPACT_SPEED);
  game.sound.play("tink", 0.4 + 0.3 * impact, b.pos);
  emitBounceSparks(game.particles, b.pos, { x: nx, y: ny }, b.bombHue(), impact);
};

const bounceBomb = (game: Game, b: Bullet, targets: StrikeTarget[]) => {
  const touched = targets.find((t) => t.collidesWith(b.pos, b.hitRadius()));
  if (touched) bounceOff(game, b, touched);
};

// The blast scores on-beat when the detonating press was — a second kill in the
// same blast is a Twin Shot, like a prong pair. Damage still follows how the
// shell was thrown, which its colour shows.
const detonate = (game: Game, b: Bullet, onBeat: boolean) => {
  b.life = 0;
  const driftTier = onBeat ? b.driftTierAtHit() : 0;
  const damage = b.damage() * (driftTier > 0 ? driftTier + 1 : 1);
  applyStrikes(game, INCLUDE_PICKUPS, (target) => {
    if (!blastReaches(b, target)) return null;
    const [dx, dy] = toroidalDelta(target.pos.x - b.pos.x, target.pos.y - b.pos.y, game.w, game.h);
    const len = Math.hypot(dx, dy) || 1;
    // Impact on the target's near face, so directional armour and the hit popups
    // land where the blast meets it.
    const reach = Math.max(0, len - target.radius);
    const impact = { x: b.pos.x + (dx / len) * reach, y: b.pos.y + (dy / len) * reach };
    const push = { x: (dx / len) * BLAST_PUSH_SPEED, y: (dy / len) * BLAST_PUSH_SPEED };
    return { damage, onBeat, shot: strikeShot(impact, push, b), bossImpact: false };
  });
  game.sound.play("explosionMedium", 1, b.pos);
  game.shake = Math.min(game.shake + 0.3, 1.2);
  emitBombBlast(game.particles, b.pos, b.bombHue(), BOMB_BLAST_RADIUS);
};

// Flash the ring on each beat — the cue for an on-beat detonation.
const pulseBomb = (game: Game, b: Bullet) => {
  if (b.bombNextPulseBeat < 0) b.bombNextPulseBeat = Math.floor(b.firedAtBeatTime / BEAT_GRID) + 1;
  if (game.perceivedBeatTime < b.bombNextPulseBeat * BEAT_GRID) return;
  b.bombNextPulseBeat = Math.floor(game.perceivedBeatTime / BEAT_GRID) + 1;
  b.bombPulseAge = 0;
};

// A detonating press is a fire press: judge it on the beat (keeping or dropping
// the streak exactly as a shot would), then blow every live mine of the volley.
const detonateLiveBombs = (game: Game) => {
  const onBeat = isInBeatWindow(game, game.perceivedBeatTime);
  if (onBeat) registerOnBeatFire(game);
  else registerOffBeatFire(game);
  for (const b of game.bullets) if (isLiveBomb(b)) detonate(game, b, onBeat);
};

// Detonate on request, then every surviving bomb rebounds off anything touched
// and pulses if a beat landed. Runs with the collision passes, which skip bombs.
export const handleBombs = (game: Game) => {
  if (game.ship.bombDetonateRequested) {
    game.ship.bombDetonateRequested = false;
    detonateLiveBombs(game);
  }
  // Read after the blast, which may have killed or split targets.
  const targets = strikeTargets(game, INCLUDE_PICKUPS);
  for (const b of game.bullets) {
    if (!isLiveBomb(b)) continue;
    bounceBomb(game, b, targets);
    pulseBomb(game, b);
  }
};
