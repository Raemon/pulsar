import type { Game } from "../Game";
import { toroidalDelta, cosmeticRand } from "../vec";
import { rng } from "./rng";
import { Asteroid } from "../Asteroid";
import { Alien } from "../Alien";
import { Comet } from "../Comet";
import { Bullet, BULLET_DAMAGE_BEAT_BOOSTED } from "../Bullet";
import { AlienBullet } from "../AlienBullet";
import { Canister } from "../Canister";
import {
  Gem,
  GEM_UPGRADE_CHANCE,
  GEM_REVEAL_SCORE,
  spawnCanisterFromGem,
} from "../Gem";
import { FuelOrb, spawnFuelOrbAt } from "../FuelOrb";
import { FUEL_MODE_ENABLED, FUEL_ORB_RESTORE } from "./fuel";
import { isInBeatWindow, beatOffsetFor, logBeatEvent, spawnBeatDebugPopup, rebaseBeatEval } from "./rhythmGate";
import { SLOW_MO_DURATION } from "./slowMo";
import { syncHud } from "./hud";
import { emitShieldPop, emitCanisterPickup, emitCanisterPop, emitGemPickup, emitFuelOrbPickup, emitBounceSparks, emitAlienBulletPop } from "./particleBursts";
import { popupPickup, popupScore, popupSideEnginesPickup, popupLaserShotPickup, popupInsufficientDamage } from "./popups";
import { registerFiredOnBeatMiss } from "./aimHint";
import { beatsAwayAtHit } from "./rhythmBonus";
import {
  applyHitToCombo,
  applyNonKillHitToCombo,
  awardScoreForKill,
  onAsteroidKilledByBullet,
  onAsteroidKilledByRam,
  onAsteroidCrackedByBullet,
  onAsteroidCrackedByRam,
  onAlienKilled,
  onAlienCracked,
  onCometKilled,
} from "./killEffects";
import { killShip } from "./lifecycle";

// every bullet-hit handler logs the same fire/impact shape; one helper keeps it uniform.
const logBulletHit = (game: Game, kind: string, b: Bullet) => {
  const fireOffsetMs = (beatOffsetFor(game, b.firedAtBeatTime) * 1000).toFixed(1);
  logBeatEvent(
    game,
    kind,
    game.perceivedBeatTime,
    `firedAt=${b.firedAtBeatTime.toFixed(4)}s fireOffset=${fireOffsetMs}ms bulletOnBeat=${b.onBeat}`,
  );
  spawnBeatDebugPopup(game, b.pos, game.perceivedBeatTime, "HIT");
};

// strict on both ends — a bullet drifting out of the window between fire and hit doesn't count.
//   Judged on perceivedBeatTime (latency-shifted) to match the fire-time classification.
//   Every hit routes through here, so it's also where the "pressed in time, connected late"
//   pattern is counted for the once-per-run targeting hint (game/aimHint.ts). The suppression
//   flag is reset per judgement so it only ever covers the hit that just raised it.
const isHitOnBeat = (game: Game, b: Bullet) => {
  const onBeat = isInBeatWindow(game, game.perceivedBeatTime) && b.onBeat;
  game.aimHintSuppressLossPopup = false;
  if (!onBeat && b.onBeat) registerFiredOnBeatMiss(game, b.pos);
  return onBeat;
};

// single-hit targets (comets/canisters) share this shape; multi-hit targets bookkeep separately.
type CollidableTarget = { collidesWith: (pos: { x: number; y: number }, r: number) => boolean };
const findFirstHittingBullet = (bullets: Bullet[], target: CollidableTarget): Bullet | null => {
  for (const b of bullets) {
    if (b.life <= 0) continue;
    if (target.collidesWith(b.pos, b.hitRadius())) return b;
  }
  return null;
};

// pierce keeps the bullet alive so a single shot can punch through a row of targets.
const consumeBullet = (b: Bullet) => { if (!b.pierce) b.life = 0; };

