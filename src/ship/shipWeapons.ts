import type { Ship } from "../Ship";
import { Vec, add, mul, fromAngle } from "../vec";
import { Bullet, BOMB_DRAG } from "../Bullet";
import { PowerupKind } from "../Canister";
import { BEAT_GRID } from "../game/rhythmConstants";

// each prong upgrade adds one more bullet, every prong 30° from its neighbour, wrapping
// into a full ring at 12 shots (12 × 30° = 360°) and continuing to overlap beyond that.
// Exported so metalChunk can lay two shards on the first-tier prong pair's rays
// (±half a step off the heading) — see Asteroid.split.
export const PRONG_ANGLE_STEP = Math.PI / 6;

// prongCount n yields n+1 shots fanned symmetrically about the heading (centred on the front),
// plus a straight-ahead shot whenever that fan has no centre prong of its own.
// count 0 → [0]; 1 → ±15,0; 2 → -30,0,+30; 3 → ±15,±45,0; 11 → full ring every 30°, plus 0.
//
// INVARIANT: a weapon's fire loop and its reticule must iterate the SAME fan —
// every entry fires a shot AND draws an aim glyph. Don't compute a single aim
// point from ship.heading in a sight; expose a fan-shaped aim helper next to
// the fire code and have both consume it (see laserAimFan in laserShot.ts;
// the bullet path fans inside computeReticulePositions).
export const prongOffsets = (prongCount: number): number[] => {
  const shots = prongCount + 1;
  const start = -((shots - 1) / 2) * PRONG_ANGLE_STEP;
  const fan = Array.from({ length: shots }, (_, i) => start + i * PRONG_ANGLE_STEP);
  return shots % 2 === 0 ? [...fan, 0] : fan;
};

// pierce extends bullet lifetime so the punch-through shot also reaches farther,
// making the powerup feel like a true "penetrating" upgrade and not just multi-hit.
const PIERCE_RANGE_MULT = 2;
// longshot extends bullet range 1.5x so a shot reaches further than the 1-beat reticule.
const LONGSHOT_RANGE_MULT = 1.5;
// combo ≥ 12 (super-boosted) stretches an on-beat shot's life 1.5× — the reward is reach.
const SUPERBOOSTED_RANGE_MULT = 1.5;

// Flight time of a stock shot under the live range upgrades. The bullet, the laser
// (whose beam overshoots this) and the beat reticules all read it, so each upgrade
// stretches every weapon's reach and its sight together.
export const shotLife = (ship: Ship, superBoosted: boolean): number => {
  let life = ship.bulletLife;
  if (ship.pierceActive) life *= PIERCE_RANGE_MULT;
  if (ship.longshotActive) life *= LONGSHOT_RANGE_MULT;
  if (superBoosted) life *= SUPERBOOSTED_RANGE_MULT;
  return life;
};

// Beat slots a shot of this life reaches — one reticule per slot.
export const beatSlotCount = (life: number): number => Math.max(1, Math.floor(life / BEAT_GRID));

// Where every weapon leaves the ship: a touch ahead of the hull along the
// (possibly prong-offset) heading.
export const muzzleOf = (ship: Ship, headingOffset = 0): Vec =>
  add(ship.pos, mul(fromAngle(ship.heading + headingOffset, 1), ship.radius + 4));

// bullet inherits a fraction of ship velocity so muzzle output reads as physical, not portaled.
const BULLET_VEL_INHERIT = 0.4;

// A bomb inherits none of the ship's velocity. It detonates by where it sits when
// a beat lands, judged against rocks in the world; inherited momentum would move
// that spot by up to ±92px a beat depending on how the ship was flying — as wide
// as the blast — and under the ship-pinned camera would make a mine thrown at
// full thrust hang off the nose. With none, a bomb always lands where it was aimed.
export const shotVelInherit = (ship: Ship): number => (ship.bombActive ? 0 : BULLET_VEL_INHERIT);

