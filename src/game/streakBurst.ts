import type { Game } from "../Game";
import type { Vec } from "../vec";
import { drawGlow } from "../glow";
import { BEAT_GRID } from "./rhythmConstants";

// Rhythm-streak sparks. Landing successive combo-shots within STREAK_MAX_GAP
// beats of each other grows a ring of comet-sparks riding an orbit around the
// reticule. The seed shot shows nothing — the first spark only appears when a
// 2nd in-window shot confirms the rhythm; only 2nd-and-onward shots count.
// Each spark is a hard white-cored pip head trailing a tapered arc tail, the
// same beat-synced line-work language as the sight it orbits. The ring advances
// in beat TICKS (surging on the downbeat, settling before the next) rather than
// gliding at constant speed; tails stretch longest exactly on the beat. A new
// spark charges on the crosshair and blooms out to its slot on its hit's beat
// center while the older sparks re-space smoothly — nothing teleports. The whole
// ring fades linearly over the extension window and reaches zero exactly when
// the window closes — sparks still visible means the streak can still be
// extended. Ending the streak (a wider gap, a combo loss, or the window
// closing) just clears the ring — each counted shot already paid its escalating
// score bonus on landing (see awardStreakShot in rhythmBonus.ts).
//
// Orbit phase is a pure function of beatTime; the fade + window + birth tween
// are pure functions of perceivedBeatTime (the clock hits are judged on) — no
// RNG anywhere here, so replays reproduce it exactly.

const TAU = Math.PI * 2;

// Sparks are the reticule's own cyan (hsl 195); the downbeat flash drifts toward
//   the brighter Pulsar-logo blue, matching the rest of the sight's beat accents.
const STREAK_HUE = 195;
const STREAK_BEAT_HUE = 207;

// Orbit radius + head size. The orbit is padded so sparks sit outside the
//   crosshair rather than smothering it.
const ORBIT_RADIUS = 38;
const HEAD_RADIUS = 7;

