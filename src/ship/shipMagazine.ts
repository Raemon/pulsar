import type { Ship } from "../Ship";
import { BEAT_GRID, BEAT_WINDOW } from "../game/rhythmConstants";

// Two shots; each restarts a 4-beat reload that refills both. The laser and a banked
// super-laser fire outside the magazine.
export const MAGAZINE_SIZE = 2;
export const MAGAZINE_RELOAD_BEATS = 4;

const REFILL_FLASH_SEC = 0.4;
const SPENT_FLASH_SEC = 0.16;

// A beat counts from when its on-beat window opens, so an early press on the refill beat lands.
const openedBeat = (beatTime: number) => Math.floor((beatTime + BEAT_WINDOW) / BEAT_GRID);

export const magazineBlocksFire = (ship: Ship) => ship.shotsLoaded === 0 && !ship.superLaserCharged;

export const spendShot = (ship: Ship, beatTime: number) => {
  ship.shotsLoaded -= 1;
  ship.magazineSpentFlash = 1;
  ship.magazineReloadBeat = openedBeat(beatTime) + MAGAZINE_RELOAD_BEATS;
};

const refillOnReloadBeat = (ship: Ship, beatTime: number) => {
  if (ship.shotsLoaded === MAGAZINE_SIZE || openedBeat(beatTime) < ship.magazineReloadBeat) return;
  ship.shotsLoaded = MAGAZINE_SIZE;
  ship.magazineRefillFlash = 1;
};

export const tickMagazine = (ship: Ship, dt: number, beatTime: number) => {
  refillOnReloadBeat(ship, beatTime);
  ship.magazineRefillFlash = Math.max(0, ship.magazineRefillFlash - dt / REFILL_FLASH_SEC);
  ship.magazineSpentFlash = Math.max(0, ship.magazineSpentFlash - dt / SPENT_FLASH_SEC);
};
