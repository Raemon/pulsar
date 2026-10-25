import { Vec, wrapMut, TAU } from "./vec";
import { drawGlow } from "./glow";

// Damage dealt by a non-rhythm bullet — enough to one-shot a small asteroid
// but takes the full size table (4/2/1) of hits to chew through a large.
export const BULLET_DAMAGE_BASE = 1;
// Damage dealt by an on-beat bullet — 4× the base, sized to one-shot any
// non-bass asteroid and meaningfully crack a bassteroid (which carries a 4×
// HP multiplier of its own, so an on-beat shot does a "normal hit" against
// armour).
export const BULLET_DAMAGE_BEAT = 4;
// Damage dealt by a boosted on-beat bullet — fired while the yellow combo
// halo is up (combo ≥ 4). Doubles the on-beat damage to reward the streak.
export const BULLET_DAMAGE_BEAT_BOOSTED = 8;

// The Bomb upgrade fires stock-sized shells that act as thrown mines: they
// glide out, settle under drag, bounce off whatever they touch, and pulse on
// every beat — detonating when a target sits inside the blast ring (see
// game/bombShot.ts). The blast hits with twice the shot's damage.
export const BOMB_DAMAGE_MULT = 2;
// Linear drag on a bomb shell, per second. A shell launched at v0 comes to rest
// v0 / BOMB_DRAG out from the muzzle; shipWeapons.shotTravel mirrors this curve
// so the sight marks where the mine will actually be on each beat.
export const BOMB_DRAG = 2;
// Reach of a bomb's blast, from the shell's centre to a target's surface. The
// ring the shell paints is drawn at exactly this radius: anything the ring
// touches on a beat is caught in the blast.
export const BOMB_BLAST_RADIUS = 96;
// Seconds the beat-pulse ring takes to fade after flashing.
const BOMB_PULSE_FADE_SEC = 0.3;

// Seconds over which an on-beat flash's ballooned core shrinks back to its
// resting size. The flash itself lasts longer (FLASH_DURATION_SEC in
// gameUpdate); this shorter tail makes the envelope hold at full size for the
// first half of the flash and decay over the final 0.06s.
const CORE_FLASH_TAIL_SEC = 0.06;
// Peak extra core growth at full flash — the bright core swells to
// (1 + CORE_FLASH_GROWTH)× its resting radius when flashEnv = 1.
const CORE_FLASH_GROWTH = 2.0;
// Fraction of the painted head-glow radius out to which the hitbox extends.
// The glow gradient (see glow.ts) holds a solid-looking blob until its
// addColorStop(0.6, …0.15) knot, then fades to fully transparent over the
// final stretch. 0.6 puts the hitbox right at that knot — the edge of the
// visibly-glowing zone — so a shot connects anywhere the bullet reads as lit,
// without claiming the faint outer halo.
export const GLOW_VISIBLE_FRACTION = 0.6;

// Bullet geometry, as pure functions of what the shot IS rather than methods on
// a live bullet — because the reticule has to size itself off these numbers a
// beat before any bullet exists. Every length in the sight (src/ship/reticule)
// derives from them, so a weapon that changes the bullet's size moves the sight
// with it instead of leaving the player aiming with the wrong-sized ring.
export const BULLET_CORE_RADIUS = 1.8;
// On-beat shots render (and therefore hit) larger than off-beat ones.
const ON_BEAT_CORE_MULT = 2.38;

export type BulletShape = { onBeat: boolean; superBoosted?: boolean };

export const bulletCoreRadius = (shape: BulletShape): number =>
  BULLET_CORE_RADIUS * (shape.onBeat ? ON_BEAT_CORE_MULT : 1);

// super-boosted (combo >= 12) keeps the core size but tightens the halo (6 vs 10)
// for a sharper, more pointed read — which also shortens its collision reach.
export const bulletHeadGlowMul = (shape: BulletShape): number =>
  shape.superBoosted ? 6 : shape.onBeat ? 10 : 6;

// The real collision reach the hit test uses: out to the edge of the visibly-lit
// zone. The sight's on-beat aim dots are pulled one of these toward the ship so
// the shell's leading EDGE — not its center — meets the target on the beat.
export const bulletCollisionRadius = (shape: BulletShape): number =>
  bulletCoreRadius(shape) * bulletHeadGlowMul(shape) * GLOW_VISIBLE_FRACTION;

