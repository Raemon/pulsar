import { drawGlow } from "./glow";
// Visual trail only — cosmetic stream so it can't desync replays.
import { cosmeticRng as rng } from "./game/rng";

// Pre-baked, GC-free glow trail. Each trailed object owns one Trail; the trail
// records (x, y, age) for the object's recent positions in a fixed-size ring
// buffer and renders them as additive glow stamps with brightness and scale
// driven by a closed-form pulse function of (time, point-index, frequency).
//
// Performance discipline (this module is hot):
//   - Fixed-capacity Float32Array. Never push/shift, never allocate per frame.
//   - No per-point object allocation. Indexing is `i * STRIDE + offset`.
//   - All glow stamps go through the cached sprite in glow.ts (no shadowBlur,
//     no per-frame createRadialGradient).
//   - The caller (Game.render) sets globalCompositeOperation = "lighter" ONCE
//     around the whole trail pass, so render() must not toggle composite mode.
//   - Pulse curves are closed-form sin/cos driven by `time` (milliseconds);
//     we never sample the audio graph for these visuals.
//
// The trail is *not* a particle system: there is no per-point velocity, no
// per-point update loop, no per-point lifetime decay branching. Update only
// stamps a new head and increments a shared sample counter; render walks the
// ring once and stamps one sprite per live sample.

export type TrailPulse =
  // Slow, deep breathing — for bass drone sources. Brightness rides a slow
  // sinusoid; scale tracks it. One major lobe per ~1s.
  | "bass"
  // Vibrato wobble — for alien theremin. Brightness has a fast tremolo on
  // top of a slow swell; scale wavers slightly per-sample for a sinuous edge.
  | "theremin"
  // Higher-frequency multi-LFO — for comet shimmer pad. Brightness has two
  // beating LFOs that drift in and out of phase to read as glittery.
  | "shimmer"
  // Heartbeat — for the pulsar. Sharp two-stage pulse (lub-dub) keyed to the
  // beat phase the caller hands in; falls back to a slow sine if no phase.
  | "heartbeat";

// Stride per sample: x, y, age (seconds). Plain Float32Array gives us GC-free
// storage and excellent cache behaviour for the linear walk in render().
const STRIDE = 3;

// Default ring capacity per trail. Tuned so even the longest-lived trails are
// well under a kilobyte each (48 * 3 * 4 = 576 bytes).
const DEFAULT_CAPACITY = 48;

// Don't push a new sample if we moved less than this many pixels since the
// last one. Avoids piling stamps on top of each other for slow-moving
// objects, which would burn fill rate without adding any visual richness.
// Kept low (2 px) so even ponderous gen-0 bassteroids deposit samples each
// few frames rather than going entire seconds without one.
const MIN_SAMPLE_DISTANCE_SQ = 2 * 2;

// Wall-clock seconds a sample remains visible. Old samples are skipped in
// render rather than removed (the ring naturally overwrites them as the head
// advances), so this is purely a cutoff on the per-point alpha curve.
const MAX_AGE_SECONDS = 1.4;

export class Trail {
  // Ring buffer of [x, y, age] triplets. `head` indexes the next slot to
  // write into. `count` rises from 0 to capacity and then sticks (the ring
  // is full and we keep overwriting the oldest slot).
  private readonly buf: Float32Array;
  private readonly capacity: number;
  private head = 0;
  private count = 0;
  // Last sample position; used for the move-threshold check so we don't
  // stamp redundant samples while drifting in place.
  private lastX = Number.NaN;
  private lastY = Number.NaN;

  // Visual configuration. None of these change per frame; they're read by
  // render() each frame but the trail object itself owns them so the render
  // path doesn't need any per-object lookups.
  hue: number;
  // Base stamp radius in pixels. Scaled by the per-sample pulse + age fade.
  baseRadius: number;
  // Peak alpha at the head of the trail. Scaled by the per-sample pulse +
  // age fade. Kept below 1 so trails layer cleanly with each other under
  // additive blending without clipping.
  baseAlpha: number;
  // Pulse character — selects the closed-form curve used for brightness/scale.
  pulse: TrailPulse;
  // Pulse rate (Hz-ish — a free multiplier on time in the chosen curve).
  // Loosely musical, not sample-accurate to the audio source.
  pulseRate: number;
  // Per-instance phase offset so multiple objects of the same type don't all
  // pulse in lockstep, which would read as one big strobe.
  phase: number;

