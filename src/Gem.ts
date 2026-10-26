import { Vec, v, rand, pick, TAU, addScaledMut, scaleMut, sub, mul, len, fromAngle, circleHit } from "./vec";
import { completeEntrance, foldWithEntrance } from "./game/entrance";
import { Canister, POWERUP_KINDS } from "./Canister";
import { ENTITY_CONFIG } from "./game/entityConfig";
import { cosmeticRng } from "./game/rng";

// Sprite-shaping jitter draws from the COSMETIC stream — buildSprite runs lazily
// inside render(), so pulling from the gameplay rng there would desync replays.
const crand = (min: number, max: number) => min + cosmeticRng() * (max - min);

// Re-exports so existing imports (collisions.ts, etc.) keep working — the
// authoritative numbers live in entityConfig.
export const GEM_UPGRADE_CHANCE = ENTITY_CONFIG.asteroidWithGem.upgradeChance;
export const GEM_REVEAL_SCORE = ENTITY_CONFIG.asteroidWithGem.revealScore;

// A standalone target left behind by a "asteroidWithGem" asteroid's death — a
// jagged obsidian gem: a black faceted diamond-cut crystal, half glassy and
// half rough chipped/gritty stone, with molten gold glowing through its cracks, so it reads as valuable-but-hazardous rather than
// a clean pickup you'd obviously scoop up. It's a rhythm target (shoot on-beat
// to crack it open), so the dangerous-looking rough edges sell "shoot me, don't
// touch me". It drifts where the rock died, inheriting a fraction of the
// parent's velocity so it reads as "ejected from the explosion", then dims and
// warps out after a long lifetime.

export const GEM_SCORE = ENTITY_CONFIG.asteroidWithGem.pickupScore;

const LIFETIME = ENTITY_CONFIG.asteroidWithGem.lifetime;
// final fraction of life spent fading + flickering as a warp-out warning.
const FADE_TAIL = LIFETIME * 0.22;

export class Gem {
  pos: Vec;
  vel: Vec;
  hue: number;
  // Pickup radius. A touch larger than the visible gem so the player doesn't
  // feel cheated when the ship clips a corner.
  radius = ENTITY_CONFIG.asteroidWithGem.radius;
  age = 0;
  alive = true;
  // Fast-flung gems (the fan a burstGem bursts into) keep their launch velocity
  // and wrap at the screen edge instead of decaying to a near-stop, so they read
  // as blades thrown across the field rather than a quietly settling drop.
  fast = false;
  // Entrance state (gem-swarm gems) — see game/entrance.ts.
  entering = false;
  enterOffX = 0;
  enterOffY = 0;
  enterTraveled = 0;
  enterMinOvershoot = 0;
  // Optional drift-to-park: rhythm-aligned gems fly from the crystal's death
  // site to a solved spot on the player's one-beat aim ring, arriving exactly
  // when `parkAge` is reached, then freeze. `parkTarget` null = free drift.
  parkTarget: Vec | null = null;
  parkAge = 0;
  private parkOrigin: Vec | null = null;
  // Lazy slow tumble, like an asteroid chunk — the ore body is a prebaked sprite
  // (built once on first render) and this just spins it in 2D.
  rot: number;
  rotSpeed: number;
  // Prebaked ore-rock sprite + its half-extent (radius incl. a little glow pad).
  private sprite: HTMLCanvasElement | null = null;
  private spriteHalf = 0;

  constructor(pos: Vec, vel: Vec) {
    this.pos = pos;
    this.vel = vel;
    this.hue = 46;
    this.rot = crand(0, TAU);
    this.rotSpeed = crand(-0.7, 0.7);
  }

