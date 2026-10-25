import type { Ship } from "../Ship";
import { addScaledMut, scaleMut, wrapMut } from "../vec";
import { IInput } from "../Input";
import { ParticleSystem } from "../Particle";
import { Bullet } from "../Bullet";
import { Sound } from "../Sound";
import { emitThrust, emitReverseThrust, emitSideThrust } from "./shipParticles";
import { fireBullets, shotTravel } from "./shipWeapons";
import { isDown } from "../game/controlBindings";
import { FUEL_MODE_ENABLED, FUEL_THRUST_DRAIN, FUEL_SIDE_DRAIN, FUEL_RECHARGE, FUEL_RECHARGE_INTERVAL } from "../game/fuel";
import { BEAT_GRID } from "../game/rhythmConstants";

const ENGINE_SOUNDS_ENABLED = false;

// Flip to true to cap the ship's velocity at ship.maxSpeed; false lets
// Newtonian drift accelerate without limit.
const TOP_SPEED_ENABLED = true;

// Flip to true to give every ship side thrust from the start, ignoring the
// sideEngines powerup gate. Flip back to false to return it to an upgrade.
// Same flag also pulls the sideEngines powerup from the drop pool (see
// Canister.POWERUP_KINDS) so the two never disagree.
export const SIDE_THRUST_ALWAYS_ON = true;

// Drift-aim fine-control: an input that BEGINS while the reticule is hovering a Next Beat Target
// starts slowed, then ramps back to full speed as you keep holding it. Inputs already in flight
// before the hover are untouched, so the slow never gets in the way of normal manoeuvring — it only
// gives a deliberate "settle onto the target" press an initial soft start.
//   - The slow is captured once on each input's press edge (driftSlowRot/Thrust/Reverse/Port/Star).
//   - While held, it ramps back to 1 over DRIFT_AIM_RAMP_SEC (so a hold > that is full speed).
//   - The captured value comes from the deepest hovered zone: center/locked slow, nearby = none.
// Rotation and thrust each have their own [nearby, center, locked] multiplier set so they can be
// tuned apart.
type DriftAimMults = { nearby: number; center: number; locked: number };
const DRIFT_AIM_ROT_MULTS: DriftAimMults = { nearby: 1, center: 0.25, locked: 0.25 };
const DRIFT_AIM_THRUST_MULTS: DriftAimMults = { nearby: 1, center: 0.25, locked: 0.25 };
// how long a held input takes to ramp its captured drift-slow back up to full speed.
const DRIFT_AIM_RAMP_SEC = 0.15;
// when true, a turn whose frame step would carry the heading PAST a hovered target snaps exactly
// onto it (once) instead of overshooting; the key still turns freely on the next frame.
const DRIFT_AIM_SNAP = true;
// Rotation swings the reticule a tangential distance of (aim distance × angular speed), so a target
// twice as far sweeps twice as fast under the same turn rate. To hold the reticule's on-screen sweep
// roughly constant regardless of how far the hovered target is, the center/locked rotation slow is
// scaled by (reference distance / actual distance): the 1-beat target (≈ refDist) keeps full slow,
// a 2-beat target halves it, a 3-beat thirds it — derived continuously from the real distance rather
// than the slot index. The reference is the 1-beat reticule distance (shotTravel over one beat). Capped
// at 1 so a closer-than-reference target never *speeds up* rotation. Thrust is unaffected (it moves
// the ship, not the reticule sweep), and the nearby approach zone keeps its full multiplier.
const driftAimRotDistFactor = (ship: Ship, ringCenter: { x: number; y: number }) => {
  const refDist = shotTravel(ship, BEAT_GRID);
  const dist = Math.hypot(ringCenter.x - ship.pos.x, ringCenter.y - ship.pos.y);
  if (dist <= refDist || refDist <= 0) return 1;
  return refDist / dist;
};

// zone level of one ring: 3 locked, 2 center, 1 nearby, 0 off-target. Zones nest → check inner-first.
const ringZoneLevel = (ring: Ship["hoverDotRingStates"][number]) => {
  if (ring.completionBeatTime !== null) return 3;
  if (ring.hoverStartBeatTime !== null) return 2;
  if (ring.zoneEnterBeatTime !== null) return 1;
  return 0;
};

