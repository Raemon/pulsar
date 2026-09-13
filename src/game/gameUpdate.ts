import type { Game } from "../Game";
import type { ReplayPlayer } from "./replayPlayer";
import { getRngSeed } from "./rng";
import { dist, nearestImageOf } from "../vec";
import { Asteroid, tickTorusGroups, isPhasedKind } from "../Asteroid";
import { Alien, ALIEN_FIRE_PATTERN_BEATS, bigAlienBurstAngleOffset } from "../Alien";
import { AlienBullet } from "../AlienBullet";
import { ENTITY_CONFIG } from "./entityConfig";
import { BEAT_GRID, DEBUG_BEAT_TIMING } from "./rhythmConstants";
import {
  isInBeatWindow,
  logBeatEvent,
  spawnBeatDebugPopup,
  evaluateClosedBeats,
  currentBeatPulse,
  comboGrid,
  loseCombo,
} from "./rhythmGate";
import { BASS_KIND_SOUND, BASS_SPLIT_PITCH_RATIO, tickBassBeats, tickAuxBeats } from "./bassClock";
import { tickWaveEvents } from "./waveEvents";
import { detonateShockwave } from "./shockwave";
import { actOfWave } from "./acts";
import { tickSepulchre } from "./sepulchre";
import { spawnWave, isBossWave, updateBgBeatIntensity, spawnTutorialSmall, spawnTutorialBig, rhythmSpeedMul, displayWave } from "./waveDirector";
import { showWaveSummary, hideWaveSummary, buildSummarySchedule, SummarySchedule } from "./waveSummary";
import { beginWaveTransition, tickWaveTransition } from "./waveTransition";
import {
  handleCollisions,
  handleAlienHits,
  handleAlienBulletHits,
  handleCometHits,
  handleCanisterPickups,
  handleCanisterShots,
  handleGems,
  handleFuelOrbPickups,
  expireGem,
} from "./collisions";
import { requestStart, showTitle, togglePause, respawn, setFirstWaveHintStage, setFirstWaveHintSubVisible, emitFirstWaveHintProgress, emitFirstWaveHintRhythmProgress, emitTutorialHoverProgress, emitTutorialControls, emitGameState, finalizeRecorder, restartReplayWorld } from "./lifecycle";
import { syncHud, syncPowerupHud, syncComboHud, syncFuelHud } from "./hud";
import { renderKilledRow, stopParade } from "./killedParade";
import { recordHighlightFrame } from "./highlightTimeline";
import { tryStartHighlightClip, tickHighlightGameOverInput, beginHighlightLoop, tickHighlightLoop } from "./highlightReplay";
import { snapshotShipKill } from "./killSnapshot";
import { updatePopups, popupDriftBonus, popupDriftCombo } from "./popups";
import { updateAimHint } from "./aimHint";
import { updateBassLightnings } from "./bassLightning";
import { updateDriftBursts } from "./driftBurst";
import { updateInkClouds } from "./inkCloud";
import { resetStreak, streakWindowClosed } from "./streakBurst";
import { updateWormholes, spawnWormhole } from "./wormhole";
import { tickWaveSkip, collapseSkipPortals } from "./waveSkip";
import { tickPendingRhythmBonuses, flushPendingRhythmBonuses } from "./rhythmBonus";
import { emitExplosion, emitCometExplosion } from "./particleBursts";
import { musicDtForFrame } from "./slowMo";
import { hideScoreEntry, isScoreEntryBlockingEnter, showScoreEntry, tickLeaderboardKeyRepeat } from "./scoreEntry";
import { showGameOverIntro } from "./gameOverIntro";
import { isDown, wasPressed, TUTORIAL_CONTROL_ACTIONS } from "./controlBindings";
import { tickLaserShot, FIRE_FLASH_DECAY } from "./laserShot";
import { BONUS_LIFE_FLASH_DECAY } from "./bonusLife";
import { tickTorusCharge, tickSuperLaserFire } from "./torusCharge";
import { tickEntrances, shiftEntranceFrames, audiblePos } from "./entrance";
import { fireBossSweepBeam, tickBossBeams } from "./bossBeam";
import { targetsForReticule } from "./gameRender";
import { driftTierForRing } from "../ship/reticule/reticuleRender";

// single dispatcher means main.ts has one update entry; per-state branches live below.
export const updateGame = (game: Game, dt: number) => {
  // The MP4 exporter (game/videoExport.ts) owns stepping while it runs; the
  //   rAF tick must not consume replay frames underneath it.
  if (game.replayExporting) return;
  // Replay drives the sim from recorded frames rather than live dt. The
  //   scrubber sets a wall-clock multiplier (paused → 0, 1x → real time,
  //   2x/4x/0.5x → scaled); runReplay spends liveDt × speed of time budget
  //   on recorded frames at their own recorded dt. Seeks (rewind/fast-forward
  //   to a target frame) are handled separately by stepping the sim with audio
  //   muted. See runReplay for the speed/seek dispatch.
  if (game.replayPlayer) { runReplay(game, dt); return; }
  advanceFrame(game, dt);
};

// One simulation+input frame. dt is the recorded value during replay (so
//   scale-with-dt physics reproduces) or the live frame dt during normal play.
const advanceFrame = (game: Game, dt: number) => {
  // First-run warm-up: the run has started but the world is held — only the beat
  //   ticks while the player practices the rhythm. The same clock carries into
  //   live play when finishCalibrationIntro fires, so the pulse never restarts.
  if (game.calibrationIntro) { updateCalibration(game, dt); return; }
  // Pilot's-log / "Latency calibrated" intro screens hold the world the same way —
  //   the bgBeat ticks under a black overlay while <IntroSequence> drives its
  //   beat-locked fade-ins.
  if (game.introOverlayActive) { updateCalibration(game, dt); return; }
  // A full-screen menu (settings dialog / standalone recalibrator) is up mid-run —
  //   freeze the sim so the ship can't drift or die behind it. The modal owns the
  //   keys (it stops propagation), so input is already shielded; we just hold the
  //   world until both flags clear, then play resumes exactly where it left off.
  if ((game.settingsOpen || game.calibrating) && (game.state === "playing" || game.state === "dying")) {
    game.input.endFrame();
    return;
  }
  if (wasPressed(game.input, "pause")) togglePause(game);
  else if (game.state === "paused" && pressedStart(game)) togglePause(game);
  if (game.state === "paused") { game.input.endFrame(); return; }
  game.time += dt * 1000;
  // title/gameover/paused freeze beatTime; playing+dying defer pulsar to after tickBassBeats.
  if (game.state !== "playing" && game.state !== "dying" && game.state !== "replaying") game.pulsar.update(dt, game.perceivedBeatTime, BEAT_GRID);
  routeStateUpdate(game, dt);
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 3);
  game.input.endFrame();
};

// Pull the next recorded frame and advance the sim one step. Returns false
//   when the stream is exhausted (the caller decides whether that ends the
//   replay or just stops a seek at the last frame). Exported for the MP4
//   exporter's frame-by-frame sweep (game/videoExport.ts).
export const stepReplayFrame = (game: Game): boolean => {
  const replayDt = game.replayPlayer!.nextFrame();
  if (replayDt === null) return false;
  advanceFrame(game, replayDt);
  // Record the combo + wave this frame settled on, for the scrubber's rhythm
  //   histogram and per-wave dots.
  game.replayPlayer!.sampleRhythm(game.beatCombo, displayWave(game.wave));
  return true;
};

// Test seam: step exactly one recorded replay frame (inputs + sim + checkpoint
//   assert), bypassing runReplay's wall-clock pacing. Used only by the headless
//   re-sim harness (scripts/resim-replay.mjs) to trace per-frame entity state
//   around a divergence; not referenced by the app.
export const __stepReplayFrameForTest = (game: Game): boolean => stepReplayFrame(game);

// Replay dispatch for one render tick. Handles seeking to a target frame
//   (rewind = rebuild the world at frame 0, then fast-forward; both seek
//   directions step with audio muted), then normal speed-scaled playback.
//   liveDt is this render tick's real elapsed time, used to pace playback in
//   wall-clock terms so 1x matches the original run regardless of the viewer's
//   refresh rate.
const runReplay = (game: Game, liveDt: number) => {
  const clip = game.highlightClip;
  // Highlight clip: the game-over UI (Enter to continue / Escape to skip) is
  //   serviced here from the live keyboard, since updateGameOver doesn't run in
  //   the "replaying" state. Exiting tears down the clip, so bail immediately.
  if (clip && tickHighlightGameOverInput(game)) return;
  // Mid-loop fade: hold the frame while the fade-out/catch-up/fade-in cycle runs.
  if (clip && game.highlightLoop) { tickHighlightLoop(game, seekReplayToTarget); return; }
  if (game.replaySeekTarget !== null) {
    seekReplayToTarget(game);
    return;
  }
  // Paused: hold the frame, but keep emitting position so a drag that ends on
  //   the same frame still re-renders. Nothing to step.
  if (game.replaySpeed <= 0) {
    emitReplayProgress(game);
    return;
  }
  // Pace playback by wall-clock time: each render tick buys replaySpeed × liveDt
  //   seconds of replay budget, and we spend it consuming recorded frames at their
  //   own recorded dt. So 1x reproduces the original run's real-time pacing exactly
  //   (independent of the viewer's refresh rate), and 0.5/2/4 are exact multiples.
  //   replayStepAccumulator holds the leftover budget (seconds) between ticks.
  game.replayStepAccumulator += game.replaySpeed * liveDt;
  // Guard against a huge catch-up burst after a stall/background tab.
  game.replayStepAccumulator = Math.min(game.replayStepAccumulator, 0.25);
  while (game.replayStepAccumulator > 0) {
    const nextDt = game.replayPlayer!.peekFrameDt();
    if (nextDt === null) {
      if (clip) { beginHighlightLoop(game); return; }
      finishReplay(game);
      return;
    }
    // Highlight clip: at the clip's end frame, begin the fade-masked loop back to
    //   its start instead of running to the end of the recording.
    if (clip && game.replayPlayer!.position() >= clip.end) { beginHighlightLoop(game); return; }
    game.replayStepAccumulator -= nextDt;
    stepReplayFrame(game);
  }
  emitReplayProgress(game);
};

