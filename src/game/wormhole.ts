import type { Vec } from "../vec";
import type { Starfield } from "../Starfield";
// Seeds only — cosmetic stream so the portal's sky offset/flow never perturbs
// the gameplay RNG draw count and desyncs replays.
import { cosmeticRng as rng } from "./rng";

// A departure portal: aliens that fly past the far edge leave THROUGH this
// instead of popping off, and a kill tears a longer-lived skip portal the ship
// can dive into. Distinct from the canister upgrade's flat radial-streak vortex
// (Canister.renderWarp) — that one is a head-on swirl of spokes collapsing to a
// point.
//
// Aesthetic: a traversable wormhole drawn the way the physics says it looks — a
// hole in 3-space is a SPHERE, so from any direction the mouth is a perfect
// circle. Through it you see another sky: a whole distant universe squeezed
// into the ball, nearly undistorted at the centre and wound ever tighter toward
// the limb, where the far sky piles up into a thin bright rim. Around the ball
// our own starfield is gravitationally lensed: stars behind the mouth are
// pushed outward into arcs that crowd onto an Einstein ring, each paired with a
// faint mirrored inner image between the ring and the limb. The lens itself is
// still — images only slide as their stars drift by under parallax — and there
// are no painted
// wisps or flames — every bit of light is lensed starlight from one side or the
// other.
//
// How the lensing is drawn (and why it isn't a baked pixel warp of the
// screen): the camera scrolls the star layers under their own parallax, so a
// snapshot of the pixels behind the mouth freezes the moment it's taken while
// the real stars keep streaming past. So the local lensing is applied per STAR:
// the starfield yields the handful of stars under the mouth each frame and each
// becomes a short lensed arc, batched by brightness. The far sky inside the
// ball is a prebaked tileable texture read through a cached fish-eye lookup
// table, panned by where the mouth sits on screen so the view through it shifts
// with parallax as it scrolls past. A body falling in (the ship) is drawn
// offscreen and pushed through the same lens map per pixel — see
// renderThroughPortal.
//
// The effect is purely cosmetic and self-contained (same lifecycle shape as
// DriftBurst): spawn → update(dt) prunes by life → render() draws. The body's
// suck-in lives on the entity itself in its warp-out phase; the wormhole only
// owns the portal so the two can be sequenced (open → swallow → collapse) and
// the body always draws in front of the mouth.

const TAU = Math.PI * 2;

// Lifecycle (seconds): the mouth opens, holds while the body is swallowed,
// then collapses. WARP_OUT_DURATION on the entity is tuned to land mid-hold.
const OPEN = 0.34;
const HOLD = 0.42;
const CLOSE = 0.4;
export const WORMHOLE_LIFE = OPEN + HOLD + CLOSE;

// Lens scale (px) of a portal torn by a body of this radius — the unit every
// radius below is measured in. The floor keeps a tiny body from punching an
// invisibly small hole.
export const portalLongAxis = (bodyRadius: number): number => Math.max(40, bodyRadius * 2.0);

// The mouth is a sphere, so the throat a body falls toward is its centre.
export const warpAnchorOffset = (
  _bodyRadius: number, _heading: number,
): { dx: number; dy: number } => ({ dx: 0, dy: 0 });

// ── Lens geometry, in units of the portal's lens scale (u = r / L) ──────────
// SPHERE: the mouth itself — the ball showing the far sky. RING: the Einstein
// radius, where lensed local starlight piles up; every source star's main
// image lands at or outside it. DEFLECT_END: where the bending has faded to
// nothing. COVER: how far the dark lens body reaches before feathering back
// into the untouched field (a touch past the bending so the last, barely
// displaced images sit on their own hidden originals rather than beside them).
const SPHERE = 0.5;
const RING = 0.62;
const DEFLECT_END = 1.25;
const COVER = 1.4;

