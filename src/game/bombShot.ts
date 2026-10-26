import type { Game } from "../Game";
import { Bullet, BOMB_BLAST_RADIUS } from "../Bullet";
import { toroidalDelta } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { applyStrikes, strikeShot, strikeTargets, StrikeTarget } from "./weaponStrike";
import { emitBounceSparks, emitBombBlast } from "./particleBursts";

// The Bomb upgrade turns every shot into a thrown mine. The shell glides out,
// settles under drag (Bullet.update), and never detonates on contact — it
// bounces off whatever it touches. On each quarter-note beat it pulses; a pulse
// with a target inside its blast ring detonates it, striking every target in
// the ring at once. The last pulse detonates it regardless.
//
// Timing comes from the beat clock, never from contact, so the only thing the
// player judges is where the mine sits when a beat lands — which the sight
// shows (shipWeapons.shotTravel) inside the same ring the shell carries.

// A pulse needs this long after launch to count, so a shot fired just ahead of
// a beat doesn't pop off the nose; it waits for the next one.
const BOMB_ARM_SEC = 0.25;
// Fraction of the closing speed a bounce returns. Low, so a mine that hits a
// rock before the beat rebounds a short way and is still in range when it pulses.
const BOMB_RESTITUTION = 0.35;
// Closing speed at which a bounce rings and sparks at full strength.
const BOUNCE_FULL_IMPACT_SPEED = 400;
// Speed of the blast's push on each target. It sets the direction kill fragments
// fly (straight out from the blast) and the knockback on survivors.
const BLAST_PUSH_SPEED = 300;

// A mine pulses and detonates, but never strikes pickups: a canister caught in a
// blast would be a powerup wasted by a shot the player never aimed at it.
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

// The blast lands on a beat by construction, so it can't break the rhythm. It
// counts as an on-beat hit whenever there's a live combo to extend — a second
// kill in the same blast is a Twin Shot, like a prong pair. With no combo
// running (an off-beat press already dropped it) it scores as an off-beat hit,
// which takes nothing away. Damage still follows how the shot was fired.
const detonate = (game: Game, b: Bullet) => {
  b.life = 0;
  const onBeat = game.beatCombo >= 1;
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

const pulseBomb = (game: Game, b: Bullet, targets: StrikeTarget[]) => {
  if (b.bombNextPulseBeat < 0) b.bombNextPulseBeat = Math.ceil((b.firedAtBeatTime + BOMB_ARM_SEC) / BEAT_GRID);
  if (game.perceivedBeatTime < b.bombNextPulseBeat * BEAT_GRID) return;
  b.bombNextPulseBeat += 1;
  b.bombPulsesLeft -= 1;
  b.bombPulseAge = 0;
  if (b.bombPulsesLeft <= 0 || targets.some((t) => blastReaches(b, t))) detonate(game, b);
};

// Every live bomb: rebound off anything touched, then pulse if a beat landed.
// Runs with the collision passes, which skip bombs.
export const handleBombs = (game: Game) => {
  for (const b of game.bullets) {
    if (!b.bomb || b.life <= 0) continue;
    // Re-read per bomb: an earlier bomb's blast may have killed or split targets.
    const targets = strikeTargets(game, INCLUDE_PICKUPS);
    bounceBomb(game, b, targets);
    pulseBomb(game, b, targets);
  }
};