  constructor(
    hue: number,
    baseRadius: number,
    baseAlpha: number,
    pulse: TrailPulse,
    pulseRate: number,
    capacity: number = DEFAULT_CAPACITY,
  ) {
    this.hue = hue;
    this.baseRadius = baseRadius;
    this.baseAlpha = baseAlpha;
    this.pulse = pulse;
    this.pulseRate = pulseRate;
    this.phase = rng() * Math.PI * 2;
    this.capacity = capacity;
    this.buf = new Float32Array(capacity * STRIDE);
  }

  // Forget every sample — for an owner that left play and comes back
  // somewhere else (a Warp Cannon return), so no streak joins the two.
  clear() {
    this.head = 0;
    this.count = 0;
    this.lastX = Number.NaN;
    this.lastY = Number.NaN;
  }

  // Stamp a new sample at (x, y) if we've moved far enough since the last
  // one, and age every live sample by dt seconds. This is the only place we
  // touch the ring buffer — everything else is read-only.
  //
  // Position wrap (asteroids/aliens wrap the playfield) can teleport the
  // owner across the screen. We detect that via the move threshold's upper
  // bound — anything farther than a screen-jump is treated as a reset so the
  // trail doesn't draw a cross-screen streak.
  update(dt: number, x: number, y: number) {
    // Age all live samples first. Skipping samples whose age has crossed
    // MAX_AGE_SECONDS happens at render time — overwriting them is the ring's
    // job and aging them past the cutoff is harmless.
    const buf = this.buf;
    const live = this.count;
    for (let i = 0; i < live; i++) {
      buf[i * STRIDE + 2] += dt;
    }
    // Skip-or-stamp decision.
    if (Number.isNaN(this.lastX)) {
      this.writeHead(x, y);
      return;
    }
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const d2 = dx * dx + dy * dy;
    if (d2 < MIN_SAMPLE_DISTANCE_SQ) return;
    // Screen-wrap teleport: don't connect old trail to new position.
    if (d2 > 200 * 200) {
      this.head = 0;
      this.count = 0;
    }
    this.writeHead(x, y);
  }

  // Carry the recorded wake across a torus fold so it stays attached to the
  // owner instead of resetting at the seam. `ox/oy` is the fold offset the
  // owner's position just took (see wrapMut's return).
  shift(ox: number, oy: number) {
    const buf = this.buf;
    const live = this.count;
    for (let i = 0; i < live; i++) {
      const base = i * STRIDE;
      buf[base] += ox;
      buf[base + 1] += oy;
    }
    if (!Number.isNaN(this.lastX)) {
      this.lastX += ox;
      this.lastY += oy;
    }
  }

  // True when every visible sample, shifted by (ox, oy), sits inside
  // [0,w)x[0,h). The entrance state uses this to decide the whole wake has
  // slid on-screen before handing the body to the wrapped world layer.
  allInside(ox: number, oy: number, w: number, h: number): boolean {
    const buf = this.buf;
    const live = this.count;
    for (let i = 0; i < live; i++) {
      const base = i * STRIDE;
      if (buf[base + 2] >= MAX_AGE_SECONDS) continue;
      const x = buf[base] + ox;
      const y = buf[base + 1] + oy;
      if (x < 0 || x >= w || y < 0 || y >= h) return false;
    }
    return true;
  }

  // Internal: place (x, y, age=0) at head, advance head, grow count up to cap.
  private writeHead(x: number, y: number) {
    const base = this.head * STRIDE;
    this.buf[base] = x;
    this.buf[base + 1] = y;
    this.buf[base + 2] = 0;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    this.lastX = x;
    this.lastY = y;
  }

