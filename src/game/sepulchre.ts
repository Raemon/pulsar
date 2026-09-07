import type { Game } from "../Game";
import { Asteroid, BASS_MEASURE_LENGTH } from "../Asteroid";
import { AlienBullet } from "../AlienBullet";
import { ENTITY_CONFIG, ENTITY_STATS } from "./entityConfig";
import { BEAT_GRID } from "./rhythmConstants";
import { bearerCycleLen } from "./bassClock";
import { TAU, nearestImageOf, v, wrapMut } from "../vec";
import { syncComboHud } from "./hud";

// The level-20 fight: the Sepulchre and the four Pallbearers carrying it.
//
// The whole encounter is one formation. The tomb is the centre of the bier
// ring, so a bearer has no velocity of its own — its position and facing are
// recomputed from the tomb every tick, the way a torus fragment rides its
// phantom ring. Each bearer owns one beat of the measure: on that beat it
// tolls (a bloom on the piece, a bell in the mix) and, if it is solid, fires
// one slow aimed bolt down its own bearing. Four bearers on four bearings on
// four beats is the fight's whole shape — you are never dodging one line, you
// are choosing which quadrant to live in.
//
// The bearers also phase, a quarter-cycle apart, so the one you may shoot is
// whichever is currently solid and the one that just went out is the safe side
// to sit on. A ghost still tolls but cannot fire: the rest in the music and the
// gap in the crossfire are the same event, which is the point.
//
// The tomb's armour is the bier: every living bearer stacks
// shellArmourPerBearer onto its shell. With four up it turns away anything
// short of a heroic drift shot; each bearer that falls drops it a rung. When
// the last one goes the tethers snap, the shutter over the reliquary grinds
// open, and the tomb takes all four beats itself — tolling the knell alone and
// throwing a ring of bolts on every downbeat.

const CFG = ENTITY_CONFIG.sepulchre;

// Build the encounter around `pos`: the tomb, then its bearers pegged to
// evenly spaced slots on the ring. Beat slot, phase offset and ring slot all
// come off the same index, so the bearer tolling is always the bearer a
// quarter-turn further round — the knell walks around the player.
export const spawnSepulchreEncounter = (game: Game, pos: { x: number; y: number }): Asteroid[] => {
  const cx = game.w / 2;
  const cy = game.h / 2;
  const drift = 5;
  const norm = Math.max(1, Math.hypot(cx - pos.x, cy - pos.y));
  const tomb = new Asteroid(
    { x: pos.x, y: pos.y },
    v(((cx - pos.x) / norm) * drift, ((cy - pos.y) / norm) * drift),
    "large",
    undefined,
    "sepulchre",
  );
  tomb.bierBearersAlive = CFG.bearerCount;
  tomb.damageReduction = shellArmour(CFG.bearerCount);

  const out: Asteroid[] = [tomb];
  const cycle = bearerCycleLen();
  for (let i = 0; i < CFG.bearerCount; i++) {
    const slot = (i / CFG.bearerCount) * TAU;
    const bearer = new Asteroid(
      { x: pos.x + Math.cos(slot) * CFG.bierRadius, y: pos.y + Math.sin(slot) * CFG.bierRadius },
      v(0, 0),
      "medium",
      undefined,
      "pallbearer",
    );
    bearer.bierCore = tomb;
    bearer.bierSlot = slot;
    bearer.bearerBeat = i;
    bearer.warblePhaseOffset = (i / CFG.bearerCount) * cycle;
    bearer.nextBeatAt = nextSlotAfter(game.beatTime, i * BEAT_GRID);
    out.push(bearer);
  }
  return out;
};

// First measure slot at or after `beatTime` whose offset within the measure is
// `offset`, snapped to the beat grid so float drift can never walk a toll off
// the beat (same trick alignBassBeat plays for a bassteroid).
const nextSlotAfter = (beatTime: number, offset: number, interval = BASS_MEASURE_LENGTH): number => {
  const k = Math.ceil((beatTime - offset - 1e-6) / interval);
  return Math.round((k * interval + offset) / BEAT_GRID) * BEAT_GRID;
};

// Recover from clock jumps without a backlog or losing this voice's beat slot.
// The tomb may legitimately wait a full measure for its first downbeat.
const reArmIfStalled = (game: Game, piece: Asteroid, interval: number, offset: number) => {
  if (Math.abs(game.beatTime - piece.nextBeatAt) <= BASS_MEASURE_LENGTH) return;
  piece.nextBeatAt = nextSlotAfter(game.beatTime, offset, interval);
};

const shellArmour = (bearersAlive: number): number =>
  (ENTITY_STATS.sepulchre!.damageReduction ?? 0) + bearersAlive * CFG.shellArmourPerBearer;