// Picks the hint line under the INSUFFICIENT DAMAGE headline. A bounced drift
// shot means the player already knows the mechanic — hold longer. Otherwise
// "gain more rhythm" is only offered when it could actually work: a max-rhythm
// (boosted) shot must beat this armour, and something soft must be on screen
// to build that rhythm against. Failing either, only a drift shot can help.
// Cosmetic-stream rand so the coin flip can't touch the gameplay RNG.
const insufficientDamageHint = (game: Game, a: Asteroid, wasDriftShot: boolean): string => {
  // The hemisphere's armour is directional — teach the flank, not the drift.
  if (a.kind === "bossHemisphere") return "HIT THE MOLTEN FACE";
  // The tomb's armour is the bier: no shot is the answer, the bearers are.
  if (a.isSepulchre() && a.bierBearersAlive > 0) return "DESTROY THE SATELLITES";
  if (wasDriftShot) return "AIM A LONGER DRIFT SHOT";
  const softTargetOnScreen =
    game.aliens.length > 0 ||
    game.comets.length > 0 ||
    game.asteroids.some((o) => o.damageReduction <= 0);
  const rhythmCanCrack = a.damageReduction < BULLET_DAMAGE_BEAT_BOOSTED;
  if (!softTargetOnScreen || !rhythmCanCrack) return "AIM A CAREFUL DRIFT SHOT";
  return cosmeticRand(0, 1) < 0.5 ? "GAIN MORE RHYTHM" : "AIM A CAREFUL DRIFT SHOT";
};

// A shot that can't break the target's armour ricochets: velocity reflects about
// the surface normal (center→bullet), drops to half speed (the crystal eats the
// rest), the bullet is shoved just clear of the hitbox so it doesn't re-trigger
// next frame, and sparks fly back along the normal. The bullet keeps its damage
// tier — a bounced on-beat shot is still on-beat if it goes on to land elsewhere.
// Half the momentum the blocked damage *would* have transferred still shoves the
// crystal, so a fully-armoured rock can still be nudged by sustained fire.
const deflectBulletOff = (game: Game, b: Bullet, a: Asteroid, blockedDmg: number, wasDriftShot: boolean) => {
  let [nx, ny] = toroidalDelta(b.pos.x - a.pos.x, b.pos.y - a.pos.y, game.w, game.h);
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  // the blocked shot shoves the crystal along its *incoming* heading (captured
  // before we reflect b.vel), so the rock gets pushed the way the bullet was going.
  const inVx = b.vel.x;
  const inVy = b.vel.y;
  const vdotn = b.vel.x * nx + b.vel.y * ny;
  // only reflect the inward component — a glancing shot already leaving keeps going.
  if (vdotn < 0) {
    b.vel.x -= 2 * vdotn * nx;
    b.vel.y -= 2 * vdotn * ny;
  }
  if (!b.hasAppliedKnockback) {
    b.hasAppliedKnockback = true;
    a.applyKnockback(inVx, inVy, blockedDmg * 0.5);
  }
  b.vel.x *= 0.5;
  b.vel.y *= 0.5;
  // push outside the hitbox along the normal so the next frame starts clear.
  // Use the faceted surface radius at this angle (crystals peak well past their
  // nominal radius) plus a small margin so the deflected shot can't re-collide.
  // A cross-seam deflection may land slightly out of domain — harmless, the
  // next update folds it.
  const surface = a.radiusAtAngle(Math.atan2(ny, nx) - a.rotation);
  const clear = surface + b.hitRadius() + 2;
  b.pos.x = a.pos.x + nx * clear;
  b.pos.y = a.pos.y + ny * clear;
  b.trail.length = 0;
  // impact reads the blocked momentum the same way applyKnockback does (vs the
  // rock's mass) so the spark spray scales with how hard the shot rang it.
  const impact = Math.min(1, blockedDmg / Math.max(1, a.maxHp));
  a.flashAmount = Math.max(a.flashAmount, 0.5 * impact);
  game.sound.play("tink", 0.5 + 0.4 * impact, a.pos);
  emitBounceSparks(game.particles, b.pos, { x: nx, y: ny }, a.hue, impact);
  // first glance off this rock teaches the player that weak hits bounce; a
  // bounced drift shot earns the "longer" variant once more on top of that.
  if (wasDriftShot ? !a.driftGlanceTipShown : !a.glanceTipShown) {
    a.glanceTipShown = true;
    if (wasDriftShot) a.driftGlanceTipShown = true;
    game.popups.push(popupInsufficientDamage(b.pos, insufficientDamageHint(game, a, wasDriftShot)));
  }
};

// walk every rock so multi-hit HP and on-kill splits both resolve in one collision pass.
const handleBulletAsteroidHits = (game: Game) => {
  const surviving: Asteroid[] = [];
  for (const a of game.asteroids) {
    const survivors = hitAsteroidWithBullets(game, a);
    if (survivors === null) surviving.push(a);
    else for (const c of survivors) surviving.push(c);
  }
  game.asteroids = surviving;
};

