import { Vec, v, rand, TAU, toroidalDelta } from "./vec";
import { rng, cosmeticRng } from "./game/rng";
import { ENTITY_CONFIG, ENTITY_STATS } from "./game/entityConfig";
import { actTwoProgress } from "./game/acts";
import { BEAT_GRID } from "./game/rhythmConstants";

// Background pulsar + parallax planets. The pulsar spins continuously (twin
// magnetic-axis beams sweep around the core), pulses softly on every beat,
// and emits a much louder, longer flare on each wave clear, accompanied by
// a deep "brrrmmm" drone. Across waves it grows and drifts toward the screen
// centre, surrounded by a faint pulsar-wind nebula. The two silhouetted
// planets grow much faster than the pulsar (one harder than the other) and
// saturate/darken as they fill more of the frame, selling the "camera is
// approaching the system" feel. All wave-driven values are read from a
// smoothed displayWaveLevel so wave transitions glide rather than snap.

type Vec3 = { x: number; y: number; z: number };

type Planet = {
  // Logical offset from screen center as a fraction of the smaller screen
  // dimension. Drift is applied to angle over time; the radius is what
  // shrinks as waves progress (camera-approach effect).
  baseAngle: number;
  // Radians per second. The two planets have different angular speeds so
  // their silhouettes don't track in lockstep. Kept small so the planets
  // read as distant background drift rather than active orbiters.
  angularSpeed: number;
  // Fractional distance from center (of min(w,h)) at wave 1. Reduced each
  // wave to simulate approach.
  baseRadiusFrac: number;
  // Base on-screen radius (pixels) at approach=0.
  baseSize: number;
  // Per-unit-approach size multiplier. Both planets grow faster than the
  // pulsar; the more prominent planet has a noticeably larger value here so
  // the parallax differential reads.
  growthRate: number;
  // Flat silhouette HSL. Saturation and lightness are recomputed each frame
  // from baseSat/satGrowth/baseLight/lightDrop so the planet darkens and
  // saturates as the camera approaches.
  hue: number;
  baseSat: number;
  satGrowth: number;
  baseLight: number;
  lightDrop: number;
  // Set on the two planets that are really bosses biding their time. A boss
  // body ignores the linear growth above and swells on a hard power curve
  // instead, so it stays a distant speck for most of its act and only looms
  // in the last stretch; `fullApproach` is the approach value at which it
  // reaches full size — its own boss wave.
  bossAct?: number;
  fullApproach?: number;
};

// A moon of the Act II tomb. During Act II these are what the player watches
// arrive: they start as a tight ring of specks around the tomb, and one by one
// (at `departAt`, a point in the act's progress) they break orbit and take up a
// slow pass through the near field — huge, dark, unlit shapes wheeling around
// the ship, tolling on the beat they will hold in the fight. By the wave before
// the boss all four are out there, and on the boss wave they stop being scenery
// and start being Pallbearers.
type TombSatellite = {
  // Slot on the ring around the tomb, and how fast that ring turns.
  baseAngle: number;
  angularSpeed: number;
  // Ring radius and body size, both as fractions of the tomb's on-screen size.
  ringFrac: number;
  sizeFrac: number;
  // Act II progress (0..1) at which this one breaks orbit for its near pass.
  departAt: number;
  // The near pass: heading and speed across the field, on-screen radius, and
  // where on the field it starts from.
  passHeading: number;
  passSpeed: number;
  passRadius: number;
  passOriginX: number;
  passOriginY: number;
  // Which beat of the measure this one tolls on — the same slot it will hold
  // as a Pallbearer, so the sky is already teaching the fight's rhythm.
  tollBeat: number;
};

// Distant foreground "stars" — really just planets seen from much farther out.
// They share the planets' tilted ecliptic and orbital drift (same orbitPoint),
// so the whole sky reads as one coherent system rather than a parallax slab
// sliding past. Each gets its own angle/speed/radius/brightness so they don't
// move in lockstep.
type EclipticStar = {
  baseAngle: number;
  angularSpeed: number;
  baseRadiusFrac: number;
  size: number;
  hue: number;
  brightness: number; // per-star alpha scalar (0..1) so brightness varies
  twinklePhase: number;
  twinkleSpeed: number;
};

export class Pulsar {
  w: number;
  h: number;
  // Position offset from center, in pixels. Starts well off-center so the
  // pulsar feels like a distant landmark; lerps toward (0, 0) as the camera
  // "approaches" across waves.
  baseOffsetX: number;
  baseOffsetY: number;
  // Pulse envelope (0..1). Decays each frame; bumped to a small value on
  // every beat and to 1.0 on each wave clear.
  pulse = 0;
  // Long-form post-wave flare envelope (0..1). Decays slowly over ~20s and
  // drives an additive glow + extra body brightness on top of the regular
  // per-beat pulse.
  flare = 0;
  // Authoritative wave level handed to us by the game. We smoothly lerp
  // displayWaveLevel toward this; all spatial calculations read from
  // displayWaveLevel.
  targetWaveLevel = 1;
  // Smoothed wave level. Lerps toward targetWaveLevel with a ~2s time
  // constant so wave transitions read as a continuous camera drift rather
  // than a snap from one configuration to the next.
  displayWaveLevel = 1;
  // Independent drift time so the planets keep moving even between waves.
  driftT = 0;
  // Continuous rotation phase in radians. Locked to the music via beatTime
  // (one full rotation every 2 beats), so each of the two opposing beams
  // sweeps past any given line of sight once per beat.
  spinAngle = 0;
  // 3D rotation axis of the neutron star, in screen-aligned coordinates
  // (+x right, +y down, +z out of the screen toward the viewer). Chosen to
  // be visibly off-vertical *and* leaning moderately toward the camera, so
  // the cone the magnetic axis sweeps passes through "pointing right at us"
  // and back out to the side — this is what gives the pulsar its 3D /
  // tilted-lighthouse character rather than a flat spinning disc.
  rotAxis: Vec3 = { x: 0.34, y: -0.74, z: 0.57 };
  // Orthonormal basis vectors in the plane perpendicular to rotAxis. Built
  // once in the constructor (rotAxis is fixed) and used to construct the
  // magnetic-axis cone each frame.
  rotAxisU: Vec3 = { x: 1, y: 0, z: 0 };
  rotAxisV: Vec3 = { x: 0, y: 1, z: 0 };
  // Angle between the magnetic axis and the rotation axis. ~60° lets one
  // beam swing all the way from "head-on at the viewer" (mz ≈ 1, bright
  // flash, streak collapses to nothing) round to "partially behind the
  // sphere" (mz < 0, fading out) within a single rotation, with the
  // opposite beam taking over near the back half — i.e. exactly the
  // asymmetric main-pulse / interpulse pattern real pulsars show.
  obliquity = (60 * Math.PI) / 180;
  // Last beat index we've already pulsed for. Tracking this here means the
  // game just hands us `beatTime` and we figure out when to flash without
  // any extra plumbing on the call site.
  lastBeatIndex = -1;
  planets: Planet[];
  eclipticStars: EclipticStar[] = [];
  tombSatellites: TombSatellite[] = [];
  // Music clock, cached from update() so the satellites overhead can toll on
  // the same measure the field does.
  private beatTime = 0;
  // Acts whose boss body has left the sky. A body is hidden the moment its own
  // fight begins — it has solidified into the field, and the thing the player
  // is shooting must not also be hanging overhead — and it never comes back.
  // Cleared when the game resets the state to "idle".
  private hiddenBossActs = new Set<number>();

  // Shockwave state machine. The pulsar occasionally (driven by the game,
  // roughly once every 5 waves) vibrates in place, flashes white-hot, then
  // emits an expanding ring that the game uses as a cue to shatter every
  // asteroid and shudder the ship. Phases:
  //   "idle"       — no shockwave in flight
  //   "pending"    — armed; waits for the next beat tick so the rumble
  //                  always starts on the music grid
  //   "vibrating"  — visible jitter ramps up; nothing else fires
  //   "flashing"   — single-frame trigger: emit the ring, signal callers
  //   "expanding"  — ring grows out to cover the screen, then we go idle
  shockPhase: "idle" | "pending" | "vibrating" | "flashing" | "expanding" = "idle";
  shockTimer = 0;
  // Extra spin contribution added on top of the music-locked spin during the
  // windup. Integrates an accelerating angular velocity so the pulsar
  // visibly speeds up over several seconds before the drop.
  shockSpinExtra = 0;
  // Where the ring originated (locked when we enter "flashing" so it doesn't
  // drift with pulsar approach mid-expansion). Set on the transition.
  shockOriginX = 0;
  shockOriginY = 0;
  // Pre-computed full-screen radius for the current shockwave so the ring
  // animates at a consistent speed regardless of which corner is farthest.
  shockTargetRadius = 0;
  // Game polls this each frame: true exactly once, on the frame the shock
  // ring is born, so the game can apply impact effects atomically.
  shockJustFired = false;
  // Same contract as shockJustFired, but for the pending→vibrating beat-tick
  // transition — the game keys the charge sound off it so audio starts with
  // the rumble, not when the event was scheduled.
  shockVibrateJustStarted = false;
  // Tuning constants. The long vibrate-then-flash beat is the tension build —
  // the bass-drop white-flash detonation is the payoff.
  static readonly SHOCK_VIBRATE_DURATION = 12.0;
  static readonly SHOCK_FLASH_DURATION = 0.42;
  static readonly SHOCK_EXPAND_DURATION = 1.5;

