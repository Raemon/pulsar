import { Vec, v, add, mul, fromAngle, rand, cosmeticRand, TAU, circleHit } from "./vec";
import { completeEntrance, foldWithEntrance } from "./game/entrance";
import { AlienBullet } from "./AlienBullet";
import { Trail } from "./Trail";
import { rng, cosmeticRng } from "./game/rng";
import { ENTITY_CONFIG } from "./game/entityConfig";
import { WARP_OUT_DURATION, warpAnchorOffset, renderThroughPortal, type Wormhole } from "./game/wormhole";

// Three sizes, each with its own role in the rhythm:
//   "big"    : 4 HP, fires every other beat (every 2× BEAT_GRID).
//              Uses the same multi-hit pipeline as bassteroids — each hit
//              decrements hp by 1, the killing hit explodes it.
//   "medium" : 2 HP, fires every beat (BEAT_GRID).
//   "small"  : 1 HP, fires every beat (BEAT_GRID).
//   Act II aliens are a tougher purple breed with faster bullets (see
//   AlienBreed / ENTITY_CONFIG.alien.actTwo).
//
// Aliens fly across the field on a slow arcing curve with a lazy weave on top.
// They don't wrap — once they drift off the far side of the screen they're gone.
// They're not aiming for the player directly — they shoot toward the player's
// current position when the beat lands, so the player can dodge by moving.
export type AlienSize = "big" | "medium" | "small";

const SIZE_RADIUS = ENTITY_CONFIG.alien.radius;
// Aliens are big and often warp out in a crowd (a wave skip sends them all at
// once), so their lens buffer is held coarser than the ship's.
const ALIEN_WARP_MAX_PX = 160;
const SIZE_HP = ENTITY_CONFIG.alien.hp;
const SIZE_SCORE = ENTITY_CONFIG.alien.score;
const SIZE_SPEED = ENTITY_CONFIG.alien.speed;
const SIZE_BULLET_SPEED = ENTITY_CONFIG.alien.bulletSpeed;

const SIZE_HUE: Record<AlienSize, number> = {
  // Act I's dark blood-red manta family — all three sizes sit in the same crimson band
  // so they read as the same species. Big sits deepest, small drifts a touch
  // warmer toward orange-red, medium sits between them.
  big: 356,
  medium: 0,
  small: 6,
};

// Each act fields its own breed of manta: the colour it wears and how it scales
// the per-size HP and bullet speed.
type AlienBreed = { hue: Record<AlienSize, number>; hpMul: number; bulletSpeedMul: number };
const ACT_ONE_BREED: AlienBreed = { hue: SIZE_HUE, hpMul: 1, bulletSpeedMul: 1 };
const ACT_TWO_BREED: AlienBreed = ENTITY_CONFIG.alien.actTwo;

// Per-size firing pattern: gaps (in BEAT_GRID units) between consecutive
// shots, cycled forever. Each entry is the wait BEFORE the next shot. Game
// multiplies by BEAT_GRID and aligns to the global beat clock so shots fall
// exactly on the rhythm grid the player is already listening to.
//   small  : one shot every 4 beats — sparse, but bullets travel farther/faster
//   medium : shot, shot (half-beat later), REST x3 → quick double-tap then 3-beat breather (4-beat cycle)
//   big    : 8-shot burst on the half-beat in a wide arc, then 4-beat rest
//            before the next burst (7 × 0.5 + 4 = 7.5-beat cycle).
export const ALIEN_FIRE_PATTERN_BEATS: Record<AlienSize, number[]> = {
  small: [4],
  medium: [0.5, 3.5],
  big: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 4],
};

// Big aliens spray each 8-shot burst across a wide arc centred on the player.
// Total spread ≈ 90°; offsets are evenly spaced so the burst paints a fan.
export const BIG_ALIEN_BURST_LEN = 8;
const BIG_ALIEN_ARC = Math.PI / 2;
export const bigAlienBurstAngleOffset = (i: number): number => {
  const t = i / (BIG_ALIEN_BURST_LEN - 1);
  return (t - 0.5) * BIG_ALIEN_ARC;
};

// Manta-craft shape. The body is a single curved silhouette — no panels — and
// the renderer carves it into a wing-disc with chevron ribs, leading-edge
// highlight, spine ridge, cockpit slit, and a trailing whip-tail. All coords
// in radius-units (renderer scales by this.radius); +X = nose forward, +Y =
// wingtip "down" relative to the heading.
//
// Outline is built as a single closed curve from these waypoints, traced
// clockwise from the nose around the starboard wing-tip → tail → port tip and
// back. The tail is a separate filled strip that fans out from the body's
// rear notch so it can taper independently of the wing.
type MantaWaypoint = { p: Vec; control: Vec };
type MantaShape = {
  // outline: nose → starboard fin tip → starboard wing root → starboard wing
  // tip → starboard rear → tail-root starboard → tail-root port → port rear →
  // port wing tip → port wing root → port fin tip → back to nose. Each pair
  // (p, control) is a quadratic curve to p with the given control point.
  outline: MantaWaypoint[];
  // cephalic horns — small forward fins. Each is a tiny triangle the renderer
  // paints AFTER the body so it sits proud of the leading edge.
  horns: { tip: Vec; baseA: Vec; baseB: Vec }[];
  // structural ribs sweeping from spine to wing edge. Each rib is a polyline
  // (start → mid → end) of straight segments — the kink in the middle makes
  // the rib read as a hard structural seam rather than an organic curve.
  // Mirrored top/bottom automatically.
  ribs: { start: Vec; mid: Vec; end: Vec }[];
  // facet seams — extra straight line pairs that paint as hard dark plate
  // joins over the curved silhouette. Each pair is a (start, end) polyline
  // run; the renderer paints them as faint inset shadows with a brighter
  // edge-light along one side. Gives the wing a mechanically-plated look
  // without breaking the swept outline. Mirrored top/bottom.
  facets: { start: Vec; end: Vec }[];
  // tail: a tapered whip emerging from the rear notch. baseHalfWidth controls
  // how thick it is at the body, length is how far back it reaches, and
  // barbHalfWidth is the tail tip's flare (0 for a clean point).
  tail: { length: number; baseHalfWidth: number; barbHalfWidth: number; sway: number } | null;
  // cockpit canopy — a faceted polygon on the dorsal centerline rather than
  // a smooth ellipse. Vertices traced clockwise; renderer fills with a dark
  // glass tint and paints a thin bright edge.
  cockpit: { vertices: Vec[] };
};

