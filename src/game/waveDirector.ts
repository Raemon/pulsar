import type { Game } from "../Game";
import { Asteroid, AsteroidKind, AsteroidSize, BASS_KINDS, BASS_MEASURE_LENGTH, isBurstGem, isTorusFragment, SIZE_SPAWN_SPEED, spawnAsteroidAtEdge, spawnBossAt } from "../Asteroid";
import { spawnGemSwarm } from "../Gem";
import { spawnComet as spawnCometAtEdge, spawnMeteorShower, COMET_LIFETIME } from "../Comet";
import { AlienSize, spawnAlienAtEdge } from "../Alien";
import { spawnCanister } from "../Canister";
import { rand, randInt, v, TAU, nearestImageOf, wrapMut } from "../vec";
import { rng } from "./rng";
import { BEAT_GRID } from "./rhythmConstants";
import { stageEntrance, audiblePos } from "./entrance";
import { newWaveEventSchedule, maybeSchedule, scheduleAt } from "./waveEvents";
import { startShockwave } from "./shockwave";
import { emitCrackParticles } from "./particleBursts";
import { alignVelocityToRhythm, BeatClaimSet, newBeatClaimSet } from "./rhythmTrajectory";
import { citadelCycleLen, citadelFadeLen } from "./bassClock";
import { ENTITY_CONFIG as CFG } from "./entityConfig";
import { BOSS_FORESHADOW_WAVES, BOSS_WAVES, bossEncounterForWave } from "./acts";
import { spawnSepulchreEncounter } from "./sepulchre";

// snap each fresh edge-spawn so its crossing of the player's natural
// kill range lands on a beat. Boss is exempt — it has its own slow drift.
//
// Reference point is the screen centre, *not* the ship — incoming rocks take
// several seconds to cross the field, by which time a moving ship has long
// left where it was. Using the screen centre as the encounter anchor means
// the timing is stable: the player can position themselves anywhere near
// the centre and still get a predictable beat-aligned procession of rocks.
// Spawn speed band for an asteroid, scaled per kind. Large solid crystals
// drift in slower than their size band (see CFG.solidCrystal.largeSpawnSpeedMul)
// — handing the aligner a slowed band keeps them beat-aligned at the lower
// speed rather than just decelerating a stock rock after the fact.
// When a gem slot fires, pick its tier: mostly the medium 4-fan gem, with a
// CFG.burstGem.bigChance roll for the rarer big 8-fan treat.
const rollBurstGemTier = (): AsteroidKind =>
  rng() < CFG.burstGem.bigChance ? "burstGemBig" : "burstGemMedium";

const spawnSpeedRange = (a: Asteroid): [number, number] => {
  const [lo, hi] = SIZE_SPAWN_SPEED[a.size];
  if (a.kind === "solidCrystal") {
    const m = CFG.solidCrystal.largeSpawnSpeedMul;
    return [lo * m, hi * m];
  }
  if (a.kind === "glassPrison") {
    const m = CFG.glassPrison.spawnSpeedMul;
    return [lo * m, hi * m];
  }
  if (a.kind === "bigGlassPrison") {
    const m = CFG.bigGlassPrison.spawnSpeedMul;
    return [lo * m, hi * m];
  }
  if (isBurstGem(a.kind)) {
    const m = CFG.burstGem.spawnSpeedMul;
    return [lo * m, hi * m];
  }
  if (a.kind === "torus") {
    const m = CFG.torus.spawnSpeedMul;
    return [lo * m, hi * m];
  }
  if (a.kind === "metalChunk") {
    const m = CFG.metalChunk.spawnSpeedMul;
    return [lo * m, hi * m];
  }
  if (a.kind === "citadel") {
    const m = CFG.citadel.spawnSpeedMul;
    return [lo * m, hi * m];
  }
  return [lo, hi];
};

const alignIncomingToRhythm = (game: Game, a: Asteroid, claimed?: BeatClaimSet) => {
  if (a.isBoss()) return;
  const range = spawnSpeedRange(a);
  alignVelocityToRhythm(a.pos, a.vel, {
    refPos: game.ship.pos,
    beatTime: game.beatTime,
    speedRange: range,
    engageRadius: CFG.engageRadius.incoming,
    // edge spawns sit many beats out; slot pool must cover slowest crossing
    maxBeats: 24,
    claimed,
  });
};

// a split child inherits the bullet's impact velocity (fast, fan-shaped)
// and starts essentially on top of the ship. We let its outward speed flex
// ±~35% so the moment it reaches CFG.engageRadius.split lands on a beat —
// and give it up to ±18 px of position nudge along its outward direction
// as a second degree of freedom (reads as "explosion shoved it a bit
// further out", not a teleport). Min 1 beat ahead so the player has at
// least 500 ms to react and re-aim. Sibling children share a `claimed`
// set so a parent's two kids end up on adjacent beats rather than
// colliding on one.
//
// refVel = ship.vel because an actively-flying player covers 200–460 px
// in the 1–2 beat alignment window — more than a ring radius. Without this
// the debris is aligned to a stale "ghost ship" position and a moving
// player never sees combo-able children.
export const alignSplitChildToRhythm = (game: Game, child: Asteroid, claimed?: BeatClaimSet) => {
  if (child.isBossFamily()) {
    // Boss fragments don't get velocity-aligned (their fan trajectory is
    // fixed), but the beat-active shards still need their first flash slot
    // seeded from the measureOffset the splitter assigned.
    if (child.isBeatFragment()) seedBeatFragmentSlot(game, child);
    return;
  }
  // Torus fragments ride a shared phantom ring — their own velocity is unused
  // (the group's drift owns their motion) and their position is recomputed each
  // tick, so rhythm-aligning either would just be thrown away.
  if (isTorusFragment(child.kind)) return;
  const speed = Math.hypot(child.vel.x, child.vel.y);
  if (speed < 1) return;
  alignVelocityToRhythm(child.pos, child.vel, {
    refPos: nearestImageOf(game.ship.pos, child.pos, game.w, game.h),
    refVel: game.ship.vel,
    beatTime: game.beatTime,
    speedRange: [speed * 0.65, speed * 1.35],
    engageRadius: CFG.engageRadius.split,
    minBeats: 1,
    maxBeats: 6,
    maxPosNudge: 18,
    claimed,
  });
};