  // Boss-planet state. planets[0] (the prominent looming planet)
  // doubles as the first boss. Its drift is timed so the orbit naturally
  // carries it across the pulsar somewhere in the wave 7-9 range; that
  // eclipse is the visual cue for the impending boss. On the boss wave
  // itself we hide the planet entirely — the planetoid has "solidified
  // into the foreground" as the boss asteroid the gameplay system now
  // spawns. After the fight we keep it hidden so the shattered planetoid
  // doesn't pop back into the sky.
  //   "idle"        — normal planet rendering
  //   "foreshadow"  — wave just before the boss; same rendering as idle,
  //                   kept for any future cueing the game might want
  //   "active"      — boss is in play; planet hidden behind the asteroid
  //   "defeated"    — boss is dead; planet stays hidden until reset
  bossPlanetState: "idle" | "foreshadow" | "active" | "defeated" = "idle";

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    // Place the pulsar off to one side and somewhat above center initially
    // — biased to the upper-third so the ship has clear room mid-screen.
    this.baseOffsetX = -Math.min(w, h) * 0.28;
    this.baseOffsetY = -Math.min(w, h) * 0.18;

    this.planets = [
      // Larger / more prominent planet — also the boss planetoid. Deterministic
      // baseAngle + tuned angularSpeed so its orbit naturally carries it across
      // the pulsar somewhere around waves 7-9 for a typical run; fast players
      // see the eclipse a wave or two later, slow players a wave or two earlier.
      // Starting angle sits well clear of the pulsar's side of the sky; the
      // ellipse's near-pulsar pass happens around driftT ≈ 290s (θ ≈ 3.95).
      {
        baseAngle: 1.8,
        angularSpeed: 0.005,
        baseRadiusFrac: 0.38,
        baseSize: 12,
        growthRate: 7.4,
        // Boss menace-red, sourced from the boss entity so the foreshadow
        // planet and the planetoid that solidifies into the boss share one hue.
        hue: ENTITY_STATS.boss!.hue!,
        baseSat: 60,
        satGrowth: 30,
        baseLight: 7,
        lightDrop: 4,
        bossAct: 1,
        // approach() reads ~0.60 by the level-10 boss wave.
        fullApproach: 0.60,
      },
      // The Act II tomb. It has been up there since wave 1 as an unremarkable
      // second world; what makes it the Sepulchre is the ring of moons that
      // resolves around it once Act II opens, and the violet cathedral hue it
      // shares with every piece of masonry the act throws at the player.
      {
        baseAngle: rand(3.5, 4.2),
        angularSpeed: 0.0072,
        baseRadiusFrac: 0.30,
        baseSize: 10,
        growthRate: 9,
        hue: ENTITY_STATS.sepulchre!.hue!,
        baseSat: 45,
        satGrowth: 25,
        baseLight: 6,
        lightDrop: 2,
        bossAct: 2,
        // approach() has reached its 0.78 ceiling by the level-20 boss wave.
        fullApproach: 0.78,
      },
    ];

    this.generateEclipticStars();
    this.generateTombSatellites();

    // Build the (u, v) basis orthogonal to rotAxis. Cross rotAxis with the
    // world-z reference vector; if rotAxis happens to be near-parallel to
    // that (it isn't with the chosen values, but stay defensive in case the
    // axis is ever tweaked) fall back to crossing with world-x instead.
    const ax = this.rotAxis.x;
    const ay = this.rotAxis.y;
    const az = this.rotAxis.z;
    let refX = 0, refY = 0, refZ = 1;
    if (Math.abs(az) > 0.95) { refX = 1; refY = 0; refZ = 0; }
    const ux0 = ay * refZ - az * refY;
    const uy0 = az * refX - ax * refZ;
    const uz0 = ax * refY - ay * refX;
    const ulen = Math.hypot(ux0, uy0, uz0);
    this.rotAxisU = { x: ux0 / ulen, y: uy0 / ulen, z: uz0 / ulen };
    // v = rotAxis × u, already unit length because rotAxis and u are both
    // unit length and perpendicular.
    const ux = this.rotAxisU.x, uy = this.rotAxisU.y, uz = this.rotAxisU.z;
    this.rotAxisV = {
      x: ay * uz - az * uy,
      y: az * ux - ax * uz,
      z: ax * uy - ay * ux,
    };
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  // Per-beat soft pulse. Cheap and gentle — just nudges the envelope up so
  // there's a quiet flicker the player can feel rather than consciously see.
  beat() {
    this.pulse = Math.min(1, this.pulse + 0.35);
  }

  // Big visible+audible pulse at wave clear. Sets the long flare envelope to
  // 1; the renderer reads it as additive glow and extra size.
  waveClear() {
    this.pulse = 1;
    this.flare = 1;
  }

  // Arm a shockwave sequence: pending → vibrate → flash → expanding ring.
  // The vibrate itself begins on the next beat tick. Idempotent: calling it
  // again while one is in flight is ignored so the game can schedule freely
  // without tracking state itself.
  triggerShockwave() {
    if (this.shockPhase !== "idle") return;
    this.shockPhase = "pending";
    this.shockTimer = 0;
    this.shockSpinExtra = 0;
  }

  // True iff the shockwave has reached its flash apex — game uses this to
  // gate other behaviours (e.g. additive screen brightness).
  shockwaveActive(): boolean {
    return this.shockPhase !== "idle";
  }

  // Sets the target wave level for size/position. Going forward by one wave
  // triggers a smooth animated transition. Restarts (target lower than what
  // we're showing) and large jumps snap immediately so the player never sees
  // a several-second rewind of the scene.
  setWaveLevel(wave: number) {
    if (wave < this.targetWaveLevel || wave - this.displayWaveLevel > 1.5) {
      this.displayWaveLevel = wave;
    }
    this.targetWaveLevel = wave;
  }

  update(dt: number, beatTime: number, beatGrid: number) {
    this.driftT += dt;
    this.beatTime = beatTime;
    // Beat pulse decays quickly (sub-second), so it reads as a heartbeat,
    // not a sustain.
    this.pulse = Math.max(0, this.pulse - dt * 3.0);
    // Wave-clear flare lasts ~20s. Linear decay so the long drone has a
    // visible counterpart for its full duration.
    this.flare = Math.max(0, this.flare - dt / 20);

    this.shockJustFired = false;
    this.shockVibrateJustStarted = false;
    if (this.shockPhase !== "idle" && this.shockPhase !== "pending") {
      this.shockTimer += dt;
      // Spin-up: integrate an accelerating angular velocity so the pulsar
      // visibly winds itself up over the vibrate window. Quadratic in t
      // means the player reads "it's spinning faster" rather than a constant
      // fast spin. Frozen at the apex while flashing so the moment of impact
      // isn't a blur.
      if (this.shockPhase === "vibrating") {
        const t = Math.min(1, this.shockTimer / Pulsar.SHOCK_VIBRATE_DURATION);
        const omega = TAU * 0.5 + TAU * 18 * t * t;
        this.shockSpinExtra += omega * dt;
      }
      if (this.shockPhase === "vibrating" && this.shockTimer >= Pulsar.SHOCK_VIBRATE_DURATION) {
        const { x, y } = this.pulsarPos();
        this.shockOriginX = x;
        this.shockOriginY = y;
        const corners = [
          Math.hypot(x, y),
          Math.hypot(this.w - x, y),
          Math.hypot(x, this.h - y),
          Math.hypot(this.w - x, this.h - y),
        ];
        this.shockTargetRadius = Math.max(...corners) * 1.05;
        this.shockPhase = "flashing";
        this.shockTimer = 0;
        this.shockJustFired = true;
        // Detonation also retriggers the long flare so the body of the
        // pulsar reads as freshly-energised, not just the ring.
        this.flare = 1;
        this.pulse = 1;
      } else if (this.shockPhase === "flashing" && this.shockTimer >= Pulsar.SHOCK_FLASH_DURATION) {
        this.shockPhase = "expanding";
        this.shockTimer = 0;
      } else if (this.shockPhase === "expanding" && this.shockTimer >= Pulsar.SHOCK_EXPAND_DURATION) {
        this.shockPhase = "idle";
        this.shockTimer = 0;
        this.shockSpinExtra = 0;
      }
    }

    // Smooth wave-level lerp. dt/2.0 gives roughly a 2-second perceptual
    // time constant — visible drift, but settles well before the next wave
    // clear. Clamped at 1 so a frame stall doesn't overshoot.
    const lerpRate = Math.min(1, dt / 2.0);
    this.displayWaveLevel += (this.targetWaveLevel - this.displayWaveLevel) * lerpRate;

    // Spin phase derived directly from beatTime so it stays phase-locked to
    // the music regardless of slow-mo or frame stutter. Period = 2 beats
    // means each of the two opposing beams crosses any given line of sight
    // once per beat (alternating), naturally producing a main-pulse +
    // inter-pulse rhythm at the beat level. shockSpinExtra is added on top
    // during a big windup so the pulsar visibly accelerates past its normal
    // music-locked rotation.
    this.spinAngle = (beatTime / (beatGrid * 2)) * TAU + this.shockSpinExtra;

    // Trigger a soft pulse on each beat tick. Using floor(beatTime / grid)
    // means we'll catch up if multiple beats elapse in a single frame, and
    // it's resilient to slow-mo (caller passes the music-rate beatTime).
    // If beatTime moved backwards (new game reset it to 0 while we were
    // still tracking an older index), rebase so the next beat fires
    // promptly instead of waiting for the clock to catch up.
    const idx = Math.floor(beatTime / beatGrid);
    if (idx < this.lastBeatIndex) this.lastBeatIndex = idx - 1;
    if (idx > this.lastBeatIndex) {
      this.lastBeatIndex = idx;
      this.beat();
      if (this.shockPhase === "pending") {
        this.shockPhase = "vibrating";
        this.shockTimer = 0;
        this.shockVibrateJustStarted = true;
      }
    }
  }