  // Glide this gem from its current spot to `target`, arriving at age `arriveAge`
  // and parking there. Used by the rhythm-aligned drop so the gem lands on the
  // player's one-beat aim ring right on the downbeat.
  driftToPark(target: Vec, arriveAge: number) {
    this.parkOrigin = { ...this.pos };
    this.parkTarget = { ...target };
    this.parkAge = arriveAge;
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    this.rot += this.rotSpeed * dt;
    if (this.parkTarget && this.parkOrigin) {
      // Smoothstep glide from the death site to the solved aim-ring spot over
      // one beat, then hold. Eased so the gem decelerates into its park.
      const t = this.parkAge > 0 ? Math.min(1, this.age / this.parkAge) : 1;
      const e = t * t * (3 - 2 * t);
      this.pos.x = this.parkOrigin.x + (this.parkTarget.x - this.parkOrigin.x) * e;
      this.pos.y = this.parkOrigin.y + (this.parkTarget.y - this.parkOrigin.y) * e;
    } else if (this.fast) {
      // Flung blade: hold velocity and wrap, so the gem keeps crossing the
      // field as a live rhythm target until its lifetime expires.
      addScaledMut(this.pos, this.vel, dt);
      foldWithEntrance(this, w, h);
    } else {
      // Gentle drift; the gem isn't supposed to chase or flee, it just floats
      // where the rock died.
      addScaledMut(this.pos, this.vel, dt);
      foldWithEntrance(this, w, h);
      // Slow the drift over time so it eventually settles near its origin.
      scaleMut(this.vel, Math.max(0, 1 - dt * 0.6));
    }
    if (this.age >= LIFETIME) this.alive = false;
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    const hit = circleHit(this.pos, this.radius, point, pointRadius);
    // Real contact ends the entrance presentation (see game/entrance.ts).
    if (hit) completeEntrance(this);
    return hit;
  }

  // Tail-end fade + quickening flicker warning the gem is about to warp out.
  private fadeAlpha(time: number): number {
    const remaining = LIFETIME - this.age;
    if (remaining >= FADE_TAIL) return 1;
    const tail = Math.max(0, remaining / FADE_TAIL);
    // flicker speeds up as tail → 0 so the urgency reads even while still bright.
    const flicker = 0.7 + 0.3 * Math.sin(time * (8 + (1 - tail) * 22));
    return tail * flicker;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    if (!this.sprite) this.buildSprite();
    const time = t * 0.001;
    const fade = this.fadeAlpha(time);
    // The polished facets catch the light as the gem turns — a slow, brighter
    // glint (this is a shiny crystal, not dull ore) so it reads as "sharp and
    // valuable" without flashing like a friendly pickup pod.
    const glint = 0.5 + 0.5 * Math.sin(time * 1.7 + this.age * 0.9);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rot);

    // The lit gem body (faceted crystal + rough chipped stone) — solid, not
    // additive.
    ctx.globalAlpha = fade;
    ctx.drawImage(this.sprite!, -this.spriteHalf, -this.spriteHalf);
    ctx.globalAlpha = 1;

    // A faint additive glint over the polished facets + sparkle points only,
    // keyed to the same baked sprite so the shine lands on the crystal faces
    // rather than the whole gem glowing — low-alpha so it never reads as a
    // pickup halo.
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.45 * glint * fade;
    ctx.drawImage(this.veinSprite!, -this.spriteHalf, -this.spriteHalf);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  // Glint-only sprite (bright facet planes + sparkle points on transparent),
  // reused as the additive glint overlay so the shimmer lands on the polished
  // faces and nowhere else.
  private veinSprite: HTMLCanvasElement | null = null;

  // Outline vertices of the gem silhouette (gem-local, unrotated). Cached so the
  // body bake and the glint bake share the exact same faceted silhouette.
  private hullPts: Array<[number, number]> = [];
  // The flat top "table" facet's corners, and the culet (bottom point). The
  // brilliant cut is: table on top, CROWN facets sloping girdle→table, PAVILION
  // facets sloping girdle→culet. Real 3D structure, not a flat pinwheel fan.
  private tablePts: Array<[number, number]> = [];
  private culet: [number, number] = [0, 0];

