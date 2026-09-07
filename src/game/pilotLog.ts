import type { Game } from "../Game";
import { BEAT_GRID } from "./rhythmConstants";
import { markPilotLogHeard, shouldPlayPilotLog } from "./sessionTracker";

// Pilot's Log unlocks fire at specific combo milestones (x6, x12). Each
// milestone has its own random pool of takes under /sounds/vocals/in-use/<n>x/.
// playPilotLog takes the milestone number directly.
//
// Cadence: vocals are aligned to the next downbeat (every 2s = 4 beats) so
// the spoken line lands on the pad melody's phrase grid instead of floating
// in between bass hits.
const DOWNBEAT_SECONDS = BEAT_GRID * 4;

// Snap forward to the next downbeat boundary. Returns the delay in seconds.
const nextDownbeatDelay = (beatTime: number): number => {
  const phase = beatTime % DOWNBEAT_SECONDS;
  return phase === 0 ? 0 : DOWNBEAT_SECONDS - phase;
};

// Fade the chapter title in over the canvas. Inner <span> carries the
// scaleX squeeze (matches the main-menu title); outer element does the
// fade so the two transforms don't compose into a moving target.
const showUnlockToast = (label: string) => {
  let el = document.getElementById("pilot-log-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "pilot-log-toast";
    const inner = document.createElement("span");
    el.appendChild(inner);
    document.body.appendChild(el);
  }
  const inner = el.firstElementChild as HTMLSpanElement;
  inner.textContent = label;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  window.setTimeout(() => { el?.classList.remove("show"); }, 5000);
};

// Vocals are rationed on the same 4h window as the intro's full-hint triplet:
//   a line the player already heard this session stays quiet on every later run
//   until the session lapses (see sessionTracker). Replay playback is exempt —
//   playPilotLog draws its take from the shared cosmetic RNG stream, so
//   skipping the call on one viewer's machine and not another's would drift
//   every downstream cosmetic draw in the re-sim.
const allowLogVocal = (game: Game, milestone: number): boolean =>
  game.state === "replaying" || shouldPlayPilotLog(milestone);

// Schedule the vocal on the next downbeat and hold the mutex for its duration.
const playLogVocal = (game: Game, milestone: number) => {
  if (!allowLogVocal(game, milestone)) return;
  if (game.state !== "replaying") markPilotLogHeard(milestone);
  game.sound.pilotLogPlaying = true;
  const delay = nextDownbeatDelay(game.beatTime);
  game.sound.playPilotLog(milestone, delay, 1.0).then((dur) => {
    window.setTimeout(() => { game.sound.pilotLogPlaying = false; }, (delay + dur + 0.5) * 1000);
  });
};

// Fire the combo-x6 unlock: HUD toast immediately, vocal cue on the next
// downbeat so it locks to the pad's phrase grid. Guarded so a stutter at the
// threshold can't re-trigger the line mid-playback.
// The fast-forward check must come before the unlocked-flag check: a replay
//   seek/precompute sweep crossing x6 would otherwise latch the flag and
//   permanently skip the toast/vocal for the rest of that viewing, even once
//   real playback later reaches the milestone on its own.
export const tryUnlockPilotLog1 = (game: Game) => {
  if (game.replayFastForwarding) return;
  if (game.pilotLog1Unlocked) return;
  if (game.beatCombo < 6) return;
  game.pilotLog1Unlocked = true;
  showUnlockToast("Chapter 1: The Outer Rim");
  // Toast still fires every run — only the vocal is rationed to once a session.
  playLogVocal(game, 6);
};

// Combo x12: Pilot's Log Entry 3. Same downbeat-snap as Entry 1, but no HUD
// toast — the captain just starts talking. pilotLogPlaying mutex prevents
// stacking on top of Entry 1 if the player blew through 6 -> 12 fast enough
// that Entry 1 is still mid-playback; in that case the unlock latches and the
// player has to hit x12 again to hear it. Acceptable: the trigger gates on
// flag *and* mutex so retrying is allowed until it actually plays.
export const tryUnlockPilotLog3 = (game: Game) => {
  if (game.replayFastForwarding) return;
  if (game.pilotLog3Unlocked) return;
  if (game.beatCombo < 12) return;
  // Muted-this-session latches straight away: there's no playback to wait on,
  // so the mutex retry below would just re-check forever.
  if (!allowLogVocal(game, 12)) {
    game.pilotLog3Unlocked = true;
    return;
  }
  if (game.sound.pilotLogPlaying) return;
  game.pilotLog3Unlocked = true;
  playLogVocal(game, 12);
};
