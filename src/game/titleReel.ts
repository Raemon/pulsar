import type { Game } from "../Game";
import { fetchReelCandidates, type HighscoreRow } from "./highscores";
import { fetchReplay } from "./replayApi";
import { decodeReplay, frameSecondsAfter, type ReplayPayload } from "./replayFormat";
import { ReplayPlayer } from "./replayPlayer";
import { pickLongestChain } from "./comboChains";
import { requestStart, resetTitleWorld, startTitleReelClip, teardownReplay } from "./lifecycle";
import { stepReplayFrame, spendReplayBudget } from "./gameUpdate";
import { tickLeaderboardKeyRepeat } from "./scoreEntry";

// The home screen's highlight reel: other pilots' best rhythm chains playing
//   behind the title, one clip at a time.
//
// Each clip is a real re-simulation of a stored replay — the same machinery the
//   leaderboard's "watch" button drives — windowed to one combo chain: from a
//   frame the pilot was at 0 rhythm, through the climb, to a beat past where the
//   streak broke. Chains come off the recording's own checkpoint samples
//   (comboChains.ts), so choosing a clip costs no simulation at all.
//
// What *does* cost: a replay is a pure input re-sim with no state snapshots, so
//   reaching frame N means stepping the sim from frame 0. The reel pays that
//   under a blackout veil, in small per-tick slices, so the title screen never
//   drops a frame while it catches up.

// Rhythm floor for a run to be worth showing. Below this the "chain" is a
//   couple of lucky hits rather than a groove.
const MIN_COMBO = 12;
// Clip windowing. The chain's own span decides the length; these only bound it
//   so one marathon streak can't hold the screen, and so a chain that reads as
//   a blip is skipped rather than shown as a flash.
const CLIP_MAX_SECONDS = 20;
const CLIP_MIN_SECONDS = 3.5;
// Play on a little past the frame the streak broke, so the clip ends on the
//   miss rather than cutting away mid-air.
const CLIP_TAIL_SECONDS = 1.5;
// Veil crossfade, matched by the #reel-veil CSS transition.
const FADE_MS = 650;
// Quiet beat on the plain title before the first clip, so the home screen
//   introduces itself before gameplay arrives.
const FIRST_CLIP_DELAY_MS = 2400;
// Beat of plain title between clips when the next one isn't loaded yet.
const IDLE_RETRY_MS = 1200;
// Per-tick slice of the catch-up re-sim. Comfortably inside a 60fps frame
//   budget alongside the title's own rendering.
const SEEK_BUDGET_MS = 10;
// How many recently-shown runs to keep off the wheel, so a small pool still
//   feels like a rotation rather than a loop of one.
const RECENT_MEMORY = 4;
// Consecutive failed clip loads before the reel gives up for this visit. An
//   empty board, an offline API or a pool of replays this build can't re-sim all
//   land here, and the title screen is perfectly good without a backdrop.
const MAX_LOAD_FAILURES = 3;

type Phase =
  // Plain title world on screen, waiting for the next clip (or its load).
  | "idle"
  // Veil fading to black over whatever is on screen.
  | "blackout"
  // Black: stepping the re-sim up to the clip's first frame.
  | "seeking"
  // Clip on screen.
  | "playing"
  // Veil fading back to black at the end of a clip.
  | "outro";

// A clip that has been fetched, decoded and windowed — everything needed to
//   start it except the (expensive) seek.
type LoadedClip = {
  row: HighscoreRow;
  payload: ReplayPayload;
  start: number;
  end: number;
  peak: number;
};

type TitleReel = {
  phase: Phase;
  // Wall-clock deadline for the current timed phase (blackout/outro/idle).
  until: number;
  clip: LoadedClip | null;
  next: LoadedClip | null;
  loading: boolean;
  candidates: HighscoreRow[] | null;
  recentIds: number[];
  // Clips play silent; the viewer's own audio setting is held here and handed
  //   back the moment the plain title world returns (or the reel stops), so the
  //   home screen is only ever muted while it is actually showing a clip.
  muted: boolean;
  soundWasEnabled: boolean;
  failures: number;
  // Set once the reel has given up (no replays to show, or the API is down):
  //   the state stays so the title screen keeps reporting itself as the title,
  //   but nothing more is fetched.
  stalled: boolean;
  // Bumped by stopTitleReel so a fetch still in flight can't install itself
  //   into a reel that has already been torn down (or a newer one).
  generation: number;
};