  // Prebake the gem once: a brilliant-cut faceted diamond — a flat top table,
  // crown facets above the girdle, pavilion facets converging to a culet point,
  // each shaded by distance to a single up-left light so the cut reads as one
  // solid 3D object. Half brilliant shine, half rough chipped stone so it looks
  // valuable-but-dangerous. Static → baked once, then rotated/faded per frame.
  private buildSprite() {
    const H = this.hue;
    const R = this.radius;
    const pad = 4;
    const half = R * 1.4 + pad; // room for the sharp culet point + rim
    const size = Math.ceil(half * 2);
    this.spriteHalf = half;

    // Girdle outline: a tall kite/marquise silhouette. Widest at the girdle
    // (y≈-0.1), a shortish pointed crown up top, a long pointed pavilion below.
    // Per-corner nicks so edges read chipped/rough, not machined.
    const base: Array<[number, number]> = [
      [0, -1.14], // crown apex (top point)
      [0.5, -0.62],
      [0.92, -0.12], // right girdle (widest)
      [0.58, 0.5],
      [0.24, 1.02],
      [0, 1.36], // culet (bottom point)
      [-0.24, 1.02],
      [-0.58, 0.5],
      [-0.92, -0.12], // left girdle
      [-0.5, -0.62],
    ];
    this.hullPts = base.map(([bx, by]) => {
      const j = 1 + crand(-0.07, 0.07);
      return [bx * R * j, by * R * j] as [number, number];
    });
    // Table: a small flat top facet, its rim sitting a bit below the crown apex
    // and pushed slightly up-left so the flat top catches the key light.
    const tw = R * 0.34, ty = -R * 0.5, tox = -R * 0.06;
    this.tablePts = [
      [tox - tw, ty - R * 0.12],
      [tox + tw * 0.9, ty - R * 0.16],
      [tox + tw, ty + R * 0.14],
      [tox - tw * 0.85, ty + R * 0.18],
    ];
    this.culet = this.hullPts[5];

    const rimPath = (c: CanvasRenderingContext2D) => {
      c.beginPath();
      const p = this.hullPts;
      c.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
      c.closePath();
    };

    this.sprite = this.paintBody(size, half, H, rimPath);
    this.veinSprite = this.paintGlint(size, half, rimPath);
  }

  // Single virtual light, up-left of the gem. Facet brightness = proximity of
  // its centroid to this point, so shading is continuous across the whole body
  // and the cut looks like one solid object catching one light (the Asteroid
  // solid-crystal technique).
  private litAt(x: number, y: number, R: number): number {
    const lx = -R * 0.6, ly = -R * 0.7;
    const d = Math.hypot(x - lx, y - ly);
    return Math.pow(Math.max(0, 1 - d / (R * 2.1)), 1.5); // 1 under light … 0 far
  }

  // Fill one facet triangle/quad, shaded by its centroid's light proximity and
  // given a subtle across-facet gradient so each plane isn't a flat tint. `bias`
  // nudges this facet lighter/darker on top of the continuous lighting so
  // adjacent facets alternate — the scintillation that reads as "cut & polished"
  // rather than a smooth dome.
  private fillFacet(
    c: CanvasRenderingContext2D, H: number, R: number,
    pts: Array<[number, number]>, bias = 0,
  ) {
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    const cx = sx / pts.length, cy = sy / pts.length;
    const lit = Math.max(0, Math.min(1, this.litAt(cx, cy, R) + bias));
    // Near-black obsidian: lit facets only lift to a glassy charcoal sheen.
    const l0 = 3 + lit * 9, l1 = 6 + lit * 18;
    const s = 14;
    const g = c.createLinearGradient(-R * 0.5, -R * 0.6, R * 0.5, R * 0.6);
    g.addColorStop(0, `hsl(${H + 8}, ${s}%, ${l1}%)`);
    g.addColorStop(1, `hsl(${H - 8}, ${s}%, ${l0}%)`);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    c.fill();
    return lit;
  }

