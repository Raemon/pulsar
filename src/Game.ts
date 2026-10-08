import { Ship } from "./Ship";
import { Asteroid, AsteroidKind } from "./Asteroid";
import { Bullet } from "./Bullet";
import { ParticleSystem } from "./Particle";
import { Shard } from "./Shard";
import { Starfield } from "./Starfield";
import { Pulsar } from "./Pulsar";
import { Input, IInput } from "./Input";
import { Sound } from "./Sound";
import type { AudioChannel } from "./game/audioPrefs";
import type { MusicLayer } from "./musicConfig";
import type { HaloMusicVariation } from "./Sound";
import { Canister } from "./Canister";
import { Gem } from "./Gem";
import { FuelOrb } from "./FuelOrb";
import { Comet } from "./Comet";
import { Alien, AlienSize } from "./Alien";
import { AlienBullet } from "./AlienBullet";
import { v, WORLD_W, WORLD_H } from "./vec";
import { Popup } from "./game/popups";
import { FIRST_BONUS_LIFE_SCORE } from "./game/bonusLife";
import type { BassLightning } from "./game/bassLightning";
import type { DriftBurst } from "./game/driftBurst";
import type { Wormhole } from "./game/wormhole";
import type { InkPatch } from "./game/inkCloud";
import type { SkipPortal, WaveSkipState } from "./game/waveSkip";
import { LaserBeam } from "./game/laserShot";
import { BossBeam } from "./game/bossBeam";
import { KilledSnapshot } from "./game/killSnapshot";
import type { HighscoreRow } from "./game/highscores";
import type { KillBucket } from "./game/killBuckets";
import { ParadeEntry } from "./game/killedParade";
import { HighlightTimeline } from "./game/highlightTimeline";
import type { WaveTransition } from "./game/waveTransition";
import type { BeatCue } from "./game/beatCues";
import type { AimHint } from "./game/aimHint";
import { WaveEventSchedule, newWaveEventSchedule } from "./game/waveEvents";
import { HudElements, bindHudElements } from "./game/hud";
import { showTitle, toggleMute, applyVolume, abortMission, setFirstWaveHintStage, triggerOverlayStart, openBeatCalibrator, finishCalibrationIntro, advanceIntroOverlay, unfreezeIntroWorld, togglePause, exitReplay } from "./game/lifecycle";
import { updateGame } from "./game/gameUpdate";
import { renderGame } from "./game/gameRender";
import { toggleReplayExport, cancelReplayExport } from "./game/videoExport";
import { loadBeatOffset, applyBeatOffset } from "./game/beatCalibration";
import { TutorialControlsUsed, emptyTutorialControlsUsed } from "./game/controlBindings";

// re-export so existing external imports (Ship.ts) keep working without touching their imports.
export { BEAT_GRID } from "./game/rhythmConstants";

// Fixed 16:9 logical playfield. Every entity (ship, bullets, asteroids, stars)
// sizes itself against game.w/game.h, so locking these to constants keeps the
// relative scale of the world identical at any window size or browser zoom.
// Defined in vec.ts (the torus is exactly one viewport) — importing Game.ts
// from vec.ts would be a cycle.
export const LOGICAL_W = WORLD_W;
export const LOGICAL_H = WORLD_H;

type GameState = "title" | "playing" | "paused" | "dying" | "gameover" | "replaying";