// Helper for symmetric outlines: takes the starboard-side waypoints (y >= 0)
// and returns a full closed outline by appending mirrored port-side ones in
// reverse order. The nose and tail-junction points are shared (not mirrored).
const symmetricOutline = (
  nose: MantaWaypoint,
  starboardEdge: MantaWaypoint[],
  rearStarboard: MantaWaypoint,
  rearPort: MantaWaypoint,
  portEdgeReturning: MantaWaypoint[],
): MantaWaypoint[] => [nose, ...starboardEdge, rearStarboard, rearPort, ...portEdgeReturning];

const buildMantaShape = (size: AlienSize): MantaShape => {
  if (size === "small") {
    // Juvenile darter — short wing-disc, sharp swept tips, stubby tail.
    return {
      outline: symmetricOutline(
        { p: v(0.95, 0), control: v(0.95, 0) },
        [
          // starboard leading edge: nose → fin shoulder → wing tip
          { p: v(0.35, 0.55), control: v(0.85, 0.45) },
          { p: v(-0.25, 0.7), control: v(0.0, 0.85) },
          // starboard trailing edge: wing tip → rear notch
          { p: v(-0.55, 0.3), control: v(-0.5, 0.55) },
        ],
        { p: v(-0.55, 0.12), control: v(-0.55, 0.18) },
        { p: v(-0.55, -0.12), control: v(-0.55, 0) },
        [
          // port trailing edge: rear notch → wing tip
          { p: v(-0.25, -0.7), control: v(-0.5, -0.55) },
          // port leading edge: wing tip → nose
          { p: v(0.35, -0.55), control: v(0.0, -0.85) },
          // close back to nose
          { p: v(0.95, 0), control: v(0.85, -0.45) },
        ],
      ),
      horns: [
        { tip: v(1.05, -0.08), baseA: v(0.75, -0.02), baseB: v(0.78, -0.15) },
        { tip: v(1.05, 0.08), baseA: v(0.75, 0.02), baseB: v(0.78, 0.15) },
      ],
      ribs: [
        { start: v(0.55, 0.05), mid: v(0.35, 0.32), end: v(0.05, 0.55) },
        { start: v(0.15, 0.05), mid: v(-0.05, 0.32), end: v(-0.28, 0.58) },
        { start: v(-0.25, 0.05), mid: v(-0.4, 0.22), end: v(-0.52, 0.34) },
      ],
      facets: [
        // forward leading-edge chamfer (straight cut across the swept curve)
        { start: v(0.7, 0.0), end: v(0.55, 0.32) },
        // mid-wing seam joining hull to wing plate
        { start: v(0.0, 0.0), end: v(-0.2, 0.5) },
        // trailing-edge chamfer near the rear notch
        { start: v(-0.5, 0.18), end: v(-0.35, 0.5) },
      ],
      tail: { length: 0.45, baseHalfWidth: 0.08, barbHalfWidth: 0.0, sway: 0.18 },
      cockpit: {
        vertices: [v(0.7, 0), v(0.6, -0.05), v(0.45, -0.05), v(0.4, 0), v(0.45, 0.05), v(0.6, 0.05)],
      },
    };
  }
  if (size === "medium") {
    // Adult sting-craft — broader sweeping wing-disc, downturned tips, mid
    // whip tail with a slight terminal flare.
    return {
      outline: symmetricOutline(
        { p: v(1.0, 0), control: v(1.0, 0) },
        [
          { p: v(0.45, 0.6), control: v(0.95, 0.45) },
          { p: v(-0.05, 0.95), control: v(0.25, 1.05) },
          { p: v(-0.45, 0.55), control: v(-0.45, 0.95) },
          { p: v(-0.6, 0.15), control: v(-0.55, 0.4) },
        ],
        { p: v(-0.55, 0.08), control: v(-0.6, 0.12) },
        { p: v(-0.55, -0.08), control: v(-0.6, 0) },
        [
          { p: v(-0.6, -0.15), control: v(-0.55, -0.12) },
          { p: v(-0.45, -0.55), control: v(-0.55, -0.4) },
          { p: v(-0.05, -0.95), control: v(-0.45, -0.95) },
          { p: v(0.45, -0.6), control: v(0.25, -1.05) },
          { p: v(1.0, 0), control: v(0.95, -0.45) },
        ],
      ),
      horns: [
        { tip: v(1.15, -0.1), baseA: v(0.85, -0.02), baseB: v(0.85, -0.2) },
        { tip: v(1.15, 0.1), baseA: v(0.85, 0.02), baseB: v(0.85, 0.2) },
      ],
      ribs: [
        { start: v(0.6, 0.06), mid: v(0.45, 0.45), end: v(0.15, 0.78) },
        { start: v(0.25, 0.06), mid: v(0.05, 0.45), end: v(-0.22, 0.82) },
        { start: v(-0.1, 0.06), mid: v(-0.28, 0.4), end: v(-0.42, 0.62) },
        { start: v(-0.4, 0.05), mid: v(-0.5, 0.2), end: v(-0.58, 0.32) },
      ],
      facets: [
        // forward leading-edge chamfer
        { start: v(0.75, 0.0), end: v(0.6, 0.4) },
        // mid-wing structural seam
        { start: v(0.1, 0.0), end: v(-0.1, 0.65) },
        // outer wing-plate seam
        { start: v(-0.3, 0.3), end: v(-0.4, 0.65) },
        // trailing-edge chamfer
        { start: v(-0.55, 0.2), end: v(-0.35, 0.55) },
      ],
      tail: { length: 0.85, baseHalfWidth: 0.07, barbHalfWidth: 0.06, sway: 0.28 },
      cockpit: {
        vertices: [v(0.78, 0), v(0.66, -0.07), v(0.48, -0.07), v(0.4, 0), v(0.48, 0.07), v(0.66, 0.07)],
      },
    };
  }
  // big — leviathan manta. Vast curved wing-disc, prominent cephalic horns,
  // long taper-to-flare whip tail, broad leading edge.
  return {
    outline: symmetricOutline(
      { p: v(1.0, 0), control: v(1.0, 0) },
      [
        { p: v(0.5, 0.65), control: v(1.0, 0.5) },
        { p: v(0.05, 1.05), control: v(0.35, 1.2) },
        { p: v(-0.55, 0.7), control: v(-0.45, 1.15) },
        { p: v(-0.7, 0.3), control: v(-0.7, 0.5) },
      ],
      { p: v(-0.6, 0.12), control: v(-0.65, 0.2) },
      { p: v(-0.6, -0.12), control: v(-0.65, 0) },
      [
        { p: v(-0.7, -0.3), control: v(-0.65, -0.2) },
        { p: v(-0.55, -0.7), control: v(-0.7, -0.5) },
        { p: v(0.05, -1.05), control: v(-0.45, -1.15) },
        { p: v(0.5, -0.65), control: v(0.35, -1.2) },
        { p: v(1.0, 0), control: v(1.0, -0.5) },
      ],
    ),
    horns: [
      { tip: v(1.2, -0.14), baseA: v(0.9, -0.04), baseB: v(0.88, -0.24) },
      { tip: v(1.2, 0.14), baseA: v(0.9, 0.04), baseB: v(0.88, 0.24) },
    ],
    ribs: [
      { start: v(0.65, 0.08), mid: v(0.5, 0.55), end: v(0.18, 0.9) },
      { start: v(0.3, 0.08), mid: v(0.1, 0.6), end: v(-0.25, 0.92) },
      { start: v(-0.05, 0.08), mid: v(-0.28, 0.5), end: v(-0.48, 0.72) },
      { start: v(-0.35, 0.06), mid: v(-0.5, 0.3), end: v(-0.62, 0.48) },
      { start: v(-0.55, 0.05), mid: v(-0.62, 0.15), end: v(-0.67, 0.24) },
    ],
    facets: [
      // forward leading-edge chamfer — long straight cut
      { start: v(0.8, 0.0), end: v(0.6, 0.5) },
      // upper mid-wing seam (between cockpit row and outer wing)
      { start: v(0.15, 0.0), end: v(-0.05, 0.78) },
      // outer wing-plate seam
      { start: v(-0.25, 0.4), end: v(-0.48, 0.8) },
      // inner-rear hull seam
      { start: v(-0.45, 0.1), end: v(-0.6, 0.45) },
      // trailing-edge chamfer
      { start: v(-0.6, 0.25), end: v(-0.4, 0.62) },
    ],
    tail: { length: 1.2, baseHalfWidth: 0.08, barbHalfWidth: 0.1, sway: 0.34 },
    cockpit: {
      vertices: [v(0.85, 0), v(0.72, -0.08), v(0.5, -0.08), v(0.4, 0), v(0.5, 0.08), v(0.72, 0.08)],
    },
  };
};

