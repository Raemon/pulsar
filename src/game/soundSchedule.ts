// When each baked sound is allowed to load.
//
// Fetching all ~250 baked variants at once — which is what the cache used to
// do — is the wrong shape twice over. It makes the player wait on the title
// screen for assets that wave 12 needs, and it lands a hundred
// decodeAudioData calls on the audio thread during the intro, which starves
// the beat scheduler (the same symptom that already forced the halo-music
// preload to be spread out by hand).
//
// So every variant declares the earliest wave it can be heard on, and the
// loader in Sound.ts drains the list in that order at a paced rate. The wave
// numbers are not guesses: most of them are `CFG.<thing>.firstWave`, the same
// value the wave director gates the spawn on, so a spawn rule and its sound
// can't drift apart.
//
// `gate: true` marks the handful that must be in cache *before* the run
// starts. That is a deliberately small set, and the bar for joining it is
// specific: a cache miss on this voice is SILENT (its play path has no
// live-synth fallback) AND it can be heard within the first seconds. Anything
// with a live fallback stays out — the worst case there is one hit rendering
// the way the game rendered it before the cache existed, which is inaudible,
// and it is not worth a second of title-screen wait to avoid.

import { ENTITY_CONFIG as CFG } from "./entityConfig";
import { BOSS_FORESHADOW_WAVES, BOSS_WAVES } from "./acts";
import { CALIBRATION_BEAT_INTENSITY } from "./beatCalibration";
import type { SoundName } from "../Sound";

export type SoundLoadEntry = {
  name: SoundName;
  keys: readonly number[];
  /** Earliest wave this variant can be heard on. */
  wave: number;
  /** Must be cached before the run starts. See the note above. */
  gate?: true;
};

// bgBeat's amplitude is baked in, so it needs one render per intensity bucket
// — but only the buckets the wave ramp actually reaches. The ramp runs from
// `base` at wave 1 to `base + range` at `rampWaves`, and playBgBeat rounds to
// one decimal, so most of the 0.0–1.0 space is unreachable and used to be
// fetched (and waited on) for nothing. Derived rather than hardcoded so
// retuning the ramp can't silently strand a bucket with no file — bgBeat is
// the one voice where a miss is always silent.
const bgBeatBuckets = (): Array<{ bucket: number; wave: number }> => {
  const seen = new Map<number, number>();
  const note = (intensity: number, wave: number) => {
    const bucket = Math.round(Math.max(0, Math.min(1, intensity)) * 10) / 10;
    if (bucket <= 0) return;
    const prev = seen.get(bucket);
    if (prev === undefined || wave < prev) seen.set(bucket, wave);
  };
  // The calibration intro beats at its own fixed loudness before wave 1 does.
  note(CALIBRATION_BEAT_INTENSITY, 1);
  const { base, range, rampWaves } = CFG.bgBeatIntensity;
  for (let wave = 1; wave <= rampWaves + 1; wave++) {
    const ramp = Math.max(0, Math.min(1, (wave - 1) / rampWaves));
    note(base + ramp * range, wave);
  }
  return [...seen].map(([bucket, wave]) => ({ bucket, wave })).sort((a, b) => a.wave - b.wave);
};

// playBgBeat composes its key as `pitch * 100 + intensityBucket`, with +1000
// marking the doubletime "light eighth" variant. Downbeats are pitch 1,
// offbeats 1.122.
const bgBeatEntries = (): SoundLoadEntry[] =>
  bgBeatBuckets().flatMap(({ bucket, wave }) => {
    const keys = [1, 1.122].flatMap((pitch) => [pitch * 100 + bucket, pitch * 100 + bucket + 1000]);
    // The first bucket is the one every run opens on — no fallback, heard on
    // the very first beat, so it is the core of the gate.
    return [{ name: "bgBeat" as const, keys, wave, ...(wave <= 1 ? { gate: true as const } : {}) }];
  });

// Bassteroids start at wave 3 (waveDirector returns no bass slots below it),
// which is also when their measure voices and split pitches first sound.
// Index-keyed pools in Sound.ts. Kept as sizes here rather than imported to
// avoid a module cycle; warmBakedCache asserts in DEV that they still match.
export const STREAK_SHIMMER_POOL_SIZE = 13;
export const FIRST_DOT_HUM_POOL_SIZE = 9;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const BASS_WAVE = 3;
const bassPitches = [1, 0.8409];

