import type { Game } from "../Game";
import { frameSecondsBefore, type ReplayPayload } from "./replayFormat";
import type { ReplayRecorder } from "./replayRecorder";
import { ReplayPlayer } from "./replayPlayer";
import { pickHighlightChain } from "./highlightTimeline";
import { startHighlightReplay, showTitle, teardownReplay } from "./lifecycle";
import { hideScoreEntry, isScoreEntryBlockingEnter } from "./scoreEntry";

// Master switch for the game-over highlight clip. The replay re-sim isn't yet
//   reliable enough to ship, so game-over falls back to the trophy parade. Flip
//   to true to restore the replay-on-gameover screen — the infra below is intact.
const HIGHLIGHT_CLIP_ON_GAMEOVER = false;

// Seconds of run shown before the chain's priming fire — the "wind-up" the spec
//   asks for so the highlight starts a beat or two before the player's first shot.
const PRE_ROLL_SECONDS = 4;
// A clip needs to be long enough to read. If the picked chain is razor-thin
//   (instant prime-then-lose), the 4s pre-roll still gives it body, but guard
//   against a zero-length range from bad data.
const MIN_CLIP_FRAMES = 2;

// Attempt to start the game-over highlight clip: the highest-rhythm chain of the
//   just-finished run, from 4s before its priming fire to the frame rhythm was
//   lost, looping. Returns false when no usable highlight exists (no recorder, no
//   chain reaching ≥2, or a degenerate range) — the caller falls back to the parade.
//   game.runSummary must already be snapshotted by the caller, since starting the
//   clip rebuilds the world and resets game.score/maxCombo/lastRunReplay.
//   The recorder is passed in (not read off game.recorder) because the caller has
//   already finalised it — finalize nulls game.recorder but keeps the instance,
//   whose in-memory frames the clip re-sims.
export const tryStartHighlightClip = (game: Game, recorder: ReplayRecorder | null): boolean => {
  if (!HIGHLIGHT_CLIP_ON_GAMEOVER) return false;
  if (!recorder || recorder.frameCount() === 0) return false;
  const chain = pickHighlightChain(game.highlightTimeline.chains);
  if (!chain) return false;

  const summary = game.runSummary;
  let payload: ReplayPayload;
  try {
    payload = recorder.buildPayload({
      score: summary?.score ?? game.score,
      wave: summary?.wave ?? game.wave,
      maxCombo: summary?.maxCombo ?? game.maxCombo,
      killCount: Object.values(summary?.killTally ?? game.killTally).reduce((s, n) => s + n, 0),
    });
  } catch {
    return false;
  }

  const totalFrames = payload.frames.length;
  if (totalFrames === 0) return false;

  const start = frameSecondsBefore(payload, chain.startFrame, PRE_ROLL_SECONDS);
  // Chain never broke (held rhythm until death) → run the clip to the last
  //   recorded frame. Clamp the end inside the recording either way.
  const rawEnd = chain.lostFrame ?? totalFrames;
  const end = Math.min(rawEnd, totalFrames);
  if (end - start < MIN_CLIP_FRAMES) return false;

  try {
    const player = new ReplayPlayer(payload);
    startHighlightReplay(game, player, { start, end });
  } catch {
    game.highlightClip = null;
    return false;
  }
  return true;
};

// Fade duration each direction — matches the #highlight-fade CSS transition so
//   the class toggle and our timer agree on when black is fully reached.
const FADE_MS = 280;

const fadeEl = (): HTMLElement | null => document.getElementById("highlight-fade");

// Clip reached its end frame: kick off the fade-out. The actual rewind happens
//   once the screen is black (in tickHighlightLoop), so the synchronous hitch is
//   hidden. Audio is left to ring out under the fade.
export const beginHighlightLoop = (game: Game) => {
  if (!game.highlightClip) return;
  game.replayStepAccumulator = 0;
  game.highlightLoop = { phase: "fadeOut", startedAt: performance.now() };
  fadeEl()?.classList.add("fading");
};

// Advance the loop's fade cycle. seekToTarget is gameUpdate's seekReplayToTarget
//   (passed in to avoid an import cycle) — it rebuilds the world at frame 0 and
//   fast-forwards muted to the clip start. Run only while the screen is black so
//   its synchronous catch-up is invisible.
export const tickHighlightLoop = (game: Game, seekToTarget: (game: Game) => void) => {
  const loop = game.highlightLoop;
  const clip = game.highlightClip;
  if (!loop || !clip) return;
  const elapsed = performance.now() - loop.startedAt;
  if (loop.phase === "fadeOut") {
    if (elapsed < FADE_MS) return;
    // Screen is black now: do the (synchronous, muted) rewind to the clip start.
    game.replaySpeed = 1;
    game.replaySeekTarget = clip.start;
    seekToTarget(game);
    // Begin fading back in from the first clip frame.
    game.highlightLoop = { phase: "fadeIn", startedAt: performance.now() };
    fadeEl()?.classList.remove("fading");
    return;
  }
  // fadeIn: once transparent again, hand back to normal clip playback.
  if (elapsed >= FADE_MS) game.highlightLoop = null;
};

// Tear down the highlight replay and return to title. The clip runs in the
//   "replaying" state with input swapped to the ReplayInput and the canvas locked
//   to the recording's dims; undo both before showTitle so the title screen runs
//   live again. Mirrors finishReplay's cleanup (which the looping clip never hits).
const exitHighlightToTitle = (game: Game) => {
  game.highlightClip = null;
  game.highlightLoop = null;
  fadeEl()?.classList.remove("fading");
  teardownReplay(game);
  game.killedSnapshots = [];
  showTitle(game);
};

// While the highlight clip plays on the game-over screen, the game-over state
//   handler (updateGameOver) doesn't run — so its Enter-to-continue / Escape-to-
//   skip handling is mirrored here, reading the LIVE keyboard (game.localInput),
//   not the replay's recorded input. Called once per render tick from runReplay.
//   Returns true when it exited to title (caller should stop touching the clip).
export const tickHighlightGameOverInput = (game: Game): boolean => {
  const live = game.localInput;
  // Escape dismisses the score-entry form so Enter can then restart. Read the
  //   live key directly: wasPressed resolves against the recording's bindings
  //   while the clip is up, which would match the wrong key.
  if (live.pressed("escape")) hideScoreEntry(game);
  const startPressed =
    live.pressed("enter") || live.pressed("return") || live.pressed(" ") || live.pressed("spacebar");
  if (startPressed && !isScoreEntryBlockingEnter(game)) {
    // Clear the latched press before tearing down — the live input's endFrame()
    //   isn't called during replay, so justPressed would otherwise persist.
    live.endFrame();
    exitHighlightToTitle(game);
    return true;
  }
  // Live input's justPressed is normally cleared by advanceFrame's endFrame() on
  //   the *replay* input; clear the live one here so presses don't latch.
  live.endFrame();
  return false;
};
