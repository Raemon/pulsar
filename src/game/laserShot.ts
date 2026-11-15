import type { Game } from "../Game";
import type { Ship } from "../Ship";
import { Vec, v, fromAngle, add, mul } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { isDown } from "./controlBindings";
import { isInBeatWindow } from "./rhythmGate";
import { registerOnBeatFire, registerOffBeatFire } from "./gameUpdate";
import { drawGlow } from "../glow";
import {
  laserGlowSprite, superLaserGlowSprite, laserCoreSprite, laserShimmerSprite, laserFlareSprite,
  LASER_SHIMMER_TILE, beamTaperAt,
} from "./laserSprites";
// Beam shimmer seed only — cosmetic stream so it can't desync replays.
import { cosmeticRng as rng } from "./rng";
import { applyStrikes, strikeShot, strikeTargets } from "./weaponStrike";
import { prongOffsets, shotLife, muzzleOf } from "../ship/shipWeapons";
import { FUEL_LASER_CHARGE_DRAIN, laserFireFuelCost, spendShipFuel } from "./fuel";
import { emitLaserImpact } from "./particleBursts";
import { scheduleLaserDots, cancelLaserChargeCues } from "./laserChargeCues";

// Absolute charge-dot ceiling (one per beat held). The dots a player can
// actually REACH is gated by rhythm via maxLaserDots().
export const LASER_MAX_DOTS = 4;

// Damage by charge dots. Starts heavier than a bullet even at 0 dots, then ramps
// hard so a full charge is a screen-clearing payoff: 5, 11, 24, 52, 110 across
// 0..4 dots. (Base 5, roughly ×2.2 per dot — steeper than the old ×2 from 2.)
// Single source of truth so the gem-crack gate, sound gain, and fire all agree.
export const laserDamage = (dots: number): number =>
  Math.round(5 * Math.pow(2.2, Math.min(dots, LASER_MAX_DOTS)));

// Refire period in quarter-note beats: after a shot, the beats in between are
// locked out and a fresh charge press can only land once this many beats have
// passed since the fire beat.
export const LASER_REFIRE_BEATS = 2;

// Fraction of the refire lockout still pending — 1 right after a shot, easing
// to 0 as the next allowed fire beat approaches. Drives the reticule's
// re-arming dim so the lockout is visible, not just a dead trigger.
export const laserCooldownFrac = (game: Game): number => {
  const remaining = game.ship.laserCooldownEndBeat - game.perceivedBeatTime / BEAT_GRID;
  return Math.max(0, Math.min(1, remaining / LASER_REFIRE_BEATS));
};

// True once the refire lockout has fully released and a fresh charge press
// would land — i.e. the laser is charged and ready to fire again.
export const laserReady = (game: Game): boolean =>
  Math.round(game.perceivedBeatTime / BEAT_GRID) >= game.ship.laserCooldownEndBeat;

// Seconds for the one-shot ready burst to fade after the lockout releases.
const READY_FLASH_DECAY = 0.55;

// The rhythm-gated cap on reachable charge dots. Higher combo unlocks deeper
// charge tiers, so a long beam is something rhythm earns.
export const maxLaserDots = (game: Game): number => {
  if (game.beatCombo >= 24) return 4;
  if (game.beatCombo >= 12) return 3;
  if (game.beatCombo >= 4) return 2;
  return 1;
};
// Visible beam stays painted for this many seconds after fire — long enough
// to read as a flash, short enough that another shot a beat later doesn't
// overlap the previous trail.
const LASER_BEAM_LIFE = 0.1;
// Purely visual tail after the damaging life ends: the beam pinches down to a
// hairline and winks out over this long. No damage is dealt during it.
const LASER_BEAM_FADE = 0.1;
// The laser deliberately overshoots the reticule slot: bulletSpeed *
// shotLife * LASER_BASE_RANGE_MULT, so the pierce/longshot/superBoosted range
// upgrades stretch it exactly as they stretch a bullet. The base mult is
// further scaled by a per-dot range factor so an uncharged shot is short.
const LASER_BASE_RANGE_MULT = 1.8;
// Range factor by dot count: a 0-dot shot reaches half the old length, a
// full charge overshoots it.
const LASER_RANGE_BY_DOTS = [0.5, 0.7, 0.85, 1.0, 1.2];
// How fast the ambient charge glow eases toward its per-dot target.
const CHARGE_GLOW_RATE = 6;
// Fire flash decays to zero over this many seconds.
export const FIRE_FLASH_DECAY = 0.18;
// Half-width (px) of the beam's hit swath by dot count — wider even at a tap so
// the laser feels like a beam rather than a thread, then escalating faster per
// dot (quadratic growth on top of a per-dot floor) so a full charge sweeps a
// genuinely fat lane that catches a whole cluster. 0..4 dots → 7, 16, 29, 46, 67.
const beamHalfWidth = (dots: number): number => 7 + dots * 7 + dots * dots * 2;

// Flat hit allowance on top of the target surface, mirroring the generosity a
// bullet's hitRadius() gives its collision test. Without it the beam's centre
// line has to thread within a target's nominal radius — small fast targets
// slip clean through the 0-dot beam every time.
const LASER_HIT_PAD = 8;

