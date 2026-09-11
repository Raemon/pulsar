import type { Vec } from "../vec";
import type { Starfield } from "../Starfield";
// Seeds only — cosmetic stream so the portal's swirl/jitter never perturbs the
// gameplay RNG draw count and desyncs replays.
import { cosmeticRng as rng } from "./rng";

// A departure portal: aliens that fly past the far edge leave THROUGH this
// instead of popping off, and a kill tears a longer-lived skip portal the ship
// can dive into. Distinct from the canister upgrade's flat radial-streak vortex
// (Canister.renderWarp) — that one is a head-on swirl of spokes collapsing to a
// point. This is a gravitational lens torn in space: the portal is read almost
// entirely through what it does to the STARS BEHIND IT. Its slight tilt is
// fixed to the SCREEN, not to the body's line of flight, so it reads the same
// from every approach.
//
// Aesthetic: a swirling distortion of the starfield with faint red energy. The
// stars behind the mouth are dragged into tangential arcs that pile up on a
// bright ring around a lightless shadow, spiral in toward it, and slowly wheel
// around it — the whole disc reads as space itself being wound up and drawn
// down a drain. The red is a whisper on top: a thin horizon glow on the
// shadow's edge, a few hot filaments riding the ring, and long wisps of energy
// that peel off the horizon and spiral outward, thinning and fading to nothing.
//
// How the lensing is drawn (and why it isn't a baked pixel warp): the camera
// scrolls the star layers under their own parallax, so a snapshot of the pixels
// behind the mouth freezes the moment it's taken while the real stars keep
// streaming past — a skip portal lives for beats, and the seam would show. So
// the distortion is applied per STAR, not per pixel: the starfield yields the
// handful of stars under the mouth each frame (the same wrapped, parallaxed
// positions it paints), and each becomes a short lensed arc — a few dozen
// tiny strokes, batched by brightness. The static parts are prebaked: the dark
// lens body is one cached sprite, and the lens map (image radius for each source
// radius) is a lookup table built once.
//
// The effect is purely cosmetic and self-contained (same lifecycle shape as
// DriftBurst): spawn → update(dt) prunes by life → render() draws additively.
// The body's suck-in (scale-down + slide toward the anchor + spin) lives on the
// entity itself in its warp-out phase; the wormhole only owns the portal so the
// two can be sequenced (open → swallow → collapse) and the body always draws
// in front of the mouth.

const TAU = Math.PI * 2;

// Lifecycle (seconds): the mouth irises open, holds while the body is swallowed,
// then collapses. WARP_OUT_DURATION on the entity is tuned to land mid-hold.
const OPEN = 0.34;
const HOLD = 0.42;
const CLOSE = 0.4;
export const WORMHOLE_LIFE = OPEN + HOLD + CLOSE;

// Screen-fixed tilt: the hole is an ellipse squashed on the vertical so it reads
// as a round mouth seen from slightly above rather than a flat disc — but the
// squash is ALWAYS along the screen's y-axis, never rotated to the body's
// heading, so the portal looks identical no matter which way a body approached.
const TILT = 0.6; // vertical squash of the ellipse (1 = head-on circle)

// The inner iris (the actual hole) sits inside the outer lens. This is the
// inner iris's fraction of the full long axis; the ship's far-lip crop and the
// throat point are built from it.
const INNER_FRAC = 0.74;

// Long axis (px) of a portal torn by a body of this radius. The floor keeps a
// tiny body from punching an invisibly small hole. spawnWormhole and the
// entity's dive-anchor both go through this so the body always falls toward the
// portal's actual throat.
export const portalLongAxis = (bodyRadius: number): number => Math.max(40, bodyRadius * 2.0);

// Screen offset from the portal centre to its vanishing-point throat. Because
// the tilt is screen-fixed the throat always sits straight up-screen from the
// centre (up the minor axis), independent of the body's heading — every body
// dives "up and back" into the far side of the shadow. The entity eases its
// dive toward this point; it lies well inside the lightless core so the body
// is swallowed by black, never by starlight.
export const warpAnchorOffset = (
  bodyRadius: number, _heading: number,
): { dx: number; dy: number } => {
  const d = portalLongAxis(bodyRadius) * INNER_FRAC * 0.55 * TILT;
  return { dx: 0, dy: -d };
};