// Game holds the cross-cutting state every helper in src/game/* reads; behavior lives in modules.
export class Game implements HudElements {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  input: IInput;
  sound: Sound;
  starfield: Starfield;
  pulsar: Pulsar;
  particles = new ParticleSystem();
  shards: Shard[] = [];
  ship: Ship;
  asteroids: Asteroid[] = [];
  bullets: Bullet[] = [];
  // Laser-shot beams from the "lasershot" upgrade — one per release of the
  //   charge. Short-lived visuals (damage resolves on spawn); see game/laserShot.ts.
  lasers: LaserBeam[] = [];
  // Laser ambient lighting: charge buildup eases up while holding fire; the
  //   fire flash pops on release and decays fast. Both drive a full-screen
  //   additive wash in renderLaserAmbientFlash. Kept on Game (not Ship) so the
  //   fire flash survives the resetLaserCharge that runs right after firing.
  laserChargeGlow = 0;
  laserFireFlash = 0;
  // Medium white full-screen wash when a bonus life is earned. Set to 1 in
  //   checkBonusLife, decayed in updatePlaying, painted in renderBonusLifeFlash.
  bonusLifeFlash = 0;
  // Sustained sweeping beams fired by the boss eye — see game/bossBeam.ts.
  bossBeams: BossBeam[] = [];
  popups: Popup[] = [];
  // bass-echo arcs from a firing bassteroid to an on-rhythm kill — see
  //   game/bassLightning.ts for the trigger conditions and rendering.
  bassLightnings: BassLightning[] = [];
  // one-shot "sound visualizer explosion" radiating from each on-beat drift-shot
  //   hit, tier-coloured and tier-sized — see game/driftBurst.ts.
  driftBursts: DriftBurst[] = [];
  // Inky blackout patches spawned where a black-diamond prison shattered —
  //   spread to a viewport-covering radius over ~10s, persist while any
  //   wraith is alive, then unroll. See game/inkCloud.ts.
  inkPatches: InkPatch[] = [];
  // 3D departure portals: comets that time out and aliens that fly off the far
  //   edge warp out THROUGH one of these instead of fading/vanishing. The body's
  //   suck-in lives on the entity; this holds the portal visual — see
  //   game/wormhole.ts.
  wormholes: Wormhole[] = [];
  // Wave-skip portals torn open by player-killed aliens: each record pairs a
  //   wormhole visual (shared with the list above) with its rolled skip depth.
  //   Entering one starts the warp below — see game/waveSkip.ts.
  skipPortals: SkipPortal[] = [];
  // Wave-skip warp in flight: dive → hidden (summary + title cascade) →
  //   emerge. null = flying normally. game/waveSkip.ts owns the lifecycle.
  waveSkip: WaveSkipState | null = null;
  // on-beat hits while a hover ring is locked queue a deferred rhythm bonus here. `amount` is the
  //   flat +1 combo added a beat later (tier no longer scales rhythm); `tier` drives the popup's
  //   colour + the damage-mult readout; `showDamageMult` is set when this hit beat the run's prior
  //   best multiplier, so the deferred popup surfaces the tier-coloured "N× DAMAGE" line.
  //   Each tick fires (or cancels) the entries whose moment has come.
  pendingDriftBonuses: Array<{
    fireAt: number; pos: { x: number; y: number }; amount: number; tier: number; showDamageMult: boolean;
  }> = [];
  // rhythm-hit pairing for the Rapid Rhythm / Twin Shot bonuses (game/rhythmBonus.ts):
  //   beat center of the latest combo-incrementing hit (-1 = none since last break),
  //   how many such hits landed on that beat, and where the last one struck.
  lastRhythmHitBeatCenter = -1;
  rhythmHitsThisBeat = 0;
  lastRhythmHitPos: { x: number; y: number } | null = null;
  // queued +1-rhythm rewards from those bonuses; staggered fireAt times make each
  //   bonus xN pop separately. Fired by tickPendingRhythmBonuses.
  pendingRhythmBonuses: Array<{ fireAt: number; pos: { x: number; y: number } }> = [];
  // Rhythm-streak state (game/rhythmBonus.ts): rewards landing successive combo-shots
  //   close together. The first shot seeds silently; the 2nd in-window shot mints the
  //   first orb orbiting the reticule and each further shot adds one; the streak continues
  //   as long as each shot lands within STREAK_MAX_GAP grid-beats of the last. Every
  //   counted shot pays an escalating score bonus on the spot (awardStreakShot).
  //   Only kills count and seed; an on-beat non-kill hit refreshes
  //   the gap timer, no orb added (extendStreakWindow). A wider
  //   gap, a combo loss, or the extension window closing (streakWindowClosed — the ring
  //   fade reaches zero at the same moment) ends it and clears the ring. The orbs spin
  //   at a steady 4-beat/rev rate. Orbit phase derives from beatTime, fade + window from
  //   perceivedBeatTime — no per-frame RNG or stored phase, so replays reproduce it.
  streakInterval = 0; // orbit rate in grid units (beats per revolution); 0 = no streak
  streakGrid = 0; // comboGrid value the streak runs on; a grid change breaks it
  streakShots = 0; // orbs currently orbiting (the "N") — 0 while a seed awaits its 2nd shot
  streakEstablished = false; // has a 2nd in-window shot started counting toward the metric?
  streakLastBeatCenter = -1; // beat-center of last streak shot or extending hit; gap + fade
  bestStreakThisWave = 0; // longest ESTABLISHED streak this wave, for the summary metric
  score = 0;
  wave = 1;
  lives = 3;
  // Next score threshold at which the player earns a bonus life. Doubles
  //   each time it's crossed.
  nextBonusLifeScore = FIRST_BONUS_LIFE_SCORE;
  state: GameState = "title";
  dyingTimer = 0;
  // Replay mirror of dyingTimer: live play flips to "dying" and respawns from
  //   updateDying, but replay stays in "replaying" so the scrubber keeps
  //   control. We count this down inside the replay update and respawn (or end
  //   the run, on the last life) without leaving "replaying". null = ship alive.
  replayDyingTimer: number | null = null;
  shake = 0;
  shakeSeed = 0;
  w = 0;
  h = 0;
  dpr = 1;
  time = 0;
  // Render-only continuous camera offset for the locked-center scroll mode. The
  // ship's gameplay position wraps every frame (wrapMut) so `w/2 - ship.pos`
  // snaps by ±w at a seam crossing; the world layer hides that under `% w`, but
  // the parallax layers (pulsar, starfield) scale the offset by <1 and a snap of
  // `parallax·w` is NOT a multiple of w, so they jolt. We instead integrate the
  // ship's toroidal frame-to-frame step into this accumulator, which never jumps,
  // and drive every layer off it. See updateCamScroll + game/gameRender.ts.
  camScrollX = 0;
  camScrollY = 0;
  lastShipPosX: number | null = null;
  lastShipPosY: number | null = null;
  // shared bass-beat clock — bass voices, on-beat detection and the visual pulsar all read this one source.
  beatTime = 0;
  // last beatTime at which we resnapped to the music's authoritative
  // audio-clock phase. Drives the periodic check in tickBeatResnap.
  lastBeatResnapAt = 0;
  // signed seconds of beat-phase error left to bleed off into musicDt over
  // subsequent frames, so corrections happen as a smooth tempo nudge rather
  // than a hard jump that skips or replays bgBeat slots.
  beatPhaseCorrection = 0;
  // Replay/export only: a playback-rate trim that holds the music on the sim
  //   clock, because a replay may not move the clock onto the music the way
  //   live play does (see tickReplayMusicPhase). 1 = untrimmed.
  musicRateTrim = 1;
  // Smoothed rate the sim clock runs at against the audio clock. 1 in live
  //   play (they are the same clock); a few tenths of a percent off during a
  //   replay, which is what the trim above cancels.
  simClockRate = 1;
  // The (audio clock, beatTime) pair that rate is measured from. Null while no
  //   audio clock is running, so the next tick re-marks instead of measuring
  //   across the gap.
  musicPhaseAudioMark: number | null = null;
  musicPhaseBeatMark = 0;
  // player-measured latency offset (seconds), loaded in the constructor. Raw audio
  //   fires on `beatTime`; everything the player reacts to (scoring window + visual
  //   beat cues) reads `perceivedBeatTime` so it lands on the beat they actually hear.
  beatOffset = 0;
  // latched while the tap-to-beat calibrator overlay is open so the title loop
  //   doesn't keep re-firing the start request behind it.
  calibrating = false;
  // latched between the player's title-screen start press and the moment the
  //   baked-mp3 cache finishes loading. Suppresses re-entrant start requests so
  //   the player can't double-trigger or get stuck while audio warms.
  startPending = false;
  // true while the settings dialog is open. Together with `calibrating`, this
  //   freezes the sim during play (see updateGame) so the ship can't drift or
  //   die behind a full-screen menu.
  settingsOpen = false;
  // true during the first-run calibration warm-up: the run has started and the
  //   beat is playing, but the world is held while the player practices the
  //   rhythm (see updateCalibration). Distinct from `calibrating`, which also
  //   covers the standalone recalibrator that doesn't run the game's beat.
  calibrationIntro = false;
  // True while the new-day / post-calibration text-overlay sequence is on
  //   screen — beat keeps ticking but the world is held and fire is gated off,
  //   same shape as `calibrationIntro`. Drives <IntroSequence>.
  introOverlayActive = false;
  // Which leg of the intro chain is on screen. The post-calibration path runs
  //   "latency" → "fullHints" → finalize; the daily-intro path is just one
  //   leg ("fullHints" or "shortHint") → finalize. Null between sequences.
  introOverlayStep: null | "latency" | "fullHints" | "shortHint" = null;
  // Hints picked at the start of the intro chain, so the latency→fullHints
  //   hand-off reuses the same triplet instead of re-rolling.
  introOverlayHints: string[] = [];
  // one-shot lerp of bgBeatIntensity (calibration loudness → wave level) so the
  //   beat eases in volume across the calibration→play hand-off instead of jumping.
  beatIntensityRamp: { from: number; to: number; t: number; dur: number } | null = null;
  // first-run guided tutorial (rookies only). Starts with a single small
  //   practice rock (respawning when killed); two milestones gate progress:
  //   hover a first-beat dot for 1s, then land one on-beat hit. After that the
  //   field holds one big rock at a time (respawning on clear) until the hint
  //   progression finishes — then tutorialActive clears and waves advance.
  tutorialActive = false;
  tutorialHoverDone = false;
  tutorialFireHitDone = false;
  // Non-veteran Start-button warm-up runs two single-target waves before the
  //   first real density wave: 1 = single rock (internal wave 1), 2 = single
  //   solid crystal (still internal wave 1), 0 = warm-up done / veteran skip.
  //   Both warm-up clears show "Wave Complete" instead of a wave number.
  warmupCrystalStage: 0 | 1 | 2 = 0;
  // chosen at the title screen: Start button → false, Tutorial button → true.
  //   beginFirstWaveByTutorialFlag reads this to decide whether to spawn the
  //   guided practice rock or the regular wave 1.
  tutorialRequested = false;
  lastBgBeatIndex = -1;
  nextBeatToEvaluate = 0;
  beatCombo = 0;
  // high-water mark of beatCombo during a run — submitted with the score so the leaderboard
  //   can showcase a pilot's best streak, separately from the final score.
  maxCombo = 0;
  // per-wave high-water mark of beatCombo, surfaced in the wave-clear summary panel.
  //   Reset to the current beatCombo at the start of each new wave.
  maxComboThisWave = 0;
  // the previous wave's peak combo, carried over so the opening rocks' speed is
  //   set by how well the player just played — not their live combo at spawn time.
  waveStartRhythm = 0;
  // per-wave count of fired drift bonuses, surfaced in the wave-clear summary as
  //   a separate +100/each line. Reset at the same point as maxComboThisWave.
  driftBonusesThisWave = 0;
  // first Drift Shot of a run gets a "2× DAMAGE" subtitle on the popup so the
  //   player learns what it's worth; later ones show just the label.
  hasShownDriftShotLabel = false;
  // highest drift-shot damage multiplier the run has surfaced so far. A drift hit only re-shows
  //   the "N× DAMAGE" line when it beats this, so an escalation announces itself but a repeat of
  //   a tier you've already seen stays quiet. Reset per run alongside hasShownDriftShotLabel.
  bestDriftDamageMultShown = 0;
  // latched on off-beat fire so the punishment can land at the next beat closure (not retroactive).
  firedOffBeatSinceLastBeat = false;
  // first-ever meaningful combo loss in a run gets a labeled popup so the player learns the mechanic.
  hasLostComboEver = false;
  // Targeting lesson (game/aimHint.ts): hits that were FIRED on the beat but LANDED off it —
  //   the signature of aiming at the rock instead of at the lead reticule. Counted so the
  //   once-per-run hint can wait for the pattern to establish itself.
  firedOnBeatMissCount = 0;
  aimHintShown = false;
  // live hint: a pulse blooming around one target's reticule plus the popup beside it.
  aimHint: AimHint | null = null;
  // set for the duration of one hit judgement when the hint takes over, so the combo-loss
  //   path skips the popup + "fire (and hit) on the beat" banner it replaces.
  aimHintSuppressLossPopup = false;
  // combo x6 unlocks the first Pilot's Log vocal — fires once per run, gated by this flag.
  pilotLog1Unlocked = false;
  // combo x12 unlocks Entry 3 — same once-per-run gate, no HUD toast.
  pilotLog3Unlocked = false;
  // beta-test mode disables the random wave director — the run only contains the elements
  //   the player selected in the beta panel; when they're all gone the wave doesn't auto-spawn.
  betaMode = false;
  // latched while the end-of-wave summary is playing (drain + hold + fade)
  //   so the empty-asteroids check in the update loop doesn't keep re-triggering
  //   advanceWave each frame. Cleared when the summary finishes and the next
  //   wave's spawn fires.
  waveTransitioning = false;
  // Sim-clock-driven end-of-wave transition. Owns the score drain (and its
  //   bonus-life checks) and the deferred next-wave spawn so they advance on the
  //   recorded dt instead of wall-clock setTimeout — replays re-sim them on the
  //   same frames they happened live. null when no transition is in flight. The
  //   summary panel's visuals/audio still run on setTimeout (cosmetic); this only
  //   carries the sim-affecting payouts. See game/waveTransition.ts.
  waveTransition: WaveTransition | null = null;
  // Beat-grid audio cues awaiting their lookahead window (game/beatCues.ts).
  //   Audio-only — never checkpointed, never read by the sim.
  beatCues: BeatCue[] = [];
  // wave-1 instructional overlay. stage 1 holds until 3 on-beat fires land,
  //   stage 2 holds until 4x rhythm, stage 3 (the score-payoff line) auto-dismisses
  //   after a brief hold. once the player reaches 6x rhythm the tutorial is marked
  //   complete in localStorage and won't show again. React-side <FirstWaveHint>
  //   listens for the "first-wave-hint:stage" CustomEvent and handles the CSS
  //   transition + auto-dismiss, so the game loop only owns the stage number.
  // Guided-tutorial stage: 1 controls · 2 fire-on-beat · 3 drift/hover · 4 fire-and-hit
  //   · 5 build-to-4x · 6 "become one with the Pulsar" · 0 hidden. Stage 1 is rendered
  //   by <TutorialControlsHint>; 2–6 by <FirstWaveHint>.
  firstWaveHintStage: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 0;
  firstWaveOnBeatFireCount = 0;
  // controls-phase (stage 1, and the normal-mode start-of-run controls hint) usage
  //   tracker. In tutorial mode all used → advance to stage 2; in normal mode all
  //   used → dismiss the hint. Rows come from TUTORIAL_CONTROLS.
  tutorialControlsUsed: TutorialControlsUsed = emptyTutorialControlsUsed();
  // True while the normal-mode start-of-run controls hint is visible. Tutorial mode
  //   uses firstWaveHintStage === 1 instead, since the stage already gates that hint.
  controlsHintActive = false;
  // A first combo loss that landed while the controls pane was still up defers the
  //   "fire (and hit) on the beat" hint to here; it fires once the pane dismisses.
  rhythmLossHintPending = false;
  // stage-2 sub-line ("Use your targeting tools to help") is gated on the
  //   player landing three on-beat hits after stage 2 opens. The diamond
  //   row under stage 2's main line fills one pip per hit, and the sub-line
  //   reveals once all three are lit.
  firstWaveHintSubVisible = false;
  firstWaveOnBeatHitCount = 0;