// A laser beam anchored to the firing ship: its origin (muzzle) and heading
// track the ship each frame while it lives, so as the ship turns or drifts the
// beam sweeps and damages anything it crosses. Each target is hit at most once
// per beam, tracked in `alreadyHit`. Lives LASER_BEAM_LIFE seconds.
export class LaserBeam {
  ship: Ship;
  origin: Vec;
  heading: number;
  length: number;
  life: number;
  maxLife: number;
  damage: number;
  // Charge dots 0..LASER_MAX_DOTS — drives the visual tier ramp (thickness,
  // glow width, flare) so the damage tiers read distinctly.
  dots: number;
  // Phase for the scintillation scroll so overlapping prong beams don't glitter in lockstep.
  seed: number;
  // Targets already damaged so a sweeping beam doesn't re-hit them each frame.
  // Any strikeable entity (see weaponStrike) regardless of type.
  alreadyHit: Set<object>;
  // Targets that existed when the beam first fired. The sweep only ever damages
  // these, so things spawned mid-beam (kill-spawned children, freshly-warped
  // enemies) can't be hit as the beam ages — only what was there at fire time.
  eligible: Set<object>;
  // Whether the fire-release landed on-beat. Carried onto every hit's fake
  // bullet so beam strikes gain rhythm exactly like an on-beat bullet's hit.
  firedOnBeat: boolean;
  // Angular offset from the ship's heading. Prong fires one beam per offset, each
  // fanned out like the bullet prong fan; 0 for the lone straight-ahead beam.
  headingOffset: number;
  // The torus-charge super beam: a screen-spanning bolt fired by spending a
  // super-laser charge (flying through a torus ring's energy thread), distinct
  // from the held-charge lasershot upgrade. Renders far beefier than the top
  // charge tier and pierces everything in its path. See fireSuperLaser.
  isSuper = false;

  constructor(ship: Ship, length: number, damage: number, dots: number, game: Game, headingOffset = 0) {
    this.ship = ship;
    this.headingOffset = headingOffset;
    this.heading = ship.heading + headingOffset;
    this.origin = muzzleOf(ship, headingOffset);
    this.length = length;
    this.life = LASER_BEAM_LIFE;
    this.maxLife = LASER_BEAM_LIFE;
    this.damage = damage;
    this.dots = dots;
    this.seed = rng();
    this.alreadyHit = new Set();
    this.firedOnBeat = false;
    // Eligibility is captured from every strikeable group at fire time, so adding
    // a new damageable entity to weaponStrike makes the beam hit it automatically
    // — no per-type wiring here.
    this.eligible = new Set(strikeTargets(game, true));
  }

  // Re-anchor to the ship, sweep-damage anything newly crossed, then age out.
  // Once life runs out the beam only lingers as its visual fade tail.
  update(dt: number, game: Game) {
    this.heading = this.ship.heading + this.headingOffset;
    this.origin = muzzleOf(this.ship, this.headingOffset);
    if (this.life > 0) applyBeamDamage(game, this, fromAngle(this.heading, 1));
    this.life -= dt;
  }

  get alive() {
    return this.life > -LASER_BEAM_FADE;
  }
}

// World position of one beam's far endpoint — same origin + length fireLaser
// uses so the laser reticule lands on the actual beam tip.
const laserBeamEndpointAt = (ship: Ship, length: number, headingOffset: number): Vec => {
  const dir = fromAngle(ship.heading + headingOffset, 1);
  return add(muzzleOf(ship, headingOffset), mul(dir, length));
};

// The laser's aim fan: one entry per beam a fire press will spawn (prong adds
// beams). fireLaser, fireSuperLaser and renderLaserReticule all iterate THIS
// list, so the sight can never show fewer aim points than the weapon fires —
// the prong/reticule contract lives here, not in each caller.
export type LaserAim = {
  headingOffset: number;
  dir: Vec;
  endpointAt: (length: number) => Vec;
};
export const laserAimFan = (ship: Ship): LaserAim[] =>
  prongOffsets(ship.prongCount).map((headingOffset) => ({
    headingOffset,
    dir: fromAngle(ship.heading + headingOffset, 1),
    endpointAt: (length: number) => laserBeamEndpointAt(ship, length, headingOffset),
  }));

// Number of dots currently charged (0..maxDots). One dot ticks in per beat
// held; maxDots is the rhythm-gated cap (see maxLaserDots). Public so the
// renderer can paint the dots in front of the ship.
export const laserDotCount = (ship: Ship, beatTime: number, maxDots: number): number => {
  if (!ship.laserChargeActive) return 0;
  const elapsed = Math.max(0, beatTime - ship.laserChargeStartBeatTime);
  return Math.min(maxDots, Math.floor(elapsed / BEAT_GRID));
};

export const resetLaserCharge = (ship: Ship) => {
  ship.laserChargeActive = false;
  ship.laserChargeStartBeatTime = 0;
  ship.laserLastDotIndexFired = -1;
  ship.laserChargeFailedThisHold = false;
  // both hold-ends (release + death) route through here — flush any queued
  //   future accents so a released charge doesn't keep clicking on later beats.
  cancelLaserChargeCues();
};

const computeBeamLength = (ship: Ship, superBoosted: boolean, dots: number): number => {
  const dotMult = LASER_RANGE_BY_DOTS[Math.min(dots, LASER_MAX_DOTS)];
  return ship.bulletSpeed * shotLife(ship, superBoosted) * LASER_BASE_RANGE_MULT * dotMult;
};

