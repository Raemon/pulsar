import type { Ship } from "../Ship";
import { BEAT_GRID, BEAT_WINDOW } from "../game/rhythmConstants";

// Two shots, each reloading on its own three beats after it was fired. The laser and a banked
// super-laser fire outside the magazine.
export const MAGAZINE_SIZE = 2;
export const MAGAZINE_RELOAD_BEATS = 3;

const SPENT_FLASH_SEC = 0.16;

// readyBeat and loaded are sim state; beatsToReady and spentFlash only drive the render.
export type Pylon = { loaded: boolean; readyBeat: number; beatsToReady: number; spentFlash: number };

export const newPylons = (): Pylon[] => Array.from({ length: MAGAZINE_SIZE }, () => (
  { loaded: true, readyBeat: -Infinity, beatsToReady: -Infinity, spentFlash: 0 }
));

// A beat counts from when its on-beat window opens, so an early press on the reload beat lands.
const openedBeat = (beatTime: number) => Math.floor((beatTime + BEAT_WINDOW) / BEAT_GRID);

export const magazineBlocksFire = (ship: Ship) =>
  !ship.pylons.some(p => p.loaded) && !ship.superLaserCharged;

// Fires from the starboard pylon first, so the round that left first comes back first.
const nextLoadedPylon = (ship: Ship): Pylon | undefined => {
  for (let i = ship.pylons.length - 1; i >= 0; i--) if (ship.pylons[i].loaded) return ship.pylons[i];
  return undefined;
};

export const spendShot = (ship: Ship, beatTime: number) => {
  const pylon = nextLoadedPylon(ship);
  if (!pylon) return;
  pylon.loaded = false;
  pylon.spentFlash = 1;
  pylon.readyBeat = openedBeat(beatTime) + MAGAZINE_RELOAD_BEATS;
};

const tickPylon = (pylon: Pylon, dt: number, beatTime: number) => {
  if (!pylon.loaded && openedBeat(beatTime) >= pylon.readyBeat) pylon.loaded = true;
  pylon.beatsToReady = pylon.readyBeat - beatTime / BEAT_GRID;
  pylon.spentFlash = Math.max(0, pylon.spentFlash - dt / SPENT_FLASH_SEC);
};

export const tickMagazine = (ship: Ship, dt: number, beatTime: number) => {
  for (const pylon of ship.pylons) tickPylon(pylon, dt, beatTime);
};