export type Wormhole = {
  x: number;
  y: number;
  // Lens scale (px) at full open — scaled from the body's radius so a big
  // alien tears a bigger hole than a comet.
  radius: number;
  // Per-portal phase, seeded from the heading so replays stay deterministic.
  angle: number;
  hueShift: number; // per-portal jitter — picks which patch of far sky shows
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
// not during the opening and not once the collapse has begun.
export const wormholeEnterable = (wh: Wormhole): boolean =>
  wh.maxLife - wh.life >= OPEN && wh.life > CLOSE;

// Absolute position of the portal's throat — the point a diving body eases
// toward (mirrors warpAnchorOffset for a live portal): the sphere's centre.
export const throatPointOf = (wh: Wormhole): { x: number; y: number } => ({ x: wh.x, y: wh.y });

// Mouth-open factor 0→1→0. Opens over the first OPEN seconds, collapses over
// the final CLOSE seconds of remaining life, holds at 1 between — expressed
// off both ends of the lifetime so a portal whose life is cut short (skip
// portals collapse early at wave end) still shrinks shut instead of popping.
const mouthOpen = (elapsed: number, life: number): number => {
  let open = 1;
  if (elapsed < OPEN) {
    const p = elapsed / OPEN; // ease-out so it snaps wide then settles
    open = 1 - (1 - p) * (1 - p);
  }
  if (life < CLOSE) {
    const p = 1 - life / CLOSE; // ease-in collapse to a point
    open = Math.min(open, 1 - p * p);
  }
  return open;
};

const smoothstep = (e0: number, e1: number, x: number): number => {
  const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
};

// ── Lens map ──────────────────────────────────────────────────────────────────
// A point-mass lens bends a ray at image radius u by RING²/u, so a source at
// radius s appears at the (outer) image radius u where s = u − RING²/u — pushed
// outward, and stretched along the ring by u/s. The bending is tapered to zero
// by DEFLECT_END so the lens has an edge instead of tugging on the whole field.
// A negative s is the inner image: a source on the far side of the centre.
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

// Deterministic 0…1 hash so every bake is identical run to run.
const hash = (n: number): number => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// ── Cached lens body ──────────────────────────────────────────────────────────
// The dark disc the lensed field is drawn over: it hides the undistorted stars
// behind the mouth (their lensed images replace them) and feathers back into
// the live field at COVER. Plain backdrop black — the lens bends light, it
// doesn't tint it. One bake, scaled to any portal.
const BODY_SPRITE_PX = 256;
let bodySprite: HTMLCanvasElement | null = null;
const getBodySprite = (): HTMLCanvasElement => {
  if (bodySprite) return bodySprite;
  const c = document.createElement("canvas");
  c.width = BODY_SPRITE_PX;
  c.height = BODY_SPRITE_PX;
  const g = c.getContext("2d")!;
  const half = BODY_SPRITE_PX / 2;
  const at = (u: number) => u / COVER;
  const grad = g.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, "rgba(2, 3, 10, 1)");
  grad.addColorStop(at(0.95), "rgba(2, 3, 10, 1)");
  grad.addColorStop(at(1.2), "rgba(2, 3, 10, 0.55)");
  grad.addColorStop(1, "rgba(2, 3, 10, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, BODY_SPRITE_PX, BODY_SPRITE_PX);
  bodySprite = c;
  return c;
};

// ── The far sky ───────────────────────────────────────────────────────────────
// What lies on the other side: a tileable patch of a different universe — a
// warm galactic band with dark dust lanes and red emission knots across a
// dense field of stars of every temperature. Baked once into a pixel buffer
// the sphere samples directly.
const SKY_PX = 512; // power of two: samples wrap with a bitmask
const SKY_MASK = SKY_PX - 1;
let skyPixels: Uint8ClampedArray | null = null;

const bakeFarSky = (): Uint8ClampedArray => {
  const c = document.createElement("canvas");
  c.width = SKY_PX;
  c.height = SKY_PX;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "rgb(3, 2, 6)";
  g.fillRect(0, 0, SKY_PX, SKY_PX);
  // Every element is stamped at the eight wrap neighbours too, so the patch
  // tiles seamlessly however the sphere pans across it.
  const tiled = (x: number, y: number, r: number, paint: (x: number, y: number) => void) => {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const px = x + ox * SKY_PX;
        const py = y + oy * SKY_PX;
        if (px + r < 0 || px - r > SKY_PX || py + r < 0 || py - r > SKY_PX) continue;
        paint(px, py);
      }
    }
  };
  const blob = (x: number, y: number, r: number, color: string, op: GlobalCompositeOperation) => {
    tiled(x, y, r, (px, py) => {
      const grad = g.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      g.globalCompositeOperation = op;
      g.fillStyle = grad;
      g.beginPath();
      g.arc(px, py, r, 0, TAU);
      g.fill();
    });
  };
  // The galactic band runs diagonally (a 1:1 slope tiles cleanly): a diffuse
  // glow, a brighter clumped core of old yellow-white starlight along its
  // spine, dust lanes eating dark channels into it, and red emission knots
  // and blue young-star clouds strung along its edges.
  const band = (t: number, off: number) => ({ x: t * SKY_PX + off, y: t * SKY_PX - off });
  for (let i = 0; i < 120; i++) {
    const p = band(i / 120, (hash(i + 1) - 0.5) * 60);
    blob(p.x, p.y, 40 + 40 * hash(i + 2), `rgba(120, 105, 120, ${0.035 + 0.03 * hash(i + 3)})`, "lighter");
  }
  for (let i = 0; i < 220; i++) {
    const p = band(hash(i + 10), (hash(i + 11) - 0.5) * 34 * hash(i + 14));
    blob(p.x, p.y, 6 + 16 * hash(i + 12), `rgba(255, 230, 200, ${0.05 + 0.09 * hash(i + 13)})`, "lighter");
  }
  for (let i = 0; i < 110; i++) {
    const p = band(hash(i + 20), (hash(i + 21) - 0.5) * 30);
    blob(p.x, p.y, 4 + 12 * hash(i + 22), `rgba(4, 2, 6, ${0.5 + 0.4 * hash(i + 23)})`, "source-over");
  }
  for (let i = 0; i < 34; i++) {
    const side = hash(i + 30) < 0.5 ? -1 : 1;
    const p = band(hash(i + 31), side * (14 + 28 * hash(i + 32)));
    const red = hash(i + 37) < 0.6;
    const col = red ? "255, 70, 70" : "120, 160, 255";
    blob(p.x, p.y, 4 + 9 * hash(i + 33), `rgba(${col}, ${0.2 + 0.25 * hash(i + 34)})`, "lighter");
    blob(p.x, p.y, 1.5 + 2.5 * hash(i + 35), `rgba(${red ? "255, 170, 160" : "200, 220, 255"}, ${0.35 + 0.3 * hash(i + 36)})`, "lighter");
  }
  // Stars: dense, clustered toward the band, coloured by temperature. Each is
  // a 2×2 soft dot so the sphere's filtered reads never alias it away.
  g.globalCompositeOperation = "lighter";
  const temps = ["255, 190, 150", "255, 225, 200", "255, 245, 235", "210, 225, 255", "170, 195, 255"];
  for (let i = 0; i < 2200; i++) {
    let x = hash(i * 1.37 + 50) * SKY_PX;
    let y = hash(i * 1.37 + 51) * SKY_PX;
    if (hash(i + 52) < 0.5) {
      const p = band(hash(i + 53), (hash(i + 54) - 0.5) * (hash(i + 55) * 90));
      x = p.x;
      y = p.y;
    }
    const m = Math.pow(hash(i + 56), 5);
    const col = temps[Math.floor(hash(i + 57) * temps.length)];
    tiled(x, y, 3, (px, py) => {
      g.fillStyle = `rgba(${col}, ${0.12 + 0.6 * m})`;
      g.fillRect(px - 1, py - 1, 2, 2);
      g.fillStyle = `rgba(${col}, ${0.15 + 0.85 * m})`;
      g.fillRect(px - 0.5, py - 0.5, 1, 1);
    });
    if (m > 0.4) blob(x, y, 3 + 6 * m, `rgba(${col}, ${0.4 * m})`, "lighter");
  }
  return g.getImageData(0, 0, SKY_PX, SKY_PX).data;
};