// Beam reach for each charge tier the current combo can reach, shortest first
// (0 dots → maxLaserDots). The laser reticule paints a dash mark at the end of
// each, so the player previews how far each charge level shoots — and the marks
// push outward when Farshot / combo-superboost extend range. Single source of
// truth for "how far the beam reaches": shares computeBeamLength with fireLaser.
export const reachableBeamLengths = (game: Game): number[] => {
  const ship = game.ship;
  const superBoosted = game.beatCombo >= 12;
  const maxDots = maxLaserDots(game);
  const lengths: number[] = [];
  for (let dots = 0; dots <= maxDots; dots++) {
    lengths.push(computeBeamLength(ship, superBoosted, dots));
  }
  return lengths;
};

// Eases laserChargeGlow toward target with frame-rate-independent decay.
const approachGlow = (current: number, target: number, dt: number): number => {
  const k = 1 - Math.exp(-CHARGE_GLOW_RATE * Math.max(0, dt));
  return current + (target - current) * k;
};

// Called each frame after Ship.update. The normal fireBullets path is
// suppressed by lasershotActive inside shipPhysics; this owns fire input
// while the upgrade is active.
// Seconds for the hull to drain to grey / bloom back to cyan across the refire
// lockout edge — short enough to read as a state change, long enough not to snap.
const COOLDOWN_DIM_FADE = 0.18;

export const tickLaserShot = (game: Game, dt: number) => {
  const ship = game.ship;
  // Hull colour follows the refire lockout: grey while the laser is spent,
  // cyan again the instant it can refire. Updated before every early return
  // below so the ship never strands mid-grey.
  const dimTarget = ship.lasershotActive && ship.alive && !laserReady(game) ? 1 : 0;
  const dimStep = dt / COOLDOWN_DIM_FADE;
  ship.laserCooldownDim = dimTarget > ship.laserCooldownDim
    ? Math.min(dimTarget, ship.laserCooldownDim + dimStep)
    : Math.max(dimTarget, ship.laserCooldownDim - dimStep);
  // A banked torus super-laser charge takes priority over the held-charge
  // upgrade — defer this frame so the fire press spends the super charge (see
  // tickSuperLaserFire) instead of starting a held charge.
  if (ship.superLaserCharged) return;
  if (!ship.alive) {
    game.sound.stopLaserCharge();
    game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
    resetLaserCharge(ship);
    // Keep the ready edge armed so a respawn doesn't pop a stray ready burst.
    ship.laserWasReady = true;
    ship.laserReadyFlash = 0;
    return;
  }
  if (!ship.lasershotActive) return;
  // Fire a one-shot ready burst on the locked→ready edge, then decay it. The
  // reticule reads laserReadyFlash to pop an "armed" ring the instant the
  // refire lockout releases, so the player sees the exact moment it can refire.
  const ready = laserReady(game);
  if (ready && !ship.laserWasReady) ship.laserReadyFlash = 1;
  ship.laserWasReady = ready;
  ship.laserReadyFlash = Math.max(0, ship.laserReadyFlash - dt / READY_FLASH_DECAY);
  const firePressed = isDown(game.input, "fire");

  if (firePressed) {
    if (!ship.laserChargeActive && !ship.laserChargeFailedThisHold) {
      // Refire lockout: the last shot rejects charge presses until its end
      // beat. Fails the whole hold (release and re-press to retry) but leaves
      // the streak alone — a locked-out weapon isn't a timing mistake.
      if (Math.round(game.perceivedBeatTime / BEAT_GRID) < ship.laserCooldownEndBeat) {
        ship.laserChargeFailedThisHold = true;
        game.sound.playLaserChargeFail();
        game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
        return;
      }
      // Charge must START on-beat. The release can land anywhere — that's just
      // how many dots you held for. Rejecting only the start gives the player
      // a clear, learnable rule without making release timing punishing.
      if (!isInBeatWindow(game, game.perceivedBeatTime)) {
        ship.laserChargeFailedThisHold = true;
        game.sound.playLaserChargeFail();
        // A mistimed press breaks the streak just like an off-beat bullet fire —
        // the charge buzz alone isn't enough feedback when a combo is riding.
        registerOffBeatFire(game);
        game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
        return;
      }
      ship.laserChargeActive = true;
      ship.laserChargeStartBeatTime = game.beatTime;
      ship.laserLastDotIndexFired = -1;
      game.sound.startLaserCharge();
    }
    if (!ship.laserChargeActive) {
      game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
      return;
    }
    // Holding the charge sips fuel — a slow drain that competes with thrust for
    // the reserve, so parking on a max charge isn't free. The release toll in
    // fireLaser stacks on top of this.
    spendShipFuel(ship, FUEL_LASER_CHARGE_DRAIN * dt);
    // Per-dot charge tick — discrete C-chord pluck accent on each new dot, plus a
    // step-up of the sustained crackle/chord bed. The accent AUDIO is lookahead-
    // scheduled (scheduleLaserDots → tickLaserChargeCues) so it lands ON the beat
    // instead of a frame late; scheduleLaserDots pre-arms every dot up to the
    // current cap, so a combo-driven cap bump mid-hold schedules cleanly too.
    const maxDots = maxLaserDots(game);
    scheduleLaserDots(ship, maxDots);
    const dots = laserDotCount(ship, game.beatTime, maxDots);
    // Ambient glow ramps toward 1 as more dots arm; faint even at zero dots.
    const target = (dots + 1) / (LASER_MAX_DOTS + 1);
    game.laserChargeGlow = approachGlow(game.laserChargeGlow, target, dt);
    return;
  }

  // Fire-released: if we were charging, fire the beam.
  if (ship.laserChargeActive) {
    const dots = laserDotCount(ship, game.beatTime, maxLaserDots(game));
    fireLaser(game, ship, dots);
  } else {
    game.laserChargeGlow = approachGlow(game.laserChargeGlow, 0, dt);
  }
  // Always reset on release so a re-press can try the beat window again.
  game.sound.stopLaserCharge();
  resetLaserCharge(ship);
};

