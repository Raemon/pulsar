// Animation registry for /sound. One animator per game object that the page
// renders into a 200×100 cell. Animators are pure closures over AnimatorCtx:
// they react to a `firedAt` change for one-shot triggers and a `playing` flag
// for continuous loops.
//
// Add a new object → add an entry in ANIMATIONS keyed by an ObjectId.
// The sound registry then maps actions to those object IDs.

import { Ship } from "../../Ship";
import { Bullet } from "../../Bullet";
import { Asteroid, type AsteroidKind } from "../../Asteroid";
import { Pulsar } from "../../Pulsar";
import { Alien } from "../../Alien";
import { Comet } from "../../Comet";
import { Canister } from "../../Canister";
import { v } from "../../vec";
import { BEAT_GRID } from "../../game/rhythmConstants";

export type AnimatorCtx = {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  t: number;
  dt: number;
  playing: boolean;
  // Seconds (since canvas mount) when this row's sound last fired. -1 if never.
  firedAt: number;
};

export type Animator = (a: AnimatorCtx) => void;

// IDs the sound registry can attach to. Each is one game object — typically
// one entity class (Ship, Comet) or one *kind* of an entity (asteroid-bassA
// vs asteroid-normal vs alien-big), because the visual differs per kind.
export type ObjectId =
  | "ship"
  | "ship-thrust"
  | "ship-reverse"
  | "ship-side"
  | "ship-shield"
  | "ship-death"
  | "bullet-weak"
  | "bullet-rhythm"
  | "bullet-bomb-weak"
  | "bullet-bomb-rhythm"
  | "bullet-prong"
  | "asteroid-normal"
  | "asteroid-bassA"
  | "asteroid-bassB"
  | "asteroid-bassC"
  | "asteroid-bassD"
  | "asteroid-chime"
  | "asteroid-bell"
  | "asteroid-warble"
  | "asteroid-gold"
  | "asteroid-solidCrystal"
  | "asteroid-glassPrison"
  | "wraith"
  | "alien-big"
  | "alien-medium"
  | "alien-small"
  | "comet"
  | "canister"
  | "pulsar"
  | "shockwave"
  | "wave-summary"
  | "combo-halo"
  | "generic-pulse";

// ── primitives ──────────────────────────────────────────────────────────

const PULSAR_WAVE_LEVEL = 6;

function drawPulsar(): Animator {
  let pulsar: Pulsar | null = null;
  let lastFiredAt = -1;
  let beatClock = 0;
  return ({ ctx, w, h, dt, firedAt }) => {
    if (!pulsar || pulsar.w !== w || pulsar.h !== h) {
      pulsar = new Pulsar(w, h);
      pulsar.baseOffsetX = 0;
      pulsar.baseOffsetY = 0;
      pulsar.planets = [];
      pulsar.setWaveLevel(PULSAR_WAVE_LEVEL);
      pulsar.displayWaveLevel = PULSAR_WAVE_LEVEL;
    }
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      pulsar.beat();
    }
    beatClock += dt;
    ctx.clearRect(0, 0, w, h);
    pulsar.update(dt, beatClock, BEAT_GRID);
    pulsar.render(ctx);
  };
}