export class Bullet {
  pos: Vec;
  vel: Vec;
  life: number;
  maxLife: number;
  trail: Vec[] = [];
  // True when fired within the on-beat window. Drives a deeper-blue, larger
  // glow so the player can see at a glance that the shot landed on the grid,
  // and is read by Game on collision to apply the combo score multiplier.
  // Also bumps the damage from BULLET_DAMAGE_BASE to BULLET_DAMAGE_BEAT.
  onBeat = false;
  // True when this on-beat bullet was fired while the yellow combo halo was
  // up (combo ≥ 4). Renders yellow instead of blue and deals 2× the on-beat
  // damage so the gold-tier streak feels lethal as well as visible.
  boosted = false;
  // True when fired at combo ≥ 12. Renders as a tight white shot and flies
  // twice as far — same hitbox/core as the yellow tier, but sharper-looking
  // and with extended reach so the streak feels like a longer arm.
  superBoosted = false;
  // Set by Ship.fire when the player has the pierce powerup active. Game's
  // collision pass keeps a piercing bullet alive on hit instead of consuming
  // it, so a single shot can punch through a row of asteroids.
  pierce = false;
  // Set by Ship.fire when the player has the bomb upgrade. The shell bounces
  // instead of hitting, slows under BOMB_DRAG, and detonates on a beat pulse
  // (game/bombShot.ts); it swaps the tier palette from blue/gold/white to
  // red/orange/white-with-a-gold-halo.
  bomb = false;
  // Beat index (perceivedBeatTime / BEAT_GRID) of the bomb's next pulse; -1
  // until bombShot arms it from firedAtBeatTime.
  bombNextPulseBeat = -1;
  // Pulses left before the bomb detonates whether or not anything is in range.
  bombPulsesLeft = 0;
  // Seconds since the last beat pulse, for the ring's flash-and-fade.
  bombPulseAge = Infinity;
  // A bullet's momentum transfers once, ever. Set on the first knockback it
  // applies (deflection or cracked hit); repeat deflections off a spinning
  // armored crystal — or later pierce hits — shove nothing more.
  hasAppliedKnockback = false;
  // beatTime (seconds since game start) at which this bullet was fired.
  // Recorded by Game when stamping new bullets so debug logging at hit time
  // can report the original fire offset, not just the impact offset.
  firedAtBeatTime = 0;
  // Muzzle position, frozen at fire time. The citadel reads it to tell an
  // inside-the-escape-hole shot (armour-bypassing) from an outside one.
  firedFrom: Vec;
  // True for the laser's synthesised strike bullet: a beam connects the instant
  // it fires, so it has no flight time and can never be a Far Shot
  // (rhythmBonus.beatsAwayAtHit).
  instantHit = false;
  // life-remaining threshold below which the bullet fades to 0 opacity. Set by
  // shipWeapons at fire-time to the gap between maxLife and the farthest beat
  // reticule, so the visible bullet dims out across the post-reticule tail
  // where any hit would no longer land on a beat. 0 = no fade.
  fadeStartLife = 0;
  // Snapshot of each hover ring's DRIFT TIER at fire-time (index 0 = 1-beat slot, 1 = 2-beat,
  // ...). 0 = ring not locked; 1/2/3 = the tier reached by holding (0.5s / 2s / 8s). Any entry
  // > 0 makes this bullet drift-eligible; the on-beat rhythm-grace is enforced separately at
  // fire-time. driftTierAtHit() reads the best tier for the damage/rhythm-bonus payout.
  driftLockedSlots: number[] = [];
  // counts the integer-beat reticule lines the bullet has already crossed (incremented by
  // gameUpdate). Each new crossing samples the rhythm window; if on-beat, flashTimer fires.
  reticuleCrossings = 0;
  // seconds of white-flash remaining — set when a crossing happens on-beat, decays in update().
  flashTimer = 0;

  constructor(pos: Vec, vel: Vec, life: number) {
    this.pos = { ...pos };
    this.firedFrom = { ...pos };
    this.vel = vel;
    this.life = life;
    this.maxLife = life;
  }

  damage(): number {
    const base = this.boosted
      ? BULLET_DAMAGE_BEAT_BOOSTED
      : this.onBeat ? BULLET_DAMAGE_BEAT : BULLET_DAMAGE_BASE;
    return this.bomb ? base * BOMB_DAMAGE_MULT : base;
  }