const fireLaser = (game: Game, ship: Ship, dots: number) => {
  // Per-shot fuel toll, scaling with charge — an uncharged tap is near-free, a
  // maxed beam takes a real bite. Spent on release (the charge sip was paid
  // while holding); never blocks the shot, just drains whatever's left.
  spendShipFuel(ship, laserFireFuelCost(dots));
  const damage = laserDamage(dots);
  const superBoosted = game.beatCombo >= 12;
  const length = computeBeamLength(ship, superBoosted, dots);
  // Fire timing primes/latches rhythm exactly like a bullet (shared with the
  // bullet path): an on-beat fire primes the streak, an off-beat fire latches a
  // break for the next beat closure. Rhythm is *gained* by the beam's on-beat
  // HITS — see the firedOnBeat flag carried into applyBeamDamage — not here.
  const firedOnBeat = isInBeatWindow(game, game.perceivedBeatTime);
  if (firedOnBeat) registerOnBeatFire(game);
  else registerOffBeatFire(game);
  // Arm the refire lockout, anchored to the fire's nearest beat so the next
  // allowed press sits on a clean beat regardless of where the release landed.
  ship.laserCooldownEndBeat = Math.round(game.perceivedBeatTime / BEAT_GRID) + LASER_REFIRE_BEATS;
  // One beam per aim-fan entry — the exact fan the laser reticule draws.
  for (const aim of laserAimFan(ship)) {
    const beam = new LaserBeam(ship, length, damage, dots, game, aim.headingOffset);
    beam.firedOnBeat = firedOnBeat;
    game.lasers.push(beam);
  }
  game.sound.playLaserShot(damage, dots);
  game.shake = Math.min(game.shake + 0.22 + dots * 0.2, 1.6);
  // Big white pop on release, scaled by charge; the buildup glow ends here.
  game.laserFireFlash = Math.min(1, 0.5 + dots * 0.22);
  // Muzzle discharge — a forward gout of plasma blasting off the barrel on
  // release, so a charged shot recoils visibly out of the ship, not just a flash.
  const tier = dots / LASER_MAX_DOTS;
  const fwd = fromAngle(ship.heading, 1);
  const muzzle = muzzleOf(ship);
  emitLaserImpact(game.particles, muzzle, { x: -fwd.x, y: -fwd.y }, 0.5 + tier * 0.5);
  game.laserChargeGlow = 0;
};

// Damage dealt by a torus-charge super-laser. Well above a full held charge
// (110) so a single super beam shears clean through a screen-line of rocks and
// bites deep into armoured kinds.
export const SUPER_LASER_DAMAGE = 150;

// Fire the screen-spanning super-laser the ship banked by flying through a torus
// ring's energy thread. Unlike the held-charge lasershot, this is a one-shot
// expendable available to ANY ship (no upgrade required) — the caller consumes
// ship.superLaserCharged. The beam spans the screen diagonal so it reaches the
// far edge from anywhere, pierces everything (eligible = all targets), and
// renders at a beefed-up tier via the `super` flag. Prong fans extra beams.
export const fireSuperLaser = (game: Game, ship: Ship) => {
  // Span the screen so the bolt always reaches the far edge regardless of where
  // the ship sits. (Camera is scroll-locked, so the visible frame is ~w×h.)
  const length = Math.hypot(game.w, game.h);
  const firedOnBeat = isInBeatWindow(game, game.perceivedBeatTime);
  if (firedOnBeat) registerOnBeatFire(game);
  else registerOffBeatFire(game);
  for (const aim of laserAimFan(ship)) {
    // Top dot tier so it inherits all the high-charge render layers, plus the
    // `super` flag pushes thickness/aura past the normal ceiling.
    const beam = new LaserBeam(ship, length, SUPER_LASER_DAMAGE, LASER_MAX_DOTS, game, aim.headingOffset);
    beam.isSuper = true;
    beam.firedOnBeat = firedOnBeat;
    game.lasers.push(beam);
  }
  game.sound.playLaserShot(SUPER_LASER_DAMAGE, LASER_MAX_DOTS);
  game.shake = Math.min(game.shake + 0.7, 1.6);
  game.laserFireFlash = 1;
  game.laserChargeGlow = 0;
};