// ── Lens geometry, in units of the iris long axis (u = r / long) ────────────
// SHADOW: the lightless core — nothing behind it is seen. RING: the Einstein
// radius, where lensed starlight piles up into the bright ring; every source
// star's main image lands at or outside it. DEFLECT_END: where the bending has
// faded to nothing. COVER: how far the dark lens body reaches before feathering
// back into the untouched field (a touch past the bending so the last, barely
// displaced images sit on their own hidden originals rather than beside them).
const SHADOW = 0.5;
const RING = 0.62;
const DEFLECT_END = 1.25;
const COVER = 1.4;

// Static spiral twist of the lensed images at the ring (radians), and how fast
// the ring wheels: both fade to zero at DEFLECT_END so the outer field stays
// still and only the throat churns. PITCH tilts each streak off the tangent so
// its downstream end leans in toward the throat — the arcs read as a spiral
// draining inward, not concentric rings.
const TWIST = 1.3;
const SPIN = 1.1; // rad/s
const PITCH = 0.55; // radians off the tangent at the ring

// Hue band for the portal's own light. The rim/wisp highlight runs a touch
// toward orange (hotter) and the horizon a touch toward oxblood (deeper), so the
// wisps and the shadow's edge read as different temperatures of one ember.
const MEMBRANE_HUE = 8; // wisps + ring filaments — hot orange-red
const THROAT_HUE = 352; // horizon glow — deep oxblood red

export type Wormhole = {
  x: number;
  y: number;
  // Long axis of the ellipse (px) at full open — scaled from the body's radius
  // so a big alien tears a bigger hole than a comet.
  radius: number;
  // Vestigial as a frame rotation (the portal's tilt is screen-fixed), but used
  // as a per-portal phase so the wisps and swirl of simultaneous portals don't
  // line up. spawnWormhole seeds it from the heading so replays stay
  // deterministic.
  angle: number;
  hueShift: number; // small per-portal hue jitter so they don't all match
  seed: number;
  life: number;
  maxLife: number;
};

export type WormholeOpts = {
  holdSec?: number;
};

export const spawnWormhole = (
  list: Wormhole[], pos: Vec, bodyRadius: number, heading: number,
  opts?: WormholeOpts,
): Wormhole => {
  const life = OPEN + (opts?.holdSec ?? HOLD) + CLOSE;
  const wh: Wormhole = {
    x: pos.x,
    y: pos.y,
    radius: portalLongAxis(bodyRadius),
    angle: heading,
    hueShift: (rng() - 0.5) * 24,
    seed: rng() * TAU,
    life,
    maxLife: life,
  };
  list.push(wh);
  return wh;
};

export const updateWormholes = (list: Wormhole[], dt: number): Wormhole[] => {
  for (const wh of list) wh.life -= dt;
  return list.filter((wh) => wh.life > 0);
};

// Seconds a portal spends collapsing at the end of its life. Exported so the
// wave-skip code can cut a portal's remaining life to exactly the collapse.
export const WORMHOLE_CLOSE = CLOSE;

// A portal can swallow the ship only while the mouth is properly gaping —
// not during the iris-open and not once the collapse has begun.
export const wormholeEnterable = (wh: Wormhole): boolean =>
  wh.maxLife - wh.life >= OPEN && wh.life > CLOSE;

// Absolute position of the portal's vanishing-point throat — the point a
// diving body eases toward (mirrors warpAnchorOffset for a live portal). The
// tilt is screen-fixed, so the throat sits straight up-screen from the centre.
export const throatPointOf = (wh: Wormhole): { x: number; y: number } => {
  const d = wh.radius * INNER_FRAC * 0.55 * TILT;
  return { x: wh.x, y: wh.y - d };
};

