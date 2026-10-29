import type { Game } from "../Game";
import type { Alien } from "../Alien";
import { toroidalDelta, wrapMut } from "../vec";
import { rng } from "./rng";
import { ENTITY_CONFIG as CFG } from "./entityConfig";
import { BEAT_GRID } from "./rhythmConstants";
import {
  Wormhole,
  spawnWormhole,
  wormholeEnterable,
  throatPointOf,
  WORMHOLE_CLOSE,
  WARP_OUT_DURATION,
} from "./wormhole";
import { isBossWave } from "./waveDirector";
import { advanceWave, showWaveAnnounce } from "./gameUpdate";
import { emitCrackParticles } from "./particleBursts";
import { completeEntrance, shiftEntranceFrames } from "./entrance";
import { newWaveEventSchedule } from "./waveEvents";

// The wave-skip warp. A player-killed alien tears open a lingering
// portal at its death spot; flying into it ends the wave on the spot and jumps
// ahead — one wave for a small alien, up to five for a big one, never past a
// boss wave. The ship dives down the throat and stays gone through the normal
// wave summary plus a title cascade (each skipped wave's "Wave N" announce
// appears and fades in turn); the landing wave then spawns exactly as any wave
// does, and a few beats later a return portal blooms where the ship vanished
// and it climbs back out.
//
// Ownership is deliberately flat: entering a portal makes ONE call to the
// existing advanceWave — with a farther target wave and the spawn pushed out
// by the cascade's length — and the summary/transition pipeline runs entirely
// unmodified. advanceWave collapses every skip portal as its first act, so a
// portal can never be entered while a transition is in flight and nothing ever
// retargets mid-flight. The ship rides the same alive=false gates the death
// state uses, so no sim system needs a new "warping" check.
//
// Everything here ticks on musicDt / beatTime inside updatePlaying and rolls
// randomness on the seeded gameplay stream, so replays re-sim the whole
// sequence deterministically.

// A skip portal record: the shared visual in game.wormholes plus the skip
// depth rolled at spawn.
export type SkipPortal = {
  wormhole: Wormhole;
  skip: number;
};

export type WaveSkipState = {
  phase: "dive" | "hidden" | "emerge";
  // 0→1 progress through the current cosmetic phase (dive / emerge).
  t: number;
  diveFrom: { x: number; y: number };
  diveTo: { x: number; y: number };
  // The portal the ship is riding — the dive portal on the way in, swapped to
  // the emerge portal on the way out. The renderer draws the hull through this
  // portal's lens so it smears and fades as it passes through. null while the
  // ship is fully hidden between the two.
  cropPortal: Wormhole | null;
  // One announce per skipped-past wave (internal numbering), ascending. The
  // landing wave's own announce fires with its spawn, as on any wave.
  titles: Array<{ atBeat: number; wave: number }>;
  // The landing wave's title (fired by advanceWave's deferred spawn) is DOM-only;
  // ring its cascade chime here so the wave you actually arrive at sounds like
  // the skipped ones did. Nulled once played.
  landingChimeBeat: number | null;
  emergePortalBeat: number;
  emergeShipBeat: number;
  emergePortalSpawned: boolean;
};

const skipCfg = () => CFG.skipWormhole;

// A player kill tears a skip portal aligned to the alien's flight path. Not in
// the beta/tutorial sandboxes, not once the wave is already over, and never on
// a boss wave — the portal must not shortcut the boss fight.
export const maybeSpawnSkipPortal = (game: Game, al: Alien) => {
  if (game.betaMode || game.tutorialActive || game.waveTransitioning) return;
  if (isBossWave(game.wave)) return;
  const [lo, hi] = skipCfg().skips[al.size];
  const skip = lo + Math.floor(rng() * (hi - lo + 1));
  const wormhole = spawnWormhole(game.wormholes, al.pos, al.radius, al.warpHeading, {
    holdSec: skipCfg().lifetimeBeats * BEAT_GRID,
  });
  game.skipPortals.push({ wormhole, skip });
  game.sound.play("canisterAppear", 1, al.pos);
};