// re-export so kill-effects callers don't have to import from two
// modules just to share a per-event claim set among sibling children.
export { newBeatClaimSet };
export type { BeatClaimSet };

export const rhythmSpeedMul = (game: Game): number => 1 + game.beatCombo * CFG.rhythm.speedPerCombo;

// wave-opening rocks read the previous wave's peak combo instead of the live one,
//   so a strong run makes the *next* wave fast even before the player rebuilds combo.
const waveStartSpeedMul = (game: Game): number => 1 + game.waveStartRhythm * CFG.rhythm.speedPerCombo;
const rhythmChanceBonus = (game: Game): number => game.beatCombo * CFG.rhythm.chancePerCombo;
// Alien size rolls only feel rhythm once combo clears the alienGate's early-wave threshold.
const alienRhythmChanceBonus = (game: Game): number =>
  Math.max(0, game.beatCombo - CFG.alien.rhythmComboThreshold) * CFG.rhythm.chancePerCombo;

// predicates let the wave director read declaratively, not as inline boolean expressions.
export const isBossWave = (wave: number): boolean => BOSS_WAVES.includes(wave);
export const isBossForeshadowWave = (wave: number): boolean => BOSS_FORESHADOW_WAVES.includes(wave);

// internal wave numbering stays 1-based (so all the wave >= N gates keep working);
// the player-facing label is shifted down by one so the warm-up rock is "Wave 0".
export const displayWave = (wave: number): number => wave - 1;

// Persistent across runs: once the player has ever reached 6x rhythm, they've
// outgrown the single-rock warm-up. Future normal-mode runs (not tutorial)
// skip straight to internal wave 2 — the first proper wave.
const VETERAN_KEY = "pulsar.veteran";

export const isVeteranPilot = (): boolean => {
  try {
    return localStorage.getItem(VETERAN_KEY) === "1";
  } catch {
    return false;
  }
};

export const markVeteranPilot = () => {
  try {
    localStorage.setItem(VETERAN_KEY, "1");
  } catch {
    // localStorage may be blocked (private mode); next run just won't skip.
  }
};

export const updateBgBeatIntensity = (game: Game) => {
  // Tell the asset loader where the run is: everything this wave introduces
  // becomes the front of its queue, and the waves behind it are already done.
  game.sound.setLoadWave(game.wave);
  // a deliberate per-wave set wins over any in-flight calibration→play loudness ramp.
  game.beatIntensityRamp = null;
  const ramp = Math.max(0, Math.min(1, (game.wave - 1) / CFG.bgBeatIntensity.rampWaves));
  game.sound.bgBeatIntensity = CFG.bgBeatIntensity.base + ramp * CFG.bgBeatIntensity.range;
};

// snap-to-grid guarantees every bassteroid fires on a pulsar beat despite float drift.
export const alignBassBeat = (game: Game, asteroid: Asteroid) => {
  if (!asteroid.isBass()) return;
  const gridSnappedOffset = Math.round(asteroid.measureOffset / BEAT_GRID) * BEAT_GRID;
  asteroid.measureOffset = gridSnappedOffset;
  const k = Math.ceil((game.beatTime - gridSnappedOffset - 1e-6) / BASS_MEASURE_LENGTH);
  const raw = k * BASS_MEASURE_LENGTH + gridSnappedOffset;
  asteroid.nextBeatAt = Math.round(raw / BEAT_GRID) * BEAT_GRID;
};

// Beat-active boss shards flash on the same grid-snapped measure slot a
// Bassteroid uses, so the first pulse lands on the next matching downbeat.
const seedBeatFragmentSlot = (game: Game, a: Asteroid) => {
  const gridSnappedOffset = Math.round(a.measureOffset / BEAT_GRID) * BEAT_GRID;
  a.measureOffset = gridSnappedOffset;
  const k = Math.ceil((game.beatTime - gridSnappedOffset - 1e-6) / BASS_MEASURE_LENGTH);
  const raw = k * BASS_MEASURE_LENGTH + gridSnappedOffset;
  a.nextBeatAt = Math.round(raw / BEAT_GRID) * BEAT_GRID;
};

// paired-wave intro (one bass, then both) trains the player gradually.
// Past CFG.bassteroid.maxLevel the post-boss arc retires the every-wave bass
// pieces so a new texture (glass prisons, the bell-toll cathedral fragment)
// can take centre stage — but each bass slot still rolls rareChanceAfterMax
// to keep them an occasional accent rather than vanishing outright.
// Each bass slot rolls a fresh kind from the full BASS_KINDS pool, so any of
// the four colours can show up on any bass wave (re-rolled per wave spawn).
// The chime/bell/warble sound-decorator asteroids are no longer spawned here.
export const activeSpecialsForWave = (_game: Game, wave: number): AsteroidKind[] => {
  if (wave < 3) return [];
  const randomBass = (): AsteroidKind => BASS_KINDS[Math.floor(rng() * BASS_KINDS.length)];
  // each slot decides independently whether a bass piece fills it
  const bassSlot = (): AsteroidKind[] =>
    wave <= CFG.bassteroid.maxLevel || rng() < CFG.bassteroid.rareChanceAfterMax
      ? [randomBass()]
      : [];
  if (wave === 3) return bassSlot();
  if (wave === 4) return bassSlot();
  return [...bassSlot(), ...bassSlot()];
};