// null|children lets the outer loop stay branchless about the survival/kill distinction.
const hitAsteroidWithBullets = (game: Game, a: Asteroid): Asteroid[] | null => {
  for (const b of game.bullets) {
    if (b.life <= 0) continue;
    // Citadel inner wall: a shot fired from within the escape hole lands even
    // while the shell is phased out, and bypasses the armour entirely — the
    // intended way to break the fortress open from inside.
    const innerHit = a.citadelInnerHit(b.firedFrom, b.pos, b.hitRadius());
    if (!innerHit && !a.collidesWith(b.pos, b.hitRadius())) continue;
    const onBeat = isHitOnBeat(game, b);
    // drift tier scales the bonus: tier1→2× … tier6→7× damage (was a flat 4×).
    const driftTier = onBeat ? b.driftTierAtHit() : 0;
    const dmg = b.damage() * (driftTier > 0 ? driftTier + 1 : 1);
    // Peek at the outcome before consuming the bullet: a hit too weak to break
    // the target's armour deflects instead of landing — no damage, no combo,
    // and the shot ricochets off the surface so it can travel on. Armour is
    // resolved at the impact point (the hemisphere's shell-only armour).
    if (!innerHit && dmg <= a.damageReductionAt(b.pos)) {
      deflectBulletOff(game, b, a, dmg, driftTier > 0);
      return null;
    }
    consumeBullet(b);
    logBulletHit(game, "HIT asteroid", b);
    const { killed } = a.applyDamage(dmg, innerHit, b.pos);
    game.shake = Math.min(game.shake + (killed ? 0.4 : 0.2), 1.2);
    if (!killed) {
      if (!b.hasAppliedKnockback) {
        b.hasAppliedKnockback = true;
        a.applyKnockback(b.vel.x, b.vel.y, dmg);
      }
      onAsteroidCrackedByBullet(game, a, b, onBeat);
      return null;
    }
    return onAsteroidKilledByBullet(game, a, b, onBeat);
  }
  return null;
};

// ramming kill skips score/combo (not a rhythm hit) but still loses shield/life unless invuln.
const handleShipAsteroidCollisions = (game: Game) => {
  if (!game.ship.alive || game.ship.invuln > 0) return;
  for (let i = 0; i < game.asteroids.length; i++) {
    const a = game.asteroids[i];
    if (!shipAsteroidHit(game, a)) continue;
    handleSingleShipAsteroidImpact(game, a, i);
    break;
  }
};

// polygon-accurate test against the visible halo means the outline IS the hitbox.
export const shipAsteroidHit = (game: Game, a: Asteroid): boolean => {
  const [dx, dy] = toroidalDelta(a.pos.x - game.ship.pos.x, a.pos.y - game.ship.pos.y, game.w, game.h);
  const distance = Math.hypot(dx, dy);
  if (distance > a.radius * 1.3 + game.ship.hitRadius) return false;
  const shipReach = game.ship.hitDistanceToward(Math.atan2(dy, dx));
  return a.collidesWith(game.ship.pos, shipReach);
};

// encapsulates the in-place splice when a ram kills, so the outer loop stays a simple sweep.
const handleSingleShipAsteroidImpact = (game: Game, a: Asteroid, asteroidIdx: number) => {
  const ramDamage = 4;
  const { killed } = a.applyDamage(ramDamage, false, game.ship.pos);
  if (killed) {
    const children = onAsteroidKilledByRam(game, a, game.ship.vel);
    for (const c of children) game.asteroids.push(c);
    game.asteroids.splice(asteroidIdx, 1);
  } else {
    // ram knockback uses the ship's own speed as the energy budget so a
    // gentle bump barely nudges a rock and a full-speed slam shoves it hard.
    const shipSpeed = Math.hypot(game.ship.vel.x, game.ship.vel.y);
    a.applyKnockback(game.ship.vel.x, game.ship.vel.y, ramDamage, shipSpeed);
    onAsteroidCrackedByRam(game, a);
  }
  if (game.ship.shieldActive) {
    game.ship.shieldActive = false;
    game.ship.invuln = 0.8;
    popShield(game);
  } else {
    killShip(game);
  }
};