export type { TitleReel };

// True when the viewer is looking at the home screen — including while a reel
//   clip holds the sim in the "replaying" state.
export const isTitleScreen = (game: Game): boolean => game.state === "title" || game.titleReel !== null;

// True for a replay the viewer actually opened and can scrub, export or exit:
//   the leaderboard "watch" path. The game-over highlight clip and the title
//   reel also run in "replaying", but they're backdrops — the transport keys,
//   the scrubber and the MP4 exporter all stay out of their way.
export const isScrubbableReplay = (game: Game): boolean =>
  game.replayPlayer !== null && game.highlightClip === null && game.titleReel === null;

let generationCounter = 0;

const veilEl = (): HTMLElement | null => document.getElementById("reel-veil");
const captionEl = (): HTMLElement | null => document.getElementById("reel-caption");

const setVeilOpaque = (opaque: boolean) => veilEl()?.classList.toggle("opaque", opaque);

// A clip is a backdrop, not a performance: it plays silent. The viewer's own
//   setting is restored as soon as the clip is gone, so nothing else on the
//   title screen (the beat calibrator, a future title theme) is left muted by it.
const setReelMuted = (game: Game, reel: TitleReel, muted: boolean) => {
  if (muted === reel.muted) return;
  reel.muted = muted;
  if (muted) reel.soundWasEnabled = game.sound.beginSeekMute();
  else game.sound.endSeekMute(reel.soundWasEnabled);
};

const captionPart = (cls: string): HTMLElement | null =>
  captionEl()?.querySelector(`.${cls}`) as HTMLElement | null;

// Show (or hide) the credit under a clip: whose run it is, and how deep the
//   chain it is climbing toward goes. The markup is React's (ui/TitleReel.tsx);
//   this only fills it in.
const showCaption = (name: string, combo: number, peak: number) => {
  const pilot = captionPart("reel-caption-pilot");
  const peakEl = captionPart("reel-caption-peak");
  if (pilot) pilot.textContent = name;
  if (peakEl) peakEl.textContent = `peak ×${peak}`;
  syncCaptionCombo(combo);
  captionEl()?.classList.add("visible");
};

const hideCaption = () => captionEl()?.classList.remove("visible");

// Per-frame update of the live rhythm number as the chain climbs.
const syncCaptionCombo = (combo: number) => {
  const live = captionPart("reel-caption-live");
  if (live) live.textContent = `rhythm ×${combo}`;
};

// Weighted draw: a run's chance is its peak rhythm, so the deepest chains show
//   up most without the shallower ones ever being locked out. Runs shown in the
//   last few clips are skipped unless the pool is too small to afford it.
const sampleCandidate = (reel: TitleReel): HighscoreRow | null => {
  const pool = (reel.candidates ?? []).filter((r) => !reel.recentIds.includes(r.id));
  const rows = pool.length > 0 ? pool : (reel.candidates ?? []);
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) total += Math.max(1, row.max_combo);
  let roll = Math.random() * total;
  for (const row of rows) {
    roll -= Math.max(1, row.max_combo);
    if (roll <= 0) return row;
  }
  return rows[rows.length - 1];
};

// Window the replay's best chain into a clip. Null when the recording carries
//   no readable chain, or the chain is too short to be worth a cut.
const clipFromPayload = (row: HighscoreRow, payload: ReplayPayload): LoadedClip | null => {
  const chain = pickLongestChain(payload);
  if (!chain) return null;
  const total = payload.frames.length;
  const start = Math.min(chain.startFrame, total);
  const tailEnd = frameSecondsAfter(payload, chain.endFrame, CLIP_TAIL_SECONDS);
  const capped = frameSecondsAfter(payload, start, CLIP_MAX_SECONDS);
  const end = Math.min(Math.max(tailEnd, 0), capped, total);
  if (end <= start) return null;
  if (frameSecondsAfter(payload, start, CLIP_MIN_SECONDS) > end) return null;
  return { row, payload, start, end, peak: chain.peak };
};