// boost velocity in place by the current rhythm-speed multiplier; called
//   *after* rhythm alignment so the alignment math (which works in the
//   unscaled SIZE_SPAWN_SPEED band) stays valid — the speedup just makes the
//   target arrive a touch earlier than its assigned beat slot.
const applyRhythmSpeed = (game: Game, vel: { x: number; y: number }, k = rhythmSpeedMul(game)) => {
  if (k === 1) return;
  vel.x *= k;
  vel.y *= k;
};

// World-space origin of the player's *visible* frame.
//
// The edge-spawn helpers place bodies relative to the 1920x1080 playfield
// (off the playfield edges, aiming at the playfield centre). Under the
// locked-centre scroll camera the visible viewport is `ship.pos ± (w/2, h/2)`
// — NOT the playfield rect — so adding this origin maps playfield-centre →
// ship.pos: "just off the left playfield edge" becomes "just off the left of
// what the player currently sees". The spawn is then folded in-domain by
// stageEntrance, which records the unfolded entrance image it slides in at.
const shipFrameOrigin = (game: Game): { x: number; y: number } => ({
  x: game.ship.pos.x - game.w / 2,
  y: game.ship.pos.y - game.h / 2,
});

// One wave rock: edge-spawn shifted into the visible frame, rhythm-aligned
//   while still unfolded (see alignIncomingToRhythm — the `claimed` set
//   spreads a batch across distinct beat slots), then staged so it slides in
//   from the screen border. Ship-relative edge spawns start ≥ half a screen
//   from the ship, so no away-from-ship retry is needed.
export const spawnAsteroidAway = (
  game: Game,
  kind?: AsteroidKind,
  size?: AsteroidSize,
  claimed?: BeatClaimSet,
) => {
  const origin = shipFrameOrigin(game);
  const a = spawnAsteroidAtEdge(game.w, game.h, undefined, kind, size);
  a.pos.x += origin.x;
  a.pos.y += origin.y;
  // Heavy solid crystals drift slower; pre-scale before alignment so even a
  //   no-candidate fallback keeps the ponderous speed. The aligner works in
  //   the matching slowed band (see spawnSpeedRange), so a successful match
  //   stays slow too.
  if (a.kind === "solidCrystal") {
    a.vel.x *= CFG.solidCrystal.largeSpawnSpeedMul;
    a.vel.y *= CFG.solidCrystal.largeSpawnSpeedMul;
  }
  if (a.kind === "glassPrison") {
    a.vel.x *= CFG.glassPrison.spawnSpeedMul;
    a.vel.y *= CFG.glassPrison.spawnSpeedMul;
  }
  if (a.kind === "bigGlassPrison") {
    a.vel.x *= CFG.bigGlassPrison.spawnSpeedMul;
    a.vel.y *= CFG.bigGlassPrison.spawnSpeedMul;
  }
  if (isBurstGem(a.kind)) {
    a.vel.x *= CFG.burstGem.spawnSpeedMul;
    a.vel.y *= CFG.burstGem.spawnSpeedMul;
  }
  if (a.kind === "torus") {
    a.vel.x *= CFG.torus.spawnSpeedMul;
    a.vel.y *= CFG.torus.spawnSpeedMul;
  }
  if (a.kind === "metalChunk") {
    a.vel.x *= CFG.metalChunk.spawnSpeedMul;
    a.vel.y *= CFG.metalChunk.spawnSpeedMul;
  }
  if (a.kind === "citadel") {
    a.vel.x *= CFG.citadel.spawnSpeedMul;
    a.vel.y *= CFG.citadel.spawnSpeedMul;
    // Phase-align so the shell arrives freshly solid: the player watches the
    // full 16 solid beats, then gets the 16-beat phased-out window to enter.
    const cycleLen = citadelCycleLen();
    a.warblePhaseOffset = (((citadelFadeLen() - game.beatTime) % cycleLen) + cycleLen) % cycleLen;
  }
  alignIncomingToRhythm(game, a, claimed);
  applyRhythmSpeed(game, a.vel, waveStartSpeedMul(game));
  stageEntrance(game, a);
  return a;
};

// specials need alignBassBeat so their first downbeat lands on the pulsar grid immediately.
const spawnSpecial = (game: Game, kind: AsteroidKind, claimed?: BeatClaimSet): Asteroid => {
  const a = spawnAsteroidAway(game, kind, undefined, claimed);
  alignBassBeat(game, a);
  return a;
};

// standalone solidCrystalSmall has a fixed small size + kind so we roll it
// outside activeSpecialsForWave. Same "rare treat" slot the tink roll filled.
const spawnSolidCrystalSmall = (game: Game, claimed?: BeatClaimSet): Asteroid =>
  spawnAsteroidAway(game, "solidCrystalSmall", "small", claimed);

// pre-align first fire to the next BEAT_GRID slot so saucer shots lock into
// the rhythm immediately. From there the alien advances through its own
// fire pattern (see ALIEN_FIRE_PATTERN_BEATS in Alien.ts).
export const spawnAlien = (game: Game, size: AlienSize) => {
  const origin = shipFrameOrigin(game);
  const a = spawnAlienAtEdge(game.w, game.h, size);
  a.pos.x += origin.x;
  a.pos.y += origin.y;
  applyRhythmSpeed(game, a.vel);
  a.nextFireAt = Math.ceil((game.beatTime + 0.5) / BEAT_GRID) * BEAT_GRID;
  a.firePatternIndex = 0;
  stageEntrance(game, a);
  game.aliens.push(a);
  game.sound.startAlienDrone(a, size, audiblePos(a));
};

