import { Vec, v, toroidalDelta } from "./vec";
import { IInput } from "./Input";
import { ParticleSystem } from "./Particle";
import { Bullet } from "./Bullet";
import { Sound } from "./Sound";
import { PowerupKind } from "./Canister";
import { FUEL_MAX } from "./game/fuel";
import { BEAT_GRID } from "./game/rhythmConstants";
import { haloVertices, haloReach, hitDistanceToward, SHIP_BODY_RADIUS, SHIP_HALO_OFFSET } from "./ship/shipHitbox";
import { tickShip } from "./ship/shipPhysics";
import { fireBullets, applyPowerup } from "./ship/shipWeapons";
import { setComboFromValue } from "./ship/shipComboHalo";
import { renderShipBody } from "./ship/shipRender";
import { renderShipReticules, tickHoverLockState, ReticuleHoverProbe } from "./ship/reticule/reticuleRender";
import { ReticuleTarget, TrajectoryTrackMap, AimHintRender } from "./ship/reticule/trajectoryPreview";
import { Wormhole, renderThroughPortal } from "./game/wormhole";

// BEAT_GRID is re-exported from Game.ts for backwards compatibility; Ship code reads it directly here.
export { BEAT_GRID };

// Ship owns the gameplay state; behavior lives in src/ship/* so each piece reads as one concept.
export class Ship {
  pos: Vec;
  vel: Vec = v(0, 0);
  heading = -Math.PI / 2;
  rotTapRate = 0.05; // slow turn rate while inside the tap window
  rotTapHoldTime = 0.04; // hold time before ramping past tap rate
  rotRampTime = 0.15 // blend time from tap rate to full rate
  rotMaxSpeed = 4; // steady turn rate once fully ramped
  rotInertia = false; // spin coasts on release instead of stopping
  rotVel = 0; // current angular velocity
  rotHoldTime = 0; // how long the turn key has been held
  rotHeldDir = 0; // turn direction last frame; reset ramp on flip
  rotSnappedLastFrame = false; // drift-aim snap fired last frame; the next frame turns freely
  // Drift-aim: an input (turn / thrust / reverse / each side engine) that BEGINS while hovering a
  // Next Beat Target starts slowed, then ramps back to full speed as you keep holding it. Inputs
  // already in flight before the hover are untouched. Each input captures its own start-slow on the
  // press edge (1 = no slow) and tracks how long it's been held so the ramp can unwind it.
  driftSlowRot = 1;
  driftSlowThrust = 1;
  driftSlowReverse = 1;
  driftSlowPort = 1;
  driftSlowStarboard = 1;
  driftHoldThrust = 0;
  driftHoldReverse = 0;
  driftHoldPort = 0;
  driftHoldStarboard = 0;
  thrustPower = 420;
  thrustRamp = 0;
  // Fuel Mode reserve (see game/fuel.ts). Thrusting drains it; it refills in
  // discrete once-a-second pulses and fuel orbs top it up. Starts full; ignored
  // entirely when fuel mode is off.
  fuel = FUEL_MAX;
  maxFuel = FUEL_MAX;
  // seconds counted toward the next recharge pulse (see rechargeFuel). Delivering
  // recharge as a once-a-second lump rather than a smooth trickle is what makes a
  // dry engine fire in single coughs: it sits empty until the lump lands, burns
  // that lump off in one short burst, then waits out the next second.
  fuelRechargeClock = 0;
  // drag is 0 so the ship coasts; thrust + retro are the only velocity inputs (Newtonian feel).
  drag = 0;
  maxSpeed = 460;
  radius = SHIP_BODY_RADIUS;
  // outer halo sits past the hull and IS the collision silhouette (matches what the player sees).
  baseHaloOffset = SHIP_HALO_OFFSET;
  get haloOffset() { return this.baseHaloOffset; }
  // shield draws an additional ring this far outside the ship's normal perimeter (purely cosmetic).
  shieldRingOffset = 12;
  // small uniform pad + forward bonus makes head-on collisions slightly more generous than rear hits.
  hitPad = 4;
  hitFrontBonus = 6;
  // a round touch zone about the hull's size (nose vertex + halo + pads) — NOT a
  // bound on the halo, whose mitred tip reaches further; see hitBound.
  get hitRadius() { return this.radius * 1.4 + this.haloOffset + this.hitPad + this.hitFrontBonus; }
  // True circumscribing radius of the collision outline (halo + pads), for
  // broad-phase culls: the halo's mitred nose tip reaches well past hitRadius.
  get hitBound() {
    if (this.haloReachFor !== this.radius * 1000 + this.haloOffset) {
      this.haloReachFor = this.radius * 1000 + this.haloOffset;
      this.haloReachCache = haloReach(this.radius, this.haloOffset);
    }
    return this.haloReachCache + this.hitPad + this.hitFrontBonus;
  }
  private haloReachFor = NaN;
  private haloReachCache = 0;
  // Collision-only padding toward a target at offset (dx, dy): uniform plus a
  // forward bonus, so a nose-on hazard registers a touch early.
  hazardPad(dx: number, dy: number): number {
    const forward = Math.max(0, Math.cos(Math.atan2(dy, dx) - this.heading));
    return this.hitPad + this.hitFrontBonus * forward;
  }
  alive = true;
  invuln = 2.0;
  // Wave-skip warp progress for the render transform (0 = full size, 1 = gone
  // down the throat); null = not warping. Purely cosmetic — the sim side of
  // the warp is game.waveSkip (see game/waveSkip.ts).
  skipWarpT: number | null = null;
  // Fold the ship's position took this frame (0 when it didn't wrap) — the
  // entrance state shifts every entering entity's frame by it so entrance
  // images stay continuous when the camera jumps. See game/entrance.ts.
  lastWrapDX = 0;
  lastWrapDY = 0;
  thrustOn = false;
  reverseThrustOn = false;
  // port = Z (accelerate left of heading), starboard = X (accelerate right of heading).
  portThrustOn = false;
  starboardThrustOn = false;
  // timestamp (in seconds, same clock as Game.beatTime) of the most recent frame the player
  // was thrusting. Drives the trajectory-preview fade — line stays solid for 2s after thrust ends,
  // then fades over 1s. -Infinity means "never thrusted" → preview hidden.
  lastThrustActiveAt = -Infinity;
  fireCooldown = 0;
  // one shot per beat by default; reticule previews where it lands at the next beat boundary.
  fireRate = BEAT_GRID;
  bulletSpeed = 620;
  bulletLife = 0.85;
  // prong/rapid/pierce/radar/longshot persist for the run; shield is one-shot.
  // prongCount stacks: each upgrade adds two more bullets (see prongOffsets for the fan).
  prongCount = 0;
  get prongActive() { return this.prongCount > 0; }
  rapidActive = false;
  pierceActive = false;
  shieldActive = false;
  radarActive = false;
  longshotActive = false;
  sideEnginesActive = false;
  lasershotActive = false;
  // Bomb upgrade: shots become thrown mines that bounce, pulse on the beat and
  //   blast everything in range. See game/bombShot.ts.
  bombActive = false;
  // Laser-shot charge state. Active while the player holds fire under the
  //   lasershot upgrade; release fires a beam dealing 1 + numChargedDots damage.
  //   See game/laserShot.ts for the charge/release logic.
  laserChargeActive = false;
  laserChargeStartBeatTime = 0;
  laserLastDotIndexFired = -1;
  // Set when an off-beat fire press is rejected so the fail sound only plays
  //   once per hold — cleared when the player releases and re-presses.
  laserChargeFailedThisHold = false;
  // Quarter-note beat index when the refire lockout from the last shot ends;
  //   charge presses before it are rejected. See LASER_REFIRE_BEATS.
  laserCooldownEndBeat = 0;
  // Whether the laser cleared its refire lockout as of last tick — used to fire
  //   laserReadyFlash exactly once on the locked→ready edge. See tickLaserShot.
  laserWasReady = true;
  // 0→1 pop that fires the instant the refire lockout releases and decays to 0,
  //   driving the reticule's "armed" ready burst. Cosmetic only.
  laserReadyFlash = 0;
  // 0→1 hull desaturation while the laser sits in its refire lockout: the ship
  //   drains to grey the moment a shot spends the charge and eases back to its
  //   cyan once the laser is ready again. Cosmetic only. See tickLaserShot.
  laserCooldownDim = 0;