// A boss's voices are first heard on its foreshadow wave, not the fight.
const bossFirstWave = Math.min(...BOSS_WAVES, ...BOSS_FORESHADOW_WAVES);

export const SOUND_LOAD_SCHEDULE: readonly SoundLoadEntry[] = [
  // ── Gate: silent on miss, audible in the first seconds ──────────────────
  ...bgBeatEntries().filter((e) => e.gate),
  // The on-beat shot. Baked-only since the live Tone fallback was removed.
  { name: "fireBeat", keys: [1], wave: 1, gate: true },
  // Engine drones — the player is holding thrust within a second of spawning.
  { name: "thrust", keys: [1], wave: 1, gate: true },
  { name: "reverseThrust", keys: [1], wave: 1, gate: true },
  { name: "sideThrust", keys: [1], wave: 1, gate: true },
  // Hold-to-charge bed and the shot it releases. A full charge takes a couple
  // of seconds, so every tier is reachable inside the opening exchange.
  { name: "chargeBed", keys: [0, 1, 2, 3, 4], wave: 1, gate: true },
  { name: "laserShot", keys: [0, 1, 2, 3, 4], wave: 1, gate: true },
  // Hovering a first-beat dot is the tutorial's first milestone; the base,
  // octave and lock hums are the ones a new player reaches immediately.
  { name: "firstDotHum", keys: [0, 1, 2], wave: 1, gate: true },

  // ── Wave 1, paced ──────────────────────────────────────────────────────
  // The rest of the drift-hum ladder needs a longer hold to unlock.
  { name: "firstDotHum", keys: range(FIRST_DOT_HUM_POOL_SIZE).slice(3), wave: 1 },
  // Streak shimmer needs several on-beat kills in a row to start.
  { name: "streakShimmer", keys: range(STREAK_SHIMMER_POOL_SIZE), wave: 1 },
  { name: "chime", keys: [1], wave: 1 },
  { name: "fire", keys: [1], wave: 1 },
  { name: "calibrationTap", keys: [1], wave: 1 },
  { name: "comboTick", keys: [1], wave: 1 },
  { name: "comboSparkle", keys: [1, 0.5], wave: 1 },
  { name: "explosionSmall", keys: [1], wave: 1 },
  { name: "explosionMedium", keys: [1], wave: 1 },
  { name: "explosionLarge", keys: [1], wave: 1 },
  { name: "asteroidBoomBeat", keys: [1], wave: 1 },
  { name: "comboLost", keys: [1], wave: 1 },
  { name: "comboLostFire", keys: [1], wave: 1 },
  { name: "laserCharge", keys: [1, 2, 3, 4], wave: 1 },
  { name: "laserChargeFail", keys: [1], wave: 1 },
  { name: "driftShotHit", keys: [1, 2, 3, 4, 5, 6], wave: 1 },
  // comboChime keys by fundamental; the low anchors are the first few kills.
  { name: "comboChime", keys: [65.41, 98.0, 146.83], wave: 1 },
  { name: "death", keys: [1], wave: 1 },
  // The warm-up crystal can appear in wave 1 (waveDirector's warmupCrystalStage),
  // ahead of solidCrystal's own firstWave. 0.55 is the non-lethal chip.
  { name: "crystalShatterLarge", keys: [0, 1, 0.55], wave: 1 },
  { name: "crystalShatterSmall", keys: [0, 1, 0.55], wave: 1 },
  // The glassy crystal-asteroid tink. playTink ignores pitchRatio, so the
  // 0.5–0.9 values collisions.ts passes all land on the one render.
  { name: "tink", keys: [1], wave: CFG.asteroidWithGem.firstWave },

  // ── End of wave 1: the summary drain ───────────────────────────────────
  { name: "waveClear", keys: [1], wave: 1 },
  { name: "drainChime", keys: [1, 2, 3, 4, 6, 8], wave: 1 },
  { name: "scoreBlip", keys: [1, 1.122, 1.189, 1.335, 1.498, 1.587, 1.682], wave: 1 },
  { name: "summaryDownbeat", keys: [0, 1, 2, 3], wave: 1 },
  { name: "summaryDownbeatDucked", keys: [0, 1, 2, 3], wave: 1 },
  { name: "bell", keys: [1.189], wave: 1 },

  // ── Everything after, in the order the wave director introduces it ─────
  // The remaining comboChime notes: reaching them needs a long combo.
  { name: "comboChime", keys: [155.56, 164.81, 174.61, 196.0, 220.0, 233.08, 261.63], wave: 2 },
  { name: "comboChime", keys: [293.66, 311.13, 329.63, 349.23, 392.0, 440.0, 466.16], wave: 3 },
  { name: "comboChime", keys: [523.25, 587.33, 622.25, 659.25, 698.46, 783.99, 880.0], wave: 4 },
  ...bgBeatEntries().filter((e) => !e.gate),

  { name: "bassKick", keys: bassPitches, wave: BASS_WAVE },
  { name: "bassBoom", keys: bassPitches, wave: BASS_WAVE },
  // bassPluck is the one bass voice whose config gives it a universal pitch
  // (0.59), and play() multiplies that into the key — so its real keys are the
  // split ratios scaled by it, not the raw ratios. Both sets are listed: the
  // scaled pair is what ships today, the raw pair is what a config reset would
  // ask for, and four small files is cheaper than a silent miss either way.
  { name: "bassPluck", keys: [...bassPitches, 0.59, 0.4961], wave: BASS_WAVE },
  { name: "bassSnap", keys: bassPitches, wave: BASS_WAVE },
  { name: "bassHit", keys: [1], wave: BASS_WAVE },
  { name: "bassEcho", keys: [1], wave: BASS_WAVE },
  { name: "bassteroidDrone", keys: [0, 1, 2, 3, 4, 5, 6, 7], wave: BASS_WAVE },

  { name: "canisterAppear", keys: [1], wave: CFG.canister.firstWave },
  { name: "canisterDestroyed", keys: [1], wave: CFG.canister.firstWave },
  { name: "powerup", keys: [1], wave: CFG.canister.firstWave },
  // The bomb's two muzzle voices can't be heard until its pod has dropped.
  { name: "fireBomb", keys: [1], wave: CFG.canister.firstWave },
  { name: "fireBombBeat", keys: [1], wave: CFG.canister.firstWave },
  { name: "shieldPop", keys: [1], wave: CFG.canister.firstWave },
  // An extra life is a score threshold, not a spawn — first plausible around
  // the time canisters start showing up.
  { name: "bonusLife", keys: [1], wave: CFG.canister.firstWave },

  { name: "cometNote", keys: [0, 1, 2, 3, 4, 6, 7], wave: CFG.comet.firstWave },
  { name: "cometDestroyed", keys: [1], wave: CFG.comet.firstWave },
  { name: "cometDestroyedSad", keys: [1], wave: CFG.comet.firstWave },

  { name: "alienDrone", keys: [0, 1, 2], wave: CFG.alien.firstWave },
  { name: "alienFireBig", keys: [0, 1, 2, 3], wave: CFG.alien.firstWave },
  { name: "alienFireMedium", keys: [0, 1, 2, 3], wave: CFG.alien.firstWave },
  { name: "alienFireSmall", keys: [1], wave: CFG.alien.firstWave },
  { name: "alienHit", keys: [1], wave: CFG.alien.firstWave },
  { name: "alienExplode", keys: [1], wave: CFG.alien.firstWave },

  { name: "shockwaveCharge", keys: [1], wave: CFG.shockwave.firstWave },
  { name: "shockwaveBoom", keys: [1], wave: CFG.shockwave.firstWave },
  { name: "pulsarHum", keys: [1], wave: CFG.shockwave.firstWave },

  { name: "meteorShower", keys: [1], wave: CFG.meteorShower.firstWave },
  { name: "gemSwarm", keys: [1], wave: CFG.gemSwarm.firstWave },

  { name: "bell", keys: [1, 0.55], wave: CFG.bell.firstWave },
  { name: "warble", keys: [1], wave: CFG.warble.firstWave },
  { name: "warbleDrone", keys: [0, 1], wave: CFG.warble.firstWave },
  { name: "wraithScream", keys: [1], wave: CFG.glassPrison.firstWave },
  { name: "wraithHit", keys: [1], wave: CFG.glassPrison.firstWave },
  { name: "wraithLunge", keys: [1], wave: CFG.glassPrison.firstWave },
  { name: "wraithDeath", keys: [1], wave: CFG.glassPrison.firstWave },
  // The boss itself, and its foreshadow wave one earlier.
  { name: "bossPulse", keys: [1], wave: bossFirstWave },
  { name: "bossHit", keys: [1], wave: bossFirstWave },
  { name: "bossEyeOpenStinger", keys: [1], wave: bossFirstWave },
];