// comet's first melody note locks to the next bass-measure downbeat (every BASS_MEASURE_LENGTH s),
//   not just the next BEAT_GRID — gives the entrance whoosh ~1–2s of solo space before the line begins
//   and ensures the sung-in pitch coincides with a downbeat hit instead of an interior tick. Each
//   subsequent note steps by 2 BEAT_GRID (=1s) per COMET_MELODY's slower phrase pulse.
//
// Comets pay 1000 × beatCombo on an on-beat kill (the single biggest combo
// payout in the game) and a flat 500 off-beat. Aligning the traversal speed
// so the comet crosses the engagement ring on a beat means an on-rhythm
// player can land the big payout on-beat without having to guess the comet's
// individual phase.
// The ±15% band is enough wiggle room to absorb the small phase mismatch
// without noticeably altering the comet's chosen traversal speed.
export const spawnComet = (game: Game) => {
  const c = spawnCometAtEdge(game.w, game.h);
  // Slide the edge-spawn into the player's visible frame so the comet streaks
  // in from a real offscreen edge and crosses the screen (see shipFrameOrigin).
  const origin = shipFrameOrigin(game);
  c.pos.x += origin.x;
  c.pos.y += origin.y;
  const cometEntryLead = 0.6;
  c.nextNoteBeatTime = Math.ceil((game.beatTime + cometEntryLead) / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
  const cometSpeed = Math.hypot(c.vel.x, c.vel.y);
  if (cometSpeed > 0) {
    alignVelocityToRhythm(c.pos, c.vel, {
      refPos: game.ship.pos,
      beatTime: game.beatTime,
      speedRange: [cometSpeed * 0.85, cometSpeed * 1.15],
      engageRadius: CFG.engageRadius.incoming,
      maxBeats: 24,
    });
  }
  applyRhythmSpeed(game, c.vel);
  // Fixed 30s in play regardless of speed or map position — the comet crosses,
  // keeps drifting through the wrapped world, then bursts apart on the clock.
  c.lifetime = COMET_LIFETIME;
  stageEntrance(game, c);
  game.comets.push(c);
  game.sound.startCometShimmer(c, audiblePos(c));
};

// The rare meteor shower: a flock of small fast meteors. They share the comet
// array (and its rendering/collision/scoring) but skip the per-comet melody and
// shimmer — instead one dramatic entrance sweep announces the whole flock,
// played at the lead meteor's position.
export const spawnMeteorShowerEvent = (game: Game, countOverride?: number) => {
  const meteors = spawnMeteorShower(game.w, game.h, countOverride);
  // Shift the whole flock into the visible frame (see shipFrameOrigin) so it
  // sweeps in from a real offscreen edge instead of popping in at the seam.
  const origin = shipFrameOrigin(game);
  const k = rhythmSpeedMul(game);
  for (const m of meteors) {
    m.pos.x += origin.x;
    m.pos.y += origin.y;
    applyRhythmSpeed(game, m.vel, k);
    // Keep the cross-and-leave lifetime matched to the sped-up velocity: a
    // faster meteor crosses sooner, so it should fade out sooner too.
    if (k !== 1) m.lifetime /= k;
    stageEntrance(game, m);
    game.comets.push(m);
  }
  if (meteors.length > 0) game.sound.play("meteorShower", 1, audiblePos(meteors[0]));
}

// The gem swarm: a flock of bare gems sweeping across the field, the
// gold-diamond cousin of the meteor shower. Each gem is a live rhythm target
// (fly in → die; shoot on-beat → points or an upgrade) — a brief, dense "comb
// through them for upgrades" window. Each is beat-aligned (anchored at screen
// centre) so its kill-range crossing lands on the grid, same as any incoming
// rock; one entrance sweep announces the whole flock at the lead gem's position.
export const spawnGemSwarmEvent = (game: Game, countOverride?: number) => {
  const cfg = CFG.gemSwarm;
  const count = countOverride ?? randInt(cfg.count[0], cfg.count[1]);
  const gems = spawnGemSwarm(game.w, game.h, count);
  const claimed = newBeatClaimSet();
  // Same camera shift as wave rocks: enter from the visible edge, cross the
  // player at screen centre (see shipFrameOrigin / spawnAsteroidAway).
  const origin = shipFrameOrigin(game);
  for (const g of gems) {
    g.pos.x += origin.x;
    g.pos.y += origin.y;
    const speed = Math.hypot(g.vel.x, g.vel.y);
    alignVelocityToRhythm(g.pos, g.vel, {
      refPos: game.ship.pos,
      beatTime: game.beatTime,
      speedRange: [speed * 0.85, speed * 1.15],
      engageRadius: CFG.engageRadius.incoming,
      maxBeats: 24,
      claimed,
    });
    applyRhythmSpeed(game, g.vel);
    stageEntrance(game, g);
    game.gems.push(g);
  }
  if (gems.length > 0) game.sound.play("gemSwarm", 1, audiblePos(gems[0]));
};

// one entry replaces the previous if/else maze covering boss/foreshadow/normal wave dispatch.
//   One `claimed` set is shared across the wave's asteroid + standalone
//   solidCrystalSmall rolls so each fresh rock takes a distinct beat slot —
//   the result is a steady beat-by-beat target procession the player can
//   combo through.
// Tutorial: a single small practice rock, rhythm-aligned like a normal spawn so
//   its first-beat dot is meaningful, with a little materialize puff so a respawn
//   reads as "a fresh one drifts in".
export const spawnTutorialSmall = (game: Game) => {
  // The guided tutorial is the rookie's "first level"; consume the flag so the
  //   first real density wave after graduation streaks in normally.
  game.hasSpawnedFirstLevel = true;
  const a = spawnAsteroidAway(game, undefined, "small", newBeatClaimSet());
  game.asteroids.push(a);
  emitCrackParticles(game.particles, a, true);
};

// Post-graduation tutorial spawn: one large rock at a time, respawning on clear
//   until the player finishes the hint progression. Avoids the difficulty cliff
//   of jumping straight from one small practice rock to the full 3-big wave.
export const spawnTutorialBig = (game: Game) => {
  const a = spawnAsteroidAway(game, undefined, "large", newBeatClaimSet());
  game.asteroids.push(a);
  emitCrackParticles(game.particles, a, true);
};

export const spawnWave = (game: Game) => {
  game.asteroids = [];
  game.canisters = [];
  game.gems = [];
  game.fuelOrbs = [];
  game.waveEvents = newWaveEventSchedule();
  game.waveElapsed = 0;

  // First wave the player actually flies (display wave 0 on a normal start,
  //   display wave 1 for a veteran who skips the warm-up). Consumed here so
  //   only that opener gets the centre-out drift spawn — every later wave
  //   resumes streaking in from the edges.
  const isFirstLevel = !game.hasSpawnedFirstLevel;
  game.hasSpawnedFirstLevel = true;

  if (handleBossWave(game)) return;
  setForeshadowState(game);
  rollWaveEvents(game);
  const claimed = newBeatClaimSet();
  spawnWaveAsteroids(game, claimed, isFirstLevel);
  rollSolidCrystalSmallSpawn(game, claimed);
};

// Cathedral fragments that precede the tomb into the level.
const SEPULCHRE_WAKE_FRAGMENTS = 4;

// capture the sky position BEFORE hiding it so a boss materialises where the
// player last saw the thing it has been all act — the red planetoid for Act I,
// the tomb and its ring of moons for Act II.
const handleBossWave = (game: Game): boolean => {
  const encounter = bossEncounterForWave(game.wave);
  if (!encounter) return false;
  const pos = game.pulsar.bossBodyPos(encounter.act);
  game.pulsar.setBossPlanetState("active", encounter.act);
  if (encounter.kind === "sepulchre") {
    // The Sepulchre brings its own four voices (the bearers' knell), so the
    // bass field stays out of this one — a full bass ensemble under four
    // tolling bearers would bury the beat the fight is played on. What drifts
    // in instead is the tomb's own wake: a scatter of cathedral fragments,
    // which carry the act's bell voice and give the player something to keep
    // rhythm against through the long dormant approach.
    game.asteroids.push(...spawnSepulchreEncounter(game, pos));
    const wake = newBeatClaimSet();
    for (let i = 0; i < SEPULCHRE_WAKE_FRAGMENTS; i++) {
      game.asteroids.push(spawnSpecial(game, "bell", wake));
    }
    return true;
  }
  game.asteroids.push(spawnBossAt(pos, game.w, game.h));
  // one of each Bassteroid joins the boss; shared claim set keeps them on
  // distinct beat slots.
  const claimed = newBeatClaimSet();
  for (const kind of BASS_KINDS) {
    game.asteroids.push(spawnSpecial(game, kind, claimed));
  }
  return true;
};

// foreshadow wave swells the planet visibly; idle fallback handles edge cases like state restart.
const setForeshadowState = (game: Game) => {
  if (isBossForeshadowWave(game.wave)) {
    game.pulsar.setBossPlanetState("foreshadow");
  } else if (game.pulsar.bossPlanetState === "foreshadow") {
    game.pulsar.setBossPlanetState("idle");
  }
};

// Each independent event rolls on its own. The three "headline" events
// (shockwave, comet, alien) cross-suppress: when one rolls successfully,
// the next ones in the sequence have their chance multiplied by
// CFG.headline.dampen so a single wave rarely stacks two of them.
// Order is randomised each wave to keep the suppression symmetric.
const rollWaveEvents = (game: Game) => {
  if (CFG.canister.featureFreeSpawns && game.wave >= CFG.canister.firstWave) {
    maybeSchedule(game.waveEvents, CFG.canister.chancePerWave, CFG.canister.spawnWindow, () => {
      const c = spawnCanister(game.w, game.h, game.ship.pos);
      applyRhythmSpeed(game, c.vel);
      game.canisters.push(c);
      game.sound.play("canisterAppear", 1, c.pos);
    });
  }
  rollHeadlineEvents(game);
  rollSwarmWave(game);
};

// One designated wave always launches an oversized meteor swarm a few seconds
// in, on top of (and independent of) the random headline roll.
const rollSwarmWave = (game: Game) => {
  const swarm = CFG.meteorShower.swarmWave;
  if (game.wave !== swarm.wave) return;
  scheduleAt(game.waveEvents, rand(swarm.delay[0], swarm.delay[1]), () =>
    spawnMeteorShowerEvent(game, randInt(swarm.count[0], swarm.count[1])),
  );
};

type HeadlineRoll = { gate: boolean; baseChance: number; fire: () => boolean };

const rollHeadlineEvents = (game: Game) => {
  // Rhythm additively boosts the alien-size rolls and the shockwave roll.
  //   Comet is left on its existing curve — only aliens + shockwave were asked for.
  const bonus = rhythmChanceBonus(game);
  const alienBonus = alienRhythmChanceBonus(game);
  const alienGate = game.wave >= 10 || (game.wave < 10 && game.waveStartRhythm >= 12);
  const alienSizeRoll = (size: AlienSize): HeadlineRoll => ({
    gate: alienGate && CFG.alienSizeShare(game.wave, size) > 0,
    baseChance: CFG.alien.chancePerWave * CFG.alienSizeShare(game.wave, size) + alienBonus,
    fire: () => {
      maybeSchedule(game.waveEvents, 1, CFG.alien.spawnWindow, () => spawnAlien(game, size));
      return true;
    },
  });

  const rolls: HeadlineRoll[] = [
    {
      gate: game.wave >= CFG.shockwave.firstWave,
      baseChance: CFG.shockwave.chancePerWave + bonus,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, CFG.shockwave.spawnWindow, () => startShockwave(game));
        return true;
      },
    },
    {
      gate: game.wave >= CFG.comet.firstWave,
      baseChance: CFG.comet.chancePerWave,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, CFG.comet.spawnWindow, () => spawnComet(game));
        return true;
      },
    },
    {
      gate: game.wave >= CFG.meteorShower.firstWave,
      baseChance: CFG.meteorShower.chancePerWave,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, CFG.meteorShower.spawnWindow, () => spawnMeteorShowerEvent(game));
        return true;
      },
    },
    {
      gate: game.wave >= CFG.gemSwarm.firstWave,
      baseChance: CFG.gemSwarm.chancePerWave,
      fire: () => {
        maybeSchedule(game.waveEvents, 1, CFG.gemSwarm.spawnWindow, () => spawnGemSwarmEvent(game));
        return true;
      },
    },
    alienSizeRoll("small"),
    alienSizeRoll("medium"),
    alienSizeRoll("big"),
  ];

  // randomise order so no single event always gets the un-dampened first roll.
  for (let i = rolls.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rolls[i], rolls[j]] = [rolls[j], rolls[i]];
  }

  let dampen = 1;
  for (const r of rolls) {
    if (!r.gate) continue;
    if (rng() >= r.baseChance * dampen) continue;
    r.fire();
    dampen *= CFG.headline.dampen;
  }
};