// Jump the sim to game.replaySeekTarget. Backward seeks rebuild the world at
//   frame 0 (no state snapshots exist — replay is a pure input re-sim), then
//   both directions fast-step to the target with sound muted so the catch-up
//   doesn't fire a burst of replayed audio.
const seekReplayToTarget = (game: Game) => {
  const target = Math.max(0, Math.min(game.replaySeekTarget!, game.replayPlayer!.total()));
  game.replaySeekTarget = null;
  const muted = game.sound.beginSeekMute();
  game.replayFastForwarding = true;
  if (target < game.replayPlayer!.position()) restartReplayWorld(game);
  while (game.replayPlayer!.position() < target) {
    if (!stepReplayFrame(game)) break;
  }
  game.replayFastForwarding = false;
  game.sound.endSeekMute(muted);
  emitReplayProgress(game);
};

// Fill rhythmByFrame for the whole recording up front so the scrubber can draw
//   a complete rhythm histogram before the viewer scrubs. Steps every frame with
//   audio muted, then rebuilds the world at frame 0 so playback starts clean.
//   One-time cost at replay open (re-sims the run once); subsequent seeks reuse
//   the cached samples.
export const precomputeRhythmHistogram = (game: Game) => {
  const player = game.replayPlayer;
  if (!player) return;
  const muted = game.sound.beginSeekMute();
  game.replayFastForwarding = true;
  // Quiet the per-frame divergence spam during the sweep — the end-of-sweep audit
  //   is the clean summary. Divergences still accumulate into player.divergences.
  player.logDivergences = false;
  while (stepReplayFrame(game)) { /* sampleRhythm + assertCheckpoint run inside */ }
  // This full-run sweep is the primary desync audit: every checkpoint was just
  //   asserted. Report it now, BEFORE restartReplayWorld → rewindToStart clears
  //   player.divergences for the upcoming live playback.
  reportReplayAudit(player);
  player.logDivergences = true;
  restartReplayWorld(game);
  game.replayFastForwarding = false;
  game.sound.endSeekMute(muted);
};

// One-shot console audit of a replay's determinism, logged at replay open after
//   the precompute sweep has asserted every checkpoint. Surfaces the failure
//   modes that otherwise look like a silent "replay didn't work": no checkpoints
//   in the payload (recorded pre-v6 → nothing to assert), a build-hash mismatch
//   (re-sim ran different code than the recording), and the first + total
//   checkpoint divergences with where they began.
const reportReplayAudit = (player: ReplayPlayer) => {
  const h = player.payload.header;
  const frames = player.total();
  // eslint-disable-next-line no-console
  console.log(
    `[replay] audit — v${h.v}, build ${h.build}, ${frames} frames, ` +
    `${player.checkpointCount()} checkpoints, ${player.beatResnapCount()} beat-resnaps`,
  );
  if (!player.hasCheckpoints()) {
    // eslint-disable-next-line no-console
    console.warn(
      "[replay] NO checkpoints in this recording — it predates the v6 format, so " +
      "the auto desync-check has nothing to assert against. Re-record to diagnose.",
    );
    return;
  }
  const currentBuild = (import.meta.env as unknown as { VITE_BUILD_HASH?: string })?.VITE_BUILD_HASH ?? "dev";
  if (h.build !== currentBuild) {
    // eslint-disable-next-line no-console
    console.warn(
      `[replay] BUILD MISMATCH — recorded under build ${h.build}, replaying under ` +
      `${currentBuild}. Any sim-logic change between them desyncs the re-sim by design.`,
    );
  }
  const divs = player.divergences;
  if (divs.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[replay] audit PASSED — no checkpoint divergence across the whole run.");
    return;
  }
  const first = divs[0];
  // eslint-disable-next-line no-console
  console.warn(
    `[replay] audit FAILED — ${divs.length} divergent checkpoint(s). First at frame ` +
    `${first.frame} (${first.timeSec.toFixed(2)}s in), fields: ` +
    first.fields.map((f) => `${f.field}(rec ${f.recorded} → rep ${f.replayed})`).join(", "),
  );
  // The full recorded vs replayed checkpoint at the first divergence — the most
  //   useful single object for diagnosis. rngState mismatch ⇒ unseeded/draw-count
  //   leak; rngState match with score/combo drift ⇒ rhythm-judgment drift.
  const pair = player.firstDivergencePair;
  if (pair) {
    // eslint-disable-next-line no-console
    console.warn("[replay] first divergence detail (also at window.__firstDivergence):", pair);
    (window as unknown as { __firstDivergence?: unknown }).__firstDivergence = { ...pair };
  }
  // Stash a COPY: restartReplayWorld → rewindToStart empties player.divergences
  //   in place right after this, so the live reference would read back as [].
  const snapshot = divs.map((d) => ({ ...d, fields: d.fields.map((f) => ({ ...f })) }));
  // eslint-disable-next-line no-console
  console.warn("[replay] full divergence history (also at window.__replayDivergences):", snapshot);
  (window as unknown as { __replayDivergences?: unknown }).__replayDivergences = snapshot;
};

const emitReplayProgress = (game: Game) => {
  if (!game.replayPlayer) return;
  window.dispatchEvent(new CustomEvent("replay:progress", {
    detail: {
      position: game.replayPlayer.position(),
      total: game.replayPlayer.total(),
      speed: game.replaySpeed,
    },
  }));
};

// Reaching the end of the stream parks the playhead on the final frame with the
//   scrubber still up — the replay holds on the recorded death rather than
//   dropping the viewer onto the real game-over/leaderboard screen. Scrubbing
//   back resumes from wherever they seek to.
const finishReplay = (game: Game) => {
  game.replaySpeed = 0;
  game.replayStepAccumulator = 0;
  emitReplayProgress(game);
};

const routeStateUpdate = (game: Game, dt: number) => {
  if (game.state === "title") updateTitle(game, dt);
  else if (game.state === "gameover") updateGameOver(game, dt);
  else if (game.state === "dying") updateDying(game, dt);
  else if (game.state === "replaying") updateReplaying(game, dt);
  else updatePlaying(game, dt);  // "playing"
};

// Replay mirror of updateDying's frame structure: the dying countdown is
//   decremented BEFORE the frame body and respawn happens AFTER it, so the
//   freshly-spawned ship's first ship.update lands on the *next* frame — exactly
//   as live play does (updateDying). Doing the respawn at the top of
//   updatePlaying instead would move the new ship one frame early and desync the
//   re-sim from the recording after every death.
const updateReplaying = (game: Game, dt: number) => {
  const dyingExpired = tickReplayDying(game, dt);
  updatePlaying(game, dt);
  if (dyingExpired && game.lives > 0) respawn(game);
};

// First-run warm-up tick: advance the beat clock and play the bgBeat (the very
//   same path live play uses) plus the pulsar's visual flash — nothing else. The
//   player taps along behind the calibration overlay; finishCalibrationIntro
//   hands straight over to updatePlaying without resetting beatTime.
const updateCalibration = (game: Game, dt: number) => {
  game.beatTime += dt;
  tickAuxBeats(game);
  game.pulsar.update(dt, game.perceivedBeatTime, BEAT_GRID);
  game.input.endFrame();
};

// Enter/Return/Space all trigger start — covers different keyboards and the arcade reflex.
const pressedStart = (game: Game): boolean =>
  game.input.pressed("enter") || game.input.pressed("return") || game.input.pressed(" ") || game.input.pressed("spacebar");

// title needs cosmetic motion + enter-to-start; nothing else fires here.
const updateTitle = (game: Game, dt: number) => {
  if (pressedStart(game)) requestStart(game);
  tickLeaderboardKeyRepeat(game, dt);
  for (const a of game.asteroids) a.update(dt, game.w, game.h);
  game.particles.update(dt);
};

// gameover drains the bassteroid field one downbeat at a time — music outlives the player.
// bgBeat sub-bass + comet notes keep ticking so the parade has a steady pulse to align to,
//   and the pulsar's beat-driven flash piggybacks on the same beatTime via Pulsar.update().
const updateGameOver = (game: Game, dt: number) => {
  // Escape dismisses score entry so the player can skip submission and press Enter to restart.
  //   Handled here in addition to the input-level listener for the case where the player clicked
  //   outside the input before pressing Escape.
  if (wasPressed(game.input, "pause")) hideScoreEntry(game);
  const enterPressed = pressedStart(game);
  if (enterPressed && !isScoreEntryBlockingEnter(game)) {
    stopParade(game);
    game.killedRowEl.classList.add("hidden");
    game.killedSnapshots = [];
    showTitle(game);
  }
  // Up/down navigate the leaderboard once the callsign input isn't focused —
  //   otherwise arrow keys would scroll the list while the player is typing.
  if (document.activeElement !== game.scoreEntryInputEl) {
    tickLeaderboardKeyRepeat(game, dt);
  }
  for (const a of game.asteroids) a.update(dt, game.w, game.h);
  game.beatTime += dt;
  tickAuxBeats(game);
  detonateScheduledBassRocks(game);
  for (const s of game.shards) s.update(dt);
  game.shards = game.shards.filter((s) => s.life > 0);
  game.particles.update(dt);
};