  // Super-laser charge — gained by flying the ship through the flickering energy
  //   thread strung between a broken torus ring's orbiting fragments. While
  //   charged, the NEXT shot fires a screen-spanning super-laser instead of a
  //   normal bullet (works without the lasershot upgrade); firing consumes it.
  //   See game/torusCharge.ts (detect + fire) and shipPhysics.updateFireTrigger.
  superLaserCharged = false;
  // 0→1 aura ramp for the crackling-energy charge glow around the hull. Eases
  //   up while charged, snaps toward 0 once spent. Cosmetic only.
  superLaserChargeGlow = 0;

  // discrete halo tier 0/1/2; intensity eases toward this target for a smooth visual response.
  comboHaloTier = 0;
  comboHaloIntensity = 0;
  // set to 1 by Game on a meaningful combo loss; decays in update to drive the red halo flash.
  comboLossFlash = 0;
  // set to 1 in checkBonusLife when a free life is earned; decays in update to
  //   flash the whole hull bright white for a beat.
  bonusLifeFlash = 0;
  // per-target trajectory state — drives entry-flash phase, fade-out lingering, and pulse phase.
  private trajectoryTracks: TrajectoryTrackMap = new Map();
  // persists across frames so the 8th-note hover ring can fill in over a continuous hover.
  //   Public so the tutorial can read hover duration for its "hold the reticule" gate.
  //   completionBeatTime stamps when the ring first reaches the lock threshold so the
  //   completion flare (visual) and the octave-up companion hum (audio) fire once on the
  //   rising edge and persist for as long as the hover lasts.
  // One ring state per reachable on-beat slot (index 0 = 1-beat, index 1 = 2-beat, ...).
  //   Grown lazily by the renderer as longshot/superBoosted/etc. extend bullet range.
  //   hoverDotRingState aliases slot-1 so the tutorial's drift/hold gate keeps reading the
  //   same field it always has.
  //   zoneEnterBeatTime stamps when the reticule first entered the wider 75px "approach"
  //   zone for this slot (cleared on leaving), driving the soft outer hum + the contracting
  //   approach ring; distinct from hoverStartBeatTime, which only arms on the tight target area.
  hoverDotRingStates: Array<{
    hoverStartBeatTime: number | null;
    completionBeatTime: number | null;
    zoneEnterBeatTime: number | null;
    fadeOutStartTime: number | null;
    lastRingCenter: { x: number; y: number } | null;
  }> = [{ hoverStartBeatTime: null, completionBeatTime: null, zoneEnterBeatTime: null, fadeOutStartTime: null, lastRingCenter: null }];
  get hoverDotRingState() { return this.hoverDotRingStates[0]; }

