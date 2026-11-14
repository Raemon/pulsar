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
// fires a teeny pellet, a full charge one about the size of a medium rock.
// Even an on-beat pellet stays well inside the biggest rock its tier swallows
// whole (warpCannon.warpBite), so it reads as a hole a body falls into, not a
// lid over it.
const PELLET_SCALE = [0.4, 0.65, 0.95, 1.35];
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

// A release this soon after the press is a tap: its rhythm is the press, so
// either edge landing on the beat counts (classifyNewBullets).
export const WARP_TAP_SEC = 0.25;
export const warpReleaseWasTap = (ship: Ship, beatTime: number): boolean =>
  beatTime - ship.warpChargeStartBeatTime <= WARP_TAP_SEC;

// The muzzle voice's bake key (Sound.buildFireWarpGraph): the tier picks the
// register, and the beat in the bar picks the chord tone (root, third, fifth,
// third), so a run of shots walks an arpeggio in time with the music.
export const FIRE_WARP_TONES = 3;
export const FIRE_WARP_KEYS = (WARP_MAX_CHARGE + 1) * FIRE_WARP_TONES;
const TONE_BY_BEAT = [0, 1, 2, 1];
export const fireWarpKey = (charge: number, beatTime: number): number => {
  const beat = Math.round(beatTime / BEAT_GRID);
  return charge * FIRE_WARP_TONES + TONE_BY_BEAT[((beat % 4) + 4) % 4];
};

// Drop a charge in progress without firing it: whenever the warp trigger
// isn't the one handling fire (a swap to bomb or laser, a live mine, a
// banked super-laser), so a stale charge can never fire on a later frame.
export const cancelWarpCharge = (ship: Ship): void => {
  ship.warpChargeActive = false;
};