// turns the gameover into a slow rhythmic field-clear instead of a static "you died" screen.
const detonateScheduledBassRocks = (game: Game) => {
  let anyExploded = false;
  for (const a of game.asteroids) {
    if (!a.isBass()) continue;
    if (game.beatTime < a.nextBeatAt) continue;
    const sound = BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"];
    const pitchRatio = BASS_SPLIT_PITCH_RATIO[a.splitLevel] ?? 1;
    game.sound.play(sound, pitchRatio, a.pos);
    game.sound.stopBassteroidDrone(a);
    a.hp = 0;
    emitExplosion(game.particles, game.shards, a, false);
    anyExploded = true;
  }
  if (anyExploded) game.asteroids = game.asteroids.filter((a: Asteroid) => !(a.isBass() && a.hp <= 0));
};

// world keeps running while the ship is gone — music, beats, aliens, comets all play on.
// The ship's alive=false flag already gates firing, rendering, and collisions.
const updateDying = (game: Game, dt: number) => {
  game.dyingTimer -= dt;
  updatePlaying(game, dt);
  if (game.dyingTimer > 0) return;
  if (game.lives <= 0) transitionToGameOver(game);
  else respawn(game);
};

const transitionToGameOver = (game: Game) => {
  // Safety net: if a highlight clip is somehow live when we reach game-over (e.g.
  //   the re-sim diverged and the ship died inside the clip window before clip.end),
  //   tear the clip down and fall through to a plain parade game-over rather than
  //   re-entering the clip machinery. recorder is already null on the clip path, so
  //   tryStartHighlightClip below no-ops anyway, but this restores input/dims/state.
  if (game.highlightClip) {
    game.highlightClip = null;
    game.highlightLoop = null;
    document.getElementById("highlight-fade")?.classList.remove("fading");
    game.replayPlayer = null;
    game.replayLockedDims = null;
    game.input = game.localInput;
    game.resize();
  }
  game.state = "gameover";
  // Snapshot the run summary BEFORE finalizeRecorder/highlight clip touch the
  //   world — the highlight clip rebuilds the sim (resetting score/maxCombo/
  //   lastRunReplay), so score submission reads this snapshot. Keep an existing
  //   snapshot if present: a divergence re-entry (above) must not overwrite the
  //   real run's summary with the partial re-sim's values.
  game.runSummary ??= {
    score: game.score,
    wave: game.wave,
    maxCombo: game.maxCombo,
    killTally: { ...game.killTally },
  };
  game.sound.stopAllAlienDrones();
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllWarbleDrones();
  game.sound.stopAllCometShimmers();
  game.sound.stopHaloAmbient();
  game.comets = [];
  game.lastRunScore = game.runSummary.score;
  game.lastRunScoreId = null;
  // Capture the death snapshot from the LIVE ship now, before the highlight clip
  //   can rebuild the world. Needed for the parade fallback.
  const shipSnap = snapshotShipKill(game.ship, "death");
  if (shipSnap) game.killedSnapshots.push(shipSnap);
  // Grab the recorder before anything nulls it: the highlight clip builds its
  //   payload from it, and finalizeRecorder serialises the upload bytes from it.
  //   Both must run off the same captured reference since the clip's startGame
  //   clears game.recorder. Finalise first so game.lastRunReplay is populated
  //   even though the clip then rebuilds the world.
  const recorder = game.recorder;
  finalizeRecorder(game);
  // Start the clip FIRST: its startGame rebuild hides the overlay + score form,
  //   so the game-over chrome must be (re)shown AFTER it, or the clip would wipe
  //   it back out. The clip reads game.runSummary for its values, not live state.
  const highlightStarted = tryStartHighlightClip(game, recorder);
  // Game-over chrome — shown last so the clip's world-rebuild can't hide it. The
  //   #overlay (gameover text + score form) layers above the replay canvas.
  game.overlayTitleEl.textContent = "";
  game.overlayStartEl.classList.add("hidden");
  game.overlayEl.classList.remove("hidden");
  game.overlayEl.classList.add("gameover-layout");
  hideWaveSummary(game);
  showGameOverIntro(game, "gameover");
  showScoreEntry(game);
  if (highlightStarted) {
    // Clip owns the canvas now; suppress the trophy parade. startHighlightReplay
    //   already emitted the "replaying" game state. The highlight-clip class drops
    //   the overlay's full-screen scrim so the replay shows through behind the
    //   gameover text + score panel.
    game.overlayEl.classList.add("highlight-clip");
    stopParade(game);
    game.killedRowEl.classList.add("hidden");
  } else {
    game.overlayEl.classList.remove("highlight-clip");
    renderKilledRow(game, "vertical");
    emitGameState(game);
  }
};

import { HALO_MUSIC_POOL, PLAY_COMBO_MUSIC, bossMusicVariation, pickHaloMusicVariation, pickHaloMusicVariationExcluding } from "./haloMusicConfig";
import { isFullHaloWave, pickFullHaloSong, pickFullHaloSongExcluding } from "./haloFullMusicConfig";
import { BASS_MEASURE_LENGTH } from "../Asteroid";

// Only true comets carry the phrygian shimmer the comet-mode pad voices around;
// meteors are silent flock members, so they must not flip the halo pad.
const hasMusicalComet = (game: Game): boolean => game.comets.some((c) => !c.isMeteor);

// yellow-halo (combo ≥ 4) opens the ambient pad; combo ≥ 6 adds the
//   melodic layer; combo ≥ 12 adds layer 3 (a single new musical element per
//   variation — lonely violin / felt glockenspiel / synth-bass arp / chime
//   counter-melody); combo ≥ 24 crossfades to a fresh random variation as
//   the climax tier; white-bullet tier (≥ 8) thickens the legacy synth pad
//   with an octave-up sparkle layer. Comet presence slides the colour-third
//   from E→Eb so the pad stays consonant with the comet's phrygian shimmer
//   instead of fighting it.
//
//   Music variation: each time combo crosses 4 from below, we pick a fresh
//   random variation from HALO_MUSIC_POOL — so successive combo runs in the
//   same wave don't always sound the same. The chosen variation persists on
//   game.sound.haloMusic.variation, so the 6x melodic-layer and 12x layer-3
//   toggles use the same variation's stems (no half-EL/half-self-built
//   mash-ups). At 24x we pick a *second* variation (excluding the current)
//   and crossfade — that swap sticks until the next combo break, so
//   dropping back below 24x but staying ≥ 4 doesn't bounce back.
const syncHaloAmbient = (game: Game) => {
  const hasYellowHalo = game.beatCombo >= 4;
  const hasMelodic = game.beatCombo >= 6;
  const hasWhiteBullets = game.beatCombo >= 12;
  const hasLayer3 = game.beatCombo >= 12;
  // 24x climax: crossfade to a fresh random variation. Sticks for the rest
  // of the halo's life (no fallback if combo drops below 24x but stays ≥ 4).
  const hasClimax = game.beatCombo >= 24;

  if (!PLAY_COMBO_MUSIC) {
    if (game.sound.haloMusic) game.sound.stopHaloMusic();
    if (game.sound.haloAmbient) game.sound.stopHaloAmbient();
    game.sound.setHaloAmbientCometMode(hasMusicalComet(game));
    return;
  }

  if (isFullHaloWave(game.wave)) {
    // Full-length song path (levels 1–9, the "different system"). One whole
    // ~2:10 track with six combo-tier layers (4x/6x/12x/18x/24x/32x). When the
    // track ends mid-halo it rolls over to the next song. Bypasses the loop
    // pool entirely on these waves; boss/haunting waves still use it below.
    if (hasYellowHalo) {
      if (!game.sound.haloFullMusic) {
        const song = pickFullHaloSong();
        const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
        const measureAlignDelay = nextDownbeat - game.beatTime;
        game.beatPhaseCorrection = 0;
        void game.sound.startHaloFullMusic(song, game.beatCombo, measureAlignDelay, game.beatTime,
          () => switchFullHaloSong(game));
      } else {
        game.sound.setHaloFullMusicTier(game.beatCombo);
      }
    } else if (game.sound.haloFullMusic) {
      game.sound.stopHaloFullMusic();
    }
  } else if (HALO_MUSIC_POOL.length > 0) {
    // Full-song node never coexists with the loop node — if we left a full
    // wave still holding a full song, tear it down before the loop path runs.
    if (game.sound.haloFullMusic) game.sound.stopHaloFullMusic();
    // Pre-rendered music path. Three layers: ambient (4x) + melodic (6x) + layer3 (12x).
    // On boss waves, force the dedicated climactic variation. The boss
    // theme replaces the random halo pick AND blocks the 24x climax swap so
    // the boss-fight track plays for the entire engagement.
    const bossTheme = bossMusicVariation(game.wave);
    const bossWave = bossTheme !== null;
    if (hasYellowHalo) {
      if (!game.sound.haloMusic) {
        const variation = bossTheme ?? pickHaloMusicVariation(game.wave);
        // Schedule the music's downbeat on the next bass-measure boundary
        // so the loop's chord changes align with the bass field's measure
        // clock. Worst-case wait is BASS_MEASURE_LENGTH (2 s); typical is
        // ~1 s. The 4x-combo halo "ignites" on the next downbeat rather
        // than mid-bar.
        const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
        const measureAlignDelay = nextDownbeat - game.beatTime;
        game.beatPhaseCorrection = 0;
        void game.sound.startHaloMusic(variation, hasMelodic, measureAlignDelay, game.beatTime, hasLayer3);
      } else {
        game.sound.setHaloMusicMelodicLayer(hasMelodic);
        game.sound.setHaloMusicLayer3(hasLayer3);
        // Entered the boss wave holding a halo from the prior wave: the random
        // track is still playing and the !haloMusic branch above never ran, so
        // force a swap to the boss theme. climaxActive doubles as the swap-in-
        // flight guard so a frame's worth of re-entry can't stack crossfades.
        if (bossTheme && game.sound.haloMusic.variation !== bossTheme && !game.sound.haloMusic.climaxActive) {
          const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
          const measureAlignDelay = nextDownbeat - game.beatTime;
          game.beatPhaseCorrection = 0;
          void game.sound.crossfadeHaloMusic(bossTheme, measureAlignDelay, game.beatTime);
        }
        if (hasClimax && !game.sound.haloMusic.climaxActive && !bossWave) {
          const next = pickHaloMusicVariationExcluding(game.sound.haloMusic.variation, game.wave);
          const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
          const measureAlignDelay = nextDownbeat - game.beatTime;
          game.beatPhaseCorrection = 0;
          void game.sound.crossfadeHaloMusic(next, measureAlignDelay, game.beatTime);
        }
      }
    } else if (game.sound.haloMusic) {
      game.sound.stopHaloMusic();
    }
  } else {
    // Legacy synthesized pad. 4x opens, 12x adds octave-up sparkle.
    if (hasYellowHalo) {
      if (!game.sound.haloAmbient) game.sound.startHaloAmbient(hasWhiteBullets ? 2 : 1);
      else game.sound.setHaloAmbientTier(hasWhiteBullets ? 2 : 1);
    } else if (game.sound.haloAmbient) {
      game.sound.stopHaloAmbient();
    }
  }
  game.sound.setHaloAmbientCometMode(game.comets.length > 0);
};