  canisters: Canister[] = [];
  gems: Gem[] = [];
  // Fuel Mode consolation drops — orbs left by gold ore that cracked open without
  // an upgrade. Fly through one to refill the reserve. See game/fuel.ts.
  fuelOrbs: FuelOrb[] = [];
  comets: Comet[] = [];
  aliens: Alien[] = [];
  alienBullets: AlienBullet[] = [];
  alienSpawnSize: AlienSize = "small";
  waveElapsed = 0;
  // false until the run's opening wave spawns; the first spawnWave (or the
  //   tutorial's first practice rock) consumes it. Gates the centre-out
  //   "drift away from the player" spawn that only the first level uses.
  hasSpawnedFirstLevel = false;
  slowMoTimer = 0;
  // per-game randomised bass-kind intro order so the wave-2/3 picks vary between runs.
  bassOrder: AsteroidKind[] = [];
  // one unified list replaces four parallel `xSpawnAt` fields used to schedule mid-wave events.
  waveEvents: WaveEventSchedule = newWaveEventSchedule();

  // Replay system. runSeed is the 32-bit PRNG seed minted at startGame; the
  //   recorder buffers per-frame dt + key deltas; the player drives state ===
  //   "replaying". lastRunReplay is the serialised gzip bytes from the most
  //   recent run, available for upload once the player names their score.
  runSeed = 0;
  recorder: import("./game/replayRecorder").ReplayRecorder | null = null;
  replayPlayer: import("./game/replayPlayer").ReplayPlayer | null = null;
  lastRunReplay: Uint8Array | null = null;
  // Set during replay to force resize() to use recorded sim dims instead of
  //   the live window; canvas is CSS-scaled to fit. Cleared when replay ends.
  replayLockedDims: { w: number; h: number; dpr: number } | null = null;
  // Scrubber state. replaySpeed: 0 = paused, else a wall-clock multiplier
  //   (0.5/1/2/4) — 1x plays back at the original run's real-time pace.
  //   replaySeekTarget: a frame index to jump to next tick (set by the timeline
  //   drag / arrow keys); consumed and cleared by the seek step.
  //   replayStepAccumulator carries leftover time budget (seconds) between ticks.
  replaySpeed = 1;
  replaySeekTarget: number | null = null;
  replayStepAccumulator = 0;
  // True while a seek or the open-time histogram sweep is synchronously
  //   fast-stepping through many recorded frames in one JS tick. Cosmetic-only
  //   DOM triggers (wave announce/summary) check this so a scrub crossing
  //   several wave boundaries doesn't schedule a pile of real-time timers
  //   against a "now" that has nothing to do with where playback resumes.
  replayFastForwarding = false;
  // True while the offline MP4 exporter (game/videoExport.ts) owns the replay
  //   loop: gates the rAF update/render and the scrubber transport events, and
  //   turns exit/Escape into export-cancel instead of leaving the replay.
  replayExporting = false;
  // Highlight-clip mode: a looping sub-range of the recording played on the
  //   game-over screen (best rhythm chain, 4s pre-roll → rhythm lost). When set,
  //   the replay loop plays start→end then rebuilds + fast-forwards back to start
  //   instead of running to the end of the stream. Null for normal full replays
  //   (leaderboard playback), so the scrubber/scoreboard path is unaffected.
  highlightClip: { start: number; end: number } | null = null;
  // Loop fade state: null while the clip plays, else the phase of the
  //   fade-out → silent catch-up re-sim → fade-in cycle that masks the
  //   synchronous rewind hitch. startedAt is a performance.now() stamp.
  highlightLoop: { phase: "fadeOut" | "fadeIn"; startedAt: number } | null = null;
  // localInput is the real keyboard-bound Input; the replay path swaps `input`
  //   to point at the player's ReplayInput while a replay is running, and we
  //   restore localInput when returning to title.
  localInput!: Input;