// the deepest-engaged hovered ring across all beat-distance slots: its zone level + the ring center
// (world-space target position) so callers can read the actual aim distance. The reticule sits over
// at most one target, but each slot tracks its own ring, so pick whichever is furthest in.
const deepestHoveredRing = (ship: Ship) => {
  let best: { zone: number; center: { x: number; y: number } | null } = { zone: 0, center: null };
  for (const ring of ship.hoverDotRingStates) {
    const zone = ringZoneLevel(ring);
    if (zone > best.zone) best = { zone, center: ring.lastRingCenter };
  }
  return best;
};

// slow to capture for a freshly-pressed ROTATION input: center/locked zone slow scaled by aim
// distance (nearby = none, no hover = none). 1 means "no slow".
const captureRotSlow = (ship: Ship) => {
  const { zone, center } = deepestHoveredRing(ship);
  if (zone >= 2) {
    const base = DRIFT_AIM_ROT_MULTS[zone === 3 ? "locked" : "center"];
    return center ? base * driftAimRotDistFactor(ship, center) : base;
  }
  if (zone === 1) return DRIFT_AIM_ROT_MULTS.nearby;
  return 1;
};

// slow to capture for a freshly-pressed THRUST-family input (no distance scaling — thrust moves the
// ship, not the reticule sweep). 1 means "no slow".
const captureThrustSlow = (ship: Ship) => {
  const zone = deepestHoveredRing(ship).zone;
  if (zone === 3) return DRIFT_AIM_THRUST_MULTS.locked;
  if (zone === 2) return DRIFT_AIM_THRUST_MULTS.center;
  if (zone === 1) return DRIFT_AIM_THRUST_MULTS.nearby;
  return 1;
};

// ramp a captured slow back toward 1 (full speed) given how long the input has been held: at hold=0
// it's the raw captured value, at hold>=DRIFT_AIM_RAMP_SEC it's a full 1.
const rampedSlow = (captured: number, heldSec: number) => {
  const t = Math.min(1, heldSec / DRIFT_AIM_RAMP_SEC);
  return captured + (1 - captured) * t;
};

// shortest signed angle delta from a to b, in (-π, π].
const angleDelta = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// if a hovered target lies between this frame's heading and where rotVel*dt would carry it, snap the
// heading exactly onto the target and report it. Snap-once: rotVel is left intact, so the next held
// frame turns freely on past. Returns true if it snapped (caller skips the normal heading advance).
const trySnapToTarget = (ship: Ship, dt: number): boolean => {
  if (!DRIFT_AIM_SNAP || ship.rotVel === 0) return false;
  const center = deepestHoveredRing(ship).center;
  if (!center) return false;
  const targetHeading = Math.atan2(center.y - ship.pos.y, center.x - ship.pos.x);
  const toTarget = angleDelta(ship.heading, targetHeading);
  const step = ship.rotVel * dt;
  // only snap when turning toward the target and this step would reach or pass it.
  if (Math.sign(step) !== Math.sign(toTarget)) return false;
  if (Math.abs(step) < Math.abs(toTarget)) return false;
  ship.heading = targetHeading;
  return true;
};