  // Faceted crystal body + rough chipped stone + two-stroke rim.
  private paintBody(
    size: number, half: number, H: number,
    rimPath: (c: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const c = cv.getContext("2d")!;
    c.translate(half, half);
    const R = this.radius;

    // Base gem fill: black glass with a faint upper-left sheen, so the crystal
    // reads as a lit solid before the facets carve light and shadow into it.
    const body = c.createRadialGradient(-R * 0.35, -R * 0.5, R * 0.1, 0, 0, R * 1.5);
    body.addColorStop(0, `hsl(${H}, 12%, 20%)`);
    body.addColorStop(0.55, `hsl(${H}, 10%, 8%)`);
    body.addColorStop(1, `hsl(${H}, 8%, 2%)`);
    c.fillStyle = body;
    rimPath(c);
    c.fill();

    // Everything else clipped to the hard gem silhouette.
    c.save();
    rimPath(c);
    c.clip();
    this.paintFacets(c, R, H);
    c.restore();

    // Two-stroke rim: dark outer occlusion contact + thin bright inner catch —
    // crisp mitred joins (not rounded) keep the edges reading sharp/dangerous.
    c.globalCompositeOperation = "source-over";
    c.lineJoin = "miter";
    c.miterLimit = 4;
    c.lineWidth = 2.4;
    c.strokeStyle = "hsla(38, 55%, 8%, 0.95)";
    rimPath(c);
    c.stroke();
    c.lineWidth = 1;
    c.strokeStyle = `hsla(${H}, 18%, 48%, 0.6)`;
    rimPath(c);
    c.stroke();
    return cv;
  }

  // Carve the interior into a real brilliant-cut structure: crown facets from
  // the girdle up to the table's edges, a flat lit table on top, pavilion facets
  // fanning from the girdle down to the culet — each shaded by one up-left light
  // so the whole thing reads as a solid 3D cut stone. Then a rough chipped/gritty
  // patch on the shadow side so it looks too dangerous to grab.
  //
  // Hull indices: 0 crown apex, 2 right girdle (widest), 5 culet (bottom point),
  // 8 left girdle. The girdle line runs 8→2 across the middle; the crown fills
  // above it to the table, the pavilion fills below it to the culet.
  private paintFacets(c: CanvasRenderingContext2D, R: number, H: number) {
    const hull = this.hullPts;
    const tbl = this.tablePts;
    const culet = this.culet;
    // The girdle midline endpoints (widest points, left & right).
    const gL = hull[8], gR = hull[2];
    // A pavilion keel just above the culet, on the light side, so the lower half
    // has a bright main facet instead of collapsing to one dark point.
    const keel: [number, number] = [-R * 0.1, R * 0.34];

    // --- Pavilion: fan the WHOLE lower polygon (girdle line gL→gR down through
    // the lower hull points to the culet) around the keel, so it fully tiles
    // with no dark gaps. Each facet shaded by its centroid's light proximity.
    const lower = [gR, hull[3], hull[4], culet, hull[6], hull[7], gL];
    for (let i = 0; i < lower.length - 1; i++) {
      // Alternate facets brighter/darker so the pavilion scintillates.
      this.fillFacet(c, H, R, [keel, lower[i], lower[i + 1]], i % 2 ? 0.14 : -0.12);
    }
    // Close the fan across the girdle midline so the band above the keel fills.
    this.fillFacet(c, H, R, [keel, gL, gR], 0.1);

    // --- Crown: fill the whole upper polygon (girdle line gL→gR up through the
    // upper hull points) out to the table edges. Fan from the table so the crown
    // facets slope up to the flat top with no gaps.
    // Left crown wall, table-top band, right crown wall, and the two girdle
    // bevels linking table corners down to the widest points.
    this.fillFacet(c, H, R, [gL, hull[9], tbl[0]]);
    this.fillFacet(c, H, R, [hull[9], hull[0], tbl[1], tbl[0]]);
    this.fillFacet(c, H, R, [hull[0], hull[1], tbl[2], tbl[1]]);
    this.fillFacet(c, H, R, [hull[1], gR, tbl[2]]);
    this.fillFacet(c, H, R, [gL, tbl[0], tbl[3]]);   // left girdle bevel
    this.fillFacet(c, H, R, [gR, tbl[2], tbl[3]]);   // right girdle bevel
    this.fillFacet(c, H, R, [gL, tbl[3], gR]);       // under-table band to girdle

    // --- Table: the flat top facet. Brightest plane, a smooth bright gradient
    // (a mirror flat surface reflecting the sky), edged crisply.
    const tl = this.litAt(0, -R * 0.5, R);
    const tg = c.createLinearGradient(tbl[0][0], tbl[0][1], tbl[2][0], tbl[2][1]);
    tg.addColorStop(0, `hsl(${H}, 12%, ${16 + tl * 22}%)`);
    tg.addColorStop(1, `hsl(${H}, 10%, ${6 + tl * 10}%)`);
    c.fillStyle = tg;
    c.beginPath();
    c.moveTo(tbl[0][0], tbl[0][1]);
    for (let i = 1; i < tbl.length; i++) c.lineTo(tbl[i][0], tbl[i][1]);
    c.closePath();
    c.fill();

    // Facet seams: bright hairlines along every cut edge (pavilion mains, girdle,
    // table rim, crown spokes). Crisp seams are what make a cut stone sparkle.
    c.lineJoin = "miter";
    c.lineWidth = 0.7;
    const seam = (a: [number, number], b: [number, number]) => {
      const lit = this.litAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, R);
      c.strokeStyle = `hsla(${H}, 14%, ${30 + lit * 35}%, ${0.18 + lit * 0.4})`;
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    };
    for (const pt of lower) seam(keel, pt);          // pavilion mains
    seam(gL, gR);                                    // girdle midline
    for (let i = 0; i < tbl.length; i++) seam(tbl[i], tbl[(i + 1) % tbl.length]);
    seam(hull[0], tbl[1]); seam(hull[9], tbl[0]); seam(hull[1], tbl[2]);
    seam(gL, tbl[0]); seam(gR, tbl[2]);

    // --- The rough half: a gritty chipped patch of raw stone biased to the
    // lower-right shadow side, so the gem is clearly "not a clean pickup".
    for (let i = 0; i < 20; i++) {
      const ang = i * 2.399 + 0.5; // golden-angle scatter
      const d = R * (0.3 + 0.7 * ((i * 0.191) % 1));
      const x = Math.cos(ang) * d, y = Math.sin(ang) * d;
      if ((x * 0.6 + y) < R * 0.25 && i % 4 !== 0) continue; // bias to shadow side
      const gr = R * (0.04 + 0.06 * ((i * 0.37) % 1));
      c.fillStyle = i % 2 === 0
        ? `hsla(${H}, 8%, 1%, 0.6)`
        : `hsla(${H}, 10%, 40%, 0.25)`;
      c.beginPath(); c.arc(x, y, gr, 0, TAU); c.fill();
    }
    // Hard dark chip-gouges (sharp notches) on the rough side.
    c.lineCap = "round";
    for (let i = 0; i < 3; i++) {
      const ang = 0.7 + i * 1.4;
      const x = Math.cos(ang) * R * 0.72, y = Math.sin(ang) * R * 0.72;
      c.strokeStyle = `hsla(${H - 22}, 40%, 6%, 0.55)`;
      c.lineWidth = R * 0.06;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x - Math.cos(ang + 0.6) * R * 0.26, y - Math.sin(ang + 0.6) * R * 0.26);
      c.stroke();
    }

