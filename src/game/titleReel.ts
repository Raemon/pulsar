import type { Game } from "../Game";
import { fetchReelCandidates, type HighscoreRow } from "./highscores";
import { fetchReplay } from "./replayApi";
import { REPLAY_FORMAT_VERSION, decodeReplay, frameSecondsAfter, frameSecondsBefore, secondsBetweenFrames, type ReplayPayload } from "./replayFormat";
import { ReplayPlayer } from "./replayPlayer";
import { pickLongestChain } from "./comboChains";
import { requestStart, resetTitleWorld, startTitleReelClip, teardownReplay } from "./lifecycle";
import { stepReplayFrame, spendReplayBudget } from "./gameUpdate";
import { tickLeaderboardKeyRepeat } from "./scoreEntry";
import { syncHud } from "./hud";

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
//
//   The ceiling is a backstop, not a pacing knob. Rhythm climbs a point every
//   few seconds, so the chains that qualify for the reel take a minute or two
//   to reach their peak: a ceiling shorter than that cuts every clip partway
//   up, before the rhythm that earned it a place here is ever on screen.
const CLIP_MAX_SECONDS = 180;
// Every clip costs a fade out, a catch-up seek and a fade in, so a clip should
//   be worth that gap. A brisk climb to 12 can take only four or five seconds,
//   though — rather than refuse those, the window opens earlier and shows the
//   pilot flying into the chain, the way the game-over clip's pre-roll does.
const CLIP_MIN_SECONDS = 6;
// Below this there isn't enough recording left around the chain to pad with, so
//   there is genuinely nothing to show.
const CLIP_FLOOR_SECONDS = 2.5;
// Play on a little past the frame the streak broke, so the clip ends on the
//   miss rather than cutting away mid-air.
const CLIP_TAIL_SECONDS = 1.5;
// Veil crossfade, matched by the #reel-veil CSS transition.
const FADE_MS = 650;
// Quiet beat on the plain title before the first clip, so a first-time visitor
//   has read the title before the screen fades under them.
const FIRST_CLIP_DELAY_MS = 4500;
// Beat of plain title between clips when the next one isn't loaded yet.
const IDLE_RETRY_MS = 1200;
// Per-tick slice of the catch-up re-sim. Nothing but a static title is being
//   rendered while this runs (the veil is opaque), so it can take most of a
//   60fps frame: the gap between clips is dead screen, and shortening it is
//   worth more than headroom nobody is using. Not the whole frame, though — the
//   title's own animations still have to run.
const SEEK_BUDGET_MS = 12;
// How many recently-shown runs to keep off the wheel, so a small pool still
//   feels like a rotation rather than a loop of one.
const RECENT_MEMORY = 4;
// Give up on a clip whose catch-up is taking too long (a chain very deep into a
//   long run on a slow machine). The gap between clips is dead screen — but a
//   gap that ends in a clip beats one that ends in nothing, so this is generous:
//   it is a backstop against a seek that will never arrive, not a pacing knob.
const MAX_SEEK_MS = 12000;
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
};

