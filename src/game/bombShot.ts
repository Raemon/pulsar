import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import type { Alien } from "../Alien";
import { Bullet, BOMB_BLAST_RADIUS } from "../Bullet";
import { Vec, add, addScaledMut, mul, toroidalDelta } from "../vec";
import { ENTITY_CONFIG } from "./entityConfig";
import { BEAT_GRID } from "./rhythmConstants";
import { isInBeatWindow } from "./rhythmGate";
import { registerOnBeatFire, registerOffBeatFire } from "./gameUpdate";
import { isLiveBomb } from "../ship/shipWeapons";
import { applyStrikes, strikeShot, strikeTargets, StrikeTarget } from "./weaponStrike";
import { emitBounceDebris, emitBombBlast } from "./particleBursts";

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

// Low, so a dense shell thuds into a rock instead of pinging off, staying in blast range.
const BOMB_RESTITUTION = 0.25;
// The shell weighs as much as a medium rock, in the bodies' knockbackMass units.
const BOMB_MASS = ENTITY_CONFIG.asteroid.hp.medium;
// So a point-blank throw can't fling a small rock or saucer across the field.
const MAX_SHOVE_SPEED = 140;
// Slower contact is a body leaning on the mine (drag re-closes the gap every frame).
const RESTING_CONTACT_SPEED = 25;
const BOUNCE_FULL_IMPACT_SPEED = 400;
const FULL_BOUNCE_SHAKE = 0.1;

// Speed of the blast's push on each target. It sets the direction kill fragments
// fly (straight out from the blast) and the knockback on survivors.
const BLAST_PUSH_SPEED = 300;

// A mine's blast never strikes pickups: a canister caught in it would be a
// powerup wasted by a shot the player never aimed at it.
const INCLUDE_PICKUPS = false;

const blastReaches = (b: Bullet, target: StrikeTarget): boolean =>
  target.collidesWith(b.pos, BOMB_BLAST_RADIUS);

const shoveableBody = (game: Game, target: StrikeTarget): Asteroid | Alien | undefined =>
  game.aliens.find((al) => al === target) ?? game.asteroids.find((a) => a === target && a.driftsFreely());

const contactNormal = (game: Game, b: Bullet, target: StrikeTarget): Vec => {
  const [dx, dy] = toroidalDelta(b.pos.x - target.pos.x, b.pos.y - target.pos.y, game.w, game.h);
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
};

const impactTier = (impact: number): number => (impact < 0.3 ? 0 : impact < 0.7 ? 1 : 2);

// A body leaning on the mine just carries it along: no exchange, no sound.
const rideAlong = (b: Bullet, normal: Vec, closing: number) => addScaledMut(b.vel, normal, -closing);

// Restitution split by mass; a body that can't be shoved is a wall.
const exchangeMomentum = (b: Bullet, body: Asteroid | Alien | undefined, normal: Vec, closing: number) => {
  const exchange = (1 + BOMB_RESTITUTION) * closing;
  if (!body) return addScaledMut(b.vel, normal, -exchange);
  const shellShare = body.knockbackMass() / (BOMB_MASS + body.knockbackMass());
  addScaledMut(b.vel, normal, -exchange * shellShare);
  addScaledMut(body.vel, normal, Math.max(exchange * (1 - shellShare), -MAX_SHOVE_SPEED));
};

// Cosmetic only, never read back by the sim.
const feelBounce = (game: Game, b: Bullet, body: Asteroid | Alien | undefined, normal: Vec, impact: number) => {
  b.trail.length = 0;
  if (body) body.flashAmount = Math.max(body.flashAmount, 0.4 * impact);
  game.shake = Math.min(game.shake + FULL_BOUNCE_SHAKE * impact, 1.2);
  game.sound.play("bombBounce", impactTier(impact), b.pos);
  const contact = add(b.pos, mul(normal, -b.hitRadius()));
  emitBounceDebris(game.particles, contact, normal, body?.hue ?? b.bombHue(), impact);
};

// Only the closing part of the motion is exchanged; a pair already separating carries on.
const bounceOff = (game: Game, b: Bullet, target: StrikeTarget) => {
  const normal = contactNormal(game, b, target);
  const closing = (b.vel.x - target.vel.x) * normal.x + (b.vel.y - target.vel.y) * normal.y;
  if (closing >= 0) return;
  if (-closing < RESTING_CONTACT_SPEED) return rideAlong(b, normal, closing);
  const body = shoveableBody(game, target);
  exchangeMomentum(b, body, normal, closing);
  feelBounce(game, b, body, normal, Math.min(1, -closing / BOUNCE_FULL_IMPACT_SPEED));
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
  game.sound.play(onBeat ? "bombBlastBeat" : "bombBlast", 1, b.pos);
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
    // A pilot killed earlier this frame takes the press with them.
    if (game.ship.alive) detonateLiveBombs(game);
  }
  // Read after the blast, which may have killed or split targets.
  const targets = strikeTargets(game, INCLUDE_PICKUPS);
  for (const b of game.bullets) {
    if (!isLiveBomb(b)) continue;
    bounceBomb(game, b, targets);
    pulseBomb(game, b);
  }
};