    this.paintCracks(c, R, H, 1);

    // Glassy specular: a hard bright chip on the table's up-left corner + a
    // couple of pinpoint sparkles at lit facet junctions — the shine that says
    // "gem", concentrated where the light hits.
    c.fillStyle = "hsla(220, 30%, 92%, 0.7)";
    c.beginPath();
    c.moveTo(tbl[0][0], tbl[0][1]);
    c.lineTo(tbl[0][0] + R * 0.22, tbl[0][1] + R * 0.05);
    c.lineTo(tbl[0][0] + R * 0.05, tbl[0][1] + R * 0.24);
    c.closePath();
    c.fill();
    for (const [sx, sy, sr] of [
      [-R * 0.5, -R * 0.2, R * 0.09],
      [R * 0.15, -R * 0.05, R * 0.06],
    ] as Array<[number, number, number]>) {
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, sr);
      g.addColorStop(0, "hsla(220, 30%, 96%, 0.6)");
      g.addColorStop(1, "hsla(220, 30%, 90%, 0)");
      c.fillStyle = g;
      c.beginPath(); c.arc(sx, sy, sr, 0, TAU); c.fill();
    }
  }

  // Jagged fissures through the obsidian, generated once per gem so the bake
  // and the glint overlay trace the same cracks.
  private cracks: Array<Array<[number, number]>> = [];
  private buildCracks(R: number) {
    this.cracks = [];
    const n = 3 + Math.floor(crand(0, 2));
    for (let k = 0; k < n; k++) {
      let ang = crand(0, TAU);
      let x = Math.cos(ang) * R * crand(0, 0.35), y = Math.sin(ang) * R * crand(0, 0.35);
      const pts: Array<[number, number]> = [[x, y]];
      const steps = 4 + Math.floor(crand(0, 3));
      for (let i = 0; i < steps; i++) {
        ang += crand(-0.9, 0.9);
        const step = R * crand(0.14, 0.28);
        x += Math.cos(ang) * step; y += Math.sin(ang) * step;
        pts.push([x, y]);
      }
      this.cracks.push(pts);
    }
  }

  // Molten gold peeking through: a soft amber bleed hugging each fissure and a
  // hairline hot core. `gain` scales it so the glint pass can re-trace brighter.
  private paintCracks(c: CanvasRenderingContext2D, R: number, H: number, gain: number) {
    if (this.cracks.length === 0) this.buildCracks(R);
    c.lineCap = "round";
    c.lineJoin = "round";
    const trace = (pts: Array<[number, number]>) => {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    };
    for (const pts of this.cracks) {
      c.strokeStyle = `hsla(${H - 6}, 100%, 45%, ${0.3 * gain})`;
      c.lineWidth = R * 0.18;
      trace(pts); c.stroke();
      c.strokeStyle = `hsla(${H}, 100%, 55%, ${0.75 * gain})`;
      c.lineWidth = R * 0.07;
      trace(pts); c.stroke();
      c.strokeStyle = `hsla(${H + 8}, 100%, 82%, ${0.9 * gain})`;
      c.lineWidth = R * 0.025;
      trace(pts); c.stroke();
    }
  }

  // Glint-only sprite: just the bright facet seams + table sparkle on
  // transparent, clipped to the gem, used as the subtle additive glint overlay
  // so the shine shimmers in place as the gem turns.
  private paintGlint(
    size: number, half: number,
    rimPath: (c: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const c = cv.getContext("2d")!;
    c.translate(half, half);
    c.save();
    rimPath(c);
    c.clip();
    const R = this.radius, H = this.hue;
    const tbl = this.tablePts;
    // The gold in the cracks breathes as the gem turns.
    this.paintCracks(c, R, H, 1);
    // Faint glassy sparkle pinpoints on the lit table corner + up-left girdle.
    for (const [sx, sy, sr] of [
      [tbl[0][0], tbl[0][1], R * 0.16],
      [-R * 0.5, -R * 0.2, R * 0.11],
    ] as Array<[number, number, number]>) {
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, sr);
      g.addColorStop(0, "hsla(220, 30%, 96%, 0.4)");
      g.addColorStop(1, "hsla(220, 30%, 90%, 0)");
      c.fillStyle = g;
      c.beginPath(); c.arc(sx, sy, sr, 0, TAU); c.fill();
    }
    c.restore();
    return cv;
  }
}

