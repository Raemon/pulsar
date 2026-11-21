// Fuel Mode — optional survival layer where thrusting drains a fuel reserve
// that slowly refills, and fuel orbs (dropped by gold gems that don't pay out
// an upgrade) top it back up. Flip FUEL_MODE_ENABLED off to remove every fuel
// cost, hide the HUD bar, and stop fuel orbs from spawning.
export const FUEL_MODE_ENABLED = false;

export const FUEL_MAX = 100;
// drain per second of held forward / reverse thrust at full ramp.
export const FUEL_THRUST_DRAIN = 3;
// side engines are cheaper than the main drive so strafing stays affordable.
export const FUEL_SIDE_DRAIN = 1;
// passive refill per second whenever the reserve isn't full — delivered as one
// lump every FUEL_RECHARGE_INTERVAL seconds rather than a smooth per-frame
// trickle. The pulsing is imperceptible at full tank but is what makes a dry
// engine cough once a second: it sits empty until a lump lands, fires that lump
// off in one short burst, then waits out the next interval.
export const FUEL_RECHARGE = 1;
export const FUEL_RECHARGE_INTERVAL = 1;
// fraction of FUEL_MAX a single fuel orb restores.
export const FUEL_ORB_RESTORE = 75;

// Laser (lasershot upgrade) fuel costs. Holding to charge sips fuel slowly —
// less than a side engine — so defensive charging stays affordable; the charge
// is rhythm-capped at a few beats so the hold is short anyway. Firing then pays
// a per-shot toll that scales with how many dots you charged, so an uncharged
// tap is near-free while a maxed melt-everything beam takes a real bite out of
// the tank and competes with movement for the reserve.
export const FUEL_LASER_CHARGE_DRAIN = 4;
export const FUEL_LASER_FIRE_BASE = 2;
export const FUEL_LASER_FIRE_PER_DOT = 4;

// Fuel a laser shot of `dots` charge costs to fire (on top of the charge sip).
export const laserFireFuelCost = (dots: number): number =>
  FUEL_LASER_FIRE_BASE + FUEL_LASER_FIRE_PER_DOT * dots;

// Spend fuel off a ship's reserve, floored at 0 — no-op when fuel mode is off.
// Structural type so callers outside shipPhysics (the laser) can drain without
// importing Ship. Unlike thrust, the laser never hard-blocks on empty: a broke
// ship still fires, it just can't also maneuver, rather than going defenceless.
export const spendShipFuel = (ship: { fuel: number }, amount: number) => {
  if (!FUEL_MODE_ENABLED) return;
  ship.fuel = Math.max(0, ship.fuel - amount);
};
