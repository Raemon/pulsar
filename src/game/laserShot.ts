import type { Game } from "../Game";
import type { Ship } from "../Ship";
import { Vec, v, fromAngle, add, mul } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { isDown } from "./controlBindings";
import { isInBeatWindow } from "./rhythmGate";
import { registerOnBeatFire, registerOffBeatFire } from "./gameUpdate";
import { buildJaggedBolt, strokePolyline } from "./bassLightning";
import { drawGlow } from "../glow";
// Beam seed/jag visuals only — cosmetic stream so it can't desync replays.
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
// Perpendicular jag amplitude (px) for the crackle arcs.
const LASER_JAG_AMPLITUDE = 7;

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
  // crackle, aura) so the damage tiers read distinctly.
  dots: number;
  // Stable per-sample perpendicular jag for the crackle arc; wobble animates
  // on top. Empty until dots warrant an arc.
  jags: number[];
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
    this.seed = rng() * Math.PI * 2;
    this.jags = [];
    this.alreadyHit = new Set();
    this.firedOnBeat = false;
    // Eligibility is captured from every strikeable group at fire time, so adding
    // a new damageable entity to weaponStrike makes the beam hit it automatically
    // — no per-type wiring here.
    this.eligible = new Set(strikeTargets(game, true));
    if (dots >= 1) {
      const n = 14;
      for (let i = 0; i < n; i++) this.jags.push((rng() * 2 - 1) * LASER_JAG_AMPLITUDE);
    }
  }

  // Re-anchor to the ship, sweep-damage anything newly crossed, then age out.
  update(dt: number, game: Game) {
    this.heading = this.ship.heading + this.headingOffset;
    this.origin = muzzleOf(this.ship, this.headingOffset);
    const dir = fromAngle(this.heading, 1);
    applyBeamDamage(game, this, dir);
    this.life -= dt;
  }

  get alive() {
    return this.life > 0;
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

// Small deterministic jag array for a charge crackle arc. Reseeds ~8x/sec via
// a coarse time bucket so the bolt flickers without per-frame randomness.
const CHARGE_ARC_SAMPLES = 8;
const chargeArcJags = (index: number, beatTime: number): number[] => {
  const bucket = Math.floor(beatTime * 8);
  const jags: number[] = [];
  for (let i = 0; i < CHARGE_ARC_SAMPLES; i++) {
    const s = Math.sin((bucket + 1) * 12.9898 + index * 7.13 + i * 78.233) * 43758.5453;
    jags.push(((s - Math.floor(s)) * 2 - 1) * (LASER_JAG_AMPLITUDE * 0.7));
  }
  return jags;
};

// Charge dots float in front of the ship — one per beat charged. Each dot
// pulses on its own beat slot so a freshly-armed dot reads as "just landed".
// Higher-tier dots get extra orbiting sparks + an energy thread connecting
// back to the ship so a full charge reads as visibly "loaded up".
export const renderLaserChargeDots = (
  ctx: CanvasRenderingContext2D, game: Game, beatTime: number,
) => {
  const ship = game.ship;
  if (!ship.lasershotActive) return;
  if (!ship.laserChargeActive) return;
  const dots = laserDotCount(ship, beatTime, maxLaserDots(game));
  const maxDots = maxLaserDots(game);
  const dir = fromAngle(ship.heading, 1);
  const perp = { x: -dir.y, y: dir.x };
  // First dot sits a bit past the muzzle; subsequent dots step outward.
  const baseOffset = ship.radius + 14;
  const dotGap = 14;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Gathering-energy aura around the ship — drawn from the instant charging
  // begins (even before the first dot) so the buildup reads as continuously
  // sucking power in, then swelling and tightening as each dot lands. `charge`
  // ramps 0..1 across the reachable dots; the partial progress toward the NEXT
  // dot keeps it climbing smoothly between beats rather than stepping.
  {
    const nextDotFrac = Math.min(1, Math.max(0,
      (beatTime - (ship.laserChargeStartBeatTime + dots * BEAT_GRID)) / BEAT_GRID));
    const charge = Math.min(1, (dots + nextDotFrac) / Math.max(1, maxDots));
    const cx = ship.pos.x;
    const cy = ship.pos.y;
    // Breathing ring of in-rushing light: a wide soft disc that pulses fast and
    // brightens with charge. Rotating inflow streaks ride on top.
    const auraPulse = 0.6 + 0.4 * Math.sin(beatTime * 16);
    const auraR = ship.radius * (2.6 + charge * 2.2);
    const auraA = (0.06 + charge * 0.18) * auraPulse;
    const aura = ctx.createRadialGradient(cx, cy, ship.radius * 0.6, cx, cy, auraR);
    aura.addColorStop(0, `rgba(180, 240, 255, ${(auraA * 0.9).toFixed(3)})`);
    aura.addColorStop(0.6, `rgba(120, 210, 255, ${(auraA * 0.5).toFixed(3)})`);
    aura.addColorStop(1, "rgba(90, 180, 255, 0)");
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(cx, cy, auraR, 0, Math.PI * 2);
    ctx.fill();

    // In-rushing streaks — short comet-lines spiralling INWARD toward the ship,
    // the "drawing power in" cue. Count + speed climb with charge.
    const streaks = 5 + Math.round(charge * 9);
    for (let s = 0; s < streaks; s++) {
      const baseAng = (s / streaks) * Math.PI * 2 + beatTime * (1.2 + charge * 1.5);
      // Each streak's radius oscillates inward over a short cycle (the inflow).
      const phase = (beatTime * (1.6 + charge) + s * 0.7) % 1;
      const rOuter = auraR * (1 - phase) + ship.radius * 1.3 * phase;
      const rInner = rOuter - (6 + charge * 14);
      const ox = cx + Math.cos(baseAng) * rOuter;
      const oy = cy + Math.sin(baseAng) * rOuter;
      const ix = cx + Math.cos(baseAng) * rInner;
      const iy = cy + Math.sin(baseAng) * rInner;
      const sa = (0.25 + charge * 0.4) * (1 - phase);
      ctx.strokeStyle = `rgba(210, 245, 255, ${sa.toFixed(3)})`;
      ctx.lineWidth = 1 + charge * 1.4;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ix, iy);
      ctx.stroke();
    }

    // Tight bright corona hugging the hull — intensifies sharply near full charge
    // so a maxed buildup looks ready to burst.
    if (charge > 0.05) {
      drawGlow(ctx, cx, cy, ship.radius * (1.4 + charge * 0.8), 195, 0.12 + charge * 0.4);
    }
  }

  if (dots <= 0) { ctx.restore(); return; }

  // Connecting thread — a wobbling line from the muzzle through every armed dot.
  // Reads as "energy being routed forward". Brighter as more dots accumulate.
  const muzzleX = ship.pos.x + dir.x * (ship.radius + 4);
  const muzzleY = ship.pos.y + dir.y * (ship.radius + 4);
  const threadEndX = ship.pos.x + dir.x * (baseOffset + (dots - 1) * dotGap);
  const threadEndY = ship.pos.y + dir.y * (baseOffset + (dots - 1) * dotGap);
  const threadPulse = 0.55 + 0.45 * Math.sin(beatTime * 14);
  ctx.strokeStyle = `rgba(150, 230, 255, ${(0.18 * dots * threadPulse).toFixed(3)})`;
  ctx.lineWidth = 1.4 + dots * 0.4;
  ctx.beginPath();
  ctx.moveTo(muzzleX, muzzleY);
  // Mid wobble point so the thread squirms instead of being a straight line.
  const midX = (muzzleX + threadEndX) * 0.5 + perp.x * Math.sin(beatTime * 9) * 2;
  const midY = (muzzleY + threadEndY) * 0.5 + perp.y * Math.sin(beatTime * 9) * 2;
  ctx.quadraticCurveTo(midX, midY, threadEndX, threadEndY);
  ctx.stroke();

  for (let i = 0; i < dots; i++) {
    const px = ship.pos.x + dir.x * (baseOffset + i * dotGap);
    const py = ship.pos.y + dir.y * (baseOffset + i * dotGap);
    // Per-dot age in seconds since this dot first appeared. The dot at index
    // i appeared at startBeatTime + (i+1)*BEAT_GRID.
    const dotAgeSec = Math.max(0, beatTime - (ship.laserChargeStartBeatTime + (i + 1) * BEAT_GRID));
    // Birth-pop: huge burst on the first ~0.18s — settles to steady pulse.
    const popT = Math.min(1, dotAgeSec / 0.18);
    const popBoost = 1 + (1 - popT) * 2.4;
    // Per-tier brightness: higher-index dots glow brighter on top of pulse.
    const tierBoost = 1 + i * 0.22;
    const pulse = (0.7 + 0.3 * Math.sin(beatTime * 7 + i * 1.7)) * tierBoost;
    const r = 3.6 * popBoost;

    // Outer wide halo — soft cyan, fades quickly to transparent.
    const wideHalo = ctx.createRadialGradient(px, py, 0, px, py, r * 4.5);
    wideHalo.addColorStop(0, `rgba(160, 235, 255, ${(0.5 * pulse).toFixed(3)})`);
    wideHalo.addColorStop(0.4, `rgba(120, 210, 255, ${(0.28 * pulse).toFixed(3)})`);
    wideHalo.addColorStop(1, "rgba(80, 180, 255, 0)");
    ctx.fillStyle = wideHalo;
    ctx.beginPath();
    ctx.arc(px, py, r * 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Inner halo
    const halo = ctx.createRadialGradient(px, py, 0, px, py, r * 2.4);
    halo.addColorStop(0, `rgba(230, 250, 255, ${(0.85 * pulse).toFixed(3)})`);
    halo.addColorStop(1, "rgba(140, 220, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(px, py, r * 2.4, 0, Math.PI * 2);
    ctx.fill();

    // Bright white core
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, 0.95 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, r * 0.85, 0, Math.PI * 2);
    ctx.fill();

    // Crackle arc — a jagged bolt leaping back from this dot to the previous
    // one (or the muzzle for the first dot), in the bass-lightning dialect.
    // Higher tiers crackle harder; the jag reseeds a few times a second so it
    // flickers without allocating fresh randomness every frame.
    if (i >= 1) {
      const fromX = ship.pos.x + dir.x * (baseOffset + (i - 1) * dotGap);
      const fromY = ship.pos.y + dir.y * (baseOffset + (i - 1) * dotGap);
      const jags = chargeArcJags(i, beatTime);
      const tSec = beatTime * 6;
      const pts = buildJaggedBolt(fromX, fromY, px, py, jags, i * 1.7, tSec, 0);
      const arcA = (0.4 + 0.3 * Math.sin(beatTime * 17 + i)) * tierBoost;
      strokePolyline(ctx, pts, 2.4, `rgba(150, 230, 255, ${(0.22 * arcA).toFixed(3)})`);
      strokePolyline(ctx, pts, 1, `rgba(235, 250, 255, ${(0.6 * arcA).toFixed(3)})`);
      drawGlow(ctx, px, py, r * 1.4, 195, 0.35 * arcA);
      ctx.globalAlpha = 1;
    }

    // Rotating sparkle ring — three orbiting micro-dots around each charge dot.
    // Higher-tier dots spin faster so the energy reads as building.
    const ringR = r * 1.8;
    const spinRate = 4 + i * 1.8;
    const sparkCount = 3 + i;
    for (let s = 0; s < sparkCount; s++) {
      const ang = beatTime * spinRate + (s * (Math.PI * 2)) / sparkCount + i * 0.6;
      const sx = px + Math.cos(ang) * ringR;
      const sy = py + Math.sin(ang) * ringR;
      const sparkAlpha = (0.55 + 0.35 * Math.sin(beatTime * 11 + s * 1.3)) * tierBoost;
      ctx.fillStyle = `rgba(220, 245, 255, ${Math.min(1, sparkAlpha * 0.7).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.2 + 0.4 * Math.sin(beatTime * 13 + s), 0, Math.PI * 2);
      ctx.fill();
    }

    // Birth-pop ring — a quickly-expanding hollow ring on dot arrival, fades fast.
    if (popT < 1) {
      const ringRadius = r * (1.5 + popT * 3);
      const ringAlpha = (1 - popT) * 0.7;
      ctx.strokeStyle = `rgba(200, 240, 255, ${ringAlpha.toFixed(3)})`;
      ctx.lineWidth = 2 * (1 - popT) + 0.5;
      ctx.beginPath();
      ctx.arc(px, py, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
};

export const renderLasers = (ctx: CanvasRenderingContext2D, lasers: LaserBeam[]) => {
  if (lasers.length === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const beam of lasers) {
    const t = beam.life / beam.maxLife;
    // Fast attack, slow tail — beam stamps fully bright then fades.
    const alpha = t > 0.85 ? (1 - t) / 0.15 : t / 0.85;
    const ageFrac = 1 - t; // 0 → freshly fired, 1 → about to vanish
    const cosH = Math.cos(beam.heading);
    const sinH = Math.sin(beam.heading);
    const ex = beam.origin.x + cosH * beam.length;
    const ey = beam.origin.y + sinH * beam.length;
    // Charge tier as a 0..1 ramp off the dot count — the damage tiers map to
    // evenly-spaced thickness/effect steps rather than the raw damage, which
    // would saturate and render the top tiers identically.
    const tier = beam.dots / LASER_MAX_DOTS;
    // Width driver scaled so the visible beam roughly fills its hit swath: the
    // gameplay half-width sets the floor, charge thickens it further. The super
    // beam (torus-charge bolt) blows past the normal ceiling so it reads as a
    // categorically bigger weapon than a maxed held charge.
    const superMul = beam.isSuper ? 2.4 : 1;
    const w = (1 + beam.dots + beamHalfWidth(beam.dots) * 0.4) * superMul;

    // A stroke that tapers to nothing over the far end of the beam, so the tip
    // dissolves instead of stopping flat. The super beam holds full brightness
    // most of its run before the tip dissolves, so a screen-spanning bolt stays
    // solid edge to edge rather than fading out halfway.
    const fadingStroke = (rgb: string, peak: number, width: number) => {
      const grad = ctx.createLinearGradient(beam.origin.x, beam.origin.y, ex, ey);
      grad.addColorStop(0, `rgba(${rgb}, ${peak.toFixed(3)})`);
      // Super beam stays bright nearly to the tip; normal beams taper sooner.
      grad.addColorStop(beam.isSuper ? 0.85 : 0.6, `rgba(${rgb}, ${(peak * (beam.isSuper ? 0.92 : 0.7)).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(beam.origin.x, beam.origin.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    };

    // Super beam wears an extra colossal halo + a hot magenta-white edge so it
    // reads as a different class of weapon from the cyan held-charge laser.
    if (beam.isSuper) {
      fadingStroke("180, 230, 255", 0.16 * alpha, 40 + w * 9);
      fadingStroke("210, 180, 255", 0.22 * alpha, 18 + w * 5);
    }
    // Outermost diffuse aura — wide and soft, now present even at a tap (a faint
    // floor + charge ramp) so the smallest beam still reads as "bending the air".
    fadingStroke("140, 200, 255", (0.1 + 0.14 * tier) * alpha, 26 + w * 8);
    // Outer glow — wide, soft, cyan-tinged. Wider at higher tiers.
    fadingStroke("120, 220, 255", 0.34 * alpha, 14 + w * 5);
    // Mid layer — brighter, narrower.
    fadingStroke("180, 240, 255", 0.62 * alpha, 6 + w * 2.1);
    // Core — near-white, hot.
    fadingStroke("255, 255, 255", alpha, 2.6 + w * 0.85);
    // Hot white inner sliver — now on every shot so the beam always has a blazing
    // centre line; grows with charge for the high-tier "plasma lance" look.
    fadingStroke("255, 255, 255", Math.min(1, alpha * 1.0), 1 + tier * 2.2 + (beam.isSuper ? 3 : 0));

    // Energy throb — a fast bright pulse riding the core so the beam looks alive
    // and surging rather than a static painted line. Brightest right after fire.
    {
      const throb = 0.5 + 0.5 * Math.sin((1 - t) * 40 + beam.seed * 6);
      fadingStroke("220, 250, 255", alpha * 0.5 * throb * (1 - ageFrac), 2 + w * 1.2);
    }

    // Crackle arcs — jagged offshoots branching off the core, in the same
    // oscilloscope dialect as bass lightning. Now from the first charged dot so
    // even a small charge spits lightning; denser/brighter at higher tiers.
    if (beam.dots >= 1 && beam.jags.length > 0) {
      const tSec = (1 - t) * 6 + beam.seed;
      const pts = buildJaggedBolt(
        beam.origin.x, beam.origin.y, ex, ey, beam.jags, beam.seed, tSec, 6,
      );
      strokePolyline(ctx, pts, 3 + tier * 3, `rgba(150, 230, 255, ${(0.2 * alpha).toFixed(3)})`);
      strokePolyline(ctx, pts, 1.4, `rgba(235, 250, 255, ${(0.7 * alpha).toFixed(3)})`);
      // Second, independently-seeded arc on high charge so the beam writhes with
      // a tangle of lightning rather than a single jag.
      if (beam.dots >= 3) {
        const pts2 = buildJaggedBolt(
          beam.origin.x, beam.origin.y, ex, ey, beam.jags, beam.seed + 2.3, tSec * 1.3, 6,
        );
        strokePolyline(ctx, pts2, 1.2, `rgba(200, 240, 255, ${(0.5 * alpha).toFixed(3)})`);
      }
    }

    // Muzzle burst — bright circular flash at the origin, dims fast over life.
    const burstAlpha = (1 - ageFrac) * alpha;
    const burstR = (8 + w * 5) * (0.6 + (1 - ageFrac) * 0.8);
    const burstGrad = ctx.createRadialGradient(
      beam.origin.x, beam.origin.y, 0,
      beam.origin.x, beam.origin.y, burstR,
    );
    burstGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.85 * burstAlpha).toFixed(3)})`);
    burstGrad.addColorStop(0.4, `rgba(180, 240, 255, ${(0.45 * burstAlpha).toFixed(3)})`);
    burstGrad.addColorStop(1, "rgba(120, 200, 255, 0)");
    ctx.fillStyle = burstGrad;
    ctx.beginPath();
    ctx.arc(beam.origin.x, beam.origin.y, burstR, 0, Math.PI * 2);
    ctx.fill();

    // Traveling sparks — small bright pips evenly spaced along the beam, drifting
    // forward over the beam's life. Density + size scale with tier.
    if (beam.dots >= 1) {
      const sparkCount = 4 + beam.dots * 4;
      const driftPhase = (1 - t); // 0..1 across beam lifetime
      const perpX = -sinH;
      const perpY = cosH;
      for (let s = 0; s < sparkCount; s++) {
        const baseFrac = (s + 0.5) / sparkCount;
        const frac = (baseFrac + driftPhase * 0.25) % 1;
        const sx = beam.origin.x + cosH * beam.length * frac;
        const sy = beam.origin.y + sinH * beam.length * frac;
        // Small lateral jitter so sparks don't sit perfectly on the centre line.
        const jitter = Math.sin(s * 12.3 + beam.maxLife * 31) * (1 + tier * 1.5);
        const jx = sx + perpX * jitter;
        const jy = sy + perpY * jitter;
        const sparkR = 1.2 + tier * 1.6 + Math.sin(s * 7 + driftPhase * 9) * 0.4;
        const sparkAlpha = alpha * (0.55 + 0.35 * Math.sin(s * 3.1 + driftPhase * 11));
        ctx.fillStyle = `rgba(255, 255, 255, ${sparkAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(jx, jy, sparkR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Endpoint glow — far tip dissolves rather than blooming, so the faded
    // beam end doesn't pick up a hard bright cap.
    if (beam.dots >= 1) {
      const tipR = (6 + w * 4) * (0.6 + (1 - ageFrac) * 0.7);
      const tipGrad = ctx.createRadialGradient(ex, ey, 0, ex, ey, tipR);
      tipGrad.addColorStop(0, `rgba(200, 240, 255, ${(0.22 * alpha * tier).toFixed(3)})`);
      tipGrad.addColorStop(1, "rgba(140, 220, 255, 0)");
      ctx.fillStyle = tipGrad;
      ctx.beginPath();
      ctx.arc(ex, ey, tipR, 0, Math.PI * 2);
      ctx.fill();
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
