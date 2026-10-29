import type { Game } from "../Game";
import type { Asteroid } from "../Asteroid";
import { WORLD_W, WORLD_H } from "../vec";
import { killShip } from "./lifecycle";
import { popShield } from "./collisions";
import { BEAT_GRID } from "./rhythmConstants";
import { shipTouches } from "../ship/shipHitbox";

// The boss eye's primary weapon. The eye emits a sustained energy beam that
// fires STRAIGHT down the aim the telegraph has been ticking onto the player
// (once per windup beat — see Asteroid.tickLaserAim). The beam snaps on along
// that locked line, holds, then fades; the ship is burned on any frame its
// hull crosses the ray. Firing straight means the telegraph is an exact
// predictor of the shot — dodge off the line before the lock and you're safe.

// How far the beam reaches. Long enough to always cross the whole screen
// from a centre-ish eye.
const BEAM_LENGTH = 1800;
// Brief charge flash before the beam is "live" (deals damage) — the line
// snaps to full intensity before it can burn.
const IGNITE_TIME = 0.08;
// How long the beam holds along its line before fading — about a beat, a
// readable "stay off the line" window.
const HOLD_TIME = BEAT_GRID * 1.0;
const FADE_TIME = 0.2;
// Hot core half-width; the ship is burned if its hull crosses this.
const BEAM_HALF_WIDTH = 7;

export class BossBeam {
  owner: Asteroid;
  // Origin is refreshed from the owner each frame while it's still alive
  // (see tickBossBeams); cached here so the beam finishes from the last known
  // origin if the eye is destroyed mid-fire.
  originX: number;
  originY: number;
  // Fixed firing angle (the locked aim). The beam does not rotate.
  angle: number;
  hue: number;
  // Total age; phases are ignite → hold → fade.
  age = 0;
  dead = false;

  constructor(owner: Asteroid, aimAngle: number, hue: number) {
    this.owner = owner;
    this.originX = owner.pos.x;
    this.originY = owner.pos.y;
    this.hue = hue;
    this.angle = aimAngle;
  }

  // Overall brightness envelope, 0..1.
  intensity(): number {
    if (this.age < IGNITE_TIME) return this.age / IGNITE_TIME;
    const fadeStart = IGNITE_TIME + HOLD_TIME;
    if (this.age < fadeStart) return 1;
    return Math.max(0, 1 - (this.age - fadeStart) / FADE_TIME);
  }

  // True once the beam is live and able to burn the ship — after the ignite
  // flash and until the fade begins.
  private damaging(): boolean {
    const fadeStart = IGNITE_TIME + HOLD_TIME;
    return this.age >= IGNITE_TIME && this.age < fadeStart;
  }

  update(dt: number) {
    this.age += dt;
    if (this.age >= IGNITE_TIME + HOLD_TIME + FADE_TIME) {
      this.dead = true;
    }
  }

  get alive() {
    return !this.dead;
  }

  // Shortest distance from any wrap image of the ship centre to the beam
  // ray — the beam segment can run past the seam, so the folded ship may sit
  // on a line the raw math would miss.
  distanceToShip(sx: number, sy: number): number {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    let best = Infinity;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iy = -1; iy <= 1; iy++) {
        const px0 = sx + ix * WORLD_W;
        const py0 = sy + iy * WORLD_H;
        const dx = px0 - this.originX;
        const dy = py0 - this.originY;
        const along = dx * cos + dy * sin;
        const t = Math.max(0, Math.min(BEAM_LENGTH, along));
        const px = this.originX + cos * t;
        const py = this.originY + sin * t;
        const d = Math.hypot(px0 - px, py0 - py);
        if (d < best) best = d;
      }
    }
    return best;
  }

  // Closest point on the beam's centre-line segment to (x, y).
  private nearestPoint(x: number, y: number): { x: number; y: number } {
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const t = Math.max(0, Math.min(BEAM_LENGTH, (x - this.originX) * cos + (y - this.originY) * sin));
    return { x: this.originX + cos * t, y: this.originY + sin * t };
  }

  hitsShip(game: Game): boolean {
    if (!this.damaging()) return false;
    const ship = game.ship;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iy = -1; iy <= 1; iy++) {
        const sx = ship.pos.x + ix * game.w;
        const sy = ship.pos.y + iy * game.h;
        // Any part of the ship's visible outline touching the beam's band counts.
        const nearest = this.nearestPoint(sx, sy);
        const dx = nearest.x - sx;
        const dy = nearest.y - sy;
        if (Math.hypot(dx, dy) > ship.hitBound + BEAM_HALF_WIDTH) continue;
        const beam = {
          pos: nearest,
          collidesWith: (p: { x: number; y: number }, r: number) => {
            const q = this.nearestPoint(p.x, p.y);
            return Math.hypot(p.x - q.x, p.y - q.y) < r + BEAM_HALF_WIDTH;
          },
        };
        if (shipTouches(ship, beam, dx, dy, ship.hazardPad(dx, dy))) return true;
      }
    }
    return false;
  }
}