  scoreEl: HTMLElement;
  scoreFlashEl: HTMLElement;
  comboEl: HTMLElement;
  comboValueEl: HTMLElement;
  waveEl: HTMLElement;
  livesEl: HTMLElement;
  overlayEl: HTMLElement;
  overlayTitleEl: HTMLElement;
  overlayStartEl: HTMLElement;
  volumeEl: HTMLInputElement;
  abortEl: HTMLButtonElement;
  killedRowEl: HTMLCanvasElement;
  scoreEntryFormEl: HTMLFormElement;
  scoreEntryInputEl: HTMLInputElement;
  scoreEntrySubmitEl: HTMLButtonElement;
  scoreEntryStatusEl: HTMLElement;
  leaderboardEl: HTMLElement;
  leaderboardListEl: HTMLOListElement;
  replaySaveCheckboxEl: HTMLInputElement;
  debugOverlayEl: HTMLElement;
  debugFpsEl: HTMLElement;
  // backtick (`) toggles #debug-overlay. FPS readout is always visible (bottom-right).
  // ?debug=true in the URL forces debug-on from page load (handy for triaging
  // production issues where the player can't easily hit backtick on mobile).
  debugMode = new URLSearchParams(window.location.search).get("debug") === "true";
  // prevents a double-submit if the player mashes Enter while the POST is in flight.
  scoreSubmitState: "idle" | "submitting" | "submitted" = "idle";
  // lets the title screen after a game-over show a score-neighborhood (±5) around the
  //   player's run instead of the global top 10. Cleared when a new run starts.
  lastRunScore: number | null = null;
  lastRunScoreId: number | null = null;
  // up/down on the title + gameover leaderboard moves a yellow selector through
  //   the fetched pilot list (cap of 50). The selector slides toward the centre
  //   slot of the 11-row window first; once centred, further presses scroll the
  //   underlying list. See game/scoreEntry.ts.
  leaderboardRows: HighscoreRow[] = [];
  // Unfiltered top-100 from the server; drives the rendered view when
  //   "top entries only" is OFF, and is the base for "show more" paging.
  //   May also hold recent-only runs folded in for the "When" sort.
  leaderboardAllRows: HighscoreRow[] = [];
  // Count of score-ranked rows in leaderboardAllRows (excludes the recent-only
  //   runs folded in). The "show more" page offset reads this so the cursor
  //   isn't thrown off by the appended recent rows.
  leaderboardRankedCount = 0;
  // Deep server-deduped "top pilots" set — scanned far enough to surface ~20
  //   distinct scores' worth of pilots. Drives the rendered view when "top
  //   entries only" is ON, since the raw top-100 can be dominated by one pilot.
  leaderboardTopPilots: HighscoreRow[] = [];
  leaderboardSelection = 0;
  leaderboardActive = false;
  // When true the rendered list dedupes by name, keeping each pilot's best
  //   row only. Persisted across sessions via localStorage.
  leaderboardTopOnly = true;
  // "show more" expands past the 7-row title window to render every loaded row.
  leaderboardExpanded = false;
  // True when the last fetch returned a full page, meaning more rows may exist
  //   on the server. Drives whether "show more" stays visible after expansion.
  leaderboardHasMore = false;
  // True while a "show more" page fetch is in flight; used to debounce clicks
  //   and to swap the button label to "loading…".
  leaderboardLoadingMore = false;
  // clickable column headers re-sort; score is the default.
  leaderboardSort: "rhythm" | "score" | "wave" | "name" | "date" = "score";
  // One-shot: after submitting a score, the very next title screen shows the
  //   ±25 neighborhood centred on the player instead of the hall-of-fame. The
  //   fetch is armed during the game-over screen so there's no loading flash.
  //   Both reset when a new run starts. See game/scoreEntry.ts.
  showNeighborhoodOnce = false;
  neighborhoodFetch: Promise<{ scores: HighscoreRow[]; selfRank: number } | null> | null = null;
  // True while the neighborhood view is rendered: forces the full ±25 list to
  //   render expanded (not windowed) so the page can scroll the self row to centre.
  leaderboardNeighborhood = false;
  // Global rank of the first rendered row, so the neighborhood view shows true
  //   ranks instead of a window-local index. 0 on every other view.
  leaderboardRankBase = 0;
  // When set (via ?player= or a click on a leaderboard name), the title screen
  //   shows that pilot's full board — every run, top-50 per category — instead
  //   of the global hall-of-fame. See game/scoreEntry.ts.
  leaderboardPlayerFilter: string | null = null;