// aliens use the bassteroid multi-hit pattern — chips before the kill shot.
export const handleAlienHits = (game: Game) => {
  const surviving: Alien[] = [];
  for (const a of game.aliens) {
    if (!tryKillAlienWithBullets(game, a)) surviving.push(a);
  }
  game.aliens = surviving;
};

// returns "should we drop this alien?" so the outer loop stays declarative.
const tryKillAlienWithBullets = (game: Game, a: Alien): boolean => {
  for (const b of game.bullets) {
    if (b.life <= 0) continue;
    if (!a.collidesWith(b.pos, b.hitRadius())) continue;
    consumeBullet(b);
    const onBeat = isHitOnBeat(game, b);
    logBulletHit(game, "HIT alien", b);
    const { killed } = a.applyDamage();
    if (!killed) {
      a.applyKnockback(b.vel.x, b.vel.y, 1);
      onAlienCracked(game, onBeat, a.pos);
      return false;
    }
    onAlienKilled(game, a, b, onBeat);
    return true;
  }
  return false;
};

// only one bullet "lands" per frame; the rest stay alive so they can hit on later frames.
// Alien bullets also chip asteroids they fly into (1 damage), consumed on impact.
export const handleAlienBulletHits = (game: Game) => {
  const remaining: AlienBullet[] = [];
  let shipHit = false;
  const shipVulnerable = game.ship.alive && game.ship.invuln <= 0;
  for (const ab of game.alienBullets) {
    if (playerBulletShootsDownAlienBullet(game, ab)) continue;
    if (alienBulletDamagesAsteroid(game, ab)) continue;
    if (shipVulnerable && !shipHit && alienBulletHitsShip(game, ab)) {
      shipHit = true;
      onShipHitByAlienBullet(game);
      continue;
    }
    remaining.push(ab);
  }
  game.alienBullets = remaining;
};

// A player shot meeting an alien bullet cancels it: the alien bullet pops in a
// hue-tinted spray and the player bullet is consumed (unless it pierces). Boss
// plasma/laser bolts are exempt — they're meant to be dodged, not shot down.
const playerBulletShootsDownAlienBullet = (game: Game, ab: AlienBullet): boolean => {
  if (ab.isBoss) return false;
  for (const b of game.bullets) {
    if (b.life <= 0) continue;
    const reach = b.hitRadius() + ab.radius;
    const [dx, dy] = toroidalDelta(b.pos.x - ab.pos.x, b.pos.y - ab.pos.y, game.w, game.h);
    if (Math.hypot(dx, dy) > reach) continue;
    consumeBullet(b);
    game.sound.play("explosionSmall", 0.7, ab.pos);
    game.shake = Math.min(game.shake + 0.12, 1.2);
    emitAlienBulletPop(game.particles, ab.pos, ab.hue);
    return true;
  }
  return false;
};

// returns true if the bullet hit (and was consumed by) an asteroid this frame.
const alienBulletDamagesAsteroid = (game: Game, ab: AlienBullet): boolean => {
  for (let i = 0; i < game.asteroids.length; i++) {
    const a = game.asteroids[i];
    if (a === ab.owner) continue;
    if (!a.collidesWith(ab.pos, ab.radius)) continue;
    const { killed } = a.applyDamage(1, false, ab.pos);
    game.shake = Math.min(game.shake + (killed ? 0.3 : 0.15), 1.2);
    if (killed) {
      const children = onAsteroidKilledByRam(game, a, ab.vel);
      game.asteroids.splice(i, 1, ...children);
    } else {
      a.applyKnockback(ab.vel.x, ab.vel.y, 1);
      onAsteroidCrackedByRam(game, a);
    }
    return true;
  }
  return false;
};

const alienBulletHitsShip = (game: Game, ab: AlienBullet): boolean => {
  const [dx, dy] = toroidalDelta(ab.pos.x - game.ship.pos.x, ab.pos.y - game.ship.pos.y, game.w, game.h);
  const distance = Math.hypot(dx, dy);
  const shipReach = game.ship.hitDistanceToward(Math.atan2(dy, dx));
  return distance < shipReach + ab.radius;
};

const onShipHitByAlienBullet = (game: Game) => {
  if (game.ship.shieldActive) {
    game.ship.shieldActive = false;
    game.ship.invuln = 0.8;
    popShield(game);
  } else {
    killShip(game);
  }
};

