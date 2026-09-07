import type { Game } from "../Game";
import { resetAimHint } from "./aimHint";
import { Ship } from "../Ship";
import { spawnAsteroidAtEdge, BASS_KINDS } from "../Asteroid";
import { ParticleSystem } from "../Particle";
import { v } from "../vec";
import { syncHud, syncComboHud, syncPowerupHud } from "./hud";
import { comboGrid, beatWindow } from "./rhythmGate";
import { spawnWave, updateBgBeatIntensity, spawnTutorialSmall, isVeteranPilot } from "./waveDirector";
import { newWaveEventSchedule } from "./waveEvents";
import { stopParade } from "./killedParade";
import { renderKilledRow } from "./killedParade";
import { snapshotShipKill } from "./killSnapshot";
import { emitShipDebris } from "./particleBursts";
import { clearPlayerFilter, hideScoreEntry, isScoreEntryBlockingEnter, showLeaderboard, showScoreEntry } from "./scoreEntry";
import { BOSS_MUSIC_VARIATIONS, HALO_MUSIC_POOL, HAUNTING_MUSIC_POOL } from "./haloMusicConfig";
import { FULL_HALO_SONGS, USE_FULL_HALO_MUSIC, type FullHaloSong } from "./haloFullMusicConfig";
import { hideWaveSummary } from "./waveSummary";
import { hideWaveAnnounce } from "./gameUpdate";
import { hideGameOverIntro, showGameOverIntro } from "./gameOverIntro";
import { hasCalibrated, CALIBRATION_BEAT_INTENSITY, loadBeatOffset } from "./beatCalibration";
import { pickIntroHints } from "./introHints";
import { isNewDaySession, markSessionStart } from "./sessionTracker";
import { rng, seedRng } from "./rng";
import { ReplayRecorder } from "./replayRecorder";
import { ReplayPlayer } from "./replayPlayer";
import { decodeReplay } from "./replayFormat";
import { HighlightTimeline } from "./highlightTimeline";
import { resetHuePaletteCursor } from "../Asteroid";
import { getBindings, normalizeBindings, setReplayBindings, emptyTutorialControlsUsed, type TutorialControlsUsed } from "./controlBindings";
import { precomputeRhythmHistogram } from "./gameUpdate";
import { resetWaveSkip } from "./waveSkip";
import { FIRST_BONUS_LIFE_SCORE } from "./bonusLife";
import { shiftEntranceFrames } from "./entrance";

// React-side <FirstWaveHint> subscribes to this so the canvas/game loop stays
//   out of layout + transitions — CSS + a single setTimeout do the dismiss work.
export const setFirstWaveHintStage = (game: Game, stage: 0 | 1 | 2 | 3 | 4 | 5 | 6) => {
  if (game.firstWaveHintStage === stage) return;
  game.firstWaveHintStage = stage;
  // stage transitions always reset the sub-line + the stage-2 hit pips; both
  //   re-open only when the player's on-beat hits during stage 2 fill them.
  if (game.firstWaveHintSubVisible) setFirstWaveHintSubVisible(game, false);
  if (game.firstWaveOnBeatHitCount !== 0) {
    game.firstWaveOnBeatHitCount = 0;
    emitFirstWaveHintHitProgress(0);
  }
  window.dispatchEvent(new CustomEvent("first-wave-hint:stage", { detail: { stage } }));
  if (stage === 5) {
    // build-to-4x stage. Wipe rhythm so the player has to rebuild from scratch
    //   — clearComboSilently also emits rhythmProgress(0) for the diamond row.
    clearComboSilently(game);
  } else {
    // leaving the build-to-4x stage (or never entering it) clears the diamond row.
    emitFirstWaveHintRhythmProgress(0);
  }
};

export const setFirstWaveHintSubVisible = (game: Game, visible: boolean) => {
  if (game.firstWaveHintSubVisible === visible) return;
  game.firstWaveHintSubVisible = visible;
  window.dispatchEvent(new CustomEvent("first-wave-hint:sub", { detail: { visible } }));
};

// stage-1 progress diamonds (3 of them) light up as the player banks on-beat
//   fires; React redraws when this fires.
export const emitFirstWaveHintProgress = (count: number) => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:progress", { detail: { count } }));
};

// stage-2 progress diamonds (3 of them) light up as the player banks on-beat
//   hits; on the third one, the sub-line ("Use your targeting tools to help")
//   reveals via setFirstWaveHintSubVisible.
export const emitFirstWaveHintHitProgress = (count: number) => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:hitProgress", { detail: { count } }));
};

// stage-3 ready: fires once `beatCombo` reaches 3 while stage 3 is showing.
//   Until then, the React component holds stage 3 at full opacity instead of
//   starting its 3s dismissal timer. If the player is already past 3x rhythm
//   at stage-3 entry (the usual case), this fires immediately.
export const emitFirstWaveHintStage3Ready = () => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:stage3Ready"));
};

// stage-3 diamonds (3 of them) mirror the player's current rhythm count
//   (capped at 3). When the player enters stage 3 below 3x, the row fills
//   as on-beat hits land; when they enter at 3x or higher, all three are
//   already filled.
export const emitFirstWaveHintRhythmProgress = (count: number) => {
  window.dispatchEvent(new CustomEvent("first-wave-hint:rhythmProgress", { detail: { count } }));
};