  // Camera-approach factor. At wave 1 the pulsar+planets sit at their base
  // distance; each wave brings them closer. Capped so deep runs don't
  // overshoot the screen center.
  private approach(): number {
    return Math.min(0.78, (this.displayWaveLevel - 1) * 0.06);
  }

  // Build the distant ecliptic stars. Uses the cosmetic RNG so it never
  // perturbs the gameplay stream's draw count (replays re-sim from input;
  // an extra gameplay draw here would desync them). They sit farther out than
  // the two planets and drift at the slow planet's speed give-or-take 20%.
  private generateEclipticStars() {
    const cr = (min: number, max: number) => min + cosmeticRng() * (max - min);
    const count = 7;
    this.eclipticStars = [];
    for (let i = 0; i < count; i++) {
      const size = cr(1.6, 2.8);
      this.eclipticStars.push({
        baseAngle: cr(0, TAU),
        angularSpeed: 0.005 * cr(0.8, 1.2),
        baseRadiusFrac: cr(0.55, 1.1),
        size,
        hue: cr(195, 235),
        // bigger reads as nearer/brighter; keep within the old bright-star range
        brightness: 0.6 + 0.4 * ((size - 1.6) / 1.2),
        twinklePhase: cr(0, TAU),
        twinkleSpeed: cr(0.25, 0.9),
      });
    }
  }

  // Build the tomb's moons. Cosmetic RNG for the same reason the ecliptic
  // stars use it: these are pure backdrop, and an extra gameplay draw here
  // would desync every replay. Slots, toll beats and departure order all come
  // off the index, so the moon that breaks orbit first is the one holding the
  // first beat — the sky's arrival order is the fight's rhythm.
  private generateTombSatellites() {
    const cr = (min: number, max: number) => min + cosmeticRng() * (max - min);
    const count = ENTITY_CONFIG.sepulchre.bearerCount;
    this.tombSatellites = [];
    for (let i = 0; i < count; i++) {
      this.tombSatellites.push({
        baseAngle: (i / count) * TAU + cr(-0.25, 0.25),
        angularSpeed: cr(0.09, 0.15),
        ringFrac: cr(2.1, 2.7),
        sizeFrac: cr(0.17, 0.25),
        // Evenly spaced through the act, so one arrives every couple of waves
        // and all four are wheeling overhead by the wave before the fight.
        departAt: (i + 1) / (count + 1),
        passHeading: cr(0, TAU),
        passSpeed: cr(7, 13),
        passRadius: cr(110, 190),
        passOriginX: cr(0, 1),
        passOriginY: cr(0, 1),
        tollBeat: i,
      });
    }
  }

  // Screen-space angle of the shared ecliptic plane: perpendicular to the
  // pulsar's flare axis (beamAngle = atan2(rotAxis.y, rotAxis.x)), so the two
  // bright flares poke out symmetrically above and below the plane the planets
  // and ecliptic stars travel along. visualizerAnchor() exposes the same
  // beamAngle the spectrum visualizer aligns its flares to.
  eclipticTilt(): number {
    return Math.atan2(this.rotAxis.y, this.rotAxis.x) + Math.PI / 2;
  }

  // Place an orbiting body (planet or ecliptic star) at its current screen
  // position: an ellipse on the tilted ecliptic, rolled around the pulsar
  // focal so it shares the camera rotation. `angle` already folds in the
  // body's own angularSpeed*driftT. Single source of truth for the render
  // loop, the ecliptic stars, and bossPlanetPos() so the boss asteroid spawns
  // exactly where the planet was drawn. The camera (focal + roll) is passed in
  // so callers compute it once per frame — cameraView() consumes the cosmetic
  // RNG during a shock vibration, so calling it once-per-body would jitter the
  // shudder pattern.
  private orbitPoint(
    angle: number, baseRadiusFrac: number, approach: number, cam: { focalX: number; focalY: number; roll: number },
  ): { x: number; y: number } {
    const minDim = Math.min(this.w, this.h);
    const radiusFrac = baseRadiusFrac * (1 - approach * 0.55);
    const u = Math.cos(angle) * radiusFrac * minDim; // along the ecliptic (major)
    const v = Math.sin(angle) * radiusFrac * minDim * 0.6; // out-of-plane (minor)
    const tilt = this.eclipticTilt();
    const cosE = Math.cos(tilt);
    const sinE = Math.sin(tilt);
    const orbitX = u * cosE - v * sinE; // rotate ellipse onto the flare-⟂ plane
    const orbitY = u * sinE + v * cosE;
    const relX = this.w / 2 + orbitX - cam.focalX;
    const relY = this.h / 2 + orbitY - cam.focalY;
    const cosR = Math.cos(cam.roll);
    const sinR = Math.sin(cam.roll);
    return {
      x: cam.focalX + relX * cosR - relY * sinR,
      y: cam.focalY + relX * sinR + relY * cosR,
    };
  }

