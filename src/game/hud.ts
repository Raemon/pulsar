import type { Game } from "../Game";
import { SLOW_MO_DURATION } from "./slowMo";
import { displayWave } from "./waveDirector";
import { formatScore, formatScorePadded } from "./formatScore";
import { FUEL_MODE_ENABLED } from "./fuel";

// cache the DOM handles once so per-frame syncs don't repeat document.getElementById calls.
export type HudElements = {
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
};

// Cached references for the powerup slot row; resolved once at boot.
const powerupSlots: Record<string, HTMLElement> = {};
let slowProgressEl: HTMLElement | null = null;
let fuelEl: HTMLElement | null = null;
let fuelFillEl: HTMLElement | null = null;

// single one-time DOM lookup means a missing element fails loudly at boot, not mid-game.
export const bindHudElements = (): HudElements => {
  const slots = document.querySelectorAll<HTMLElement>("#powerups .powerup-slot");
  slots.forEach((el) => {
    const kind = el.dataset.kind;
    if (kind) powerupSlots[kind] = el;
  });
  slowProgressEl = powerupSlots.slow?.querySelector<HTMLElement>(".powerup-progress") ?? null;
  fuelEl = document.getElementById("fuel");
  fuelFillEl = document.getElementById("fuel-fill");
  // Reveal the fuel bar once at boot when fuel mode is on; it stays hidden otherwise.
  if (FUEL_MODE_ENABLED) fuelEl?.classList.remove("hidden");
  return {
    scoreEl: document.getElementById("score")!,
    scoreFlashEl: document.getElementById("score-flash")!,
    comboEl: document.getElementById("combo")!,
    comboValueEl: document.getElementById("combo-value")!,
    waveEl: document.getElementById("wave")!,
    livesEl: document.getElementById("lives")!,
    overlayEl: document.getElementById("overlay")!,
    overlayTitleEl: document.getElementById("overlay-title")!,
    overlayStartEl: document.getElementById("overlay-start")!,
    volumeEl: document.getElementById("volume") as HTMLInputElement,
    abortEl: document.getElementById("abort-mission") as HTMLButtonElement,
    killedRowEl: document.getElementById("killed-row") as HTMLCanvasElement,
    scoreEntryFormEl: document.getElementById("score-entry") as HTMLFormElement,
    scoreEntryInputEl: document.getElementById("score-entry-name") as HTMLInputElement,
    scoreEntrySubmitEl: document.getElementById("score-entry-submit") as HTMLButtonElement,
    scoreEntryStatusEl: document.getElementById("score-entry-status")!,
    leaderboardEl: document.getElementById("leaderboard")!,
    leaderboardListEl: document.getElementById("leaderboard-list") as HTMLOListElement,
    replaySaveCheckboxEl: document.getElementById("replay-save-toggle-input") as HTMLInputElement,
    debugOverlayEl: document.getElementById("debug-overlay")!,
    debugFpsEl: document.getElementById("debug-fps")!,
  };
};

// toggling the class on every frame would re-fire the pop animation; only flip on change.
const setSlotActive = (kind: string, active: boolean) => {
  const el = powerupSlots[kind];
  if (!el) return;
  const isActive = el.classList.contains("active");
  if (active && !isActive) el.classList.add("active");
  else if (!active && isActive) el.classList.remove("active");
};

// Linear scale/glow from points earned. Anchors: a 50-point baseline kill
// reads at 1.0× scale; a 500-point hit reads at 2.5×. Clamps keep
// tiny chips visible and very-big combo'd kills from blowing out the HUD.
const SCORE_FLASH_BASELINE_POINTS = 50;
const SCORE_FLASH_PEAK_POINTS = 5000;
const SCORE_FLASH_BASELINE_SCALE = 1.0;
const SCORE_FLASH_PEAK_SCALE = 2.5;
const SCORE_FLASH_MIN_SCALE = 0.85;
const SCORE_FLASH_MAX_SCALE = 3.0;