type TitleReel = {
  phase: Phase;
  // Wall-clock deadline for the current timed phase (blackout/outro/idle).
  until: number;
  clip: LoadedClip | null;
  next: LoadedClip | null;
  // performance.now() at which the current catch-up seek began.
  seekStartedAt: number;
  // The HUD the title screen had before the reel borrowed the world. A clip
  //   drives score/wave/lives from someone else's run, and those numbers must
  //   not be what fades back in when the plain title returns.
  hud: { score: number; wave: number; lives: number } | null;
  loading: boolean;
  candidates: HighscoreRow[] | null;
  recentIds: number[];
  // Runs that can't be shown: no chain worth cutting, or a chain too deep into
  //   the run to catch up to in time. Unlike recentIds these are out for the
  //   visit: nothing about them will change, and re-drawing them (the sampler
  //   favours exactly these — they're the deepest runs) would stall the reel on
  //   the same handful of rows.
  unusableIds: number[];
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

// `reel-visible` is the backdrop's "gameplay is actually on screen" state: it
//   re-balances the overlay for a moving background. It is NOT the inverse of
//   the veil — the plain title between clips has neither the veil nor this —
//   so the heavier plates never sit as boxes on the flat gap.
const setClipOnScreen = (onScreen: boolean) =>
  document.body.classList.toggle("reel-visible", onScreen);

// The plain title: no shutter, no gameplay treatment.
const clearReelBackdrop = () => {
  setVeilOpaque(false);
  setClipOnScreen(false);
};

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

// The live rhythm number is rewritten every frame of a clip; hold the node
//   rather than walking the DOM for it 60 times a second. React owns the markup
//   and never re-renders it, but re-resolve on each clip start anyway.
let liveComboEl: HTMLElement | null = null;

// Credit the run on screen. The markup is React's (ui/TitleReel.tsx); this only
//   fills it in. The chain's peak is left out on purpose — see TitleReel.tsx.
const showCaption = (name: string, combo: number) => {
  const pilot = captionPart("reel-caption-pilot");
  if (pilot) pilot.textContent = name;
  liveComboEl = captionPart("reel-caption-live");
  syncCaptionCombo(combo);
  captionEl()?.classList.add("visible");
};

const hideCaption = () => captionEl()?.classList.remove("visible");

// Per-frame update of the live rhythm number as the chain climbs.
const syncCaptionCombo = (combo: number) => {
  if (liveComboEl) liveComboEl.textContent = `rhythm ×${combo}`;
};

// Runs recently shown go to the back of the queue, so a small pool still feels
//   like a rotation rather than a loop.
const rememberShown = (reel: TitleReel, id: number) => {
  reel.recentIds = [...reel.recentIds.filter((n) => n !== id), id].slice(-RECENT_MEMORY);
};

const retireRun = (reel: TitleReel, id: number) => {
  reel.unusableIds = [...reel.unusableIds, id];
};

// Weighted draw: a run's chance is its peak rhythm, so the deepest chains show
//   up most without the shallower ones ever being locked out. Runs shown in the
//   last few clips are skipped unless the pool is too small to afford it.
const sampleCandidate = (reel: TitleReel): HighscoreRow | null => {
  const usable = (reel.candidates ?? []).filter((r) => !reel.unusableIds.includes(r.id));
  const fresh = usable.filter((r) => !reel.recentIds.includes(r.id));
  const rows = fresh.length > 0 ? fresh : usable;
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

// Window the replay's best chain into a clip: from a frame the pilot was at 0
//   rhythm, through the climb, to a beat past the break — with a pre-roll in
//   front if the chain alone is too brief to be worth the cut. Null when the
//   recording carries no readable chain, or there isn't enough of it to show.
const clipFromPayload = (row: HighscoreRow, payload: ReplayPayload): LoadedClip | null => {
  const chain = pickLongestChain(payload);
  if (!chain) return null;
  const total = payload.frames.length;
  const chainStart = Math.min(chain.startFrame, total);
  const tailEnd = frameSecondsAfter(payload, chain.endFrame, CLIP_TAIL_SECONDS);
  const capped = frameSecondsAfter(payload, chainStart, CLIP_MAX_SECONDS);
  const end = Math.min(Math.max(tailEnd, 0), capped, total);
  if (end <= chainStart) return null;
  // Measured against the recorded frame times, not inferred from a frame count:
  //   a chain that primes near the end of the recording clamps to the same last
  //   frame on both sides, and would otherwise pass as "long enough".
  const chainSeconds = secondsBetweenFrames(payload, chainStart, end);
  const start = chainSeconds >= CLIP_MIN_SECONDS
    ? chainStart
    : frameSecondsBefore(payload, chainStart, CLIP_MIN_SECONDS - chainSeconds);
  if (secondsBetweenFrames(payload, start, end) < CLIP_FLOOR_SECONDS) return null;
  return { row, payload, start, end };
};

// The reel declining to play is not an error, but it is invisible — and the
//   reasons it declines (nothing on the board qualifies, a replay this build
//   can't re-sim, a chain too short to cut) are exactly what someone wondering
//   "why is there no reel?" needs. One line, once, naming the reason.
let lastNote = "not started";
const reelNote = (message: string) => {
  lastNote = message;
  console.info(`[title reel] ${message}`);
};

// One line for the debug overlay (backtick): what the reel is doing, or the
//   reason it is doing nothing. The console says the same thing, but a reel that
//   declines does so once, on load, and is easy to miss.
export const titleReelStatus = (game: Game): string => {
  const reel = game.titleReel;
  if (!reel) return `title reel: off — ${lastNote}`;
  const pool = reel.candidates?.length ?? 0;
  const phase = reel.stalled ? "stalled" : reel.phase;
  return `title reel: ${phase} — ${pool} run(s), ${reel.unusableIds.length} unusable — ${lastNote}`;
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
      if (reel.candidates === null) {
        reel.candidates = await fetchReelCandidates(MIN_COMBO);
        if (!stillMine()) return;
        reelNote(
          reel.candidates.length > 0
            ? `${reel.candidates.length} run(s) to draw from.`
            : `no run on the board has both a saved replay from this build ` +
              `(format v${REPLAY_FORMAT_VERSION}) and ${MIN_COMBO}+ rhythm — nothing to play.`,
        );
      }
      const row = sampleCandidate(reel);
      if (!row) {
        // Nothing left to draw: every candidate has been tried and none of them
        //   yields a clip. (An empty board already said so above.)
        reel.stalled = true;
        if (reel.candidates.length > 0) reelNote("every run on the board has been tried — stopping.");
        return;
      }
      const clip = clipFromPayload(row, await decodeReplay(await fetchReplay(row.id)));
      if (!stillMine()) return;
      if (!clip) {
        retireRun(reel, row.id);
        reelNote(`${row.name}'s run (#${row.id}) has no chain to cut — skipping it.`);
        return;
      }
      rememberShown(reel, row.id);
      reel.next = clip;
      reel.failures = 0;
    } catch (err) {
      // A missing replay, a format this build can't re-sim, or an offline
      //   leaderboard all just mean "no reel" — the title screen behind it is
      //   perfectly fine on its own.
      console.warn(`[title reel] clip load failed: ${err instanceof Error ? err.message : String(err)}`);
      if (stillMine()) reel.failures += 1;
    } finally {
      if (stillMine()) {
        reel.loading = false;
        if (reel.failures >= MAX_LOAD_FAILURES && !reel.stalled) {
          reel.stalled = true;
          reelNote("giving up for this visit — the title screen runs without it.");
        }
      }
    }
  })();
};

