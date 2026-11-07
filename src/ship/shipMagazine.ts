import type { Ship } from "../Ship";
import { BEAT_GRID, BEAT_WINDOW } from "../game/rhythmConstants";

// The ship carries two shots, slung as missiles either side of the hull. Each
// stock shot (bullet, bomb throw, warp shell) spends one; every shot restarts
// the reload, and both come back together MAGAZINE_RELOAD_BEATS quarter-note
// beats after the beat of the last shot. The laser keeps its own refire lockout
// and a banked super-laser isn't a magazine shot, so neither draws from it.
export const MAGAZINE_SIZE = 2;
export const MAGAZINE_RELOAD_BEATS = 4;

// Seconds for the refill pulse and for a spent missile's launch flare to fade.
const REFILL_FLASH_DECAY = 0.6;
const SPENT_FLASH_DECAY = 0.16;
// Rate the empty pylons' count-in fill eases toward each beat's step.
const RELOAD_FILL_RATE = 18;

export const usesMagazine = (ship: Ship): boolean => !ship.lasershotActive;

// Whole beats begun since the last shot's beat. A beat counts from the moment
// its on-beat window opens, so the refill beat's window is live end to end: an
// early press on it lands, and a held trigger refires on the beat, not before.
const beatsSinceLastShot = (ship: Ship, beatTime: number): number =>
  Math.floor((beatTime + BEAT_WINDOW) / BEAT_GRID) - (ship.magazineReloadBeat - MAGAZINE_RELOAD_BEATS);

export const spendShot = (ship: Ship, beatTime: number) => {
  ship.shotsLoaded -= 1;
  ship.missileSpentFlash[ship.shotsLoaded] = 1;
  ship.magazineReloadBeat = Math.round(beatTime / BEAT_GRID) + MAGAZINE_RELOAD_BEATS;
  ship.magazineReloadFill = 0;
};

// Runs before the fire trigger each tick, so a press on the refill beat fires.
export const tickMagazine = (ship: Ship, beatTime: number, dt: number) => {
  if (ship.shotsLoaded < MAGAZINE_SIZE) {
    const beats = beatsSinceLastShot(ship, beatTime);
    if (beats >= MAGAZINE_RELOAD_BEATS) {
      ship.shotsLoaded = MAGAZINE_SIZE;
      ship.magazineRefillFlash = 1;
      ship.magazineReloadFill = 1;
    } else {
      const target = Math.max(0, beats) / MAGAZINE_RELOAD_BEATS;
      ship.magazineReloadFill += (target - ship.magazineReloadFill) * Math.min(1, RELOAD_FILL_RATE * dt);
    }
  }
  ship.magazineRefillFlash = Math.max(0, ship.magazineRefillFlash - dt / REFILL_FLASH_DECAY);
  for (let i = 0; i < MAGAZINE_SIZE; i++) {
    ship.missileSpentFlash[i] = Math.max(0, ship.missileSpentFlash[i] - dt / SPENT_FLASH_DECAY);
  }
};
