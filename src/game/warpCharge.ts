import type { Ship } from "../Ship";
import { BEAT_GRID, BEAT_WINDOW } from "./rhythmConstants";

// The Warp Cannon's held charge, kept free of game imports so the ship, the
// bullet and the renderer can all read it without an import cycle.
//
// Like the laser, the Warp Cannon is held to charge and fires on release: one
// charge tier ticks in per beat held, up to WARP_MAX_CHARGE. The tier sets the
// pellet's size and how big a body it can swallow whole (warpCannon.warpBite).
// Press and release are plain trigger edges (shipPhysics.updateWarpTrigger),
// so the release is judged on-beat like any other volley.
export const WARP_MAX_CHARGE = 3;

// Pellet mouth (its hitbox) by tier, against a stock shot's hit radius: a tap
// fires a teeny pellet, a full charge a hole wider than a medium rock.
const PELLET_SCALE = [0.5, 1, 1.5, 2.1];
export const warpPelletScale = (charge: number): number =>
  PELLET_SCALE[Math.max(0, Math.min(WARP_MAX_CHARGE, charge))];

// Beats held so far, shifted a beat window early so a press on one beat and a
// release on a later one counts every beat between, whichever side of the
// beat each edge fell. `beatTime` is the perceived clock the press was stamped on.
const beatsHeld = (ship: Ship, beatTime: number): number =>
  (beatTime - ship.warpChargeStartBeatTime + BEAT_WINDOW) / BEAT_GRID;

// Tiers charged by `beatTime`.
export const warpChargeAt = (ship: Ship, beatTime: number): number =>
  ship.warpChargeActive ? Math.max(0, Math.min(WARP_MAX_CHARGE, Math.floor(beatsHeld(ship, beatTime)))) : 0;

// 0→1 progress toward the next tier (0 once fully charged), for the swell.
export const warpChargeToNext = (ship: Ship, beatTime: number): number => {
  if (!ship.warpChargeActive || warpChargeAt(ship, beatTime) >= WARP_MAX_CHARGE) return 0;
  const held = Math.max(0, beatsHeld(ship, beatTime));
  return held - Math.floor(held);
};

// Drop a charge in progress without firing it: whenever the warp trigger
// isn't the one handling fire (a swap to bomb or laser, a live mine, a
// banked super-laser), so a stale charge can never fire on a later frame.
export const cancelWarpCharge = (ship: Ship): void => {
  ship.warpChargeActive = false;
};