// Fired when a full-length song reaches its natural end while a halo is still
// held. Rolls over to a different song from the current one, restarting at the
// player's live combo tier so the build-up doesn't reset to silence. If the
// halo broke between the track ending and this firing, leaves music stopped
// (the next 4x will pick a fresh song). Runs from the audio thread's onended,
// so it reads live game state rather than a captured snapshot.
const switchFullHaloSong = (game: Game) => {
  if (!game.sound.haloFullMusic) return;
  if (game.beatCombo < 4) { game.sound.stopHaloFullMusic(); return; }
  const next = pickFullHaloSongExcluding(game.sound.haloFullMusic.song);
  const nextDownbeat = Math.ceil(game.beatTime / BASS_MEASURE_LENGTH) * BASS_MEASURE_LENGTH;
  const measureAlignDelay = nextDownbeat - game.beatTime;
  game.beatPhaseCorrection = 0;
  void game.sound.startHaloFullMusic(next, game.beatCombo, measureAlignDelay, game.beatTime,
    () => switchFullHaloSong(game));
};

// seconds the reticule must rest on a first-beat dot to clear the hover gate. Mirrors the basic
//   drift-shot lock time (HOVER_RING_FILL_SEC) so the tutorial progress bar fills in lockstep
//   with the visible ring; kept as a separate literal rather than imported from the renderer.
const TUTORIAL_HOVER_SEC = 0.5;

// Guided-tutorial spawn machine. Holds exactly one small practice rock (respawns
//   when killed) and watches the two gates: hover a first-beat dot for 1s, then
//   land one on-beat hit (set in killEffects). Clearing both graduates to the
//   big-asteroid phase: one large rock at a time, respawning on clear, until
//   the hint progression finishes (stage 0). The hover gate reads the ship's
//   hover-ring timer.
const tickTutorialSpawn = (game: Game) => {
  if (!game.tutorialActive) return;
  if (game.tutorialFireHitDone) {
    // big phase. Once the hint progression finishes (stage 0), the next time
    //   the field empties we kick off the real Wave 1 — fresh spawn + the
    //   standard "Wave 1" title flash, as if the tutorial were a warm-up.
    if (game.asteroids.length === 0) {
      if (game.firstWaveHintStage === 0) {
        game.tutorialActive = false;
        spawnWave(game);
        showWaveAnnounce(game);
      } else {
        spawnTutorialBig(game);
      }
    }
    return;
  }
  if (game.firstWaveHintStage === 1) {
    tickControlsGate(game);
  } else if (game.firstWaveHintStage === 3) {
    // drift/hold gate: reticule rested on a first-beat dot for a full second.
    const hoverStart = game.ship.hoverDotRingState.hoverStartBeatTime;
    const elapsed = hoverStart === null ? 0 : game.perceivedBeatTime - hoverStart;
    emitTutorialHoverProgress(Math.max(0, Math.min(1, elapsed / TUTORIAL_HOVER_SEC)));
    if (elapsed >= TUTORIAL_HOVER_SEC) setFirstWaveHintStage(game, 4);
  }
  if (game.asteroids.length === 0) spawnTutorialSmall(game);
};

// controls gate: tracks per-key usage of the TUTORIAL_CONTROLS keys so each glyph
//   fades the moment its own key is pressed. Tutorial mode (stage 1) advances to
//   stage 2 once every key is used; normal mode just dismisses the start-of-run hint.
const tickControlsGate = (game: Game) => {
  const used = game.tutorialControlsUsed;
  let changed = false;
  for (const action of TUTORIAL_CONTROL_ACTIONS) {
    if (!used[action] && isDown(game.input, action)) {
      used[action] = true;
      changed = true;
    }
  }
  if (changed) emitTutorialControls(used);
  if (TUTORIAL_CONTROL_ACTIONS.every((action) => used[action])) {
    if (game.tutorialActive && game.firstWaveHintStage === 1) {
      setFirstWaveHintStage(game, 2);
    } else {
      dismissControlsHint(game);
    }
  }
};

// Fades the normal-mode start-of-run controls hint and releases whatever was
//   waiting behind it: the deferred first-combo-loss hint fires here, and
//   IntroSequence lifts its FIRE_HIT_HINT suppression on the dismiss event.
const dismissControlsHint = (game: Game) => {
  if (!game.controlsHintActive) return;
  game.controlsHintActive = false;
  window.dispatchEvent(new CustomEvent("controls-hint:dismiss"));
  if (game.rhythmLossHintPending) {
    game.rhythmLossHintPending = false;
    window.dispatchEvent(new CustomEvent("rhythm-loss-hint:show"));
  }
};

// ease bgBeat from practice level to wave level across calibration→play
const tickBeatIntensityRamp = (game: Game, dt: number) => {
  const r = game.beatIntensityRamp;
  if (!r) return;
  r.t += dt;
  const f = Math.min(1, r.t / r.dur);
  game.sound.bgBeatIntensity = r.from + (r.to - r.from) * f;
  if (f >= 1) game.beatIntensityRamp = null;
};

// tracked across frames so we only push a new playbackRate when it changes
// meaningfully — avoids hammering AudioParam every frame at the same rate.
let lastCommandedPlaybackRate = 1;

const BEAT_RESNAP_INTERVAL = BASS_MEASURE_LENGTH;
const BEAT_RESNAP_THRESHOLD = 0.030;
// above this we assume a real stall (tab suspend, GC pause, debugger) rather
// than gradual drift — bleeding it off as a tempo nudge would take many
// seconds of audibly-wrong cadence, so we accept a one-shot skip instead.
const BEAT_RESNAP_HARD_SNAP = 0.5;
// fraction of dt that any single frame's correction is allowed to consume,
// so corrections sound like a subtle breath rather than a tempo shift.
const PHASE_CORRECTION_RATE = 0.25;
// Cadence (in frames) for tracker-style sim-state checkpoints. ~once a second at
//   60fps — sparse enough that the always-on cost is negligible, dense enough to
//   localise a desync to a one-second window. See captureOrAssertCheckpoint.
const CHECKPOINT_INTERVAL = 60;

// Watchdog: once a measure, compare beatTime to the music's actual playback
// position. Small errors get bled off over many frames via beatPhaseCorrection;
// huge errors (post-stall) hard-snap and re-sync the bgBeat index.
const tickBeatResnap = (game: Game) => {
  // Replay is a pure dt+input re-sim: beatTime must stay a deterministic sum of
  // the recorded musicDt. Resnap reads the live AudioContext position, which
  // during replay sits at an unrelated wall-clock spot (audio is muted/seeked),
  // so letting it run would shove beatTime onto a garbage value and desync
  // every beatTime-keyed system (combo gate, bass clock, wave spawns).
  if (game.replayPlayer) return;
  if (game.slowMoTimer > 0) return;
  if (game.beatTime - game.lastBeatResnapAt < BEAT_RESNAP_INTERVAL) return;
  game.lastBeatResnapAt = game.beatTime;
  const expected = game.sound.audioBeatTimeFromMusic();
  if (expected === null) return;
  const error = expected - game.beatTime;
  if (Math.abs(error) < BEAT_RESNAP_THRESHOLD) return;
  if (Math.abs(error) >= BEAT_RESNAP_HARD_SNAP) {
    const EIGHTH_GRID = BEAT_GRID / 2;
    game.beatTime = expected;
    game.lastBgBeatIndex = Math.floor(expected / EIGHTH_GRID);
    game.lastBeatResnapAt = expected;
    game.beatPhaseCorrection = 0;
    if (DEBUG_BEAT_TIMING) {
      console.log(`[beat-resnap] error=${(error * 1000).toFixed(1)}ms  hard-snapped`);
    }
    return;
  }
  game.beatPhaseCorrection = error;
  if (DEBUG_BEAT_TIMING) {
    console.log(`[beat-resnap] error=${(error * 1000).toFixed(1)}ms  bleeding`);
  }
};

// Bleeds beatPhaseCorrection into musicDt so tickBassBeats advances beatTime
// by a fraction of the pending error each frame — corrections never skip or
// duplicate an eighth-note slot, just gently warp tempo until phase aligns.
const applyBeatPhaseCorrection = (game: Game, musicDt: number): number => {
  if (game.beatPhaseCorrection === 0) return musicDt;
  const cap = musicDt * PHASE_CORRECTION_RATE;
  const delta = Math.max(-cap, Math.min(cap, game.beatPhaseCorrection));
  game.beatPhaseCorrection -= delta;
  return musicDt + delta;
};