function drawShip(opts: { thrust?: boolean; reverse?: boolean; shield?: boolean; death?: boolean }): Animator {
  const ship = new Ship(v(0, 0));
  ship.invuln = 0;
  let lastDeathAt = -1;
  return ({ ctx, w, h, t, playing, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    ship.pos = v(w / 2, h / 2);
    ship.heading = -Math.PI / 2 + Math.sin(t * 0.6) * 0.2;
    ship.thrustOn = !!opts.thrust && playing;
    ship.reverseThrustOn = !!opts.reverse && playing;
    if (opts.shield) {
      // Shield-pop is a one-shot — flare invuln briefly each fire so the
      // bubble visibly pops rather than steady-on.
      if (firedAt !== lastDeathAt && firedAt >= 0) {
        lastDeathAt = firedAt;
        ship.invuln = 0.8;
      }
      ship.invuln = Math.max(0, ship.invuln - 1 / 60);
    }
    if (opts.death && firedAt !== lastDeathAt && firedAt >= 0) {
      lastDeathAt = firedAt;
      ship.invuln = 2.0;
    }
    ship.render(ctx, t * 1000, 0);
  };
}

function drawBullet(opts: { onBeat: boolean; boosted: boolean; count: number; bomb?: boolean }): Animator {
  const lanes = opts.count === 2 ? [-0.3, 0.3] : opts.count === 3 ? [-0.35, 0, 0.35] : [0];
  type Tracked = { bullet: Bullet; vx: number; vy: number };
  let tracked: Tracked[] = [];
  let lastFiredAt = -1;
  return ({ ctx, w, h, dt, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      for (const lane of lanes) {
        const b = new Bullet(
          v(10, h / 2 + lane * h * 0.6),
          v(0, 0),
          1.4,
        );
        b.onBeat = opts.onBeat;
        b.boosted = opts.boosted;
        b.bomb = opts.bomb ?? false;
        tracked.push({ bullet: b, vx: 140, vy: lane * 18 });
      }
    }
    for (const tr of tracked) {
      tr.bullet.life -= dt;
      tr.bullet.trail.push({ x: tr.bullet.pos.x, y: tr.bullet.pos.y });
      if (tr.bullet.trail.length > 8) tr.bullet.trail.shift();
      tr.bullet.pos = v(tr.bullet.pos.x + tr.vx * dt, tr.bullet.pos.y + tr.vy * dt);
    }
    tracked = tracked.filter((tr) => tr.bullet.life > 0 && tr.bullet.pos.x < w + 30);
    for (const tr of tracked) tr.bullet.render(ctx);
  };
}

// Asteroid animator parameterised by kind. Same closure for every kind —
// the kind picks the silhouette/colour the Asteroid class builds at construct
// time. `mode` is "chip" (re-spawns after each kill) or "kill" (walks HP to 0
// on each fire).
function drawAsteroid(kind: AsteroidKind, mode: "chip" | "kill"): Animator {
  const fresh = (): Asteroid => {
    const a = new Asteroid(v(0, 0), v(0, 0), "large", undefined, kind);
    return a;
  };
  let asteroid = fresh();
  let lastFiredAt = -1;
  let killedAt = -Infinity;
  return ({ ctx, w, h, t, dt, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      if (mode === "kill") {
        asteroid.hp = 0;
        asteroid.flashAmount = 1;
        killedAt = t;
      } else {
        if (asteroid.hp <= 1) asteroid = fresh();
        asteroid.applyDamage(1);
      }
    }
    if (mode === "kill" && t - killedAt > 0.9 && asteroid.hp === 0) {
      asteroid = fresh();
      killedAt = -Infinity;
    }
    const fit = 0.78;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(fit, fit);
    ctx.translate(-w / 2, -h / 2);
    asteroid.pos = v(w / 2, h / 2);
    asteroid.update(dt, w * 4, h * 4);
    asteroid.pos = v(w / 2, h / 2);
    asteroid.render(ctx, t * 1000);
    ctx.restore();
  };
}

function drawAlien(size: "big" | "medium" | "small"): Animator {
  const alien = new Alien(v(0, 0), v(40, 0), size);
  let lastFiredAt = -1;
  return ({ ctx, w, h, t, dt, firedAt }) => {
    ctx.clearRect(0, 0, w, h);
    alien.pos = v(w / 2, h / 2);
    alien.update(dt, w * 4, h * 4);
    alien.pos = v(w / 2, h / 2);
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      alien.fireFlash = 1;
      alien.flashAmount = 0.6;
    }
    const fit = size === "big" ? 0.55 : size === "medium" ? 0.8 : 1.0;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(fit, fit);
    ctx.translate(-w / 2, -h / 2);
    alien.render(ctx, t * 1000);
    ctx.restore();
  };
}

