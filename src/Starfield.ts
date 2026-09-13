import { cosmeticRand as rand, TAU } from "./vec";

// Per-layer parallax: the fraction of the camera's world-scroll each background
// layer moves by. Farther things move less (≈0 = at infinity, 1 = locked to the
// world like gameplay entities). Depth-ordered so the field reads as real space:
// nebula sits deepest, the twinkling stars drift fastest of the star layers, and
// the pulsar (handled in gameRender) is nearer still. The nearest foreground
// accents ("ecliptic stars") live in Pulsar.ts now — they orbit the shared
// ecliptic with the planets rather than parallax-scrolling here.
export const STARFIELD_PARALLAX = {
  nebula: 0.06,
  dust: 0.16,
  starBase: 0.2, // per-star scaled up by depth on top of this
  starDepth: 0.22,
} as const;

// Wrap a screen-space delta onto the torus: the nearest wrapped image of a star
// to a query point is never more than half a cell away.
const foldDelta = (d: number, period: number): number => {
  d %= period;
  if (d > period / 2) d -= period;
  else if (d < -period / 2) d += period;
  return d;
};

type Star = {
  x: number;
  y: number;
  size: number;
  hue: number;
  twinklePhase: number;
  twinkleSpeed: number;
  depth: number;
};

// Tiny static background stars — no twinkle, no halo, no per-frame
// trig. Baked once into a sprite at construct/resize time so the dense
// field costs nothing at draw time.
type DustStar = {
  x: number;
  y: number;
  size: number;
  hue: number;
  alpha: number;
};

type NebulaBlob = {
  x: number;
  y: number;
  radius: number;
  hue: number;
  alpha: number;
};

// The starfield is a toroidal backdrop: it bakes one w×h sprite that tiles
// seamlessly so the locked-center scroll camera can scroll it 1:1 with the world
// and repeat it across the viewport with no seam. Every baked feature (nebula
// blob, dust star, Milky-Way puff) is drawn WRAPPED — also painted at the
// neighbour offsets it overhangs — so anything crossing an edge reappears on the
// opposite edge and the tile joins itself cleanly.
export class Starfield {
  stars: Star[] = [];
  dust: DustStar[] = [];
  nebula: NebulaBlob[] = [];
  w: number;
  h: number;
  // Pre-rendered nebula + Milky-Way band layer, baked tileable.
  nebulaSprite: HTMLCanvasElement | null = null;
  // Pre-rendered dust-star layer (dense, faint, static), baked tileable.
  dustSprite: HTMLCanvasElement | null = null;