// Two-regime turning: inside the tap window the ship turns at a slow,
// constant nudge rate, then the rate blends quickly up to the full turn
// rate and holds steady there. With rotInertia the spin coasts on key
// release and must be countered; without it the spin stops instantly.
const updateTurning = (ship: Ship, input: IInput, dt: number) => {
  const dir = (isDown(input, "rotateRight") ? 1 : 0) - (isDown(input, "rotateLeft") ? 1 : 0);
  const precision = isDown(input, "precisionTurn") ? 0.2 : 1;
  if (dir !== 0) {
    // press edge (start, or direction flip): reset the hold clock and capture this turn's drift-slow
    // from the currently-hovered zone. A turn begun off-target captures 1 (no slow).
    if (dir !== ship.rotHeldDir) {
      ship.rotHoldTime = 0;
      ship.driftSlowRot = captureRotSlow(ship);
    }
    ship.rotHoldTime += dt;
    const past = ship.rotHoldTime - ship.rotTapHoldTime;
    const blend = Math.min(1, Math.max(0, past / ship.rotRampTime));
    const rate = ship.rotTapRate + (ship.rotMaxSpeed - ship.rotTapRate) * blend;
    const driftAim = rampedSlow(ship.driftSlowRot, ship.rotHoldTime);
    ship.rotVel = dir * rate * precision * driftAim;
  } else {
    ship.rotHoldTime = 0;
    ship.driftSlowRot = 1;
    if (!ship.rotInertia) ship.rotVel = 0;
  }
  ship.rotHeldDir = dir;
  if (!trySnapToTarget(ship, dt)) ship.heading += ship.rotVel * dt;
};

// tap-to-nudge feel; thrust ramps in over ~0.15s so a tap barely budges and a hold accelerates fully.
const updateThrustRamp = (ship: Ship, input: IInput, dt: number) => {
  const active = isDown(input, "thrust") || isDown(input, "reverse");
  if (active) ship.thrustRamp = Math.min(1, ship.thrustRamp + dt / 0.15);
  else ship.thrustRamp = 0;
};
const thrustScale = (ship: Ship) => 0.02 + 0.98 * ship.thrustRamp;

// Fuel Mode gate: an engine can only fire if there's fuel left (always true when
// fuel mode is off). Each engine calls this before committing to thrust this frame.
const hasFuel = (ship: Ship) => !FUEL_MODE_ENABLED || ship.fuel > 0;

// Spend fuel for one frame of an engine running at `drainPerSec`, floored at 0.
// No-op when fuel mode is off.
const drainFuel = (ship: Ship, drainPerSec: number, dt: number) => {
  if (!FUEL_MODE_ENABLED) return;
  ship.fuel = Math.max(0, ship.fuel - drainPerSec * dt);
};

// Refill the reserve in discrete once-a-second pulses rather than a smooth
// trickle. The clock only advances on frames the engine isn't already burning
// fuel (an active thrust or laser charge pauses it), and a lump lands each time
// it crosses FUEL_RECHARGE_INTERVAL. A dry engine the player is still holding
// has thrustOn == false (gated by hasFuel), so its frames count toward the
// clock — it sits dead until a lump arrives, fires that lump off in one short
// cough, then waits out the next second. No "fumes mode": the cough is just a
// normal thrust frame that happens to be all the fuel there is.
const rechargeFuel = (ship: Ship, dt: number) => {
  if (!FUEL_MODE_ENABLED) return;
  const thrusting = ship.thrustOn || ship.reverseThrustOn || ship.portThrustOn || ship.starboardThrustOn;
  if (thrusting || ship.laserChargeActive) return;
  if (ship.fuel >= ship.maxFuel) { ship.fuelRechargeClock = 0; return; }
  ship.fuelRechargeClock += dt;
  if (ship.fuelRechargeClock < FUEL_RECHARGE_INTERVAL) return;
  ship.fuelRechargeClock -= FUEL_RECHARGE_INTERVAL;
  ship.fuel = Math.min(ship.maxFuel, ship.fuel + FUEL_RECHARGE * FUEL_RECHARGE_INTERVAL);
};

// Single acceleration path for every engine — push velocity along (heading + offset) with this
// engine's drift-slow baked in. `ramped` applies the forward/reverse tap-ramp; side thrust passes
// false to keep its instant full power. `driftSlow` is the engine's already-ramped drift-aim slow
// (1 = none) so each engine honours only the slow captured on its own press edge.
const applyThrust = (ship: Ship, headingOffset: number, ramped: boolean, driftSlow: number, dt: number, t: number) => {
  const a = ship.thrustPower * (ramped ? thrustScale(ship) : 1) * driftSlow * dt;
  const h = ship.heading + headingOffset;
  ship.vel.x += Math.cos(h) * a;
  ship.vel.y += Math.sin(h) * a;
  ship.lastThrustActiveAt = t / 1000;
};