// Clip the current context so that anything drawn afterward is HIDDEN where it
// crosses behind the far (upper) lip of the portal's inner iris — the ship
// sinking into the hole vanishes down the throat instead of floating over it.
//
// The mask is the whole viewport MINUS the far half of the inner iris: the top
// half of the tilted iris ellipse, from its horizontal centre-line up. A hull
// pixel up-screen of that centre-line and inside the iris falls in the hole and
// is masked away; the near (lower) lip never hides anything, so the ship reads
// as tucking under the far rim while its near side still overlaps the mouth.
//
// Coords are world-space — call it inside the same camera-translated frame the
// ship draws in. `screenW/H` bound the "keep everything" outer rect (generous
// padding covers shake); `open` mirrors renderWormholes so the iris the crop
// uses matches the one on screen exactly.
export const clipBehindPortalFarLip = (
  ctx: CanvasRenderingContext2D, wh: Wormhole, screenW: number, screenH: number,
): void => {
  const elapsed = wh.maxLife - wh.life;
  const open = mouthOpen(elapsed, wh.life);
  if (open < 0.02) return;
  const inner = wh.radius * INNER_FRAC * open;
  const ry = inner * TILT;
  // Outer rect spans well past the viewport in every direction (the frame is
  // camera-translated, so 0,0 isn't the screen origin) — it's the "show this".
  const pad = Math.max(screenW, screenH);
  ctx.beginPath();
  ctx.rect(wh.x - screenW - pad, wh.y - screenH - pad, (screenW + pad) * 2, (screenH + pad) * 2);
  // Far-half of the iris as its own closed sub-path: the upper semicircle of the
  // tilted ellipse (canvas −y is up-screen, so π→2π sweeps the top edge), closed
  // along its diameter. moveTo starts it fresh so no stray chord links it to the
  // rect. evenodd punches this hole out of the rect → everything but the far lip
  // survives.
  ctx.moveTo(wh.x - inner, wh.y);
  ctx.ellipse(wh.x, wh.y, inner, ry, 0, Math.PI, TAU);
  ctx.closePath();
  ctx.clip("evenodd");
};

// Mouth-open factor 0→1→0. Opens over the first OPEN seconds, collapses over
// the final CLOSE seconds of remaining life, holds at 1 between — expressed
// off both ends of the lifetime so a portal whose life is cut short (skip
// portals collapse early at wave end) still irises shut instead of popping.
const mouthOpen = (elapsed: number, life: number): number => {
  let open = 1;
  if (elapsed < OPEN) {
    const p = elapsed / OPEN; // ease-out so it snaps wide then settles
    open = 1 - (1 - p) * (1 - p);
  }
  if (life < CLOSE) {
    const p = 1 - life / CLOSE; // ease-in collapse to a slit
    open = Math.min(open, 1 - p * p);
  }
  return open;
};

// A cheap deterministic value-noise: a sum of a few sines the caller can sample
// smoothly by angle so an outline wobbles organically instead of running a clean
// curve. `phase` decorrelates portals; `t` drifts it so the wobble crawls and
// writhes over time rather than sitting still.
const wobble = (a: number, phase: number, t: number): number =>
  Math.sin(a * 3 + phase + t) * 0.55
  + Math.sin(a * 5 - phase * 1.7 - t * 0.8) * 0.3
  + Math.sin(a * 8 + phase * 0.5 + t * 1.6) * 0.15;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
};

// How much of the twist/spin a point at lens radius u feels: full at the ring,
// gone at DEFLECT_END.
const swirlWeight = (u: number): number => {
  const k = Math.max(0, Math.min(1, (DEFLECT_END - u) / (DEFLECT_END - RING)));
  return k * k;
};

// ── Lens map ──────────────────────────────────────────────────────────────────
// A point-mass lens bends a ray at image radius u by RING²/u, so a source at
// radius s appears at the (outer) image radius u where s = u − RING²/u — pushed
// outward, and stretched along the ring by u/s. The bending is tapered to zero
// by DEFLECT_END so the lens has an edge instead of tugging on the whole field.
const deflection = (u: number): number =>
  ((RING * RING) / u) * (1 - smoothstep(0.8, DEFLECT_END, u));

// Forward lookup: source radius → outer-image radius (fwdU) and the radial
// magnification there (fwdMr, <1 — images are squeezed toward the ring). Built
// once by tabulating the inverse relation, which is monotonic, and reading it
// back at even source-radius steps.
const LUT_N = 512;
const fwdU = new Float32Array(LUT_N + 1);
const fwdMr = new Float32Array(LUT_N + 1);
{
  const STEPS = 4096;
  // Bracket [lo, hi] of tabulated (image radius, source radius) pairs; the
  // source radius climbs monotonically with the image radius, so the bracket
  // only ever walks outward.
  let j = 0;
  let loU = RING;
  let loS = 0;
  let hiU = RING;
  let hiS = 0;
  for (let i = 0; i <= LUT_N; i++) {
    const s = (i / LUT_N) * COVER;
    while (hiS < s && j < STEPS) {
      j++;
      loU = hiU;
      loS = hiS;
      hiU = RING + (j / STEPS) * (COVER - RING);
      hiS = hiU - deflection(hiU);
    }
    const span = hiS - loS;
    const k = span > 1e-9 ? (s - loS) / span : 0;
    fwdU[i] = loU + (hiU - loU) * k;
    fwdMr[i] = span > 1e-9 ? Math.min(1, (hiU - loU) / span) : 1;
  }
}