  // Diagonal galactic band: where it crosses the cell and how wide its falloff
  // is. The band is a soft glow stripe with denser dust along it. Built from the
  // cell's own size so it always spans corner-to-corner and wraps with the tile.
  private bandAngle = 0;
  private bandOffset = 0; // perpendicular shift of the band centre, in px

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.generate();
    this.buildNebulaSprite();
    this.buildDustSprite();
  }

  // Signed perpendicular distance from a point to the band centre-line, taken
  // toroidally so the nearest wrapped image of the line wins. Drives both the
  // band glow falloff and the along-band dust-density boost.
  private bandDistance(x: number, y: number): number {
    const nx = Math.sin(this.bandAngle);
    const ny = -Math.cos(this.bandAngle);
    // Raw perpendicular distance to the infinite line through the cell centre.
    const cx = this.w / 2;
    const cy = this.h / 2;
    const raw = (x - cx) * nx + (y - cy) * ny - this.bandOffset;
    // The band repeats every cell along its normal (it's a wrapped diagonal), so
    // fold the distance into the nearest period so points near an edge read as
    // close to the band's wrapped image.
    const period = Math.abs(this.w * nx) + Math.abs(this.h * ny);
    let d = raw % period;
    if (d > period / 2) d -= period;
    if (d < -period / 2) d += period;
    return d;
  }

  private generate() {
    const { w, h } = this;
    // A diagonal band that leans up-right, offset off-centre so it doesn't cut
    // the field in half symmetrically.
    this.bandAngle = rand(-0.7, -0.45);
    this.bandOffset = rand(-h * 0.12, h * 0.12);
    const bandHalfWidth = h * 0.28;

    // Twinkling stars — the closest layer, drawn live. Denser near the band.
    const starCount = Math.floor((w * h) / 2400);
    for (let i = 0; i < starCount; i++) {
      const x = rand(0, w);
      const y = rand(0, h);
      // Bias extra stars onto the band: keep most, but reroll some off-band ones
      // toward it so the band reads as a faint over-density of pinpricks.
      const onBand = 1 - Math.min(1, Math.abs(this.bandDistance(x, y)) / bandHalfWidth);
      this.stars.push({
        x,
        y,
        size: rand(0.3, 2.0),
        hue: rand(180, 260),
        twinklePhase: rand(0, TAU),
        twinkleSpeed: rand(0.4, 2.0),
        depth: rand(0.2, 1.0),
      });
      // Drop a second, fainter star on the band for the density gradient.
      if (onBand > 0.45 && rand(0, 1) < onBand * 0.6) {
        this.stars.push({
          x: x + rand(-30, 30),
          y: y + rand(-30, 30),
          size: rand(0.3, 1.2),
          hue: rand(200, 250),
          twinklePhase: rand(0, TAU),
          twinkleSpeed: rand(0.4, 2.0),
          depth: rand(0.2, 0.6),
        });
      }
    }

    // Dense pin-prick dust. Base field everywhere, plus a strong over-density
    // concentrated along the band so the "milky" lane reads as packed stars.
    const dustCount = Math.floor((w * h) / 240);
    for (let i = 0; i < dustCount; i++) {
      const x = rand(0, w);
      const y = rand(0, h);
      const onBand = 1 - Math.min(1, Math.abs(this.bandDistance(x, y)) / bandHalfWidth);
      this.dust.push({
        x,
        y,
        size: rand(0.25, 0.7),
        hue: rand(180, 260),
        // a touch warmer/brighter inside the lane, but only a whisper of a boost
        alpha: rand(0.18, 0.55) * (0.85 + 0.25 * onBand),
      });
    }
    // Extra dust sprinkled only inside the lane for a clear density gradient.
    const bandDust = Math.floor(dustCount * 0.18);
    for (let i = 0; i < bandDust; i++) {
      // Sample a point biased toward the band centre.
      const along = rand(0, w);
      const perp = (rand(-1, 1) ** 3) * bandHalfWidth; // cubic → clusters at centre
      const nx = Math.sin(this.bandAngle);
      const ny = -Math.cos(this.bandAngle);
      const cx = w / 2;
      const cy = h / 2;
      // March `along` down the band axis, offset `perp` along its normal.
      const ax = Math.cos(this.bandAngle);
      const ay = Math.sin(this.bandAngle);
      const x = cx + (along - w / 2) * ax + (perp + this.bandOffset) * nx;
      const y = cy + (along - w / 2) * ay + (perp + this.bandOffset) * ny;
      this.dust.push({
        x: ((x % w) + w) % w,
        y: ((y % h) + h) % h,
        size: rand(0.25, 0.6),
        hue: rand(200, 250),
        alpha: rand(0.12, 0.4),
      });
    }

    // Coloured nebula blobs scattered across the cell, a few biased onto the band.
    const blobCount = 6;
    for (let i = 0; i < blobCount; i++) {
      const onBand = i < 3;
      let x: number, y: number;
      if (onBand) {
        const along = rand(0, w);
        const perp = rand(-bandHalfWidth * 0.7, bandHalfWidth * 0.7);
        const nx = Math.sin(this.bandAngle);
        const ny = -Math.cos(this.bandAngle);
        const ax = Math.cos(this.bandAngle);
        const ay = Math.sin(this.bandAngle);
        x = w / 2 + (along - w / 2) * ax + (perp + this.bandOffset) * nx;
        y = h / 2 + (along - w / 2) * ay + (perp + this.bandOffset) * ny;
      } else {
        x = rand(0, w);
        y = rand(0, h);
      }
      this.nebula.push({
        x: ((x % w) + w) % w,
        y: ((y % h) + h) % h,
        radius: rand(220, 460),
        // warmer hues in the band (200-260), cooler/violet drifting off it
        hue: onBand ? rand(210, 265) : rand(250, 300),
        // barely-there — the coloured clouds are a faint tint in the black, not
        // a wash. (Gradient stacks additively over the band glow.)
        alpha: rand(0.003, 0.0075),
      });
    }

  }

  // Draw `paint(ox, oy)` at the base position and at every neighbour offset the
  // feature overhangs, so a feature crossing an edge reappears opposite and the
  // baked sprite tiles seamlessly.
  private wrapDraw(x: number, y: number, reach: number, paint: (ox: number, oy: number) => void) {
    const { w, h } = this;
    const dxs = x < reach ? [0, w] : x > w - reach ? [0, -w] : [0];
    const dys = y < reach ? [0, h] : y > h - reach ? [0, -h] : [0];
    for (const dx of dxs) for (const dy of dys) paint(dx, dy);
  }

  buildNebulaSprite() {
    const { w, h } = this;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(w));
    canvas.height = Math.max(1, Math.floor(h));
    const ctx = canvas.getContext("2d")!;
    ctx.globalCompositeOperation = "lighter";

    // 1. Milky-Way band glow — a soft luminous lane along the diagonal, built
    //    from overlapping radial puffs marched down the band axis (each wrapped),
    //    so the glow is continuous and tiles with the cell.
    const bandHalfWidth = h * 0.26;
    const ax = Math.cos(this.bandAngle);
    const ay = Math.sin(this.bandAngle);
    const nx = Math.sin(this.bandAngle);
    const ny = -Math.cos(this.bandAngle);
    const cx = w / 2;
    const cy = h / 2;
    const span = Math.hypot(w, h);
    const step = 46;
    for (let s = -span; s <= span; s += step) {
      // gentle waver so the lane isn't a ruler-straight stripe
      const waver = Math.sin(s * 0.004) * bandHalfWidth * 0.18;
      const px = cx + s * ax + (this.bandOffset + waver) * nx;
      const py = cy + s * ay + (this.bandOffset + waver) * ny;
      const wx = ((px % w) + w) % w;
      const wy = ((py % h) + h) % h;
      const r = bandHalfWidth * rand(0.85, 1.15);
      this.wrapDraw(wx, wy, r, (ox, oy) => {
        const g = ctx.createRadialGradient(wx + ox, wy + oy, 0, wx + ox, wy + oy, r);
        // barely-there warm-cream core fading to nothing — the diffuse galactic
        // glow should read as a whisper, not a stripe (puffs stack additively).
        g.addColorStop(0, "hsla(40, 45%, 80%, 0.003)");
        g.addColorStop(0.5, "hsla(220, 60%, 60%, 0.002)");
        g.addColorStop(1, "hsla(220, 60%, 60%, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(wx + ox - r, wy + oy - r, r * 2, r * 2);
      });
    }

    // 2. Coloured nebula blobs on top, each wrapped so it tiles.
    for (const b of this.nebula) {
      this.wrapDraw(b.x, b.y, b.radius, (ox, oy) => {
        const g = ctx.createRadialGradient(b.x + ox, b.y + oy, 0, b.x + ox, b.y + oy, b.radius);
        g.addColorStop(0, `hsla(${b.hue}, 90%, 62%, ${b.alpha})`);
        g.addColorStop(0.5, `hsla(${b.hue + 20}, 80%, 52%, ${b.alpha * 0.4})`);
        g.addColorStop(1, `hsla(${b.hue}, 90%, 62%, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(b.x + ox - b.radius, b.y + oy - b.radius, b.radius * 2, b.radius * 2);
      });
    }
    this.nebulaSprite = canvas;
  }

  buildDustSprite() {
    const { w, h } = this;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(w));
    canvas.height = Math.max(1, Math.floor(h));
    const ctx = canvas.getContext("2d")!;
    ctx.globalCompositeOperation = "lighter";
    for (const d of this.dust) {
      this.wrapDraw(d.x, d.y, d.size + 1, (ox, oy) => {
        ctx.fillStyle = `hsla(${d.hue}, 70%, 88%, ${d.alpha})`;
        ctx.beginPath();
        ctx.arc(d.x + ox, d.y + oy, d.size, 0, TAU);
        ctx.fill();
      });
    }
    this.dustSprite = canvas;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.stars = [];
    this.dust = [];
    this.nebula = [];
    this.generate();
    this.buildNebulaSprite();
    this.buildDustSprite();
  }

  // Blit a tileable sprite to cover the whole screen, scrolled by (sx,sy). The
  // sprite is exactly one world cell (w×h), so two copies per axis cover any
  // scroll offset — the seamless bake means the joins are invisible.
  private blitTiled(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, sx: number, sy: number) {
    const { w, h } = this;
    let ox = sx % w;
    if (ox > 0) ox -= w;
    let oy = sy % h;
    if (oy > 0) oy -= h;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) ctx.drawImage(sprite, ox + i * w, oy + j * h);
    }
  }

  // camera is optional so the starfield still renders fine in isolation
  // (tests, splash screens). scrollX/scrollY (locked-center mode) shift the whole
  // field 1:1 with the world and tile it seamlessly so the stars feel anchored to
  // the torus. When no scroll is given the legacy parallax/roll dolly is used
  // (the non-scroll edge-aid modes), where the closer twinkling stars fan outward
  // from the pulsar's focal point as approach grows.
  render(
    ctx: CanvasRenderingContext2D,
    t: number,
    camera?: { focalX: number; focalY: number; roll: number; approach: number },
    scrollX = 0,
    scrollY = 0,
  ) {
    const scrolling = scrollX !== 0 || scrollY !== 0;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    if (scrolling) {
      this.renderScrolling(ctx, t, scrollX, scrollY);
      ctx.restore();
      return;
    }

    const focalX = camera ? camera.focalX : this.w / 2;
    const focalY = camera ? camera.focalY : this.h / 2;
    const roll = camera ? camera.roll : 0;
    const approach = camera ? camera.approach : 0;
    const farZoom = 1 + 0.06 * approach;
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);
    const driftX = Math.sin(t * 0.0003) * 20;
    const driftY = Math.cos(t * 0.00025) * 20;

    for (const sprite of [this.nebulaSprite, this.dustSprite]) {
      if (!sprite) continue;
      ctx.save();
      ctx.translate(focalX, focalY);
      ctx.rotate(roll);
      ctx.scale(farZoom, farZoom);
      const dx = sprite === this.nebulaSprite ? driftX : 0;
      const dy = sprite === this.nebulaSprite ? driftY : 0;
      ctx.translate(-focalX + dx, -focalY + dy);
      ctx.drawImage(sprite, 0, 0);
      ctx.restore();
    }

    this.renderTwinkles(ctx, t, focalX, focalY, approach, cosR, sinR);
    ctx.restore();
  }

  // Place a star at its on-screen wrapped copy and run `paint(px, py)` for the
  // single copy that lands on screen. Each layer scrolls by its own parallax
  // fraction of the camera offset, so deeper layers slide past slower; the wrap
  // period stays w/h so every layer still tiles seamlessly.
  private wrapStar(
    x: number, y: number, sx: number, sy: number, pad: number,
    paint: (px: number, py: number) => void,
  ) {
    const { w, h } = this;
    let ox = sx % w;
    if (ox > 0) ox -= w;
    let oy = sy % h;
    if (oy > 0) oy -= h;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const px = x + ox + i * w;
        const py = y + oy + j * h;
        if (px < -pad || px > w + pad || py < -pad || py > h + pad) continue;
        paint(px, py);
      }
    }
  }

  // Visit every star (dust + twinkling) whose scrolled screen position lands
  // inside the ellipse centred (cx, cy) with semi-axes (rx, ry) — the patch a
  // wormhole lenses. Positions are the exact wrapped screen coords
  // renderScrolling paints (each layer under its own parallax), so the lens
  // bends the very stars the player sees behind it, and they keep streaming
  // past as the camera scrolls instead of freezing under a snapshot. Twinkle
  // alpha/size match the live paint for the same `t`. `halo` flags the bigger
  // twinklers that also paint a soft halo.
  forEachStarNear(
    t: number, scrollX: number, scrollY: number,
    cx: number, cy: number, rx: number, ry: number,
    visit: (x: number, y: number, size: number, hue: number, alpha: number, halo: boolean) => void,
  ) {
    const { w, h } = this;
    const P = STARFIELD_PARALLAX;
    const dustX = scrollX * P.dust;
    const dustY = scrollY * P.dust;
    for (const d of this.dust) {
      const dx = foldDelta(d.x + dustX - cx, w);
      if (dx > rx || dx < -rx) continue;
      const dy = foldDelta(d.y + dustY - cy, h);
      if (dy > ry || dy < -ry) continue;
      const nx = dx / rx;
      const ny = dy / ry;
      if (nx * nx + ny * ny > 1) continue;
      visit(cx + dx, cy + dy, d.size, d.hue, d.alpha, false);
    }
    for (const star of this.stars) {
      const p = P.starBase + P.starDepth * star.depth;
      const dx = foldDelta(star.x + scrollX * p - cx, w);
      if (dx > rx || dx < -rx) continue;
      const dy = foldDelta(star.y + scrollY * p - cy, h);
      if (dy > ry || dy < -ry) continue;
      const nx = dx / rx;
      const ny = dy / ry;
      if (nx * nx + ny * ny > 1) continue;
      const twinkle = 0.5 + 0.5 * Math.sin(t * 0.001 * star.twinkleSpeed + star.twinklePhase);
      const alpha = 0.13 + 0.32 * twinkle * star.depth;
      const size = star.size * (0.7 + 0.3 * twinkle);
      visit(cx + dx, cy + dy, size, star.hue, alpha, star.size > 1.3);
    }
  }

  // Locked-center scroll: each layer tiles under its OWN parallax-scaled scroll
  // (deeper = slower) so the field reads as real depth. The baked sprites blit
  // tiled; the live twinkling stars scatter wrapped across their scroll.
  private renderScrolling(ctx: CanvasRenderingContext2D, t: number, sx: number, sy: number) {
    const P = STARFIELD_PARALLAX;
    const driftX = Math.sin(t * 0.0003) * 20;
    const driftY = Math.cos(t * 0.00025) * 20;
    if (this.nebulaSprite) this.blitTiled(ctx, this.nebulaSprite, sx * P.nebula + driftX, sy * P.nebula + driftY);
    if (this.dustSprite) this.blitTiled(ctx, this.dustSprite, sx * P.dust, sy * P.dust);

    for (const star of this.stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 0.001 * star.twinkleSpeed + star.twinklePhase);
      const alpha = 0.13 + 0.32 * twinkle * star.depth;
      const size = star.size * (0.7 + 0.3 * twinkle);
      // closer (higher depth) twinkles parallax faster than the deep field
      const p = P.starBase + P.starDepth * star.depth;
      const bigHalo = star.size > 1.3;
      this.wrapStar(star.x, star.y, sx * p, sy * p, 4, (px, py) => {
        ctx.fillStyle = `hsla(${star.hue}, 80%, 85%, ${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, TAU);
        ctx.fill();
        if (bigHalo) {
          ctx.fillStyle = `hsla(${star.hue}, 80%, 85%, ${alpha * 0.4})`;
          ctx.beginPath();
          ctx.arc(px, py, size * 3, 0, TAU);
          ctx.fill();
        }
      });
    }
  }

  // Legacy parallax twinkles: each star fans outward from the focal point with
  // depth, rolled with the camera — the non-scroll edge-aid modes' dolly feel.
  private renderTwinkles(
    ctx: CanvasRenderingContext2D, t: number,
    focalX: number, focalY: number, approach: number, cosR: number, sinR: number,
  ) {
    for (const star of this.stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 0.001 * star.twinkleSpeed + star.twinklePhase);
      const alpha = 0.13 + 0.32 * twinkle * star.depth;
      const size = star.size * (0.7 + 0.3 * twinkle);
      const parallax = 1 + approach * (0.42 - 0.32 * star.depth);
      const rx = (star.x - focalX) * parallax;
      const ry = (star.y - focalY) * parallax;
      const sx = focalX + rx * cosR - ry * sinR;
      const sy = focalY + rx * sinR + ry * cosR;
      ctx.fillStyle = `hsla(${star.hue}, 80%, 85%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(sx, sy, size, 0, TAU);
      ctx.fill();
      if (star.size > 1.3) {
        ctx.fillStyle = `hsla(${star.hue}, 80%, 85%, ${alpha * 0.4})`;
        ctx.beginPath();
        ctx.arc(sx, sy, size * 3, 0, TAU);
        ctx.fill();
      }
    }
  }
}