// Sweep-damages every target the beam segment crosses this frame, skipping any
// already hit by this beam. The swath widens with charge (beamHalfWidth). Every
// strike routes through the shared weaponStrike pipeline, so the laser scores
// and splits exactly like a bullet. Pickups included: a beam through a canister
// wastes it, as a bullet would.
//
// The beam's hit swath: a point is struck if it's within halfWidth + pad of the
// beam segment. We pose that as a circle of that radius riding the beam's closest
// approach to the target, then let the target's own collidesWith decide — so the
// test honours each entity's real hitbox (faceted asteroid surface, tight alien
// body, gem/comet/canister circles) exactly as the bullet path does.
const applyBeamDamage = (game: Game, beam: LaserBeam, dir: Vec) => {
  const { origin, length } = beam;
  const { w, h } = game;
  const swathR = beamHalfWidth(beam.dots) + LASER_HIT_PAD;
  applyStrikes(game, true, (target) => {
    if (beam.alreadyHit.has(target) || !beam.eligible.has(target)) return null;
    // The segment may run past the seam: sweep each wrap image of the target
    // and fold the contact point back in-domain so impact effects land on the
    // visible body.
    let contact: Vec | null = null;
    for (let ix = -1; ix <= 1 && !contact; ix++) {
      for (let iy = -1; iy <= 1 && !contact; iy++) {
        const offX = ix * w;
        const offY = iy * h;
        const t = closestApproach(origin, dir, length, { x: target.pos.x + offX, y: target.pos.y + offY });
        const closest = v(origin.x + dir.x * t - offX, origin.y + dir.y * t - offY);
        if (target.collidesWith(closest, swathR)) contact = closest;
      }
    }
    if (!contact) return null;
    beam.alreadyHit.add(target);
    // Hot beam-strike gout at the contact point, on top of the target's own
    // kill/crack burst — sells the laser as a heavier hit than a bullet.
    emitLaserImpact(game.particles, contact, dir, beam.dots / LASER_MAX_DOTS);
    // Beams carry no drift tier and no halo tier: an on-beat strike scores
    // rhythm-multiplied like a plain on-beat bullet.
    const shot = strikeShot(contact, dir, { onBeat: beam.firedOnBeat, boosted: false, superBoosted: false, driftLockedSlots: [] });
    // A beam strike is an on-beat HIT under the same rule a bullet uses: the
    // shot was fired on-beat AND it connects inside a beat window.
    const onBeat = isInBeatWindow(game, game.perceivedBeatTime) && beam.firedOnBeat;
    // The laser is a charged shot — give the boss family the meaty armored
    // impact every time it connects, on-beat or not.
    return { damage: beam.damage, onBeat, shot, bossImpact: true };
  });
};

// The t-parameter along the beam (clamped to [0, length]) where the beam passes
// closest to `pos` — the point we test the swath against and use as the impact
// position for kill effects.
const closestApproach = (origin: Vec, dir: Vec, length: number, pos: Vec): number => {
  const tRaw = (pos.x - origin.x) * dir.x + (pos.y - origin.y) * dir.y;
  return Math.max(0, Math.min(length, tRaw));
};

const TAU = Math.PI * 2;
// The laser's resting cyan, shared with the hull and the reticule's near gate.
const LASER_HUE = 192;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
// Stable pseudo-random 0..1 per (index, channel) so motes and wisps keep their
// identity frame to frame without touching any RNG stream.
const hash01 = (i: number, k: number): number => {
  const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// Lays a prebaked beam-style sprite from `from` along `dir` for `length`,
// `height` thick, centred on the axis.
const blitAlong = (
  ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement,
  from: Vec, angle: number, length: number, height: number, alpha: number,
) => {
  if (alpha <= 0.002 || length <= 0 || height <= 0) return;
  ctx.save();
  ctx.translate(from.x, from.y);
  ctx.rotate(angle);
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sprite, 0, -height / 2, length, height);
  ctx.restore();
};

// Anamorphic streak laid across the beam axis at `at` — the lens-flare tell of
// an intensely bright point source.
const paintCrossFlare = (
  ctx: CanvasRenderingContext2D, at: Vec, angle: number, span: number, thick: number, alpha: number,
) => {
  if (alpha <= 0.002 || span <= 0) return;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(angle + Math.PI / 2);
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(laserFlareSprite(), -span / 2, -thick / 2, span, thick);
  ctx.restore();
};