// A full-motion gameplay backdrop is exactly what this setting asks us not to
//   put behind a page. The title screen's own drifting asteroids stay.
const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// A recording is a 16:9 world, letterboxed into whatever window is watching. On
//   a portrait phone that leaves a band of gameplay a few hundred pixels tall
//   between two black fields — a seam, not a backdrop — and it would re-simulate
//   a whole run on a battery for it. Those visitors get the plain title.
const MIN_REEL_ASPECT = 1.1;
const viewportTooNarrow = (): boolean => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Unknown dimensions (a headless harness, a stubbed window) are not narrow —
  //   the reel's other guards cover those cases on their own.
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return false;
  return w / h < MIN_REEL_ASPECT;
};

// Begin the reel on the title screen. Safe to call repeatedly; the first call
//   wins until stopTitleReel.
export const startTitleReel = (game: Game) => {
  if (game.titleReel) return;
  lastNote = "looking for a run to play";
  if (prefersReducedMotion()) { reelNote("skipped: the browser asks for reduced motion."); return; }
  if (viewportTooNarrow()) { reelNote("skipped: a 16:9 clip has nowhere to go in a portrait window."); return; }
  generationCounter += 1;
  game.titleReel = {
    phase: "idle",
    until: performance.now() + FIRST_CLIP_DELAY_MS,
    clip: null,
    next: null,
    seekStartedAt: 0,
    hud: null,
    loading: false,
    candidates: null,
    recentIds: [],
    unusableIds: [],
    muted: false,
    soundWasEnabled: true,
    failures: 0,
    stalled: false,
    generation: generationCounter,
  };
  clearReelBackdrop();
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
  reel.clip = null;
  document.body.classList.remove("reel-active");
  returnToTitleWorld(game, reel);
  syncHud(game);
  game.titleReel = null;
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
    // requestStart stops the reel itself, once the audio context is up and the
    //   run is actually about to start — so the clip keeps playing through that
    //   wait rather than cutting to a dead screen.
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

// Hand the HUD back the numbers the title screen had before a clip drove them
//   from a stranger's run — otherwise the board's top pilot's score and lives
//   fade in over the home screen as if they were the viewer's.
const restoreTitleHud = (game: Game, reel: TitleReel) => {
  if (!reel.hud) return;
  game.score = reel.hud.score;
  game.wave = reel.hud.wave;
  game.lives = reel.hud.lives;
  reel.hud = null;
  // The HUD stays hidden (body.reel-active) until the reel stops altogether, so
  //   the numbers are not re-synced here — stopTitleReel does it, on the one
  //   path where the HUD becomes visible again without a run resetting it.
};

// Put the plain title world back on screen: between clips (no clip ready, or a
//   load failed), and as the last step of stopping the reel altogether. showTitle
//   is not reused here — it would re-render the whole overlay and re-fetch the
//   leaderboard every cycle.
const returnToTitleWorld = (game: Game, reel: TitleReel) => {
  setReelMuted(game, reel, false);
  if (game.replayPlayer) teardownReplay(game);
  resetTitleWorld(game);
  restoreTitleHud(game, reel);
  hideCaption();
  clearReelBackdrop();
};

const beginClip = (game: Game, reel: TitleReel) => {
  const clip = reel.clip;
  if (!clip) return;
  reel.hud ??= { score: game.score, wave: game.wave, lives: game.lives };
  const player = new ReplayPlayer(clip.payload);
  // A clip is a backdrop: a re-sim that drifts from the recording costs a less
  //   impressive chain, not a wrong result worth logging on every frame.
  player.logDivergences = false;
  startTitleReelClip(game, player);
  reel.phase = "seeking";
  reel.seekStartedAt = performance.now();
};

// Give up on the clip being sought and go back to the plain title. The run is
//   retired rather than sent to the back of the queue: its chain is no nearer
//   next time, and in a pool small enough to come straight back round to it the
//   home screen would spend the visit going dark for a clip that never arrives.
const abandonClip = (game: Game, reel: TitleReel) => {
  if (reel.clip) {
    reelNote(
      `${reel.clip.row.name}'s run (#${reel.clip.row.id}) is taking too long to catch up to ` +
      `(frame ${reel.clip.start}) — skipping it.`,
    );
    retireRun(reel, reel.clip.row.id);
  }
  reel.clip = null;
  hideCaption();
  returnToTitleWorld(game, reel);
  reel.phase = "idle";
  reel.until = performance.now() + IDLE_RETRY_MS;
};

// Step the re-sim toward the clip's first frame in one bounded slice. Returns
//   true once the playhead has arrived (or the stream ran out).
//
//   replayFastForwarding is what tells the rest of the game that these frames
//   are catch-up, not playback: without it the burst crosses wave boundaries and
//   schedules wave summaries, wave announcements and pilot-log cues against a
//   wall clock that has nothing to do with where the clip actually starts. The
//   two pre-existing burst-seek paths (seekReplayToTarget, the rhythm
//   precompute) bracket their loops the same way.
const tickSeek = (game: Game, clip: LoadedClip): boolean => {
  const player = game.replayPlayer;
  if (!player) return true;
  const deadline = performance.now() + SEEK_BUDGET_MS;
  game.replayFastForwarding = true;
  try {
    while (player.position() < clip.start) {
      if (!stepReplayFrame(game)) return true;
      if (performance.now() >= deadline) return false;
    }
    return true;
  } finally {
    game.replayFastForwarding = false;
  }
};

const endClip = (game: Game, reel: TitleReel) => {
  setVeilOpaque(true);
  setClipOnScreen(false);
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
    // Marked once, for the whole reel: the run-facing chrome (HUD, first-wave
    //   hints) fades out with the first blackout and stays away until the reel
    //   stops, instead of flashing a stranger's score between clips.
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
    if (!tickSeek(game, clip)) {
      // Taking too long to reach the chain: drop this one rather than hold the
      //   home screen on a black frame while it catches up.
      if (now - reel.seekStartedAt > MAX_SEEK_MS) abandonClip(game, reel);
      return;
    }
    reel.phase = "playing";
    showCaption(clip.row.name, game.beatCombo);
    setClipOnScreen(true);
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
    rememberShown(reel, reel.clip.row.id);
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