// Fish-eye map for the ball at a given sprite resolution: for each pixel, the
// offset into the far sky it sees, plus a gain and coverage. Near the centre
// the view is close to straight through; toward the limb the deflection
// diverges so the whole far sky is wound into an ever-thinner rim, where the
// piled-up images brighten into a fine ring. Cached per size.
type SphereMap = {
  n: number;
  dx: Float32Array;
  dy: Float32Array;
  gain: Float32Array;
  cover: Float32Array;
  img: ImageData;
  canvas: HTMLCanvasElement;
};
const sphereMaps = new Map<number, SphereMap>();
const SKY_SCALE = 70; // far-sky px across the ball's radius at the centre

const getSphereMap = (n: number): SphereMap => {
  const hit = sphereMaps.get(n);
  if (hit) return hit;
  const dx = new Float32Array(n * n);
  const dy = new Float32Array(n * n);
  const gain = new Float32Array(n * n);
  const cover = new Float32Array(n * n);
  const half = n / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5 - half) / half;
      const y = (j + 0.5 - half) / half;
      const rho = Math.hypot(x, y);
      const k = j * n + i;
      cover[k] = Math.max(0, Math.min(1, (1 - rho) * half + 0.5));
      if (cover[k] <= 0) continue;
      // Antialiased edge pixels just past the limb read the rim, not black.
      const rr = Math.min(rho, 0.999);
      const R = (SKY_SCALE * rr) / Math.sqrt(1 - rr * rr * 0.995);
      const a = Math.atan2(y, x);
      dx[k] = Math.cos(a) * R;
      dy[k] = Math.sin(a) * R;
      const limb = smoothstep(0.86, 1, rr);
      gain[k] = 1 + 1.6 * limb * limb;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = n;
  canvas.height = n;
  const img = canvas.getContext("2d")!.createImageData(n, n);
  const map = { n, dx, dy, gain, cover, img, canvas };
  sphereMaps.set(n, map);
  return map;
};