  // True when this on-beat hit should award the drift-shot 4× bonus: any
  // hover ring that finished its lock animation before fire-time grants
  // drift eligibility for this bullet. The on-beat rhythm-grace window is
  // already enforced by the fire-time onBeat check, so once a lock exists
  // any hit by this bullet pays out — matching "if you got the lock
  // animation, you should be able to land a drift shot".
  driftEligibleAtHit(): boolean {
    return this.driftTierAtHit() > 0;
  }

  // Best drift tier across all locked slots at fire-time (0 = no lock; 1/2/3 = held tier).
  // Drives the tier-scaled damage multiplier and the +tier rhythm bonus.
  driftTierAtHit(): number {
    let best = 0;
    for (let i = 0; i < this.driftLockedSlots.length; i++) {
      if (this.driftLockedSlots[i] > best) best = this.driftLockedSlots[i];
    }
    return best;
  }

  // Visual core radius. On-beat shots render larger; hitRadius() scales with
  // this so the collision box matches the visible glow.
  effectiveRadius(): number {
    return bulletCoreRadius(this);
  }

  // Radius of the bright painted core dot. Balloons during an on-beat flash
  // and settles back over CORE_FLASH_TAIL_SEC. render() paints exactly this,
  // and hitRadius() reuses it so the collision box tracks the visible core's
  // growth instead of duplicating the size math.
  coreDrawRadius(): number {
    if (this.flashTimer <= 0) return this.effectiveRadius();
    const flashEnv = Math.min(1, this.flashTimer / CORE_FLASH_TAIL_SEC);
    return this.effectiveRadius() * (1 + CORE_FLASH_GROWTH * flashEnv);
  }

  // Multiplier on the core radius for the painted head-glow halo. render()
  // draws the glow at effectiveRadius() × this, and hitRadius() reuses it so
  // the collision box scales with the glow rather than duplicating the number.
  // super-boosted (combo ≥ 12) keeps the yellow-tier core size but tightens the
  // halo (6 vs 10) for a sharper, more pointed read.
  headGlowRadiusMul(): number {
    return bulletHeadGlowMul(this);
  }

  // Collision radius — reaches out to the edge of the visibly-glowing zone
  // (GLOW_VISIBLE_FRACTION of the painted head-glow radius) so a shot connects
  // anywhere the bullet reads as lit. Never smaller than the actual painted
  // core (coreDrawRadius), which balloons when the bullet flashes at a beat
  // reticule, so the player's read of "I'm clearly inside the bullet" always
  // lands.
  hitRadius(): number {
    const glowVisibleRadius = this.effectiveRadius() * this.headGlowRadiusMul() * GLOW_VISIBLE_FRACTION;
    return Math.max(glowVisibleRadius, this.coreDrawRadius());
  }

  update(dt: number, w: number, h: number) {
    this.life -= dt;
    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.trail.push({ ...this.pos });
    if (this.trail.length > 8) this.trail.shift();
    // Exact integration of linear drag, so the shell lands where shotTravel
    // says whatever the frame rate.
    const travel = this.bomb ? (1 - Math.exp(-BOMB_DRAG * dt)) / BOMB_DRAG : dt;
    this.pos.x += this.vel.x * travel;
    this.pos.y += this.vel.y * travel;
    if (this.bomb) {
      const decay = Math.exp(-BOMB_DRAG * dt);
      this.vel.x *= decay;
      this.vel.y *= decay;
      this.bombPulseAge += dt;
    }
    wrapMut(this.pos, w, h);
  }

  // Bomb tier palette: red at tier 1, orange at tier 2. Tier 3 paints its head
  // glow white (like any super-boosted shot) and gets the gold ONLY from the
  // wide corona in render(), which is what makes it read as a white shot inside
  // a gold halo rather than a uniformly gold one.
  bombHue(): number {
    if (this.superBoosted) return 45;
    // 30/0 rather than 25/5: glow sprites are cached in 15-degree hue buckets,
    // so landing on a bucket edge keeps painted orange looking orange.
    return this.boosted ? 30 : 0;
  }

  // Bright core dot colour for a bomb shot: white at tier 3, otherwise a
  // near-white tint of the tier hue so the halo reads as the carrier.
  bombCoreFill(): string {
    if (this.superBoosted) return "hsla(0, 0%, 100%, 1)";
    return this.boosted ? "hsla(28, 100%, 88%, 1)" : "hsla(4, 100%, 86%, 1)";
  }