// Guided-tutorial signals (consumed by the tutorial UI). hoverProgress drives the
//   "hold your reticule" circle (0→1 over one second); the two *Done events mark
//   the milestones that gate the spawn machine — see gameUpdate.tickTutorialSpawn.
export const emitTutorialHoverProgress = (value: number) => {
  window.dispatchEvent(new CustomEvent("tutorial:hoverProgress", { detail: { value } }));
};
// controls-phase usage (stage 1 + normal-mode start-of-run hint) — drives the
//   fade-as-used keys in <TutorialControlsHint>.
export const emitTutorialControls = (used: TutorialControlsUsed) => {
  // copy: `used` is the live, mutated game object — React's setUsed would bail on an
  //   unchanged reference, so each emit must carry a fresh object.
  window.dispatchEvent(new CustomEvent("tutorial:controls", { detail: { ...used } }));
};
export const emitTutorialHoverDone = () => {
  window.dispatchEvent(new CustomEvent("tutorial:hoverDone"));
};
export const emitTutorialFireHitDone = () => {
  window.dispatchEvent(new CustomEvent("tutorial:fireHitDone"));
};


// Fisher-Yates over Array.sort — sort's randomness is biased and varies across engines.
const shuffled = <T,>(arr: ReadonlyArray<T>): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// title screen needs visible motion; decorative rocks don't carry HP or split logic.
const spawnTitleDecorativeAsteroids = (game: Game) => {
  const decorativeAsteroidIndices = [0, 1, 2, 3, 4];
  for (const _ of decorativeAsteroidIndices) {
    game.asteroids.push(spawnAsteroidAtEdge(game.w, game.h));
  }
};

// drone loops can outlive a wave — every state-leaver calls this to avoid stale audio.
const stopAllPersistentAudio = (game: Game) => {
  game.sound.stopAllAlienDrones();
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllWarbleDrones();
  game.sound.stopAllCometShimmers();
  game.sound.stopHaloAmbient();
  // The full-length halo song is a long un-looped track that can outlive a wave
  // like a drone — explicitly stop it on every state exit so it can't bleed
  // into a cutscene / title / game-over.
  game.sound.stopHaloFullMusic();
  game.comets = [];
};

// lifecycle transitions have their own cues; the loseCombo wrrr would just clutter them.
const clearComboSilently = (game: Game) => {
  game.beatCombo = 0;
  game.firedOffBeatSinceLastBeat = false;
  syncComboHud(game);
  if (game.firstWaveHintStage === 5) emitFirstWaveHintRhythmProgress(0);
};