// Replay mirror of updateDying's countdown: live play counts down dyingTimer in
//   the "dying" state, but a replay holds "replaying" so the scrubber keeps
//   control. Decrement on the recorded dt and report the frame the timer elapses
//   on; updateReplaying does the respawn *after* the frame body so timing matches
//   live exactly. Returns true only on the expiry frame.
const tickReplayDying = (game: Game, dt: number): boolean => {
  if (game.replayDyingTimer === null) return false;
  game.replayDyingTimer -= dt;
  if (game.replayDyingTimer > 0) return false;
  game.replayDyingTimer = null;
  return true;
};

// ordered phases (ship → bass → world → collisions) so cause-and-effect reads top-down.
const updatePlaying = (game: Game, dt: number) => {
  game.recorder?.captureFrame(dt, game.input, {
    beatTime: game.beatTime,
    lastBgBeatIndex: game.lastBgBeatIndex,
    nextBeatToEvaluate: game.nextBeatToEvaluate,
    lastBeatResnapAt: game.lastBeatResnapAt,
  });
  tickBeatIntensityRamp(game, dt);
  tickTutorialSpawn(game);
  if (game.controlsHintActive) tickControlsGate(game);
  const bulletsBeforeShipUpdate = game.bullets.length;
  game.ship.setCombo(game.beatCombo);
  syncHaloAmbient(game);
  // Bank a super-laser charge if the ship is flying through a torus ring's
  // energy thread — must run before ship.update so the charge is set before the
  // fire trigger reads it this frame.
  tickTorusCharge(game, dt);
  game.ship.update(dt, game.input, game.particles, game.bullets, game.w, game.h, game.time, game.sound);
  // A ship fold jumps the camera a full screen; keep entrance images pinned.
  if (game.ship.lastWrapDX !== 0 || game.ship.lastWrapDY !== 0) {
    shiftEntranceFrames(game, game.ship.lastWrapDX, game.ship.lastWrapDY);
  }
  // Debug instrumentation: capture ship state right after physics tick so the
  //   recorded snapshot reflects the exact state the replay should reproduce.
  //   Replay-side compares to the same snapshot and logs the first divergence.
  game.recorder?.captureShip(game.ship, game.input);
  game.replayPlayer?.checkShipAgainstRecording(game.ship);
  tickLaserShot(game, dt);
  tickSuperLaserFire(game);
  const rawMusicDt = tickSlowMoTimer(game, dt);
  // music slows with gameplay so beat+music stay locked through slow-mo.
  if (dt > 0) {
    const slowMoFactor = rawMusicDt / dt;
    if (Math.abs(slowMoFactor - lastCommandedPlaybackRate) > 0.001) {
      game.sound.setHaloMusicPlaybackRate(slowMoFactor, 0);
      game.sound.setHaloFullMusicPlaybackRate(slowMoFactor, 0);
      lastCommandedPlaybackRate = slowMoFactor;
    }
  }
  // Resnap perturbs beatTime away from a pure dt-sum, two ways: a hard-snap jumps
  //   beatTime directly here, and a bleed feeds beatPhaseCorrection into musicDt
  //   (below) over many frames. Both are driven by the live audio clock, which a
  //   replay lacks — so live play records the net adjustment per frame and replay
  //   re-applies the recorded value instead of running the watchdog. snapDelta is
  //   the hard-snap jump (0 on bleed/clean frames); the bleed delta is captured
  //   after applyBeatPhaseCorrection as (musicDt - rawMusicDt).
  const beatTimeBeforeSnap = game.beatTime;
  if (!game.replayPlayer) tickBeatResnap(game);
  const snapDelta = game.beatTime - beatTimeBeforeSnap;
  const musicDt = game.replayPlayer
    ? rawMusicDt + game.replayPlayer.beatResnapForCurrentFrame()
    : applyBeatPhaseCorrection(game, rawMusicDt);
  // Live: total resnap adjustment to beatTime this frame = the hard-snap jump plus
  //   the bleed delta folded into musicDt. Replay already injected its recorded
  //   value into musicDt above, so it records nothing.
  game.recorder?.recordBeatResnap(snapDelta + (musicDt - rawMusicDt));
  // playbackRate maps beatTime → audio-clock seconds for the lookahead pulse
  // scheduler; under slow-mo musicDt < dt so beats are scheduled further out.
  const beatPlaybackRate = dt > 0 ? rawMusicDt / dt : 1;
  tickBassBeats(game, musicDt, beatPlaybackRate);
  // after tickBassBeats so the payout compares this frame's advanced beatTime.
  tickWaveTransition(game);
  // Wave-skip warp: portal entry + the dive/hidden/emerge sequence. After
  //   tickWaveTransition so the landing spawn always fires before the emerge
  //   beats anchored past it are checked.
  tickWaveSkip(game, musicDt);
  // pulsar runs against perceivedBeatTime so its flash lands with the *heard* bass voices.
  game.pulsar.update(dt, game.perceivedBeatTime, BEAT_GRID);
  game.ship.tickComboHalo(musicDt, currentBeatPulse(game));
  if (game.bullets.length > bulletsBeforeShipUpdate) classifyNewBullets(game, bulletsBeforeShipUpdate);
  graceFrameNearAsteroids(game);
  tickWavePhase(game, dt, musicDt);
  tickWorldEntities(game, dt, musicDt);
  tickEntrances(game, musicDt);
  game.particles.update(musicDt);
  game.popups = updatePopups(game.popups, dt, game.w, game.h);
  updateAimHint(game, dt);
  game.bassLightnings = updateBassLightnings(game.bassLightnings, dt);
  game.driftBursts = updateDriftBursts(game.driftBursts, dt);
  updateInkClouds(game, dt);
  // musicDt (not dt) so the portal opens/closes in lockstep with the body's
  // dive, which also runs on musicDt — under slow-mo both stretch together.
  game.wormholes = updateWormholes(game.wormholes, musicDt);
  tickPendingDriftBonuses(game);
  tickPendingRhythmBonuses(game);
  tickStreakTimeout(game);
  runCollisionPasses(game);
  evaluateClosedBeats(game);
  recordHighlightFrame(game);
  syncPowerupHud(game);
  syncFuelHud(game);
  if (game.asteroids.length === 0 && !game.betaMode && !game.waveTransitioning && !game.tutorialActive) advanceWave(game);
  tickHoverLock(game);
  captureOrAssertCheckpoint(game);
};

// Drift-shot hover-lock, lifted out of render so it's deterministic for replay (it gates a +1
//   combo). Runs at END of the frame with the SAME post-advance perceivedBeatTime + post-update
//   ship pos the live render used, so the recorded run reproduces frame-for-frame. classifyNewBullets
//   (earlier in the frame) reads the PRIOR frame's lock state — exactly as it did when render owned
//   this. emit=false on replay so it doesn't re-fire the lock hum over the recorded audio stream.
const tickHoverLock = (game: Game) => {
  const doubletime = comboGrid(game) < BEAT_GRID;
  const superBoosted = game.beatCombo >= 12;
  game.ship.tickReticuleLock(
    BEAT_GRID, game.w, game.h, targetsForReticule(game), game.perceivedBeatTime, doubletime,
    superBoosted, game.gems, game.sound, !game.replayPlayer,
  );
};

// Tracker-style desync guard. On the recording path, snapshot settled sim state
//   every CHECKPOINT_INTERVAL frames; on the replay path, assert the live state
//   against the recorded snapshot so a divergence reports its exact frame +
//   field. The frame index is read from whichever side owns this frame (recorder
//   captured it at the top of updatePlaying; replay consumed it via nextFrame),
//   so both gate on the same indices and the checkpoints line up.
const checkpointState = (game: Game) => ({
  score: game.score,
  wave: game.wave,
  lives: game.lives,
  beatCombo: game.beatCombo,
  beatTime: game.beatTime,
  asteroids: game.asteroids.length,
  bullets: game.bullets.length,
  aliens: game.aliens.length,
  rngState: getRngSeed(),
});

const captureOrAssertCheckpoint = (game: Game) => {
  if (game.replayPlayer) {
    game.replayPlayer.assertCheckpoint(checkpointState(game));
    return;
  }
  if (!game.recorder) return;
  if ((game.recorder.frameCount() - 1) % CHECKPOINT_INTERVAL !== 0) return;
  game.recorder.captureCheckpoint(checkpointState(game));
};

// Drift Shot queue: on-beat hits made under a fully-locked hover ring schedule a +1-rhythm
//   reward for 1 beat later. If the streak broke before the moment arrives, drop the entry —
//   the bonus is tied to a live streak. The hit itself already showed the first combo number
//   (C+1, popupDriftCombo); this fires the second (C+2), staged a beat later and offset to the
//   lower-right so the player reads the streak climbing one step at a time.
const awardDriftBonus = (game: Game, entry: Game["pendingDriftBonuses"][number]) => {
  if (game.beatCombo === 0) return;
  game.beatCombo += entry.amount;
  if (game.beatCombo > game.maxCombo) game.maxCombo = game.beatCombo;
  if (game.beatCombo > game.maxComboThisWave) game.maxComboThisWave = game.beatCombo;
  game.driftBonusesThisWave += 1;
  syncComboHud(game);
  game.sound.playComboChime(game.beatCombo, entry.pos);
  // second staged combo number, offset down-right of the first so both steps read in rhythm.
  game.popups.push(popupDriftCombo(entry.pos, game.beatCombo, true));
  // DRIFT SHOT label rides this beat too; show the tier-coloured "N× DAMAGE" subtitle only on
  //   a new game-best multiplier (and force the first-of-run label so the player learns it).
  const firstOfRun = !game.hasShownDriftShotLabel;
  game.popups.push(popupDriftBonus(entry.pos, entry.tier, entry.showDamageMult || firstOfRun));
  if (firstOfRun) game.hasShownDriftShotLabel = true;
};