// Paint the ball: read the far sky through the fish-eye map, panned by the
// mouth's screen position (parallax — the view through shifts as it scrolls).
const renderSphere = (
  ctx: CanvasRenderingContext2D, L: number, pxScale: number,
  panX: number, panY: number,
): void => {
  const sky = skyPixels ?? (skyPixels = bakeFarSky());
  const r = SPHERE * L;
  // Power-of-two map sizes, so an opening/closing mouth reuses a handful of
  // cached maps instead of building one per pixel of radius.
  const n = Math.min(256, Math.max(32, 2 ** Math.ceil(Math.log2(r * 2 * pxScale))));
  const map = getSphereMap(n);
  const out = map.img.data;
  const { dx, dy, gain, cover } = map;
  for (let k = 0; k < n * n; k++) {
    const c = cover[k];
    const o = k * 4;
    if (c <= 0) {
      out[o + 3] = 0;
      continue;
    }
    // Bilinear read, wrapping on the tile.
    const fx = dx[k] + panX;
    const fy = dy[k] + panY;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const r0 = (iy & SKY_MASK) * SKY_PX;
    const r1 = ((iy + 1) & SKY_MASK) * SKY_PX;
    const a = (r0 + (ix & SKY_MASK)) * 4;
    const b = (r0 + ((ix + 1) & SKY_MASK)) * 4;
    const cc = (r1 + (ix & SKY_MASK)) * 4;
    const d = (r1 + ((ix + 1) & SKY_MASK)) * 4;
    const gk = gain[k];
    for (let ch = 0; ch < 3; ch++) {
      const top = sky[a + ch] + (sky[b + ch] - sky[a + ch]) * tx;
      const bot = sky[cc + ch] + (sky[d + ch] - sky[cc + ch]) * tx;
      out[o + ch] = (top + (bot - top) * ty) * gk;
    }
    out[o + 3] = 255 * c;
  }
  map.canvas.getContext("2d")!.putImageData(map.img, 0, 0);
  ctx.drawImage(map.canvas, -r, -r, r * 2, r * 2);
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

// Streak length exaggeration: a real point source only stretches by its
// magnification, which at pin-prick size is invisible — so arcs grow with it
// but from a visible floor, capped so they never wrap far around the ring.
// Pin-pricks stretch harder than the bright twinklers, whose halos would
// otherwise smear into bands.
const DUST_STREAK_GAIN = 1.6;
const STAR_STREAK_GAIN = 1;
const MAX_MAG = 8;

// Pin-prick arcs are batched into one path per brightness bucket, split again
// by whether they sit inside the strong-lensing zone: only the brightest of
// those get the chromatic fringe (a shrunken blue and an enlarged red refill
// of the same path), since a lens splits colours where it bends light
// hardest and the fringe only shows on the bright arcs anyway.
const DUST_BUCKETS = 3;
const DUST_ALPHA = [0.2, 0.36, 0.55];
const CHROMA_U = 0.95; // arcs inside this radius get the fringe
const CHROMA = 0.014; // radial scale between the blue and red images
const dustPaths: Path2D[] = [];
const dustCounts = new Int32Array(DUST_BUCKETS * 2);

// A streak's k-th sample (k in −1…1) along its arc around the lens centre.
const streakPoint = (
  r: number, th: number, halfLen: number, k: number,
): { x: number; y: number } => {
  const ak = th + (k * halfLen) / r;
  return { x: Math.cos(ak) * r, y: Math.sin(ak) * r };
};

// Add a tapered, leaf-shaped streak through three points to a path: a kite
// bowed to either side of the spine, meeting in points at both ends so every
// arc fades out instead of stopping dead. Straight sides, not curves — at
// streak widths they look the same and fill several times cheaper.
const leaf = (
  p: Path2D, ax: number, ay: number, mx: number, my: number, zx: number, zy: number, halfW: number,
): void => {
  let nx = -(zy - ay);
  let ny = zx - ax;
  const len = Math.hypot(nx, ny) || 1;
  nx = (nx / len) * halfW;
  ny = (ny / len) * halfW;
  p.moveTo(ax, ay);
  p.lineTo(mx + nx, my + ny);
  p.lineTo(zx, zy);
  p.lineTo(mx - nx, my - ny);
  p.closePath();
};

const streakLeaf = (
  p: Path2D, u: number, th: number, halfLen: number, L: number, halfW: number,
): void => {
  const r = u * L;
  const a = streakPoint(r, th, halfLen, -1);
  const m = streakPoint(r, th, halfLen, 0);
  const z = streakPoint(r, th, halfLen, 1);
  leaf(p, a.x, a.y, m.x, m.y, z.x, z.y, halfW);
};

const bucketOf = (alpha: number): number => (alpha < 0.23 ? 0 : alpha < 0.38 ? 1 : 2);

const addDustArc = (
  alpha: number, u: number, th: number, halfLen: number, L: number,
): void => {
  const idx = (u < CHROMA_U ? 0 : DUST_BUCKETS) + bucketOf(alpha);
  streakLeaf(dustPaths[idx], u, th, halfLen, L, 0.7);
  dustCounts[idx]++;
};

// Refill a streak path as its blue image (a touch inside) and red image (a
// touch outside) — the prismatic fringe of light bent through the lens.
const fillChroma = (ctx: CanvasRenderingContext2D, p: Path2D, alpha: number): void => {
  ctx.save();
  ctx.scale(1 - CHROMA, 1 - CHROMA);
  ctx.fillStyle = `hsla(212, 95%, 68%, ${alpha * 0.4})`;
  ctx.fill(p);
  ctx.restore();
  ctx.save();
  ctx.scale(1 + CHROMA, 1 + CHROMA);
  ctx.fillStyle = `hsla(2, 95%, 62%, ${alpha * 0.4})`;
  ctx.fill(p);
  ctx.restore();
};

// Bright twinklers are batched the same way — two brightness buckets, each
// with a core path and a wider soft-halo path for the stars that carry a halo
// in the field — so a big mouth full of bright stars is a handful of fills
// rather than one per star. Their hue spread (all blue-white) isn't missed.
const STAR_BUCKETS = 2;
const STAR_ALPHA = [0.3, 0.46];
const starCore: Path2D[] = [];
const starHalo: Path2D[] = [];
const starCounts = new Int32Array(STAR_BUCKETS * 2); // [core…, halo…]

const addStarArc = (
  alpha: number, u: number, th: number, halfLen: number, L: number,
  halfW: number, halo: boolean,
): void => {
  const b = alpha < 0.33 ? 0 : 1;
  streakLeaf(starCore[b], u, th, halfLen, L, halfW);
  starCounts[b]++;
  if (halo) {
    streakLeaf(starHalo[b], u, th, halfLen, L, halfW * 3);
    starCounts[STAR_BUCKETS + b]++;
  }
};

// Bend every star under the mouth into its lensed arc(s) and paint them. `L`
// is the live lens scale, (cx, cy) the portal's screen position. The lens is
// static: an image only moves as its source star drifts by under parallax.
// Each source star gets its outer image on or
// beyond the ring, and — when it isn't swallowed by the shadow — a fainter
// mirrored inner image between the ring and the horizon, the way a real lens
// doubles what sits close behind it.
const renderLensedStars = (
  ctx: CanvasRenderingContext2D, backdrop: LensBackdrop,
  cx: number, cy: number, L: number,
): void => {
  for (let i = 0; i < DUST_BUCKETS * 2; i++) {
    dustPaths[i] = new Path2D();
    dustCounts[i] = 0;
  }
  for (let i = 0; i < STAR_BUCKETS; i++) {
    starCore[i] = new Path2D();
    starHalo[i] = new Path2D();
    starCounts[i] = 0;
    starCounts[STAR_BUCKETS + i] = 0;
  }
  const reach = COVER * L;
  // Bigger mouths get proportionally longer streaks so the arcs read at any size.
  const sizeScale = Math.sqrt(L / 60);
  backdrop.starfield.forEachStarNear(
    backdrop.timeMs, backdrop.scrollX, backdrop.scrollY, cx, cy, reach, reach,
    (x, y, size, _hue, alpha, halo) => {
      const X = (x - cx) / L;
      const Y = (y - cy) / L;
      const s = Math.hypot(X, Y);
      if (s >= COVER) return;
      const thS = Math.atan2(Y, X);
      const { u, mr } = lensImage(s);
      const mt = Math.min(MAX_MAG, s > 1e-4 ? u / s : MAX_MAG);
      const bright = halo || size > 1.0;
      const gain = (bright ? STAR_STREAK_GAIN : DUST_STREAK_GAIN) * sizeScale;
      const halfLen = Math.min(0.45 * u * L, sizeScale * (0.4 + size * (mt - 1) * gain));
      if (bright) {
        const halfW = Math.max(0.4, size * 0.8 * (0.6 + 0.4 * mr));
        addStarArc(alpha, u, thS, halfLen, L, halfW, halo);
      } else {
        addDustArc(alpha, u, thS, halfLen, L);
      }
      // Inner image: mirrored through the centre, squeezed toward the shadow.
      const uIn = (RING * RING) / u;
      if (uIn > SPHERE + 0.02 && s > 1e-4) {
        const mtIn = Math.min(MAX_MAG, uIn / s);
        const thIn = thS + Math.PI;
        const halfIn = Math.min(0.3 * uIn * L, sizeScale * (0.3 + size * mtIn * gain * 0.7));
        addDustArc(alpha * 0.55, uIn, thIn, halfIn, L);
      }
    },
  );
  for (let i = 0; i < DUST_BUCKETS * 2; i++) {
    if (dustCounts[i] === 0) continue;
    const alpha = DUST_ALPHA[i % DUST_BUCKETS];
    ctx.fillStyle = `hsla(220, 70%, 90%, ${alpha})`;
    ctx.fill(dustPaths[i]);
    if (i === DUST_BUCKETS - 1) fillChroma(ctx, dustPaths[i], alpha);
  }
  for (let b = 0; b < STAR_BUCKETS; b++) {
    if (starCounts[STAR_BUCKETS + b] > 0) {
      ctx.fillStyle = `hsla(215, 80%, 86%, ${STAR_ALPHA[b] * 0.35})`;
      ctx.fill(starHalo[b]);
    }
    if (starCounts[b] === 0) continue;
    ctx.fillStyle = `hsla(215, 80%, 92%, ${STAR_ALPHA[b]})`;
    ctx.fill(starCore[b]);
    fillChroma(ctx, starCore[b], STAR_ALPHA[b]);
  }
};

// ── Einstein ring ─────────────────────────────────────────────────────────────
// Lensed starlight from the whole field behind the mouth crowds onto the ring:
// a faint diffuse annulus of cool light, densest at the ring and thinning out,
// with a fine bright thread hugging the limb where the inner images pile up.
const renderRingGlow = (ctx: CanvasRenderingContext2D, L: number, open: number): void => {
  const at = (u: number) => u / DEFLECT_END;
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, DEFLECT_END * L);
  glow.addColorStop(at(SPHERE), "hsla(215, 60%, 85%, 0)");
  glow.addColorStop(at(SPHERE + 0.015), "hsla(210, 70%, 92%, 0.22)");
  glow.addColorStop(at(SPHERE + 0.05), "hsla(215, 60%, 80%, 0.05)");
  glow.addColorStop(at(RING - 0.02), "hsla(215, 60%, 82%, 0.11)");
  glow.addColorStop(at(RING + 0.04), "hsla(218, 60%, 78%, 0.07)");
  glow.addColorStop(at(0.95), "hsla(220, 60%, 70%, 0.015)");
  glow.addColorStop(1, "hsla(220, 60%, 70%, 0)");
  ctx.globalAlpha = open;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, DEFLECT_END * L, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
};