  constructor(pos: Vec) { this.pos = pos; }

  // silhouette polygon used by both rendering and collision so the visible outline == the hitbox.
  haloVertices(): Array<[number, number]> { return haloVertices(this); }

  // bullets/asteroids query reach in a direction; lets glancing shots that look right actually hit.
  hitDistanceToward(theta: number): number { return hitDistanceToward(this, theta); }

  // combo tier comes from Game's beatCombo via a single setter so HUD and halo stay in sync.
  setCombo(combo: number) { setComboFromValue(this, combo); }

  // kept for callsite compatibility; the simplified halo has no per-beat state to advance.
  tickComboHalo(_dt: number, _beatPulse: number) {}

  // orchestrates a single frame of player control, audio, and motion in one delegated call.
  update(
    dt: number, input: IInput, particles: ParticleSystem, bullets: Bullet[],
    w: number, h: number, t: number, sound: Sound,
  ) {
    tickShip(this, dt, input, particles, bullets, w, h, t, sound);
  }

  // prong spreads + on-beat tagging happens in Game; the ship just emits the right bullet count.
  fire(bullets: Bullet[]) { fireBullets(this, bullets); }

  // powerup pickup goes through one entry point so the active-flag rules stay in one file.
  applyPowerup(kind: PowerupKind) { applyPowerup(this, kind); }