export const fireBossSweepBeam = (game: Game, a: Asteroid, aimAngle: number) => {
  game.bossBeams.push(new BossBeam(a, aimAngle, a.hue));
};

export const tickBossBeams = (game: Game, dt: number) => {
  for (const beam of game.bossBeams) {
    // Follow the owning eye while it's still on the field; once it's gone the
    // beam keeps sweeping from its last origin.
    if (game.asteroids.includes(beam.owner)) {
      beam.originX = beam.owner.pos.x;
      beam.originY = beam.owner.pos.y;
    }
    beam.update(dt);
  }
  let shipHit = false;
  const vulnerable = game.ship.alive && game.ship.invuln <= 0;
  for (const beam of game.bossBeams) {
    if (vulnerable && !shipHit && beam.hitsShip(game)) {
      shipHit = true;
      if (game.ship.shieldActive) {
        game.ship.shieldActive = false;
        game.ship.invuln = 0.8;
        popShield(game);
      } else {
        killShip(game);
      }
    }
  }
  game.bossBeams = game.bossBeams.filter((b) => b.alive);
};

export const renderBossBeams = (ctx: CanvasRenderingContext2D, beams: BossBeam[]) => {
  if (beams.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const beam of beams) {
    const intensity = beam.intensity();
    if (intensity <= 0.01) continue;
    const cos = Math.cos(beam.angle);
    const sin = Math.sin(beam.angle);
    const ox = beam.originX;
    const oy = beam.originY;
    const ex = ox + cos * BEAM_LENGTH;
    const ey = oy + sin * BEAM_LENGTH;
    const hue = beam.hue;

    // Wide diffuse aura.
    ctx.strokeStyle = `hsla(${hue + 6}, 100%, 60%, ${(0.14 * intensity).toFixed(3)})`;
    ctx.lineWidth = 34;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Mid glow.
    ctx.strokeStyle = `hsla(${hue + 12}, 100%, 65%, ${(0.4 * intensity).toFixed(3)})`;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Hot core.
    ctx.strokeStyle = `hsla(${hue + 30}, 100%, 85%, ${(0.85 * intensity).toFixed(3)})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // White-hot centre line.
    ctx.strokeStyle = `hsla(48, 100%, 98%, ${(intensity).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Muzzle bloom at the eye.
    const muzzleR = 26 * intensity;
    const muzzle = ctx.createRadialGradient(ox, oy, 0, ox, oy, muzzleR);
    muzzle.addColorStop(0, `hsla(48, 100%, 98%, ${(0.9 * intensity).toFixed(3)})`);
    muzzle.addColorStop(0.4, `hsla(${hue + 25}, 100%, 75%, ${(0.5 * intensity).toFixed(3)})`);
    muzzle.addColorStop(1, `hsla(${hue}, 100%, 55%, 0)`);
    ctx.fillStyle = muzzle;
    ctx.beginPath();
    ctx.arc(ox, oy, muzzleR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};