export const renderWormholes = (
  ctx: CanvasRenderingContext2D, list: Wormhole[],
  backdrop: LensBackdrop | null = null,
): void => {
  if (list.length === 0) return;
  // World → screen for this paint (the scroll camera paints the world layer at
  // wrap offsets; each copy has its own translate): the lens has to ask the
  // starfield about the stars at its SCREEN position, in CSS px.
  const m = ctx.getTransform();
  const offX = m.e / m.a;
  const offY = m.f / m.d;
  const pxScale = Math.abs(m.a);
  ctx.save();
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
      if (cx + reach < 0 || cx - reach > w || cy + reach < 0 || cy - reach > h) continue;
    }

    ctx.save();
    ctx.translate(wh.x, wh.y);

    // 1) Lens body: hides the undistorted stars behind the mouth.
    ctx.globalCompositeOperation = "source-over";
    const R = COVER * L;
    ctx.drawImage(getBodySprite(), -R, -R, R * 2, R * 2);

    // 2) The stars behind the mouth, bent into arcs, and the ring they crowd.
    ctx.globalCompositeOperation = "lighter";
    if (backdrop) renderLensedStars(ctx, backdrop, cx, cy, L);
    renderRingGlow(ctx, L, open);

    // 3) The ball itself: the far sky. Its pan follows the mouth's screen
    //    position so the view through it shifts with parallax.
    ctx.globalCompositeOperation = "source-over";
    const sw = backdrop ? backdrop.starfield.w : 0;
    const sh = backdrop ? backdrop.starfield.h : 0;
    // The pan rides the far galaxy's band (it runs along x = y in the sky
    // patch), so every portal looks out across it.
    const along = wh.seed * 80;
    const panX = along - (cx - sw / 2) * 0.12;
    const panY = along - (cy - sh / 2) * 0.12 + wh.hueShift * 1.5;
    renderSphere(ctx, L, pxScale, panX, panY);

    ctx.restore();
  }
  ctx.restore();
};