const tickPendingDriftBonuses = (game: Game) => {
  if (game.pendingDriftBonuses.length === 0) return;
  const keep: typeof game.pendingDriftBonuses = [];
  for (const entry of game.pendingDriftBonuses) {
    if (game.perceivedBeatTime < entry.fireAt) { keep.push(entry); continue; }
    awardDriftBonus(game, entry);
  }
  game.pendingDriftBonuses = keep;
};

// Wave closed before a staged bonus's beat arrived: pay it out immediately so
//   the wave-ending drift shot still lands inside the summary snapshot.
const flushPendingDriftBonuses = (game: Game) => {
  for (const entry of game.pendingDriftBonuses) awardDriftBonus(game, entry);
  game.pendingDriftBonuses = [];
};

// slow-mo timer ticks in wall-clock so its lifespan isn't extended by its own effect.
const tickSlowMoTimer = (game: Game, dt: number): number => {
  if (game.slowMoTimer > 0) game.slowMoTimer = Math.max(0, game.slowMoTimer - dt);
  return musicDtForFrame(dt, game.slowMoTimer);
};

// ≤1 fire event per frame, but prong emits multiple bullets — they all share one beat flag.
const classifyNewBullets = (game: Game, firstNewIndex: number) => {
  // perceivedBeatTime = beatTime shifted by the player's calibrated latency, so a
  //   press timed to the heard beat scores even when output latency makes it land
  //   late on the raw audio grid.
  const firedOnBeat = isInBeatWindow(game, game.perceivedBeatTime);
  const count = game.bullets.length - firstNewIndex;
  // snapshot each ring's drift TIER (0 = unlocked; 1/2/3 = held tier). Uses game.beatTime — the
  //   same clock tickHoverLockState stamped hoverStartBeatTime on — so the tier is deterministic.
  const lockedSlots = game.ship.hoverDotRingStates.map(r => driftTierForRing(r, game.beatTime));
  for (let i = firstNewIndex; i < game.bullets.length; i++) {
    game.bullets[i].firedAtBeatTime = game.perceivedBeatTime;
    game.bullets[i].driftLockedSlots = lockedSlots;
  }
  logBeatEvent(game, "FIRE", game.perceivedBeatTime, `bullets=${count}`);
  spawnBeatDebugPopup(game, game.ship.pos, game.perceivedBeatTime, "FIRE");
  if (firedOnBeat) {
    boostNewBullets(game, firstNewIndex);
    registerOnBeatFire(game);
  } else {
    registerOffBeatFire(game);
  }
  // deeper fireBeat pluck reinforces "you nailed the beat"; ship no longer plays its own.
  // The bomb's shells get their own pair of voices, two octaves down but the same
  // pitch classes, so the heavier weapon sounds heavier without leaving the key.
  const bomb = game.ship.bombActive;
  game.sound.play(firedOnBeat ? (bomb ? "fireBombBeat" : "fireBeat") : bomb ? "fireBomb" : "fire");
};

// Bullet-only: tag the freshly-spawned projectiles with the live halo tier so
// they fly boosted/super-boosted. The laser owns its own per-tier visuals, so
// it shares registerOnBeatFire below but not this.
const boostNewBullets = (game: Game, firstNewIndex: number) => {
  // boosted bullets fly while the yellow halo (combo ≥ 4, tier 2) is up.
  const boosted = game.ship.comboHaloTier >= 2;
  // combo ≥ 12 promotes to the white "super-boosted" tier — sharper look and
  // 1.5× range; same hitbox as yellow so the reward is reach, not sweep.
  const superBoosted = game.beatCombo >= 12;
  for (let i = firstNewIndex; i < game.bullets.length; i++) {
    const newBullet = game.bullets[i];
    newBullet.onBeat = true;
    newBullet.boosted = boosted;
    newBullet.superBoosted = superBoosted;
    if (superBoosted) {
      newBullet.life *= 1.5;
      newBullet.maxLife *= 1.5;
      const slotCount = Math.max(1, Math.floor(newBullet.maxLife / BEAT_GRID));
      newBullet.fadeStartLife = Math.max(0, newBullet.maxLife - slotCount * BEAT_GRID);
    }
  }
};

// Shared by EVERY weapon's on-beat fire (bullets, laser, future). Rhythm is
// gained by HITS, not fires — so this only does the 0→1 priming step; above 1
// the combo climbs on on-beat hits + beat closures, never on consecutive fires.
// Keep weapon-specific projectile setup out of here (see boostNewBullets).
export const registerOnBeatFire = (game: Game) => {
  game.sound.play("comboTick");
  if (game.beatCombo === 0) {
    game.beatCombo = 1;
    if (game.maxCombo < 1) game.maxCombo = 1;
    syncHud(game);
  }
  if (game.firstWaveHintStage === 2) {
    // fire-on-the-beat stage: 3 on-beat fires → advance to drift/hover (stage 3).
    game.firstWaveOnBeatFireCount += 1;
    emitFirstWaveHintProgress(game.firstWaveOnBeatFireCount);
    if (game.firstWaveOnBeatFireCount >= 3) setFirstWaveHintStage(game, 3);
  } else if (game.firstWaveHintStage === 4 && !game.firstWaveHintSubVisible) {
    // fire-and-hit stage: first on-beat *fire* (hit or not) reveals the targeting
    //   sub-line; the three diamonds are independently gated on on-beat *hits*.
    setFirstWaveHintSubVisible(game, true);
  } else if (game.firstWaveHintStage === 5) {
    // build-to-4x stage. 0→1 priming step mirrors into the row. Diamonds start at
    //   2x (diamond N = rhythm N+1), so priming alone leaves the row at 0.
    emitFirstWaveHintRhythmProgress(Math.max(0, Math.min(game.beatCombo - 1, 3)));
  }
};

// Shared by EVERY weapon's off-beat fire. The break is now immediate: pressing
// off the beat drops the streak the instant the shot leaves the barrel (sound +
// "RHYTHM LOST" text + halo music cut on the next syncHaloAmbient). Clear the
// deferred latch so evaluateClosedBeats doesn't re-penalize at beat closure —
// it would otherwise drop a doubletime streak from its 4x floor to 0.
export const registerOffBeatFire = (game: Game) => {
  game.firedOffBeatSinceLastBeat = false;
  loseCombo(game, game.ship.pos, "fire");
};

// End an active rhythm streak once no shot can extend it anymore — the ring's
//   fade reaches zero at this same moment (streakWindowClosed drives both).
//   perceivedBeatTime is replay-deterministic (beatOffset is recorded), so
//   replays reproduce it. Runs before runCollisionPasses, which is safe: a hit
//   this frame qualifies iff the window is still open at this same clock value.
const tickStreakTimeout = (game: Game) => {
  if (game.streakGrid <= 0) return;
  if (streakWindowClosed(game)) resetStreak(game);
};

// cheap respawn-grace — extend invuln if a rock is still inside the safe radius near the end.
const graceFrameNearAsteroids = (game: Game) => {
  if (!(game.ship.invuln > 0 && game.ship.invuln < 0.4)) return;
  const safeRadius = 130;
  for (const a of game.asteroids) {
    if (dist(a.pos, game.ship.pos) < safeRadius) { game.ship.invuln = 0.4; return; }
  }
};

// shockwave's actual detonation lands one frame later when pulsar.shockJustFired flips.
const tickWavePhase = (game: Game, dt: number, _musicDt: number) => {
  game.waveElapsed += dt;
  tickWaveEvents(game.waveEvents, game.waveElapsed);
  if (game.pulsar.shockVibrateJustStarted) game.sound.play("shockwaveCharge");
  if (game.pulsar.shockJustFired) detonateShockwave(game);
};

// Two-pointer in-place compaction: keeps surviving entries in their original
// slots, truncates the array. Avoids the per-frame array allocation that
// .filter() does even when nothing died.
const compactInPlace = <T>(arr: T[], alive: (item: T) => boolean): void => {
  let write = 0;
  for (let read = 0; read < arr.length; read++) {
    const item = arr[read];
    if (alive(item)) {
      if (write !== read) arr[write] = item;
      write++;
    }
  }
  arr.length = write;
};

// reticules sit at integer multiples of the rhythm grid out from the muzzle, so a bullet
// "crosses" its Nth reticule when its age passes N * grid. Each unseen crossing samples the
// beat window — if on-beat, flash white. Crossings are tracked per-bullet so a flash only
// triggers once per slot, and we count up to whatever the bullet's age has reached.
const FLASH_DURATION_SEC = 0.12;
const tickBulletReticuleCrossings = (game: Game) => {
  const grid = comboGrid(game);
  if (grid <= 0) return;
  for (const b of game.bullets) {
    const age = b.maxLife - b.life;
    const expected = Math.floor(age / grid);
    if (expected > b.reticuleCrossings) {
      // grid can halve mid-flight (combo crossing 16); snap to the new count without
      // firing a burst of phantom flashes for the past.
      b.reticuleCrossings = expected;
      const crossingTime = b.firedAtBeatTime + expected * grid;
      if (isInBeatWindow(game, crossingTime)) b.flashTimer = FLASH_DURATION_SEC;
    }
  }
};