export const tickSepulchre = (game: Game, dt: number) => {
  const tomb = game.asteroids.find((a) => a.isSepulchre()) ?? null;
  const bearers = game.asteroids.filter((a) => a.kind === "pallbearer");
  if (!tomb && bearers.length === 0) return;

  if (tomb) {
    tomb.bierPhase += CFG.bierSpin * dt;
    const carried = bearers.filter((b) => b.bierCore === tomb);
    for (const bearer of carried) rideBier(bearer, tomb, game);
    // The bier rides in asleep: through the whole dormant approach it just
    // holds station around the tomb, unlit and untouchable.
    if (tomb.bossPhase === "dormant") return;
    wakeBearers(game, carried);
    tomb.bierBearersAlive = carried.length;
    tomb.damageReduction = shellArmour(carried.length);
    tickShutter(game, tomb, dt);
    tollTomb(game, tomb);
  }

  for (const bearer of bearers) {
    // The tomb went first (a drift shot got through the bier): the bier drops.
    // Each bearer keeps the tangential motion it was riding and flies off on it
    // rather than freezing in place around a hole in the sky.
    // Kills remove asteroids from the field without clearing their alive flag.
    if (bearer.bierCore && !game.asteroids.includes(bearer.bierCore)) releaseBearer(bearer);
    if (bearer.bossPhase === "dormant") continue;
    bearer.tollFlash = Math.max(0, bearer.tollFlash - dt * 2.2);
    tollBearer(game, bearer);
  }
};

// The bier wakes as one. Each bearer's beat slot is re-seeded off the live
// clock, or its toll loop would pay out a minute of backlogged bells — and a
// minute of backlogged bolts — the moment it came up.
const wakeBearers = (game: Game, carried: Asteroid[]) => {
  for (const bearer of carried) {
    if (bearer.bossPhase !== "dormant") continue;
    bearer.bossPhase = "live";
    bearer.nextBeatAt = nextSlotAfter(game.beatTime, bearer.bearerBeat * BEAT_GRID);
  }
};

// A bearer holds its slot on the ring rather than integrating its own velocity,
// and keeps its shoulder to the tomb: local +x points outward, away from the
// thing it carries, so the lamp faces the field and the yoke lies along the
// bier.
const rideBier = (bearer: Asteroid, tomb: Asteroid, game: Game) => {
  const angle = bearer.bierSlot + tomb.bierPhase;
  bearer.pos.x = tomb.pos.x + Math.cos(angle) * CFG.bierRadius;
  bearer.pos.y = tomb.pos.y + Math.sin(angle) * CFG.bierRadius;
  wrapMut(bearer.pos, game.w, game.h);
  bearer.rotation = angle;
  // Carried velocity, so a bearer freed by the tomb's death (or anything else
  // reading vel, like knockback) inherits the motion the ring was giving it.
  const tangential = CFG.bierRadius * CFG.bierSpin;
  bearer.vel.x = tomb.vel.x - Math.sin(angle) * tangential;
  bearer.vel.y = tomb.vel.y + Math.cos(angle) * tangential;
};

const releaseBearer = (bearer: Asteroid) => {
  bearer.bierCore = null;
  bearer.rotSpeed = 0.4;
};

// One toll per measure on the bearer's own beat. The bloom and the bell always
// land — a ghost still tolls — but the shot only leaves a solid bearer, so the
// quadrant that has just phased out is both a rest in the knell and a hole in
// the crossfire.
const tollBearer = (game: Game, bearer: Asteroid) => {
  reArmIfStalled(game, bearer, BASS_MEASURE_LENGTH, bearer.bearerBeat * BEAT_GRID);
  while (game.beatTime >= bearer.nextBeatAt) {
    bearer.tollFlash = 1;
    bearer.haloEcho = 1;
    // Deep bell for a solid bearer, thin and far-off for a ghost — the ear
    // hears which quadrant can shoot back before the eye finds it.
    game.sound.play("bell", bearer.warbleSolid ? 0.55 : 1.189, bearer.pos);
    if (bearer.warbleSolid && game.ship.alive) fireTollBolt(game, bearer);
    bearer.nextBeatAt = Math.round((bearer.nextBeatAt + BASS_MEASURE_LENGTH) / BEAT_GRID) * BEAT_GRID;
  }
};

// The opened tomb takes the measure over: it tolls every beat, and on the
// downbeat the reliquary lashes out in every direction at once. The ring is
// slow and its gaps widen as it expands, so the dodge is to pick a gap and ride
// outward through it — the opposite read from the boss's single locked line.
const tollTomb = (game: Game, tomb: Asteroid) => {
  if (tomb.shutterOpen < 1) return;
  reArmIfStalled(game, tomb, BEAT_GRID, 0);
  while (game.beatTime >= tomb.nextBeatAt) {
    tomb.tollFlash = 1;
    const isDownbeat = Math.abs(tomb.nextBeatAt % BASS_MEASURE_LENGTH) < 1e-6;
    game.sound.play("bell", isDownbeat ? 0.55 : 1, tomb.pos);
    if (isDownbeat && game.ship.alive) fireReliquaryRing(game, tomb);
    tomb.nextBeatAt = Math.round((tomb.nextBeatAt + BEAT_GRID) / BEAT_GRID) * BEAT_GRID;
  }
};