type AlienCrack = {
  pos: Vec;
  angle: number;
  branches: { points: Vec[] }[];
};

// Visual-only crack overlay with a VARIABLE per-alien draw count — must use the
//   cosmetic stream so it can't shift gameplay draws and desync replays. Mirror
//   of Asteroid.rollCracks; see the cosmetic-stream note in rng.ts.
const rollAlienCracks = (count: number): AlienCrack[] => {
  const cracks: AlienCrack[] = [];
  for (let i = 0; i < count; i++) {
    const a = cosmeticRand(0, TAU);
    const r = cosmeticRand(0.18, 0.7);
    const forkCount = 3 + Math.floor(cosmeticRng() * 2);
    const branches: { points: Vec[] }[] = [];
    for (let f = 0; f < forkCount; f++) {
      const baseAngle = (f / forkCount) * TAU + cosmeticRand(-0.4, 0.4);
      const segments = 3 + Math.floor(cosmeticRng() * 2);
      const points: Vec[] = [v(0, 0)];
      let cx = 0;
      let cy = 0;
      let ang = baseAngle;
      for (let s = 0; s < segments; s++) {
        const len = cosmeticRand(0.12, 0.22);
        ang += cosmeticRand(-0.7, 0.7);
        cx += Math.cos(ang) * len;
        cy += Math.sin(ang) * len;
        points.push(v(cx, cy));
      }
      branches.push({ points });
    }
    cracks.push({ pos: v(Math.cos(a) * r, Math.sin(a) * r), angle: cosmeticRand(0, TAU), branches });
  }
  return cracks;
};