function drawComet(): Animator {
  let comet = new Comet(v(-20, 50), v(40, 0), 200);
  return ({ ctx, w, h, dt }) => {
    ctx.clearRect(0, 0, w, h);
    if (comet.pos.x > w + 40) comet = new Comet(v(-20, h / 2), v(40, 0), 200);
    comet.update(dt, w, h);
    comet.render(ctx);
  };
}

function drawCanister(): Animator {
  const canister = new Canister(v(0, 0), v(0, 0), "shield", 1e9);
  return ({ ctx, w, h, t, dt }) => {
    ctx.clearRect(0, 0, w, h);
    canister.pos = v(w / 2, h / 2);
    canister.update(dt, w * 4, h * 4);
    canister.pos = v(w / 2, h / 2);
    canister.render(ctx, t * 1000);
  };
}

// Expanding ring with a charge-up bloom. Used for shockwave actions; the
// difference between "charge" and "boom" is just timing — both look like
// the in-game shockwave at distinct moments of its lifecycle.
function drawShockwave(): Animator {
  let lastFiredAt = -1;
  let flash = 0;
  return ({ ctx, w, h, dt, firedAt }) => {
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      flash = 1;
    }
    flash = Math.max(0, flash - dt * 1.6);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    // Expanding outer ring on each fire.
    const r = (1 - flash) * Math.min(w, h) * 0.55;
    ctx.strokeStyle = `rgba(255, 216, 106, ${flash * 0.85})`;
    ctx.lineWidth = 2 + flash * 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.stroke();
    // Bright core that fades with the ring.
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 26);
    grad.addColorStop(0, `rgba(255, 244, 200, ${flash * 0.9})`);
    grad.addColorStop(1, "rgba(255, 244, 200, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fill();
  };
}

// Wave-summary row mockup — a thin score line that briefly highlights on
// each fire, mimicking how the end-of-wave panel reveals one row per beat.
function drawWaveSummary(): Animator {
  let lastFiredAt = -1;
  let flash = 0;
  return ({ ctx, w, h, dt, firedAt }) => {
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      flash = 1;
    }
    flash = Math.max(0, flash - dt * 2.5);
    ctx.clearRect(0, 0, w, h);
    const pad = 18;
    const rowH = 16;
    for (let i = 0; i < 4; i++) {
      const y = 18 + i * (rowH + 6);
      const isActive = i === 1;
      const a = 0.18 + (isActive ? flash * 0.7 : 0);
      ctx.fillStyle = `rgba(106, 215, 255, ${a * 0.18})`;
      ctx.fillRect(pad, y, w - pad * 2, rowH);
      ctx.strokeStyle = `rgba(106, 215, 255, ${0.25 + (isActive ? flash * 0.5 : 0)})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(pad + 0.5, y + 0.5, w - pad * 2 - 1, rowH - 1);
      // Right-aligned number flash.
      ctx.fillStyle = `rgba(255, 216, 106, ${0.4 + (isActive ? flash * 0.6 : 0)})`;
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.fillText(isActive ? "1234" : "—", w - pad - 6, y + rowH - 4);
      ctx.textAlign = "left";
    }
  };
}

// Combo-halo ring around a static ship silhouette. Used for combo-related
// sounds (sparkle, tick, lost). The halo brightens on fire and fades.
function drawComboHalo(): Animator {
  const ship = new Ship(v(0, 0));
  ship.invuln = 0;
  let lastFiredAt = -1;
  let flash = 0;
  return ({ ctx, w, h, t, dt, firedAt }) => {
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      flash = 1;
    }
    flash = Math.max(0, flash - dt * 2);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    // Halo ring.
    const grad = ctx.createRadialGradient(cx, cy, 20, cx, cy, 44);
    grad.addColorStop(0, "rgba(255, 216, 106, 0)");
    grad.addColorStop(0.6, `rgba(255, 216, 106, ${0.22 + flash * 0.5})`);
    grad.addColorStop(1, "rgba(255, 216, 106, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, 44, 0, Math.PI * 2);
    ctx.fill();
    ship.pos = v(cx, cy);
    ship.heading = -Math.PI / 2;
    ship.thrustOn = false;
    ship.reverseThrustOn = false;
    ship.render(ctx, t * 1000, 0);
  };
}

// Fallback for sounds without a clear visual home — soft glow pulse on each
// fire, ambient hum while a loop is active.
function drawGenericPulse(): Animator {
  let lastFiredAt = -1;
  let flash = 0;
  let loopFlash = 0;
  return ({ ctx, w, h, dt, firedAt, playing }) => {
    if (firedAt !== lastFiredAt && firedAt >= 0) {
      lastFiredAt = firedAt;
      flash = 1;
    }
    flash = Math.max(0, flash - dt * 2.2);
    loopFlash = playing ? Math.min(1, loopFlash + dt * 3) : Math.max(0, loopFlash - dt * 3);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const r = 6 + flash * 32 + loopFlash * 14;
    const a = 0.18 + flash * 0.55 + loopFlash * 0.35;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(106, 215, 255, ${a})`);
    grad.addColorStop(1, "rgba(106, 215, 255, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(106, 215, 255, ${0.4 + flash * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 6 + loopFlash * 4, 0, Math.PI * 2);
    ctx.stroke();
  };
}