// comets are 1-HP — single-hit kill pattern shared with canisters.
export const handleCometHits = (game: Game) => {
  const surviving: Comet[] = [];
  for (const c of game.comets) {
    if (!tryKillCometWithBullets(game, c)) surviving.push(c);
  }
  game.comets = surviving;
};

const tryKillCometWithBullets = (game: Game, c: Comet): boolean => {
  const b = findFirstHittingBullet(game.bullets, c);
  if (!b) return false;
  consumeBullet(b);
  const onBeat = isHitOnBeat(game, b);
  logBulletHit(game, "HIT comet", b);
  onCometKilled(game, c, b, onBeat);
  return true;
};

// Grabbing a reward should be forgiving — "anywhere the ship touches it counts",
// not "ram it dead-centre". The old test summed the ship's hull radius scaled
// DOWN to 0.9, which sat well inside the visible silhouette. Use the ship's
// full visible perimeter (hull + the halo that IS the player-facing edge)
// instead, so a pickup fires the moment the sprites overlap on screen.
const pickupReach = (game: Game): number =>
  game.ship.radius + game.ship.haloOffset;

// pickup-popup labels what was grabbed so the player can read it after the burst clears.
export const handleCanisterPickups = (game: Game) => {
  if (!game.ship.alive) return;
  const remaining: Canister[] = [];
  for (const c of game.canisters) {
    if (c.collidesWith(game.ship.pos, pickupReach(game))) collectCanister(game, c);
    else remaining.push(c);
  }
  game.canisters = remaining;
};

// Fuel Mode: fly through a fuel orb to top up the reserve. No-op when fuel mode
// is off (no orbs ever spawn, so the list stays empty).
export const handleFuelOrbPickups = (game: Game) => {
  if (!FUEL_MODE_ENABLED || !game.ship.alive) return;
  const remaining: FuelOrb[] = [];
  for (const o of game.fuelOrbs) {
    if (o.collidesWith(game.ship.pos, pickupReach(game))) collectFuelOrb(game, o);
    else remaining.push(o);
  }
  game.fuelOrbs = remaining;
};

const collectFuelOrb = (game: Game, o: FuelOrb) => {
  game.ship.fuel = Math.min(game.ship.maxFuel, game.ship.fuel + FUEL_ORB_RESTORE);
  game.sound.play("powerup");
  emitFuelOrbPickup(game.particles, o.pos, o.hue);
};

// white burst differs from the hue-tinted pickup burst so "wasted pod" reads visibly.
export const handleCanisterShots = (game: Game) => {
  const remaining: Canister[] = [];
  for (const c of game.canisters) {
    const b = findFirstHittingBullet(game.bullets, c);
    if (b) {
      consumeBullet(b);
      explodeCanister(game, c);
    } else remaining.push(c);
  }
  game.canisters = remaining;
};

// one site handles every pickup so HUD label / timer / powerup-apply stay in lockstep.
const collectCanister = (game: Game, c: Canister) => {
  game.sound.play("powerup");
  if (c.kind === "sideEngines") game.popups.push(popupSideEnginesPickup(c.pos));
  else if (c.kind === "lasershot") game.popups.push(popupLaserShotPickup(game.ship.pos));
  else game.popups.push(popupPickup(c.pos, c.kind));
  if (c.kind === "slow") {
    game.slowMoTimer = SLOW_MO_DURATION;
  } else {
    // rapid flips grid quarters→eighths; rebase against the new grid so closures keep
    // marching forward. (skip if combo is already ≥ 16 — grid was already on eighths.)
    const willChangeGrid = c.kind === "rapid" && !game.ship.rapidActive && game.beatCombo < 16;
    game.ship.applyPowerup(c.kind);
    if (willChangeGrid) rebaseBeatEval(game);
  }
  emitCanisterPickup(game.particles, c);
};