export class Alien {
  pos: Vec;
  vel: Vec;
  size: AlienSize;
  radius: number;
  hue: number;
  hp: number;
  maxHp: number;
  // Muzzle speed of every shot, set by size and breed.
  bulletSpeed: number;
  cracks: AlienCrack[];
  // Game-time at which to fire the next bullet. Set on spawn (aligned to the
  // global beat grid) and advanced after each shot by the next gap in the
  // size's fire pattern.
  nextFireAt = 0;
  // Index into ALIEN_FIRE_PATTERN_BEATS[size] — advances each shot, wraps.
  firePatternIndex = 0;
  // Pulsing tells the player a beat is coming. Set to 1.0 each fire, decays.
  fireFlash = 0;
  flashAmount = 0;
  // Lazy oscillation that gives aliens a hovering "drifting around" feel
  // rather than a straight line.
  weavePhase: number;
  weaveSpeed: number;
  // Slow rotation of the velocity vector (rad/sec). Signed, small magnitude —
  // bends the flight path into an arc that may loop once before the alien
  // drifts off the far side of the screen.
  curveRate: number;
  // Rotation follows the heading (so the nose points along velocity), with
  // a small sway added in render() for life.
  rotation: number;
  // Curve-based manta silhouette (outline + chevron ribs + horns + tail +
  // cockpit). Built once at spawn and reused for the body draw, the crack
  // clip mask, and the hit-flash overlay.
  shape: MantaShape;
  // Pre-baked hull — static parts (silhouette fill + chevron ribs + leading
  // edge highlight + spine ridge + cockpit slit). Drawn once per frame with
  // one drawImage. The live parts (halo, chevron bioluminescent pulse, wake,
  // damage cracks, hit-flash) layer on top each frame.
  sprite: HTMLCanvasElement;
  // Half of the sprite's canvas size, used to centre the drawImage blit.
  spriteHalfSize: number = 0;
  // Score awarded on kill.
  scoreValue: number;
  alive = true;
  // Distance flown since spawn, and the threshold at which it despawns. The
  // alien enters just off the visible edge and crosses the screen; once it has
  // travelled past the far edge it's gone. Distance-based (not an off-screen
  // box) because the scroll camera tiles the world, so there is no fixed
  // off-screen region. spawnAlienAtEdge overwrites maxTravel from the screen
  // size; the Infinity default keeps a directly-constructed alien (the sound
  // page's looping demo) from auto-despawning.
  traveled = 0;
  maxTravel = Infinity;
  // Warp-out: an alien that reaches maxTravel dives through a departure portal
  // instead of vanishing off the far edge. warpT runs 0→1 over
  // WARP_OUT_DURATION; while it does, the body slides toward warpAnchor (the
  // portal's throat) and is drawn through the portal's lens until it's gone.
  // needsWormhole tells the Game to spawn exactly one portal (warpPortal, a
  // render-only reference). null = not warping.
  warpT: number | null = null;
  warpAnchorX = 0;
  warpAnchorY = 0;
  warpStartX = 0;
  warpStartY = 0;
  needsWormhole = false;
  warpPortal: Wormhole | null = null;
  // Entrance state — the arrival mirror of warpT. See game/entrance.ts.
  entering = false;
  enterOffX = 0;
  enterOffY = 0;
  enterTraveled = 0;
  enterMinOvershoot = 0;
  // Theremin-drone glow trail. Vibrato pulse mode lines up loosely with the
  // alien voice's amplitude LFO. See Trail.ts.
  trail: Trail;

  // `act` picks the breed (see AlienBreed).
  constructor(pos: Vec, vel: Vec, size: AlienSize, act: number = 1) {
    const breed = act >= 2 ? ACT_TWO_BREED : ACT_ONE_BREED;
    this.pos = pos;
    this.vel = vel;
    this.size = size;
    this.radius = SIZE_RADIUS[size];
    this.hue = breed.hue[size];
    this.maxHp = SIZE_HP[size] * breed.hpMul;
    this.hp = this.maxHp;
    this.bulletSpeed = SIZE_BULLET_SPEED[size] * breed.bulletSpeedMul;
    this.cracks = rollAlienCracks(this.maxHp);
    this.weavePhase = rand(0, TAU);
    this.weaveSpeed = rand(0.6, 1.1);
    // Gentle path bend — small enough that the alien still crosses to roughly
    // the opposite side. Bigger curveRate used to make them loop and exit the
    // same edge, which left them on-screen for only a moment.
    this.curveRate = rand(0.04, 0.1) * (rng() < 0.5 ? -1 : 1);
    this.rotation = Math.atan2(vel.y, vel.x);
    this.shape = buildMantaShape(size);
    this.sprite = this.buildSprite();
    this.scoreValue = SIZE_SCORE[size];
    // Trail tuned per size — bigger aliens have a thicker, slower-pulsing
    // wake; small ones flicker faster, matching their tighter firing rate.
    const trailRadius = this.radius * 0.7;
    const trailRate = size === "big" ? 0.9 : size === "medium" ? 1.2 : 1.5;
    this.trail = new Trail(this.hue, trailRadius, 0.26, "theremin", trailRate);
  }

  // Begin diving through a departure portal. Freezes the dive path: the body
  // travels from here to warpAnchor (the portal's throat — the centre of its
  // spherical mouth). Called once when
  // the alien reaches maxTravel.
  private beginWarpOut() {
    this.warpT = 0;
    this.needsWormhole = true;
    this.warpStartX = this.pos.x;
    this.warpStartY = this.pos.y;
    const off = warpAnchorOffset(this.radius, Math.atan2(this.vel.y, this.vel.x));
    this.warpAnchorX = this.pos.x + off.dx;
    this.warpAnchorY = this.pos.y + off.dy;
  }

  // Heading the portal aligns to — the alien's flight direction.
  get warpHeading(): number {
    return Math.atan2(this.vel.y, this.vel.x);
  }

  update(dt: number, w: number, h: number) {
    // Once warping out, run the dive instead of normal flight: ease the body
    // into the portal mouth and end it when it's fully swallowed.
    if (this.warpT !== null) {
      this.warpT += dt / WARP_OUT_DURATION;
      if (this.warpT >= 1) {
        this.alive = false;
        return;
      }
      this.weavePhase += dt * this.weaveSpeed;
      const k = Math.min(1, this.warpT);
      const ease = k * k;
      this.pos.x = this.warpStartX + (this.warpAnchorX - this.warpStartX) * ease;
      this.pos.y = this.warpStartY + (this.warpAnchorY - this.warpStartY) * ease;
      this.trail.update(dt, this.pos.x, this.pos.y);
      if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
      return;
    }
    this.weavePhase += dt * this.weaveSpeed;
    // Bend the velocity vector slowly so the flight path arcs (and sometimes
    // loops) instead of going in a straight line. Rotate (vx, vy) by curveRate*dt.
    const cosR = Math.cos(this.curveRate * dt);
    const sinR = Math.sin(this.curveRate * dt);
    const nvx = this.vel.x * cosR - this.vel.y * sinR;
    const nvy = this.vel.x * sinR + this.vel.y * cosR;
    this.vel.x = nvx;
    this.vel.y = nvy;
    // Sideways weave perpendicular to current heading — gives the alien a
    // saucer-like sway without making it impossible to predict where it's
    // going to be in a couple of seconds.
    const heading = Math.atan2(this.vel.y, this.vel.x);
    const perpX = -Math.sin(heading);
    const perpY =  Math.cos(heading);
    const swayMag = Math.sin(this.weavePhase) * 42;
    const stepX = (this.vel.x + perpX * swayMag) * dt;
    const stepY = (this.vel.y + perpY * swayMag) * dt;
    this.pos.x += stepX;
    this.pos.y += stepY;
    // Fold onto the torus; carry the wake across the fold. Despawn stays on
    // distance *travelled* (maxTravel, set from the screen diagonal) — under
    // the locked-centre scroll camera there is no fixed off-screen region.
    const off = foldWithEntrance(this, w, h);
    if (off) this.trail.shift(off.x, off.y);
    this.traveled += Math.hypot(stepX, stepY);
    if (this.traveled > this.maxTravel) {
      this.beginWarpOut();
    }
    // Nose follows the direction of travel, with a tiny weave-driven sway so
    // the silhouette breathes instead of locking rigidly to the velocity.
    this.rotation = heading + Math.sin(this.weavePhase) * 0.12;
    this.trail.update(dt, this.pos.x, this.pos.y);
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    if (this.fireFlash > 0) this.fireFlash = Math.max(0, this.fireFlash - dt * 2.4);
  }