// Spawn a gold crystal at the dead asteroid's position, inheriting a small
// fraction of its parent velocity so the gem drifts naturally with the burst
// rather than freezing in space.
export const spawnGemAt = (pos: Vec, parentVel: Vec): Gem => {
  // a fraction of parent velocity + small random jitter reads as "the
  // explosion ejected it" without sending it flying out of reach. Jitter is
  // small so the gem stays predictably near the kill site.
  const drift = v(parentVel.x * 0.25 + rand(-18, 18), parentVel.y * 0.25 + rand(-18, 18));
  return new Gem({ ...pos }, drift);
};

// Fan `count` gems out from the dropper's position in an even ring, each gem
// gently ejected outward so they read as a small burst spreading from the kill
// site rather than a clump landing on one spot. A single gem just inherits the
// parent drift (no meaningful direction to fan toward).
const GEM_FAN_EJECT_SPEED = 42; // gentle outward drift, pre-rhythm-mul
export const spawnGemFan = (pos: Vec, parentVel: Vec, count: number): Gem[] => {
  if (count <= 1) return count === 1 ? [spawnGemAt(pos, parentVel)] : [];
  const baseAngle = rand(0, TAU);
  const gems: Gem[] = [];
  for (let i = 0; i < count; i++) {
    const angle = baseAngle + (i / count) * TAU;
    const dir = fromAngle(angle);
    const drift = v(
      parentVel.x * 0.25 + dir.x * GEM_FAN_EJECT_SPEED,
      parentVel.y * 0.25 + dir.y * GEM_FAN_EJECT_SPEED,
    );
    gems.push(new Gem({ ...pos }, drift));
  }
  return gems;
};