  // The bomb's blast ring, drawn at exactly BOMB_BLAST_RADIUS so "the ring is
  // touching it" is the whole rule. A faint resting ring shows the reach between
  // beats; each pulse flashes it bright and fades, so the player sees the beat
  // the mine is listening on. The final pulse's lead-up burns hotter.
  renderBlastRing(ctx: CanvasRenderingContext2D) {
    const pulse = Math.max(0, 1 - this.bombPulseAge / BOMB_PULSE_FADE_SEC);
    const lastBeat = this.bombPulsesLeft === 1;
    const alpha = (lastBeat ? 0.32 : 0.18) + 0.6 * pulse * pulse;
    ctx.strokeStyle = `hsla(${this.bombHue()}, 100%, ${70 + 25 * pulse}%, ${alpha})`;
    ctx.lineWidth = 1.5 + 2 * pulse;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, BOMB_BLAST_RADIUS, 0, TAU);
    ctx.stroke();
  }

  whiteGlow(): boolean {
    return this.superBoosted;
  }

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const rangeAlpha = this.fadeStartLife > 0 && this.life < this.fadeStartLife
      ? Math.max(0, this.life / this.fadeStartLife)
      : 1;
    // Super-boosted (combo ≥ 12): white — saturation 0 makes hue irrelevant.
    // Boosted on-beat: gold (hue 45) to match the tier-2 combo halo.
    // On-beat: deep saturated blue (hue 220) — sells "weightier" rhythm shot.
    // Pierce: yellow. Non-beat: pale cyan, smaller and quieter visually.
    // Bomb runs its own tier palette (see bombHue): red → orange → gold-haloed
    // white, so a bomb shot never reads as an ordinary blue rhythm bullet.
    const flashing = this.flashTimer > 0;
    const trailHue = this.bomb ? this.bombHue() : this.boosted ? 45 : this.onBeat ? 220 : this.pierce ? 60 : 180;
    const headHue = this.bomb ? this.bombHue() : this.boosted ? 48 : this.onBeat ? 222 : this.pierce ? 60 : 180;
    const trailAlphaScale = this.onBeat ? 0.85 : 0.4;
    const headAlpha = this.onBeat ? 1.0 : 0.75;
    const headRadiusMul = this.headGlowRadiusMul();
    const trailRadiusMul = this.superBoosted ? 3 : 5;
    const coreRadius = this.effectiveRadius();
    for (let i = 0; i < this.trail.length; i++) {
      const segmentT = i / this.trail.length;
      const p = this.trail[i];
      const r = coreRadius * segmentT * 1.5;
      drawGlow(ctx, p.x, p.y, r * trailRadiusMul, trailHue, trailAlphaScale * segmentT * rangeAlpha, this.whiteGlow());
    }

    drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul, headHue, headAlpha * rangeAlpha, this.whiteGlow() || flashing);
    // Tier-3 bomb: a wide gold corona outside the head glow, so the white core
    // sits in a halo rather than just reading as a bigger white shot.
    if (this.bomb && this.superBoosted) {
      drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul * 2.2, 45, 0.7 * rangeAlpha);
    }
    if (this.bomb) this.renderBlastRing(ctx);
    if (flashing) {
      // sharp attack, tail-off — peak brightness lands on the first frame of the flash.
      const flashEnv = Math.min(1, this.flashTimer / CORE_FLASH_TAIL_SEC);
      // outer halo: huge soft bloom so the flash reads from across the screen.
      drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul * 3.0, 0, 0.7 * flashEnv * rangeAlpha, true);
      // mid bloom: stacked twice for extra punch where the lighter composite peaks.
      drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul * 1.8, 0, 1.0 * flashEnv * rangeAlpha, true);
      drawGlow(ctx, this.pos.x, this.pos.y, coreRadius * headRadiusMul * 1.2, 0, 1.0 * flashEnv * rangeAlpha, true);
    }
    ctx.globalAlpha = rangeAlpha;
    // Bright core dot — for on-beat use a near-white blue-tinted highlight so
    // the deep-blue halo reads as the carrier and the core still pops.
    ctx.fillStyle = flashing
      ? "hsla(0, 0%, 100%, 1)"
      : this.bomb
      ? this.bombCoreFill()
      : this.superBoosted
      ? "hsla(0, 0%, 100%, 1)"
      : this.boosted
        ? "hsla(50, 100%, 90%, 1)"
        : this.onBeat
          ? "hsla(220, 100%, 85%, 1)"
          : this.pierce
            ? "hsla(60, 100%, 96%, 1)"
            : "hsla(180, 100%, 98%, 1)";
    const coreDrawRadius = this.coreDrawRadius();
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, coreDrawRadius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}