// slow-mo slows the whole world via musicDt — asteroids, comets, aliens, bullets, shards, canisters.
//   Ship stays on wall-clock dt (updated earlier) so player reactions feel responsive.
const tickWorldEntities = (game: Game, _dt: number, musicDt: number) => {
  for (const c of game.comets) c.update(musicDt, game.w, game.h);
  spawnPendingCometExplosions(game);
  pruneDeadComets(game);
  for (const a of game.asteroids) a.update(musicDt, game.w, game.h);
  // Torus fragments don't integrate their own position in update() — drive the
  // shared phantom rings here so every fragment is snapped onto its slot before
  // collision runs.
  tickTorusGroups(game.asteroids, musicDt, game.w, game.h);
  tickSepulchre(game, musicDt);
  // defensive prune; no asteroid kind currently clears alive on its own.
  compactInPlace(game.asteroids, (a) => a.alive);
  for (const al of game.aliens) al.update(musicDt, game.w, game.h);
  spawnPendingWormholes(game, game.aliens);
  pruneOffscreenAliens(game);
  tickAlienFire(game);
  tickBossRhythm(game);
  tickWraiths(game, musicDt);
  for (const b of game.bullets) b.update(musicDt, game.w, game.h);
  tickBulletReticuleCrossings(game);
  compactInPlace(game.bullets, (b) => b.life > 0);
  for (const l of game.lasers) l.update(musicDt, game);
  compactInPlace(game.lasers, (l) => l.alive);
  if (game.laserFireFlash > 0) {
    game.laserFireFlash = Math.max(0, game.laserFireFlash - musicDt / FIRE_FLASH_DECAY);
  }
  if (game.bonusLifeFlash > 0) {
    game.bonusLifeFlash = Math.max(0, game.bonusLifeFlash - musicDt / BONUS_LIFE_FLASH_DECAY);
  }
  for (const ab of game.alienBullets) ab.update(musicDt, game.w, game.h);
  compactInPlace(game.alienBullets, (ab) => ab.life > 0);
  tickBossBeams(game, musicDt);
  for (const s of game.shards) s.update(musicDt);
  compactInPlace(game.shards, (s) => s.life > 0);
  for (const c of game.canisters) {
    const wasWarping = c.warping;
    c.update(musicDt, game.w, game.h);
    if (!wasWarping && c.warping) game.sound.play("canisterAppear", 1, c.pos);
  }
  compactInPlace(game.canisters, (c) => c.alive);
  for (const g of game.gems) {
    const wasAlive = g.alive;
    g.update(musicDt, game.w, game.h);
    // collect/waste paths remove gems via handleGems without
    // touching alive, so any alive→dead transition here is a lifetime expiry.
    if (wasAlive && !g.alive) expireGem(game, g);
  }
  compactInPlace(game.gems, (g) => g.alive);
  for (const o of game.fuelOrbs) o.update(musicDt, game.w, game.h);
  compactInPlace(game.fuelOrbs, (o) => o.alive);
  updatePositionalAudio(game);
};

// Refresh the spatial listener and the per-frame pan/gain on every active
// drone. Listener is the ship (when alive); drones still pan after death so
// the post-mortem field-clear keeps positional cues. We pass the screen
// dimensions so pan saturates at the actual visible edges.
const updatePositionalAudio = (game: Game) => {
  game.sound.setListener(game.ship.pos.x, game.ship.pos.y, game.w, game.h);
  // audiblePos: an entering body pans from its visible entrance image, not
  // the folded pos on the far side of the torus.
  for (const a of game.asteroids) {
    if (a.isBass() && (a.size === "medium" || a.size === "small")) {
      game.sound.updateBassteroidDrone(a, audiblePos(a));
    }
    if (isPhasedKind(a.kind)) {
      // Lazily open the voice (guards against dupes) and ride the phase morph:
      // ghost = 1 - opacity, so the hum warbles harder as the rock fades out.
      // The citadel shares the warble's voice — its slow cycle just morphs it
      // over 16-beat stretches instead of every measure.
      game.sound.startWarbleDrone(a, audiblePos(a));
      game.sound.updateWarbleDrone(a, audiblePos(a));
      game.sound.setWarbleDronePhase(a, 1 - a.warbleOpacity);
    }
  }
  for (const al of game.aliens) game.sound.updateAlienDrone(al, audiblePos(al));
  for (const c of game.comets) if (!c.isMeteor) game.sound.updateCometShimmer(c, audiblePos(c));
};

// A comet that times out / an alien that flies past the far edge flags
// needsWormhole the frame it begins warping out (the body owns the suck-in; this
// spawns the portal it dives into). Anchor the portal at the body's warp-start
// position so the mouth gapes where the dive began. Called right after each
// entity's update loop with that array; the flag is consumed once.
type WarpingBody = {
  needsWormhole: boolean;
  warpStartX: number;
  warpStartY: number;
  radius: number;
  warpHeading: number;
};
const spawnPendingWormholes = (game: Game, bodies: WarpingBody[]) => {
  for (const e of bodies) {
    if (!e.needsWormhole) continue;
    e.needsWormhole = false;
    spawnWormhole(
      game.wormholes, { x: e.warpStartX, y: e.warpStartY }, e.radius, e.warpHeading,
    );
  }
};

// A comet/meteor that times out flags needsExplosion the frame it ends (the body
// owns the clock; the Game owns particles + sound). Burst it apart in place with
// the same celestial spray a player-killed one throws. A lone comet also gets the
// softer "sad" death tone since nobody shot it — it just burned out; a meteor
// shower stays silent here so its staggered flock doesn't ripple out a chorus of
// sad tones (the shower had its own entrance sound). The flag is consumed once;
// pruneDeadComets then drops the now-!alive body.
const spawnPendingCometExplosions = (game: Game) => {
  for (const c of game.comets) {
    if (!c.needsExplosion) continue;
    c.needsExplosion = false;
    emitCometExplosion(game.particles, c);
    // No pos — see killEffects: the baked comet-death buffer must play centered
    // at full volume, matching the old live graph's dead-center routing.
    if (!c.isMeteor) game.sound.play("cometDestroyedSad", 1);
  }
};

// pruning is a separate pass so we don't mutate game.comets mid-iteration of the update loop.
const pruneDeadComets = (game: Game) => {
  const survivingComets = [];
  for (const c of game.comets) {
    if (c.alive) survivingComets.push(c);
    else game.sound.stopCometShimmer(c);
  }
  game.comets = survivingComets;
};

// Aliens fly across the field on an arc and despawn once they drift past the
// far side. They mark themselves !alive in update(); we drop them here and
// release their drone so the chord doesn't keep humming after they're gone.
const pruneOffscreenAliens = (game: Game) => {
  const surviving: typeof game.aliens = [];
  for (const a of game.aliens) {
    if (a.alive) surviving.push(a);
    else game.sound.stopAlienDrone(a);
  }
  game.aliens = surviving;
};

// shots aim at the player's pos at fire-time — dodging works by moving between beats.
const tickAlienFire = (game: Game) => {
  if (game.aliens.length === 0) return;
  for (const a of game.aliens) {
    if (a.warpT !== null) continue; // warping out — done fighting, just leaving
    if (a.entering) continue; // holds fire while sliding in
    // A clock that fell behind (fire was held during the entrance — however it
    // ended) re-arms to the next slot instead of firing a catch-up burst. Legit
    // fire never lags more than one frame, so a full BEAT_GRID of lag is
    // unambiguous.
    if (game.beatTime - a.nextFireAt > BEAT_GRID) {
      a.nextFireAt = Math.ceil((game.beatTime + 0.5) / BEAT_GRID) * BEAT_GRID;
    }
    while (game.beatTime >= a.nextFireAt) fireOneAlienShot(game, a);
  }
};

// Boss 8-beat rhythm. Every 4s cycle drives top/bottom hemisphere flashes,
// iris flash, pupil double-pulse, and the charged laser shot — all snapped
// to game.beatTime so the boss "plays along" with the music. Post-break the
// hemispheres each fire a slow plasma ball on their flash slot.
const tickBossRhythm = (game: Game) => {
  for (const a of game.asteroids) {
    if (!a.isBoss() && a.kind !== "bossEye" && a.kind !== "bossHemisphere") continue;
    // Boss-eye-open edge: the dormant→live transition just fired this tick.
    // Play the dissonant stinger and wipe the player's combo — the boss
    // arriving is a "wrong-note" moment, the music's tonal centre is broken.
    // Skip loseCombo() because its "wrrr" SFX would step on the stinger and
    // because the boss reset is a HARD wipe (a normal off-beat at 32x drops
    // to 4x; here the player drops to 0 regardless).
    if (a.bossJustOpenedEye) {
      a.bossJustOpenedEye = false;
      game.sound.play("bossEyeOpenStinger", 1.0, a.pos);
      if (game.beatCombo > 0) {
        game.beatCombo = 0;
        game.ship.comboLossFlash = 1;
        syncComboHud(game);
      }
    }
    const shipImg = nearestImageOf(game.ship.pos, a.pos, game.w, game.h);
    a.trackPlayer(shipImg.x, shipImg.y);
    const ev = a.tickBossRhythm(game.beatTime);
    if (ev.topFlash || ev.bottomFlash || ev.irisFlash) game.sound.play("bossPulse", 0.9, a.pos);
    if (ev.pupilFlash) game.sound.play("bossPulse", 1.0, a.pos);
    if (ev.firePlasma) fireBossHemispherePlasma(game, a);
    if (ev.fireLaser) fireBossEyeBolt(game, a);
  }
};

const tickWraiths = (game: Game, dt: number) => {
  for (const a of game.asteroids) {
    if (a.kind !== "wraith") continue;
    const shipImg = nearestImageOf(game.ship.pos, a.pos, game.w, game.h);
    // The wraith flanks relative to where the ship is POINTING, so it needs the
    // heading as well as the position (see Asteroid.tickWraith).
    const strike = a.tickWraith(dt, shipImg.x, shipImg.y, game.ship.heading, game.beatTime);
    // The windup is the telegraph — the cry lands there, half a beat before the
    // strike, so the player hears it in time to break off. The lunge itself
    // gets a shorter, closer hit of the same voice.
    if (strike === "windup") game.sound.play("wraithScream", 0.55, a.pos);
    else if (strike === "lunge") game.sound.play("wraithLunge", 1, a.pos);
  }
};

