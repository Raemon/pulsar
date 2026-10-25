import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import type { Alien } from "../Alien";
import type { Comet } from "../Comet";
import type { Gem } from "../Gem";
import type { Canister } from "../Canister";
import { Vec } from "../vec";
import { Bullet } from "../Bullet";
import {
  onAsteroidKilledByBullet,
  onAsteroidCrackedByBullet,
  onAlienKilled,
  onAlienCracked,
  onCometKilled,
  applyHitToCombo,
  applyNonKillHitToCombo,
} from "./killEffects";
import { explodeCanister, expireGem, crackGemForCanister } from "./collisions";
import { syncHud } from "./hud";

// A strike is a weapon hit that doesn't come from a flying bullet touching its
// target — a laser beam's sweep, a bomb's blast. It reaches every target in its
// area at once, and each one is routed through the SAME kill-effect pipeline a
// bullet uses, so every weapon scores, combos and splits rocks identically.

// Every strikeable entity already exposes collidesWith(pos, radius) for the
// bullet path, so a strike hits exactly what a bullet would, with no per-type
// collision math.
export type StrikeTarget = { pos: Vec; vel: Vec; radius: number; collidesWith: (p: Vec, r: number) => boolean };

export type Strike = {
  damage: number;
  // On-beat under the weapon's own rule, decided by the caller.
  onBeat: boolean;
  // Stand-in bullet carrying the impact point, the direction the blow lands in
  // (fragments fly along it), and the shot's rhythm state.
  shot: Bullet;
  // Land the meaty armored-impact on the boss family whatever the shot's flags.
  bossImpact: boolean;
};

// One group per strikeable entity array. `strike` applies one blow to `target`
// and returns the bodies that remain in the array afterwards: the target if it
// survived, kill-spawned children if it died and split, or nothing. To make
// strikes hit a new entity type, add a group here.
type StrikeGroup = {
  list: () => StrikeTarget[];
  strike: (target: StrikeTarget, s: Strike) => StrikeTarget[];
  set: (surviving: StrikeTarget[]) => void;
};

const strikeGroups = (game: Game, includePickups: boolean): StrikeGroup[] => {
  const groups: StrikeGroup[] = [
    {
      list: () => game.asteroids,
      strike: (target, s) => strikeAsteroid(game, target as Asteroid, s),
      set: (surviving) => { game.asteroids = surviving as Asteroid[]; },
    },
    {
      list: () => game.aliens,
      strike: (target, s) => strikeAlien(game, target as Alien, s),
      set: (surviving) => { game.aliens = surviving as Alien[]; },
    },
    {
      list: () => game.comets,
      strike: (target, s) => {
        onCometKilled(game, target as Comet, s.shot, s.onBeat);
        return [];
      },
      set: (surviving) => { game.comets = surviving as Comet[]; },
    },
    {
      // Gems crack (yield canister/score) only on an on-beat hit of ≥4 damage —
      // the same gate the bullet path applies (handleGems). Anything weaker
      // wastes the gem, exactly like an off-beat bullet.
      list: () => game.gems,
      strike: (target, s) => {
        const g = target as Gem;
        if (s.onBeat && s.damage >= 4) {
          applyHitToCombo(game, s.onBeat, s.shot.pos);
          crackGemForCanister(game, g, s.shot.driftTierAtHit());
        } else {
          applyNonKillHitToCombo(game, s.onBeat, s.shot.pos);
          expireGem(game, g);
        }
        return [];
      },
      set: (surviving) => { game.gems = surviving as Gem[]; },
    },
  ];
  if (includePickups) {
    groups.push({
      // Striking a canister wastes the powerup (white pop), same as a bullet.
      list: () => game.canisters,
      strike: (target) => {
        explodeCanister(game, target as Canister);
        return [];
      },
      set: (surviving) => { game.canisters = surviving as Canister[]; },
    });
  }
  return groups;
};

// A blow too weak for the armour glances off — no damage, no combo — just as a
// bullet's deflects (collisions.deflectBulletOff).
const strikeAsteroid = (game: Game, a: Asteroid, s: Strike): StrikeTarget[] => {
  if (s.bossImpact && a.isBossFamily()) game.sound.play("bossHit", 1, a.pos);
  const { killed, bounced } = a.applyDamage(s.damage, false, s.shot.pos);
  if (bounced) {
    a.flashAmount = Math.max(a.flashAmount, 0.5);
    game.sound.play("tink", 0.7, a.pos);
    return [a];
  }
  game.shake = Math.min(game.shake + (killed ? 0.3 : 0.15), 1.2);
  if (!killed) {
    a.applyKnockback(s.shot.vel.x, s.shot.vel.y, s.damage);
    onAsteroidCrackedByBullet(game, a, s.shot, s.onBeat);
    return [a];
  }
  return onAsteroidKilledByBullet(game, a, s.shot, s.onBeat);
};

// Aliens take 1 hp per applyDamage; loop so a heavy strike chews through HP in
// one blow instead of needing N separate shots.
const strikeAlien = (game: Game, al: Alien, s: Strike): StrikeTarget[] => {
  let killed = false;
  for (let i = 0; i < s.damage; i++) {
    if (al.applyDamage().killed) { killed = true; break; }
  }
  if (killed) {
    onAlienKilled(game, al, s.shot, s.onBeat);
    return [];
  }
  al.applyKnockback(s.shot.vel.x, s.shot.vel.y, s.damage);
  onAlienCracked(game, s.onBeat, al.pos);
  return [al];
};

// Every strikeable target on the field right now.
export const strikeTargets = (game: Game, includePickups: boolean): StrikeTarget[] =>
  strikeGroups(game, includePickups).flatMap((g) => g.list());

// Offers every strikeable target to `strikeFor`; each one it returns a Strike for
// takes that blow. Returns how many targets were struck.
export const applyStrikes = (
  game: Game, includePickups: boolean, strikeFor: (target: StrikeTarget) => Strike | null,
): number => {
  let struck = 0;
  for (const group of strikeGroups(game, includePickups)) {
    const surviving: StrikeTarget[] = [];
    for (const target of group.list()) {
      const s = strikeFor(target);
      if (!s) { surviving.push(target); continue; }
      struck += 1;
      for (const remaining of group.strike(target, s)) surviving.push(remaining);
    }
    group.set(surviving);
  }
  syncHud(game);
  return struck;
};

// Synthesises a Bullet just so the kill-effect helpers can read .pos / .vel /
// rhythm flags without re-wiring the whole kill pipeline. It is never added to
// game.bullets, so it never updates or renders. instantHit: a strike has no
// flight of its own, so it can never be a Far Shot.
export type ShotRhythm = Pick<Bullet, "onBeat" | "boosted" | "superBoosted" | "driftLockedSlots">;
export const strikeShot = (pos: Vec, vel: Vec, rhythm: ShotRhythm): Bullet => {
  const b = new Bullet({ x: pos.x, y: pos.y }, { x: vel.x, y: vel.y }, 0.01);
  b.onBeat = rhythm.onBeat;
  b.boosted = rhythm.boosted;
  b.superBoosted = rhythm.superBoosted;
  b.driftLockedSlots = rhythm.driftLockedSlots;
  b.instantHit = true;
  return b;
};