const lensImage = (s: number): { u: number; mr: number } => {
  const f = Math.min(LUT_N, (s / COVER) * LUT_N);
  const i = Math.floor(f);
  const k = f - i;
  const i2 = Math.min(LUT_N, i + 1);
  return { u: fwdU[i] + (fwdU[i2] - fwdU[i]) * k, mr: fwdMr[i] + (fwdMr[i2] - fwdMr[i]) * k };
};

// ── Cached lens body ──────────────────────────────────────────────────────────
// The dark disc the arcs are drawn over: the shadow, a whisper of oxblood just
// past the horizon, a faint cool pile-up glow under the ring, then the opaque
// backdrop colour out to COVER where it feathers back into the live field. One
// radial gradient in the circular frame, baked once at a fixed resolution and
// scaled to any portal (never upscaled past its bake).
const BODY_SPRITE_PX = 512;
let bodySprite: HTMLCanvasElement | null = null;
const getBodySprite = (): HTMLCanvasElement => {
  if (bodySprite) return bodySprite;
  const c = document.createElement("canvas");
  c.width = BODY_SPRITE_PX;
  c.height = BODY_SPRITE_PX;
  const g = c.getContext("2d")!;
  const half = BODY_SPRITE_PX / 2;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  const at = (u: number) => u / COVER;
  grad.addColorStop(0, "rgba(0, 0, 3, 1)");
  grad.addColorStop(at(SHADOW - 0.025), "rgba(0, 0, 3, 1)");
  grad.addColorStop(at(SHADOW + 0.025), "rgba(16, 4, 12, 1)");
  grad.addColorStop(at(RING + 0.1), "rgba(15, 13, 30, 1)");
  grad.addColorStop(at(0.95), "rgba(5, 3, 12, 1)");
  grad.addColorStop(at(1.12), "rgba(2, 3, 10, 1)");
  grad.addColorStop(1, "rgba(2, 3, 10, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, BODY_SPRITE_PX, BODY_SPRITE_PX);
  bodySprite = c;
  return c;
};

// ── Lensed stars ──────────────────────────────────────────────────────────────
// What the lens needs from the world: the starfield and the same scroll +
// clock it was painted with this frame, so the stars it bends are the ones on
// screen. Null (no field, e.g. a preview page) just leaves the lens starless.
export type LensBackdrop = {
  starfield: Starfield;
  timeMs: number;
  scrollX: number;
  scrollY: number;
};

// Dust arcs are batched into a few strokes by brightness (one path each) so a
// hundred pin-pricks under a big mouth cost three draw calls. Each entry is
// one three-point polyline; the buffers are reused across frames.
const DUST_BUCKETS = 3;
const DUST_ALPHA = [0.16, 0.3, 0.46];
const dustSegs: number[][] = Array.from({ length: DUST_BUCKETS }, () => []);

// Streak length exaggeration: a real point source only stretches by its
// magnification, which at pin-prick size is invisible — so arcs grow with it
// but from a visible floor, capped so they never wrap far around the ring.
// Pin-pricks stretch harder than the bright twinklers, whose halos would
// otherwise smear into bands.
const DUST_STREAK_GAIN = 4;
const STAR_STREAK_GAIN = 2.5;
const MAX_MAG = 8;

// A streak's k-th sample (k in −1…1) along its spiral: the downstream end
// (k = +1, along the flow) sits closer to the throat by the pitch.
const streakPoint = (
  r: number, th: number, halfLen: number, pitch: number, dir: number, k: number,
): { x: number; y: number } => {
  const rk = r - k * halfLen * Math.sin(pitch);
  const ak = th + (dir * k * halfLen * Math.cos(pitch)) / r;
  return { x: Math.cos(ak) * rk, y: Math.sin(ak) * rk * TILT };
};

const addDustArc = (
  alpha: number, u: number, th: number, halfLen: number, L: number, pitch: number, dir: number,
): void => {
  const b = alpha < 0.23 ? 0 : alpha < 0.38 ? 1 : 2;
  const seg = dustSegs[b];
  const r = u * L;
  const a = streakPoint(r, th, halfLen, pitch, dir, -1);
  const m = streakPoint(r, th, halfLen, pitch, dir, 0);
  const z = streakPoint(r, th, halfLen, pitch, dir, 1);
  seg.push(a.x, a.y, m.x, m.y, z.x, z.y);
};

// Stroke one lensed twinkler: a polyline arc at radius u, plus the wider soft
// halo the bigger ones carry in the field.
const strokeStarArc = (
  ctx: CanvasRenderingContext2D,
  u: number, th: number, halfLen: number, L: number, pitch: number, dir: number,
  width: number, hue: number, alpha: number, halo: boolean,
): void => {
  const r = u * L;
  const N = halfLen > 6 ? 5 : 3;
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const p = streakPoint(r, th, halfLen, pitch, dir, (i / (N - 1)) * 2 - 1);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  if (halo) {
    ctx.lineWidth = width * 3;
    ctx.strokeStyle = `hsla(${hue}, 80%, 85%, ${alpha * 0.4})`;
    ctx.stroke();
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = `hsla(${hue}, 80%, 85%, ${alpha})`;
  ctx.stroke();
};

// Bend every star under the mouth into its lensed arc(s) and paint them. `L`
// is the live iris long axis, (cx, cy) the portal's screen position, `spin`
// the ring's current wheel angle. Each source star gets its outer image on or
// beyond the ring, and — when it isn't swallowed by the shadow — a fainter
// mirrored inner image between the ring and the horizon, the way a real lens
// doubles what sits close behind it.
const renderLensedStars = (
  ctx: CanvasRenderingContext2D, backdrop: LensBackdrop,
  cx: number, cy: number, L: number, spin: number, dir: number,
): void => {
  for (const seg of dustSegs) seg.length = 0;
  ctx.lineCap = "round";
  const reach = COVER * L;
  // Bigger mouths get proportionally longer streaks so the swirl reads at any size.
  const sizeScale = Math.sqrt(L / 60);
  backdrop.starfield.forEachStarNear(
    backdrop.timeMs, backdrop.scrollX, backdrop.scrollY, cx, cy, reach, reach * TILT,
    (x, y, size, hue, alpha, halo) => {
      const X = (x - cx) / L;
      const Y = (y - cy) / (L * TILT);
      const s = Math.hypot(X, Y);
      if (s >= COVER) return;
      const thS = Math.atan2(Y, X);
      const { u, mr } = lensImage(s);
      const mt = Math.min(MAX_MAG, s > 1e-4 ? u / s : MAX_MAG);
      const sw = swirlWeight(u);
      const thD = thS + dir * sw * (TWIST + spin);
      const pitch = PITCH * sw;
      const bright = halo || size > 0.75;
      const gain = (bright ? STAR_STREAK_GAIN : DUST_STREAK_GAIN) * sizeScale;
      const halfLen = Math.min(0.45 * u * L, sizeScale + size * mt * gain);
      if (bright) {
        const width = Math.max(0.6, size * 1.5 * (0.6 + 0.4 * mr));
        strokeStarArc(ctx, u, thD, halfLen, L, pitch, dir, width, hue, alpha, halo);
      } else {
        addDustArc(alpha, u, thD, halfLen, L, pitch, dir);
      }
      // Inner image: mirrored through the centre, squeezed toward the shadow.
      const uIn = (RING * RING) / u;
      if (uIn > SHADOW + 0.02 && s > 1e-4) {
        const mtIn = Math.min(MAX_MAG, uIn / s);
        const swIn = swirlWeight(uIn);
        const thIn = thS + Math.PI + dir * swIn * (TWIST + spin);
        const halfIn = Math.min(0.3 * uIn * L, sizeScale * 0.7 + size * mtIn * gain * 0.7);
        addDustArc(alpha * 0.55, uIn, thIn, halfIn, L, PITCH * swIn, dir);
      }
    },
  );
  ctx.lineWidth = 0.9;
  for (let b = 0; b < DUST_BUCKETS; b++) {
    const seg = dustSegs[b];
    if (seg.length === 0) continue;
    ctx.strokeStyle = `hsla(220, 70%, 88%, ${DUST_ALPHA[b]})`;
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 6) {
      ctx.moveTo(seg[i], seg[i + 1]);
      ctx.lineTo(seg[i + 2], seg[i + 3]);
      ctx.lineTo(seg[i + 4], seg[i + 5]);
    }
    ctx.stroke();
  }
};

// ── Red energy ────────────────────────────────────────────────────────────────
// Wisps: long filaments of energy that peel off the horizon and spiral outward
// with the flow, tapering from a fine thread at the root to nothing at the tip,
// their light falling off with distance so each one dissolves into the dark
// rather than ending. Drawn as filled ribbons in the squashed frame.
const WISP_COUNT = 8;
const WISP_SAMPLES = 14;
const wispX = new Float32Array(WISP_SAMPLES + 1);
const wispY = new Float32Array(WISP_SAMPLES + 1);

const fillRibbon = (
  ctx: CanvasRenderingContext2D, rootHalfWidth: number,
): void => {
  ctx.beginPath();
  // Left edge root→tip, then right edge tip→root, offsetting each spine sample
  // along its normal by a width that thins toward the tip.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k <= WISP_SAMPLES; k++) {
      const i = pass === 0 ? k : WISP_SAMPLES - k;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(WISP_SAMPLES, i + 1);
      const tx = wispX[i1] - wispX[i0];
      const ty = wispY[i1] - wispY[i0];
      const len = Math.hypot(tx, ty) || 1;
      const s = i / WISP_SAMPLES;
      const hw = (rootHalfWidth * Math.pow(1 - s, 2) + 0.05) * (pass === 0 ? 1 : -1);
      const px = wispX[i] - (ty / len) * hw;
      const py = wispY[i] + (tx / len) * hw;
      if (pass === 0 && k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fill();
};

const renderWisps = (
  ctx: CanvasRenderingContext2D,
  L: number, hue: number, open: number, t: number, dir: number, phase: number,
): void => {
  // Light falls off with distance from the horizon — shared by every wisp so
  // the whole nest fades out at the same radius.
  const glow = ctx.createRadialGradient(0, 0, SHADOW * L, 0, 0, 1.9 * L);
  glow.addColorStop(0, `hsla(${hue}, 100%, 62%, 0.34)`);
  glow.addColorStop(0.3, `hsla(${hue}, 100%, 56%, 0.13)`);
  glow.addColorStop(1, `hsla(${hue - 10}, 100%, 45%, 0)`);
  ctx.fillStyle = glow;
  const rootWidth = 0.65 * Math.sqrt(L / 60);
  for (let i = 0; i < WISP_COUNT; i++) {
    // Root angle drifts with the flow; reach and curl breathe per wisp so the
    // nest never reads as a fixed rosette.
    const a0 = phase * 1.3 + i * (TAU / WISP_COUNT) + dir * t * 0.25 + 0.3 * Math.sin(t * 0.7 + i * 1.9);
    const reach = 1.05 + 0.75 * (0.5 + 0.5 * Math.sin(t * 0.9 + i * 1.7));
    const curl = 2.0 + 0.5 * Math.sin(t * 0.5 + i * 2.3);
    for (let k = 0; k <= WISP_SAMPLES; k++) {
      const s = k / WISP_SAMPLES;
      const u = SHADOW + 0.04 + (reach - SHADOW - 0.04) * s;
      const th = a0 + dir * curl * Math.pow(s, 1.3) + wobble(s * 5, phase + i, t * 1.5) * 0.18 * s;
      wispX[k] = Math.cos(th) * u * L;
      wispY[k] = Math.sin(th) * u * L;
    }
    const flicker = 0.75 + 0.25 * Math.sin(t * 3 + i * 2.4);
    ctx.globalAlpha = open * flicker * 0.12;
    fillRibbon(ctx, rootWidth * 4); // soft bloom under the thread
    ctx.globalAlpha = open * flicker * 0.85;
    fillRibbon(ctx, rootWidth);
  }
  ctx.globalAlpha = 1;
};

// Horizon glow on the shadow's edge (brighter on the near, lower lip) and a few
// hot filaments wheeling around the ring with the flow.
const renderHorizon = (
  ctx: CanvasRenderingContext2D,
  L: number, membraneHue: number, throatHue: number,
  open: number, t: number, dir: number, phase: number, shimmer: number,
): void => {
  const r = SHADOW * L;
  const lip = ctx.createLinearGradient(0, -r, 0, r);
  lip.addColorStop(0, `hsla(${throatHue}, 95%, 45%, ${0.12 * open * shimmer})`);
  lip.addColorStop(1, `hsla(${membraneHue}, 100%, 62%, ${0.34 * open * shimmer})`);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.lineWidth = 5;
  ctx.strokeStyle = `hsla(${throatHue}, 90%, 40%, ${0.09 * open * shimmer})`;
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = lip;
  ctx.stroke();

  for (let i = 0; i < 3; i++) {
    const fr = (RING + 0.03 + 0.05 * i) * L;
    const start = phase + i * 2.1 + dir * t * (0.9 + 0.25 * i);
    const span = 0.8 + 0.3 * Math.sin(t * 1.3 + i);
    ctx.beginPath();
    ctx.arc(0, 0, fr, start, start + dir * span, dir < 0);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = `hsla(${membraneHue}, 100%, 55%, ${0.05 * open})`;
    ctx.stroke();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `hsla(${membraneHue + 6}, 100%, 66%, ${0.16 * open * shimmer})`;
    ctx.stroke();
  }
};

export const renderWormholes = (
  ctx: CanvasRenderingContext2D, list: Wormhole[], tSec: number,
  backdrop: LensBackdrop | null = null,
): void => {
  if (list.length === 0) return;
  // World → screen for this paint (the scroll camera paints the world layer at
  // wrap offsets; each copy has its own translate): the lens has to ask the
  // starfield about the stars at its SCREEN position, in CSS px.
  const m = ctx.getTransform();
  const offX = m.e / m.a;
  const offY = m.f / m.d;
  ctx.save();
  ctx.lineJoin = "round";
  for (const wh of list) {
    const elapsed = wh.maxLife - wh.life;
    const open = mouthOpen(elapsed, wh.life);
    if (open < 0.02) continue;
    const L = wh.radius * open;
    const cx = wh.x + offX;
    const cy = wh.y + offY;
    // Cull the wrap copies that land entirely off-screen — the lens is the
    // costliest thing in the layer to paint for nothing.
    if (backdrop) {
      const reach = COVER * L;
      const { w, h } = backdrop.starfield;
      if (cx + reach < 0 || cx - reach > w || cy + reach * TILT < 0 || cy - reach * TILT > h) continue;
    }
    const membraneHue = MEMBRANE_HUE + wh.hueShift;
    const throatHue = THROAT_HUE + wh.hueShift;
    // Per-portal flow direction and phase, a slow wheel for the swirl, and a
    // faint crackle on the red.
    const dir = wh.seed > Math.PI ? 1 : -1;
    const phase = wh.angle * 1.7 + wh.seed;
    const spin = tSec * SPIN + wh.seed;
    const shimmer = 0.85 + 0.15 * Math.sin(tSec * 16 + wh.seed);

    ctx.save();
    ctx.translate(wh.x, wh.y);
    // No frame rotation: the tilt is screen-fixed so the hole reads identically
    // regardless of the direction the departing body came from.

    // 1) Lens body (source-over): the cached dark disc — shadow, ring glow,
    //    and the opaque cover that hides the undistorted stars, feathering
    //    back into the live field at its edge.
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.scale(1, TILT);
    const R = COVER * L;
    ctx.drawImage(getBodySprite(), -R, -R, R * 2, R * 2);
    ctx.restore();

    // Everything below is additive light over the dark disc.
    ctx.globalCompositeOperation = "lighter";

    // 2) The stars behind the mouth, bent into arcs — the portal's substance.
    if (backdrop) renderLensedStars(ctx, backdrop, cx, cy, L, spin, dir);

    // 3) Red energy, faint: horizon glow + ring filaments, then the wisps
    //    peeling off into space. Drawn in the squashed frame so every circle
    //    hugs the tilted mouth.
    ctx.save();
    ctx.scale(1, TILT);
    ctx.lineCap = "round";
    renderHorizon(ctx, L, membraneHue, throatHue, open, tSec, dir, phase, shimmer);
    renderWisps(ctx, L, membraneHue, open, tSec, dir, phase);
    ctx.restore();

    ctx.restore();
  }
  ctx.restore();
};

// How long a body takes to fall all the way through the mouth (warpT 0→1). It
// must finish comfortably BEFORE the mouth starts collapsing (OPEN + HOLD) so
// the body is gone while the throat is still wide — the 0.8 leaves headroom for
// the body to vanish a few frames early even at a low frame rate, rather than
// winking out against an already-shrinking iris.
export const WARP_OUT_DURATION = OPEN + HOLD * 0.8;