// First level only. Instead of streaking in from a screen edge, the opening
// wave's rocks materialise in a loose ring around the centre — right where the
// ship spawns — and drift gently *outward*. Each one sits a little past the
// resting reticule's reach, so one soft thrust is enough to glide after it and
// bring its first-beat target dot under the crosshair. It's the calmest
// possible introduction to lining a shot up on the beat.
const FIRST_LEVEL_DRIFT = {
  // spawn distance band as fractions of the incoming engage ring. Pushed
  //   further out than the original single ringFrac so the opener needs a
  //   gentle chase; the max can sit slightly past the ring.
  distMinFrac: 0.9,
  distMaxFrac: 1.1,
  // nudge after the sorted-distance spread so rocks aren't perfectly ordered.
  distJitter: 22,
  // slow, ponderous outward drift — a calm, readable target to chase.
  speed: [30, 46] as [number, number],
};

// Random bearings + distances that tend to spread (one closer, one farther).
//   Sample `count` uniform distances, sort them, jitter each — on average
//   that lands noticeably different radii without hardcoding tiers. Angles
//   are sampled with a minimum angular separation so rocks don't visually
//   overlap at the engage ring; with the largest plausible opener count
//   (~5 on a veteran skip) and ~30° min spacing the budget is comfortable.
const FIRST_LEVEL_MIN_ANGLE_SEP = (30 * Math.PI) / 180;
const sampleFirstLevelPlacements = (count: number, engage: number): Array<{ angle: number; dist: number }> => {
  const minDist = engage * FIRST_LEVEL_DRIFT.distMinFrac;
  const maxDist = engage * FIRST_LEVEL_DRIFT.distMaxFrac;
  const distSamples: number[] = [];
  for (let i = 0; i < count; i++) distSamples.push(minDist + rng() * (maxDist - minDist));
  distSamples.sort((a, b) => a - b);
  // Shrink the floor if the budget can't fit — keeps us robust to large counts
  //   while preserving the visual goal in the common case.
  const sep = Math.min(FIRST_LEVEL_MIN_ANGLE_SEP, (TAU / Math.max(count, 1)) * 0.9);
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    let chosen = rng() * TAU;
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = rng() * TAU;
      if (angles.every(a => angularDist(a, candidate) >= sep)) { chosen = candidate; break; }
      if (attempt === 0) chosen = candidate;
    }
    angles.push(chosen);
  }
  const placements: Array<{ angle: number; dist: number }> = [];
  for (let i = 0; i < count; i++) {
    const dist = Math.max(minDist, Math.min(maxDist, distSamples[i] + rand(-FIRST_LEVEL_DRIFT.distJitter, FIRST_LEVEL_DRIFT.distJitter)));
    placements.push({ angle: angles[i], dist });
  }
  return placements;
};