  // Render every live sample as a glow stamp. Caller MUST have set
  // globalCompositeOperation = "lighter" before this and restore it after.
  // `tSeconds` is wall-clock seconds (game.time / 1000); used inside the
  // closed-form pulse curves.
  //
  // `beatPhase` is optional: pass 0..1 (fraction through the current beat)
  // for the "heartbeat" pulse; ignored by other pulse types.
  render(ctx: CanvasRenderingContext2D, tSeconds: number, beatPhase = 0) {
    const buf = this.buf;
    const cap = this.capacity;
    const count = this.count;
    if (count === 0) return;
    const hue = this.hue;
    const baseR = this.baseRadius;
    const baseA = this.baseAlpha;
    const rate = this.pulseRate;
    const phase = this.phase;
    const pulseKind = this.pulse;

    // Pre-compute the global pulse envelope ONCE per render. The per-sample
    // loop only multiplies in age-based fade — cheap, branch-light.
    let globalScale = 1;
    let globalAlpha = 1;
    const omega = tSeconds * rate + phase;
    if (pulseKind === "bass") {
      // Deep slow swell. One major lobe per ~1/rate sec.
      const s = 0.5 + 0.5 * Math.sin(omega);
      globalScale = 0.85 + 0.45 * s;
      globalAlpha = 0.6 + 0.4 * s;
    } else if (pulseKind === "theremin") {
      // Slow envelope + fast vibrato tremolo on top.
      const slow = 0.5 + 0.5 * Math.sin(omega);
      const vib = 0.5 + 0.5 * Math.sin(tSeconds * rate * 7.3 + phase);
      globalScale = 0.8 + 0.35 * slow;
      globalAlpha = 0.55 + 0.25 * slow + 0.2 * vib * slow;
    } else if (pulseKind === "shimmer") {
      // Two beating LFOs — they drift in and out of phase. Reads as glitter.
      const a = 0.5 + 0.5 * Math.sin(omega);
      const b = 0.5 + 0.5 * Math.sin(tSeconds * rate * 1.37 + phase * 1.7);
      const combined = (a + b) * 0.5;
      globalScale = 0.9 + 0.25 * combined;
      globalAlpha = 0.5 + 0.45 * combined;
    } else if (pulseKind === "heartbeat") {
      // lub-dub: two short peaks per beat. beatPhase ∈ [0, 1); peaks near
      // 0.0 (strong) and 0.25 (weaker).
      const p = beatPhase;
      const lub = Math.exp(-((p - 0.0) * 12) * ((p - 0.0) * 12));
      const dub = 0.55 * Math.exp(-((p - 0.22) * 14) * ((p - 0.22) * 14));
      const beat = Math.min(1, lub + dub);
      globalScale = 0.85 + 0.5 * beat;
      globalAlpha = 0.5 + 0.5 * beat;
    }

    // Walk the ring from oldest to newest so newer samples (drawn last) sit
    // on top under additive blend — they end up as the brightest layer along
    // the trail's leading edge. Oldest live index = (head - count + cap) % cap.
    const startIdx = (this.head - count + cap) % cap;
    const maxAge = MAX_AGE_SECONDS;
    for (let n = 0; n < count; n++) {
      const i = (startIdx + n) % cap;
      const base = i * STRIDE;
      const age = buf[base + 2];
      if (age >= maxAge) continue;
      // Age-based fade: cubic ease-out so the head stays bright and the tail
      // tapers smoothly rather than fading linearly to a hard edge.
      const ageT = 1 - age / maxAge;
      const ageFade = ageT * ageT;
      const alpha = baseA * globalAlpha * ageFade;
      if (alpha < 0.008) continue;
      // Slight per-sample size growth toward the head — older points are
      // smaller, head is largest — which sells the "wake widening behind"
      // look without needing a particle physics layer.
      const sizeT = 0.55 + 0.45 * ageT;
      const r = baseR * globalScale * sizeT;
      drawGlow(ctx, buf[base], buf[base + 1], r, hue, alpha);
    }
  }
}