// Spark-head sprite: unlike the soft radial drawGlow, this holds a bright white-hot
//   core, snaps to the reticule cyan by mid-radius, then cuts to nothing with only a
//   thin soft rim — reads as a hard bright pip, not a blurry smudge. Cached once (no
//   per-frame gradient; no shadowBlur — house rules).
const SPARK_SPRITE_SIZE = 128;
let sparkSprite: HTMLCanvasElement | null = null;
const getSparkSprite = (): HTMLCanvasElement => {
  if (sparkSprite) return sparkSprite;
  const canvas = document.createElement("canvas");
  canvas.width = SPARK_SPRITE_SIZE;
  canvas.height = SPARK_SPRITE_SIZE;
  const ctx = canvas.getContext("2d")!;
  const c = SPARK_SPRITE_SIZE / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, "hsla(0, 0%, 100%, 1)");
  grad.addColorStop(0.22, `hsla(${STREAK_HUE}, 100%, 92%, 1)`);
  grad.addColorStop(0.42, `hsla(${STREAK_HUE}, 100%, 62%, 0.95)`);
  grad.addColorStop(0.7, `hsla(${STREAK_HUE}, 100%, 55%, 0.35)`);
  grad.addColorStop(1, `hsla(${STREAK_HUE}, 100%, 55%, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPARK_SPRITE_SIZE, SPARK_SPRITE_SIZE);
  sparkSprite = canvas;
  return sparkSprite;
};

// Blit the spark-head sprite at radius r. Caller sets additive composite + alpha handling.
const drawSparkHead = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) => {
  ctx.globalAlpha = alpha;
  ctx.drawImage(getSparkSprite(), x - r, y - r, r * 2, r * 2);
};
// A shot extends the streak while its hit still rounds to a beat within this
//   many grid units of the last one (see trackStreak in rhythmBonus.ts).
export const STREAK_MAX_GAP = 4;
// only render up to this many orbs so a very long streak stays cheap; N still
//   counts in full for the metric.
const MAX_ORBS = 16;

// The extension window, measured from the last shot's beat center in the
//   streak's own grid units. Hits round perceivedBeatTime to the nearest grid
//   beat, so extension is possible until half a grid past the last legal beat —
//   the window closes at exactly the point where no future hit can qualify.
export const streakWindowLength = (game: Game): number =>
  (STREAK_MAX_GAP + 0.5) * game.streakGrid;

// True once no shot can extend the streak anymore. Judged on perceivedBeatTime —
//   the same clock hit qualification uses — so the cutoff can't race a legal
//   max-gap shot the way the old raw-beatTime timeout did.
export const streakWindowClosed = (game: Game): boolean =>
  game.perceivedBeatTime - game.streakLastBeatCenter >= streakWindowLength(game);

// Shared 0..1 fade for the whole ring: 1 at the last hit's beat center, linear
//   to 0 at window close — the visual dies exactly when extension becomes
//   impossible, in every grid tier.
const streakFade = (game: Game): number => {
  if (game.streakShots < 1 || game.streakGrid <= 0) return 0;
  const elapsed = game.perceivedBeatTime - game.streakLastBeatCenter;
  return Math.max(0, Math.min(1, 1 - elapsed / streakWindowLength(game)));
};

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

// Beat-tick motion: the ring advances one step per beat — surging on the downbeat
//   and settling before the next — like a clock hand striking the grid, so the
//   rotation itself carries the rhythm the way the rest of the sight does. The
//   eased fraction reaches 1 exactly as the next beat starts, so the phase is
//   continuous, and it derives purely from beatTime.
const steppedBeats = (beatTime: number): number => {
  const beats = beatTime / BEAT_GRID;
  const whole = Math.floor(beats);
  return whole + easeOutCubic(beats - whole);
};

// Square-decay downbeat envelope — 1 on the beat, easing to 0 before the next —
//   the same shape the reticule's own beat pulse rides. Doubles as the tail
//   driver: the beat tick's angular speed peaks on the downbeat, so tails are
//   longest exactly when this envelope is 1.
const beatEnvelope = (beatTime: number): number => {
  const beats = beatTime / BEAT_GRID;
  const sinceBeat = beats - Math.floor(beats);
  return (1 - sinceBeat) * (1 - sinceBeat);
};

// A landed shot re-forms the ring over this window, measured from the hit's beat
//   center: the new spark blooms out from the crosshair to its slot while the
//   older sparks ease from their old spacing to the new — nothing teleports.
const BIRTH_SEC = 0.45;

// 0 until the last hit's beat center, 1 once the ring has settled. Negative
//   elapsed (a shot landed ahead of its beat center) holds at 0 — the newborn
//   spark waits on the crosshair and launches exactly on the beat center.
const birthProgress = (game: Game): number => {
  if (game.streakLastBeatCenter < 0) return 1;
  const elapsed = game.perceivedBeatTime - game.streakLastBeatCenter;
  return Math.max(0, Math.min(1, elapsed / BIRTH_SEC));
};

type SparkPos = {
  x: number;
  y: number;
  ang: number;
  radius: number;
  birth: number; // 0..1 bloom progress for the newest spark; 1 once settled
};

const streakSparkPositions = (game: Game, center: Vec): SparkPos[] => {
  const n = game.streakShots;
  const shown = Math.min(n, MAX_ORBS);
  const prevShown = Math.min(Math.max(n - 1, 1), MAX_ORBS);
  const revBeats = game.streakInterval > 0 ? game.streakInterval : 4;
  const orbitPhase = (steppedBeats(game.beatTime) / revBeats) * TAU;
  const settle = easeOutCubic(birthProgress(game));
  const sparks: SparkPos[] = [];
  for (let i = 0; i < shown; i++) {
    // once the ring is capped, hits stop minting sparks — no slot blooms, the
    //   whole ring just takes the hit-lift flash instead.
    const isNewest = n <= MAX_ORBS && i === shown - 1;
    const targetFrac = i / shown;
    // older sparks slide from their old slot fraction to the new one as the ring
    //   absorbs the newcomer.
    const prevFrac = i / prevShown;
    const frac = isNewest ? targetFrac : prevFrac + (targetFrac - prevFrac) * settle;
    const ang = orbitPhase + frac * TAU;
    const birth = isNewest ? settle : 1;
    const radius = ORBIT_RADIUS * birth;
    sparks.push({
      x: center.x + Math.cos(ang) * radius,
      y: center.y + Math.sin(ang) * radius,
      ang,
      radius,
      birth,
    });
  }
  return sparks;
};

// Live sparks riding the ring around the reticule at `center`. Caller sets
//   additive composite.
export const renderStreakOrbs = (ctx: CanvasRenderingContext2D, game: Game, center: Vec) => {
  const n = game.streakShots;
  if (n < 1) return;
  const fade = streakFade(game);
  if (fade <= 0) return;
  const beatEnv = beatEnvelope(game.beatTime);
  const hue = STREAK_HUE + (STREAK_BEAT_HUE - STREAK_HUE) * beatEnv;
  const sparks = streakSparkPositions(game, center);
  // brief whole-ring lift on each landed shot, so extending a capped ring still
  //   visibly pulses even though no new spark appears.
  const hitLift = 0.35 * (1 - birthProgress(game));
  // tails stretch on the downbeat and contract as the tick settles; they also
  //   wither as the extension window runs out, so a dying streak visibly loses
  //   its energy before the pips themselves fade. Capped below the slot gap so
  //   a full ring never smears into an unbroken circle.
  const slotGap = TAU / sparks.length;
  const maxSweep = Math.min(0.55, slotGap * 0.62);
  ctx.setLineDash([]);
  ctx.lineCap = "round";
  for (const s of sparks) {
    const flare = 1 + 1.3 * (1 - s.birth);
    const a = Math.min(1, fade * (0.85 + 0.15 * beatEnv) * flare + hitLift * fade);
    const sweep = maxSweep * (0.35 + 0.65 * beatEnv) * (0.3 + 0.7 * fade) * s.birth;
    if (sweep > 0.02 && s.radius > 1) {
      // tapered tail: three stacked arcs of shrinking sweep — soft afterglow,
      //   cyan body, then a white-hot core hugging the head — summing under the
      //   additive composite so the far end thins out on its own.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = `hsla(${hue}, 100%, 65%, ${0.16 * a})`;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(center.x, center.y, s.radius, s.ang - sweep * 1.15, s.ang);
      ctx.stroke();
      ctx.strokeStyle = `hsla(${hue}, 100%, 72%, ${0.5 * a})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(center.x, center.y, s.radius, s.ang - sweep, s.ang);
      ctx.stroke();
      ctx.strokeStyle = `hsla(0, 0%, 100%, ${0.75 * a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(center.x, center.y, s.radius, s.ang - sweep * 0.4, s.ang);
      ctx.stroke();
    }
    const headR = HEAD_RADIUS * (1 + 0.2 * beatEnv) * (0.6 + 0.4 * s.birth);
    // a faint wide halo keeps the head legible against a busy field, the sharp
    //   sprite lands the hard white-cored pip on top, and the downbeat adds a
    //   white flash riding the same envelope as the reticule pulse.
    drawGlow(ctx, s.x, s.y, headR * 2.4, STREAK_HUE, a * 0.28);
    drawSparkHead(ctx, s.x, s.y, headR, a);
    if (beatEnv > 0.02) drawGlow(ctx, s.x, s.y, headR * 1.1, 0, a * 0.4 * beatEnv, true);
  }
  ctx.globalAlpha = 1;
};

// ---- Streak lifecycle (shared by rhythmBonus + rhythmGate/loseCombo). ----

// End a streak: zero the run-streak state (the ring just stops drawing — each
//   counted shot already paid on landing). Keeps the per-wave total. Kept here
//   so both rhythmBonus and rhythmGate (loseCombo) can call it without an
//   import cycle.
export const resetStreak = (game: Game) => {
  game.streakInterval = 0;
  game.streakGrid = 0;
  game.streakShots = 0;
  game.streakEstablished = false;
  game.streakLastBeatCenter = -1;
};