const angularDist = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % TAU + TAU) % TAU);
  return Math.min(d, TAU - d);
};

// Spawn one opening-wave rock drifting straight out from the ship. Folded
// in-domain at the end but NOT staged — it materialises in view, it doesn't
// slide in from a border.
const spawnFirstLevelDrifter = (
  game: Game,
  angle: number,
  dist: number,
  kind: AsteroidKind | undefined,
  size: AsteroidSize,
  claimed: BeatClaimSet,
): Asteroid => {
  const cx = game.ship.pos.x;
  const cy = game.ship.pos.y;
  const engage = CFG.engageRadius.incoming;
  const pos = v(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist);
  // Heavy solid crystals keep their slowdown multiplier on top of the already
  //   gentle opener band.
  const mul = kind === "solidCrystal" ? CFG.solidCrystal.largeSpawnSpeedMul : 1;
  const band: [number, number] = [FIRST_LEVEL_DRIFT.speed[0] * mul, FIRST_LEVEL_DRIFT.speed[1] * mul];
  const speed = rand(band[0], band[1]);
  const vel = v(Math.cos(angle) * speed, Math.sin(angle) * speed);
  const a = new Asteroid(pos, vel, size, undefined, kind ?? "normal");
  // Beat-align the outward crossing of the engage ring (anchored at centre) so
  //   the rock's trajectory dots fall on the grid. The slow band means the
  //   aligner only nudges the ponderous drift, never speeds it up.
  alignVelocityToRhythm(a.pos, a.vel, {
    refPos: { x: cx, y: cy },
    beatTime: game.beatTime,
    speedRange: band,
    engageRadius: engage,
    maxBeats: 24,
    claimed,
  });
  wrapMut(a.pos, game.w, game.h);
  return a;
};

