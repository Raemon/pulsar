import type { Game } from "../Game";
import type { Vec } from "../vec";
import { toroidalDelta } from "../ship/reticule/coneGeometry";

// How fast the pulsar layer (pulsar, planets, spectrum halo) scrolls relative
// to the camera. It slides slower than gameplay entities, a distant body, but
// nearer than the twinkling star layers at STARFIELD_PARALLAX.
export const PULSAR_PARALLAX = 0.62;

// Map a point drawn in the pulsar layer's own coordinates to the world point
// that is on screen at the same spot. The pulsar layer scrolls at
// PULSAR_PARALLAX of the camera while the world scrolls 1:1, so this is how
// something born out of the sky (a boss body) lands exactly where the player
// saw it.
export const skyToWorld = (game: Game, p: Vec): Vec => {
  const camX = game.w / 2 - game.ship.pos.x;
  const camY = game.h / 2 - game.ship.pos.y;
  const wrap = (n: number, m: number) => ((n % m) + m) % m;
  return {
    x: wrap(p.x + game.camScrollX * PULSAR_PARALLAX - camX, game.w),
    y: wrap(p.y + game.camScrollY * PULSAR_PARALLAX - camY, game.h),
  };
};

// An act's boss body as it currently appears in the sky: its world position and
// drawn radius.
export const bossBodyInWorld = (game: Game, act: number): { pos: Vec; size: number } => {
  const view = game.pulsar.bossBodyView(act);
  return { pos: skyToWorld(game, view), size: view.size };
};

// Advance the continuous camera (Game.camScroll*). It runs in the sim step,
// not the render pass, because the boss spawn reads it through skyToWorld and
// replays re-sim without rendering. The ship's
// gameplay position wraps each frame, so we can't difference it directly — we
// take the step toroidally (a wrap reads as a small move, not a ±w jump) and
// integrate it. Seeded to the exact `w/2 - ship.pos` on the first frame (and
// after a resize/teleport, detected by an out-of-torus jump) so the camera is
// pixel-identical to the old math except that it never snaps.
export const updateCamScroll = (game: Game) => {
  const { w, h, ship } = game;
  const seed = () => {
    game.camScrollX = w / 2 - ship.pos.x;
    game.camScrollY = h / 2 - ship.pos.y;
  };
  if (game.lastShipPosX === null || game.lastShipPosY === null) {
    seed();
  } else {
    const [dx, dy] = toroidalDelta(ship.pos.x - game.lastShipPosX, ship.pos.y - game.lastShipPosY, w, h);
    // A step larger than a wrapped frame's worth means a respawn/teleport, not
    // motion — reseed rather than smear a huge slide across the field.
    if (Math.hypot(dx, dy) > Math.min(w, h) * 0.25) seed();
    else {
      game.camScrollX -= dx;
      game.camScrollY -= dy;
    }
  }
  game.lastShipPosX = ship.pos.x;
  game.lastShipPosY = ship.pos.y;
};


// Reseed the camera on the next sim step. Called at run start so a live run
// and its replay integrate the scroll from the same origin.
export const resetCamScroll = (game: Game) => {
  game.lastShipPosX = null;
  game.lastShipPosY = null;
};