// A burstGem's death: fan `count` fast-flying gems out in an even ring, rotated
// half a step off the killing-shot axis so none flies straight back down the
// return line (the bullet came IN along impactDir). Each is a real Gem — fly
// into one and you die, shoot it on-beat for points/an upgrade — that simply
// keeps its launch speed and wraps the field instead of settling in place.
export const spawnBurstGemFan = (
  deathPos: Vec,
  parentVel: Vec,
  impactDir: Vec | null,
  count: number,
  speed: number,
  ejectDist: number,
): Gem[] => {
  const baseAngle = impactDir
    ? Math.atan2(impactDir.y, impactDir.x)
    : Math.atan2(parentVel.y, parentVel.x);
  const fan: Gem[] = [];
  for (let i = 0; i < count; i++) {
    const angle = baseAngle + Math.PI / count + (i / count) * TAU;
    const dir = fromAngle(angle);
    const pos = v(deathPos.x + dir.x * ejectDist, deathPos.y + dir.y * ejectDist);
    // Inherit a touch of the gem's drift so the fan travels with it rather than
    // expanding from a dead-still centre.
    const vel = v(parentVel.x * 0.3 + dir.x * speed, parentVel.y * 0.3 + dir.y * speed);
    const gem = new Gem(pos, vel);
    gem.fast = true;
    fan.push(gem);
  }
  return fan;
};

// A gem swarm: a flock of bare gems streaking across the field the same way a
// meteor shower does — shared heading, spread across the entry edge, staggered
// diagonally so they trail rather than arrive as a wall. Each is a live rhythm
// target (fly in → die; shoot on-beat → points or an upgrade): a brief, dense
// "comb through them" window. They fly fast and wrap, so they keep crossing
// until shot or expired. Velocities are aligned to the beat by the caller.
const GEM_SWARM_SPEED = 165; // brisk single-screen-width sweep, pre-rhythm-mul
export const spawnGemSwarm = (w: number, h: number, count: number): Gem[] => {
  const edge = Math.floor(rand(0, 4));
  const offset = 120;
  let origin: Vec;
  if (edge === 0) origin = v(-offset, rand(h * 0.15, h * 0.85));
  else if (edge === 1) origin = v(w + offset, rand(h * 0.15, h * 0.85));
  else if (edge === 2) origin = v(rand(w * 0.15, w * 0.85), -offset);
  else origin = v(rand(w * 0.15, w * 0.85), h + offset);

  const target = v(rand(w * 0.3, w * 0.7), rand(h * 0.3, h * 0.7));
  const angle = Math.atan2(target.y - origin.y, target.x - origin.x);
  const along = fromAngle(angle, 1);
  const perp = v(-along.y, along.x);

  const gems: Gem[] = [];
  for (let i = 0; i < count; i++) {
    // Spread across the perpendicular (centred on origin) and stagger back
    // along the heading so later gems trail the leaders.
    const spread = (i - (count - 1) / 2) * rand(48, 78);
    const lag = i * rand(50, 110);
    const pos = v(
      origin.x + perp.x * spread - along.x * lag,
      origin.y + perp.y * spread - along.y * lag,
    );
    const gem = new Gem(pos, fromAngle(angle, GEM_SWARM_SPEED));
    gem.fast = true;
    gems.push(gem);
  }
  return gems;
};

// Drop a fresh powerup canister where the gem was. Aims at a random point on
// the far side of the playfield and uses the standard canister drift speed so
// the freed canister flies across the screen and eventually warps out just
// like a normally-spawned canister — the player has to chase it.
export const spawnCanisterFromGem = (g: Gem, w: number, h: number): Canister => {
  const kind = pick(POWERUP_KINDS);
  const aim = v(rand(80, w - 80), rand(80, h - 80));
  const delta = sub(aim, g.pos);
  const fullDist = len(delta) || 1;
  const dir = mul(delta, 1 / fullDist);
  // Slower drift + longer path budget than a standard canister so freed
  // upgrades hang around long enough for the player to actually chase them
  // down — the gem already cost work to crack, so the reward shouldn't warp
  // out before they can react.
  const driftSpeed = rand(45, 80);
  const pathLength = fullDist * rand(1.1, 1.5);
  return new Canister({ ...g.pos }, mul(dir, driftSpeed), kind, pathLength);
};