// Cut every open skip portal down to its collapse so it irises shut on screen.
// advanceWave calls this the moment a wave ends, which is what makes "portal
// entered mid-transition" structurally impossible.
export const collapseSkipPortals = (game: Game) => {
  for (const p of game.skipPortals) {
    p.wormhole.life = Math.min(p.wormhole.life, WORMHOLE_CLOSE);
  }
  game.skipPortals = [];
};

export const resetWaveSkip = (game: Game) => {
  game.waveSkip = null;
  game.skipPortals = [];
  game.ship.skipWarpT = null;
};

// Landing wave for a skip taken now. Walks the span so the first boss wave in
// range absorbs the skip — the player always faces every boss.
const landingWaveFor = (game: Game, skip: number): number => {
  const next = game.wave + 1;
  const landing = next + skip;
  for (let w = next; w <= landing; w++) {
    if (isBossWave(w)) return w;
  }
  return landing;
};

// The wave is over the moment the ship commits to the portal — sweep the
// leftovers. Rocks puff away (no score: nothing was killed); aliens and comets
// leave through their own departure portals; a pending mid-wave spawn event
// must not fire into the empty summary field.
const sweepFieldForSkip = (game: Game) => {
  for (const a of game.asteroids) emitCrackParticles(game.particles, a, true);
  game.asteroids = [];
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllWarbleDrones();
  for (const al of game.aliens) {
    completeEntrance(al);
    al.maxTravel = -1;
  }
  for (const c of game.comets) {
    completeEntrance(c);
    c.age = Math.max(c.age, c.lifetime);
  }
  game.alienBullets = [];
  game.waveEvents = newWaveEventSchedule();
};

const beginWaveSkip = (game: Game, portal: SkipPortal) => {
  const ship = game.ship;
  const landing = landingWaveFor(game, portal.skip);
  const skipped = landing - (game.wave + 1);
  const cadenceSec = skipCfg().titleCadenceBeats * BEAT_GRID;
  // Titles for the skipped waves are queued off the wave being completed —
  // capture it before the transition (whose spawn closure moves game.wave).
  const completedWave = game.wave;
  const schedule = advanceWave(game, landing, skipped * cadenceSec);
  // advanceWave collapsed every skip portal; re-extend this one so its mouth
  // stays open while the ship falls through it.
  portal.wormhole.life = WORMHOLE_CLOSE + WARP_OUT_DURATION;
  sweepFieldForSkip(game);
  ship.vel.x = 0;
  ship.vel.y = 0;
  ship.thrustOn = false;
  ship.reverseThrustOn = false;
  ship.portThrustOn = false;
  ship.starboardThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
  ship.alive = false;
  ship.skipWarpT = 0;
  const throat = throatPointOf(portal.wormhole);
  const [tdx, tdy] = toroidalDelta(throat.x - ship.pos.x, throat.y - ship.pos.y, game.w, game.h);
  const normalSpawnBeat = schedule.spawnBeat - skipped * cadenceSec;
  const titles: Array<{ atBeat: number; wave: number }> = [];
  for (let i = 0; i < skipped; i++) {
    titles.push({ atBeat: normalSpawnBeat + i * cadenceSec, wave: completedWave + 1 + i });
  }
  game.waveSkip = {
    phase: "dive",
    t: 0,
    diveFrom: { x: ship.pos.x, y: ship.pos.y },
    diveTo: { x: ship.pos.x + tdx, y: ship.pos.y + tdy },
    cropPortal: portal.wormhole,
    titles,
    landingChimeBeat: schedule.spawnBeat,
    emergePortalBeat: schedule.spawnBeat + skipCfg().emergeDelayBeats * BEAT_GRID,
    emergeShipBeat: schedule.spawnBeat + (skipCfg().emergeDelayBeats + skipCfg().emergeRideBeats) * BEAT_GRID,
    emergePortalSpawned: false,
  };
};

