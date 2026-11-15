// Prebaked textures for the player laser. Every beam layer is one of these
// stretched along the beam with a single drawImage, so the cross-section gets a
// smooth Gaussian falloff (no stacked-stroke banding) and the far tip narrows
// and dissolves, at the cost of a blit per layer. Built lazily on first use.

type Rgb = readonly [number, number, number];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// The last TAIL_START of a beam sprite fades out while its profile pinches
// toward the axis, so the tip reads as a lance dissolving rather than a cut-off.
const TAIL_START = 0.72;
const tailOf = (u: number) => Math.max(0, (u - TAIL_START) / (1 - TAIL_START));
export const beamTaperAt = (u: number) => Math.pow(1 - tailOf(Math.min(1, u)), 1.3);

// Paints a w×h sprite from a per-pixel shader. u runs 0..1 along x; d is the
// unsigned distance from the horizontal centre line, 0..1 at the edge.
const bake = (w: number, h: number, shade: (u: number, d: number, x: number) => [Rgb, number]) => {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const half = h / 2;
  for (let y = 0; y < h; y++) {
    const d = Math.abs(y + 0.5 - half) / half;
    for (let x = 0; x < w; x++) {
      const [rgb, a] = shade((x + 0.5) / w, d, x);
      const i = (y * w + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = Math.max(0, Math.min(1, a)) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
};

// Soft saturated halo around the core: bright cyan at the axis falling through
// a deep blue skirt, i.e. the coloured light scattered off a white-hot beam.
const bakeGlow = (inner: Rgb, outer: Rgb) => bake(512, 64, (u, d) => {
  const tail = tailOf(u);
  const dd = d / (1 - 0.55 * tail);
  if (dd >= 1) return [outer, 0];
  const lead = Math.min(1, u / 0.012);
  const a = (0.7 * Math.exp(-((dd / 0.26) ** 2)) + 0.32 * Math.exp(-((dd / 0.6) ** 2))) * (1 - dd * dd);
  return [mix(inner, outer, Math.min(1, dd * 1.6)), a * Math.pow(1 - tail, 1.4) * lead];
});

// The coherent core: a flat white plateau with a steep cyan fringe, so the edge
// stays crisp even when stretched to a hairline.
const CORE_WHITE: Rgb = [255, 255, 255];
const CORE_FRINGE: Rgb = [150, 238, 255];
const CORE_EDGE: Rgb = [50, 180, 255];
const bakeCore = () => bake(512, 32, (u, d) => {
  const tail = tailOf(u);
  const dd = d / (1 - 0.8 * tail);
  if (dd >= 1) return [CORE_EDGE, 0];
  const lead = Math.min(1, u / 0.008);
  const a = dd < 0.32 ? 1 : Math.exp(-(((dd - 0.32) / 0.24) ** 2));
  const rgb = dd < 0.28 ? CORE_WHITE : dd < 0.6 ? mix(CORE_WHITE, CORE_FRINGE, (dd - 0.28) / 0.32) : mix(CORE_FRINGE, CORE_EDGE, (dd - 0.6) / 0.4);
  return [rgb, a * Math.pow(1 - tail, 1.1) * lead];
});

// Tileable scintillation strip: sparse bright dashes of varied length and
// strength, scrolled along the core so the beam glitters like coherent light.
const SHIMMER_W = 256;
const bakeShimmer = () => {
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const lum = new Float32Array(SHIMMER_W);
  for (let k = 0; k < 26; k++) {
    const start = Math.floor(rand() * SHIMMER_W);
    const len = 3 + Math.floor(rand() * 26);
    const peak = 0.35 + rand() * 0.65;
    for (let j = 0; j < len; j++) {
      const env = Math.sin((j / len) * Math.PI);
      const x = (start + j) % SHIMMER_W;
      lum[x] = Math.min(1, lum[x] + peak * env);
    }
  }
  const tint: Rgb = [215, 250, 255];
  return bake(SHIMMER_W, 16, (_u, d, x) => [tint, lum[x] * Math.exp(-((d / 0.42) ** 2))]);
};

// Anamorphic lens streak: a thin bright line that fades toward both ends. Laid
// across the emitter it sells an intensely bright point source.
const bakeFlare = () => bake(256, 16, (u, d) => {
  const along = Math.pow(1 - Math.abs(u * 2 - 1), 2.4);
  const a = along * Math.exp(-((d / 0.32) ** 2));
  return [mix(CORE_WHITE, [120, 220, 255], Math.abs(u * 2 - 1)), a];
});

let glow: HTMLCanvasElement | null = null;
let superGlow: HTMLCanvasElement | null = null;
let core: HTMLCanvasElement | null = null;
let shimmer: HTMLCanvasElement | null = null;
let flare: HTMLCanvasElement | null = null;

export const laserGlowSprite = () => (glow ??= bakeGlow([120, 225, 255], [20, 110, 255]));
export const superLaserGlowSprite = () => (superGlow ??= bakeGlow([215, 170, 255], [120, 60, 255]));
export const laserCoreSprite = () => (core ??= bakeCore());
export const laserShimmerSprite = () => (shimmer ??= bakeShimmer());
export const laserFlareSprite = () => (flare ??= bakeFlare());
export const LASER_SHIMMER_TILE = SHIMMER_W;