  // Decrement HP by 1. Returns whether the alien is now dead. Game uses this
  // for big aliens (multi-hit, same pipeline as bassteroids) and for
  // medium/small to keep the bookkeeping uniform.
  applyDamage(): { killed: boolean } {
    this.hp = Math.max(0, this.hp - 1);
    this.flashAmount = 1;
    if (this.hp <= 0) this.alive = false;
    return { killed: this.hp <= 0 };
  }

  // same hp-as-momentum proxy as asteroids — a chip hit shoves a small
  // alien noticeably, barely budges a big one.
  applyKnockback(dirX: number, dirY: number, amount: number, referenceSpeed: number = 120) {
    const len = Math.hypot(dirX, dirY);
    if (len === 0) return;
    const fraction = Math.min(1, amount / Math.max(1, this.maxHp));
    const dv = fraction * referenceSpeed;
    this.vel.x += (dirX / len) * dv;
    this.vel.y += (dirY / len) * dv;
  }

  // Fire a bullet aimed at `target`. Returns the new bullet so Game can
  // append it to the alien-bullet list. Sets fireFlash for the visual cue.
  // `angleOffset` lets the caller spread a burst across an arc (big aliens).
  fireAt(target: Vec, angleOffset: number = 0): AlienBullet {
    this.fireFlash = 1;
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const angle = Math.atan2(dy, dx) + angleOffset;
    const speed = this.bulletSpeed;
    const muzzle = add(this.pos, mul(fromAngle(angle, 1), this.radius + 4));
    return new AlienBullet(muzzle, fromAngle(angle, speed), this.size, this.hue);
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    // A warping-out alien is intangible — it's diving through its portal, no
    // longer a target or a threat, so neither bullets nor the ship interact.
    if (this.warpT !== null) return false;
    // 0.9 — tight circle so glancing shots miss the spindly limbs.
    const hit = circleHit(this.pos, this.radius * 0.9, point, pointRadius);
    // Real contact ends the entrance presentation (see game/entrance.ts).
    if (hit) completeEntrance(this);
    return hit;
  }

  // Traces the closed body outline (the curved manta silhouette) onto whatever
  // 2D context is given, scaled to this.radius. Used by the sprite bake AND by
  // live renderers (cracks clip, hit-flash fill, ribs clip). Centred on (0,0)
  // in radius-units: caller is responsible for translate/rotate.
  private traceBody(ctx: CanvasRenderingContext2D) {
    const r = this.radius;
    const outline = this.shape.outline;
    ctx.beginPath();
    ctx.moveTo(outline[0].p.x * r, outline[0].p.y * r);
    for (let i = 1; i < outline.length; i++) {
      const wp = outline[i];
      ctx.quadraticCurveTo(wp.control.x * r, wp.control.y * r, wp.p.x * r, wp.p.y * r);
    }
    ctx.closePath();
  }

