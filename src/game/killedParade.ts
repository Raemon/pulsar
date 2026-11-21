import type { Game } from "../Game";
import { KilledSnapshot } from "./killSnapshot";
import { BEAT_GRID } from "./rhythmConstants";
import { SoundName } from "../Sound";
import { formatScore } from "./formatScore";

// high enough scroll speed that sprites move visibly between beats — reads as marching past.
const PARADE_PX_PER_BEAT = 140;

// perceptual onset of a sound lands at the peak of its envelope, not at trigger time.
//   The bass voices sweep their pitch over 40–80ms before the body crystallises, so triggering
//   them exactly when the sprite reaches centre makes the audible "hit" arrive late. Lead the
//   trigger by the sweep duration so the perceived peak lands on the visual beat instead.
//   Values are seconds and were tuned from each voice's pitchDecay / filterEnvelope settings
//   in Sound.ts: bassKick 0.04s, bassPluck 0.04s (filter sweep dominates), bassBoom 0.08s,
//   bassSnap is short-transient (~0.005s) so it sits effectively on-beat.
const SOUND_PRE_ROLL_SECONDS: Partial<Record<SoundName, number>> = {
  bassKick: 0.04,
  bassPluck: 0.04,
  bassBoom: 0.08,
  bassSnap: 0.0,
  bgBeat: 0.04,
};

// horizontal-layout canvas height fits the tallest snap (+vpad) so a boss-large
//   with its additive glow halo isn't clipped at the top/bottom of the row.
const PARADE_HORIZ_MIN_H = 220;
// bottom pad fits the 22px "+N" score flash (drawn 6px under the sprite) plus its
//   14px shadow blur — 48px keeps the tallest sprite's flash unclipped.
const PARADE_HORIZ_VPAD = 48;
const PARADE_HORIZ_MIN_W = 320;
// vertical-layout canvas width fits the widest snap (+hpad) so the side-mounted
//   "+N" score flash has breathing room (22px font + 14px shadow blur).
const PARADE_VERT_MIN_W = 220;
const PARADE_VERT_HPAD = 56;
const PARADE_VERT_MIN_H = 320;
// bgBeat fires on every whole BEAT_GRID tick (alternating downbeat/offbeat pitch), so
//   snapping offsets to integer beats guarantees the kill-sound trigger lands on a bg beat.
const PARADE_BEAT_SUBDIV = 1.0;

// `played` latches true so each kill sound replays once when its sprite crosses centre.
//   `playedAtBeat` snapshots the parade-beat clock at that moment so the "+N" score flash
//   can fade out a fixed number of beats later, independent of bgm tempo drift.
//   `droneKey` is the unique handle (this entry object would clash across replays) for the
//   per-entry bass drone so we can stop it when the sprite exits the canvas or the parade ends.
export type ParadeEntry = {
  snap: KilledSnapshot;
  beatOffset: number;
  played: boolean;
  playedAtBeat: number;
  droneKey: object | null;
  droneActive: boolean;
};

// maxHp/4 spacing = on-rhythm shots needed — paces the parade by kill difficulty.
//   orientation: "horizontal" on the title screen (full-width banner), "vertical"
//   on the gameover layout (narrow right-column column-of-march).
export const renderKilledRow = (game: Game, orientation: "horizontal" | "vertical" = "horizontal") => {
  stopParade(game);
  if (game.killedSnapshots.length === 0) {
    game.killedRowEl.classList.add("hidden");
    return;
  }
  game.paradeOrientation = orientation;
  layOutParade(game);
  configureParadeCanvas(game);
  startParadeLoop(game);
};

// tiny kills get sub-beat rests (1hp → quarter, 2hp → half) so trash-mob trails machine-gun by;
//   anything bigger snaps to the whole-beat grid so the kill-sound still lands on a bg bass tick.
const layOutParade = (game: Game) => {
  const entries: ParadeEntry[] = [];
  let cursor = 0;
  for (const snap of game.killedSnapshots) {
    entries.push({ snap, beatOffset: cursor, played: false, playedAtBeat: 0, droneKey: null, droneActive: false });
    let rest: number;
    if (snap.maxHp <= 1) rest = 0.25;
    else if (snap.maxHp <= 2) rest = 0.5;
    else {
      const raw = Math.max(PARADE_BEAT_SUBDIV, snap.maxHp / 4);
      rest = Math.ceil(raw / PARADE_BEAT_SUBDIV) * PARADE_BEAT_SUBDIV;
    }
    cursor += rest;
  }
  game.paradeEntries = entries;
};