// shooting wastes the powerup — neutral sound + white burst contrasts the pickup flavour.
export const explodeCanister = (game: Game, c: Canister) => {
  game.sound.play("explosionSmall", 1, c.pos);
  game.sound.play("canisterDestroyed", 1, c.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitCanisterPop(game.particles, c);
};

// Two ways to resolve a gold gem on the field:
//   1) Shoot it. Strictly rhythm-gated: only an on-beat shot dealing ≥ 4
//      damage cracks it — that path may reveal an upgrade or pay out reveal
//      score (see crackGemForCanister). Any weaker / off-beat shot
//      wastes it: no score, no popup, same sad sound + white burst a wasted
//      canister gets, so the player reads "wrong tool" the same way.
//   2) Fly through it. The gem shatters on contact and the ship takes the
//      hit — shield pops if up, otherwise killShip. No score: the gem is a
//      rhythm target, never a freebie pickup.
// Shoot pass runs first so a bullet at the gem this frame can't be
// pre-empted by a same-frame ship overlap.
export const handleGems = (game: Game) => {
  const remaining: Gem[] = [];
  for (const g of game.gems) {
    const b = findFirstHittingBullet(game.bullets, g);
    if (b) {
      consumeBullet(b);
      const onBeat = isHitOnBeat(game, b);
      const dmg = b.damage();
      if (onBeat && dmg >= 4) {
        applyHitToCombo(game, onBeat, b.pos, beatsAwayAtHit(game, b));
        crackGemForCanister(game, g, b.driftTierAtHit());
      } else {
        applyNonKillHitToCombo(game, onBeat, b.pos);
        wasteGem(game, g);
      }
      continue;
    }
    if (game.ship.alive && game.ship.invuln <= 0 && g.collidesWith(game.ship.pos, game.ship.radius * 0.9)) {
      shatterGemOnShip(game, g);
      continue;
    }
    remaining.push(g);
  }
  game.gems = remaining;
};

// Ship touched the gem: same sad crystal-break flavour as a solid-crystal
// asteroid shatter, and the ship eats the impact (shield first, then kill).
const shatterGemOnShip = (game: Game, g: Gem) => {
  game.sound.play("crystalShatterSmall", 1, g.pos);
  game.shake = Math.min(game.shake + 0.3, 1.2);
  emitGemPickup(game.particles, g);
  if (game.ship.shieldActive) {
    game.ship.shieldActive = false;
    game.ship.invuln = 0.8;
    popShield(game);
  } else {
    killShip(game);
  }
};

// Rhythm-cracked (always on-beat — the caller only reaches here on-beat): 40% of
// the time the gem yields its embedded canister, the rest of the time it pays out
// score. The score branch goes through the shared awardScoreForKill, so the gem's
// reveal score is rhythm-multiplied and its drift-tier bonus is staged exactly the
// same way an asteroid kill's is — one code path, no gem-specific bonus queue.
export const crackGemForCanister = (game: Game, g: Gem, driftTier: number) => {
  game.sound.play("tink", 1, g.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitGemPickup(game.particles, g);
  if (rng() < GEM_UPGRADE_CHANCE) {
    const canister = spawnCanisterFromGem(g, game.w, game.h);
    game.canisters.push(canister);
    game.sound.play("canisterAppear", 1, g.pos);
  } else {
    const earned = awardScoreForKill(game, g.pos, GEM_REVEAL_SCORE, true, driftTier);
    game.popups.push(popupScore(g.pos, earned));
    // Fuel Mode: a no-upgrade crack still drops something useful — a fuel orb to
    // chase down. Off → unchanged (score only).
    if (FUEL_MODE_ENABLED) {
      game.fuelOrbs.push(spawnFuelOrbAt(g.pos, game.w, game.h));
      game.sound.play("canisterAppear", 1, g.pos);
    }
  }
  syncHud(game);
};

// Off-beat / weak shot: same "wasted upgrade" feedback as shooting a canister
// Lifetime ran out before the player grabbed or shot the gem. Same
// "lost upgrade" feedback as a wasted shot so an unattended gem doesn't
// just silently vanish — the bang nudges the player to notice next time.
export const expireGem = (game: Game, g: Gem) => {
  game.sound.play("explosionSmall", 1, g.pos);
  game.sound.play("canisterDestroyed", 1, g.pos);
  game.shake = Math.min(game.shake + 0.25, 1.2);
  emitCanisterPop(game.particles, g);
};

// Shot the gem instead of flying through it — no score, no popup. Same
// "lost upgrade" feedback; teaches the player the gem is a rhythm target.
const wasteGem = expireGem;

// deflection burst differs from kill bursts so the player feels the shield saved them.
export const popShield = (game: Game) => {
  game.sound.play("shieldPop");
  game.shake = Math.min(game.shake + 0.2, 1.2);
  emitShieldPop(game.particles, game.ship.pos);
};

// rolls bullet-vs-rocks + ship-vs-rocks into one entry; update() reads as one step.
export const handleCollisions = (game: Game) => {
  handleBulletAsteroidHits(game);
  handleShipAsteroidCollisions(game);
  syncHud(game);
};