const fireBossEyeBolt = (game: Game, a: Asteroid) => {
  // Emit a sustained beam that sweeps across the locked aim direction (the
  // line re-aimed at the player on each windup beat and locked on beat 7 —
  // see Asteroid.tickLaserAim). The beam enters from one side, slashes
  // through where the player was, and exits the far side, so juking out of
  // the sweep's arc dodges it.
  const angle = a.eyeAimAngle();
  fireBossSweepBeam(game, a, angle);
  game.sound.play("alienFireBig", 1.0, a.pos);
  game.sound.play("bossPulse", 1.0, a.pos);
};

// Post-break, top/bottom hemispheres each launch one heavy plasma ball
// per cycle on their own flash beat. The ball lives exactly 4 beats and
// fades over the 5th — a sustained dodge window per shot.
const fireBossHemispherePlasma = (game: Game, a: Asteroid) => {
  const shipImg = nearestImageOf(game.ship.pos, a.pos, game.w, game.h);
  const angle = Math.atan2(shipImg.y - a.pos.y, shipImg.x - a.pos.x);
  const speed = ENTITY_CONFIG.boss.eyeBulletSpeed * 0.85;
  const muzzleDist = a.radius * 0.95;
  const muzzleX = a.pos.x + Math.cos(angle) * muzzleDist;
  const muzzleY = a.pos.y + Math.sin(angle) * muzzleDist;
  const bullet = new AlienBullet(
    { x: muzzleX, y: muzzleY },
    { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    "big",
    a.hue,
    true,
  );
  bullet.isBossHemiPlasma = true;
  bullet.maxLife = BEAT_GRID * 5;
  bullet.fadeStartLife = BEAT_GRID * 1;
  bullet.life = bullet.maxLife;
  game.alienBullets.push(bullet);
  game.sound.play("alienFireBig", 0.8, a.pos);
};

const fireOneAlienShot = (game: Game, a: Alien) => {
  if (game.ship.alive) {
    const angleOffset = a.size === "big" ? bigAlienBurstAngleOffset(a.firePatternIndex) : 0;
    const bullet = a.fireAt(nearestImageOf(game.ship.pos, a.pos, game.w, game.h), angleOffset);
    if (a.size === "small") {
      const k = rhythmSpeedMul(game);
      bullet.vel.x *= k;
      bullet.vel.y *= k;
    }
    game.alienBullets.push(bullet);
    const fireSound = a.size === "big" ? "alienFireBig" : a.size === "medium" ? "alienFireMedium" : "alienFireSmall";
    game.sound.play(fireSound, 1, a.pos);
  } else {
    a.fireFlash = 1;
  }
  const pattern = ALIEN_FIRE_PATTERN_BEATS[a.size];
  const gap = pattern[a.firePatternIndex % pattern.length];
  a.firePatternIndex = (a.firePatternIndex + 1) % pattern.length;
  a.nextFireAt += gap * BEAT_GRID;
};

// collisions run before evaluateClosedBeats so trailing-edge closures see this frame's kills.
const runCollisionPasses = (game: Game) => {
  handleCollisions(game);
  handleAlienHits(game);
  handleAlienBulletHits(game);
  handleCometHits(game);
  handleCanisterPickups(game);
  handleCanisterShots(game);
  handleGems(game);
  handleFuelOrbPickups(game);
};

// Fade "Wave N" into the centre of the screen so it picks up directly from
// where the previous wave's "Completed Wave N" title sat in the summary panel.
// The wave-skip cascade retriggers it once per skipped wave, so the hide timer
// is tracked — a stale timer from title N must not cut title N+1 short.
// Replay seeks and the open-time histogram sweep fast-step through many wave
//   boundaries in one synchronous burst (game.replayFastForwarding) — skip the
//   DOM/timer work then, or it fires a pile of announcements that land at real
//   times unrelated to where playback actually resumes.
let waveAnnounceHideTimer = 0;
export const showWaveAnnounce = (game: Game, wave = game.wave) => {
  if (game.replayFastForwarding) return;
  let el = document.getElementById("wave-announce");
  if (!el) {
    el = document.createElement("div");
    el.id = "wave-announce";
    const inner = document.createElement("span");
    el.appendChild(inner);
    document.body.appendChild(el);
  }
  const inner = el.firstElementChild as HTMLSpanElement;
  inner.textContent = `Wave ${displayWave(wave)}`;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  window.clearTimeout(waveAnnounceHideTimer);
  waveAnnounceHideTimer = window.setTimeout(() => { el?.classList.remove("show"); }, 2800);
};

// Cancel any in-flight announce timer and hide the title immediately. Called
//   when a replay seek rebuilds the world, so a title queued against the
//   pre-seek "now" can't pop back up mid-flight after the rewind.
export const hideWaveAnnounce = () => {
  window.clearTimeout(waveAnnounceHideTimer);
  document.getElementById("wave-announce")?.classList.remove("show");
};

// the wave-clear cue (sound + pulsar pulse + boss state) fires
//   immediately on closure, but the next wave's spawn is deferred until the
//   summary panel has fully faded — the empty-asteroids playfield serves as
//   the breathing room while the player reads their bonus. waveTransitioning
//   gates the empty-asteroids check in the update loop so this only fires once.
// The wave-skip path lands the spawn on a farther `targetWave` and pushes it
//   out by `extraSpawnDelaySec` (the skipped-title cascade rides that gap);
//   the summary/payout flow is identical, and the returned schedule lets the
//   skip sequencer anchor its cascade + emergence to the same beats.
export const advanceWave = (game: Game, targetWave?: number, extraSpawnDelaySec = 0): SummarySchedule => {
  const wasBossWave = isBossWave(game.wave);
  const completedWave = game.wave;
  // The wave-ending hit's staged bonuses (drift / rapid-rhythm / twin-shot)
  //   haven't fired yet — pay them out before snapshotting the summary stats,
  //   or the last shot's rewards silently vanish from the panel and its bonus.
  flushPendingDriftBonuses(game);
  flushPendingRhythmBonuses(game);
  const maxRhythm = Math.max(1, game.maxComboThisWave);
  const finalRhythm = Math.max(1, game.beatCombo);
  const bestStreak = game.bestStreakThisWave;
  const driftBonuses = game.driftBonusesThisWave;
  // Rookie warm-up: clearing the single rock (stage 1) holds at internal wave 1
  //   to show the single crystal (stage 2); clearing that advances normally.
  //   Both clears are titled "Wave Complete" with no number. A wave-skip
  //   (explicit targetWave) never counts as a warm-up clear.
  const inWarmup = targetWave === undefined && completedWave === 1 && game.warmupCrystalStage !== 0;
  const nextStage = inWarmup && game.warmupCrystalStage === 1 ? 2 : 0;
  const holdForWarmupCrystal = inWarmup && game.warmupCrystalStage === 1;
  const nextWave = targetWave ?? (holdForWarmupCrystal ? completedWave : completedWave + 1);
  // A player who clears Wave 1 without touching every control shouldn't keep
  //   staring at the controls pane — force the fade (and release the hints
  //   queued behind it) at the wave boundary.
  if (displayWave(completedWave) >= 1) dismissControlsHint(game);
  game.sound.play("waveClear");
  game.sound.play("pulsarHum");
  game.pulsar.waveClear();
  if (wasBossWave) game.pulsar.setBossPlanetState("defeated", actOfWave(completedWave));
  game.waveTransitioning = true;
  // The wave is over — every open skip portal irises shut, so one can never
  //   be entered while the transition below is in flight.
  collapseSkipPortals(game);
  // One beat-grid schedule feeds both halves: the cosmetic panel (DOM timers +
  //   beat cues) and the sim-clock driver that owns the score drain + deferred
  //   spawn. beatTime is a deterministic sum of recorded musicDt, so the sim
  //   half reproduces in replays; the snap in the builder is what puts the
  //   whole summary on the same grid the bgBeat pulse plays on.
  const bonus = (maxRhythm + finalRhythm + driftBonuses + bestStreak) * 100;
  const schedule = buildSummarySchedule(game.beatTime, bonus, extraSpawnDelaySec);
  showWaveSummary(game, schedule, displayWave(completedWave), maxRhythm, finalRhythm, bestStreak, driftBonuses, inWarmup);
  beginWaveTransition(game, schedule, () => {
    game.wave = nextWave;
    // Step the warm-up stage before spawnWave so it spawns the right target
    //   (crystal on stage 2), then clears so wave 2+ behave normally.
    if (inWarmup) game.warmupCrystalStage = nextStage;
    // opening rocks' speed keys off the peak combo of the wave just cleared, not
    //   the live combo at spawn (which a death or whiff may have already reset).
    game.waveStartRhythm = game.maxComboThisWave;
    game.maxComboThisWave = game.beatCombo;
    game.driftBonusesThisWave = 0;
    game.bestStreakThisWave = 0;
    // clear any leftover trailing dots so a streak doesn't ride into the next wave.
    resetStreak(game);
    game.pulsar.setWaveLevel(game.wave);
    updateBgBeatIntensity(game);
    spawnWave(game);
    // The single-target warm-ups carry no numbered banner (the summary already
    //   read "Wave Complete"); the density waves announce their number as usual.
    if (!holdForWarmupCrystal) showWaveAnnounce(game);
    syncHud(game);
    game.waveTransitioning = false;
  });
  syncHud(game);
  return schedule;
};