// DPR-aware backing store needed so the parade looks crisp at high-density display ratios.
//   Horizontal: canvas spans the viewport, height fits the tallest snap.
//   Vertical: canvas spans the viewport height, width fits the widest snap.
const configureParadeCanvas = (game: Game) => {
  const canvas = game.killedRowEl;
  let cssW: number;
  let cssH: number;
  if (game.paradeOrientation === "vertical") {
    let widest = 0;
    for (const e of game.paradeEntries) widest = Math.max(widest, e.snap.full.width);
    cssW = Math.max(PARADE_VERT_MIN_W, widest + PARADE_VERT_HPAD * 2);
    cssH = Math.max(PARADE_VERT_MIN_H, window.innerHeight);
  } else {
    let tallest = 0;
    for (const e of game.paradeEntries) tallest = Math.max(tallest, e.snap.full.height);
    cssW = Math.max(PARADE_HORIZ_MIN_W, window.innerWidth);
    cssH = Math.max(PARADE_HORIZ_MIN_H, tallest + PARADE_HORIZ_VPAD * 2);
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  game.paradeCanvasW = cssW;
  game.paradeCanvasH = cssH;
  canvas.classList.remove("hidden");
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};

// rAF id held so stopParade can cancel cleanly on restart / abort.
// anchor parade time to game.beatTime (snapped to BEAT_GRID) so the eighth-note kill-sound
//   triggers land exactly on the bg bass beat that keeps ticking during gameover.
const startParadeLoop = (game: Game) => {
  const ctx = game.killedRowEl.getContext("2d");
  if (!ctx) return;
  game.paradeActive = true;
  game.paradeStartBeatTime = Math.ceil(game.beatTime / BEAT_GRID) * BEAT_GRID;
  const step = () => {
    if (!game.paradeActive) return;
    tickParade(game, ctx);
    game.paradeRafId = requestAnimationFrame(step);
  };
  game.paradeRafId = requestAnimationFrame(step);
};

// hard reset on every state transition — never want two parades running together.
//   Also kills any in-flight bass drones the parade started; otherwise restarting the parade
//   (e.g. abort → title) would leak the drone bed into the title screen.
export const stopParade = (game: Game) => {
  if (game.paradeRafId !== null) {
    cancelAnimationFrame(game.paradeRafId);
    game.paradeRafId = null;
  }
  for (const e of game.paradeEntries) {
    if (e.droneActive && e.droneKey) game.sound.stopBassteroidDrone(e.droneKey);
    e.droneActive = false;
  }
  game.paradeActive = false;
  game.paradeEntries = [];
};

// per-frame composition splits cleanly into "where are we", "draw", "should we stop?".
const tickParade = (game: Game, ctx: CanvasRenderingContext2D) => {
  const cssW = game.paradeCanvasW;
  const cssH = game.paradeCanvasH;
  ctx.clearRect(0, 0, cssW, cssH);
  // travel axis is width for horizontal, height for vertical.
  const travelDim = game.paradeOrientation === "vertical" ? cssH : cssW;
  const t = currentParadeBeat(game, travelDim);
  drawParadeSprites(game, ctx, t, cssW, cssH);
  maybeEndParade(game, t, travelDim);
};

// pre-roll itself is snapped to BEAT_GRID so the first sprite still reaches centre on a beat
//   even though the canvas-derived pre-roll would otherwise land on a fractional beat.
const currentParadeBeat = (game: Game, travelDim: number): number => {
  const elapsedBeats = (game.beatTime - game.paradeStartBeatTime) / BEAT_GRID;
  const rawPreRoll = travelDim / (2 * PARADE_PX_PER_BEAT);
  const preRollBeats = Math.ceil(rawPreRoll / PARADE_BEAT_SUBDIV) * PARADE_BEAT_SUBDIV;
  return elapsedBeats - preRollBeats;
};

// "+N" flashes for ~1.5 beats after the sprite crosses centre — long enough to read at
//   any sane bpm, short enough that consecutive close kills don't pile up overlapping numbers.
const SCORE_FLASH_BEATS = 1.5;

// cull offscreen sprites before drawImage; trigger kill sound when sprite crosses centre.
//   Bassteroid entries also light up their drone for the duration the sprite is on screen, so
//   the parade carries the continuous bed as well as the per-beat hit voice.
//   Horizontal: sprites march right-to-left, meeting at centreX on the beat.
//   Vertical:   sprites march bottom-to-top, meeting at centreY on the beat.
const drawParadeSprites = (game: Game, ctx: CanvasRenderingContext2D, t: number, cssW: number, cssH: number) => {
  const centreX = cssW / 2;
  const centreY = cssH / 2;
  const vertical = game.paradeOrientation === "vertical";
  for (const e of game.paradeEntries) {
    const halfW = e.snap.full.width / 2;
    const halfH = e.snap.full.height / 2;
    const travel = (e.beatOffset - t) * PARADE_PX_PER_BEAT;
    const x = vertical ? centreX : centreX + travel;
    const y = vertical ? centreY + travel : centreY;
    // lead bass/percussive triggers by their perceptual-onset delay so the audible "hit"
    //   lands on centre, not after the sprite has already passed it. See SOUND_PRE_ROLL_SECONDS.
    const preRollBeats = (SOUND_PRE_ROLL_SECONDS[e.snap.killSound] ?? 0) / BEAT_GRID;
    if (!e.played && t >= e.beatOffset - preRollBeats) {
      e.played = true;
      e.playedAtBeat = t;
      game.sound.play(e.snap.killSound);
      if (e.snap.rhythmHit) {
        game.sound.playComboSparkleShort();
        game.sound.playComboChime(e.snap.rhythmHit.combo, undefined, 0.5);
      }
      if (e.snap.bassDrone) {
        e.droneKey = {};
        game.sound.startBassteroidDrone(e.droneKey, e.snap.bassDrone.kind, e.snap.bassDrone.size);
        e.droneActive = true;
      }
    }
    const offscreenEnter = vertical ? y - halfH > cssH : x - halfW > cssW;
    const offscreenExit = vertical ? y + halfH < 0 : x + halfW < 0;
    if (e.droneActive && offscreenExit && e.droneKey) {
      game.sound.stopBassteroidDrone(e.droneKey);
      e.droneActive = false;
    }
    if (offscreenEnter || offscreenExit) continue;
    const dimmed = !e.snap.rhythmHit;
    if (dimmed) {
      ctx.save();
      ctx.globalAlpha = 0.6;
    }
    ctx.drawImage(e.snap.full, x - halfW, y - halfH);
    if (dimmed) ctx.restore();
    if (e.played && e.snap.scoreEarned > 0) {
      const age = t - e.playedAtBeat;
      if (age < SCORE_FLASH_BEATS) {
        // Horizontal: flash sits beneath the sprite, top-anchored.
        // Vertical:   flash sits to the right of the sprite, vertically centred.
        if (vertical) drawScoreFlashSide(ctx, x + halfW + 6, y, e.snap.scoreEarned, age);
        else drawScoreFlashUnder(ctx, x, y + halfH, e.snap.scoreEarned, age);
      }
    }
  }
};

// matches popupScore's in-game look (pale blue, soft glow, brief pop-in) so the parade
//   feedback reads as a replay of the same "+N" the player saw at the kill site.
const drawScoreFlashUnder = (ctx: CanvasRenderingContext2D, x: number, y: number, points: number, ageBeats: number) => {
  beginScoreFlash(ctx, ageBeats, "center", "top");
  ctx.translate(x, y + 6);
  finishScoreFlash(ctx, points, ageBeats);
};

const drawScoreFlashSide = (ctx: CanvasRenderingContext2D, x: number, y: number, points: number, ageBeats: number) => {
  beginScoreFlash(ctx, ageBeats, "left", "middle");
  ctx.translate(x, y);
  finishScoreFlash(ctx, points, ageBeats);
};

const beginScoreFlash = (ctx: CanvasRenderingContext2D, ageBeats: number, align: CanvasTextAlign, baseline: CanvasTextBaseline) => {
  const t = ageBeats / SCORE_FLASH_BEATS;
  const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.font = "600 22px 'Space Grotesk', system-ui, sans-serif";
  ctx.fillStyle = "#e6f4ff";
  ctx.shadowColor = "rgba(200, 230, 255, 0.85)";
};

const finishScoreFlash = (ctx: CanvasRenderingContext2D, points: number, ageBeats: number) => {
  const popIn = Math.min(1, ageBeats / 0.25);
  const scale = 1 + (1 - popIn) * 0.6;
  ctx.scale(scale, scale);
  ctx.fillText(`+${formatScore(points)}`, 0, 0);
  ctx.restore();
};

// stop the rAF once the last sprite has cleared the travel axis — no point burning frames on blank.
const maybeEndParade = (game: Game, t: number, travelDim: number) => {
  const last = game.paradeEntries[game.paradeEntries.length - 1];
  if (!last) return;
  const lastPos = travelDim / 2 + (last.beatOffset - t) * PARADE_PX_PER_BEAT;
  const halfExtent = (game.paradeOrientation === "vertical" ? last.snap.full.height : last.snap.full.width) / 2;
  if (lastPos + halfExtent < 0) game.paradeActive = false;
};
