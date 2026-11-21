import type { Ship } from "../Ship";
import { BEAT_GRID, BEAT_WINDOW } from "./rhythmConstants";

// The Warp Cannon's held charge, kept free of game imports so the ship, the
// bullet and the renderer can all read it without an import cycle.
//
// Like the laser, the Warp Cannon is held to charge and fires on release: the
// tiers tick in after 2, 4 and 8 beats held (WARP_TIER_BEATS), up to
// WARP_MAX_CHARGE. The tier sets the pellet's size and how big a body it can swallow whole (warpCannon.warpBite).
// Press and release are plain trigger edges (shipPhysics.updateWarpTrigger),
// so the release is judged on-beat like any other volley (a tap: either edge).
export const WARP_MAX_CHARGE = 3;

// Pellet mouth (its hitbox) by tier, against a stock shot's hit radius: a tap
// fires a teeny pellet, a full charge one about the size of a medium rock.
// Even an on-beat pellet stays well inside the biggest rock its tier swallows
// whole (warpCannon.warpBite), so it reads as a hole a body falls into, not a
// lid over it.
const PELLET_SCALE = [0.34, 0.55, 0.8, 1.15];
export const warpPelletScale = (charge: number): number =>
  PELLET_SCALE[Math.max(0, Math.min(WARP_MAX_CHARGE, charge))];

// Beats held so far, shifted a beat window early so a press on one beat and a
// release on a later one counts every beat between, whichever side of the
// beat each edge fell. `beatTime` is the perceived clock the press was stamped on.
const beatsHeld = (ship: Ship, beatTime: number): number =>
  (beatTime - ship.warpChargeStartBeatTime + BEAT_WINDOW) / BEAT_GRID;

// Beats held at which each tier past 0 lands.
const WARP_TIER_BEATS = [2, 4, 8];

// Tiers charged by `beatTime`.
export const warpChargeAt = (ship: Ship, beatTime: number): number => {
  if (!ship.warpChargeActive) return 0;
  const held = beatsHeld(ship, beatTime);
  return WARP_TIER_BEATS.filter((b) => held >= b).length;
};

// 0→1 progress toward the next tier (0 once fully charged), for the swell.
export const warpChargeToNext = (ship: Ship, beatTime: number): number => {
  const charge = warpChargeAt(ship, beatTime);
  if (!ship.warpChargeActive || charge >= WARP_MAX_CHARGE) return 0;
  const from = charge === 0 ? 0 : WARP_TIER_BEATS[charge - 1];
  const to = WARP_TIER_BEATS[charge];
  return Math.max(0, Math.min(1, (beatsHeld(ship, beatTime) - from) / (to - from)));
};

// A release this soon after the press is a tap: its rhythm is the press, so
// either edge landing on the beat counts (classifyNewBullets).
export const WARP_TAP_SEC = 0.25;
export const warpReleaseWasTap = (ship: Ship, beatTime: number): boolean =>
  beatTime - ship.warpChargeStartBeatTime <= WARP_TAP_SEC;

// The Warp Cannon's voices (Sound.buildFireWarpGraph, buildWarpSwallowGraph)
// are keyed by a tier, which picks the register, and the beat in the bar,
// which picks one of three chord tones (low, middle, high, middle). A run of
// shots walks an arpeggio in time with the music, and each swallow plays back
// the note of the shot that made it.
export const WARP_CHORD_TONES = 3;
export const WARP_VOICE_KEYS = (WARP_MAX_CHARGE + 1) * WARP_CHORD_TONES;
const TONE_BY_BEAT = [0, 1, 2, 1];
export const warpVoiceKey = (tier: number, beatTime: number): number => {
  const beat = Math.round(beatTime / BEAT_GRID);
  return tier * WARP_CHORD_TONES + TONE_BY_BEAT[((beat % 4) + 4) % 4];
};

// Drop a charge in progress without firing it: whenever the warp trigger
// isn't the one handling fire (a swap to bomb or laser, a live mine, a
// banked super-laser), so a stale charge can never fire on a later frame.
export const cancelWarpCharge = (ship: Ship): void => {
  ship.warpChargeActive = false;
};