const tryEnterSkipPortal = (game: Game) => {
  if (!game.ship.alive || game.waveTransitioning) return;
  for (const p of game.skipPortals) {
    const wh = p.wormhole;
    if (!wormholeEnterable(wh)) continue;
    const [dx, dy] = toroidalDelta(wh.x - game.ship.pos.x, wh.y - game.ship.pos.y, game.w, game.h);
    if (Math.hypot(dx, dy) > wh.radius * skipCfg().entryRadiusFrac) continue;
    beginWaveSkip(game, p);
    return;
  }
};

// The single owner of the warp sequence, ticked from updatePlaying right after
// tickWaveTransition (so the landing spawn always lands before the emerge
// beats it anchors are checked).
export const tickWaveSkip = (game: Game, musicDt: number) => {
  const warp = game.waveSkip;
  if (warp === null) {
    game.skipPortals = game.skipPortals.filter((p) => p.wormhole.life > 0);
    tryEnterSkipPortal(game);
    return;
  }
  const ship = game.ship;
  // Pop cascade titles as their beat slots arrive. The announce is cosmetic
  // DOM, but it fires off the beat clock so the cadence reproduces in replays.
  while (warp.titles.length > 0 && game.beatTime >= warp.titles[0].atBeat) {
    showWaveAnnounce(game, warp.titles.shift()!.wave);
    game.sound.play("chime");
  }
  // The landing wave's DOM title is fired by advanceWave's deferred spawn; ring
  // its chime the moment that beat arrives so it matches the cascade above.
  if (warp.landingChimeBeat !== null && game.beatTime >= warp.landingChimeBeat) {
    game.sound.play("chime");
    warp.landingChimeBeat = null;
  }
  if (warp.phase === "dive") {
    warp.t = Math.min(1, warp.t + musicDt / WARP_OUT_DURATION);
    const ease = warp.t * warp.t;
    ship.pos.x = warp.diveFrom.x + (warp.diveTo.x - warp.diveFrom.x) * ease;
    ship.pos.y = warp.diveFrom.y + (warp.diveTo.y - warp.diveFrom.y) * ease;
    const fold = wrapMut(ship.pos, game.w, game.h);
    if (fold) {
      warp.diveFrom.x += fold.x;
      warp.diveFrom.y += fold.y;
      warp.diveTo.x += fold.x;
      warp.diveTo.y += fold.y;
      shiftEntranceFrames(game, fold.x, fold.y);
    }
    ship.skipWarpT = warp.t;
    if (warp.t >= 1) {
      warp.phase = "hidden";
      ship.skipWarpT = null;
      warp.cropPortal = null;
    }
    return;
  }
  if (warp.phase === "hidden") {
    if (!warp.emergePortalSpawned && game.beatTime >= warp.emergePortalBeat) {
      const emerge = spawnWormhole(game.wormholes, ship.pos, skipCfg().emergePortalBodyRadius, ship.heading, {
        holdSec: skipCfg().emergeRideBeats * BEAT_GRID + skipCfg().emergeSec + 0.5,
      });
      warp.cropPortal = emerge;
      game.sound.play("canisterAppear", 1, ship.pos);
      warp.emergePortalSpawned = true;
    }
    if (game.beatTime >= warp.emergeShipBeat) {
      // Visible again ⇒ tangible again (alive), just under respawn grace.
      ship.alive = true;
      ship.invuln = Math.max(ship.invuln, skipCfg().invulnOnEmerge);
      ship.skipWarpT = 1;
      warp.phase = "emerge";
      warp.t = 1;
      game.sound.play("pulsarHum", 1, ship.pos);
    }
    return;
  }
  // emerge — the outbound dive run backwards, purely cosmetic; control and
  // collisions are already live.
  warp.t = Math.max(0, warp.t - musicDt / skipCfg().emergeSec);
  ship.skipWarpT = warp.t;
  if (warp.t <= 0) {
    ship.skipWarpT = null;
    game.waveSkip = null;
  }
};