// Fetch + decode + window one candidate into reel.next. One at a time: the
//   reel only ever needs the clip after the current one.
const loadNextClip = (game: Game) => {
  const reel = game.titleReel;
  if (!reel || reel.loading || reel.stalled || reel.next) return;
  reel.loading = true;
  const generation = reel.generation;
  // The world may have moved on (a run started, a leaderboard replay launched)
  //   while this was in flight — only touch the reel that asked for it.
  const stillMine = () => game.titleReel === reel && reel.generation === generation;
  void (async () => {
    try {
      if (reel.candidates === null) reel.candidates = await fetchReelCandidates(MIN_COMBO);
      const row = sampleCandidate(reel);
      const clip = row ? clipFromPayload(row, await decodeReplay(await fetchReplay(row.id))) : null;
      if (!stillMine()) return;
      if (clip) {
        reel.next = clip;
        reel.failures = 0;
      } else {
        reel.failures += 1;
      }
    } catch (err) {
      // A missing replay, a format this build can't re-sim, or an offline
      //   leaderboard all just mean "no reel" — the title screen behind it is
      //   perfectly fine on its own.
      console.warn(`[title reel] clip load failed: ${err instanceof Error ? err.message : String(err)}`);
      if (stillMine()) reel.failures += 1;
    } finally {
      if (stillMine()) {
        reel.loading = false;
        if (reel.failures >= MAX_LOAD_FAILURES) reel.stalled = true;
      }
    }
  })();
};

// A full-motion gameplay backdrop is exactly what this setting asks us not to
//   put behind a page. The title screen's own drifting asteroids stay.
const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Begin the reel on the title screen. Safe to call repeatedly; the first call
//   wins until stopTitleReel.
export const startTitleReel = (game: Game) => {
  if (game.titleReel) return;
  if (prefersReducedMotion()) return;
  generationCounter += 1;
  game.titleReel = {
    phase: "idle",
    until: performance.now() + FIRST_CLIP_DELAY_MS,
    clip: null,
    next: null,
    loading: false,
    candidates: null,
    recentIds: [],
    muted: false,
    soundWasEnabled: true,
    failures: 0,
    stalled: false,
    generation: generationCounter,
  };
  setVeilOpaque(false);
  hideCaption();
  loadNextClip(game);
};

// Stop the reel and give everything it borrowed back: the viewer's audio
//   setting, the live input, the canvas, and the title's own world in place of
//   whichever clip was holding it.
export const stopTitleReel = (game: Game) => {
  const reel = game.titleReel;
  if (!reel) return;
  // Invalidate in-flight loads before clearing, so a late resolve can't revive
  //   a dead reel.
  reel.generation = -1;
  setReelMuted(game, reel, false);
  game.titleReel = null;
  setVeilOpaque(false);
  hideCaption();
  document.body.classList.remove("reel-active");
  // A clip was holding the world: give the title its own back, so whatever
  //   comes next (a run, a leaderboard replay, a modal over the title) starts
  //   from the state the title screen normally has.
  if (game.replayPlayer) {
    teardownReplay(game);
    resetTitleWorld(game);
  }
  game.state = "title";
};

// Hand the title screen's own keys back while a clip holds the "replaying"
//   state: Enter/Space start a run, ↑/↓ walk the leaderboard. Read from the live
//   keyboard, since game.input is the recording's input during a clip. Returns
//   true when the press tore the reel down (caller must stop touching it).
const tickReelTitleInput = (game: Game, dt: number): boolean => {
  const live = game.localInput;
  const startPressed =
    live.pressed("enter") || live.pressed("return") || live.pressed(" ") || live.pressed("spacebar");
  if (startPressed) {
    live.endFrame();
    // requestStart stops the reel itself — it has to, before startGame rebuilds
    //   the world out from under the clip.
    requestStart(game);
    if (game.titleReel === null) return true;
  }
  // tickLeaderboardKeyRepeat reads game.input, which is the recording's input
  //   while a clip plays; point it at the live keyboard for the call.
  const recorded = game.input;
  game.input = live;
  tickLeaderboardKeyRepeat(game, dt);
  game.input = recorded;
  // The replay input's endFrame runs inside the sim step; the live one has no
  //   other owner while a clip plays, so clear its just-pressed latch here.
  live.endFrame();
  return false;
};