const scoreFlashScale = (points: number): number => {
  const slope =
    (SCORE_FLASH_PEAK_SCALE - SCORE_FLASH_BASELINE_SCALE) /
    (SCORE_FLASH_PEAK_POINTS - SCORE_FLASH_BASELINE_POINTS);
  const raw = SCORE_FLASH_BASELINE_SCALE + (points - SCORE_FLASH_BASELINE_POINTS) * slope;
  return Math.max(SCORE_FLASH_MIN_SCALE, Math.min(SCORE_FLASH_MAX_SCALE, raw));
};

// Pop the "+N" readout next to the score. We toggle the .flashing class off
// and re-apply on the next frame so a rapid-fire kill chain restarts the
// animation instead of being swallowed by an already-playing one.
export const flashScoreGain = (game: Game, points: number) => {
  if (points <= 0) return;
  const el = game.scoreFlashEl;
  const scale = scoreFlashScale(points);
  // Glow tracks the same linear curve, then re-mapped into a smaller range
  // so even small flashes still glow a little.
  const glow = 0.55 + ((scale - SCORE_FLASH_MIN_SCALE) / (SCORE_FLASH_MAX_SCALE - SCORE_FLASH_MIN_SCALE)) * 0.45;
  el.textContent = `+${formatScore(points)}`;
  el.style.setProperty("--scale", scale.toFixed(3));
  el.style.setProperty("--glow", glow.toFixed(3));
  el.classList.remove("flashing");
  // Force a reflow so removing+adding the class restarts the keyframes.
  void el.offsetWidth;
  el.classList.add("flashing");
};

// collapses score/wave/lives/combo DOM writes into one call so handlers stay one-liners.
export const syncHud = (game: Game) => {
  game.scoreEl.textContent = formatScorePadded(game.score);
  game.waveEl.textContent = `WAVE ${displayWave(game.wave)}`;
  const lifeSpans: string[] = [];
  for (let i = 0; i < game.lives; i++) lifeSpans.push("<span></span>");
  game.livesEl.innerHTML = lifeSpans.join("");
  syncComboHud(game);
  syncPowerupHud(game);
  syncFuelHud(game);
};

// Fuel reserve bar — width tracks the reserve, colour shifts amber under a third
// and red when fully dry. No-op (and the bar stays hidden) when fuel mode is off.
const FUEL_LOW_FRACTION = 0.33;
export const syncFuelHud = (game: Game) => {
  if (!FUEL_MODE_ENABLED || !fuelFillEl) return;
  const frac = Math.max(0, Math.min(1, game.ship.fuel / game.ship.maxFuel));
  fuelFillEl.style.width = `${frac * 100}%`;
  fuelFillEl.classList.toggle("empty", frac <= 0.001);
  fuelFillEl.classList.toggle("low", frac > 0.001 && frac < FUEL_LOW_FRACTION);
};

// persistent flags drive on/off; slow-mo also shows a bottom-up timer bar of remaining duration.
export const syncPowerupHud = (game: Game) => {
  setSlotActive("prong", game.ship.prongActive);
  setSlotActive("pierce", game.ship.pierceActive);
  setSlotActive("shield", game.ship.shieldActive);
  setSlotActive("radar", game.ship.radarActive);
  setSlotActive("longshot", game.ship.longshotActive);
  setSlotActive("bomb", game.ship.bombActive);
  setSlotActive("warpCannon", game.ship.warpCannonActive);
  const slowOn = game.slowMoTimer > 0;
  setSlotActive("slow", slowOn);
  if (slowProgressEl) {
    const pct = slowOn ? Math.max(0, Math.min(1, game.slowMoTimer / SLOW_MO_DURATION)) * 100 : 0;
    slowProgressEl.style.height = `${pct}%`;
  }
};

// x1 ("primed") doesn't yet multiply anything, so we hide it to avoid misleading the player.
export const syncComboHud = (game: Game) => {
  if (game.beatCombo >= 2) {
    game.comboEl.classList.remove("hidden");
    game.comboValueEl.textContent = String(game.beatCombo);
  } else {
    game.comboEl.classList.add("hidden");
  }
};