// advance one engine's drift-slow for this frame: capture from the hovered zone on the press edge
// (was off, now on), otherwise ramp the held slow back toward full. Returns the slow to apply now.
const tickEngineDriftSlow = (
  ship: Ship, on: boolean, was: boolean,
  getHold: () => number, setHold: (v: number) => void,
  getSlow: () => number, setSlow: (v: number) => void, dt: number,
) => {
  if (!on) { setHold(0); setSlow(1); return 1; }
  if (!was) { setHold(0); setSlow(captureThrustSlow(ship)); }
  setHold(getHold() + dt);
  return rampedSlow(getSlow(), getHold());
};

// thruster has to gate sound start/stop on the edge so the loop doesn't restart every frame.
const updateForwardThrust = (ship: Ship, input: IInput, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasThrusting = ship.thrustOn;
  ship.thrustOn = isDown(input, "thrust") && hasFuel(ship);
  const slow = tickEngineDriftSlow(
    ship, ship.thrustOn, wasThrusting,
    () => ship.driftHoldThrust, v => (ship.driftHoldThrust = v),
    () => ship.driftSlowThrust, v => (ship.driftSlowThrust = v), dt,
  );
  if (ship.thrustOn) {
    applyThrust(ship, 0, true, slow, dt, t);
    drainFuel(ship, FUEL_THRUST_DRAIN, dt);
    emitThrust(ship, particles, t);
    if (ENGINE_SOUNDS_ENABLED && !wasThrusting) sound.play("thrust");
  } else if (wasThrusting) sound.stopThrust();
};

// retro-thrust mirrors forward thrust with its own audio loop and front-vented jet flames.
const updateReverseThrust = (ship: Ship, input: IInput, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const wasReversing = ship.reverseThrustOn;
  ship.reverseThrustOn = isDown(input, "reverse") && hasFuel(ship);
  const slow = tickEngineDriftSlow(
    ship, ship.reverseThrustOn, wasReversing,
    () => ship.driftHoldReverse, v => (ship.driftHoldReverse = v),
    () => ship.driftSlowReverse, v => (ship.driftSlowReverse = v), dt,
  );
  if (ship.reverseThrustOn) {
    applyThrust(ship, Math.PI, true, slow, dt, t);
    drainFuel(ship, FUEL_THRUST_DRAIN, dt);
    emitReverseThrust(ship, particles, t);
    if (ENGINE_SOUNDS_ENABLED && !wasReversing) sound.play("reverseThrust");
  } else if (wasReversing) sound.stopReverseThrust();
};

// Lateral thrust — port pushes left of heading, starboard pushes right.
// Gated on the sideEngines powerup (unless SIDE_THRUST_ALWAYS_ON); bound to
// z/x by default. Shares one audio loop that runs while either key is held.
const updateSideThrust = (ship: Ship, input: IInput, particles: ParticleSystem, sound: Sound, dt: number, t: number) => {
  const enabled = (ship.sideEnginesActive || SIDE_THRUST_ALWAYS_ON) && hasFuel(ship);
  const wasActive = ship.portThrustOn || ship.starboardThrustOn;
  const wasPort = ship.portThrustOn;
  const wasStarboard = ship.starboardThrustOn;
  ship.portThrustOn = enabled && isDown(input, "sidePort");
  ship.starboardThrustOn = enabled && isDown(input, "sideStarboard");
  const portSlow = tickEngineDriftSlow(
    ship, ship.portThrustOn, wasPort,
    () => ship.driftHoldPort, v => (ship.driftHoldPort = v),
    () => ship.driftSlowPort, v => (ship.driftSlowPort = v), dt,
  );
  const starboardSlow = tickEngineDriftSlow(
    ship, ship.starboardThrustOn, wasStarboard,
    () => ship.driftHoldStarboard, v => (ship.driftHoldStarboard = v),
    () => ship.driftSlowStarboard, v => (ship.driftSlowStarboard = v), dt,
  );
  if (ship.portThrustOn) {
    applyThrust(ship, -Math.PI / 2, false, portSlow, dt, t);
    drainFuel(ship, FUEL_SIDE_DRAIN, dt);
    emitSideThrust(ship, particles, t, "port");
  }
  if (ship.starboardThrustOn) {
    applyThrust(ship, Math.PI / 2, false, starboardSlow, dt, t);
    drainFuel(ship, FUEL_SIDE_DRAIN, dt);
    emitSideThrust(ship, particles, t, "starboard");
  }
  const isActive = ship.portThrustOn || ship.starboardThrustOn;
  if (ENGINE_SOUNDS_ENABLED && isActive && !wasActive) sound.play("sideThrust");
  else if (!isActive && wasActive) sound.stopSideThrust();
};