  // Traces the tail strip from rear-of-body back to tail tip. Closed shape;
  // base half-width tapers to barb half-width (0 = sharp point). A bit of sway
  // would be nice but the tail uses its own static taper here — animated sway
  // happens in live render where we have weavePhase.
  private traceTail(ctx: CanvasRenderingContext2D, swayPhase: number) {
    const tail = this.shape.tail;
    if (!tail) return;
    const r = this.radius;
    // Tail emerges from the rear notch at the body's rear (approximately at
    // x = -0.6, y = 0). Build it from a few segments with a sinusoidal sway
    // applied perpendicular to its forward axis (+X negative).
    const segs = 6;
    const baseX = -0.55;
    const top: { x: number; y: number }[] = [];
    const bot: { x: number; y: number }[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = baseX - t * tail.length;
      const half = tail.baseHalfWidth * (1 - t) + tail.barbHalfWidth * t;
      // Sway peaks toward the tip — base stays anchored to the body.
      const sway = Math.sin(swayPhase + t * 2.6) * tail.sway * t;
      top.push({ x: x * r, y: (-half + sway) * r });
      bot.push({ x: x * r, y: (half + sway) * r });
    }
    ctx.beginPath();
    ctx.moveTo(top[0].x, top[0].y);
    for (let i = 1; i < top.length; i++) ctx.lineTo(top[i].x, top[i].y);
    // tail tip (centred between last top & bot already), then walk back
    for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i].x, bot[i].y);
    ctx.closePath();
  }

  // Bakes the static parts of the manta into an offscreen sprite. Painted
  // once at construction and blitted each frame; live parts (halo, chevron
  // pulse, wake, damage, hit-flash) layer on top in render().
  buildSprite(): HTMLCanvasElement {
    const r = this.radius;
    const baseHue = this.hue;
    const shape = this.shape;
    // Padding accommodates leading-edge glow + horn tips + wing extent.
    const padding = 18;
    // Big and medium have outline points that reach past 1.0 (horns at 1.2,
    // wings at ~1.05) — pad the sprite generously so nothing clips.
    const extent = Math.ceil(r * 1.25 + padding);
    const sizePx = extent * 2;
    const canvas = document.createElement("canvas");
    canvas.width = sizePx;
    canvas.height = sizePx;
    const sctx = canvas.getContext("2d")!;
    this.spriteHalfSize = sizePx / 2;
    sctx.translate(sizePx / 2, sizePx / 2);

    // 1. Soft underbody glow — radial wash from spine outward, deeper in the
    //    centre of the wing-disc and fading toward the edges. Painted first
    //    so the silhouette fill rides on top of it.
    sctx.globalCompositeOperation = "lighter";
    const underglow = sctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.1);
    underglow.addColorStop(0, `hsla(${baseHue + 6}, 95%, 26%, 0.55)`);
    underglow.addColorStop(0.55, `hsla(${baseHue}, 90%, 18%, 0.35)`);
    underglow.addColorStop(1, `hsla(${baseHue - 6}, 80%, 10%, 0)`);
    sctx.fillStyle = underglow;
    sctx.fillRect(-extent, -extent, sizePx, sizePx);

    // 2. Body silhouette — dorsal-to-ventral gradient (darker along the spine,
    //    a touch lighter at the wing edges) gives the wing a sense of volume
    //    from above. Paint in source-over so the fill is opaque purple, not
    //    additively brightened.
    sctx.globalCompositeOperation = "source-over";
    this.traceBody(sctx);
    const bodyFill = sctx.createLinearGradient(0, -r, 0, r);
    bodyFill.addColorStop(0, `hsla(${baseHue + 4}, 85%, 20%, 0.96)`);
    bodyFill.addColorStop(0.5, `hsla(${baseHue - 2}, 90%, 8%, 0.98)`);
    bodyFill.addColorStop(1, `hsla(${baseHue + 4}, 85%, 20%, 0.96)`);
    sctx.fillStyle = bodyFill;
    sctx.fill();

    // 3. Tail body — same fill language as the wing so it reads as one piece.
    //    Static sway phase 0 for the baked version; live render adds animated
    //    sway as a separate stroke on top.
    if (shape.tail) {
      this.traceTail(sctx, 0);
      sctx.fillStyle = `hsla(${baseHue - 4}, 90%, 8%, 0.95)`;
      sctx.fill();
    }

    // 4. Cephalic horns — small filled triangles flanking the nose. Same
    //    body-fill language so they read as part of the same creature.
    sctx.fillStyle = `hsla(${baseHue + 4}, 88%, 14%, 0.95)`;
    for (const horn of shape.horns) {
      sctx.beginPath();
      sctx.moveTo(horn.tip.x * r, horn.tip.y * r);
      sctx.lineTo(horn.baseA.x * r, horn.baseA.y * r);
      sctx.lineTo(horn.baseB.x * r, horn.baseB.y * r);
      sctx.closePath();
      sctx.fill();
    }

    // 5. Structural ribs + facet seams — straight-segment plate joins, not
    //    organic curves. Ribs are kinked polylines (start → mid → end);
    //    facets are single straight cuts. Both clipped to the body so they
    //    can't bleed outside the wing silhouette.
    sctx.save();
    this.traceBody(sctx);
    sctx.clip();
    sctx.lineCap = "butt";
    sctx.lineJoin = "miter";

    // Facet seams first — dark inset that reads as a panel join, with a
    // brighter sliver on the dorsal side for "edge-lit plate" parallax.
    sctx.globalCompositeOperation = "source-over";
    for (const facet of shape.facets) {
      // Dark seam (the join itself).
      sctx.strokeStyle = `hsla(${baseHue - 12}, 70%, 5%, 0.55)`;
      sctx.lineWidth = 1.2;
      sctx.beginPath();
      sctx.moveTo(facet.start.x * r, -facet.start.y * r);
      sctx.lineTo(facet.end.x * r, -facet.end.y * r);
      sctx.stroke();
      sctx.beginPath();
      sctx.moveTo(facet.start.x * r, facet.start.y * r);
      sctx.lineTo(facet.end.x * r, facet.end.y * r);
      sctx.stroke();
    }
    // Bright edge-light along one side of each seam (slightly offset toward
    // the leading edge so the wing reads as a faceted plate catching light).
    sctx.globalCompositeOperation = "lighter";
    sctx.strokeStyle = `hsla(${baseHue + 8}, 100%, 55%, 0.32)`;
    sctx.lineWidth = 0.7;
    for (const facet of shape.facets) {
      const dx = facet.end.x - facet.start.x;
      const dy = facet.end.y - facet.start.y;
      const len = Math.hypot(dx, dy) || 1;
      // Perpendicular offset toward +X (forward) so the highlight sits on
      // the leading side of each seam.
      const nx = (-dy / len) * 0.025;
      const ny = (dx / len) * 0.025;
      // top side: flip y → flip perp y
      sctx.beginPath();
      sctx.moveTo((facet.start.x + nx) * r, (-(facet.start.y) - ny) * r);
      sctx.lineTo((facet.end.x + nx) * r, (-(facet.end.y) - ny) * r);
      sctx.stroke();
      // bottom side
      sctx.beginPath();
      sctx.moveTo((facet.start.x + nx) * r, (facet.start.y + ny) * r);
      sctx.lineTo((facet.end.x + nx) * r, (facet.end.y + ny) * r);
      sctx.stroke();
    }

    // Ribs — kinked polylines drawn as glowing structural seams.
    sctx.globalCompositeOperation = "lighter";
    sctx.strokeStyle = `hsla(${baseHue + 6}, 100%, 50%, 0.55)`;
    sctx.lineWidth = 1.2;
    sctx.lineCap = "round";
    sctx.lineJoin = "round";
    for (const rib of shape.ribs) {
      // top side (mirrored)
      sctx.beginPath();
      sctx.moveTo(rib.start.x * r, -rib.start.y * r);
      sctx.lineTo(rib.mid.x * r, -rib.mid.y * r);
      sctx.lineTo(rib.end.x * r, -rib.end.y * r);
      sctx.stroke();
      // bottom side
      sctx.beginPath();
      sctx.moveTo(rib.start.x * r, rib.start.y * r);
      sctx.lineTo(rib.mid.x * r, rib.mid.y * r);
      sctx.lineTo(rib.end.x * r, rib.end.y * r);
      sctx.stroke();
    }
    sctx.restore();

    // 6. Leading-edge highlight — a bright crescent traced along the front
    //    portion of the silhouette. Read as "wing cutting through space".
    //    We retrace the outline but only stroke; the lighter blend mode +
    //    shadowBlur paints a soft glow that hugs the leading edge. Body
    //    fill (drawn earlier in source-over) covers the rear stroke so only
    //    the forward arc reads as the highlight.
    sctx.globalCompositeOperation = "lighter";
    sctx.strokeStyle = `hsla(${baseHue + 8}, 100%, 58%, 0.85)`;
    sctx.lineWidth = 1.4;
    this.traceBody(sctx);
    sctx.stroke();

    // 7. Spine ridge — a faint dark line down the centerline gives the
    //    wing-disc a dorsal seam. Source-over so it darkens rather than
    //    glows.
    sctx.globalCompositeOperation = "source-over";
    sctx.strokeStyle = `hsla(${baseHue - 10}, 70%, 6%, 0.5)`;
    sctx.lineWidth = 1.0;
    sctx.beginPath();
    sctx.moveTo(0.85 * r, 0);
    sctx.lineTo(-0.55 * r, 0);
    sctx.stroke();

    // 8. Cockpit canopy — a faceted polygon (not an ellipse) reads as a
    //    glass plate rather than an organic eye. Dark glass fill, thin
    //    bright edge stroke, soft inner glow.
    const tracePoly = (poly: Vec[]) => {
      sctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const x = poly[i].x * r;
        const y = poly[i].y * r;
        if (i === 0) sctx.moveTo(x, y);
        else sctx.lineTo(x, y);
      }
      sctx.closePath();
    };
    sctx.globalCompositeOperation = "source-over";
    sctx.fillStyle = `hsla(${baseHue - 10}, 80%, 4%, 0.95)`;
    tracePoly(shape.cockpit.vertices);
    sctx.fill();
    sctx.strokeStyle = `hsla(${baseHue + 10}, 100%, 62%, 0.75)`;
    sctx.lineWidth = 0.8;
    sctx.lineJoin = "miter";
    sctx.stroke();
    // Inner glow — a faint additive wash sitting inside the dark canopy.
    sctx.save();
    tracePoly(shape.cockpit.vertices);
    sctx.clip();
    sctx.globalCompositeOperation = "lighter";
    // Compute polygon centroid for the radial gradient origin.
    let gcx = 0, gcy = 0;
    for (const p of shape.cockpit.vertices) { gcx += p.x; gcy += p.y; }
    gcx = (gcx / shape.cockpit.vertices.length) * r;
    gcy = (gcy / shape.cockpit.vertices.length) * r;
    const cockpitGlow = sctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, r * 0.2);
    cockpitGlow.addColorStop(0, `hsla(${baseHue + 8}, 100%, 55%, 0.7)`);
    cockpitGlow.addColorStop(1, `hsla(${baseHue}, 100%, 45%, 0)`);
    sctx.fillStyle = cockpitGlow;
    sctx.fillRect(-extent, -extent, sizePx, sizePx);
    sctx.restore();
    return canvas;
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    const portal = this.warpT !== null ? this.warpPortal : null;
    if (portal) {
      // Warping out: same fall through the lens as the ship's wave-skip dive.
      renderThroughPortal(
        ctx, portal, Math.min(1, this.warpT!), { x: this.pos.x, y: this.pos.y, reach: this.radius * 1.8 },
        portal.x - this.pos.x, portal.y - this.pos.y,
        (g) => this.paint(g, t, false), ALIEN_WARP_MAX_PX,
      );
      return;
    }
    this.paint(ctx, t, true);
  }

  // `warpShrink` is the fallback dive for a warp with no portal to lens through.
  private paint(ctx: CanvasRenderingContext2D, t: number, warpShrink: boolean) {
    const baseHue = this.hue;
    const r = this.radius;
    const shape = this.shape;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    // Warping out with no portal: shrink the whole body toward the throat and
    // spin it in. A brief swell, then squeeze to nothing.
    if (warpShrink && this.warpT !== null) {
      const k = Math.min(1, this.warpT);
      const warpScale = (1 + 0.18 * Math.sin(k * Math.PI)) * (1 - k * k);
      if (warpScale < 0.02) { ctx.restore(); return; }
      ctx.rotate(k * 5);
      ctx.scale(warpScale, warpScale);
    }
    ctx.rotate(this.rotation);
    ctx.globalCompositeOperation = "lighter";

    // Soft elongated halo — wider across the wing than along it, so the glow
    // matches the manta's wing-disc shape. Grows with fire-flash to telegraph
    // an incoming shot from a distance.
    const haloAlpha = 0.14 + 0.28 * this.fireFlash;
    const haloRadiusX = r * (1.3 + 0.25 * this.fireFlash);
    const haloRadiusY = r * (1.7 + 0.3 * this.fireFlash);
    ctx.save();
    ctx.scale(haloRadiusX / haloRadiusY, 1);
    const halo = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, haloRadiusY);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 45%, ${haloAlpha})`);
    halo.addColorStop(0.55, `hsla(${baseHue + 4}, 100%, 38%, ${haloAlpha * 0.35})`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 42%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadiusY, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Wake pulses — twin soft trails behind the rear-of-body. Pulses with the
    // weave so the manta feels like it's gliding rather than thrusting. No
    // "engine plumes" — these read as the slipstream of a swimming creature.
    const wakePulse = 0.7 + 0.3 * Math.sin(this.weavePhase * 2.4);
    for (const side of [-1, 1]) {
      const wx = -0.55 * r;
      const wy = 0.18 * r * side;
      const wakeLen = r * (0.45 + 0.18 * wakePulse);
      const wakeRad = r * 0.16;
      const wg = ctx.createRadialGradient(wx - wakeLen * 0.4, wy, 0, wx - wakeLen * 0.4, wy, wakeLen);
      wg.addColorStop(0, `hsla(${baseHue + 6}, 100%, 48%, ${0.45 * wakePulse})`);
      wg.addColorStop(0.55, `hsla(${baseHue}, 100%, 40%, ${0.2 * wakePulse})`);
      wg.addColorStop(1, `hsla(${baseHue}, 100%, 38%, 0)`);
      ctx.fillStyle = wg;
      ctx.beginPath();
      ctx.ellipse(wx - wakeLen * 0.4, wy, wakeLen, wakeRad, 0, 0, TAU);
      ctx.fill();
    }

    // Baked body — silhouette fill, chevron ribs, leading-edge glow, spine,
    // cockpit slit. Cast once into the offscreen sprite at construction.
    ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);

    // Edge-light pulse — a brightness wave sweeps from spine outward along
    // the rib seams, reading as charge running through the wing's structural
    // plates. Fire-flash boosts the whole wave so the moment of firing reads
    // as a coordinated glow.
    ctx.save();
    this.traceBody(ctx);
    ctx.clip();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const sweep = (t * 0.0014 + this.weavePhase * 0.4) % 1;
    for (let i = 0; i < shape.ribs.length; i++) {
      const rib = shape.ribs[i];
      const phase = (sweep + i / shape.ribs.length) % 1;
      const tri = Math.max(0, 1 - Math.abs(phase - 0.5) * 2.4);
      const pulse = tri * (0.5 + 0.6 * this.fireFlash) + this.fireFlash * 0.25;
      if (pulse <= 0.02) continue;
      ctx.strokeStyle = `hsla(${baseHue + 12}, 100%, 62%, ${Math.min(1, pulse * 0.85)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(rib.start.x * r, -rib.start.y * r);
      ctx.lineTo(rib.mid.x * r, -rib.mid.y * r);
      ctx.lineTo(rib.end.x * r, -rib.end.y * r);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(rib.start.x * r, rib.start.y * r);
      ctx.lineTo(rib.mid.x * r, rib.mid.y * r);
      ctx.lineTo(rib.end.x * r, rib.end.y * r);
      ctx.stroke();
    }
    ctx.restore();

    // Animated tail sway — stroke the tail outline with a faint glow so the
    // whip-tail trails behind the wing, rather than locking statically to the
    // baked sprite. Uses the same weave phase as the rest of the body.
    if (shape.tail) {
      ctx.save();
      ctx.strokeStyle = `hsla(${baseHue + 8}, 100%, 52%, 0.4)`;
      ctx.lineWidth = 1.2;
      this.traceTail(ctx, this.weavePhase * 1.4);
      ctx.stroke();
      ctx.restore();
    }

    // Damage cracks — one per HP lost. Clipped to the body silhouette so
    // they only show where there's actual wing underneath.
    const cracksToDraw = this.maxHp - this.hp;
    if (cracksToDraw > 0) {
      ctx.save();
      this.traceBody(ctx);
      ctx.clip();
      const crackScale = 0.6;
      for (let i = 0; i < cracksToDraw; i++) {
        const crack = this.cracks[i];
        const dx = crack.pos.x * r;
        const dy = crack.pos.y * r;
        ctx.save();
        ctx.translate(dx, dy);
        ctx.rotate(crack.angle);
        ctx.scale(crackScale, crackScale);
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(245,245,250,0.45)";
        ctx.lineWidth = 1.0;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const branch of crack.branches) {
          ctx.beginPath();
          for (let p = 0; p < branch.points.length; p++) {
            const px = branch.points[p].x * r;
            const py = branch.points[p].y * r;
            if (p === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = `rgba(255,255,255,0.28)`;
        ctx.lineWidth = 0.45;
        for (const branch of crack.branches) {
          ctx.beginPath();
          for (let p = 0; p < branch.points.length; p++) {
            const px = branch.points[p].x * r;
            const py = branch.points[p].y * r;
            if (p === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    // Hit-flash — pale overlay across the body silhouette.
    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 40}, 100%, 95%, ${this.flashAmount * 0.32})`;
      this.traceBody(ctx);
      ctx.fill();
    }

    ctx.restore();
  }
}

export const spawnAlienAtEdge = (w: number, h: number, size: AlienSize, act: number = 1): Alien => {
  const edge = Math.floor(rng() * 4);
  let pos: Vec;
  let target: Vec;
  // Aim toward a point somewhere in the OPPOSITE half of the field so the
  // alien actually crosses the screen instead of clipping a corner and
  // leaving from the same edge it came in. Target position is randomized
  // within that opposite half so paths still vary.
  if (edge === 0) {
    pos = v(rand(0, w), -40);
    target = v(rand(0, w), rand(h * 0.55, h * 0.95));
  } else if (edge === 1) {
    pos = v(w + 40, rand(0, h));
    target = v(rand(w * 0.05, w * 0.45), rand(0, h));
  } else if (edge === 2) {
    pos = v(rand(0, w), h + 40);
    target = v(rand(0, w), rand(h * 0.05, h * 0.45));
  } else {
    pos = v(-40, rand(0, h));
    target = v(rand(w * 0.55, w * 0.95), rand(0, h));
  }
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const norm = Math.hypot(dx, dy);
  const [smin, smax] = SIZE_SPEED[size];
  const speed = rand(smin, smax);
  const alien = new Alien(pos, v((dx / norm) * speed, (dy / norm) * speed), size, act);
  // Let it cross the full screen and clear the far edge before despawning. The
  // diagonal is the worst-case crossing (corner to corner); the pad covers the
  // sprite extent + the weave/arc lengthening the path. See Alien.update.
  alien.maxTravel = Math.hypot(w, h) * 1.2;
  return alien;
};
