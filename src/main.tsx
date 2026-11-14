import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./style.css";

import { Game } from "./Game";
import { loadSoundConfig } from "./soundConfig";
import { installBetaTest } from "./game/betaTest";
import { installInstructionsDemos } from "./instructions";
import { initAuth } from "./game/auth";
import { initAcquisition } from "./game/acquisitionEvents";

initAcquisition();

// Mount React first and force a synchronous commit so the HUD/Overlay
// markup is on the page before bindHudElements() runs inside `new Game()`.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("React root #root not found");
const root = createRoot(rootEl);
flushSync(() => {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
if (!canvas) throw new Error("Canvas #stage not found");

// Pull /sounds/config.json before any audio fires so cfgN() returns tuned
// values from the very first shot. We don't block boot on this — if the
// fetch fails, sounds fall back to hardcoded defaults inside Sound.ts.
loadSoundConfig();

// Restore any cached Google session and warm the sign-in client so the
//   score-entry form can offer callsign claiming without a load hitch.
initAuth();

const game = new Game(canvas);
(window as any).__game = game;
// Console hook: replay the most recently completed run without round-tripping
//   through the leaderboard. Useful for debugging replay determinism — record
//   a run, die, then call __replayLast() from devtools. Tracker-style sim-state
//   checkpoints assert automatically during any replay (no __replayDebug needed)
//   and log "[replay] checkpoint divergence at frame N" with the drifted fields.
(window as any).__replayLast = async () => {
  if (!game.lastRunReplay) { console.warn("no replay bytes yet — finish a run first"); return; }
  const { startReplay } = await import("./game/lifecycle");
  await startReplay(game, game.lastRunReplay);
};
// Inspect the live replay's accumulated checkpoint divergences (the precompute
//   sweep also stashes its own snapshot at window.__replayDivergences). Empty
//   array = no desync detected so far; null = no replay running.
(window as any).__divergences = () => game.replayPlayer?.divergences ?? null;
// Verification hook for the offline exporter's audio path: capture + render
//   the currently-open replay's soundtrack and download it as a WAV, for
//   by-ear A/B against live replay playback.
(window as any).__exportReplayAudio = async () => {
  const { exportReplayAudioWav } = await import("./game/videoExport");
  await exportReplayAudioWav(game);
};
installBetaTest(game);
installInstructionsDemos();

let last = performance.now();
// Anchor the sim clock to the AudioContext hardware clock whenever audio is running, so beatTime
// (and the on-beat hum/bass scheduling that rides it) stays locked to the looping music instead
// of slowly drifting against it the way performance.now() does over a long run. Falls back to
// performance.now() before audio starts or while the context is suspended. lastAudio is the
// previous frame's audio-clock reading (null when audio wasn't running last frame).
let lastAudio: number | null = null;
// Rolling FPS — count frames over a window then publish; cheaper than smoothing per-frame dts.
const FPS_WINDOW_MS = 500;
let fpsWindowStart = last;
let fpsFrames = 0;
const tick = (now: number) => {
  const audioNow = game.sound.runningAudioTime();
  // 50ms clamp guards physics from a huge step after a stall/background, on either clock.
  const usedAudioClock = audioNow !== null && lastAudio !== null && audioNow > lastAudio;
  const dt = usedAudioClock
    ? Math.min(audioNow! - lastAudio!, 0.05)
    : Math.min((now - last) / 1000, 0.05);
  lastAudio = audioNow;
  last = now;
  game.update(dt);
  game.render();
  fpsFrames++;
  const windowElapsed = now - fpsWindowStart;
  if (windowElapsed >= FPS_WINDOW_MS) {
    const fps = (fpsFrames * 1000) / windowElapsed;
    game.debugFpsEl.textContent = `FPS ${fps.toFixed(0)}`;
    fpsWindowStart = now;
    fpsFrames = 0;
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