// Charge buildup at one emitter. `c` is 0..1 charge across the reachable dots
// (climbing smoothly between beats), `kick` 1→0 just after a dot lands.
// Light motes spiral in and accelerate onto the muzzle, which swells into a
// white-hot point; two focusing lines pinch from a wide cone down onto the beam
// axis, their focus reaching further out the harder the shot is charged.
const paintChargeEmitter = (
  ctx: CanvasRenderingContext2D, m: Vec, angle: number, c: number, kick: number, fadeIn: number, t: number,
) => {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = -dy;
  const py = dx;

  const spread = 5 + 20 * (1 - c);
  const focal = 30 + 110 * c;
  const fx = m.x + dx * focal;
  const fy = m.y + dy * focal;
  const lineA = (0.12 + 0.28 * c + 0.3 * kick) * fadeIn;
  ctx.lineCap = "round";
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgb(150, 230, 255)";
  ctx.globalAlpha = lineA;
  ctx.beginPath();
  for (const side of [-1, 1]) {
    ctx.moveTo(m.x - dx * 4 + px * spread * side, m.y - dy * 4 + py * spread * side);
    ctx.lineTo(fx, fy);
  }
  ctx.stroke();
  // Faint pilot filament down the axis, through the focus and on past it.
  blitAlong(ctx, laserCoreSprite(), m, angle, focal + 70 + 110 * c, 1.6 + c, (0.2 + 0.45 * c + 0.3 * kick) * fadeIn);
  // A dot landing sends a pulse racing down both focusing lines onto the focus.
  if (kick > 0) {
    const k = 1 - kick;
    for (const side of [-1, 1]) {
      const sx = m.x - dx * 4 + px * spread * side;
      const sy = m.y - dy * 4 + py * spread * side;
      drawGlow(ctx, sx + (fx - sx) * k, sy + (fy - sy) * k, 5, 0, 0.8 * kick, true);
    }
    drawGlow(ctx, fx, fy, 6 + 10 * k, LASER_HUE, 0.6 * k * kick * 4);
  }

  const motes = 10 + Math.round(16 * c);
  const reach = 44 + 40 * c;
  const rate = 1.1 + 1.7 * c;
  ctx.strokeStyle = "rgb(195, 242, 255)";
  for (let i = 0; i < motes; i++) {
    const p = (t * rate + hash01(i, 1)) % 1;
    // biased forward of the muzzle so the inflow doesn't stream through the hull
    const base = angle + (hash01(i, 2) - 0.5) * TAU * 0.8;
    const lead = Math.max(0, 1 - p - 0.06 - 0.06 * c);
    const r0 = reach * Math.pow(1 - p, 1.7) + 2;
    const r1 = reach * Math.pow(lead, 1.7) + 2;
    const a0 = base + (1 - p) * 0.9;
    const a1 = base + lead * 0.9;
    ctx.globalAlpha = Math.sin(p * Math.PI) * (0.3 + 0.55 * c) * fadeIn * (0.55 + 0.45 * hash01(i, 3));
    ctx.lineWidth = 0.8 + 1.1 * c * hash01(i, 4);
    ctx.beginPath();
    ctx.moveTo(m.x + Math.cos(a0) * r0, m.y + Math.sin(a0) * r0);
    ctx.lineTo(m.x + Math.cos(a1) * r1, m.y + Math.sin(a1) * r1);
    ctx.stroke();
  }

  const flicker = 0.88 + 0.12 * Math.sin(t * 53) * Math.sin(t * 31);
  const heat = (0.25 + 0.75 * c) * fadeIn;
  drawGlow(ctx, m.x, m.y, (8 + 24 * c + 14 * kick) * flicker, LASER_HUE, 0.3 + 0.45 * heat + 0.3 * kick);
  drawGlow(ctx, m.x, m.y, (3 + 7 * c + 6 * kick) * flicker, 0, 0.55 + 0.45 * heat, true);
  paintCrossFlare(ctx, m, angle, (12 + 64 * c + 46 * kick) * flicker, 5 + 2 * c, (0.25 + 0.6 * c + 0.4 * kick) * fadeIn);
  ctx.globalAlpha = Math.min(1, 0.55 + heat);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(m.x, m.y, 1.1 + 2 * c + 1.4 * kick, 0, TAU);
  ctx.fill();
  // Imploding ring as each dot locks in — energy snapping onto the emitter.
  if (kick > 0) {
    ctx.globalAlpha = kick * 0.75;
    ctx.strokeStyle = "rgb(200, 245, 255)";
    ctx.lineWidth = 0.8 + kick;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 4 + 26 * kick, 0, TAU);
    ctx.stroke();
  }
};

// Seconds a freshly armed charge pip stays enlarged before settling.
const PIP_POP = 0.18;
// Charge pips: one bead per armed dot, strung along the beam axis ahead of the
// muzzle so the tier count stays readable at a glance.
const paintChargePips = (
  ctx: CanvasRenderingContext2D, game: Game, dots: number, beatTime: number,
) => {
  const ship = game.ship;
  const dir = fromAngle(ship.heading, 1);
  const baseOffset = ship.radius + 14;
  const dotGap = 14;
  for (let i = 0; i < dots; i++) {
    const x = ship.pos.x + dir.x * (baseOffset + i * dotGap);
    const y = ship.pos.y + dir.y * (baseOffset + i * dotGap);
    const age = Math.max(0, beatTime - (ship.laserChargeStartBeatTime + (i + 1) * BEAT_GRID));
    const pop = Math.max(0, 1 - age / PIP_POP);
    const breathe = 0.85 + 0.15 * Math.sin(beatTime * 9 + i * 1.7);
    drawGlow(ctx, x, y, (6 + 9 * pop) * breathe, LASER_HUE, 0.45 + 0.45 * pop);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + 1.8 * pop, 0, TAU);
    ctx.fill();
  }
};

const paintCharge = (ctx: CanvasRenderingContext2D, game: Game, beatTime: number) => {
  const ship = game.ship;
  const maxDots = maxLaserDots(game);
  const dots = laserDotCount(ship, beatTime, maxDots);
  const start = ship.laserChargeStartBeatTime;
  const nextDotFrac = dots >= maxDots ? 0 : clamp01((beatTime - (start + dots * BEAT_GRID)) / BEAT_GRID);
  const c = Math.min(1, (dots + nextDotFrac) / Math.max(1, maxDots));
  const held = Math.max(0, beatTime - start);
  const fadeIn = Math.min(1, held / 0.12);
  const sinceDot = dots > 0 ? beatTime - (start + dots * BEAT_GRID) : Infinity;
  const kick = Math.max(0, 1 - sinceDot / 0.16);
  drawGlow(ctx, ship.pos.x, ship.pos.y, ship.radius * (2.2 + 1.6 * c), LASER_HUE, (0.05 + 0.14 * c) * fadeIn);
  for (const aim of laserAimFan(ship)) {
    paintChargeEmitter(ctx, muzzleOf(ship, aim.headingOffset), ship.heading + aim.headingOffset, c, kick, fadeIn, beatTime);
  }
  paintChargePips(ctx, game, dots, beatTime);
};