// Redistribute a budget of `largeCount` plain large rocks across the size
//   ladder (1 huge = 2 large = 4 medium = 8 small) while preserving total mass.
//   Tuned so that on average ~half the wave mass stays plain large — the
//   classic big rock — and the other half spreads across huge / medium / small
//   for variety. Each unit of budget carries one large-equivalent of mass into
//   whichever bucket it lands in, so the "stays large" probability below is
//   directly the expected large mass fraction. Always returns a list whose
//   summed mass equals `largeCount`.
const redistributeNormalMass = (largeCount: number, allowHuge: boolean): AsteroidSize[] => {
  const UPGRADE_CHANCE = 0.2;
  const DOWNGRADE_MEDIUM_CHANCE = 0.18;
  const DOWNGRADE_SMALL_CHANCE = 0.12;
  const out: AsteroidSize[] = [];
  let remaining = largeCount;
  while (remaining >= 1) {
    // Upgrade only when a second whole large remains to pair into the huge.
    if (allowHuge && remaining >= 2 && rng() < UPGRADE_CHANCE) {
      out.push("huge");
      remaining -= 2;
      continue;
    }
    const roll = rng();
    if (roll < DOWNGRADE_SMALL_CHANCE) {
      out.push("small", "small", "small", "small");
    } else if (roll < DOWNGRADE_SMALL_CHANCE + DOWNGRADE_MEDIUM_CHANCE) {
      out.push("medium", "medium");
    } else {
      out.push("large");
    }
    remaining -= 1;
  }
  return out;
};