// rapid powerup halves the cooldown; both states use the same trigger gate.
// lasershot replaces the per-press bullet emit with hold-to-charge / release-to-fire
// driven by game/laserShot.ts.tickLaserShot — gate the bullet path off entirely here.
const updateFireTrigger = (ship: Ship, input: IInput, bullets: Bullet[]) => {
  if (ship.lasershotActive) return;
  // A banked super-laser charge replaces the next shot with a screen-spanning
  // bolt. The bullet path is suppressed here; the game-level tickSuperLaserFire
  // owns the actual fire (it needs game state the ship module can't see).
  if (ship.superLaserCharged) return;
  if (!isDown(input, "fire")) return;
  if (ship.fireCooldown > 0) return;
  fireBullets(ship, bullets);
  const RAPID_FIRE_RATE_MULTIPLIER = 0.5;
  ship.fireCooldown = ship.rapidActive ? ship.fireRate * RAPID_FIRE_RATE_MULTIPLIER : ship.fireRate;
};

// easing the halo intensity smooths the visual response — snap up on combo gain, slow fade on loss.
const easeComboHaloIntensity = (ship: Ship, dt: number) => {
  const haloTarget = ship.comboHaloTier;
  const rising = haloTarget > ship.comboHaloIntensity;
  const rate = rising ? 14 : 2.5;
  ship.comboHaloIntensity += (haloTarget - ship.comboHaloIntensity) * Math.min(1, rate * dt);
  if (ship.comboLossFlash > 0) ship.comboLossFlash = Math.max(0, ship.comboLossFlash - dt / 0.7);
  if (ship.bonusLifeFlash > 0) ship.bonusLifeFlash = Math.max(0, ship.bonusLifeFlash - dt / 0.4);
};

// velocity cap + screen wrap keep the ship in bounds; drag is 0 so Newtonian drift dominates.
const integrateMotion = (ship: Ship, dt: number, w: number, h: number) => {
  scaleMut(ship.vel, 1 - ship.drag * dt);
  const speed = Math.hypot(ship.vel.x, ship.vel.y);
  if (TOP_SPEED_ENABLED && speed > ship.maxSpeed) scaleMut(ship.vel, ship.maxSpeed / speed);
  addScaledMut(ship.pos, ship.vel, dt);
  const off = wrapMut(ship.pos, w, h);
  if (off) {
    ship.lastWrapDX = off.x;
    ship.lastWrapDY = off.y;
  }
};

// one frame's worth of player control, audio, and motion — keeps Ship.update one-line readable.
export const tickShip = (
  ship: Ship, dt: number, input: IInput,
  particles: ParticleSystem, bullets: Bullet[],
  w: number, h: number, t: number, sound: Sound,
) => {
  ship.lastWrapDX = 0;
  ship.lastWrapDY = 0;
  if (!ship.alive) return;
  if (ship.invuln > 0) ship.invuln -= dt;
  if (ship.fireCooldown > 0) ship.fireCooldown -= dt;
  easeComboHaloIntensity(ship, dt);
  updateTurning(ship, input, dt);
  updateThrustRamp(ship, input, dt);
  updateForwardThrust(ship, input, particles, sound, dt, t);
  updateReverseThrust(ship, input, particles, sound, dt, t);
  updateSideThrust(ship, input, particles, sound, dt, t);
  rechargeFuel(ship, dt);
  updateFireTrigger(ship, input, bullets);
  integrateMotion(ship, dt, w, h);
};