  // post-run trophy lineup; replayed in the end-of-mission parade with original kill sounds.
  killedSnapshots: KilledSnapshot[] = [];
  // per-run kill tally by category — submitted alongside the score on game over.
  killTally: Partial<Record<KillBucket, number>> = {};
  paradeActive = false;
  // parade timing reads game.beatTime (which keeps ticking through gameover) so
  //   sprite-crosses-centre events land on the same beat grid as the bg bass beat.
  paradeStartBeatTime = 0;
  paradeRafId: number | null = null;
  paradeEntries: ParadeEntry[] = [];
  paradeTotalBeats = 0;
  paradeCanvasW = 0;
  paradeCanvasH = 0;
  paradeOrientation: "horizontal" | "vertical" = "horizontal";
  // Segments the live run into rhythm chains so game-over can replay the
  //   highest-rhythm one as a highlight clip. Re-created each startGame.
  highlightTimeline = new HighlightTimeline();
  // Frozen copy of the just-finished run's summary, taken at game-over BEFORE the
  //   highlight clip rebuilds the world (which would reset game.score/maxCombo to
  //   fresh-run values). Score submission reads this when present so the highlight
  //   clip can run on the main sim without corrupting what gets submitted. Null
  //   outside game-over. (Replay upload bytes still land on game.lastRunReplay via
  //   the async finalizeRecorder gzip, which fires before the clip rebuild.)
  runSummary: {
    score: number;
    wave: number;
    maxCombo: number;
    killTally: Partial<Record<KillBucket, number>>;
  } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.localInput = new Input();
    this.input = this.localInput;
    this.sound = new Sound();
    this.resize();
    this.starfield = new Starfield(this.w, this.h);
    this.pulsar = new Pulsar(this.w, this.h);
    this.ship = new Ship(v(this.w / 2, this.h / 2));
    window.addEventListener("resize", () => this.resize());
    const hud = bindHudElements();
    this.scoreEl = hud.scoreEl;
    this.scoreFlashEl = hud.scoreFlashEl;
    this.comboEl = hud.comboEl;
    this.comboValueEl = hud.comboValueEl;
    this.waveEl = hud.waveEl;
    this.livesEl = hud.livesEl;
    this.overlayEl = hud.overlayEl;
    this.overlayTitleEl = hud.overlayTitleEl;
    this.overlayStartEl = hud.overlayStartEl;
    this.volumeEl = hud.volumeEl;
    this.abortEl = hud.abortEl;
    this.killedRowEl = hud.killedRowEl;
    this.scoreEntryFormEl = hud.scoreEntryFormEl;
    this.scoreEntryInputEl = hud.scoreEntryInputEl;
    this.scoreEntrySubmitEl = hud.scoreEntrySubmitEl;
    this.scoreEntryStatusEl = hud.scoreEntryStatusEl;
    this.leaderboardEl = hud.leaderboardEl;
    this.leaderboardListEl = hud.leaderboardListEl;
    this.replaySaveCheckboxEl = hud.replaySaveCheckboxEl;
    this.debugOverlayEl = hud.debugOverlayEl;
    this.debugFpsEl = hud.debugFpsEl;
    this.debugOverlayEl.classList.toggle("hidden", !this.debugMode);
    this.volumeEl.addEventListener("input", () => {
      applyVolume(this, Number(this.volumeEl.value) / 100);
    });
    // Slider sits at low opacity by default; light it up when the cursor is
    // within 25px of its bounding box so the player can find it without
    // having to land directly on it.
    window.addEventListener("mousemove", (e) => {
      const r = this.volumeEl.getBoundingClientRect();
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
      const near = Math.hypot(dx, dy) <= 25;
      this.volumeEl.classList.toggle("near", near);
    });
    this.beatOffset = loadBeatOffset() ?? 0;
    this.abortEl.addEventListener("click", () => abortMission(this));
    this.overlayStartEl.addEventListener("click", () => {
      // Start button on the title screen launches Wave 1 directly, no tutorial.
      //   In other states (paused/gameover) triggerOverlayStart routes correctly.
      if (this.state === "title") this.tutorialRequested = false;
      triggerOverlayStart(this);
    });
    window.addEventListener("tutorial:request", () => {
      if (this.state !== "title") return;
      this.tutorialRequested = true;
      triggerOverlayStart(this);
    });
    // <BeatCalibrator> (React) owns the tap-to-beat UI; the game owns the audio
    //   context it schedules clicks on, plus persistence of the result. These
    //   three events are the contract between them.
    window.addEventListener("beat-calibrator:request", () => openBeatCalibrator(this));
    window.addEventListener("beat-calibrator:done", (e) => {
      const { offsetSec, origin } = (e as CustomEvent).detail;
      applyBeatOffset(this, offsetSec);
      // First-run intro folds straight into live play on the same beat; standalone
      //   recalibration just applies the offset and re-opens settings if that's where we came from.
      if (this.calibrationIntro) finishCalibrationIntro(this);
      this.calibrating = false;
      if (origin === "settings") window.dispatchEvent(new CustomEvent("settings:open-request"));
    });
    window.addEventListener("beat-calibrator:cancel", (e) => {
      const { origin } = (e as CustomEvent).detail ?? {};
      // Bailing out of the first-run warm-up abandons the nascent run back to the title.
      if (this.calibrationIntro) {
        this.calibrationIntro = false;
        this.beatIntensityRamp = null;
        this.sound.bgBeatIntensity = 0;
        showTitle(this);
      }
      this.calibrating = false;
      if (origin === "settings") window.dispatchEvent(new CustomEvent("settings:open-request"));
    });
    // Settings dialog's manual latency slider — applies live (and persists) so a
    //   nudge takes effect immediately, even mid-run.
    window.addEventListener("beat-offset:set", (e) => {
      const { offsetSec } = (e as CustomEvent).detail;
      applyBeatOffset(this, offsetSec);
    });
    window.addEventListener("settings:opened", () => { this.settingsOpen = true; });
    window.addEventListener("settings:closed", () => { this.settingsOpen = false; });
    // Per-channel audio sliders (Audio tab in Settings). The dispatcher lives
    //   in audioPrefs.setChannelVolume; Sound applies the value to the
    //   matching channel gain pair (live + baked legs).
    window.addEventListener("audio-pref:changed", (e) => {
      const { channel, value } = (e as CustomEvent).detail as { channel: AudioChannel; value: number };
      this.sound.setChannelVolume(channel, value);
    });
    // /music page tweaks a per-variation/per-layer halo-music gain. The page
    //   saves through saveMusicConfig (POSTs to /__music-config__ and the dev
    //   plugin in vite.config.ts writes public/sounds/music-config.json);
    //   it also dispatches `halo-music-pref:changed` so the active stem can
    //   ramp to the new value without waiting for the next combo cycle.
    window.addEventListener("halo-music-pref:changed", (e) => {
      const { variation, layer, value } = (e as CustomEvent).detail as {
        variation: HaloMusicVariation; layer: MusicLayer; value: number;
      };
      this.sound.applyHaloLayerGain(variation, layer, value);
    });
    // <IntroSequence> fires unfreeze the moment its bg starts revealing the
    //   world (4 beats before the text finishes fading out) so the player can
    //   move during the fade-in; `done` fires when the overlay is fully gone.
    window.addEventListener("intro-sequence:unfreeze", () => unfreezeIntroWorld(this));
    window.addEventListener("intro-sequence:done", () => advanceIntroOverlay(this));
    window.addEventListener("game:togglePause", () => togglePause(this));
    // Replay scrubber (React <ReplayScrubber>) → game. Speed 0 pauses playback;
    //   seek sets a target frame consumed on the next replay tick.
    window.addEventListener("replay:setSpeed", (e) => {
      if (!this.replayPlayer || this.replayExporting) return;
      this.replaySpeed = (e as CustomEvent).detail.speed as number;
    });
    window.addEventListener("replay:seek", (e) => {
      if (!this.replayPlayer || this.replayExporting) return;
      this.replaySeekTarget = (e as CustomEvent).detail.frame as number;
    });
    window.addEventListener("replay:togglePlay", () => {
      if (!this.replayPlayer || this.replayExporting) return;
      this.replaySpeed = this.replaySpeed > 0 ? 0 : 1;
      window.dispatchEvent(new CustomEvent("replay:progress", {
        detail: { position: this.replayPlayer.position(), total: this.replayPlayer.total(), speed: this.replaySpeed },
      }));
    });
    window.addEventListener("replay:exit", () => {
      // Mid-export, exit means "abort the export" — the replay stays open.
      if (this.replayExporting) { cancelReplayExport(); return; }
      if (this.replayPlayer && this.highlightClip === null) exitReplay(this);
    });
    // Scrubber download button → offline MP4 export (or cancel if in flight).
    window.addEventListener("replay:download", () => {
      if (this.replayPlayer && this.highlightClip === null) toggleReplayExport(this);
    });
    // <FirstWaveHint> owns its own stage-3 auto-dismiss timer; when it fades
    //   out it asks the game to clear the stage.
    window.addEventListener("first-wave-hint:dismiss", () => {
      setFirstWaveHintStage(this, 0);
    });
    // stage 5 (build-to-4x) → stage 6 ("Become one with the Pulsar") closing flourish.
    window.addEventListener("first-wave-hint:advance", () => {
      if (this.firstWaveHintStage === 5) setFirstWaveHintStage(this, 6);
    });
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k === "m" && this.state !== "title") toggleMute(this);
      // Replay scrubbing: arrows jump ~2s, space toggles play. Handled here
      //   (not via game.input) because input is the recorded ReplayInput. Skipped
      //   for the game-over highlight clip — there Space/Enter mean "continue",
      //   handled by tickHighlightGameOverInput, and there's no scrubber.
      if (this.replayPlayer && this.highlightClip === null) {
        if (this.replayExporting) {
          // Export in flight: Escape aborts it; everything else is ignored so
          //   a stray seek can't fight the exporter's frame sweep.
          if (k === "escape") {
            e.preventDefault();
            cancelReplayExport();
          }
        } else {
          const SEEK_FRAMES = 120;
          if (k === "arrowleft" || k === "arrowright") {
            e.preventDefault();
            const dir = k === "arrowright" ? 1 : -1;
            const from = this.replaySeekTarget ?? this.replayPlayer.position();
            this.replaySeekTarget = from + dir * SEEK_FRAMES;
          } else if (k === " " || k === "spacebar") {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent("replay:togglePlay"));
          } else if (k === "escape") {
            e.preventDefault();
            exitReplay(this);
          }
        }
      }
      if (k === "`") {
        this.debugMode = !this.debugMode;
        this.debugOverlayEl.classList.toggle("hidden", !this.debugMode);
      }
    });
    showTitle(this);
  }

  // Fixed-resolution renderer: the sim always runs at LOGICAL_W x LOGICAL_H,
  //   and the canvas is CSS-scaled to the largest 16:9 box that fits the live
  //   window (centered, with black letterbox/pillar bars filling the rest).
  //   Backing store stays DPR-crisp. Replay locks to the recorded dims and
  //   uses the same fit-and-center math.
  resize() {
    const locked = this.replayLockedDims;
    if (locked) {
      this.w = locked.w;
      this.h = locked.h;
      this.dpr = locked.dpr;
    } else {
      this.dpr = window.devicePixelRatio || 1;
      this.w = LOGICAL_W;
      this.h = LOGICAL_H;
    }
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    const liveW = window.innerWidth;
    const liveH = window.innerHeight;
    const scale = Math.min(liveW / this.w, liveH / this.h);
    const cssW = this.w * scale;
    const cssH = this.h * scale;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "auto";
    this.canvas.style.left = `${(liveW - cssW) / 2}px`;
    this.canvas.style.top = `${(liveH - cssH) / 2}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.starfield) this.starfield.resize(this.w, this.h);
    if (this.pulsar) this.pulsar.resize(this.w, this.h);
  }

  // raw audio plays on `beatTime`; scoring + visual beat cues read this shifted
  //   clock so they coincide with the beat the player actually hears (see beatCalibration.ts).
  get perceivedBeatTime(): number { return this.beatTime - this.beatOffset; }

  update(dt: number) { updateGame(this, dt); }
  render() {
    // The exporter renders each stepped frame itself; a rAF repaint between
    //   its yields would only redraw the same state.
    if (this.replayExporting) return;
    renderGame(this);
    if (this.debugMode) this.renderDebugOverlay();
  }

  // Renders a per-frame snapshot of the baked-mp3 cache into #debug-overlay.
  // Groups keys by sound name with one row per group; trailing summary shows
  // overall loaded-vs-expected count so partial states are obvious at a glance.
  private renderDebugOverlay() {
    const states = this.sound.bakedLoadStates;
    if (states.size === 0) {
      this.debugOverlayEl.textContent = "audio cache: (waiting for first user gesture)";
      return;
    }
    const groups = new Map<string, { loaded: number; fetching: number; queued: number; failed: number; total: number }>();
    for (const [key, state] of states) {
      const name = key.split("|")[0];
      const g = groups.get(name) ?? { loaded: 0, fetching: 0, queued: 0, failed: 0, total: 0 };
      g.total++;
      g[state]++;
      groups.set(name, g);
    }
    const lines: string[] = ["audio cache:"];
    const sortedNames = Array.from(groups.keys()).sort();
    let totalLoaded = 0;
    let totalCount = 0;
    let anyFailed = false;
    for (const name of sortedNames) {
      const g = groups.get(name)!;
      totalLoaded += g.loaded;
      totalCount += g.total;
      if (g.failed > 0) anyFailed = true;
      const status = g.loaded === g.total
        ? "✓"
        : g.failed > 0
          ? `${g.loaded}/${g.total} (${g.failed} failed)`
          : `${g.loaded}/${g.total}`;
      lines.push(`  ${name.padEnd(10)} ${status}`);
    }
    const allDone = totalLoaded === totalCount && !anyFailed;
    lines.push(`  ────────────────`);
    lines.push(`  total      ${totalLoaded}/${totalCount}${allDone ? " ✓ ready" : anyFailed ? " ⚠ failures" : " …loading"}`);
    this.debugOverlayEl.textContent = lines.join("\n");
  }
}