// ── Falling through ───────────────────────────────────────────────────────────
// Draw a body that is falling into (or climbing out of) a portal as seen
// THROUGH the portal's lens. `depth` 0→1 is how far the body has sunk behind
// the mouth: at 0 it's drawn as-is in front; as it deepens it is tidally
// stretched toward the throat, its image is bent by the same lens map the
// stars use (so it smears into an arc along the Einstein ring and throws a
// mirrored inner image), the ball occludes whatever of it lies behind the
// limb, its light splits chromatically and washes toward white, and it fades
// out as it
// passes through.
//
// The body is painted by `draw` into an offscreen buffer around the portal and
// warped per pixel — exact inverse lens mapping from each output pixel back to
// the buffer. Only the one diving body ever goes through here, for well under a
// second, so the per-pixel cost is affordable; the loop skips any output pixel
// whose source falls outside the body's painted bounds.
const MAX_WARP_PX = 400;
let warpSrc: HTMLCanvasElement | null = null;
let warpDst: HTMLCanvasElement | null = null;
let warpBloom: HTMLCanvasElement | null = null;
let warpPremul = new Float32Array(0);
let warpDefl = new Float32Array(0);
let warpInvR = new Float32Array(0);
let warpVis = new Float32Array(0);
const RADIAL_STEPS_PER_PX = 4;
// Depth at which the lens starts bending the falling body.
const LENS_ONSET = 0.08;
let warpOut: ImageData | null = null;

const scratch = (c: HTMLCanvasElement | null, d: number): HTMLCanvasElement => {
  const canvas = c ?? document.createElement("canvas");
  if (canvas.width !== d || canvas.height !== d) {
    canvas.width = d;
    canvas.height = d;
  }
  return canvas;
};