export const ANIMATIONS: Record<ObjectId, () => Animator> = {
  ship: () => drawShip({}),
  "ship-thrust": () => drawShip({ thrust: true }),
  "ship-reverse": () => drawShip({ reverse: true }),
  "ship-side": () => drawShip({}),
  "ship-shield": () => drawShip({ shield: true }),
  "ship-death": () => drawShip({ death: true }),
  "bullet-weak": () => drawBullet({ onBeat: false, boosted: false, count: 1 }),
  "bullet-rhythm": () => drawBullet({ onBeat: true, boosted: false, count: 1 }),
  "bullet-bomb-weak": () => drawBullet({ onBeat: false, boosted: false, count: 1, bomb: true }),
  "bullet-bomb-rhythm": () => drawBullet({ onBeat: true, boosted: false, count: 1, bomb: true }),
  "bullet-prong": () => drawBullet({ onBeat: true, boosted: true, count: 3 }),
  "asteroid-normal": () => drawAsteroid("normal", "chip"),
  "asteroid-bassA": () => drawAsteroid("bassA", "chip"),
  "asteroid-bassB": () => drawAsteroid("bassB", "chip"),
  "asteroid-bassC": () => drawAsteroid("bassC", "chip"),
  "asteroid-bassD": () => drawAsteroid("bassD", "chip"),
  "asteroid-chime": () => drawAsteroid("chime", "chip"),
  "asteroid-bell": () => drawAsteroid("bell", "chip"),
  "asteroid-warble": () => drawAsteroid("warble", "chip"),
  "asteroid-gold": () => drawAsteroid("asteroidWithGem", "chip"),
  "asteroid-solidCrystal": () => drawAsteroid("solidCrystal", "chip"),
  // No bespoke animator yet for the new kinds — reuse the solid-crystal
  // chip preview for the prison and the generic pulse for the wraith.
  // Visual fidelity here only matters for the sound-debug page.
  "asteroid-glassPrison": () => drawAsteroid("solidCrystal", "chip"),
  wraith: drawGenericPulse,
  "alien-big": () => drawAlien("big"),
  "alien-medium": () => drawAlien("medium"),
  "alien-small": () => drawAlien("small"),
  comet: drawComet,
  canister: drawCanister,
  pulsar: drawPulsar,
  shockwave: drawShockwave,
  "wave-summary": drawWaveSummary,
  "combo-halo": drawComboHalo,
  "generic-pulse": drawGenericPulse,
};