  // aim disc + radar cone + trajectory previews share one composition — single delegate.
  renderReticules(
    ctx: CanvasRenderingContext2D, beatGrid: number, w: number, h: number,
    targets: ReadonlyArray<ReticuleTarget> = [], beatTime: number = 0, doubletime: boolean = false,
    tutorialHighlight: boolean = false, sound: Sound | null = null, audioBeatTime: number = beatTime,
    superBoosted: boolean = false,
    hoverProbes: ReadonlyArray<ReticuleHoverProbe> = [],
    aimHint: AimHintRender | null = null,
  ) {
    renderShipReticules(this, { trajectoryTracks: this.trajectoryTracks, hoverDotRings: this.hoverDotRingStates }, ctx, beatGrid, w, h, targets, beatTime, doubletime, tutorialHighlight, sound, audioBeatTime, superBoosted, hoverProbes, aimHint);
  }

  // How long ago the radar last had this target in its cone, in beat-time seconds; null if it
  //   has never been tracked. Lets the targeting hint pick a rock the player can already see.
  secondsSinceRadarContact(target: object, beatTime: number): number | null {
    const track = this.trajectoryTracks.get(target);
    return track ? beatTime - track.lastInConeAt : null;
  }

  // SIM-side hover-lock tick — runs the lock state machine (drift-shot eligibility) deterministically
  //   each frame from updatePlaying, sharing the reticule geometry with renderReticules but headless.
  //   `emit` true on live (fires the lock hum/hint), false on replay.
  tickReticuleLock(
    beatGrid: number, w: number, h: number,
    targets: ReadonlyArray<ReticuleTarget>, beatTime: number, doubletime: boolean,
    superBoosted: boolean, hoverProbes: ReadonlyArray<ReticuleHoverProbe>,
    sound: Sound | null, emit: boolean,
  ) {
    tickHoverLockState(this, { trajectoryTracks: this.trajectoryTracks, hoverDotRings: this.hoverDotRingStates }, beatGrid, w, h, targets, beatTime, doubletime, superBoosted, hoverProbes, sound, emit);
  }

  // hull + thrust + retro + shield + combo halo all composite together in one
  // save/restore block. `cropPortal` (the skip portal the ship is diving into
  // or climbing out of) lenses the hull as it passes through the mouth;
  // screenW/H resolve the portal's nearest wrap copy.
  render(
    ctx: CanvasRenderingContext2D, t: number, beatPulse: number = 0,
    cropPortal: Wormhole | null = null, screenW = 0, screenH = 0,
  ) {
    const k = this.skipWarpT;
    if (k === null) {
      renderShipBody(ctx, this, t, beatPulse);
      return;
    }
    if (cropPortal) {
      const [dx, dy] = toroidalDelta(cropPortal.x - this.pos.x, cropPortal.y - this.pos.y, screenW, screenH);
      renderThroughPortal(
        ctx, cropPortal, k, { x: this.pos.x, y: this.pos.y, reach: this.radius * 3 }, dx, dy,
        (g) => renderShipBody(g, this, t, beatPulse),
      );
      return;
    }
    const scale = 1 - k * k;
    if (scale < 0.02) return;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.scale(scale, scale);
    ctx.translate(-this.pos.x, -this.pos.y);
    renderShipBody(ctx, this, t, beatPulse);
    ctx.restore();
  }
}