export const renderThroughPortal = (
  ctx: CanvasRenderingContext2D, wh: Wormhole, depth: number,
  body: { x: number; y: number; reach: number },
  portalDx: number, portalDy: number,
  draw: (g: CanvasRenderingContext2D) => void,
  maxPx = MAX_WARP_PX,
): void => {
  const open = mouthOpen(wh.maxLife - wh.life, wh.life);
  const L = wh.radius * open;
  // Portal centre in the body's frame (the caller resolves the toroidal wrap).
  const cx = body.x + portalDx;
  const cy = body.y + portalDy;
  // Before the lens takes hold (and for a mouth too small to matter) the body
  // only stretches — draw it straight, at full resolution.
  // Tidal stretch along the line to the throat, fading out for a body that
  // already sits on the throat (an alien warps out where its portal opens),
  // where the stretch has no direction.
  const dist = Math.hypot(portalDx, portalDy);
  const tidal = depth * depth * (L > 0 ? Math.min(1, dist / (0.3 * L)) : 0);
  const stretch = 1 + 2.2 * tidal;
  const squeeze = 1 / (1 + 0.8 * tidal);
  if (L < 4 || depth < LENS_ONSET) {
    const rc = 1 - 0.3 * depth;
    const st = stretch * rc;
    const sq = squeeze * rc;
    const radial = Math.atan2(cy - body.y, cx - body.x);
    ctx.save();
    ctx.translate(body.x, body.y);
    ctx.rotate(radial);
    ctx.scale(st, sq);
    ctx.rotate(-radial);
    ctx.translate(-body.x, -body.y);
    draw(ctx);
    ctx.restore();
    return;
  }
  const half = Math.ceil(Math.max(DEFLECT_END * L, dist + body.reach * stretch) + 2);
  // Skip the whole warp for a wrap copy that lands off-canvas — the scroll
  // camera can paint the entity layer up to four times a frame.
  const m = ctx.getTransform();
  const scx = m.a * cx + m.c * cy + m.e;
  const scy = m.b * cx + m.d * cy + m.f;
  const ext = half * Math.hypot(m.a, m.b);
  if (scx + ext < 0 || scy + ext < 0 || scx - ext > ctx.canvas.width || scy - ext > ctx.canvas.height) return;
  let S = Math.min(1, Math.abs(m.a) || 1);
  if (half * 2 * S > maxPx) S = maxPx / (half * 2);
  const D = Math.ceil(half * 2 * S);

  // 1) Paint the body into the buffer, tidally stretched along the line to the
  //    throat and shrinking as it recedes.
  warpSrc = scratch(warpSrc, D);
  const g = warpSrc.getContext("2d", { willReadFrequently: true })!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.clearRect(0, 0, D, D);
  g.setTransform(S, 0, 0, S, (half - cx) * S, (half - cy) * S);
  const radial = Math.atan2(cy - body.y, cx - body.x);
  const recede = 1 - 0.3 * depth;
  g.translate(body.x, body.y);
  g.rotate(radial);
  g.scale(stretch * recede, squeeze * recede);
  g.rotate(-radial);
  g.translate(-body.x, -body.y);
  draw(g);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const src = g.getImageData(0, 0, D, D).data;

  // Premultiply for clean bilinear filtering, and find the painted bounds.
  if (warpPremul.length < D * D * 4) warpPremul = new Float32Array(D * D * 4);
  const pm = warpPremul;
  let x0 = D;
  let y0 = D;
  let x1 = -1;
  let y1 = -1;
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < D; i++) {
      const o = (j * D + i) * 4;
      const a = src[o + 3];
      if (a === 0) {
        pm[o] = pm[o + 1] = pm[o + 2] = pm[o + 3] = 0;
        continue;
      }
      const k = a / 255;
      pm[o] = src[o] * k;
      pm[o + 1] = src[o + 1] * k;
      pm[o + 2] = src[o + 2] * k;
      pm[o + 3] = a;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
    }
  }
  if (x1 < 0) return;

  // Bilinear sample of one premultiplied channel (ch 0–3); 0 outside bounds.
  const sample = (fx: number, fy: number, ch: number): number => {
    if (fx < x0 - 1 || fx > x1 || fy < y0 - 1 || fy > y1) return 0;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const ix1 = Math.min(D - 1, ix + 1);
    const iy1 = Math.min(D - 1, iy + 1);
    const cx0 = Math.max(0, ix);
    const cy0 = Math.max(0, iy);
    const a = pm[(cy0 * D + cx0) * 4 + ch];
    const b = pm[(cy0 * D + ix1) * 4 + ch];
    const c = pm[(iy1 * D + cx0) * 4 + ch];
    const d = pm[(iy1 * D + ix1) * 4 + ch];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };

  // 2) Inverse lens map, output pixel → buffer. Everything that depends only
  //    on the radius (bend, occlusion by the ball) is
  //    tabulated once per frame along a fine radial grid.
  warpDst = scratch(warpDst, D);
  const dg = warpDst.getContext("2d")!;
  if (!warpOut || warpOut.width !== D) warpOut = dg.createImageData(D, D);
  const outImg = warpOut;
  const out = outImg.data;
  out.fill(0);
  const ca = 0.06 * depth; // chromatic split: red bends more than blue
  // The lens takes hold a beat after the tidal stretch, so the ship still
  // reads as itself for the first part of the fall.
  const lens = smoothstep(LENS_ONSET, 0.7, depth);
  const behind = smoothstep(0.15, 0.45, depth);
  const fade = 1 - smoothstep(0.85, 1, depth);
  // Light concentrated onto the ring washes toward white rather than keeping
  // the hull's hue (a literal redshift turns the teal hull a muddy green).
  const wash = 0.55 * lens;
  const limbPx = SPHERE * L;
  // Covers the buffer's corners: output pixels reach √2·(half + 0.5/S).
  const radialN = Math.ceil((half + 1 / S) * Math.SQRT2 * RADIAL_STEPS_PER_PX) + 2;
  if (warpDefl.length < radialN) {
    warpDefl = new Float32Array(radialN);
    warpInvR = new Float32Array(radialN);
    warpVis = new Float32Array(radialN);
  }
  for (let n = 0; n < radialN; n++) {
    const r = Math.max(1e-3, n / RADIAL_STEPS_PER_PX);
    const u = r / L;
    warpDefl[n] = lens * deflection(u) * L;
    warpInvR[n] = 1 / r;
    warpVis[n] = (1 - behind * Math.max(0, Math.min(1, (limbPx - r) * S + 0.5))) * fade;
  }
  const bx0 = x0 - 1;
  const by0 = y0 - 1;
  for (let j = 0; j < D; j++) {
    const y = (j + 0.5) / S - half;
    for (let i = 0; i < D; i++) {
      const x = (i + 0.5) / S - half;
      const r = Math.sqrt(x * x + y * y);
      const n = (r * RADIAL_STEPS_PER_PX) | 0;
      const vis = warpVis[n];
      if (vis <= 0) continue;
      // Unit direction back toward the source.
      const ux = x * warpInvR[n];
      const uy = y * warpInvR[n];
      const defl = warpDefl[n];
      const sG = r - defl;
      const gx = (ux * sG + half) * S - 0.5;
      const gy = (uy * sG + half) * S - 0.5;
      // Bounds test on the green image before any sampling — nearly every
      // output pixel maps somewhere the body never painted.
      if (gx < bx0 - 2 || gx > x1 + 2 || gy < by0 - 2 || gy > y1 + 2) continue;
      const a = sample(gx, gy, 3);
      if (a < 0.5) continue;
      const sR = r - defl * (1 + ca);
      const sB = r - defl * (1 - ca);
      const rr = sample((ux * sR + half) * S - 0.5, (uy * sR + half) * S - 0.5, 0);
      const gg = sample(gx, gy, 1);
      const bb = sample((ux * sB + half) * S - 0.5, (uy * sB + half) * S - 0.5, 2);
      const inv = 255 / a;
      const o = (j * D + i) * 4;
      const lum = (rr + gg + bb) * inv * 0.4;
      out[o] = rr * inv + (lum - rr * inv) * wash;
      out[o + 1] = gg * inv + (lum - gg * inv) * wash;
      out[o + 2] = bb * inv + (lum * 1.1 - bb * inv) * wash;
      out[o + 3] = a * vis;
    }
  }
  dg.putImageData(outImg, 0, 0);
  ctx.drawImage(warpDst, cx - half, cy - half, half * 2, half * 2);

  // 3) Polish: the smeared light blooms — a quarter-res copy stretched back up
  //    and added on top, a cheap blur that also hides the arcs' aliasing —
  //    and the Einstein ring flares in the ship's light as it crosses.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const bloom = 0.9 * lens * fade;
  if (bloom > 0.02) {
    const bd = Math.max(8, Math.ceil(D / 4));
    warpBloom = scratch(warpBloom, bd);
    const bg = warpBloom.getContext("2d")!;
    bg.clearRect(0, 0, bd, bd);
    bg.imageSmoothingQuality = "high";
    bg.drawImage(warpDst, 0, 0, bd, bd);
    ctx.globalAlpha = bloom;
    ctx.drawImage(warpBloom, cx - half, cy - half, half * 2, half * 2);
    ctx.globalAlpha = bloom * 0.6;
    const spread = half * 0.06;
    ctx.drawImage(warpBloom, cx - half - spread, cy - half - spread, (half + spread) * 2, (half + spread) * 2);
    ctx.globalAlpha = 1;
  }
  const flare = smoothstep(0.35, 0.7, depth) * (1 - smoothstep(0.8, 1, depth));
  if (flare > 0.01) {
    const rIn = SPHERE * L;
    const rOut = (RING + 0.1) * L;
    const at = (r: number) => (r - rIn) / (rOut - rIn);
    const ring = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut);
    ring.addColorStop(0, "hsla(190, 90%, 92%, 0)");
    ring.addColorStop(Math.min(at(rIn + 1.5), at(RING * L) - 0.01), `hsla(190, 90%, 94%, ${0.6 * flare})`);
    ring.addColorStop(at(RING * L), `hsla(195, 85%, 75%, ${0.1 * flare})`);
    ring.addColorStop(1, "hsla(200, 80%, 60%, 0)");
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};

// How long a body takes to fall all the way through the mouth (warpT 0→1). It
// must finish comfortably BEFORE the mouth starts collapsing (OPEN + HOLD) so
// the body is gone while the throat is still wide — the 0.8 leaves headroom for
// the body to vanish a few frames early even at a low frame rate, rather than
// winking out against an already-shrinking mouth.
export const WARP_OUT_DURATION = OPEN + HOLD * 0.8;

// Bake the far sky at module load, like the bassteroid halo outlines, so the
// first portal of a run doesn't stall a frame on the ~60ms bake.
if (typeof document !== "undefined") skyPixels = bakeFarSky();
