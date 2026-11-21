import type { Ship } from "../Ship";
import { BEAT_GRID, BEAT_WINDOW } from "../game/rhythmConstants";

// Two shots, each reloading on its own: two silent beats after firing, a beat of visible
// recharge, then ready. The laser and a banked super-laser fire outside the magazine.
export const MAGAZINE_SIZE = 2;
export const MAGAZINE_RELOAD_BEATS = 4;

// The bomb and the Warp Cannon each fire from a single round of their own instead.
// The bomb's comes back a beat after the mine is gone; the Warp Cannon's takes a
// beat per charge tier the shot carried (a tap is back on the next beat).
export const BOMB_RELOAD_BEATS = 1;
export const warpReloadBeats = (charge: number) => charge + 1;

const SPENT_FLASH_SEC = 0.16;

// readyBeat and loaded are sim state; beatsToReady and spentFlash only drive the render.
export type Pylon = { loaded: boolean; readyBeat: number; beatsToReady: number; spentFlash: number };

const newPylon = (): Pylon => ({ loaded: true, readyBeat: -Infinity, beatsToReady: -Infinity, spentFlash: 0 });
export const newPylons = (): Pylon[] => Array.from({ length: MAGAZINE_SIZE }, newPylon);
export const newSpecialPylon = newPylon;

export const firesSpecialRound = (ship: Ship) => ship.bombActive || ship.warpCannonActive;

// A beat counts from when its on-beat window opens, so an early press on the reload beat lands.
const openedBeat = (beatTime: number) => Math.floor((beatTime + BEAT_WINDOW) / BEAT_GRID);

export const magazineBlocksFire = (ship: Ship) => {
  if (ship.superLaserCharged) return false;
  if (firesSpecialRound(ship)) return !ship.specialPylon.loaded;
  return !ship.pylons.some(p => p.loaded);
};

// Fires from the starboard pylon first, so the round that left first comes back first.
const nextLoadedPylon = (ship: Ship): Pylon | undefined => {
  if (firesSpecialRound(ship)) return ship.specialPylon.loaded ? ship.specialPylon : undefined;
  for (let i = ship.pylons.length - 1; i >= 0; i--) if (ship.pylons[i].loaded) return ship.pylons[i];
  return undefined;
};

const shotReloadBeats = (ship: Ship, warpCharge: number) =>
  ship.warpCannonActive ? warpReloadBeats(warpCharge) : ship.bombActive ? BOMB_RELOAD_BEATS : MAGAZINE_RELOAD_BEATS;

export const spendShot = (ship: Ship, beatTime: number, warpCharge = 0) => {
  const pylon = nextLoadedPylon(ship);
  if (!pylon) return;
  pylon.loaded = false;
  pylon.spentFlash = 1;
  pylon.readyBeat = openedBeat(beatTime) + shotReloadBeats(ship, warpCharge);
};

// While a mine is out its round can't come back: the reload starts once it's gone.
export const holdSpecialRoundForBomb = (ship: Ship, beatTime: number) => {
  const pylon = ship.specialPylon;
  pylon.loaded = false;
  pylon.readyBeat = Math.max(pylon.readyBeat, openedBeat(beatTime) + BOMB_RELOAD_BEATS);
};

const tickPylon = (pylon: Pylon, dt: number, beatTime: number) => {
  if (!pylon.loaded && openedBeat(beatTime) >= pylon.readyBeat) pylon.loaded = true;
  pylon.beatsToReady = pylon.readyBeat - beatTime / BEAT_GRID;
  pylon.spentFlash = Math.max(0, pylon.spentFlash - dt / SPENT_FLASH_SEC);
};

export const tickMagazine = (ship: Ship, dt: number, beatTime: number) => {
  for (const pylon of ship.pylons) tickPylon(pylon, dt, beatTime);
  tickPylon(ship.specialPylon, dt, beatTime);
};