// carries the prior run's trophy lineup so a returning player still sees what they took down.
export const showTitle = (game: Game) => {
  // drop any active replay-binding override (lingers when a replay ran to end-of-stream
  //   and the player exits to title; otherwise the next live run sees the watched
  //   pilot's bindings instead of their own).
  setReplayBindings(null);
  game.betaMode = false;
  game.state = "title";
  game.overlayTitleEl.textContent = "Pulsar";
  game.overlayStartEl.textContent = "Start";
  game.overlayStartEl.classList.remove("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.remove("gameover-layout");
  game.overlayEl.classList.remove("highlight-clip");
  hideGameOverIntro();
  renderKilledRow(game);
  clearComboSilently(game);
  game.asteroids = [];
  game.canisters = [];
  game.gems = [];
  game.fuelOrbs = [];
  stopAllPersistentAudio(game);
  game.aliens = [];
  game.alienBullets = [];
  game.bossBeams = [];
  game.waveEvents = newWaveEventSchedule();
  game.slowMoTimer = 0;
  game.sound.bgBeatIntensity = 0;
  game.pulsar.setBossPlanetState("idle");
  spawnTitleDecorativeAsteroids(game);
  game.ship.prongCount = 0;
  game.ship.rapidActive = false;
  game.ship.pierceActive = false;
  game.ship.shieldActive = false;
  game.ship.radarActive = false;
  game.ship.longshotActive = false;
  game.ship.sideEnginesActive = false;
  game.ship.bombActive = false;
  syncPowerupHud(game);
  hideScoreEntry(game);
  showLeaderboard(game);
  hideWaveSummary(game);
  setFirstWaveHintStage(game, 0);
  game.waveTransitioning = false;
  game.waveTransition = null;
  emitGameState(game);
};

// First run gates on the latency calibrator: rhythm scoring is meaningless if the
//   player's "on the beat" presses are landing 150ms late through a Bluetooth
//   speaker and they've no idea where the beat even is. Once they've calibrated
//   (or skipped) the result persists, so every later run goes straight in.
//
// Resumes the AudioContext on the user gesture and awaits the baked-mp3 cache
//   before kicking off the run, so the first sounds always play from cache and
//   the live Tone fallback (which crashes on some browsers' stubbed Web Audio)
//   is never exercised during gameplay.
export const requestStart = (game: Game) => {
  if (game.calibrating || game.calibrationIntro || game.introOverlayActive || game.startPending) return;
  game.startPending = true;
  // Await the context actually reaching "running" (resume now retries until it
  //   does) alongside the baked-mp3 cache, so the run never starts scheduling
  //   sounds into a still-suspended context — the cause of silent-until-reload.
  void Promise.all([game.sound.resume(), game.sound.bakedCacheReady()]).then(() => {
    game.startPending = false;
    if (!hasCalibrated()) {
      startCalibrationIntro(game);
      return;
    }
    // Already-calibrated players get a pilot's-log opener instead of jumping
    //   straight in. New day (>=4h) → full triplet + "Become one with the
    //   Pulsar"; otherwise → one hint as a quick fade. Same shape for veterans
    //   and rookies on same-day re-entry.
    if (isNewDaySession()) {
      startGameWithIntro(game, "fullHints");
    } else {
      startGameWithIntro(game, "shortHint");
    }
  });
};

// Spin up a real run, but with the intro overlay riding on top — the world is
//   held by updateGame's introOverlayActive short-circuit while the beat ticks
//   under the black overlay. When IntroSequence fires `intro-sequence:done`,
//   we drop the flag and play takes over from the same beat clock.
const startGameWithIntro = (game: Game, kind: "fullHints" | "shortHint") => {
  markSessionStart();
  startGame(game);
  // startGame set state=playing and spawned the wave; immediately hide the
  //   world behind the intro and gate fire off via introOverlayActive.
  game.introOverlayActive = true;
  game.introOverlayStep = kind;
  game.introOverlayHints = pickIntroHints(kind === "fullHints" ? 3 : 1);
  game.ship.invuln = Math.max(game.ship.invuln, 2.0);
  // Hold the bgBeat at calibration loudness for the intro and ramp down once
  //   play actually begins; same pattern as the post-calibration hand-off.
  game.sound.bgBeatIntensity = CALIBRATION_BEAT_INTENSITY;
  game.beatIntensityRamp = null;
  window.dispatchEvent(new CustomEvent("intro-sequence:start", { detail: { kind, hints: game.introOverlayHints } }));
};

// Recalibration only (settings "Resync the beat"): the standalone calibrator
//   schedules its own beat, used when there's no run to fold the pulse into.
export const openBeatCalibrator = (game: Game) => {
  if (game.calibrating || game.calibrationIntro) return;
  game.calibrating = true;
  game.sound.resume();
  window.dispatchEvent(new CustomEvent("beat-calibrator:open", { detail: { sound: game.sound, intro: false } }));
};

// First run: the run actually begins, but the world is held and only the beat
//   plays while the player practices tapping in rhythm. The same beat clock
//   carries straight into live play (updateCalibration → finishCalibrationIntro),
//   so there's no stop-restart at the hand-off.
export const startCalibrationIntro = (game: Game) => {
  game.sound.resume();
  game.sound.preloadPilotLog(6);
  game.sound.preloadPilotLog(12);
  // Wave 1 only ever needs HALO_MUSIC_POOL — warm just those here so the
  // first 4x trigger doesn't pay fetch latency. The haunting pool + boss
  // variation are deferred to unfreezeIntroWorld (see preloadDeferredMusic)
  // because back-to-back decodes during the intro starve the audio
  // scheduler and skip beats.
  for (const variation of HALO_MUSIC_POOL) game.sound.preloadHaloMusic(variation);
  // The streak sound's updraft roll needs its two loop stems decoded before
  // the first streak forms (streaks can start seconds into wave 1).
  game.sound.preloadStreakMusic();
  // Wave 1 is a full-halo wave when USE_FULL_HALO_MUSIC is on, so warm the
  // full-song layer stems too — its first 4x will start a full song, not a loop.
  if (USE_FULL_HALO_MUSIC) {
    for (const song of Object.keys(FULL_HALO_SONGS) as FullHaloSong[]) game.sound.preloadHaloFullMusic(song);
  }
  game.betaMode = false;
  game.state = "playing";
  game.calibrationIntro = true;
  game.calibrating = true;
  game.score = 0;
  game.wave = 1;
  game.lives = 3;
  game.nextBonusLifeScore = FIRST_BONUS_LIFE_SCORE;
  game.waveTransitioning = false;
  resetRunTimers(game);
  resetRunCollections(game);
  game.bassOrder = shuffled(BASS_KINDS);
  game.particles = new ParticleSystem();
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 1e9; // untouchable through the warm-up
  game.pulsar.setBossPlanetState("idle");
  game.pulsar.setWaveLevel(game.wave);
  game.sound.bgBeatIntensity = CALIBRATION_BEAT_INTENSITY;
  game.beatIntensityRamp = null;
  game.overlayEl.classList.add("hidden");
  hideScoreEntry(game);
  game.leaderboardEl.classList.add("hidden");
  game.lastRunScore = null;
  game.lastRunScoreId = null;
  game.showNeighborhoodOnce = false;
  game.neighborhoodFetch = null;
  game.leaderboardNeighborhood = false;
  game.leaderboardRankBase = 0;
  clearPlayerFilter(game);
  syncHud(game);
  emitGameState(game);
  window.dispatchEvent(new CustomEvent("beat-calibrator:open", { detail: { sound: game.sound, intro: true } }));
};

// Player locked in: hand off the calibrator's beat clock to the pilot's-log
//   intro overlay. The world stays held (introOverlayActive shares the same
//   short-circuit path calibrationIntro uses) and beat keeps ticking under the
//   "Latency calibrated" beat and the 3-hint sequence. When the intro fires
//   `intro-sequence:done`, finalizeIntroToPlay brings wave 1 to life.
export const finishCalibrationIntro = (game: Game) => {
  game.calibrationIntro = false;
  game.calibrating = false;
  game.introOverlayActive = true;
  game.introOverlayStep = "latency";
  game.introOverlayHints = pickIntroHints(3);
  // startCalibrationIntro set invuln to 1e9 for the warm-up; replace (don't Math.max)
  // so the player is actually vulnerable once the post-calibration intro hands off to play.
  game.ship.invuln = 2.0;
  markSessionStart();
  // First-ever calibration always counts as a fresh day — kick off the latency
  //   announcement and queue the pilot's log triplet right after. The chain
  //   latency → fullHints → finalize is advanced by the Game.ts handler for
  //   `intro-sequence:done` (it re-fires `intro-sequence:start` for fullHints).
  window.dispatchEvent(new CustomEvent("intro-sequence:start", { detail: { kind: "latency", hints: game.introOverlayHints } }));
};

// Called by the Game-level `intro-sequence:done` handler to advance the chain.
//   For the post-calibration chain, "latency" hands off to "fullHints"; for
//   any single-leg chain (daily fullHints or shortHint, or the trailing
//   fullHints of the post-calibration chain), the next done finalizes play.
export const advanceIntroOverlay = (game: Game) => {
  if (game.introOverlayStep === "latency") {
    // Chain hands off to the pilot's-log triplet — keep the world frozen, the
    //   bg stays black, the beat keeps ticking under the new leg.
    game.introOverlayStep = "fullHints";
    window.dispatchEvent(new CustomEvent("intro-sequence:start", { detail: { kind: "fullHints", hints: game.introOverlayHints } }));
    return;
  }
  // shortHint or fullHints leg's text has fully faded out — the unfreeze
  //   already fired mid-fade, so this is just bookkeeping.
  finalizeIntroToPlay(game);
};

// Fired the moment IntroSequence begins fading from black — the world wakes up
//   *during* the fade-in instead of after it, so the player can move as soon as
//   the screen starts revealing. The bgBeat stays at the intro's loudness
//   (CALIBRATION_BEAT_INTENSITY) so the pulse doesn't dip when play starts; the
//   wave director will set per-wave levels on wave changes from there on.
export const unfreezeIntroWorld = (game: Game) => {
  if (!game.introOverlayActive) return;
  game.introOverlayActive = false;
  game.beatIntensityRamp = null;
  game.sound.bgBeatIntensity = CALIBRATION_BEAT_INTENSITY;
  // Intro is fading out — kick off the deferred music preload now. The
  // haunting pool isn't needed until wave 12 and the boss variation not
  // until wave 11, so we have minutes of slack to warm them one stem at
  // a time without contending with active beat scheduling.
  game.sound.preloadHaloMusicSequential([...HAUNTING_MUSIC_POOL, ...BOSS_MUSIC_VARIATIONS]);
  // Post-calibration chain only: spawn wave 1 + tutorial if we haven't yet.
  //   startGameWithIntro already spawned the wave; in that case `hasSpawnedFirstLevel`
  //   is true and beginFirstWaveByTutorialFlag is skipped.
  if (!game.hasSpawnedFirstLevel) {
    game.firstWaveOnBeatFireCount = 0;
    game.firstWaveOnBeatHitCount = 0;
    game.tutorialActive = false;
    game.tutorialHoverDone = false;
    game.tutorialFireHitDone = false;
    emitFirstWaveHintProgress(0);
    emitFirstWaveHintHitProgress(0);
    emitFirstWaveHintRhythmProgress(0);
    beginFirstWaveByTutorialFlag(game, game.tutorialRequested, isVeteranPilot());
  }
  syncHud(game);
};

// Final cleanup after IntroSequence's last leg fades out completely. The world
//   has already been awake since `unfreezeIntroWorld` fired earlier in the
//   fade-in; this just clears the residual chain state.
export const finalizeIntroToPlay = (game: Game) => {
  unfreezeIntroWorld(game); // no-op if unfreeze already fired
  game.introOverlayStep = null;
  game.introOverlayHints = [];
};

// Tutorial button → guided tutorial (single practice rock + stage 1 controls hint);
//   Start button → skips straight to the single-asteroid warm-up (displayed Wave 0).
//   Veteran pilots (anyone who has ever hit 6x rhythm) skip the warm-up and start on
//   the first proper density wave instead. Used at both calibration hand-off and the
//   direct startGame path so the two stay in sync.
const beginFirstWaveByTutorialFlag = (game: Game, tutorial: boolean, veteran: boolean) => {
  game.tutorialControlsUsed = emptyTutorialControlsUsed();
  // Rookie Start-button runs get the two single-target warm-ups (rock, then
  //   crystal); tutorial + veteran runs skip them. Set unconditionally so a
  //   restart never inherits a mid-warm-up stage from the previous run.
  game.warmupCrystalStage = !tutorial && !veteran ? 1 : 0;
  if (tutorial) {
    game.tutorialActive = true;
    spawnTutorialSmall(game);
    setFirstWaveHintStage(game, 1);
  } else {
    setFirstWaveHintStage(game, 0);
    if (veteran) {
      game.wave = 2;
      game.pulsar.setWaveLevel(game.wave);
      updateBgBeatIntensity(game);
      syncHud(game);
    }
    spawnWave(game);
    game.controlsHintActive = true;
    window.dispatchEvent(new CustomEvent("controls-hint:show"));
  }
};

// per-run randomised bass intro order means the wave-2/3 picks vary between runs.
// Overrides (set by startReplay) freeze the seed + tutorial/veteran flags so
//   wave-1 spawn reproduces deterministically from the recording.
export const startGame = (game: Game, overrides?: {
  seed: number;
  tutorial: boolean;
  veteran: boolean;
  recorder: false;
  // Replay path only: the recording's calibrated latency. perceivedBeatTime =
  //   beatTime - beatOffset drives the whole on-beat gate, so the re-sim must
  //   use the recorder's offset, not the viewer's persisted one.
  beatOffset: number;
}) => {
  game.sound.resume();
  game.sound.preloadPilotLog(6);
  game.sound.preloadPilotLog(12);
  // Warm every halo music stem in the pool so whichever variation gets
  // randomly picked at the first 4x doesn't pay fetch+decode latency.
  // Haunting pool + boss variation are deferred until the intro fades out
  // (see preloadDeferredMusic in unfreezeIntroWorld) — back-to-back decodes
  // during the intro starve the audio scheduler and skip beats.
  for (const variation of HALO_MUSIC_POOL) {
    game.sound.preloadHaloMusic(variation);
  }
  // Seed the PRNG before anything random fires (bassOrder shuffle, wave events,
  //   asteroid hues). Re-arming the lazy hue cursor lets the first nextWaveHue
  //   call after this draw from the seeded RNG, not whichever cursor a previous
  //   run left behind. Replay overrides supply the recorded seed up front so the
  //   downstream shuffle + wave spawn draw the same numbers the recording saw.
  game.runSeed = overrides
    ? overrides.seed
    : (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
  seedRng(game.runSeed);
  resetHuePaletteCursor();
  const tutorial = overrides ? overrides.tutorial : game.tutorialRequested;
  const veteran = overrides ? overrides.veteran : isVeteranPilot();
  // Replay re-sim runs on the recording's latency offset; a live run keeps the
  //   viewer's already-loaded game.beatOffset untouched.
  if (overrides) game.beatOffset = overrides.beatOffset;
  // Replay path skips the recorder — playback uses the player, not capture.
  game.recorder = overrides ? null : new ReplayRecorder({
    seed: game.runSeed,
    beatOffset: game.beatOffset,
    w: game.w,
    h: game.h,
    dpr: game.dpr,
    tutorial,
    veteran,
    bindings: getBindings(),
  });
  game.replayPlayer = null;
  game.highlightTimeline = new HighlightTimeline();
  game.highlightClip = null;
  // A replay/highlight-clip rebuild (overrides set) must NOT wipe runSummary,
  //   the just-finished run's upload bytes, or the loop's fade phase — the
  //   game-over screen is still showing the clip. Only a genuine fresh run
  //   clears them (restartReplayWorld restores them across the clip's own
  //   rebuilds). lastRunReplay especially: the clip loops every few seconds,
  //   and each loop rebuilds the world, so clearing here would silently drop
  //   the gzipped bytes the score form is about to upload.
  if (!overrides) {
    game.runSummary = null;
    game.lastRunReplay = null;
    game.highlightLoop = null;
    document.getElementById("highlight-fade")?.classList.remove("fading");
  }
  game.input = game.localInput;
  game.betaMode = false;
  game.state = "playing";
  game.score = 0;
  game.wave = 1;
  game.lives = 3;
  game.nextBonusLifeScore = FIRST_BONUS_LIFE_SCORE;
  game.waveTransitioning = false;
  resetRunTimers(game);
  resetRunCollections(game);
  game.bassOrder = shuffled(BASS_KINDS);
  game.particles = new ParticleSystem();
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 2.0;
  game.pulsar.setBossPlanetState("idle");
  game.pulsar.setWaveLevel(game.wave);
  updateBgBeatIntensity(game);
  game.firstWaveOnBeatFireCount = 0;
  game.firstWaveOnBeatHitCount = 0;
  emitFirstWaveHintProgress(0);
  emitFirstWaveHintHitProgress(0);
  emitFirstWaveHintRhythmProgress(0);
  beginFirstWaveByTutorialFlag(game, tutorial, veteran);
  game.overlayEl.classList.add("hidden");
  hideScoreEntry(game);
  game.leaderboardEl.classList.add("hidden");
  game.lastRunScore = null;
  game.lastRunScoreId = null;
  game.showNeighborhoodOnce = false;
  game.neighborhoodFetch = null;
  game.leaderboardNeighborhood = false;
  game.leaderboardRankBase = 0;
  clearPlayerFilter(game);
  syncHud(game);
  emitGameState(game);
};

// run-scoped state only; spawnWave handles per-wave timers separately.
const resetRunTimers = (game: Game) => {
  game.beatTime = 0;
  game.lastBeatResnapAt = game.beatTime;
  game.beatPhaseCorrection = 0;
  game.lastBgBeatIndex = -1;
  game.nextBeatToEvaluate = 0;
  game.beatCombo = 0;
  game.maxCombo = 0;
  game.maxComboThisWave = 0;
  game.waveStartRhythm = 0;
  game.driftBonusesThisWave = 0;
  game.hasShownDriftShotLabel = false;
  game.bestDriftDamageMultShown = 0;
  game.firedOffBeatSinceLastBeat = false;
  game.pendingDriftBonuses = [];
  game.pendingRhythmBonuses = [];
  game.lastRhythmHitBeatCenter = -1;
  game.rhythmHitsThisBeat = 0;
  game.lastRhythmHitPos = null;
  game.streakInterval = 0;
  game.streakGrid = 0;
  game.streakShots = 0;
  game.streakEstablished = false;
  game.streakLastBeatCenter = -1;
  game.bestStreakThisWave = 0;
  game.slowMoTimer = 0;
  game.hasLostComboEver = false;
  game.pilotLog1Unlocked = false;
  game.pilotLog3Unlocked = false;
  game.tutorialActive = false;
  game.tutorialHoverDone = false;
  game.tutorialFireHitDone = false;
  game.controlsHintActive = false;
  game.rhythmLossHintPending = false;
  game.beatIntensityRamp = null;
  resetAimHint(game);
  game.hasSpawnedFirstLevel = false;
  game.replayDyingTimer = null;
  resetWaveSkip(game);
  // Drop any in-flight end-of-wave drain/spawn so a stale schedule from the prior
  //   run (or a torn-down replay) can't fire into this fresh world. Beat cues are
  //   keyed to the old beatTime, so they'd be far-future garbage after the reset.
  game.waveTransition = null;
  game.beatCues = [];
};

// parade + drones from the previous title screen must be torn down before the new run runs.
const resetRunCollections = (game: Game) => {
  game.asteroids = [];
  game.bullets = [];
  game.popups = [];
  game.bassLightnings = [];
  game.driftBursts = [];
  game.shards = [];
  game.canisters = [];
  game.gems = [];
  game.fuelOrbs = [];
  game.killedSnapshots = [];
  game.killTally = {};
  stopParade(game);
  game.killedRowEl.classList.add("hidden");
  stopAllPersistentAudio(game);
  game.aliens = [];
  game.alienBullets = [];
  game.bossBeams = [];
  // Skip portals can outlive their wave by design — never a run boundary.
  game.wormholes = [];
  game.waveEvents = newWaveEventSchedule();
};

// one esc handler keeps the pause toggle simple; sub-helpers cover the per-state side effects.
export const togglePause = (game: Game) => {
  if (game.state === "playing") enterPause(game);
  else if (game.state === "paused") leavePause(game);
};

// Click-equivalent of pressing Enter on whichever overlay is showing.
export const triggerOverlayStart = (game: Game) => {
  if (game.state === "title") requestStart(game);
  else if (game.state === "paused") leavePause(game);
  else if (game.state === "gameover") {
    if (isScoreEntryBlockingEnter(game)) return;
    stopParade(game);
    game.killedRowEl.classList.add("hidden");
    game.killedSnapshots = [];
    showTitle(game);
  }
};

const enterPause = (game: Game) => {
  game.state = "paused";
  game.ship.thrustOn = false;
  game.ship.reverseThrustOn = false;
  game.ship.portThrustOn = false;
  game.ship.starboardThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
  game.sound.fadeForPause(0, 0.35);
  game.overlayTitleEl.textContent = "Paused";
  game.overlayStartEl.textContent = "Resume";
  game.overlayStartEl.classList.remove("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.add("paused");
  game.overlayEl.classList.remove("gameover-layout");
  hideGameOverIntro();
  game.abortEl.classList.remove("hidden");
  emitGameState(game);
};

const leavePause = (game: Game) => {
  game.state = "playing";
  game.sound.fadeForPause(1, 0.25);
  game.overlayEl.classList.add("hidden");
  game.overlayEl.classList.remove("paused");
  game.abortEl.classList.add("hidden");
  emitGameState(game);
};

// broadcast the game's coarse lifecycle state for UI chrome (pause button visibility,
//   pause-screen controls panel). Cheap, fires only on transition.
export const emitGameState = (game: Game) => {
  // `highlight` lets the ReplayScrubber stay hidden during a game-over highlight
  //   clip — it's a passive backdrop, not a scrubbable leaderboard replay.
  window.dispatchEvent(new CustomEvent("game:state", { detail: { state: game.state, highlight: game.highlightClip !== null } }));
};

// Finalise the in-flight replay recorder (live runs only — replay-driven runs
//   already discarded it). Bytes land on game.lastRunReplay asynchronously
//   after gzip; the gameover overlay polls for them before showing the upload
//   button.
export const finalizeRecorder = (game: Game): void => {
  if (!game.recorder) return;
  const r = game.recorder;
  game.recorder = null;
  void r.serialize({
    score: game.score,
    wave: game.wave,
    maxCombo: game.maxCombo,
    killCount: Object.values(game.killTally).reduce((s, n) => s + n, 0),
  }).then(
    (bytes) => { game.lastRunReplay = bytes; },
    // A gzip/serialise failure would otherwise leave lastRunReplay null forever:
    //   the score form polls for 15s and then reports "Replay unavailable" with
    //   no reason logged anywhere. Say what actually broke.
    (err) => { console.error("[replay] serialise failed — no upload bytes:", err); },
  );
};

// lets a stuck player exit cleanly via the kill-row screen without having to die out.
export const abortMission = (game: Game) => {
  if (game.state !== "paused") return;
  game.state = "gameover";
  finalizeRecorder(game);
  game.ship.thrustOn = false;
  game.ship.reverseThrustOn = false;
  game.ship.portThrustOn = false;
  game.ship.starboardThrustOn = false;
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
  stopAllPersistentAudio(game);
  game.sound.fadeForPause(1, 0.1);
  game.lastRunScore = game.score;
  game.lastRunScoreId = null;
  game.abortEl.classList.add("hidden");
  game.overlayTitleEl.textContent = "";
  game.overlayStartEl.classList.add("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.add("gameover-layout");
  hideWaveSummary(game);
  const shipSnap = snapshotShipKill(game.ship, "death");
  if (shipSnap) game.killedSnapshots.push(shipSnap);
  renderKilledRow(game, "vertical");
  showGameOverIntro(game, "aborted");
  showScoreEntry(game);
  emitGameState(game);
};

// combo grid may have flipped (8ths→quarters if previous life had rapid); rebase the eval index.
export const respawn = (game: Game) => {
  const oldX = game.ship.pos.x;
  const oldY = game.ship.pos.y;
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  // The respawn teleports the locked-centre camera; shift entrance frames by
  // the same jump (as shiftEntranceFrames does for a fold) so mid-entrance
  // bodies keep sliding in from the border instead of popping elsewhere.
  shiftEntranceFrames(game, game.ship.pos.x - oldX, game.ship.pos.y - oldY);
  game.ship.invuln = 2.2;
  game.nextBeatToEvaluate = Math.max(0, Math.floor((game.perceivedBeatTime - beatWindow(game)) / comboGrid(game)) + 1);
  game.state = game.replayPlayer ? "replaying" : "playing";
  syncHud(game);
  emitGameState(game);
};

// death pauses beatTime so a leftover streak would pin the HUD until respawn — drop it now.
export const killShip = (game: Game) => {
  game.shake = 1.5;
  clearComboSilently(game);
  game.sound.stopThrust();
  game.sound.stopReverseThrust();
  game.sound.stopSideThrust();
  game.sound.stopHaloAmbient();
  game.sound.play("death");
  emitShipDebris(game.particles, game.ship.pos);
  game.ship.alive = false;
  // A held super-laser charge doesn't survive death.
  game.ship.superLaserCharged = false;
  game.ship.superLaserChargeGlow = 0;
  game.lives -= 1;
  // During replay we render the death but never flip to "dying"/gameover — the
  //   scrubber stays in control. We still mirror the death→respawn lifecycle so
  //   the recorded inputs after the death drive a freshly-spawned ship (see
  //   tickReplayDying); without this the ship stays dead for the rest of the
  //   recording. The pause length matches dyingTimer so respawn timing — and
  //   thus the re-sim — lines up frame-for-frame with the original run.
  if (game.replayPlayer) { game.replayDyingTimer = 1.8; return; }
  game.state = "dying";
  game.dyingTimer = 1.8;
  emitGameState(game);
};

// Slider position is the source of truth; volumeEl.max = 200 corresponds to
// volume multiplier 2.0. lastNonZeroVolume lets the M key restore the prior
// level after a mute toggle instead of jumping back to max.
let lastNonZeroVolume = 2;

export const applyVolume = (game: Game, multiplier: number) => {
  game.sound.setVolume(multiplier);
  if (multiplier > 0) lastNonZeroVolume = multiplier;
  game.volumeEl.value = String(Math.round(multiplier * 100));
  game.volumeEl.classList.toggle("muted", multiplier === 0);
};

export const toggleMute = (game: Game) => {
  const next = game.sound.volume > 0 ? 0 : lastNonZeroVolume;
  applyVolume(game, next);
};

// Hand the scrubber the per-frame rhythm samples so it can draw the histogram.
//   A plain number[] copy crosses the React boundary cleanly (the Int16Array is
//   reused if the world rebuilds). Sent once per replay, after the precompute.
const emitReplayRhythm = (game: Game) => {
  if (!game.replayPlayer) return;
  window.dispatchEvent(new CustomEvent("replay:rhythm", {
    detail: {
      rhythm: Array.from(game.replayPlayer.rhythmByFrame),
      waveStarts: game.replayPlayer.waveStarts.map((w) => ({ ...w })),
    },
  }));
};

// Start playing a recorded replay. startGame runs with the recorded seed +
//   tutorial/veteran flags supplied up front, so wave-1 spawn and every
//   downstream RNG draw match the original run. The ReplayPlayer's
//   ReplayInput then drives dt + key state from the recorded frames.
export const startReplay = async (game: Game, bytes: Uint8Array): Promise<void> => {
  const payload = await decodeReplay(bytes);
  const player = new ReplayPlayer(payload);
  seedReplayWorld(game, player);
  // Re-sim the whole run once (muted) to fill the scrubber's rhythm histogram,
  //   then rebuild at frame 0 so playback starts clean.
  precomputeRhythmHistogram(game);
  emitReplayRhythm(game);
  // Fresh replay always begins playing at 1x with the playhead at frame 0.
  game.replaySpeed = 1;
  game.replaySeekTarget = null;
  game.replayStepAccumulator = 0;
  game.state = "replaying";
  emitGameState(game);
};

// Leave a full replay (scrubber playback) and return to title. Undoes the
//   replay's input swap + locked canvas dims the same way the highlight clip's
//   exitHighlightToTitle does. Bound to Escape while a scrubber replay runs.
export const exitReplay = (game: Game): void => {
  game.replayPlayer = null;
  game.replaySeekTarget = null;
  game.replayLockedDims = null;
  game.input = game.localInput;
  game.runSummary = null;
  // The replay overwrote game.beatOffset with the recording's value; restore the
  //   viewer's own calibration so their next live run judges on their latency.
  game.beatOffset = loadBeatOffset() ?? 0;
  game.resize();
  showTitle(game);
};

// Start a looping highlight clip from an in-memory payload (the just-finished
//   run's recording, no gzip round-trip). The clip range is consumed by the
//   replay loop, which fast-forwards muted to clip.start, plays to clip.end, then
//   rebuilds + fast-forwards back to start. Used on the game-over screen instead
//   of the parade. Caller has already snapshotted game.runSummary so the world
//   rebuild here doesn't corrupt score submission.
export const startHighlightReplay = (game: Game, player: ReplayPlayer, clip: { start: number; end: number }): void => {
  seedReplayWorld(game, player);
  game.highlightClip = clip;
  game.replaySpeed = 1;
  game.replayStepAccumulator = 0;
  // Enter through the same fade the loop uses: start black so the first
  //   (synchronous) fast-forward from frame 0 to clip.start is hidden, then fade
  //   in on the first clip frame. tickHighlightLoop performs the seek once black.
  game.highlightLoop = { phase: "fadeOut", startedAt: performance.now() };
  document.getElementById("highlight-fade")?.classList.add("fading");
  game.state = "replaying";
  emitGameState(game);
};

// Rewind in place: rebuild the world at frame 0 for the *current* player so a
//   backward seek can fast-forward to its target. Reuses the decoded payload —
//   no re-fetch/decode. Called from the seek path with audio already muted.
export const restartReplayWorld = (game: Game): void => {
  const player = game.replayPlayer;
  if (!player) return;
  // seedReplayWorld → startGame clears highlight state AND hides the game-over
  //   overlay/score form. Snapshot both so a looping highlight clip survives its
  //   own rebuild without re-running showGameOverIntro (which would re-fire the
  //   staged fade + bell) or stealing focus from the score input each loop.
  const clip = game.highlightClip;
  const loop = game.highlightLoop;
  const chrome = clip ? captureGameOverChrome(game) : null;
  // Kill any wave-announce/summary timers left over from before the rewind —
  //   they were scheduled against the pre-seek "now" and would otherwise pop
  //   back up mid-flight, detached from the rewound sim's position.
  hideWaveAnnounce();
  hideWaveSummary(game);
  player.rewindToStart();
  seedReplayWorld(game, player);
  game.highlightClip = clip;
  game.highlightLoop = loop;
  if (chrome) restoreGameOverChrome(game, chrome);
  game.state = "replaying";
  // startGame above broadcast a transient "playing"; re-broadcast the truth
  //   (with the restored highlight flag) so game:state listeners — notably the
  //   scrubber's visibility — don't latch the intermediate state.
  emitGameState(game);
};

// Snapshot the game-over overlay's visibility classes + score-form state so a
//   highlight-clip loop rebuild (startGame hides them) can put them back exactly,
//   without re-triggering the intro animation or the form's focus/reset.
type GameOverChrome = {
  overlayHidden: boolean;
  gameoverLayout: boolean;
  highlightClipClass: boolean;
  scoreFormHidden: boolean;
  leaderboardHidden: boolean;
  inputFocused: boolean;
};
const captureGameOverChrome = (game: Game): GameOverChrome => ({
  overlayHidden: game.overlayEl.classList.contains("hidden"),
  gameoverLayout: game.overlayEl.classList.contains("gameover-layout"),
  highlightClipClass: game.overlayEl.classList.contains("highlight-clip"),
  scoreFormHidden: game.scoreEntryFormEl.classList.contains("hidden"),
  leaderboardHidden: game.leaderboardEl.classList.contains("hidden"),
  inputFocused: document.activeElement === game.scoreEntryInputEl,
});
const restoreGameOverChrome = (game: Game, c: GameOverChrome): void => {
  game.overlayEl.classList.toggle("hidden", c.overlayHidden);
  game.overlayEl.classList.toggle("gameover-layout", c.gameoverLayout);
  game.overlayEl.classList.toggle("highlight-clip", c.highlightClipClass);
  game.scoreEntryFormEl.classList.toggle("hidden", c.scoreFormHidden);
  game.leaderboardEl.classList.toggle("hidden", c.leaderboardHidden);
  // startGame's hideScoreEntry blurred the name field; refocus if the player was
  //   mid-type so the loop rebuild doesn't kick them out of the input.
  if (c.inputFocused && !c.scoreFormHidden) game.scoreEntryInputEl.focus();
};

// Shared world setup for a replay player at frame 0. startGame resets
//   game.replayPlayer to null and re-points game.input at the live keyboard,
//   so we re-install both afterwards.
const seedReplayWorld = (game: Game, player: ReplayPlayer): void => {
  const payload = player.payload;
  // install the recording-time bindings *before* startGame, since startGame's
  //   recorder construction reads getBindings() (skipped on the replay path) and
  //   the wave-spawn doesn't need bindings — but every isDown call from frame 1
  //   onward will.
  setReplayBindings(normalizeBindings(payload.header.bindings));
  // Lock the sim to the recording's dimensions before startGame spawns the
  //   ship — ship.pos and edge-wrap depend on game.w/h, and any mismatch
  //   diverges motion from frame 0. resize() reads replayLockedDims to switch
  //   into the locked-canvas + CSS-letterbox rendering mode.
  game.replayLockedDims = { w: payload.header.w, h: payload.header.h, dpr: payload.header.dpr };
  game.resize();
  startGame(game, {
    seed: payload.header.seed,
    tutorial: payload.header.tutorial,
    veteran: payload.header.veteran,
    recorder: false,
    beatOffset: payload.header.beatOffset,
  });
  // Restore the beat-clock to where the recording's first captured frame sat.
  //   startGame spawned wave 1 at beatTime 0 (matching the recording — recorded
  //   runs always spawn at 0, since the recorder is only created on the
  //   startGameWithIntro path). The live run then held the world under the intro,
  //   advancing beatTime to here with no frames captured. Without this the replay
  //   re-sims from beatTime 0 while the recording's frame 0 was at T_intro,
  //   shifting every on-beat judgment + bass hit and desyncing within wave 1.
  const sb = payload.header.startBeat;
  game.beatTime = sb.beatTime;
  game.lastBgBeatIndex = sb.lastBgBeatIndex;
  game.nextBeatToEvaluate = sb.nextBeatToEvaluate;
  game.lastBeatResnapAt = sb.lastBeatResnapAt;
  game.replayPlayer = player;
  game.input = player.input;
  // Enter "replaying" NOW, before any stepping. startGame above left state
  //   "playing", but the precompute sweep (and seek catch-up) step the sim
  //   immediately — and the death→respawn lifecycle only runs in updateReplaying.
  //   If the sweep ran in "playing" the ship would die and never respawn, so the
  //   rhythm histogram + checkpoint audit would diverge for the whole post-death
  //   tail of any run with a death. restartReplayWorld already sets this; the
  //   first seed (startReplay/startHighlightReplay) must too.
  game.state = "replaying";
};