const fireTollBolt = (game: Game, bearer: Asteroid) => {
  const ship = nearestImageOf(game.ship.pos, bearer.pos, game.w, game.h);
  const angle = Math.atan2(ship.y - bearer.pos.y, ship.x - bearer.pos.x);
  game.alienBullets.push(bolt(bearer, angle, CFG.bearerBulletSpeed, BEAT_GRID * 6));
  game.sound.play("alienFireBig", 0.7, bearer.pos);
};

const RELIQUARY_RING_BOLTS = 12;

const fireReliquaryRing = (game: Game, tomb: Asteroid) => {
  // Rolled off the ring's own rotation so successive rings land rotated against
  // each other — a fixed spoke pattern would let the player park in one gap.
  const base = tomb.bierPhase;
  for (let i = 0; i < RELIQUARY_RING_BOLTS; i++) {
    const angle = base + (i / RELIQUARY_RING_BOLTS) * TAU;
    game.alienBullets.push(bolt(tomb, angle, CFG.bearerBulletSpeed * 0.8, BEAT_GRID * 10));
  }
  game.sound.play("alienFireBig", 1, tomb.pos);
  game.sound.play("bossPulse", 1, tomb.pos);
};

const bolt = (from: Asteroid, angle: number, speed: number, life: number): AlienBullet => {
  const muzzle = from.radius * 0.95;
  const shot = new AlienBullet(
    { x: from.pos.x + Math.cos(angle) * muzzle, y: from.pos.y + Math.sin(angle) * muzzle },
    v(Math.cos(angle) * speed, Math.sin(angle) * speed),
    "big",
    from.hue,
    true,
  );
  shot.isBossHemiPlasma = true;
  shot.owner = from;
  shot.maxLife = life;
  shot.fadeStartLife = BEAT_GRID;
  shot.life = life;
  return shot;
};

// With the bier broken the shutter grinds open over shutterBeats. The instant
// it starts moving is the fight's turn: the same wrong-note moment the boss's
// eye makes, so it takes the player's combo with it.
const tickShutter = (game: Game, tomb: Asteroid, dt: number) => {
  if (tomb.bierBearersAlive > 0 || tomb.shutterOpen >= 1) return;
  if (tomb.shutterOpen === 0) {
    game.sound.play("bossEyeOpenStinger", 1, tomb.pos);
    if (game.beatCombo > 0) {
      game.beatCombo = 0;
      game.ship.comboLossFlash = 1;
      syncComboHud(game);
    }
  }
  tomb.shutterOpen = Math.min(1, tomb.shutterOpen + dt / (CFG.shutterBeats * BEAT_GRID));
  // The tomb picks the measure up only once the leaves are fully apart, so its
  // first toll is the next downbeat after that — not a burst catching up on the
  // beats that passed while it was grinding open.
  if (tomb.shutterOpen >= 1) tomb.nextBeatAt = nextSlotAfter(game.beatTime, 0);
};

// The bier itself, drawn in world space: a taut line of light from the tomb to
// each bearer still carrying it. This is the armour made visible — four lines
// means nothing you fire at the tomb will land, and the player watches them go
// out one at a time.
export const renderBierTethers = (ctx: CanvasRenderingContext2D, game: Game, t: number) => {
  const tomb = game.asteroids.find((a) => a.isSepulchre() && a.bossPhase === "live");
  if (!tomb) return;
  const shimmer = 0.6 + 0.4 * Math.sin(t * 0.004);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const bearer of game.asteroids) {
    if (bearer.kind !== "pallbearer" || bearer.bierCore !== tomb) continue;
    const end = nearestImageOf(bearer.pos, tomb.pos, game.w, game.h);
    const strength = bearer.warbleSolid ? 1 : 0.45;
    const pulse = strength * (0.55 + 0.45 * bearer.tollFlash);
    ctx.strokeStyle = `hsla(${tomb.hue}, 100%, 40%, ${0.3 * pulse})`;
    ctx.lineWidth = 7 * pulse;
    ctx.beginPath();
    ctx.moveTo(tomb.pos.x, tomb.pos.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${tomb.hue + 20}, 100%, 88%, ${(0.5 + 0.3 * shimmer) * pulse})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(tomb.pos.x, tomb.pos.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.restore();
};
