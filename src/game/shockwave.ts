import type { Game } from "../Game";
import { toroidalDelta } from "../vec";
import { completeEntrance } from "./entrance";
import { Asteroid } from "../Asteroid";
import { emitExplosion, emitShockwaveSparks } from "./particleBursts";
import { alignBassBeat, alignSplitChildToRhythm, newBeatClaimSet, BeatClaimSet } from "./waveDirector";
import { ENTITY_CONFIG } from "./entityConfig";

const SW = ENTITY_CONFIG.shockwave;

// Arms the pulsar; the rumble itself starts on the next beat tick, at which
// point pulsar.shockVibrateJustStarted flips and the charge sound plays.
export const startShockwave = (game: Game) => {
  game.pulsar.triggerShockwave();
};

// instant-killing the boss via environment would feel cheap; we still nudge it for feedback.
const bossWeathersShockwave = (game: Game, a: Asteroid, surviving: Asteroid[]) => {
  const kick = game.pulsar.shockwaveImpulseAt(a.pos);
  a.vel = { x: a.vel.x + kick.x * SW.bossKick, y: a.vel.y + kick.y * SW.bossKick };
  a.flashAmount = 1;
  surviving.push(a);
};

// kicking children outward reads as flung-apart by the wavefront, not spawning in place.
const kickChildFromShockwave = (game: Game, child: Asteroid) => {
  const kick = game.pulsar.shockwaveImpulseAt(child.pos);
  child.vel = { x: child.vel.x + kick.x * SW.childKick, y: child.vel.y + kick.y * SW.childKick };
};

// bass children stay grid-aligned + inherit drones so the music keeps marching post-shatter.
//   Rhythm trajectory alignment runs *after* the shockwave kick so we're not
//   immediately undoing the kick's force; instead it tunes the net post-kick
//   speed so the child's first re-engagement still falls on a beat. All
//   shockwave-spawned children share one claim set so the field that
//   re-forms is spread across the beat grid, not stacked on one beat.
const shatterBassRock = (game: Game, a: Asteroid, surviving: Asteroid[], claimed: BeatClaimSet) => {
  a.hp = 0;
  a.flashAmount = 1;
  emitExplosion(game.particles, game.shards, a, false);
  game.sound.stopBassteroidDrone(a);
  for (const c of a.split()) {
    alignBassBeat(game, c);
    if (c.size === "medium" || c.size === "small") {
      game.sound.startBassteroidDrone(c, c.kind as "bassA" | "bassB" | "bassC" | "bassD", c.size, c.pos);
    }
    kickChildFromShockwave(game, c);
    alignSplitChildToRhythm(game, c, claimed);
    surviving.push(c);
  }
};

// non-bass rocks have no drone or beat schedule, so the path stays free of audio bookkeeping.
const shatterPlainRock = (game: Game, a: Asteroid, surviving: Asteroid[], claimed: BeatClaimSet) => {
  a.flashAmount = 1;
  emitExplosion(game.particles, game.shards, a, false);
  // awayFrom/shipVel only: the citadel uses them to throw its shell clear of a
  // player standing inside it (shipGrace alone doesn't cover a fragment that
  // spawns on top of the hull and lingers there). Withholding shipHeading
  // deliberately keeps metalChunk on its plain radial burst — a field-wide
  // shatter isn't the aimed prong-shot lesson that placement is for.
  for (const c of a.split({ awayFrom: game.ship.pos, shipVel: game.ship.vel })) {
    kickChildFromShockwave(game, c);
    alignSplitChildToRhythm(game, c, claimed);
    surviving.push(c);
  }
};

// rebuild via surviving[] so we don't mutate the array we're iterating over.
const shatterAllAsteroids = (game: Game) => {
  const surviving: Asteroid[] = [];
  const claimed = newBeatClaimSet();
  for (const a of game.asteroids) {
    // The wavefront is a full-field event — an entering rock is hit like any
    // other; the contact just ends its entrance presentation first.
    completeEntrance(a);
    if (a.isBossFamily() || a.isSepulchreFamily()) bossWeathersShockwave(game, a, surviving);
    else if (a.isBass()) shatterBassRock(game, a, surviving, claimed);
    else shatterPlainRock(game, a, surviving, claimed);
  }
  game.asteroids = surviving;
};

// clamped distance falloff guarantees the player feels *something* even at the far corner.
const kickShipFromShockwave = (game: Game) => {
  if (!game.ship.alive) return;
  const kick = game.pulsar.shockwaveImpulseAt(game.ship.pos);
  const [dx, dy] = toroidalDelta(
    game.ship.pos.x - game.pulsar.shockOriginX,
    game.ship.pos.y - game.pulsar.shockOriginY,
    game.w, game.h,
  );
  const d = Math.hypot(dx, dy);
  const falloff = Math.max(0.45, 1 - d / Math.max(game.w, game.h));
  const mag = SW.shipImpulse * falloff;
  game.ship.vel = { x: game.ship.vel.x + kick.x * mag, y: game.ship.vel.y + kick.y * mag };
  // grace frame avoids punishing the player for being kicked into freshly-shattered debris.
  game.ship.invuln = Math.max(game.ship.invuln, SW.shipGrace);
};

// environment event — no score / combo so the ring stays a "free-of-charge" hazard reshape.
export const detonateShockwave = (game: Game) => {
  game.sound.play("shockwaveBoom");
  // Bass-drop shake kicks the screen hard so the impact registers in the
  // body as well as the ears. Capped so we never lose all sense of the frame.
  game.shake = Math.min(game.shake + 2.4, 3.0);
  shatterAllAsteroids(game);
  kickShipFromShockwave(game);
  emitShockwaveSparks(game.particles, { x: game.pulsar.shockOriginX, y: game.pulsar.shockOriginY });
};