// How far a shot has flown along its heading `t` seconds after leaving the muzzle,
// before inherited ship velocity. Stock shots fly straight at bulletSpeed; a bomb
// slows under BOMB_DRAG and settles bulletSpeed / BOMB_DRAG out. Every consumer of
// "where is the shot after N beats" — the beat reticules, the aim circle, the
// drift-aim distance reference — reads this so the sight matches the shell.
export const shotTravel = (ship: Ship, t: number): number =>
  ship.bombActive
    ? (ship.bulletSpeed * (1 - Math.exp(-BOMB_DRAG * t))) / BOMB_DRAG
    : ship.bulletSpeed * t;

// Velocity a shot fired now at `headingOffset` leaves the muzzle with.
const shotLaunchVel = (ship: Ship, headingOffset: number): Vec =>
  add(mul(fromAngle(ship.heading + headingOffset, 1), ship.bulletSpeed), mul(ship.vel, shotVelInherit(ship)));

// Unit direction a shot fired now at `headingOffset` flies along — bent off the
// heading by inherited ship velocity. Drag only slows a bomb, never turns it.
// Exported so metalChunk can lay its wedges on the true prong rays (Asteroid.split).
export const shotRayDir = (ship: Ship, headingOffset: number): Vec => {
  const v = shotLaunchVel(ship, headingOffset);
  return mul(v, 1 / (Math.hypot(v.x, v.y) || 1));
};

// Where a shot fired now at `headingOffset` will be `t` seconds later — the one
// trajectory both the fired shell and its sight follow.
export const shotPositionAt = (ship: Ship, headingOffset: number, t: number): Vec => {
  const dir = fromAngle(ship.heading + headingOffset, 1);
  const inherited = mul(ship.vel, shotVelInherit(ship) * t);
  return add(add(muzzleOf(ship, headingOffset), mul(dir, shotTravel(ship, t))), inherited);
};

// A bomb pulses this many beats, then detonates whether or not anything is near.
export const BOMB_PULSES = 4;
// Bomb sights: one per pulse would stack — by the third beat a settling mine has
// barely moved (196 → 268 → 295px out), so the second sight already marks where
// it rests, well inside its own blast ring.
export const BOMB_SIGHT_SLOTS = 2;

// (Re)sets a stock shot's flight time. The farthest reticule sits at
// beatSlotCount(life) beats out; anything past that can't land on a beat, so the
// bullet fades across the leftover tail to expiry.
export const setShotLife = (bullet: Bullet, life: number) => {
  bullet.life = life;
  bullet.maxLife = life;
  bullet.fadeStartLife = Math.max(0, life - beatSlotCount(life) * BEAT_GRID);
};

const launchBullet = (ship: Ship, headingOffset: number): Bullet => {
  const bullet = new Bullet(muzzleOf(ship, headingOffset), shotLaunchVel(ship, headingOffset), 0);
  if (ship.bombActive) {
    // A bomb's life is counted in beat pulses (game/bombShot.ts), which detonate
    // it. Its timer is only a backstop: a pulse always comes first, even fired
    // just past a beat and armed a full beat later.
    bullet.bomb = true;
    bullet.bombPulsesLeft = BOMB_PULSES;
    bullet.life = bullet.maxLife = (BOMB_PULSES + 2) * BEAT_GRID;
    return bullet;
  }
  bullet.pierce = ship.pierceActive;
  setShotLife(bullet, shotLife(ship, false));
  return bullet;
};

// single fire event yields one bullet per prongOffsets entry; prong must share its on-beat flag across all.
export const fireBullets = (ship: Ship, bullets: Bullet[]) => {
  for (const offset of prongOffsets(ship.prongCount)) bullets.push(launchBullet(ship, offset));
};

// powerup flags are simple bool latches; shield is one-shot, the rest persist for the run.
export const applyPowerup = (ship: Ship, kind: PowerupKind) => {
  if (kind === "prong") ship.prongCount += 1;
  else if (kind === "rapid") ship.rapidActive = true;
  else if (kind === "pierce") ship.pierceActive = true;
  else if (kind === "shield") ship.shieldActive = true;
  else if (kind === "radar") ship.radarActive = true;
  else if (kind === "longshot") ship.longshotActive = true;
  else if (kind === "sideEngines") ship.sideEnginesActive = true;
  else if (kind === "lasershot") ship.lasershotActive = true;
  else if (kind === "bomb") ship.bombActive = true;
};