  // A distant ecliptic star: bright core + soft radial halo, with a slow
  // brightness breath so it shimmers without strobing. Per-star `brightness`
  // scales the whole thing so the field varies. Radial-gradient halo (never
  // shadowBlur). driftT (seconds) drives the breath.
  private paintEclipticStar(ctx: CanvasRenderingContext2D, star: EclipticStar, px: number, py: number) {
    const breath = 0.6 + 0.4 * Math.sin(this.driftT * star.twinkleSpeed + star.twinklePhase);
    const core = star.size * (0.85 + 0.15 * breath);
    const haloR = core * 7;
    const a = (0.5 + 0.4 * breath) * star.brightness;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // soft halo
    const g = ctx.createRadialGradient(px, py, 0, px, py, haloR);
    g.addColorStop(0, `hsla(${star.hue}, 75%, 90%, ${0.22 * a})`);
    g.addColorStop(0.35, `hsla(${star.hue}, 80%, 80%, ${0.07 * a})`);
    g.addColorStop(1, `hsla(${star.hue}, 80%, 80%, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(px - haloR, py - haloR, haloR * 2, haloR * 2);
    // bright core
    ctx.fillStyle = `hsla(${star.hue}, 60%, 96%, ${0.95 * a})`;
    ctx.beginPath();
    ctx.arc(px, py, core, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Current pulsar size in pixels. Grows linearly with the approach factor;
  // the per-frame pulse adds a small further bump.
  private currentRadius(): number {
    const approach = this.approach();
    const base = 4 + approach * 26;
    return base * (1 + 0.18 * this.pulse + 0.55 * this.flare);
  }

  private pulsarPos(): { x: number; y: number } {
    const approach = this.approach();
    const cx = this.w / 2;
    const cy = this.h / 2;
    // Lerp base offset toward (0,0) as approach grows. (1 - approach) means
    // wave 1 → full offset; high wave → near center.
    let x = cx + this.baseOffsetX * (1 - approach);
    let y = cy + this.baseOffsetY * (1 - approach);
    // Pre-shockwave vibration: while warming up, jitter the rendered
    // position by an amount that ramps from 0 to ~12px so the player sees
    // a visible "this thing is about to do something" tell. Once we cross
    // into "flashing" the ring is locked to the un-jittered origin captured
    // at the transition (see update), so render-time jitter is gated to the
    // vibrating phase only.
    if (this.shockPhase === "vibrating") {
      const t = Math.min(1, this.shockTimer / Pulsar.SHOCK_VIBRATE_DURATION);
      // Peaks heavy at the apex so the visual tension matches the audio
      // rising into the bass drop.
      const intensity = t * t * 22;
      // cosmetic shock-shudder offset (render-only) — gameplay stream would
      //   desync replays since render doesn't run during the muted re-sim.
      x += (cosmeticRng() - 0.5) * 2 * intensity;
      y += (cosmeticRng() - 0.5) * 2 * intensity;
    }
    return { x, y };
  }

  // Shared camera state for any background layer that wants to feel part
  // of the same parallax view as the pulsar. focal is the pulsar's screen
  // position (so close stars fan out radially from it as we approach), roll
  // is a slow continuous camera tilt accumulated over the run, and approach
  // is the same 0..0.78 dolly factor used everywhere else.
  cameraView(): { focalX: number; focalY: number; roll: number; approach: number } {
    const { x, y } = this.pulsarPos();
    const approach = this.approach();
    // ~8° of roll across the entire approach (displayWaveLevel ~1 → ~14).
    // Eased via approach (not displayWaveLevel directly) so the tilt rate
    // matches the same dolly the player already feels.
    const roll = approach * 0.14;
    return { focalX: x, focalY: y, roll, approach };
  }

  // Screen geometry the spectrum visualizer's radial mode aligns to: the
  // pulsar's on-screen centre, its current radius, and a FIXED screen-space
  // angle for the magnetic-axis line. As the pulsar spins, the live beam vector
  // sweeps an ellipse on screen centred on the rotation-axis projection — the
  // flashes are most prominent along that axis (the beams sweep through and
  // bloom hardest as they cross it). We hand back that stable axis so the ring
  // doesn't spin with the pulsar; it points where the flashes cluster.
  visualizerAnchor(): { x: number; y: number; r: number; beamAngle: number } {
    const { x, y } = this.pulsarPos();
    const beamAngle = Math.atan2(this.rotAxis.y, this.rotAxis.x);
    return { x, y, r: this.currentRadius(), beamAngle };
  }

  // Outward jitter direction the game applies to objects on the frame of
  // the flash. Vector from the shock origin toward the supplied point,
  // normalised; falls back to a random angle for points coincident with
  // the origin so the ship/asteroids always pick up *some* impulse.
  shockwaveImpulseAt(point: Vec): Vec {
    const [dx, dy] = toroidalDelta(
      point.x - this.shockOriginX, point.y - this.shockOriginY, this.w, this.h,
    );
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) {
      const a = rng() * TAU;
      return v(Math.cos(a), Math.sin(a));
    }
    return v(dx / d, dy / d);
  }

  render(ctx: CanvasRenderingContext2D) {
    const approach = this.approach();
    const minDim = Math.min(this.w, this.h);
    const { x: ppx, y: ppy } = this.pulsarPos();
    const r = this.currentRadius();
    const beat = this.pulse;
    const flare = this.flare;

    // Pulsar wind nebula — a soft violet/blue wash centred on the pulsar.
    // Drawn before the rest of the pulsar so the body sits in its own
    // remnant, the way the Crab pulsar does. Planets render *after* the
    // pulsar (see below) and therefore eclipse both the nebula and the
    // pulsar disc when they cross in front.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const nebulaRadius = r * 14 + minDim * 0.10;
    const nebulaAlpha = 0.06 + 0.08 * approach + 0.10 * flare;
    const nebula = ctx.createRadialGradient(ppx, ppy, 0, ppx, ppy, nebulaRadius);
    nebula.addColorStop(0, `hsla(265, 80%, 55%, ${nebulaAlpha})`);
    nebula.addColorStop(0.4, `hsla(220, 90%, 50%, ${nebulaAlpha * 0.5})`);
    nebula.addColorStop(1, `hsla(220, 90%, 50%, 0)`);
    ctx.fillStyle = nebula;
    ctx.beginPath();
    ctx.arc(ppx, ppy, nebulaRadius, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Outer flare ring — big and faint, only really visible during a wave
    // clear when `flare` is high.
    if (flare > 0.01) {
      const flareRadius = r * (6 + flare * 8);
      const flareGrad = ctx.createRadialGradient(ppx, ppy, 0, ppx, ppy, flareRadius);
      flareGrad.addColorStop(0, `hsla(190, 100%, 80%, ${0.18 * flare})`);
      flareGrad.addColorStop(0.4, `hsla(220, 100%, 70%, ${0.08 * flare})`);
      flareGrad.addColorStop(1, `hsla(220, 100%, 70%, 0)`);
      ctx.fillStyle = flareGrad;
      ctx.beginPath();
      ctx.arc(ppx, ppy, flareRadius, 0, TAU);
      ctx.fill();
    }

    // Medium glow — driven mostly by the per-beat pulse so the heartbeat is
    // visible even between waves.
    const glowRadius = r * (3.2 + beat * 1.5 + flare * 2.0);
    const glow = ctx.createRadialGradient(ppx, ppy, 0, ppx, ppy, glowRadius);
    const glowAlpha = 0.22 + 0.35 * beat + 0.25 * flare;
    glow.addColorStop(0, `hsla(195, 100%, 88%, ${glowAlpha})`);
    glow.addColorStop(0.5, `hsla(210, 100%, 70%, ${glowAlpha * 0.35})`);
    glow.addColorStop(1, `hsla(220, 100%, 60%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(ppx, ppy, glowRadius, 0, TAU);
    ctx.fill();

    // Build the magnetic-axis 3D direction for the current spin phase. The
    // magnetic axis sits at `obliquity` radians off the rotation axis and
    // sweeps around it as spinAngle advances; the opposite end gives the
    // second beam. We render them separately because, with a tilted axis,
    // the two beams have asymmetric visibility — one can be flashing right
    // at us while the other is hidden behind the sphere.
    const cosOb = Math.cos(this.obliquity);
    const sinOb = Math.sin(this.obliquity);
    const cs = Math.cos(this.spinAngle);
    const ss = Math.sin(this.spinAngle);
    const mx = cosOb * this.rotAxis.x + sinOb * (cs * this.rotAxisU.x + ss * this.rotAxisV.x);
    const my = cosOb * this.rotAxis.y + sinOb * (cs * this.rotAxisU.y + ss * this.rotAxisV.y);
    const mz = cosOb * this.rotAxis.z + sinOb * (cs * this.rotAxisU.z + ss * this.rotAxisV.z);
    const beamDirections: Vec3[] = [
      { x: mx, y: my, z: mz },
      { x: -mx, y: -my, z: -mz },
    ];

    // Overall amplitude of the 3D-specific overlays (beam streaks, head-on
    // flash, hot spots). Ramps with approach so early waves read as "barely
    // a hint of rotation on a distant point of light" and the full tilted-
    // lighthouse character only emerges as the camera closes in. Without
    // this every wave reads as equally cinematic and the progression flat-
    // tens out.
    const lighthouseIntensity = 0.15 + 0.85 * approach;

    // Per-beam render: foreshortened streak from the polar cap outward, plus
    // an additive head-on bloom centred on the projected cap when the beam
    // points at the camera. Visibility ramps from 0 at bz ≈ -0.3 (beam tips
    // behind the sphere) to 1 at bz ≥ 0.3 (beam clearly facing us); the
    // streak length is proportional to sqrt(1 - bz²) so it naturally
    // collapses to nothing at head-on while the bloom takes over.
    for (const beamDir of beamDirections) {
      const bx = beamDir.x;
      const by = beamDir.y;
      const bz = beamDir.z;
      const visibility = Math.max(0, Math.min(1, (bz + 0.3) / 0.6));
      if (visibility < 0.02) continue;

      const screenMag = Math.sqrt(Math.max(0, 1 - bz * bz));

      if (screenMag > 0.05) {
        const beamLen3D = r * (5 + flare * 3);
        const beamLenScreen = beamLen3D * screenMag;
        const beamWid = r * 0.45;
        const capX = ppx + bx * r;
        const capY = ppy + by * r;
        ctx.save();
        ctx.translate(capX, capY);
        ctx.rotate(Math.atan2(by, bx));
        const sgrad = ctx.createLinearGradient(0, 0, beamLenScreen, 0);
        const sa = (0.4 + 0.25 * beat + 0.3 * flare) * visibility * lighthouseIntensity;
        sgrad.addColorStop(0, `hsla(190, 100%, 95%, ${sa * 0.7})`);
        sgrad.addColorStop(0.15, `hsla(190, 100%, 95%, ${sa})`);
        sgrad.addColorStop(0.55, `hsla(200, 100%, 85%, ${sa * 0.35})`);
        sgrad.addColorStop(1, `hsla(220, 100%, 70%, 0)`);
        ctx.fillStyle = sgrad;
        ctx.beginPath();
        // Narrow at the cap (apex), widening toward the tip — the beam is a
        // cone of light leaving the surface.
        ctx.moveTo(0, -beamWid * 0.25);
        ctx.lineTo(beamLenScreen, -beamWid * 0.95);
        ctx.lineTo(beamLenScreen, beamWid * 0.95);
        ctx.lineTo(0, beamWid * 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // Head-on flash. Gated to a relatively narrow window near bz=1 (only
      // when the beam is genuinely close to pointing at us) so it reads as
      // a deliberate "the lighthouse just swept us" moment rather than a
      // continuous beacon. Centred on the projected polar cap, which sits
      // near (but not at) the disc centre when the beam is roughly head-on
      // — that off-centre wander is what sells the "tilted lighthouse"
      // feeling.
      if (bz > 0.55) {
        const headOn = (bz - 0.55) / 0.45;
        const flashX = ppx + bx * r * 0.9;
        const flashY = ppy + by * r * 0.9;
        const flashR = r * (1.2 + 1.6 * headOn);
        const flashA = 0.35 * headOn * (0.6 + 0.4 * beat + 0.3 * flare) * lighthouseIntensity;
        const fgrad = ctx.createRadialGradient(flashX, flashY, 0, flashX, flashY, flashR);
        fgrad.addColorStop(0, `hsla(190, 100%, 98%, ${flashA})`);
        fgrad.addColorStop(0.4, `hsla(200, 100%, 90%, ${flashA * 0.45})`);
        fgrad.addColorStop(1, `hsla(220, 100%, 80%, 0)`);
        ctx.fillStyle = fgrad;
        ctx.beginPath();
        ctx.arc(flashX, flashY, flashR, 0, TAU);
        ctx.fill();
      }
    }

    // Core dot — small, bright, nearly white. This is the actual "star".
    const coreAlpha = 0.7 + 0.3 * beat + 0.3 * flare;
    ctx.fillStyle = `hsla(190, 100%, 96%, ${Math.min(1, coreAlpha)})`;
    ctx.beginPath();
    ctx.arc(ppx, ppy, Math.max(1.2, r * 0.55), 0, TAU);
    ctx.fill();

    // Polar hot spots. Each one sits on the surface at the magnetic pole;
    // in 3D that's at position (±m) * r. The screen projection is just
    // (±mx*r, ±my*r), and we fade them out as their z-component tips behind
    // the sphere so they disappear smoothly at the limb instead of popping.
    // Because the rotation axis is tilted, the two spots trace tilted
    // ellipses on the disc — this is the strongest single cue that the
    // pulsar has a 3D orientation rather than being a flat spinner.
    const hotSpotR = Math.max(0.7, r * 0.15);
    const hotSpotBaseAlpha = Math.min(1, (0.55 + beat * 0.3 + flare * 0.3) * lighthouseIntensity);
    const polarSpotPositions: Vec3[] = [
      { x: mx, y: my, z: mz },
      { x: -mx, y: -my, z: -mz },
    ];
    for (const spot of polarSpotPositions) {
      const spotFade = Math.max(0, Math.min(1, (spot.z + 0.1) / 0.4));
      if (spotFade <= 0) continue;
      const sx = ppx + spot.x * r * 0.85;
      const sy = ppy + spot.y * r * 0.85;
      ctx.fillStyle = `hsla(0, 0%, 100%, ${hotSpotBaseAlpha * spotFade})`;
      ctx.beginPath();
      ctx.arc(sx, sy, hotSpotR, 0, TAU);
      ctx.fill();
    }

    // Hot center pinprick for that pulsar "lighthouse beam" feel.
    ctx.fillStyle = `hsla(0, 0%, 100%, ${Math.min(1, 0.5 + beat * 0.5 + flare * 0.5)})`;
    ctx.beginPath();
    ctx.arc(ppx, ppy, Math.max(0.6, r * 0.22), 0, TAU);
    ctx.fill();

    ctx.restore();

    // Shared camera for all orbiting bodies: focal = pulsar's already-computed
    // screen pos, roll = same continuous tilt cameraView() derives. Built once
    // here (not via cameraView() per body) so we don't re-run pulsarPos() — it
    // consumes the cosmetic RNG during a shock vibration.
    const cam = { focalX: ppx, focalY: ppy, roll: approach * 0.14 };

    // Distant ecliptic stars — drawn before the planets so the big silhouettes
    // occlude them. They orbit the same tilted ecliptic (orbitPoint) as the
    // planets, so the whole sky reads as one coherent system.
    for (const star of this.eclipticStars) {
      const angle = star.baseAngle + this.driftT * star.angularSpeed;
      const { x: px, y: py } = this.orbitPoint(angle, star.baseRadiusFrac, approach, cam);
      // off-screen orbiters cost nothing — skip with a generous margin for the halo
      if (px < -120 || px > this.w + 120 || py < -120 || py > this.h + 120) continue;
      this.paintEclipticStar(ctx, star, px, py);
    }

    // Planets — drawn AFTER the pulsar so they occlude it. Iterated back-
    // to-front: planets[1] is the smaller / farther one and goes down first,
    // planets[0] is the larger / closer one and goes on top so the two
    // silhouettes layer correctly when they cross.
    // Camera roll applied to all background planets so their orbits rotate
    // with the rest of the scene — sells "this is one coherent camera view"
    // rather than each layer floating independently.
    const actTwo = actTwoProgress(this.displayWaveLevel);
    for (let pi = this.planets.length - 1; pi >= 0; pi--) {
      const planet = this.planets[pi];
      if (planet.bossAct !== undefined && this.hiddenBossActs.has(planet.bossAct)) continue;

      // Position the planet on the shared tilted ecliptic, rolled around the
      // pulsar focal so planet and starfield share the camera rotation.
      const angle = planet.baseAngle + this.driftT * planet.angularSpeed;
      const { x: px, y: py } = this.orbitPoint(angle, planet.baseRadiusFrac, approach, cam);
      let size: number;
      let colorApproach: number;
      if (planet.bossAct !== undefined) {
        // Normalized progress 0→1 where 1 = full size on this body's own boss
        // wave. Eased with a power curve so it stays a small distant speck for
        // many waves and only swells noticeably in the final stretch.
        const fullness = Math.min(1, approach / planet.fullApproach!);
        const easedFullness = Math.pow(fullness, 2.8);
        size = planet.baseSize * (1 + easedFullness * planet.growthRate);
        // Color stays pure black until the body is nearly full size, then the
        // hue floods in over the final stretch so it "arrives" right as the
        // thing finishes looming into the level.
        colorApproach = approach * Math.max(0, (fullness - 0.82) / 0.18);
      } else {
        size = planet.baseSize * (1 + approach * planet.growthRate);
        colorApproach = approach;
      }

      this.renderPlanet(ctx, planet, px, py, size, ppx, ppy, r, colorApproach, beat, flare);
      if (planet.bossAct === 2 && actTwo > 0) this.renderTombRing(ctx, planet, px, py, size, actTwo);
    }

    // The moons that have already broken orbit, drifting through the near
    // field. Drawn after the planets — they are the closest thing in the sky,
    // and by the end of Act II they are wheeling around the ship itself.
    if (actTwo > 0 && !this.hiddenBossActs.has(2)) this.renderNearSatellites(ctx, actTwo);

    this.renderShockwave(ctx);
  }

  // Draw a single background planet on top of the pulsar. The disc itself is
  // a flat tinted silhouette (saturation climbs, lightness drops as we
  // approach); on top of that we add a crescent rim-light on the side facing
  // the pulsar, surface detail that fades in as the planet gets larger, and
  // an additive corona flare during an eclipse where the planet sits over
  // the pulsar's disc.
  private renderPlanet(
    ctx: CanvasRenderingContext2D,
    planet: Planet,
    px: number,
    py: number,
    size: number,
    ppx: number,
    ppy: number,
    pulsarR: number,
    approach: number,
    beat: number,
    flare: number,
  ) {
    // Dark silhouette — the planet is backlit, so its body sits in shadow
    // against the starfield. Saturation still climbs with approach so the
    // hue reads on the faint terminator detail, but the disc itself is
    // pushed very dark.
    const sat = planet.baseSat + approach * planet.satGrowth;
    const light = Math.max(1, planet.baseLight * 0.35 - approach * planet.lightDrop * 0.5);

    ctx.fillStyle = `hsl(${planet.hue}, ${sat}%, ${light}%)`;
    ctx.beginPath();
    this.tracePlanetDisc(ctx, px, py, size);
    ctx.fill();

    // Direction from planet toward pulsar — that side gets the rim light.
    const toPulsarX = ppx - px;
    const toPulsarY = ppy - py;
    const distToPulsar = Math.hypot(toPulsarX, toPulsarY);
    const nx = distToPulsar > 1e-3 ? toPulsarX / distToPulsar : 1;
    const ny = distToPulsar > 1e-3 ? toPulsarY / distToPulsar : 0;

    // The pulsar is a brilliant point-source much smaller than the planet,
    // so the eclipse plays out in three optically distinct phases keyed off
    // the pulsar disc's position relative to the planet's limb:
    //
    //   approach  — pulsar disc still outside the planet; the planet's
    //               leading limb forward-scatters pulsar light into a thin
    //               brilliant arc (no soft ambient halo — proximity alone
    //               must not glow the planet).
    //   contact   — pulsar disc straddling the limb; a single intense
    //               point of light leaks past the silhouette edge
    //               ("diamond ring"). Happens on ingress and egress.
    //   totality  — pulsar fully behind the planet; the only light reaching
    //               us has been refracted around the limb (a thin ring
    //               framing the entire silhouette) or transmitted through
    //               an atmosphere (a dim red wash on the body itself, the
    //               same Rayleigh path that turns the lunar eclipse red).
    //
    // ingress: 1 when pulsar disc is just touching the limb from outside,
    //          ramping to 0 once the disc is fully inside the silhouette.
    // totality: 0 until the pulsar disc is fully inside the silhouette,
    //           then 1 as it crosses the planet's center.
    const ingressStart = size + pulsarR;       // outside edges first touch
    const ingressEnd = Math.max(0, size - pulsarR); // pulsar fully inside limb
    let ingress = 0;
    if (distToPulsar < ingressStart && distToPulsar > ingressEnd) {
      ingress = (ingressStart - distToPulsar) / Math.max(1, ingressStart - ingressEnd);
    } else if (distToPulsar <= ingressEnd) {
      ingress = 1;
    }
    const totality = distToPulsar < ingressEnd
      ? Math.min(1, (ingressEnd - distToPulsar) / Math.max(1, ingressEnd))
      : 0;

    // Forward-scatter arc on the leading limb during approach. The bright
    // stop sits just inside the limb on the pulsar-facing side and the
    // gradient is clipped to the disc's exterior, so what survives is a
    // razor-thin crescent — the way a planet's atmosphere lights up when
    // a point source sits right behind its edge. Falls off the moment the
    // pulsar disc is fully behind the planet (totality takes over from
    // here). Critically: this term is gated on geometric contact, not on
    // ambient proximity, so a distant planet drifting near the pulsar
    // never picks up a glow.
    const approachBand = Math.max(0, Math.min(1, (size * 2.4 + pulsarR - distToPulsar) / Math.max(1, size * 1.4)));
    const arcStrength = approachBand * (1 - totality);
    if (arcStrength > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const arcAlpha = Math.min(1, 0.55 * arcStrength + 0.35 * ingress + 0.25 * flare * arcStrength);
      const anchor = size * 1.02;
      const acx = px + nx * anchor;
      const acy = py + ny * anchor;
      const arcOuter = size * (0.32 + 0.18 * ingress);
      const arc = ctx.createRadialGradient(acx, acy, 0, acx, acy, arcOuter);
      arc.addColorStop(0, `hsla(48, 100%, 96%, ${arcAlpha})`);
      arc.addColorStop(0.35, `hsla(38, 100%, 75%, ${arcAlpha * 0.65})`);
      arc.addColorStop(1, `hsla(20, 100%, 55%, 0)`);
      ctx.fillStyle = arc;
      ctx.beginPath();
      ctx.arc(acx, acy, arcOuter, 0, TAU);
      this.tracePlanetDisc(ctx, px, py, size, true);
      ctx.fill("evenodd");
      ctx.restore();
    }

    // Diamond ring — the pulsar peeks past the limb at second/third
    // contact. A single brilliant point of light sitting on the silhouette
    // edge at the contact angle. Peaks sharply when the pulsar disc is
    // about half-occluded; intentionally dim because the corona of a small
    // star is many orders dimmer than its photosphere, so this should read
    // as a quick glint rather than a sustained burst.
    const diamond = 4 * ingress * (1 - ingress);
    if (diamond > 0.02 && totality < 0.5) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const diamondAlpha = Math.min(1, 0.4 * diamond * (1 - totality * 1.5));
      const dcx = px + nx * size;
      const dcy = py + ny * size;
      const dR = pulsarR * (1.2 + 0.8 * diamond) + size * 0.04;
      const dGrad = ctx.createRadialGradient(dcx, dcy, 0, dcx, dcy, dR);
      dGrad.addColorStop(0, `hsla(50, 100%, 98%, ${diamondAlpha})`);
      dGrad.addColorStop(0.35, `hsla(40, 100%, 80%, ${diamondAlpha * 0.6})`);
      dGrad.addColorStop(1, `hsla(25, 100%, 55%, 0)`);
      ctx.fillStyle = dGrad;
      ctx.beginPath();
      ctx.arc(dcx, dcy, dR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Bailey's Beads — during contact (ingress and egress), photospheric
    // light leaks through "valleys" along the silhouette's limb, scattered
    // around the contact angle rather than concentrated at it. Gives the
    // moment asymmetric punctuation without a single bright burst.
    // Positions/sizes are seeded off the planet's stable hue+baseAngle so
    // a given planet's beads are consistent run to run.
    if (diamond > 0.05 && totality < 0.7) {
      const seed = Math.abs(Math.sin(planet.hue * 12.9898 + planet.baseAngle * 78.233));
      const beadCount = 5;
      const contactAngle = Math.atan2(ny, nx);
      // Spread the beads across an arc on the pulsar-facing limb. Wider
      // than the diamond ring's footprint so it reads as a different
      // optical event, not the same blob twice.
      const arcSpread = 1.1;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < beadCount; i++) {
        const slot = (i + 0.5) / beadCount;
        const jitter = ((seed * (i + 1) * 43.1) % 1) - 0.5;
        const angle = contactAngle + (slot - 0.5) * arcSpread + jitter * 0.18;
        const bx = px + Math.cos(angle) * size;
        const by = py + Math.sin(angle) * size;
        // Each bead has its own twinkle envelope and brightness so they
        // don't all peak simultaneously — sells "discrete points of light"
        // rather than a dashed line.
        const phase = (seed * (i * 7 + 3)) % 1;
        const twinkle = 0.4 + 0.6 * ((seed * (i + 2) * 17.5) % 1);
        const beadAlpha = Math.min(1, diamond * twinkle * (1 - totality * 1.2) * (0.55 + 0.45 * Math.sin((phase + i) * 9.7)));
        if (beadAlpha < 0.02) continue;
        const beadR = pulsarR * (0.35 + 0.4 * twinkle) + size * 0.012;
        const bg = ctx.createRadialGradient(bx, by, 0, bx, by, beadR);
        bg.addColorStop(0, `hsla(52, 100%, 96%, ${beadAlpha})`);
        bg.addColorStop(0.5, `hsla(38, 100%, 75%, ${beadAlpha * 0.5})`);
        bg.addColorStop(1, `hsla(20, 100%, 50%, 0)`);
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(bx, by, beadR, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // Lens flare — when the pulsar is at the limb (ingress/egress) or
    // freshly disappeared behind it, we're effectively pointing the camera
    // at a brilliant point source partially occluded by a much larger dark
    // body. Real optics respond with an anamorphic horizontal streak and
    // hot bloom centred on the source. Peaks during ingress/egress and
    // decays smoothly across early totality so the disappearance reads as
    // a flare blooming and then snuffing out.
    const flarePhase = Math.max(diamond, totality > 0 && totality < 0.25 ? (1 - totality / 0.25) * 0.5 : 0);
    if (flarePhase > 0.04) {
      // Anchor sits at the contact point during ingress and slides back
      // toward the planet centre as the pulsar buries — that's where the
      // last sliver of light is coming from.
      const anchor = size * (1 - 0.55 * totality);
      const fcx = px + nx * anchor;
      const fcy = py + ny * anchor;
      const fAlpha = Math.min(1, 0.42 * flarePhase * (1 - totality * 0.6));

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      // Hot bloom — radial, warm-white core falling to gold. Kept compact
      // so it reads as glint off the limb, not a flooded directional flare.
      const bloomR = size * (0.32 + 0.28 * flarePhase) + pulsarR * 1.2;
      const bloom = ctx.createRadialGradient(fcx, fcy, 0, fcx, fcy, bloomR);
      bloom.addColorStop(0, `hsla(55, 100%, 98%, ${fAlpha})`);
      bloom.addColorStop(0.25, `hsla(45, 100%, 85%, ${fAlpha * 0.55})`);
      bloom.addColorStop(0.65, `hsla(30, 100%, 60%, ${fAlpha * 0.15})`);
      bloom.addColorStop(1, `hsla(20, 100%, 50%, 0)`);
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(fcx, fcy, bloomR, 0, TAU);
      ctx.fill();

      // Anamorphic horizontal streak — the classic lens-flare bar. Drawn
      // as a wide ellipse with a radial gradient so the falloff is soft on
      // every edge (a rect+linear-gradient leaves hard top/bottom seams
      // that read as a white stripe rather than a flare ray). Shortened
      // significantly from the original so it punctuates rather than
      // dominates the frame.
      const streakLen = size * (1.6 + 1.1 * flarePhase);
      const streakH = Math.max(1.5, pulsarR * 0.6 + size * 0.018);
      const streakAlpha = fAlpha * 0.7;
      ctx.save();
      ctx.translate(fcx, fcy);
      ctx.scale(streakLen, streakH);
      const streak = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      streak.addColorStop(0, `hsla(190, 100%, 98%, ${streakAlpha})`);
      streak.addColorStop(0.3, `hsla(195, 100%, 90%, ${streakAlpha * 0.55})`);
      streak.addColorStop(0.7, `hsla(200, 100%, 80%, ${streakAlpha * 0.12})`);
      streak.addColorStop(1, `hsla(200, 100%, 80%, 0)`);
      ctx.fillStyle = streak;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, TAU);
      ctx.fill();
      ctx.restore();

      // Tiny secondary ghost on the opposite side of the frame centre —
      // sells the "lens" read by hinting at internal reflections.
      const fcxCenter = this.w / 2;
      const fcyCenter = this.h / 2;
      const ghostDx = (fcx - fcxCenter) * -0.45;
      const ghostDy = (fcy - fcyCenter) * -0.45;
      const gx = fcxCenter + ghostDx;
      const gy = fcyCenter + ghostDy;
      const ghostR = size * 0.35 * flarePhase + 6;
      const ghost = ctx.createRadialGradient(gx, gy, 0, gx, gy, ghostR);
      ghost.addColorStop(0, `hsla(180, 80%, 80%, ${fAlpha * 0.18})`);
      ghost.addColorStop(1, `hsla(220, 80%, 60%, 0)`);
      ctx.fillStyle = ghost;
      ctx.beginPath();
      ctx.arc(gx, gy, ghostR, 0, TAU);
      ctx.fill();

      ctx.restore();
    }

    // Totality: the pulsar is fully behind the planet. Two distinct
    // optical contributions:
    //
    //   1. A thin refraction ring around the *entire* limb — light
    //      bending around the planet via the atmosphere, framing the
    //      silhouette evenly rather than blooming on one side. Stays
    //      narrow and hot at the limb, falls off quickly outside.
    //   2. A dim red wash *through* the planet itself — the Rayleigh-
    //      scattered transmission path, the same physics that turns the
    //      Moon copper-red during a lunar eclipse. Painted as a soft
    //      radial gradient *clipped to the silhouette* so the body
    //      becomes faintly, eerily visible rather than going jet black.
    if (totality > 0.01) {
      ctx.save();

      // Red transmission glow on the body. Clipped to the silhouette and
      // drawn with normal compositing so it tints the dark disc rather
      // than bleaching it.
      ctx.save();
      ctx.beginPath();
      this.tracePlanetDisc(ctx, px, py, size);
      ctx.clip();
      const transAlpha = Math.min(1, 0.55 * totality + 0.2 * beat * totality);
      const trans = ctx.createRadialGradient(px, py, 0, px, py, size);
      trans.addColorStop(0, `hsla(8, 95%, 38%, ${transAlpha})`);
      trans.addColorStop(0.55, `hsla(15, 90%, 28%, ${transAlpha * 0.7})`);
      trans.addColorStop(1, `hsla(0, 80%, 8%, 0)`);
      ctx.fillStyle = trans;
      ctx.fillRect(px - size, py - size, size * 2, size * 2);
      ctx.restore();

      // Refraction ring around the whole limb. Two concentric stops
      // straddling size keep the bright band thin even at high totality.
      ctx.globalCompositeOperation = "lighter";
      const ringAlpha = Math.min(1, 0.5 * totality + 0.25 * flare * totality);
      const ringOuter = size * (1.06 + 0.05 * totality);
      const ringInner = size * 0.94;
      const ring = ctx.createRadialGradient(px, py, ringInner, px, py, ringOuter);
      ring.addColorStop(0, `hsla(20, 90%, 25%, 0)`);
      ring.addColorStop(0.5, `hsla(35, 100%, 80%, ${ringAlpha})`);
      ring.addColorStop(1, `hsla(15, 100%, 55%, 0)`);
      ctx.fillStyle = ring;
      ctx.beginPath();
      ctx.arc(px, py, ringOuter, 0, TAU);
      this.tracePlanetDisc(ctx, px, py, size, true);
      ctx.fill("evenodd");
      ctx.restore();
    }
  }

  // Bright flash + expanding ring overlay drawn after the rest of the
  // pulsar so it always sits on top. Separate from the main render path so
  // the regular per-frame draw stays readable.
  private renderShockwave(ctx: CanvasRenderingContext2D) {
    if (this.shockPhase === "idle" || this.shockPhase === "vibrating") return;
    const ox = this.shockOriginX;
    const oy = this.shockOriginY;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    if (this.shockPhase === "flashing") {
      // Blue-tinted bloom centred on the origin, drawn underneath the entity
      // layers. The pure-white wash that actually covers the screen on the
      // bass drop is rendered separately by renderShockwaveOverlay() so it
      // sits above everything else.
      const t = this.shockTimer / Pulsar.SHOCK_FLASH_DURATION;
      const env = Math.sin(Math.min(1, t) * Math.PI);
      const flashRadius = Math.max(this.w, this.h);
      const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, flashRadius * 0.8);
      grad.addColorStop(0, `hsla(195, 100%, 98%, ${0.85 * env})`);
      grad.addColorStop(0.25, `hsla(200, 100%, 80%, ${0.45 * env})`);
      grad.addColorStop(1, `hsla(220, 100%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    if (this.shockPhase === "expanding") {
      const t = this.shockTimer / Pulsar.SHOCK_EXPAND_DURATION;
      // Ease-out so the ring lunges outward fast at first and trails into
      // the corners — feels more like a wavefront than a linear sweep.
      const eased = 1 - Math.pow(1 - t, 2);
      const ringRadius = eased * this.shockTargetRadius;
      const alpha = Math.max(0, 1 - t);
      const thickness = 14 + 38 * (1 - t);
      // Outer feathered ring — additive bloom hugging the leading edge.
      const ringGrad = ctx.createRadialGradient(ox, oy, Math.max(0, ringRadius - thickness), ox, oy, ringRadius + thickness * 0.3);
      ringGrad.addColorStop(0, `hsla(210, 100%, 70%, 0)`);
      ringGrad.addColorStop(0.7, `hsla(200, 100%, 80%, ${0.55 * alpha})`);
      ringGrad.addColorStop(1, `hsla(195, 100%, 95%, ${0.9 * alpha})`);
      ctx.fillStyle = ringGrad;
      ctx.beginPath();
      ctx.arc(ox, oy, ringRadius + thickness * 0.3, 0, TAU);
      ctx.arc(ox, oy, Math.max(0, ringRadius - thickness), 0, TAU, true);
      ctx.fill();
      // Crisp bright leading edge so the ring reads even on busy frames.
      ctx.strokeStyle = `hsla(195, 100%, 98%, ${alpha})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(ox, oy, ringRadius, 0, TAU);
      ctx.stroke();
    }

    ctx.restore();
  }

  // Full-screen overlay drawn AFTER all entities so it actually covers the
  // scene — slams the whole frame white on the bass drop. The tinted radial
  // in renderShockwave() stays underneath the entity layers as a coloured
  // backdrop; this is the wash that actually whites out the view.
  renderShockwaveOverlay(ctx: CanvasRenderingContext2D) {
    if (this.shockPhase !== "flashing") return;
    const t = this.shockTimer / Pulsar.SHOCK_FLASH_DURATION;
    // Hold pure white for the first ~30% of the flash window so the moment
    // of impact is unambiguous, then fade linearly back to clear over the
    // remainder — feels like an overload recovering, not a single frame.
    const whiteAlpha = t < 0.3 ? 1 : Math.max(0, 1 - (t - 0.3) / 0.7);
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${whiteAlpha})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  // Strength of this moon's toll right now, 1 on its own beat of the measure
  // and decaying across the beat. The four of them light in turn, so the sky
  // walks the same four-beat knell the bearers will hold in the fight.
  private satelliteToll(tollBeat: number): number {
    const measure = BEAT_GRID * 4;
    const since = (((this.beatTime - tollBeat * BEAT_GRID) % measure) + measure) % measure;
    return Math.max(0, 1 - since / (BEAT_GRID * 0.9));
  }

  // How present a moon is in each of its two lives. The sky ring fades a moon
  // out over the last stretch before it departs and the near pass fades the
  // same moon in just after, so a departure reads as one object moving from
  // background to foreground rather than two objects blinking.
  private static readonly SATELLITE_DEPART_FADE = 0.05;
  private static readonly SATELLITE_ARRIVE_FADE = 0.08;

  // The tomb's ring of moons, still in orbit. They ride the same tilted
  // ecliptic the rest of the sky does, so the ring reads as a real orbit seen
  // edge-on-ish rather than a flat circle pasted over the planet.
  private renderTombRing(
    ctx: CanvasRenderingContext2D,
    planet: Planet,
    px: number,
    py: number,
    size: number,
    progress: number,
  ) {
    const tilt = this.eclipticTilt();
    const cosE = Math.cos(tilt);
    const sinE = Math.sin(tilt);
    for (const satellite of this.tombSatellites) {
      const fadeStart = satellite.departAt - Pulsar.SATELLITE_DEPART_FADE;
      if (progress >= satellite.departAt) continue;
      const leaving = Math.max(0, (progress - fadeStart) / Pulsar.SATELLITE_DEPART_FADE);
      // The ring only resolves as the act runs on: at the top of Act II these
      // are barely-there specks, and they are unmistakable by the end.
      const alpha = Math.min(1, 0.55 + progress * 0.6) * (1 - leaving);
      if (alpha <= 0.01) continue;
      const angle = satellite.baseAngle + this.driftT * satellite.angularSpeed;
      const u = Math.cos(angle) * size * satellite.ringFrac;
      const v = Math.sin(angle) * size * satellite.ringFrac * 0.45;
      this.paintSatellite(
        ctx,
        px + u * cosE - v * sinE,
        py + u * sinE + v * cosE,
        Math.max(1.5, size * satellite.sizeFrac),
        planet.hue,
        alpha,
        this.satelliteToll(satellite.tollBeat),
        1.7,
      );
    }
  }

  // Moons that have broken orbit and are making their slow pass through the
  // near field. Position is integrated straight off driftT and wrapped around a
  // margin past the screen, so each one crosses, leaves, and comes round again
  // for as long as the act lasts — the player keeps finding one of them looming
  // somewhere off the ship's shoulder.
  private renderNearSatellites(ctx: CanvasRenderingContext2D, progress: number) {
    for (const satellite of this.tombSatellites) {
      if (progress < satellite.departAt) continue;
      const alpha = Math.min(1, (progress - satellite.departAt) / Pulsar.SATELLITE_ARRIVE_FADE);
      const margin = satellite.passRadius * 2;
      const spanX = this.w + margin * 2;
      const spanY = this.h + margin * 2;
      const travelled = this.driftT * satellite.passSpeed;
      const x0 = satellite.passOriginX * spanX + Math.cos(satellite.passHeading) * travelled;
      const y0 = satellite.passOriginY * spanY + Math.sin(satellite.passHeading) * travelled;
      this.paintSatellite(
        ctx,
        ((x0 % spanX) + spanX) % spanX - margin,
        ((y0 % spanY) + spanY) % spanY - margin,
        satellite.passRadius,
        this.planets[1].hue,
        alpha,
        this.satelliteToll(satellite.tollBeat),
        0.8,
      );
    }
  }

  // One moon, at any scale: a lit body with a real terminator, a scatter of
  // carved pits so the silhouette is a worked thing rather than a ball, and a
  // dark contact rim with a thin catch of light over it to seat it against the
  // starfield. The lamp on its face is a small hot point, not a wash — these
  // have to loom past the playfield without ever competing with a target for
  // the player's eye, so the only moment one is bright is the beat it tolls on.
  private paintSatellite(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    hue: number,
    alpha: number,
    toll: number,
    lampScale: number,
  ) {
    ctx.save();
    ctx.globalAlpha = alpha * 0.62;

    const body = ctx.createRadialGradient(x - radius * 0.4, y - radius * 0.45, radius * 0.1, x, y, radius * 1.15);
    body.addColorStop(0, `hsl(${hue + 6}, 26%, 13%)`);
    body.addColorStop(0.55, `hsl(${hue}, 30%, 6%)`);
    body.addColorStop(1, `hsl(${hue - 14}, 38%, 2%)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();

    // Pits, each with a lit up-left lip and a dark floor. Deterministic off the
    // index so a moon weathers the same way every frame.
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.clip();
    for (let i = 0; i < 4; i++) {
      const a = i * 2.4 + hue;
      const d = radius * (0.25 + 0.45 * Math.abs(Math.cos(i * 1.7)));
      const pr = radius * (0.12 + 0.1 * Math.abs(Math.sin(i * 1.3)));
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      const pit = ctx.createRadialGradient(px + pr * 0.25, py + pr * 0.25, 0, px, py, pr);
      pit.addColorStop(0, `hsla(${hue}, 30%, 2%, 0.55)`);
      pit.addColorStop(1, `hsla(${hue}, 26%, 12%, 0)`);
      ctx.fillStyle = pit;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, TAU);
      ctx.fill();
      const lip = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, 0, px - pr * 0.4, py - pr * 0.4, pr * 0.85);
      lip.addColorStop(0, `hsla(${hue + 10}, 24%, 40%, 0.16)`);
      lip.addColorStop(1, `hsla(${hue}, 24%, 20%, 0)`);
      ctx.fillStyle = lip;
      ctx.beginPath();
      ctx.arc(px - pr * 0.4, py - pr * 0.4, pr * 0.85, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    ctx.strokeStyle = `hsla(${hue}, 40%, 2%, 0.9)`;
    ctx.lineWidth = Math.max(1, radius * 0.05);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${hue + 12}, 55%, 58%, 0.22)`;
    ctx.lineWidth = Math.max(0.6, radius * 0.011);
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.96, Math.PI * 0.82, Math.PI * 1.88);
    ctx.stroke();

    ctx.globalCompositeOperation = "lighter";
    // Small bodies far away need a proportionally bigger lamp to read at all;
    // a near one needs a smaller one or it washes its own face out.
    const lampR = radius * 0.13 * lampScale * (1 + 0.4 * toll);
    const lamp = ctx.createRadialGradient(x, y, 0, x, y, lampR * 3.2);
    lamp.addColorStop(0, `hsla(${hue + 20}, 100%, 90%, ${0.14 + 0.5 * toll})`);
    lamp.addColorStop(0.35, `hsla(${hue + 4}, 100%, 62%, ${0.04 + 0.16 * toll})`);
    lamp.addColorStop(1, `hsla(${hue}, 100%, 55%, 0)`);
    ctx.fillStyle = lamp;
    ctx.beginPath();
    ctx.arc(x, y, lampR * 3.2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Game tells us where the boss-planet life-cycle sits. Idle is the default;
  // foreshadow is the wave just before the boss spawns (no special rendering
  // any more — the eclipse is what cues the player); active hides the planet
  // entirely while the boss is on the field; defeated locks it hidden so the
  // planetoid that was just shattered doesn't pop back into the sky.
  setBossPlanetState(state: "idle" | "foreshadow" | "active" | "defeated", act: number = 1) {
    this.bossPlanetState = state;
    if (state === "idle") this.hiddenBossActs.clear();
    else if (state === "active" || state === "defeated") this.hiddenBossActs.add(act);
  }

  // Current on-screen position of an act's boss body. Used by the wave director
  // to spawn the fight where the looming thing was drifting, so the transition
  // reads as the body itself solidifying into play rather than a fresh object
  // teleporting in.
  bossBodyPos(act: number): { x: number; y: number } {
    const planet = this.planets.find((p) => p.bossAct === act) ?? this.planets[0];
    // Same orbitPoint the planet render uses (shared tilted ecliptic + camera
    // roll), so the boss asteroid spawns exactly where the player saw the planet.
    const angle = planet.baseAngle + this.driftT * planet.angularSpeed;
    return this.orbitPoint(angle, planet.baseRadiusFrac, this.approach(), this.cameraView());
  }

  bossPlanetPos(): { x: number; y: number } {
    return this.bossBodyPos(1);
  }

  // Silhouette for a background planet: a smooth sphere with the faint
  // equatorial bulge every spinning world has. Real oblateness (Earth's is
  // ~0.3%) is far too small to survive rasterisation, so we exaggerate it to
  // ~3% — enough that the limb reads as a rotating body rather than a drawn
  // circle, small enough that it never reads as an egg. `reverse` traces the
  // path counter-clockwise for use as an even-odd cutout inside the halo
  // annulus.
  private static readonly PLANET_FLATTENING = 0.03;
  private tracePlanetDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, reverse: boolean = false) {
    ctx.ellipse(cx, cy, size, size * (1 - Pulsar.PLANET_FLATTENING), 0, 0, TAU, reverse);
  }
}