// Put the plain title world back on screen between clips (no clip ready, or a
//   load failed). showTitle is not reused here: it would re-render the whole
//   overlay and re-fetch the leaderboard every cycle.
const returnToTitleWorld = (game: Game, reel: TitleReel) => {
  setReelMuted(game, reel, false);
  if (game.replayPlayer) teardownReplay(game);
  resetTitleWorld(game);
  hideCaption();
  document.body.classList.remove("reel-active");
  setVeilOpaque(false);
};

const beginClip = (game: Game, reel: TitleReel) => {
  const clip = reel.clip;
  if (!clip) return;
  const player = new ReplayPlayer(clip.payload);
  // A clip is a backdrop: a re-sim that drifts from the recording costs a less
  //   impressive chain, not a wrong result worth logging on every frame.
  player.logDivergences = false;
  startTitleReelClip(game, player);
  reel.phase = "seeking";
};

// Step the re-sim toward the clip's first frame in one bounded slice. Returns
//   true once the playhead has arrived (or the stream ran out).
const tickSeek = (game: Game, clip: LoadedClip): boolean => {
  const player = game.replayPlayer;
  if (!player) return true;
  const deadline = performance.now() + SEEK_BUDGET_MS;
  while (player.position() < clip.start) {
    if (!stepReplayFrame(game)) return true;
    if (performance.now() >= deadline) return false;
  }
  return true;
};

const endClip = (game: Game, reel: TitleReel) => {
  setVeilOpaque(true);
  hideCaption();
  reel.phase = "outro";
  reel.until = performance.now() + FADE_MS;
  // Line the next one up while the fade runs.
  loadNextClip(game);
};

// One render tick of the reel. Driven from updateTitle while the plain title
//   world is up, and from runReplay while a clip holds the "replaying" state —
//   the same two-homes arrangement the game-over highlight clip uses.
export const tickTitleReel = (game: Game, liveDt: number) => {
  const reel = game.titleReel;
  if (!reel) return;
  // A clip is driving the sim: the title screen's own keys live here.
  if (game.replayPlayer && tickReelTitleInput(game, liveDt)) return;
  const now = performance.now();

  if (reel.phase === "idle") {
    if (reel.stalled) return;
    if (!reel.next) loadNextClip(game);
    if (now < reel.until || !reel.next) return;
    reel.clip = reel.next;
    reel.next = null;
    setReelMuted(game, reel, true);
    // Mark the body now, not when the clip appears: the run-facing chrome (HUD,
    //   first-wave hints) fades out together with the backdrop instead of
    //   popping away the moment gameplay arrives.
    document.body.classList.add("reel-active");
    setVeilOpaque(true);
    reel.phase = "blackout";
    reel.until = now + FADE_MS;
    return;
  }

  if (reel.phase === "blackout") {
    if (now < reel.until) return;
    beginClip(game, reel);
    return;
  }

  if (reel.phase === "seeking") {
    const clip = reel.clip;
    if (!clip) { reel.phase = "idle"; reel.until = now; return; }
    if (!tickSeek(game, clip)) return;
    reel.phase = "playing";
    showCaption(clip.row.name, game.beatCombo, clip.peak);
    setVeilOpaque(false);
    return;
  }

  if (reel.phase === "playing") {
    const clip = reel.clip;
    if (!clip) { endClip(game, reel); return; }
    const outcome = spendReplayBudget(game, liveDt, clip.end);
    syncCaptionCombo(game.beatCombo);
    // Pull the next clip's bytes while this one plays, so the gap between them
    //   is only the catch-up seek.
    if (!reel.next) loadNextClip(game);
    if (outcome !== "running") endClip(game, reel);
    return;
  }

  // "outro": black again — straight into the next clip if it's ready, otherwise
  //   back to the plain title world until one is.
  if (now < reel.until) return;
  if (reel.clip) {
    reel.recentIds = [...reel.recentIds, reel.clip.row.id].slice(-RECENT_MEMORY);
    reel.clip = null;
  }
  if (reel.next) {
    reel.clip = reel.next;
    reel.next = null;
    beginClip(game, reel);
    return;
  }
  returnToTitleWorld(game, reel);
  reel.phase = "idle";
  reel.until = now + IDLE_RETRY_MS;
};