// Wave 0 (internal wave 1): a single large rock — a gentle warm-up before density ramps.
// Wave 1+ (internal wave 2+): 3, 3, 4, 4, 5, 5... per-wave count gives the player a wave to consolidate before density bumps.
// Post-boss (display 11+): the ramp resets to CFG.postBoss.waveCount and
//   climbs again on the same two-wave cadence, with the new special kinds
//   layering difficulty on top of the density.
//   A single `claimed` set is shared across the wave's spawns (including the
//   standalone solidCrystalSmall roll below — see spawnWave) so each rock
//   targets a distinct beat slot, giving the player a sustainable
//   beat-by-beat target procession.
const spawnWaveAsteroids = (game: Game, claimed: BeatClaimSet, isFirstLevel: boolean) => {
  const baseCount = game.wave === 1 ? 1
    : game.wave >= CFG.postBoss.firstWave
      ? CFG.postBoss.waveCount + Math.floor((game.wave - CFG.postBoss.firstWave) / 2)
    : 3 + Math.floor((game.wave - 2) / 2);
  const swarm = CFG.meteorShower.swarmWave;
  // The swarm wave thins its asteroid field so the meteor flock is the headline.
  const totalCount = game.wave === swarm.wave ? Math.max(1, Math.round(baseCount * swarm.asteroidCountMul)) : baseCount;
  const activeSpecials = activeSpecialsForWave(game, game.wave);
  const normalCount = Math.max(0, totalCount - activeSpecials.length);

  // Pre-roll the kind for each normal slot. On the introductory wave for a
  // given special (firstWave) we force exactly one slot of that kind so the
  // player sees the mechanic at least once; on later waves each slot rolls
  // independently at the configured per-spawn chance. Solid crystal rolls
  // are checked first — when one fires, the slot can't also become a gem rock.
  const slotKinds: AsteroidKind[] = [];
  for (let i = 0; i < normalCount; i++) {
    // Phase citadel — the headline fortress of the post-boss arc, retired
    // after its lastWave. Rolled first so a citadel slot keeps its identity.
    const isCitadel = game.wave >= CFG.citadel.firstWave && game.wave <= CFG.citadel.lastWave
      && rng() < CFG.citadel.perSpawnChance;
    if (isCitadel) { slotKinds.push("citadel"); continue; }
    // Glass prisons gated on their firstWave (post-boss). Rolled before the rest
    // so a prison slot can't also pick up a gem or be downgraded to a solid
    // crystal. The big shell rolls first — when it fires, the slot becomes the
    // oversized brood prison rather than the ordinary single-captive one.
    const isBigPrison = game.wave >= CFG.bigGlassPrison.firstWave && rng() < CFG.bigGlassPrison.perSpawnChance;
    if (isBigPrison) { slotKinds.push("bigGlassPrison"); continue; }
    const isPrison = game.wave >= CFG.glassPrison.firstWave && rng() < CFG.glassPrison.perSpawnChance;
    if (isPrison) { slotKinds.push("glassPrison"); continue; }
    // Phased warble — post-boss arc (display-level 11+). Rolled before solid/gem
    // so a warble slot keeps its phasing identity rather than being downgraded.
    const isWarble = game.wave >= CFG.warble.firstWave && rng() < CFG.warble.perSpawnChance;
    if (isWarble) { slotKinds.push("warble"); continue; }
    // Mechanical torus — post-boss arc (display-level 11+). Rolled before
    // solid/gem so a torus slot keeps its ring identity.
    const isTorus = game.wave >= CFG.torus.firstWave && rng() < CFG.torus.perSpawnChance;
    if (isTorus) { slotKinds.push("torus"); continue; }
    // Gold gem: rare in the early arc, frequent once frequentWave hits. Rolled
    // before solid/gem so a gem slot can't also become a solid crystal or gem rock.
    const burstGemChance =
      game.wave >= CFG.burstGem.frequentWave ? CFG.burstGem.frequentChance
      : game.wave >= CFG.burstGem.firstWave && game.wave <= CFG.burstGem.lastEarlyWave ? CFG.burstGem.perSpawnChance
      : 0;
    const rollBurstGem = burstGemChance > 0 && rng() < burstGemChance;
    if (rollBurstGem) { slotKinds.push(rollBurstGemTier()); continue; }
    // Metal chunk: rare across its introduction span (display 5-9), then a
    // common obstacle from frequentWave on. Rolled before solid/gem so a chunk
    // slot keeps its identity rather than being downgraded.
    const metalChunkChance =
      game.wave >= CFG.metalChunk.frequentWave ? CFG.metalChunk.frequentChance
      : game.wave >= CFG.metalChunk.firstWave && game.wave <= CFG.metalChunk.lastEarlyWave ? CFG.metalChunk.perSpawnChance
      : 0;
    if (metalChunkChance > 0 && rng() < metalChunkChance) { slotKinds.push("metalChunk"); continue; }
    const isSolid = game.wave > CFG.solidCrystal.firstWave && rng() < CFG.solidCrystal.perSpawnChance;
    if (isSolid) { slotKinds.push("solidCrystal"); continue; }
    const isGem = game.wave > CFG.asteroidWithGem.firstWave && rng() < CFG.asteroidWithGem.perSpawnChance;
    slotKinds.push(isGem ? "asteroidWithGem" : "normal");
  }
  if (game.wave === CFG.asteroidWithGem.firstWave && normalCount > 0 && !slotKinds.includes("asteroidWithGem")) {
    slotKinds[Math.floor(rng() * normalCount)] = "asteroidWithGem";
  }
  // No guaranteed intro spawn for the burst gem — it's meant to be a rare
  // surprise across display levels 2-9, met only via the low per-rock roll.
  if (game.wave === CFG.solidCrystal.firstWave && normalCount > 0 && !slotKinds.includes("solidCrystal")) {
    slotKinds[Math.floor(rng() * normalCount)] = "solidCrystal";
  }
  // Introductory glassPrison wave is guaranteed one prison so the player meets
  // the new mechanic right away rather than rolling for it.
  if (game.wave === CFG.glassPrison.firstWave && normalCount > 0 && !slotKinds.includes("glassPrison")) {
    slotKinds[Math.floor(rng() * normalCount)] = "glassPrison";
  }
  // Same for the big prison's introductory wave — a brood shell is rare enough
  // that leaving it to the roll could hide it for several levels.
  if (game.wave === CFG.bigGlassPrison.firstWave && normalCount > 0 && !slotKinds.includes("bigGlassPrison")) {
    slotKinds[Math.floor(rng() * normalCount)] = "bigGlassPrison";
  }
  // Introductory warble wave gets one guaranteed phased rock so the player
  // meets the pass-through-during-fade mechanic right away.
  if (game.wave === CFG.warble.firstWave && normalCount > 0 && !slotKinds.includes("warble")) {
    slotKinds[Math.floor(rng() * normalCount)] = "warble";
  }
  // Introductory torus wave gets one guaranteed ring so the player meets the
  // splits-into-orbiting-arcs mechanic right away.
  if (game.wave === CFG.torus.firstWave && normalCount > 0 && !slotKinds.includes("torus")) {
    slotKinds[Math.floor(rng() * normalCount)] = "torus";
  }
  // Rookie warm-up stage 2: the lone wave-1 rock is a single solid crystal —
  // a gentle first look at the tough faceted kind before the density wave.
  if (game.wave === 1 && game.warmupCrystalStage === 2 && normalCount > 0) {
    slotKinds[0] = "solidCrystal";
  }

  // Build the concrete spawn descriptors. Special slots (gem / solid / prison)
  // keep their authored size. The plain "normal" rocks instead pool their total
  // large-equivalent mass and get redistributed across the size ladder
  // (huge / large / medium / small) — same total mass per wave, just a varied
  // mix. See redistributeNormalMass; it's biased so most mass stays plain large.
  const specialSpawns: { kind: AsteroidKind | undefined; size: AsteroidSize }[] = [];
  let normalLargeCount = 0;
  for (const kind of slotKinds) {
    if (kind === "normal") { normalLargeCount++; continue; }
    // Solid crystal + metal chunk are medium-sized; the other specials spawn large.
    specialSpawns.push({ kind, size: kind === "solidCrystal" || kind === "metalChunk" ? "medium" : "large" });
  }
  // Huge rocks only start appearing at display wave 3 (internal wave 4).
  const allowHuge = displayWave(game.wave) >= 3;
  const normalSpawns = redistributeNormalMass(normalLargeCount, allowHuge).map(
    (size): { kind: AsteroidKind | undefined; size: AsteroidSize } => ({ kind: undefined, size }),
  );
  const spawns = [...normalSpawns, ...specialSpawns];

  const firstLevelPlacements = isFirstLevel
    ? sampleFirstLevelPlacements(spawns.length, CFG.engageRadius.incoming)
    : null;
  spawns.forEach(({ kind: k, size }, slotIndex) => {
    const rock = isFirstLevel && firstLevelPlacements
      ? spawnFirstLevelDrifter(game, firstLevelPlacements[slotIndex].angle, firstLevelPlacements[slotIndex].dist, k, size, claimed)
      : spawnAsteroidAway(game, k, size, claimed);
    game.asteroids.push(rock);
  });
  for (const kind of activeSpecials) {
    game.asteroids.push(spawnSpecial(game, kind, claimed));
  }
};

// solidCrystalSmall standalone is a "treat", not a fixture; gated chance + late
// first-wave keeps it feeling rare.
const rollSolidCrystalSmallSpawn = (game: Game, claimed: BeatClaimSet) => {
  const cfg = CFG.solidCrystal.smallSpawn;
  if (game.wave >= cfg.firstWave && rng() < cfg.chancePerWave) {
    game.asteroids.push(spawnSolidCrystalSmall(game, claimed));
  }
};