// Matches the reticule's armed ring, so the refill arc closes into it exactly.
const REFILL_RING_R = 9;
// Fraction of the lockout spent visibly cooling off before the refill takes over.
const COOL_SPAN = 0.6;

// Refire lockout at one emitter. The muzzle starts white-hot and cools through
// amber to nothing, shedding wisps of heat, while a thin arc sweeps round the
// muzzle and a cyan pilot light swells back — the cell recharging. Once ready
// only the steady pilot light remains.
const paintReloadEmitter = (
  ctx: CanvasRenderingContext2D, m: Vec, angle: number, cooldown: number, t: number,
) => {
  if (cooldown <= 0) {
    const breathe = 0.8 + 0.2 * Math.sin(t * 4);
    drawGlow(ctx, m.x, m.y, 7 * breathe, LASER_HUE, 0.4);
    drawGlow(ctx, m.x, m.y, 2.5, 0, 0.55, true);
    return;
  }
  const heat = clamp01((cooldown - (1 - COOL_SPAN)) / COOL_SPAN);
  const refill = 1 - cooldown;
  if (heat > 0) {
    // hue slides from yellow-white down to a dull red as the emitter cools
    const emberHue = 12 + 34 * heat;
    drawGlow(ctx, m.x, m.y, 6 + 16 * heat, emberHue, 0.9 * heat ** 1.2);
    drawGlow(ctx, m.x, m.y, 2.5 + 6 * heat, 0, heat ** 1.8, true);
    const px = -Math.sin(angle);
    const py = Math.cos(angle);
    for (let k = 0; k < 6; k++) {
      const life = (t * 1.7 + hash01(k, 5)) % 1;
      const side = k % 2 ? 1 : -1;
      const drift = 4 + 20 * life;
      const sway = Math.sin(t * 7 + k * 2.1) * 3 * life;
      const x = m.x + px * side * drift - Math.cos(angle) * (life * 12 - sway);
      const y = m.y + py * side * drift - Math.sin(angle) * (life * 12 - sway);
      drawGlow(ctx, x, y, 2.5 + 5 * life, emberHue - 6, heat * (1 - life) * 0.7);
    }
  }
  const sweepStart = angle + Math.PI;
  const sweepEnd = sweepStart + TAU * refill;
  ctx.strokeStyle = `hsl(${LASER_HUE}, 100%, 72%)`;
  ctx.globalAlpha = 0.12;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(m.x, m.y, REFILL_RING_R, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 0.35 + 0.55 * refill;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(m.x, m.y, REFILL_RING_R, sweepStart, sweepEnd);
  ctx.stroke();
  const hx = m.x + Math.cos(sweepEnd) * REFILL_RING_R;
  const hy = m.y + Math.sin(sweepEnd) * REFILL_RING_R;
  drawGlow(ctx, hx, hy, 5, LASER_HUE, 0.45 + 0.5 * refill);
  drawGlow(ctx, hx, hy, 1.8, 0, 0.8, true);
  drawGlow(ctx, m.x, m.y, 2 + 5 * refill, LASER_HUE, 0.4 * refill * refill);
};

// Everything the laser draws at the ship's nose between shots: the charge
// buildup while the trigger is held, otherwise the refire cooldown / ready
// pilot light. Painted over the hull, under nothing.
export const renderLaserEmitter = (
  ctx: CanvasRenderingContext2D, game: Game, beatTime: number,
) => {
  const ship = game.ship;
  if (!ship.alive || !ship.lasershotActive) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  if (ship.laserChargeActive) {
    paintCharge(ctx, game, beatTime);
  } else {
    const cooldown = laserCooldownFrac(game);
    for (const aim of laserAimFan(ship)) {
      paintReloadEmitter(ctx, muzzleOf(ship, aim.headingOffset), ship.heading + aim.headingOffset, cooldown, beatTime);
    }
  }
  ctx.restore();
};

// Seconds the ignition overdrive (overbright core, swollen glow, cross flare)
// takes to settle into the steady beam.
const IGNITION = 0.06;
// Lifetime of the shock ring thrown off the emitter on ignition.
const SHOCK_RING_LIFE = 0.14;
// Scroll speeds (px/s) of the two scintillation layers; differing rates make
// them beat against each other into a sparkle rather than a sliding pattern.
const SHIMMER_FAST = 2600;
const SHIMMER_SLOW = 1100;

// Scrolls the tileable shimmer strip along the beam's local +x, fading each
// tile with the beam's own tip taper.
const paintShimmer = (
  ctx: CanvasRenderingContext2D, length: number, height: number, offset: number, alpha: number,
) => {
  if (alpha <= 0.002) return;
  const tile = LASER_SHIMMER_TILE;
  const strip = laserShimmerSprite();
  const shift = ((offset % tile) + tile) % tile;
  for (let x = shift - tile; x < length; x += tile) {
    const sx = Math.max(0, -x);
    const w = Math.min(tile - sx, length - (x + sx));
    if (w <= 0) continue;
    ctx.globalAlpha = Math.min(1, alpha * beamTaperAt((x + sx + w / 2) / length));
    ctx.drawImage(strip, sx, 0, w, strip.height, x + sx, -height / 2, w, height);
  }
};

// The beam itself, in three phases over its life:
//  - ignition: an overbright frame or two — swollen glow, a white flash and
//    anamorphic flare across the emitter, and a shock ring thrown outward;
//  - sustain: a coherent white core with crisp edges inside a saturated cyan
//    Gaussian glow (sized to the hit swath), glittering with scrolling
//    scintillation;
//  - decay (the post-damage fade tail): the glow drains first while the core
//    pinches down to a hairline and winks out.
// Every layer is a prebaked sprite stretched along the beam (see laserSprites),
// so the cost is a handful of blits per beam.
export const renderLasers = (ctx: CanvasRenderingContext2D, lasers: LaserBeam[]) => {
  if (lasers.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const beam of lasers) {
    const age = beam.maxLife - beam.life;
    const decay = beam.life < 0 ? clamp01(-beam.life / LASER_BEAM_FADE) : 0;
    const live = 1 - decay;
    const ignite = Math.max(0, 1 - age / IGNITION);
    const tier = beam.dots / LASER_MAX_DOTS;
    const superMul = beam.isSuper ? 2.4 : 1;
    // The hit swath half-width — the soft glow fills it so the visible lane
    // matches what the beam actually catches.
    const swath = beamHalfWidth(beam.dots) * superMul;
    const core = (3 + beam.dots * 2.2) * (beam.isSuper ? 2.2 : 1);
    const L = beam.length;

    ctx.save();
    ctx.translate(beam.origin.x, beam.origin.y);
    ctx.rotate(beam.heading);
    const glowSprite = beam.isSuper ? superLaserGlowSprite() : laserGlowSprite();
    // The super beam's swath is already huge; it needs less bloom on top to stay a beam, not a whiteout.
    const bloomH = swath * (beam.isSuper ? 2.6 : 4.2) * (1 + 0.5 * ignite) * (1 - 0.5 * decay);
    ctx.globalAlpha = Math.min(1, (beam.isSuper ? 0.3 : 0.28 + 0.2 * tier) * live * live * (1 + 0.9 * ignite));
    ctx.drawImage(glowSprite, 0, -bloomH / 2, L, bloomH);
    const glowH = (swath * (beam.isSuper ? 0.9 : 2) + 6) * (1 + 0.3 * ignite) * (1 - 0.6 * decay);
    ctx.globalAlpha = Math.min(1, 0.85 * live ** 1.5 * (1 + 0.4 * ignite));
    ctx.drawImage(laserGlowSprite(), 0, -glowH / 2, L, glowH);
    const coreSprite = laserCoreSprite();
    const coreH = core * (1 + 0.7 * ignite) * live * live;
    if (coreH > 0.5) {
      ctx.globalAlpha = 1;
      ctx.drawImage(coreSprite, 0, -coreH / 2, L, coreH);
    }
    // Hairline spine — stays crisp through the decay after the body has pinched away.
    ctx.globalAlpha = Math.pow(live, 0.5);
    ctx.drawImage(coreSprite, 0, -1, L, 2);

    const shimmerA = live * live * (0.55 + 0.3 * tier);
    paintShimmer(ctx, L, core * 2.2, age * SHIMMER_FAST + beam.seed * 997, shimmerA);
    paintShimmer(ctx, L, core * 1.3, age * SHIMMER_SLOW + beam.seed * 431 + 128, shimmerA * 0.8);
    ctx.restore();

    // Emitter: ignition flash + cross flare, settling to a hot point while the beam holds.
    const o = beam.origin;
    const flash = ignite + 0.35 * live;
    drawGlow(ctx, o.x, o.y, (12 + swath * 0.9) * (0.7 + 0.8 * ignite), 0, Math.min(1, 0.95 * flash), true);
    drawGlow(ctx, o.x, o.y, (20 + swath * 1.6) * (0.8 + 0.6 * ignite), LASER_HUE, Math.min(1, 0.6 * flash));
    paintCrossFlare(ctx, o, beam.heading, (50 + swath * 3.2) * (0.5 + 0.9 * ignite) * superMul, 6 + 4 * tier, flash * 0.9);
    if (age < SHOCK_RING_LIFE) {
      const k = age / SHOCK_RING_LIFE;
      ctx.globalAlpha = (1 - k) ** 2 * 0.8;
      ctx.strokeStyle = "rgb(200, 245, 255)";
      ctx.lineWidth = 0.6 + 2.2 * (1 - k);
      ctx.beginPath();
      ctx.arc(o.x, o.y, 8 + k * (26 + swath * 1.3), 0, TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
};

// Full-screen additive wash — the room lighting up from the beam. Charge
// buildup adds a faint cyan glow that grows while holding; the fire flash
// pops bright on release and decays fast. Drawn above the entity layers.
export const renderLaserAmbientFlash = (ctx: CanvasRenderingContext2D, game: Game) => {
  const a = game.laserChargeGlow * 0.09 + game.laserFireFlash * 0.3;
  if (a <= 0.001) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = `rgba(150, 220, 255, ${a.toFixed(3)})`;
  ctx.fillRect(0, 0, game.w, game.h);
  ctx.restore();
};
