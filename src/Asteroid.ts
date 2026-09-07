import { Vec, v, fromAngle, rand, cosmeticRand, TAU, addScaledMut, wrapMut, toroidalDelta, nearestImageOf, WORLD_W, WORLD_H } from "./vec";
import { completeEntrance, foldWithEntrance } from "./game/entrance";
import { Trail } from "./Trail";
import { SoundwaveRadiator } from "./SoundwaveRadiator";
import { rng, cosmeticRng } from "./game/rng";
import { ENTITY_CONFIG, ENTITY_STATS, entityStat } from "./game/entityConfig";
import { SHIP_BODY_RADIUS, SHIP_HALO_OFFSET, SHIP_NOSE_MUL, SHIP_WING_ANGLE } from "./ship/shipHitbox";
import { PRONG_ANGLE_STEP, BULLET_VEL_INHERIT } from "./ship/shipWeapons";
import { drawGlow } from "./glow";

const HUE_PALETTE = [185, 200, 220, 250, 280, 310, 330];

// Combo-halo state shared from the ship each frame. `super` is the overdrive
// ramp (0→1 above rhythm 12) that brightens the halo past the tier-3 ceiling.
export type ComboHalo = { intensity: number; beatPulse: number; super: number };

// Cap on how far the boss laser aim can rotate per windup beat, so a circling
// player can outrun the sweep instead of being snapped onto.
const MAX_AIM_TURN_PER_BEAT = 0.32;
// Time constant for easing the displayed aim toward the committed aim, so the
// line slews smoothly across the discrete per-beat steps (~150ms to close).
const AIM_DISPLAY_TAU = 0.07;

// Boss laser timing, as phase offsets within the 8.0s rhythm cycle.
// The aim windup ticks the sightline onto the player across LASER_AIM_START..
// LASER_AIM_END (beats 4..7); the aim then holds. After a beat of hold the
// pre-fire wind-up surge runs across the final 3 beats up to LASER_FIRE_T,
// escalating the eye's charge glow so the shot is heavily telegraphed.
const LASER_AIM_START = 1.5;
const LASER_AIM_END = 3.5;
// Fire moved 4 beats later than the old beat-8 (t=3.5) shot: now beat 12.
const LASER_FIRE_T = 5.5;
// The wind-up surge covers the 3 beats immediately before the fire.
const LASER_WINDUP_START = LASER_FIRE_T - 1.5;

// Lazy-init so the first cursor pick comes from the seeded RNG (after startGame
// calls seedRng) rather than module-load Math.random — replays would diverge.
let huePaletteCursor = -1;
export const nextWaveHue = (): number => {
  if (huePaletteCursor < 0) huePaletteCursor = Math.floor(rng() * HUE_PALETTE.length);
  huePaletteCursor = (huePaletteCursor + 1 + Math.floor(rng() * (HUE_PALETTE.length - 1))) % HUE_PALETTE.length;
  return HUE_PALETTE[huePaletteCursor];
};

export const resetHuePaletteCursor = (): void => { huePaletteCursor = -1; };

type Harmonic = { amp: number; freq: number; phase: number };

type Nucleus = {
  angle: number;
  dist: number;
  size: number;
  pulsePhase: number;
  pulseSpeed: number;
};

export type AsteroidSize = "huge" | "large" | "medium" | "small";

// "bassA" / "bassB" / "bassC" / "bassD" are the four layered bassteroid
// kinds — one per beat slot in a 4-beat measure (4 beats × 0.5s = 2s at
// 120 BPM). Their gen-0 offsets stagger them: A→beat1, B→beat2, C→beat3,
// D→beat4. Each kind has its own distinct percussive sound (kick / pluck /
// boom / snap, all in or around C major) so multiple kinds layered on a
// beat still harmonise.
//
// Unlike organic asteroids, bassteroids are armoured: a large piece has 4 HP
// and takes that many hits before exploding, each hit leaving visible
// crack damage. On the final hit it splits into two medium pieces
// (2 HP each) that share the parent's kind but sit half a measure apart —
// gen-1 bassA fires beats 1+3, gen-1 bassB fires 2+4, gen-1 bassC fires
// 3+1, gen-1 bassD fires 4+2. Splitting again subdivides further into
// quarter-measure offsets: four gen-2 small pieces (1 HP each) cover all
// four beats with the parent kind's voice. Every bassteroid hit also
// triggers a deeper bass-echo overlay sound on top of the regular hit.
//
// "chime", "bell", "warble" are sound-decorator asteroids that behave exactly
// like normal ones but trigger a distinctive musical hit sound.
//
// "asteroidWithGem" looks like a normal large asteroid except a faintly visible
// gold crystal is embedded inside it (blurred, low-contrast — the player has
// to *notice* it). Killing it drops a collectible Gem where the rock
// was, plus an off-balanced fragment recipe (3 small OR 1 small + 1 medium).
// Always spawned at large size; doesn't survive past a single kill.
//
// "solidCrystal" is a tough, fully-faceted ice-blue crystal asteroid — 16 HP
// (4× a normal large), no embedded gold tease, the whole rock IS the crystal.
// On death it drops 1–3 collectible Gems AND splits into 4 fast-moving
// "solidCrystalSmall" fragments (4 HP each, no further split).
//
// "solidCrystalSmall" also spawns standalone as a rare "treat" — a tough
// 4 HP shard that pays out solidCrystal.smallScore on the killing hit. Same
// sprite + shatter sound as a parent-spawned fragment, no further split.
//
// "burstGemMedium" / "burstGemBig" are heavy, chunky solid-gold diamonds — the
// whole rock IS a cut gold gem (8 HP, no embedded tease). On death the gem
// bursts into a fan of fast-flying collectible Gems (4 for medium, 8 for big)
// thrown out from the kill, rotated off the killing-shot axis so none flies
// straight back at the shooter. The burst gem itself drops nothing; each flung
// Gem is the reward (fly into one and you die; shoot it on-beat for points or
// an upgrade). See isBurstGem() — most call sites test the family, not the tier.
//
// Boss fragment kinds (level 10 culmination). The "boss" kind is the
// whole-body planetoid; it splits into two `bossHemisphere` halves + one
// `bossEye` core. Hemispheres further split into `bossPlate` shards (the
// modular ring panels they wore); the eye further splits into
// `bossIrisShard` slivers + a single inert `bossEmber` pupil.

// "sepulchre" / "pallbearer" are the level-20 culmination — the Act II answer
// to the level-10 planetoid. Where the boss is one body with one eye and one
// line to dodge, the Sepulchre is a formation: a violet cathedral tomb of the
// same stone the whole act has been shedding, carried by four Pallbearers on a
// slow ring around it. Each bearer holds one beat of the measure, tolls the
// knell on it, and fires down its own bearing, so the pressure arrives from
// four directions on four beats. Each also phases (a longer, staggered cousin
// of the citadel's cycle), so the bearer you may shoot is whichever is
// currently solid. The tomb's own armour is the bier: every living bearer
// stacks ENTITY_CONFIG.sepulchre.shellArmourPerBearer onto its shell, so it
// shrugs off everything until the bier is broken and softens a step per bearer
// that falls. With the last one gone the tethers snap, the shutter over its
// reliquary grinds open, and it takes all four beats itself. Killing it
// scatters the cathedral debris the player has been shooting since level 11.
//
// "glassPrison" is the post-boss horror: a cut black diamond, faceted and
// near-lightless, with faint red eyes glowing from somewhere inside. Drifts
// in starting display-level 11; one hit shatters it — the single wraith
// inside escapes screaming, and the shell's own shards fan out as debris.
// "bigGlassPrison" is the rare oversized cousin (display-level 14+): the same
// shell at roughly double the radius, 2 HP so it cracks before it breaks, and
// a brood of 2-4 wraiths inside instead of one. Both share every paint path.
//
// "wraith" is what crawls out. It has no baked sprite (drawn live every frame
// from drifting noise layers and writhing tendrils). It fights at two ranges:
// far away it stalks — steering for a standoff point behind the ship's tail
// and swirling around to get there, so it works to sit where you aren't
// looking; up close it strikes — a braking windup telegraph, then a lunge on
// a direction locked at ignition (dodgeable), then a limp recovery window
// that is the player's opening to kill it. See tickWraith.
// "torus" is a mechanical ring (display-level 11+). The killing hit cleaves it
// into two "torusArc" C-shaped half-rings that keep orbiting a shared centre
// with the donut gap intact; each half-ring later breaks into one shorter
// torusArc sliver + a couple of terminal "torusChunk" debris bits. Every
// fragment of one torus shares a TorusGroup (the phantom rotating ring) and
// holds a fixed angular slot on it, so the pieces look like they're still
// trying to reassemble into one ring. A flickering energy arc strings the
// surviving fragments together around the ring. See split() / tickTorusGroup.
//
// "citadel" is the warble's massive fortress cousin (display-level 11-19). A
// slowly-rotating armoured shell with a ship-shaped escape hole through the
// middle (always safe for the ship). It rides a much longer phase cycle than
// the warble — solid for 16 beats, out of phase for 16 — and its outer shell
// deflects all but the heaviest shots. The intended kill: drift into the hole
// while it's phased out and shoot the unarmoured inner wall from inside (see
// citadelInnerHit). Breaking it releases the warbles it was built from.
//
// "metalChunk" is a dense tungsten ingot — a medium-sized, extremely heavy cube
// behind damageReduction 8 (only a drift-tier-2+ shot or the super laser bites
// through). Its 8 HP shatters it into 4 slow "metalShard" cubes, each 1 HP but
// still behind the same DR 8 armour, so the fragments are as tough to punch
// through as the parent — a lingering field of stubborn scrap.
// Rare across display-levels 5-9, then a common obstacle afterwards.
export type AsteroidKind = "normal" | "bassA" | "bassB" | "bassC" | "bassD" | "chime" | "bell" | "warble" | "citadel" | "boss" | "bossHemisphere" | "bossEye" | "bossPlate" | "bossIrisShard" | "bossEmber" | "sepulchre" | "pallbearer" | "asteroidWithGem" | "burstGemMedium" | "burstGemBig" | "solidCrystal" | "solidCrystalSmall" | "glassPrison" | "bigGlassPrison" | "wraith" | "cathedralKeystone" | "glassShard" | "columnDrum" | "rubbleBlock" | "torus" | "torusArc" | "torusChunk" | "metalChunk" | "metalShard";

// The two phased kinds share the warble opacity/solid state machine, the
// blurred-ghost render path and the phase drone; they differ in cycle length
// (bassClock drives both) and the citadel's armour + escape hole.
export const isPhasedKind = (kind: AsteroidKind): boolean =>
  kind === "warble" || kind === "citadel" || kind === "pallbearer";

// How much of the parent ring a warble kept, by size. A warble IS a piece of a
// citadel, so it's shaped like one: a curved stretch of the fortress's outer
// shell closed by two straight fracture faces running back to a blunt apex — a
// pie slice, not a lump. A large one is a literal third of the ring; the pieces
// it breaks into keep a narrower slice each, so a small warble reads as a chip
// off a chunk rather than a shrunken copy of the whole. Narrower also means
// flatter: at 60° the outer arc only bulges 13% of its own radius, which is
// exactly how a fragment-of-a-fragment should read.
const WARBLE_WEDGE_SPAN: Record<AsteroidSize, number> = {
  huge: TAU / 3,
  large: TAU / 3,
  medium: TAU * 0.25,
  small: TAU * 0.17,
};

// The citadel's escape hole: the ship's visible triangle (hull + halo, nose
// along local +x) scaled up by holeScale. Built once — every citadel wears the
// same hole, rotated with its body.
const CITADEL_HOLE_VERTS: ReadonlyArray<Vec> = (() => {
  const scale = ENTITY_CONFIG.citadel.holeScale;
  const nose = (SHIP_BODY_RADIUS * SHIP_NOSE_MUL + SHIP_HALO_OFFSET) * scale;
  const wing = (SHIP_BODY_RADIUS + SHIP_HALO_OFFSET) * scale;
  return [
    v(nose, 0),
    v(Math.cos(SHIP_WING_ANGLE) * wing, Math.sin(SHIP_WING_ANGLE) * wing),
    v(Math.cos(-SHIP_WING_ANGLE) * wing, Math.sin(-SHIP_WING_ANGLE) * wing),
  ];
})();

// Append the escape-hole triangle to the current path. `pos`/`rotation`
// place it in world space; omit both when already in citadel-local space.
// Callers own beginPath so the hole can join evenodd fills and clips.
export const traceCitadelHolePath = (ctx: CanvasRenderingContext2D, pos?: Vec, rotation = 0) => {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const px = pos?.x ?? 0;
  const py = pos?.y ?? 0;
  for (let i = 0; i < CITADEL_HOLE_VERTS.length; i++) {
    const p = CITADEL_HOLE_VERTS[i];
    const x = px + p.x * cos - p.y * sin;
    const y = py + p.x * sin + p.y * cos;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
};

// Worst-case reach of the ship's collision silhouette in any direction —
// the nose halo plus the collision pads, mirroring Ship.hitRadius without
// needing a live Ship. Used by the citadel break-up to place its fragments
// outside anything the hull could possibly be touching.
const SHIP_CLEAR_RADIUS = SHIP_BODY_RADIUS * SHIP_NOSE_MUL + SHIP_HALO_OFFSET + 10;

// Same-side sign test against each edge; works for either winding.
const pointInTriangle = (px: number, py: number, tri: ReadonlyArray<Vec>): boolean => {
  const [a, b, c] = tri;
  const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
  const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
  const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
};

// The three ring-fragment kinds that orbit a shared TorusGroup. "torus" (the
// whole ring) isn't a fragment — it spawns standalone and creates the group
// only when it splits.
export const isTorusFragment = (kind: AsteroidKind): boolean =>
  kind === "torusArc" || kind === "torusChunk";

// The two gold-gem tiers share nearly all behaviour (painting, HP, kill bucket,
// clamp); they differ only in radius and shard count. Most call sites test the
// family rather than the exact tier.
export const isBurstGem = (kind: AsteroidKind): boolean => kind === "burstGemMedium" || kind === "burstGemBig";

// The two prison tiers share the shell material, the diamond silhouette, the
// captive-eye glow and the shatters-into-wraiths split; they differ only in
// radius, HP, score and how many wraiths come out. Nearly every call site
// tests the family rather than the tier.
export const isGlassPrison = (kind: AsteroidKind): boolean => kind === "glassPrison" || kind === "bigGlassPrison";

// Anything cut as a true rhombus silhouette (diamondProfile) rather than the
// harmonic-noise outline — burst gems and the black-diamond prison shells.
export const isDiamondCut = (kind: AsteroidKind): boolean => isBurstGem(kind) || isGlassPrison(kind);

// The two hull-metal tiers share the plate material, DR 8 armour, and the
// opaque steel render; they differ only in size and whether they split further.
export const isMetalHull = (kind: AsteroidKind): boolean => kind === "metalChunk" || kind === "metalShard";

// The cathedral ("bell") asteroid rolls one of these archetypes at spawn. Each
// reads as a different fragment of a civilization's basilica carved out of the
// asteroid belt — its own silhouette harmonics + its own carved-into-rock
// interior painter, all sharing the weathered-stone frame. See
// `paintCathedralFragmentBody`, which dispatches on this.
export type CathedralArchetype = "lancetWall" | "roseFacade" | "spireTower" | "arcade" | "buttressRuin";
const CATHEDRAL_ARCHETYPES: ReadonlyArray<CathedralArchetype> = ["lancetWall", "roseFacade", "spireTower", "arcade", "buttressRuin"];
// Terminal small kinds a cathedral asteroid shatters into — carved debris that
// makes conceptual sense as broken building pieces (cf. how bassteroids break
// into recognisable ship chunks). None of these split further.
const CATHEDRAL_DEBRIS_KINDS: ReadonlyArray<AsteroidKind> = ["cathedralKeystone", "glassShard", "columnDrum", "rubbleBlock"];

export const BASS_KINDS: ReadonlyArray<"bassA" | "bassB" | "bassC" | "bassD"> = ["bassA", "bassB", "bassC", "bassD"];

const SIZE_RADIUS = ENTITY_CONFIG.asteroid.radius;

// The boss asteroid is the first end-of-arc fight: a cratered planetoid that
// solidifies out of the looming background planet on wave 10. It's roughly
// 3× the diameter of a large asteroid, splits into 3 medium children, and
// each medium splits into 3 smalls (smalls don't split). The per-size radius
// ladder lives on the boss entity entry; alias it as a concrete record so the
// boss geometry code can index it directly (.large / .small * 0.85 etc.).
export const BOSS_RADIUS = ENTITY_STATS.boss!.radius as Record<AsteroidSize, number>;

export const SIZE_SPAWN_SPEED = ENTITY_CONFIG.asteroid.spawnSpeed;

const splitChildSpeed = (parentVel: Vec, childSize: AsteroidSize): number => {
  const parentSpeed = Math.hypot(parentVel.x, parentVel.y);
  if (childSize === "medium") return parentSpeed * rand(1.2, 1.7) + 40;
  return parentSpeed * rand(1.15, 1.65) + 40;
};

// Rhythm gate for the fastest terminal shards (solidCrystal smalls, gen-2
// bassteroid pieces). These deliberately fly faster than a momentum-conserving
// fragment to challenge the player — but only once they've earned enough
// rhythm. Below this combo the shards are throttled to a calmer drift.
const FAST_SHARD_RHYTHM = 4;
// Multiplier applied to the shard's burst speed while under FAST_SHARD_RHYTHM.
const SLOW_SHARD_MUL = 0.25;
const fastShardSpeedMul = (combo: number | undefined): number =>
  (combo ?? 0) >= FAST_SHARD_RHYTHM ? 1 : SLOW_SHARD_MUL;

// Length of one musical measure (seconds). 4 beats at 120 BPM × 0.5s/beat.
// Every bassteroid fires exactly once per measure regardless of split
// generation; what changes with splitting is which beat-slot in the measure
// each piece occupies (see `split()` below).
export const BASS_MEASURE_LENGTH = 2.0;

// Wraith strikes ignite on this grid (a half measure) so a close-quarters fight
// stays inside the music instead of firing at arbitrary wall-clock moments.
const WRAITH_STRIKE_GRID = BASS_MEASURE_LENGTH / 2;

// Within-measure offset (seconds) for a freshly-spawned gen-0 asteroid of
// each kind. Each kind sits on its own beat slot so the four interlock into
// a kick-pluck-kick-pluck pattern when all four are on the field.
export const BASS_KIND_BASE_OFFSET: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
  bassA: 0.0,
  bassB: 0.5,
  bassC: 1.0,
  bassD: 1.5,
};

// Maximum number of times a bassteroid can be split. 0 = gen-0 (large, 4 HP),
// 1 = gen-1 (medium, 2 HP), 2 = gen-2 (small, 1 HP, terminal). Two splits
// stops the subdivision at quarter-notes, which is the densest pattern that
// still reads as rhythm rather than mush.
export const BASS_MAX_SPLIT_LEVEL = 2;

// Combo-halo gap: the halo outline floats this many pixels outside the hull,
// uniform along every edge and across every bassteroid size (a center-scale
// multiplier would push long hull extremities much further out than the
// flanks, and would scale the gap with the rock).
const BASS_HALO_GAP_PX = 8;

// Shared state for all fragments that came from one torus. The fragments don't
// fly apart on momentum like normal debris — they hold fixed angular slots on a
// phantom ring centred at `center` that slowly rotates (`phase`) and drifts with
// `vel`, so the broken pieces read as "still trying to be one ring". One group
// is created at the first split and inherited by every later fragment. Dead
// members are pruned each tick (see tickTorusGroup); when none remain the group
// is simply garbage-collected with its last fragment.
export type TorusGroup = {
  // Drifting centre of the phantom ring (world coords) + its inherited velocity.
  center: Vec;
  vel: Vec;
  // Radius of the phantom ring the fragment centroids ride on, and its current
  // rotation (radians) advanced by `spin` each second.
  ringRadius: number;
  phase: number;
  spin: number;
  // Hue carried so the connecting energy arcs match the ring's steel-cyan.
  hue: number;
  // Live members. Repopulated each split; pruned to the living set each tick.
  members: Asteroid[];
};

// Vertex list (local-space, normalised to radius=1) for one armoured panel
// of a bassteroid. Each kind is a fixed cluster of these panels — drawn with
// hard edges and bright outlines so they read as built-by-hand spaceships
// rather than the organic Fourier blobs everything else uses.
type BassModule = { vertices: Vec[] };

// Per-kind hard-points: little glowing dots painted on top of the panels.
// Treated as "running lights" so each kind has a memorable silhouette even
// when crack damage has gnawed at the panel outlines.
type BassLight = { pos: Vec; size: number };

type BassShip = { modules: BassModule[]; lights: BassLight[] };

const rect = (x1: number, y1: number, x2: number, y2: number): BassModule => ({
  vertices: [v(x1, y1), v(x2, y1), v(x2, y2), v(x1, y2)],
});

const hexagon = (cx: number, cy: number, r: number, rot = 0): BassModule => {
  const verts: Vec[] = [];
  for (let i = 0; i < 6; i++) {
    const a = rot + (i / 6) * TAU;
    verts.push(v(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return { vertices: verts };
};

// Each kind is hand-tuned to look distinct at a glance — silhouettes are
// the primary identifier since hues blend together under additive blending.
//   bassA: "Hauler"     — long horizontal hull + side pods, cockpit on right
//   bassB: "Tri-cluster"— three hex pods around a central hub
//   bassC: "Cross"      — square core with four cardinal arms
//   bassD: "Tower"      — vertical stack (engine block, tank, cockpit cone)
// Coordinates are in radius-units; the renderer scales by this.radius.
const buildBassteroidShape = (kind: "bassA" | "bassB" | "bassC" | "bassD"): BassShip => {
  if (kind === "bassA") {
    return {
      modules: [
        rect(-0.85, -0.28, 0.55, 0.28),
        { vertices: [v(0.55, -0.28), v(0.98, 0), v(0.55, 0.28)] },
        rect(-0.55, -0.68, 0.25, -0.32),
        rect(-0.55, 0.32, 0.25, 0.68),
        { vertices: [v(-0.85, -0.22), v(-1.02, -0.08), v(-1.02, 0.08), v(-0.85, 0.22)] },
      ],
      lights: [
        { pos: v(0.7, 0), size: 0.06 },
        { pos: v(-0.15, -0.5), size: 0.05 },
        { pos: v(-0.15, 0.5), size: 0.05 },
        { pos: v(-0.95, 0), size: 0.07 },
      ],
    };
  }
  if (kind === "bassB") {
    const podRadius = 0.34;
    return {
      modules: [
        hexagon(0, -0.5, podRadius),
        hexagon(-0.46, 0.28, podRadius),
        hexagon(0.46, 0.28, podRadius),
        hexagon(0, 0, 0.18),
        rect(-0.04, -0.45, 0.04, -0.16),
        rect(-0.42, 0.25, -0.16, 0.13),
        rect(0.16, 0.13, 0.42, 0.25),
      ],
      lights: [
        { pos: v(0, -0.5), size: 0.06 },
        { pos: v(-0.46, 0.28), size: 0.06 },
        { pos: v(0.46, 0.28), size: 0.06 },
        { pos: v(0, 0), size: 0.05 },
      ],
    };
  }
  if (kind === "bassC") {
    return {
      modules: [
        rect(-0.32, -0.32, 0.32, 0.32),
        rect(-0.14, -0.96, 0.14, -0.32),
        rect(-0.14, 0.32, 0.14, 0.96),
        rect(0.32, -0.14, 0.96, 0.14),
        rect(-0.96, -0.14, -0.32, 0.14),
      ],
      lights: [
        { pos: v(0, -0.92), size: 0.06 },
        { pos: v(0, 0.92), size: 0.06 },
        { pos: v(0.92, 0), size: 0.06 },
        { pos: v(-0.92, 0), size: 0.06 },
        { pos: v(0, 0), size: 0.07 },
      ],
    };
  }
  // Tower is a gothic comms-spire, read top→bottom: a faceted crown beacon, a
  // tapering twin-step shaft (narrow neck over a wider mast), a flared buttress
  // base, and two angled outrigger fins braced off the mast. The stepped taper
  // gives a ziggurat-spire profile instead of a plain box stack; the fins add
  // the cross-bracing read of a transmission mast. Split-tree indices below
  // depend on this order: 0 crown, 1 neck, 2 mast, 3 base, 4/5 fins.
  return {
    modules: [
      { vertices: [v(-0.18, -0.5), v(0, -0.98), v(0.18, -0.5), v(0.1, -0.36), v(-0.1, -0.36)] },
      { vertices: [v(-0.16, -0.5), v(0.16, -0.5), v(0.26, -0.04), v(-0.26, -0.04)] },
      { vertices: [v(-0.3, -0.04), v(0.3, -0.04), v(0.42, 0.5), v(-0.42, 0.5)] },
      { vertices: [v(-0.5, 0.5), v(0.5, 0.5), v(0.66, 0.98), v(-0.66, 0.98)] },
      { vertices: [v(-0.3, 0.04), v(-0.78, 0.2), v(-0.6, 0.46), v(-0.36, 0.36)] },
      { vertices: [v(0.3, 0.04), v(0.78, 0.2), v(0.6, 0.46), v(0.36, 0.36)] },
    ],
    lights: [
      { pos: v(0, -0.64), size: 0.07 },
      { pos: v(-0.2, 0.16), size: 0.05 },
      { pos: v(0.2, 0.16), size: 0.05 },
      { pos: v(0, 0.78), size: 0.06 },
    ],
  };
};

// ── Deterministic fragmentation ──────────────────────────────────────────
// A bassteroid breaks the same way every time: a hand-authored fragment tree
// per kind, not a random projection-axis slice. This buys two things the old
// random partition couldn't:
//   1. The full set of split-child shapes is finite and known at build time,
//      so prewarmHaloOutlines() can bake every combo-halo outline before the
//      game starts — nothing computes during a frame, ever.
//   2. The smallest pieces are authored to be single connected blobs (every
//      module in a leaf shares an edge with another, with hand-placed "sliver"
//      quads bridging any appendage that only touched the now-absent core), so
//      a terminal small never reads as "two pieces you could still split".
//
// Fragments are authored in the ORIGINAL LARGE's local frame (radius=1); the
// child inherits its parent's exact sub-geometry rather than a re-derived one,
// so a medium and the small carved from it line up. normalizeFragment() then
// recentres + rescales to the child's own radius=1 footprint.
const moduleCentroid = (m: BassModule): Vec => {
  let sx = 0;
  let sy = 0;
  for (const p of m.vertices) {
    sx += p.x;
    sy += p.y;
  }
  return v(sx / m.vertices.length, sy / m.vertices.length);
};

type BassFragment = { modules: BassModule[]; lights: BassLight[] };
// One kind's tree: two mediums, each carving into two terminal smalls.
type BassSplitTree = { mediums: { fragment: BassFragment; smalls: [BassFragment, BassFragment] }[] };

// Recentre a fragment's vertices on its own centroid and rescale so its max
// vertex radius is 1 — the existing `vertex * this.radius` render pipeline then
// lands it at the child tier's footprint. Lights ride along with the same
// transform. (Same math the old random partition used, factored out.)
const normalizeFragment = (frag: BassFragment): BassShip => {
  if (frag.modules.length === 0) return { modules: [], lights: [] };
  let gx = 0;
  let gy = 0;
  let n = 0;
  for (const m of frag.modules) {
    const c = moduleCentroid(m);
    gx += c.x;
    gy += c.y;
    n++;
  }
  gx /= n;
  gy /= n;
  let maxR = 0;
  for (const m of frag.modules) {
    for (const p of m.vertices) {
      const r = Math.hypot(p.x - gx, p.y - gy);
      if (r > maxR) maxR = r;
    }
  }
  const scale = maxR > 0 ? 1 / maxR : 1;
  return {
    modules: frag.modules.map(m => ({ vertices: m.vertices.map(p => v((p.x - gx) * scale, (p.y - gy) * scale)) })),
    lights: frag.lights.map(l => ({ pos: v((l.pos.x - gx) * scale, (l.pos.y - gy) * scale), size: l.size * scale })),
  };
};

// Pull a subset of a kind's hand-built modules/lights by index, optionally with
// extra authored modules (the bridging "slivers"). Keeps the authoring tables
// terse: most fragments are just "modules 0,2,4 plus this one quad".
const frag = (kind: "bassA" | "bassB" | "bassC" | "bassD", moduleIdx: number[], lightIdx: number[], extra: BassModule[] = []): BassFragment => {
  const ship = buildBassteroidShape(kind);
  return {
    modules: [...moduleIdx.map(i => ship.modules[i]), ...extra],
    lights: lightIdx.map(i => ship.lights[i]),
  };
};

// Authored split trees. Module/light indices reference buildBassteroidShape().
// `extra` quads are sliver bridges so a leaf with an orphaned appendage still
// reads as one solid piece. See each kind's silhouette comment above.
const BASS_SPLIT_TREES: Record<"bassA" | "bassB" | "bassC" | "bassD", BassSplitTree> = {
  // Hauler: hull(0) is the spine; split fore/aft. Each pod pairs with a hull
  // sliver under it (slivers overrun the pod inner edge so there's no seam).
  bassA: {
    mediums: [
      {
        fragment: frag("bassA", [1], [0], [rect(-0.15, -0.28, 0.55, 0.28)]),
        smalls: [
          frag("bassA", [1], [0], [rect(0.2, -0.2, 0.55, 0.2)]),
          frag("bassA", [], [], [rect(-0.15, -0.28, 0.3, 0.28)]),
        ],
      },
      {
        fragment: frag("bassA", [2, 3, 4], [1, 2, 3], [rect(-0.85, -0.34, -0.15, 0.34)]),
        smalls: [
          frag("bassA", [2], [1], [rect(-0.55, -0.34, 0.25, -0.05)]),
          frag("bassA", [3, 4], [2, 3], [rect(-0.85, -0.05, -0.15, 0.34)]),
        ],
      },
    ],
  },
  // Tri-cluster: hub(3) + struts(4,5,6) join the three hex pods(0,1,2). Top pod
  // vs the two lower pods. The lower-pod medium carries a center bridge so its
  // two strut+pod arms stay joined once the hub is gone.
  bassB: {
    mediums: [
      {
        fragment: frag("bassB", [0, 3, 4], [0, 3]),
        smalls: [frag("bassB", [0, 4], [0]), frag("bassB", [3], [3])],
      },
      {
        fragment: frag("bassB", [1, 2, 5, 6], [1, 2], [rect(-0.16, 0.13, 0.16, 0.25)]),
        smalls: [frag("bassB", [1, 5], [1]), frag("bassB", [2, 6], [2])],
      },
    ],
  },
  // Cross: core(0) + four arms. Split into (top+left) and (bottom+right); each
  // arm keeps a half-core sliver so the broken mount stays attached.
  bassC: {
    mediums: [
      {
        fragment: frag("bassC", [1, 4], [1, 3], [rect(-0.32, -0.32, 0.0, 0.32), rect(-0.14, -0.32, 0.14, 0.0)]),
        smalls: [
          frag("bassC", [1], [1], [rect(-0.14, -0.32, 0.14, 0.0)]),
          frag("bassC", [4], [3], [rect(-0.32, -0.14, 0.0, 0.14)]),
        ],
      },
      {
        fragment: frag("bassC", [2, 3], [0, 2], [rect(0.0, -0.32, 0.32, 0.32), rect(-0.14, 0.0, 0.14, 0.32)]),
        smalls: [
          frag("bassC", [2], [0], [rect(-0.14, 0.0, 0.14, 0.32)]),
          frag("bassC", [3], [2], [rect(0.0, -0.14, 0.32, 0.14)]),
        ],
      },
    ],
  },
  // Tower: gothic spire — crown(0) / neck(1) / mast(2) / base(3), fins(4,5)
  // bolt onto the mast. Split crown+neck (the spire) vs mast+base+fins (the
  // body), so the fins ride with the mast they actually touch. The spire
  // medium carries a sliver bridging the neck stub to the crown.
  bassD: {
    mediums: [
      {
        fragment: frag("bassD", [0, 1], [0], [rect(-0.16, -0.5, 0.16, -0.2)]),
        smalls: [frag("bassD", [0], [0]), frag("bassD", [1], [], [rect(-0.16, -0.5, 0.16, -0.2)])],
      },
      {
        fragment: frag("bassD", [2, 3, 4, 5], [1, 2, 3]),
        smalls: [frag("bassD", [2, 4, 5], [1, 2]), frag("bassD", [3], [3])],
      },
    ],
  },
};

// Build a simplified closed silhouette from a BassShip — the outer hull of
// all module vertices, resampled at fixed angular intervals around the
// centroid. Used by SoundwaveRadiator: a wave that wears the actual chunk's
// silhouette reads as "the broken piece is singing" rather than a generic
// ring. Returned in radius-units (caller scales by this.radius).
//
// Algorithm:
//   1. Gather every module vertex.
//   2. For each of N angular bins around (0,0), keep the farthest vertex
//      whose angle falls in that bin. This is a polar-max sweep — cheaper
//      than a true convex hull, and gives a slightly puffier outline that
//      reads as "the body" rather than "the exact edge of the body".
//   3. Bins with no contributors fall back to interpolation between their
//      filled neighbours so the curve is C0-continuous.
// Result: a 28-sample closed polygon, each sample = (angle, radius_norm).
// The renderer reconstructs xy by (cos a * r, sin a * r) * scaleRadius.
export type SilhouetteSample = { ax: number; ay: number; r: number };
export const buildBassSilhouette = (ship: BassShip, samples = 28): SilhouetteSample[] => {
  const bins: number[] = new Array(samples).fill(0);
  for (const m of ship.modules) {
    for (const p of m.vertices) {
      const r = Math.hypot(p.x, p.y);
      if (r <= 0) continue;
      let a = Math.atan2(p.y, p.x);
      if (a < 0) a += TAU;
      const idx = Math.min(samples - 1, Math.floor((a / TAU) * samples));
      if (r > bins[idx]) bins[idx] = r;
    }
  }
  // Fill any empty bins by linear interpolation from the nearest filled
  // neighbours on either side. If everything is empty (defensive), fall
  // back to a unit circle so the radiator still draws something.
  let anyFilled = false;
  for (const b of bins) if (b > 0) { anyFilled = true; break; }
  if (!anyFilled) {
    for (let i = 0; i < samples; i++) bins[i] = 1;
  } else {
    for (let i = 0; i < samples; i++) {
      if (bins[i] > 0) continue;
      let left = -1, right = -1;
      for (let k = 1; k <= samples; k++) {
        const li = (i - k + samples) % samples;
        if (bins[li] > 0) { left = li; break; }
      }
      for (let k = 1; k <= samples; k++) {
        const ri = (i + k) % samples;
        if (bins[ri] > 0) { right = ri; break; }
      }
      if (left === right) { bins[i] = bins[left]; continue; }
      // Shortest signed distance from left → i and i → right (going around).
      const dL = (i - left + samples) % samples;
      const dR = (right - i + samples) % samples;
      const t = dL / (dL + dR);
      bins[i] = bins[left] * (1 - t) + bins[right] * t;
    }
  }
  // Light low-pass: average each bin with its neighbours so the outline
  // breathes smoothly instead of stepping per-bin (which would read as
  // a polygon, not a soundwave).
  const smoothed: number[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const prev = bins[(i - 1 + samples) % samples];
    const next = bins[(i + 1) % samples];
    smoothed[i] = (prev + bins[i] * 2 + next) * 0.25;
  }
  const out: SilhouetteSample[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * TAU;
    out[i] = { ax: Math.cos(a), ay: Math.sin(a), r: smoothed[i] };
  }
  return out;
};

// Pre-rolled local-space placements for crack damage. We generate one entry
// per HP — cracks reveal in order as hits land so the same bassteroid gives
// a consistent, escalating fracture pattern per playthrough. Each crack is
// a jagged poly-line through the impact point: `branches` are line segments
// fanning outward from local origin, all in radius-units.
type AsteroidCrack = {
  pos: Vec;
  size: number;
  angle: number;
  branches: { points: Vec[] }[];
};
// Crack-overlay geometry is purely visual — drawn on damage, read by nothing in
//   the sim. It also draws a VARIABLE number of values per asteroid (forkCount,
//   segments), so it must pull from the COSMETIC stream; on the gameplay stream
//   its count would shift every downstream gameplay draw and desync the replay.
const rollCracks = (count: number): AsteroidCrack[] => {
  const cracks: AsteroidCrack[] = [];
  for (let i = 0; i < count; i++) {
    const a = cosmeticRand(0, TAU);
    const r = cosmeticRand(0.2, 0.78);
    const size = cosmeticRand(0.28, 0.42);
    // 3–4 jagged forks per impact, each a short zig-zag polyline radiating
    // from the impact centre. Forks are stored in local crack-space; the
    // renderer translates+rotates them into the bassteroid's frame.
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
        const len = size * cosmeticRand(0.35, 0.7);
        ang += cosmeticRand(-0.7, 0.7);
        cx += Math.cos(ang) * len;
        cy += Math.sin(ang) * len;
        points.push(v(cx, cy));
      }
      branches.push({ points });
    }
    cracks.push({ pos: v(Math.cos(a) * r, Math.sin(a) * r), size, angle: cosmeticRand(0, TAU), branches });
  }
  return cracks;
};

// ── Combo-halo outline geometry ──────────────────────────────────────────
// The halo is the boundary of the *union* of a bassteroid's module polygons,
// each pushed outward by a constant pixel gap. Offsetting per-module and
// stroking them all (the old approach) drew the interior shared edges too,
// criss-crossing wherever modules overlapped. Here we offset each module
// (sharp mitered corners — a center-scale would drift, a disk Minkowski sum
// would round), then keep only the offset edges that lie outside every other
// inflated module, and chain the survivors into closed loops. Result: one
// outline hugging the true outer perimeter, sharp corners preserved.

type HPt = { x: number; y: number };

// Offset a CCW-or-CW polygon outward by gap, mitering each corner (intersect
// adjacent shifted edges). Returns vertices in the same winding as input.
const offsetPolygon = (pts: HPt[], gap: number): HPt[] => {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area > 0 ? 1 : -1; // outward-normal selector
  const dirs: HPt[] = [];
  const anchors: HPt[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    dirs.push(d);
    anchors.push({ x: a.x + sign * d.y * gap, y: a.y - sign * d.x * gap });
  }
  const out: HPt[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const cross = dirs[j].x * dirs[i].y - dirs[j].y * dirs[i].x;
    if (Math.abs(cross) < 1e-9) {
      out.push({ x: pts[i].x + sign * dirs[i].y * gap, y: pts[i].y - sign * dirs[i].x * gap });
      continue;
    }
    const dx = anchors[i].x - anchors[j].x;
    const dy = anchors[i].y - anchors[j].y;
    const t = (dx * dirs[i].y - dy * dirs[i].x) / cross;
    out.push({ x: anchors[j].x + dirs[j].x * t, y: anchors[j].y + dirs[j].y * t });
  }
  return out;
};

const pointInPolygon = (px: number, py: number, poly: HPt[]): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > py) !== (b.y > py)) {
      const x = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (px < x) inside = !inside;
    }
  }
  return inside;
};

// Outline of the union of several offset polygons. Each edge of each polygon
// is cut at every crossing with edges of the *other* polygons, then a sub-edge
// is kept iff its midpoint lies outside all other polygons. Kept sub-edges are
// chained head-to-tail into closed loops. Winding is normalized so every input
// polygon contributes outward-consistent edges.
const unionOutline = (polys: HPt[][]): HPt[][] => {
  // Normalize all to CCW so "outside-all-others" is winding-consistent.
  const ccw = polys.map((p) => {
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area < 0 ? [...p].reverse() : p;
  });

  const EPS = 1e-7;
  const kept: { a: HPt; b: HPt }[] = [];
  for (let pi = 0; pi < ccw.length; pi++) {
    const poly = ccw[pi];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      // Collect split parameters (t along a→b) from intersections with every
      // edge of every other polygon.
      const ts = [0, 1];
      for (let qi = 0; qi < ccw.length; qi++) {
        if (qi === pi) continue;
        const other = ccw[qi];
        for (let k = 0; k < other.length; k++) {
          const c = other[k], d = other[(k + 1) % other.length];
          const r = { x: b.x - a.x, y: b.y - a.y };
          const s = { x: d.x - c.x, y: d.y - c.y };
          const denom = r.x * s.y - r.y * s.x;
          if (Math.abs(denom) < 1e-12) continue;
          const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
          const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
          if (t > EPS && t < 1 - EPS && u > -EPS && u < 1 + EPS) ts.push(t);
        }
      }
      ts.sort((m, n) => m - n);
      for (let s = 0; s < ts.length - 1; s++) {
        const t0 = ts[s], t1 = ts[s + 1];
        if (t1 - t0 < EPS) continue;
        const mt = (t0 + t1) / 2;
        const mx = a.x + (b.x - a.x) * mt;
        const my = a.y + (b.y - a.y) * mt;
        let buried = false;
        for (let qi = 0; qi < ccw.length; qi++) {
          if (qi === pi) continue;
          if (pointInPolygon(mx, my, ccw[qi])) { buried = true; break; }
        }
        if (buried) continue;
        kept.push({
          a: { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
          b: { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
        });
      }
    }
  }

  // Chain kept segments into closed loops by snapping endpoints to a grid.
  const key = (p: HPt) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const adj = new Map<string, { seg: { a: HPt; b: HPt }; used: boolean }[]>();
  for (const seg of kept) {
    const ka = key(seg.a);
    if (!adj.has(ka)) adj.set(ka, []);
    adj.get(ka)!.push({ seg, used: false });
  }
  const loops: HPt[][] = [];
  const allEntries = [...adj.values()].flat();
  for (const start of allEntries) {
    if (start.used) continue;
    const loop: HPt[] = [];
    let cur: { seg: { a: HPt; b: HPt }; used: boolean } | undefined = start;
    let guard = 0;
    const startKey = key(start.seg.a);
    while (cur && !cur.used && guard++ < 10000) {
      cur.used = true;
      loop.push(cur.seg.a);
      const nextKey = key(cur.seg.b);
      if (nextKey === startKey) break;
      const candidates = adj.get(nextKey);
      cur = candidates?.find((c) => !c.used);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
};

// ── Halo-outline cache ───────────────────────────────────────────────────
// unionOutline is an O(edges²) clip + chain — cheap for one rock but a visible
// frame spike when several bassteroids ignite their combo halo on the same
// beat (e.g. the boss wave spawns one of every kind). The outline depends only
// on (module geometry, radius, gap), all fixed at construction, so we build it
// once per distinct shape and memoize. Because fragmentation is deterministic
// (see BASS_SPLIT_TREES), the complete shape set — every kind's large, mediums,
// and smalls — is known up front, so prewarmHaloOutlines() bakes all of them at
// module load and nothing ever computes during gameplay.
const haloOutlineCache = new Map<string, { x: number; y: number }[][]>();

const haloCacheKey = (ship: BassShip, radius: number, gapPx: number): string => {
  // Round to 0.001 unit so float jitter in inherited geometry still hits the
  // same key; radius+gap fold in because the offset is in pixels (gap doesn't
  // scale with radius), so the same modules at a different tier differ.
  let s = `${radius.toFixed(2)}|${gapPx}|`;
  for (const m of ship.modules) {
    for (const vt of m.vertices) s += `${Math.round(vt.x * 1000)},${Math.round(vt.y * 1000)};`;
    s += "/";
  }
  return s;
};

const computeHaloOutline = (ship: BassShip, radius: number, gapPx: number): { x: number; y: number }[][] => {
  const offset = ship.modules
    .filter((m) => m.vertices.length >= 3)
    .map((m) =>
      offsetPolygon(m.vertices.map((vt) => ({ x: vt.x * radius, y: vt.y * radius })), gapPx),
    );
  if (offset.length === 0) return [];
  if (offset.length === 1) return offset;
  return unionOutline(offset);
};

const getHaloOutline = (ship: BassShip, radius: number, gapPx: number): { x: number; y: number }[][] => {
  const key = haloCacheKey(ship, radius, gapPx);
  let cached = haloOutlineCache.get(key);
  if (!cached) {
    cached = computeHaloOutline(ship, radius, gapPx);
    haloOutlineCache.set(key, cached);
  }
  return cached;
};

// Warm the cache for EVERY bassteroid shape at module load — the gen-0 large,
// both gen-1 mediums, and all four gen-2 smalls of each kind — so the O(edges²)
// union-clip never runs during a frame, not even on a split-child's first
// render. The fragment trees are deterministic, so this is the complete set
// (4 kinds × 7 shapes = 28 outlines), all baked before the game starts.
const prewarmHaloOutlines = () => {
  for (const kind of BASS_KINDS) {
    getHaloOutline(buildBassteroidShape(kind), SIZE_RADIUS.large, BASS_HALO_GAP_PX);
    for (const m of BASS_SPLIT_TREES[kind].mediums) {
      getHaloOutline(normalizeFragment(m.fragment), SIZE_RADIUS.medium, BASS_HALO_GAP_PX);
      for (const s of m.smalls) {
        getHaloOutline(normalizeFragment(s), SIZE_RADIUS.small, BASS_HALO_GAP_PX);
      }
    }
  }
};
prewarmHaloOutlines();

export class Asteroid {
  pos: Vec;
  vel: Vec;
  size: AsteroidSize;
  radius: number;
  rotation: number;
  rotSpeed: number;
  hue: number;
  harmonics: Harmonic[];
  nuclei: Nucleus[];
  outline: number[];
  outlineSamples = 60;
  membranePhase: number;
  flashAmount = 0;
  // Entrance state — the arrival mirror of the warpT exit. See game/entrance.ts.
  entering = false;
  enterOffX = 0;
  enterOffY = 0;
  enterTraveled = 0;
  enterMinOvershoot = 0;
  // Pre-rendered offscreen sprite of the static body (halo, outline, interior,
  // filaments, baseline nucleus glow). Built once in the constructor. Per-frame
  // rendering is a single drawImage + a couple of cheap pulse/flash overlays.
  sprite: HTMLCanvasElement | null = null;
  spriteHalfSize = 0;
  kind: AsteroidKind;
  // For bass kinds, the within-measure beat slot (seconds) this piece
  // occupies. Always equal to `BASS_KIND_BASE_OFFSET[kind]` — split children
  // inherit the parent's slot rather than subdividing, so the beat each
  // kind plays never moves. Unused for non-bass kinds.
  measureOffset = 0;
  // Number of times this bassteroid has already been split. 0 = gen-0 large,
  // 1 = gen-1 medium (terminal — its final hit destroys it outright).
  // Always 0 for non-bass kinds.
  splitLevel = 0;
  // Which authored medium (0 or 1) of BASS_SPLIT_TREES[kind] this gen-1 piece
  // came from, so it carves into the matching pair of gen-2 smalls. -1 for a
  // gen-0 large (it picks the medium index at split time) and non-bass kinds.
  bassMediumIndex = -1;
  // Game-time (seconds) at which this bassteroid should fire its next
  // beat. Set by Game when the asteroid is spawned / split. Unused for
  // non-bass kinds.
  nextBeatAt = 0;
  // 0→1 progress through the current beat interval (0 just after a beat fires,
  // 1 the instant before the next). Updated each tick from beatTime in
  // bassClock; drives the halo shimmer and the pre-beat warm-up so the
  // anticipation animation can ramp without threading beatTime into render().
  beatPhase = 0;
  // Hitpoints. Every asteroid uses the HP/crack system now. Non-killing
  // bullet hits decrement `hp` and reveal one more entry in `cracks`; the
  // killing hit (hp → 0) explodes the asteroid (and splits it, for non-
  // terminal sizes). Bassteroids carry a 4× multiplier on top of the size
  // table — see `getMaxHp` / `BASS_HP`.
  hp = 0;
  maxHp = 0;
  // Flat amount subtracted from every incoming hit before it touches HP. A hit
  // whose raw damage doesn't exceed this is fully absorbed — no HP lost, no
  // crack, the shot bounces off. Solid crystals set this; 0 for everything else.
  damageReduction = 0;
  // True once a bullet has glanced off this rock's armour and we've shown the
  // "Insufficient damage" tip for it — so the hint fires at most once per rock.
  glanceTipShown = false;
  // Same, for the "aim a longer drift shot" variant a bounced drift shot earns.
  driftGlanceTipShown = false;
  // Asteroids wrap at the screen edge forever, so this stays true for their
  // whole life; the game-loop prune still honours it as a defensive guard.
  alive = true;
  cracks: AsteroidCrack[] = [];
  bassShip: BassShip | null = null;
  // Combo-halo outline: each module polygon offset outward by a fixed pixel
  // gap (mitered, so corners stay sharp). Hull + radius never change after
  // construction, so the offset polygons are built once and cached here.
  haloOutline: { x: number; y: number }[][] | null = null;
  // Lingering "I just played a beat" flare. Independent from `flashAmount`
  // (the bullet-hit flash) so a beat-flash and a hit-flash can co-exist
  // without overwriting each other. Set to 1.0 in tickBassBeats and decays
  // a little slower so the visual beat actually lands.
  beatFlash = 0;
  // Slow-decaying echo of the beat, seeded to 1.0 alongside beatFlash but
  // living far longer (~1.2s) so the combo halo can shed an expanding ring
  // that rides outward and fades well after the on-beat flash is gone. Only
  // consumed by the combo-halo render, so it costs nothing when the halo's off.
  haloEcho = 0;
  // Bioluminescent glow trail, only allocated for bassteroids (the only
  // long-lasting drone source among asteroid kinds). One pre-baked sprite
  // stamp per ring-buffer sample under additive blend — no shadowBlur, no
  // per-frame allocation. See Trail.ts.
  trail: Trail | null = null;
  // Radiating-soundwave visualiser. Replaces `trail` once a bassteroid has
  // been broken into mediums/smalls — at which point its drone fades in and
  // the piece should "sing" outward rather than leave a wake. Anchored
  // origin per wave; see SoundwaveRadiator.ts.
  radiator: SoundwaveRadiator | null = null;
  // Number of gem collectibles this solid crystal will drop on death (0–3).
  // Decided at spawn so the same count can be pre-rendered as frosted gems
  // visible inside the crystal body. Unused for other kinds.
  embeddedGemCount = 0;
  // Local-space positions for the frosted gems inside a solidCrystal. Picked
  // at construction so they sit at the same spots in the pre-baked sprite
  // and the death payout.
  embeddedGemSpots: { x: number; y: number; r: number; tilt: number }[] = [];

  // Warble phasing. A warble is a "phased" asteroid: every measure (4 beats)
  // it dims from full body to `warbleOpacity` low and back. While it is in the
  // dim window it goes intangible — bullets pass clean through (see
  // `isPhasedOut` / collidesWith). Both fields are driven each tick from
  // game.beatTime in bassClock.tickWarbles so the cadence locks to the music;
  // 1 = fully present/solid, low = ghosted/intangible. A per-rock phase offset
  // keeps a field of warbles from blinking in unison.
  warbleOpacity = 1;
  warbleSolid = true;
  warblePhaseOffset = 0;
  // Pre-baked blurred copy of the warble sprite, drawn (very faint) in place of
  // the crisp body while phased out so the intangible window reads as "smeared
  // out of this plane" rather than a solid rock. Baked once so we never run a
  // blur filter per frame.
  warbleBlurSprite: HTMLCanvasElement | null = null;

  // Which cathedral archetype this "bell" asteroid wears (lancet wall, rose
  // facade, spire tower, arcade, buttress ruin). Rolled at construction; picks
  // both the silhouette harmonics and the interior painter. Unused off-kind.
  cathedralArchetype: CathedralArchetype = "lancetWall";

  // ---- torus fragment state (torusArc / torusChunk only) ----
  // The shared phantom ring this fragment rides. Null for a whole-body "torus"
  // (it has no group until it splits) and for every non-torus kind.
  torusGroup: TorusGroup | null = null;
  // Fixed angular slot (radians) this fragment occupies on the phantom ring.
  // Combined with the group's rotating `phase` to place the fragment each tick.
  torusSlot = 0;
  // Angular span (radians) of this fragment's arc. A half-ring C is ~π, the
  // shorter sliver ~1.9, a chunk is a small nub (~0.5). Drives the baked arc
  // sprite sweep + which neighbour the energy thread reaches to.
  torusArcSpan = 0;
  // Radius (in the local sprite frame) of the centreline the arc is bent along,
  // so the baked C-shape curves with the same radius the whole ring had. The
  // fragment's centroid sits one of these out from the phantom-ring centre.
  torusBendRadius = 0;

  // Level-10 boss reveal phase. "dormant" plays the 8s grow-and-rotate
  // foreshadow animation and is invulnerable. "live" is the normal damageable
  // engagement. Only meaningful when isBossFamily().
  bossPhase: "dormant" | "live" = "live";
  // Seconds elapsed since spawn while dormant; drives the swell + the rotate
  // -around reveal of the architecture. Reaches revealDuration → phase
  // transitions to "live" and the eye opens.
  bossRevealT = 0;
  // Eye-core target radius (set at construction for "boss" too so the
  // closed-eye lid seam is positioned consistently). For "bossEye" this is
  // the full body radius — the eye IS the asteroid.
  bossEyeRadius = 0;
  // Iris angle the eye is currently aiming. Lerps toward the player position
  // over a short window so quick player jukes are tracked but not perfectly.
  bossIrisAngle = 0;
  // Tracked aim point — locked at the start of the laser charge window so a
  // player who jukes during beats 7→8 actually dodges the bolt.
  bossEyeAimX = 0;
  bossEyeAimY = 0;
  // Displayed aim angle — eased toward the committed aim each frame so the
  // telegraph/beam slews smoothly between the discrete per-beat re-target
  // steps instead of snapping. -999 = uninitialised (snap to committed first).
  bossAimDisplayAngle = -999;
  // Per-fragment local-space orientation marker. For bossHemisphere this is
  // the angle of the cut diameter (so the straight edge faces a known
  // direction); for bossPlate it's the original modular hue band the plate
  // came from. Stored on the asteroid so the renderer doesn't need to derive
  // it from velocity (which drifts post-spawn).
  bossFragmentAngle = 0;
  // Color band index for bossPlate fragments — 0..3 picks one of the four
  // bassteroid hues that decorate the equatorial ring.
  bossPlateBand = 0;
  // For bossEmber: tiny inert pupil — no firing, just drifts. No state
  // beyond hue/radius is needed, this flag is implicit in kind.

  // ---- boss rhythm. Cycle = 16 beats × 0.5s = 8.0s; laser fires on beat 8 ----
  // Phase within the cycle (seconds 0..4). Driven by gameUpdate from
  // game.beatTime each tick. Used by the live boss and by post-break
  // fragments to fire their flash + plasma on the assigned slot.
  bossRhythmT = 0;
  // Per-section flash amplitudes — set to 1 on the assigned beat and decay.
  // Top hemisphere flashes on beat 1, bottom on beat 3, brass iris ring on
  // beat 5, pupil double-flash on beats 7 & 8 (the second triggers the bolt).
  bossTopFlash = 0;
  bossBottomFlash = 0;
  bossIrisFlash = 0;
  bossPupilFlash = 0;
  // Per-cycle latches. Each pulse fires exactly once per 8-beat cycle even
  // if dt overshoots the slot. Cleared when bossRhythmT wraps back to 0.
  bossDidTop = false;
  bossDidBottom = false;
  bossDidIris = false;
  bossDidPupil1 = false;
  bossDidPupil2 = false;
  // Flipped true after the first tickBossRhythm call so the very first
  // tick doesn't cascade every-prior-slot at once if the asteroid happens
  // to spawn mid-cycle.
  bossRhythmInit = false;
  // One-shot edge: true for exactly one tick after bossPhase transitions
  // dormant→live. gameUpdate reads it to play the wrong-note stinger and
  // zero the player's combo, then clears it.
  bossJustOpenedEye = false;
  // Laser charge ramp (0 → 1 across the windup). Renderer reads this to
  // crescendo the pupil core glow before the bolt leaves.
  bossLaserCharge = 0;
  // Pre-fire wind-up surge (0 → 1 across the final 3 beats before the shot).
  // Layered on top of bossLaserCharge to visibly wind the eye up as it commits
  // — a shudder + spooling glow that reads as "the barrel is about to fire".
  bossLaserWindup = 0;
  // Latest ship position cached by trackPlayer each tick — so the per-beat
  // re-aim inside tickBossRhythm can snap the targeting line to the player
  // without tickBossRhythm needing its own ship handle.
  bossTrackedShipX = 0;
  bossTrackedShipY = 0;
  // Windup beat index the targeting aim last ticked on. The aim steps toward
  // the player once per beat across the windup (beats 4..7) so the player
  // reads a sightline visibly walking onto them, then locking for the fire.
  bossAimBeatIndex = -1;
  // Latch flipped true after the post-break top/bottom hemispheres fire
  // their plasma ball on this cycle, reset on cycle wrap. Lives on every
  // boss-family asteroid so each hemisphere keeps its own state.
  bossPlasmaFired = false;

  // ---- Sepulchre (level-20 boss) + its Pallbearers ----
  // A bearer's fixed angular slot on the bier ring. The ring's centre is the
  // tomb itself, so a bearer's position is recomputed from its core each tick
  // (see tickSepulchre) rather than integrated from its own velocity.
  bierSlot = 0;
  // The tomb this bearer carries. Null once the tomb is gone — the bier drops
  // and the bearer flies off along the tangent it was riding.
  bierCore: Asteroid | null = null;
  // Which beat of the measure this bearer tolls on (0-3). It doubles as the
  // bearer's quarter of the phase cycle, so the ring is never all ghost at once.
  bearerBeat = 0;
  // Ring rotation (radians). Advanced on the tomb, read by every bearer.
  bierPhase = 0;
  // Toll bloom: set to 1 on the bearer's beat and decayed each tick. This is
  // the knell made visible — the tolling piece is the one lighting up.
  tollFlash = 0;
  // 0 shut → 1 fully open. The shutter over the reliquary grinds open once the
  // last bearer falls; while it is shut the Sepulchre is only a tomb, and once
  // it is open the tomb takes the bearers' beats itself.
  shutterOpen = 0;
  // Living bearers the shell's armour is currently priced off. Recomputed each
  // tick so the armour ladder and the visible tethers can never disagree.
  bierBearersAlive = 0;

  // Wraith-only state. The writhe phase drives the live-painted body's
  // breathing distortion and tendril extrusion. Pre-roll per-tendril phase
  // offsets at construction so each wraith has its own gait.
  writhePhase = 0;
  // 0 → just-emerged, 1 → fully manifested. Eases up over emergeDuration
  // so a wraith doesn't appear and instantly start damaging the player.
  wraithEmerge = 0;
  // Which half of the strike cycle it's in (see tickWraith):
  //   "stalk"  — repositioning; the only mode that steers freely.
  //   "windup" — braking telegraph before a strike; beat-snapped.
  //   "lunge"  — committed charge along a locked direction.
  //   "recover"— limp, unsteered, heavily damped: the kill window.
  wraithMode: "stalk" | "windup" | "lunge" | "recover" = "stalk";
  // Seconds left in the current timed mode ("stalk" ignores it).
  wraithModeT = 0;
  // True once the ship has come inside cfg.lungeRange; cleared again only past
  // cfg.stalkRange. Selects orbit-and-strike over flank-and-approach.
  wraithClose = false;
  // True while it is patrolling the standoff ring out in front of the player
  // (see tickWraith) — that arc runs on a lower speed cap so it doesn't fling
  // itself wide. Cleared as soon as it commits to the flank or a strike.
  wraithCircling = false;
  // Enforced hover (s) left before the next strike may arm. Set when a recovery
  // ends so a wraith can't chain-lunge the moment it gets its legs back.
  wraithStrikeCooldown = 0;
  // Last WRAITH_STRIKE_GRID slot seen while close; strikes ignite on a crossing.
  // Reset to -1 whenever it drops back to stalking so re-closing doesn't fire
  // instantly off a stale slot.
  wraithBeatSlot = -1;
  // Which side of the ship this wraith prefers to swing around while stalking
  // (+1/-1, rolled at spawn) so a brood fans out rather than queueing up on
  // one arc.
  wraithSwirlDir = 1;
  // Unit direction locked in at lunge ignition — the strike does NOT re-home,
  // which is what makes it dodgeable.
  lungeDirX = 0;
  lungeDirY = 0;
  // > 0 while mid-lunge; counts down. Drives the red-eye flare and the
  // additional acceleration burst during the lunge window.
  lungeActiveT = 0;
  // > 0 while winding up; counts down. Drives the pre-strike eye flare and
  // the coiling body squeeze in the renderer.
  windupActiveT = 0;
  // Per-tendril phase offsets (length determines tendril count). Decided at
  // spawn so each wraith reads as an individual; the actual extrusion is
  // computed live from this + writhePhase.
  wraithTendrils: number[] = [];
  // Emission cooldown for the dark-smoke trail the wraith bleeds behind it.
  wraithSmokeT = 0;

  // How many wraiths this prison shell is holding. Rolled at construction (not
  // at shatter time) so the live eye-glow render can show one pair of eyes per
  // captive — the player counts the eyes to judge what breaking it will cost.
  // 0 on every non-prison kind.
  prisonCaptives = 0;

  // True only for solidCrystalSmall shards ejected from a shattered glass
  // prison — paints as a black diamond splinter instead of the standalone
  // treat pickup's ice-blue crystal. Same kind, same HP/physics/sound; this
  // flag only swaps paintSolidCrystalBody's material.
  isPrisonShard = false;

  constructor(pos: Vec, vel: Vec, size: AsteroidSize, hue?: number, kind: AsteroidKind = "normal", inheritBass?: BassShip) {
    this.pos = pos;
    this.vel = vel;
    this.size = size;
    // Radius + damage-reduction off the stat table (stock size band by default);
    // the boss family re-derives radius below from the per-size ladder.
    this.radius = entityStat(kind, size, "radius");
    this.damageReduction = ENTITY_STATS[kind]?.damageReduction ?? 0;
    this.rotation = rand(0, TAU);
    this.rotSpeed = rand(-0.6, 0.6);
    this.kind = kind;
    const isBass = kind === "bassA" || kind === "bassB" || kind === "bassC" || kind === "bassD";
    const isBoss = kind === "boss";
    const isBossHemisphere = kind === "bossHemisphere";
    const isBossEye = kind === "bossEye";
    const isBossPlate = kind === "bossPlate";
    const isBossIrisShard = kind === "bossIrisShard";
    const isBossEmber = kind === "bossEmber";
    if (isBass) {
      this.measureOffset = BASS_KIND_BASE_OFFSET[kind];
      // Split children inherit a chunk of the parent's modules so they look
      // like a literal piece of the original ship rather than a scaled-down
      // copy of the whole silhouette. Gen-0 spawns use the full hand-built
      // ship.
      this.bassShip = inheritBass ?? buildBassteroidShape(kind);
      // Bassteroids orient by intent (engines/cockpit point a way) so a
      // wildly spinning silhouette would muddy the modular read. Keep them
      // drifting slowly.
      this.rotSpeed = rand(-0.18, 0.18);
    }
    if (isBurstGem(kind)) {
      // Heavy mass → barely tumbles; the slow drift is set in waveDirector.
      this.rotSpeed = rand(-0.22, 0.22);
    }
    if (isGlassPrison(kind)) {
      this.rotSpeed = rand(-0.18, 0.18);
      // Roll the brood now so the eyes visible through the shell match what
      // split() will actually let out.
      this.prisonCaptives = kind === "bigGlassPrison"
        ? Math.round(rand(ENTITY_CONFIG.bigGlassPrison.minWraiths, ENTITY_CONFIG.bigGlassPrison.maxWraiths))
        : ENTITY_CONFIG.glassPrison.wraithCount;
    }
    if (kind === "torus") {
      // Slow majestic spin like a heavy mechanical body.
      this.rotSpeed = rand(-0.14, 0.14);
    }
    if (kind === "citadel") {
      // Never turns — line up with the escape hole once and stay lined up.
      // (The spawn rotation above still randomizes which way the hole faces.)
      this.rotSpeed = 0;
    }
    if (kind === "sepulchre") {
      // A tomb turning once in a long while, not a tumbling rock.
      this.rotSpeed = rand(-0.05, 0.05);
      this.bossPhase = "dormant";
      this.bossRevealT = 0;
    }
    if (kind === "pallbearer") {
      // Both position and facing are dictated by the ring (see tickSepulchre):
      // a bearer always keeps its shoulder to the tomb it carries.
      this.rotSpeed = 0;
      // Dormant with the tomb: it rides the bier in silently through the whole
      // approach and only lights, tolls and becomes a target when the tomb wakes.
      this.bossPhase = "dormant";
    }
    if (kind === "torusArc" || kind === "torusChunk") {
      // Radius is set by split() from ring geometry; rotation by tickTorusGroup.
      this.rotSpeed = 0;
    }
    if (kind === "wraith") {
      // Slow tumble — the writhe body deformation does the real visual work.
      this.rotSpeed = rand(-0.4, 0.4);
      this.writhePhase = rand(0, TAU);
      this.wraithSwirlDir = rng() < 0.5 ? -1 : 1;
      // Five tendrils, evenly distributed around the body with per-piece
      // phase jitter so they wave asynchronously.
      const tendrilCount = 5;
      for (let i = 0; i < tendrilCount; i++) {
        this.wraithTendrils.push((i / tendrilCount) * TAU + rand(-0.4, 0.4));
      }
    }
    if (kind === "bell") {
      // Archetype drives both the harmonics silhouette and the interior painter.
      this.cathedralArchetype = CATHEDRAL_ARCHETYPES[Math.floor(rng() * CATHEDRAL_ARCHETYPES.length)];
    }
    if (isBoss) {
      // Slow majestic spin; even small bosses out-rotate ordinary asteroids.
      this.rotSpeed = rand(-0.12, 0.12) * (size === "large" ? 0.5 : 1);
      // Dormant until the reveal opens the eye; fragments spawn straight to live.
      this.bossPhase = "dormant";
      this.bossRevealT = 0;
      // Iris radius scales with the (dormant) body so the eyelid layout holds.
      this.bossEyeRadius = ENTITY_CONFIG.boss.eyeRadius * (this.radius / BOSS_RADIUS.large);
    }
    if (isBossHemisphere) {
      this.rotSpeed = rand(-0.18, 0.18);
    }
    if (isBossEye) {
      this.rotSpeed = rand(-0.12, 0.12);
    }
    if (isBossPlate) {
      this.rotSpeed = rand(-1.4, 1.4);
    }
    if (isBossIrisShard) {
      this.rotSpeed = rand(-2.0, 2.0);
    }
    if (isBossEmber) {
      this.rotSpeed = rand(-1.0, 1.0);
    }
    this.maxHp = entityStat(kind, size, "hp");
    this.hp = this.maxHp;
    // For most asteroids each HP gets its own pre-rolled crack so the
    // damage state escalates predictably. The boss has a much higher HP
    // budget (60 large) — drawing 60 multi-branch overlays every frame is
    // wasteful and looks like noise, so cap the boss at a handful of
    // distinct fractures and let `renderBossCracks` interpolate brightness
    // with the damage fraction instead.
    const crackCount = isBoss || kind === "sepulchre"
      ? 12
      : isBossHemisphere ? 8 : isBossEye || kind === "pallbearer" ? 6 : (isBossPlate || isBossIrisShard || isBossEmber) ? 4
      : this.maxHp;
    this.cracks = rollCracks(crackCount);
    // Boss-family, bass, gem etc. carry a fixed hue in ENTITY_STATS; the plain
    // kinds leave it undefined and roll a fresh wave hue.
    this.hue = hue ?? ENTITY_STATS[kind]?.hue ?? nextWaveHue();
    this.harmonics = this.buildHarmonicsForKind(kind);
    this.outlineSamples = ENTITY_STATS[kind]?.outlineSamples ?? this.outlineSamples;
    this.outline = this.computeOutline();
    this.nuclei = [];
    const nucleusCount = kind === "citadel" ? 9 : size === "huge" ? 7 : size === "large" ? 5 : size === "medium" ? 3 : 2;
    // Citadel nuclei live out on the shell band, clear of the escape hole.
    const [nucleusDistLo, nucleusDistHi] = kind === "citadel" ? [0.73, 0.86] : [0.15, 0.55];
    const nucleusIndices = Array.from({ length: nucleusCount }, (_, i) => i);
    for (const i of nucleusIndices) {
      this.nuclei.push({
        angle: (i / nucleusCount) * TAU + rand(-0.3, 0.3),
        dist: rand(nucleusDistLo, nucleusDistHi) * this.radius,
        size: rand(2, 4) * (size === "huge" ? 1.6 : size === "large" ? 1.3 : 1),
        pulsePhase: rand(0, TAU),
        pulseSpeed: rand(1.2, 2.4),
      });
    }
    if (kind === "warble") {
      // Lanterns belong on the stretch of shell the fragment kept, not
      // scattered through its broken middle (and never behind the apex, which
      // is outside the wedge entirely). Re-aim each one onto the outer band,
      // spread across the span — the rolled angle is reused as its jitter, so
      // this consumes no fresh seeded draws.
      const { apexX, arcR, halfSpan } = this.wedgeGeom();
      for (let i = 0; i < this.nuclei.length; i++) {
        const n = this.nuclei[i];
        const spread = ((i + 0.5) / this.nuclei.length - 0.5) * 2 * halfSpan * 0.8;
        const bandA = spread + Math.sin(n.angle * 3.3) * halfSpan * 0.08;
        const band = arcR * (0.72 + 0.1 * ((Math.sin(n.angle * 5.1) + 1) / 2));
        const nx = apexX + Math.cos(bandA) * band;
        const ny = Math.sin(bandA) * band;
        n.angle = Math.atan2(ny, nx);
        n.dist = Math.hypot(nx, ny);
      }
    }
    if (kind === "citadel") {
      // Walk any shell lantern out of the escape hole's footprint (plus
      // margin) — the hole is bare space, and render() pulses a live light at
      // every nucleus each frame. Deterministic nudges, no fresh seeded draws.
      for (const n of this.nuclei) {
        for (let tries = 0; tries < 16; tries++) {
          const nx = Math.cos(n.angle) * n.dist;
          const ny = Math.sin(n.angle) * n.dist;
          if (!pointInTriangle(nx / 1.18, ny / 1.18, CITADEL_HOLE_VERTS)) break;
          n.angle += 0.3;
        }
      }
    }
    this.membranePhase = rand(0, TAU);
    // Roll embedded gem count for solid crystals — weighted 60/25/10/5 for
    // 0/1/2/3 gems — and pick local-space spots so they can be pre-baked into
    // the sprite as frosted hints and dropped at the same positions on death.
    if (kind === "solidCrystal") {
      const gemRoll = rng();
      this.embeddedGemCount = gemRoll < 0.6 ? 0 : gemRoll < 0.85 ? 1 : gemRoll < 0.95 ? 2 : 3;
      for (let i = 0; i < this.embeddedGemCount; i++) {
        const angle = rand(0, TAU);
        const dist = this.embeddedGemCount === 1 ? rand(0, this.radius * 0.18) : this.radius * rand(0.28, 0.42);
        const a = this.embeddedGemCount === 1 ? 0 : angle + (i * TAU) / this.embeddedGemCount;
        this.embeddedGemSpots.push({
          x: Math.cos(a) * dist,
          y: Math.sin(a) * dist,
          r: this.radius * rand(0.18, 0.24),
          tilt: rand(0, TAU),
        });
      }
    }
    // Stagger each warble's phase so a field of them doesn't blink in lockstep.
    if (kind === "warble") this.warblePhaseOffset = rand(0, BASS_MEASURE_LENGTH);
    this.sprite = this.buildSprite();
    if (isPhasedKind(kind) && this.sprite) this.warbleBlurSprite = this.buildWarbleBlurSprite(this.sprite);
    // Bassteroid wake. Gen-0 (large) wears no drone yet — it gets the slow
    // glow Trail as a "pristine charged thing drifting in space" wake.
    // Mediums/smalls (only spawned via split) have an active drone voice,
    // so they instead wear a SoundwaveRadiator that radiates the drone
    // outward from their position. Trail hue / radiator hue both match the
    // bassteroid's own hue (set above from KIND_HUE).
    if (isBass) {
      if (size === "large") {
        const bassRateByKind: Record<string, number> = {
          bassA: 0.65,
          bassB: 0.85,
          bassC: 0.75,
          bassD: 1.05,
        };
        const rate = bassRateByKind[kind] ?? 0.8;
        // Trail radius scales with asteroid radius; alpha kept modest so a
        // field of four overlapping drones doesn't wash the screen out.
        this.trail = new Trail(this.hue, this.radius * 0.65, 0.28, "bass", rate);
      } else {
        // Fragmented: drone is fading in. Build a simplified silhouette
        // from this child's inherited ship chunk so the radiating waves
        // wear the actual broken-piece outline rather than a generic ring.
        const silhouette = buildBassSilhouette(this.bassShip!);
        const isHighOctave = size === "small";
        this.radiator = new SoundwaveRadiator(
          kind as "bassA" | "bassB" | "bassC" | "bassD",
          this.hue,
          silhouette,
          isHighOctave,
        );
      }
    }
  }

  // Each non-bass kind gets a subtly distinct silhouette via its harmonic
  // mix. "normal" stays the classic lumpy default; chime/bell/warble each
  // lean on different frequencies so they read as different shapes even
  // before colour cues land.
  buildHarmonicsForKind(kind: AsteroidKind): Harmonic[] {
    const out: Harmonic[] = [];
    // Per-kind frequency list and amplitude scale. Bass kinds keep the
    // default since their actual silhouette is the modular ship sprite.
    let freqs: number[];
    let ampScale = 1;
    if (kind === "chime") {
      // Sharp crystalline shards: high frequencies, low amplitude.
      freqs = [5, 7, 9, 11];
      ampScale = 0.7;
    } else if (kind === "bell") {
      // Cathedral fragment carved from an asteroid. The archetype picks the
      // gross proportion: a spire/tower wants a tall narrow body, an arcade
      // wants a wide squat slab, etc. Low harmonics give the chunky "broken
      // slab of building" silhouette; paintCathedralFragmentBody does the
      // architectural detailing on the interior.
      switch (this.cathedralArchetype) {
        case "spireTower": freqs = [1, 2, 3]; ampScale = 1.2; break;
        case "arcade":     freqs = [1, 2, 4]; ampScale = 1.4; break;
        case "roseFacade": freqs = [2, 3, 5]; ampScale = 1.1; break;
        case "buttressRuin": freqs = [1, 3, 5]; ampScale = 1.7; break;
        default:           freqs = [1, 2, 4]; ampScale = 1.5; break;
      }
    } else if (kind === "cathedralKeystone") {
      // A wedge-shaped voussoir / keystone chunk — strong 1-harmonic gives the
      // tapered "fat at one end" wedge, 3 jags the broken edges.
      freqs = [1, 3]; ampScale = 1.8;
    } else if (kind === "glassShard") {
      // A sharp sliver of stained glass — high amp on a low freq makes a long
      // pointed splinter; the low sample count keeps the edges hard.
      freqs = [1, 2]; ampScale = 2.0;
    } else if (kind === "columnDrum") {
      // A section of carved column / capital — nearly round (a drum of stone)
      // with light fluting wobble.
      freqs = [2, 6]; ampScale = 0.6;
    } else if (kind === "rubbleBlock") {
      // A plain chipped masonry block — chunky irregular polygon.
      freqs = [1, 2, 4]; ampScale = 1.3;
    } else if (kind === "warble") {
      // A broken bastion of the citadel: the wedgeProfile in computeOutline
      // carries the silhouette (curved shell arc + two fracture faces), so
      // these only chip the edges. The fortress's 3/5/8 family mix at metal
      // -hull amplitude — enough to weather the stone, not enough to round off
      // the corners or bow the straight breaks. Avoid freqs dividing the 34
      // outline samples (2 and 17 do).
      freqs = [3, 5, 8];
      ampScale = 0.3;
    } else if (kind === "citadel") {
      // Fortress mass: the warble's lobed family resemblance at a fraction of
      // the amplitude, so the huge shell reads solid and the escape hole
      // stays comfortably inside the silhouette at every angle.
      freqs = [3, 5, 8];
      ampScale = 0.4;
    } else if (isGlassPrison(kind)) {
      // Black diamond shell: the diamondProfile in computeOutline carries the
      // sharp rhombus silhouette; these harmonics only add a faint per-gem
      // facet wobble so no two prisons are identical. Kept low-amp (same
      // treatment as the burst gems) so the crisp diamond points survive.
      freqs = [3, 5];
      ampScale = 0.5;
    } else if (kind === "solidCrystal" || kind === "solidCrystalSmall") {
      // Pure crystal: a low harmonic count + low outlineSamples (set in the
      // constructor) make the silhouette a hard-edged polygon. Avoid any
      // freq that divides outlineSamples (7 for large, 6 for small) — those
      // alias to a constant offset across all sample points and produce no
      // visible variation. Low harmonics (1,2) handle the overall lopsided
      // body (one side bulges, the other tapers); 4 and 5 spike individual
      // vertices outward as broken-off shards. Result: dramatically irregular
      // polygons, each one different. computeOutline clamps the resulting
      // radius to a safe band so the shard can't collapse to a degenerate
      // self-intersecting polygon when harmonics happen to align in phase.
      freqs = [1, 2, 4, 5];
      ampScale = 1.8;
    } else if (isBurstGem(kind)) {
      // Cut gold. The diamond profile (computeOutline) carries the silhouette;
      // these harmonics only add a small per-gem wobble so no two are identical.
      // Kept low-amp so the crisp diamond points survive. Avoid freqs dividing
      // the 8 samples.
      freqs = [3, 5];
      ampScale = 0.5;
    } else if (isMetalHull(kind)) {
      // A dense tungsten block: computeOutline's cubeProfile carries the
      // rounded-cube silhouette; these low harmonics only add a faint chipped
      // wobble so no two blocks are identical. Kept low-amp so the square
      // corners survive. Avoid freqs dividing the 16 samples (2, 4, 8 do).
      freqs = [1, 3, 5];
      ampScale = 0.35;
    } else {
      // Default — classic asteroid lumpiness.
      freqs = [2, 3, 5, 7];
    }
    for (const freq of freqs) {
      out.push({
        amp: (rand(0.05, 0.18) / Math.sqrt(freq)) * ampScale,
        freq,
        phase: rand(0, TAU),
      });
    }
    return out;
  }

  buildSprite(): HTMLCanvasElement | null {
    // Boss-family pieces all paint live (the whole-body boss needs to swell
    // during the dormant reveal, hemispheres draw a half-disc that depends
    // on bossFragmentAngle, eye core renders the tracking iris each frame,
    // shards are tumbling sub-pieces). Returning null skips the pre-bake;
    // render() branches on kind below to dispatch to the live painters.
    // Wraiths also paint live — their entire identity is "writhing motion",
    // so a pre-baked silhouette would defeat the point.
    if (this.isBossFamily() || this.kind === "wraith" || this.isSepulchre()) return null;
    if (this.isBass()) return this.buildBassteroidSprite();
    if (this.kind === "torus") return this.buildTorusSprite();
    if (this.kind === "torusArc" || this.kind === "torusChunk") return this.buildTorusArcSprite();
    const haloRadius = this.radius * 2.3;
    const padding = 14;
    const size = Math.ceil(2 * (haloRadius + padding));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    this.spriteHalfSize = size / 2;

    ctx.translate(size / 2, size / 2);
    ctx.globalCompositeOperation = "lighter";
    const baseHue = this.hue;
    // Normal asteroids are essentially monochrome rock — drop saturation
    // hard so the special kinds (chime/bell/warble/bass) are the only
    // things drawing the eye with colour. asteroidWithGem mimics a normal rock
    // (the crystal hint is painted in separately below) so it stays plain.
    const isPlain = this.kind === "normal" || this.kind === "asteroidWithGem";
    const sHi = isPlain ? 8 : 100;
    const sMid = isPlain ? 6 : 80;
    const sLo = isPlain ? 5 : 70;
    const sFaint = isPlain ? 4 : 60;

    // Cathedral pieces are dead derelict stone — the architecture painters lay
    // down their own opaque body + rim, so skip the biolum halo / interior glow
    // / filament veins / nuclei cores that would otherwise make them "alive".
    // Metal hull is likewise inert plate: it paints its own opaque steel body.
    const isArchitectural = this.kind === "bell" || this.kind === "pallbearer" || CATHEDRAL_DEBRIS_KINDS.includes(this.kind) || isMetalHull(this.kind);
    // The fortress kinds lay down their own laminated armour body instead — the
    // soft membrane/filament pass would read organic under the plate bands, and
    // its bright baked nuclei would bleed up through the stone. Both paint their
    // own presence halo and their own lantern lights.
    const isCitadel = this.kind === "citadel";
    const isFortress = isCitadel || this.kind === "warble";
    if (!isArchitectural && !isFortress) {
    const halo = ctx.createRadialGradient(0, 0, this.radius * 0.7, 0, 0, haloRadius);
    halo.addColorStop(0, `hsla(${baseHue}, ${sHi}%, 60%, 0.12)`);
    halo.addColorStop(0.5, `hsla(${baseHue + 10}, ${sHi}%, 55%, 0.048)`);
    halo.addColorStop(1, `hsla(${baseHue}, ${sHi}%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    ctx.beginPath();
    const outlineSampleIndices = Array.from({ length: this.outlineSamples }, (_, i) => i);
    for (const i of outlineSampleIndices) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const interior = ctx.createRadialGradient(0, 0, 0, 0, 0, this.radius);
    interior.addColorStop(0, `hsla(${baseHue}, ${sMid}%, 30%, 0.35)`);
    interior.addColorStop(0.7, `hsla(${baseHue - 10}, ${sLo}%, 18%, 0.25)`);
    interior.addColorStop(1, `hsla(${baseHue}, ${sFaint}%, 10%, 0.05)`);
    ctx.fillStyle = interior;
    ctx.fill();

    ctx.lineWidth = 1.3;
    ctx.strokeStyle = `hsla(${baseHue + 10}, ${sHi}%, 75%, 0.7)`;
    ctx.stroke();

    ctx.save();
    ctx.clip();
    const filamentCount = this.size === "huge" ? 8 : this.size === "large" ? 6 : this.size === "medium" ? 4 : 3;
    ctx.strokeStyle = `hsla(${baseHue + 5}, ${isPlain ? 6 : 90}%, 70%, 0.18)`;
    ctx.lineWidth = 0.6;
    const filamentIndexList = Array.from({ length: filamentCount }, (_, i) => i);
    for (const i of filamentIndexList) {
      const fa = (i / filamentCount) * TAU + this.membranePhase * 0.2;
      ctx.beginPath();
      ctx.moveTo(-this.radius, Math.sin(fa) * this.radius * 0.4);
      ctx.bezierCurveTo(
        -this.radius * 0.3, Math.cos(fa * 2) * this.radius * 0.5,
        this.radius * 0.3, Math.sin(fa * 1.5 + 1) * this.radius * 0.5,
        this.radius, Math.cos(fa) * this.radius * 0.4,
      );
      ctx.stroke();
    }
    ctx.restore();

    const bakedNucleusPulse = 0.7;
    for (const n of this.nuclei) {
      const nx = Math.cos(n.angle) * n.dist;
      const ny = Math.sin(n.angle) * n.dist;
      const nucleusRadius = n.size * 6 * bakedNucleusPulse;
      const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nucleusRadius);
      grad.addColorStop(0, `hsla(${baseHue + 15}, ${sHi}%, 90%, ${0.9 * bakedNucleusPulse})`);
      grad.addColorStop(0.4, `hsla(${baseHue}, ${sHi}%, 65%, ${0.45 * bakedNucleusPulse})`);
      grad.addColorStop(1, `hsla(${baseHue}, ${sHi}%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(nx, ny, nucleusRadius, 0, TAU);
      ctx.fill();
    }
    }

    if (this.kind === "warble") this.paintWarbleBody(ctx);
    if (isCitadel) this.paintCitadelShell(ctx);
    if (this.kind === "asteroidWithGem") this.paintEmbeddedGem(ctx);
    if (this.kind === "solidCrystal" || this.kind === "solidCrystalSmall") this.paintSolidCrystalBody(ctx);
    if (isBurstGem(this.kind)) this.paintBurstGemBody(ctx);
    if (isGlassPrison(this.kind)) this.paintGlassPrisonBody(ctx);
    if (this.kind === "bell") this.paintCathedralFragmentBody(ctx);
    if (this.kind === "pallbearer") this.paintPallbearerBody(ctx);
    if (this.kind === "cathedralKeystone") this.paintKeystoneBody(ctx);
    if (this.kind === "glassShard") this.paintGlassShardBody(ctx);
    if (this.kind === "columnDrum") this.paintColumnDrumBody(ctx);
    if (this.kind === "rubbleBlock") this.paintRubbleBlockBody(ctx);
    if (isMetalHull(this.kind)) this.paintMetalChunkBody(ctx);
    // Cut last so the hole punches through every layer painted above.
    if (this.kind === "citadel") this.paintCitadelHole(ctx);

    return canvas;
  }

  // Citadel shell — a ring-fortress cathedral. Concentric curtain walls step
  // inward from the silhouette, each wearing battlement teeth, so the shell
  // funnels down toward the lit doorway; radial flying-buttress ribs brace
  // the walls, a ring of carved lancet windows burns with phase energy
  // between the inner walls, and the baked nucleus glows sit on the shell
  // band like lantern lights. Painted before paintCitadelHole so the escape
  // hole punches through every layer.
  private paintCitadelShell(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    // Bake-stable jitter derived from already-rolled per-rock values — the
    // bake must not consume fresh seeded draws.
    const jitter01 = (i: number): number => {
      const h = this.harmonics[i % this.harmonics.length];
      return (Math.sin(h.phase * (3.1 + i) + this.membranePhase * (1.7 + i)) + 1) / 2;
    };

    // Presence halo, kept from the generic pass — a body this big glows.
    const haloR = R * 1.9;
    const halo = ctx.createRadialGradient(0, 0, R * 0.75, 0, 0, haloR);
    halo.addColorStop(0, `hsla(${H}, 100%, 60%, 0.11)`);
    halo.addColorStop(1, `hsla(${H}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    this.tracePath(ctx, 1);
    ctx.clip();

    // Single up-left light: hue drifts warm on the lit shoulder, cool into
    // the shadow side, so the armour reads lit rather than tinted.
    const body = ctx.createRadialGradient(-R * 0.35, -R * 0.45, R * 0.1, 0, 0, R * 1.35);
    body.addColorStop(0, `hsla(${H + 12}, 55%, 42%, 0.95)`);
    body.addColorStop(0.55, `hsla(${H}, 50%, 24%, 0.92)`);
    body.addColorStop(1, `hsla(${H - 14}, 45%, 11%, 0.9)`);
    ctx.fillStyle = body;
    ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);

    // One bright-catch gradient shared by every plate edge: strong toward
    // the light, dying past the terminator.
    const catchGrad = ctx.createLinearGradient(-R, -R, R, R);
    catchGrad.addColorStop(0, `hsla(${H + 30}, 90%, 78%, 0.75)`);
    catchGrad.addColorStop(0.55, `hsla(${H + 30}, 90%, 78%, 0.14)`);
    catchGrad.addColorStop(1, `hsla(${H + 30}, 90%, 78%, 0)`);

    // Curtain walls: inset echoes of the silhouette, each shifted a touch
    // toward the shadow side so the stack reads as concentric ramparts. Each
    // wall wears battlement teeth — a dashed dark stroke bitten out of the
    // body just outside the wall line — over the usual dark/lit edge pair.
    const laminaScales = [0.86, 0.72, 0.58];
    for (let li = 0; li < laminaScales.length; li++) {
      const off = R * 0.022 * (li + 1);
      this.tracePath(ctx, laminaScales[li], off, off);
      ctx.fillStyle = `hsla(${H - 6}, 45%, 8%, 0.16)`;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = `hsla(${H}, 40%, 5%, 0.8)`;
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = catchGrad;
      ctx.stroke();
      const tooth = R * 0.045;
      ctx.setLineDash([tooth, tooth * 0.7]);
      ctx.lineDashOffset = R * jitter01(li);
      ctx.lineWidth = R * 0.03;
      ctx.strokeStyle = `hsla(${H - 6}, 45%, 8%, 0.5)`;
      this.tracePath(ctx, laminaScales[li] + 0.04, off, off);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Radial flying-buttress ribs brace the walls, jittered off a perfect
    // wheel: a mid-tone stone rib spanning inner wall to rim, with a dark
    // shadow groove on one flank and a lit catch on the other.
    const ribCount = this.nuclei.length;
    for (let i = 0; i < ribCount; i++) {
      const a = ((i + 0.5) / ribCount) * TAU + (jitter01(i) - 0.5) * 0.25;
      const idx = ((Math.round((a / TAU) * this.outlineSamples) % this.outlineSamples) + this.outlineSamples) % this.outlineSamples;
      const rOut = this.outline[idx] * 0.995;
      const rIn = rOut * 0.52;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      const rib = (offPerp: number) => {
        ctx.beginPath();
        ctx.moveTo(cosA * rIn - sinA * offPerp, sinA * rIn + cosA * offPerp);
        ctx.lineTo(cosA * rOut - sinA * offPerp, sinA * rOut + cosA * offPerp);
        ctx.stroke();
      };
      ctx.lineWidth = R * 0.042;
      ctx.strokeStyle = `hsla(${H + 4}, 30%, 28%, 0.9)`;
      rib(0);
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = `hsla(${H}, 40%, 5%, 0.8)`;
      rib(R * 0.024);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = catchGrad;
      rib(-R * 0.024);
    }

    // A ring of carved lancet windows between the inner walls, one per bay,
    // their glass still burning with phase energy — the citadel is a living
    // cathedral, not a derelict like the bell. Bays swallowed by the portal
    // are skipped rather than sliced by the hole punch.
    for (let i = 0; i < this.nuclei.length; i++) {
      const a = this.nuclei[i].angle;
      const idx = ((Math.round((a / TAU) * this.outlineSamples) % this.outlineSamples) + this.outlineSamples) % this.outlineSamples;
      const rW = this.outline[idx] * 0.65;
      const wx = Math.cos(a) * rW;
      const wy = Math.sin(a) * rW;
      if (pointInTriangle(wx / 1.12, wy / 1.12, CITADEL_HOLE_VERTS)) continue;
      ctx.save();
      ctx.translate(wx, wy);
      // Local -y points radially outward so the lancet tip faces the rim.
      ctx.rotate(a + Math.PI / 2);
      const hw = R * 0.03;
      const top = -R * 0.035, bot = R * 0.06, tip = -R * 0.095;
      const win = (inset: number) => this.lancetPath(ctx, 0, hw, top, bot, tip, inset);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `hsla(${H}, 40%, 6%, 0.9)`;
      win(-R * 0.012);
      ctx.fill();
      const glass = ctx.createLinearGradient(0, tip, 0, bot);
      glass.addColorStop(0, `hsla(${H + 45}, 95%, 84%, 0.95)`);
      glass.addColorStop(1, `hsla(${H + 12}, 90%, 52%, 0.85)`);
      ctx.fillStyle = glass;
      win(0);
      ctx.fill();
      ctx.strokeStyle = `hsla(${H}, 45%, 8%, 0.85)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, tip + R * 0.01);
      ctx.lineTo(0, bot);
      ctx.stroke();
      // The window casts its light onto the surrounding stone.
      ctx.globalCompositeOperation = "lighter";
      const cast = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.09);
      cast.addColorStop(0, `hsla(${H + 30}, 90%, 70%, 0.35)`);
      cast.addColorStop(1, `hsla(${H + 30}, 90%, 70%, 0)`);
      ctx.fillStyle = cast;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.09, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";

    // Specular catch on the lit shoulder — the one crisp "it's 3D" cue.
    ctx.globalCompositeOperation = "lighter";
    const spec = ctx.createRadialGradient(-R * 0.42, -R * 0.5, 0, -R * 0.42, -R * 0.5, R * 0.34);
    spec.addColorStop(0, `hsla(${H + 40}, 95%, 92%, 0.45)`);
    spec.addColorStop(0.4, `hsla(${H + 25}, 90%, 75%, 0.15)`);
    spec.addColorStop(1, `hsla(${H + 25}, 90%, 75%, 0)`);
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(-R * 0.42, -R * 0.5, R * 0.34, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Outer rim: dark occlusion under a bright catch, straddling the edge.
    ctx.globalCompositeOperation = "source-over";
    this.tracePath(ctx, 1);
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = `hsla(${H}, 35%, 6%, 0.9)`;
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `hsla(${H + 20}, 90%, 74%, 0.85)`;
    ctx.stroke();

    // Lantern lights on the shell band (the citadel's take on the generic
    // baked-nuclei pass); render() pulses live cores over these.
    ctx.globalCompositeOperation = "lighter";
    for (const n of this.nuclei) {
      const nx = Math.cos(n.angle) * n.dist;
      const ny = Math.sin(n.angle) * n.dist;
      const nr = n.size * 5;
      const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
      grad.addColorStop(0, `hsla(${H + 20}, 100%, 88%, 0.75)`);
      grad.addColorStop(0.45, `hsla(${H}, 100%, 65%, 0.32)`);
      grad.addColorStop(1, `hsla(${H}, 100%, 60%, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(nx, ny, nr, 0, TAU);
      ctx.fill();
    }
  }

  // Punch the ship-shaped escape hole out of the baked body, then dress its
  // edge with the house double rim (dark occlusion + bright catch) and a soft
  // interior bloom so the safe pocket reads as a lit doorway, not a paint gap.
  private paintCitadelHole(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const holePath = () => {
      ctx.beginPath();
      traceCitadelHolePath(ctx);
    };
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    holePath();
    ctx.fill();
    ctx.restore();
    // Carved portal archivolts — stepped echoes of the doorway receding into
    // the wall, the nested-arch treatment a cathedral porch wears. Clipped to
    // the body so the outer ring can't poke past the rim near the nose.
    ctx.save();
    this.tracePath(ctx, 1);
    ctx.clip();
    ctx.globalCompositeOperation = "source-over";
    for (const [s, dark, lit] of [[1.09, 0.7, 0.5], [1.18, 0.55, 0.3]] as const) {
      ctx.save();
      ctx.scale(s, s);
      holePath();
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.strokeStyle = `hsla(${H}, 35%, 7%, ${dark})`;
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `hsla(${H + 25}, 80%, 72%, ${lit})`;
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 4;
    ctx.strokeStyle = `hsla(${H}, 30%, 6%, 0.9)`;
    holePath();
    ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `hsla(${H + 35}, 95%, 80%, 0.95)`;
    holePath();
    ctx.stroke();
    // Bloom hugging the inner wall — clipped to the body so it doesn't spill
    // into the hole and muddy the "empty, safe" read.
    const bloomR = CITADEL_HOLE_VERTS[0].x * 1.45;
    ctx.save();
    this.tracePath(ctx, 1);
    traceCitadelHolePath(ctx);
    ctx.clip("evenodd");
    const bloom = ctx.createRadialGradient(0, 0, bloomR * 0.3, 0, 0, bloomR);
    bloom.addColorStop(0, `hsla(${H + 30}, 90%, 70%, 0.30)`);
    bloom.addColorStop(1, `hsla(${H + 30}, 90%, 70%, 0)`);
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(0, 0, bloomR, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Trace an annular-sector path (the "tube" of a torus, optionally only a
  // slice of it) into the current context, centred at (cx, cy). Sweeps the
  // outer edge from a0→a1 then the inner edge back a1→a0 and closes, so a fill
  // paints the ring band and a clip masks interior detail to it. A full ring
  // (|a1-a0| ≥ ~TAU) is traced as two concentric circles with an even-odd hole.
  private traceAnnularSector(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number,
  ) {
    const full = a1 - a0 >= TAU - 1e-3;
    ctx.beginPath();
    if (full) {
      ctx.arc(cx, cy, rOuter, 0, TAU);
      ctx.arc(cx, cy, rInner, 0, TAU, true);
      return;
    }
    ctx.arc(cx, cy, rOuter, a0, a1, false);
    ctx.arc(cx, cy, rInner, a1, a0, true);
    ctx.closePath();
  }

  // Paint a lit mechanical ring band (or a slice of one) using the house depth
  // recipe: dark occlusion rim → body gradient with an upper-left hot-spot →
  // bright inner rim → radial panel seams → a row of glowing energy studs on the
  // tube. Centre (cx, cy) is the phantom-ring centre in the sprite's local
  // frame. Shared by the whole-ring bake and each arc-fragment bake.
  private paintTorusBand(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number,
  ) {
    const H = this.hue;
    const rMid = (rOuter + rInner) / 2;
    const sector = () => this.traceAnnularSector(ctx, cx, cy, rOuter, rInner, a0, a1);

    // Dark outer rim first (occlusion contact against the starfield).
    ctx.globalCompositeOperation = "source-over";
    sector();
    ctx.fillStyle = `hsla(${H}, 28%, 7%, 0.95)`;
    ctx.fill("evenodd");

    // Body: radial gradient whose hot-spot is pushed up-left so the ring's
    // upper-left shoulder reads lit and the lower-right falls into shadow. Hue
    // drifts cooler+darker into the shadow stops so it looks lit, not plastic.
    ctx.save();
    sector();
    ctx.clip("evenodd");
    const gx = cx - rOuter * 0.4;
    const gy = cy - rOuter * 0.5;
    const body = ctx.createRadialGradient(gx, gy, rInner * 0.2, cx, cy, rOuter * 1.25);
    body.addColorStop(0, `hsla(${H}, 42%, 62%, 1)`);
    body.addColorStop(0.5, `hsla(${H}, 40%, 38%, 1)`);
    body.addColorStop(1, `hsla(${H + 8}, 46%, 13%, 1)`);
    ctx.fillStyle = body;
    ctx.fillRect(cx - rOuter * 1.3, cy - rOuter * 1.3, rOuter * 2.6, rOuter * 2.6);

    // Concentric machined grooves so the tube reads as turned metal, not a flat
    // donut. Hairline dark + a thinner bright catch just inside it.
    const grooveCount = 3;
    for (let g = 1; g <= grooveCount; g++) {
      const gr = rInner + ((rOuter - rInner) * g) / (grooveCount + 1);
      ctx.beginPath();
      ctx.arc(cx, cy, gr, a0, a1, false);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `hsla(${H}, 35%, 10%, 0.55)`;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, gr - 1, a0, a1, false);
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = `hsla(${H + 12}, 70%, 78%, 0.3)`;
      ctx.stroke();
    }

    // Radial panel seams crossing the tube — turns the band into bolted plates.
    // A full ring seams all the way round (i from 0); an arc skips its two cut
    // ends (the break-face caps are drawn separately by the arc baker).
    const span = a1 - a0;
    const full = span >= TAU - 1e-3;
    const seamStep = 0.42;
    const seamCount = Math.max(2, Math.round(span / seamStep));
    for (let i = (full ? 0 : 1); i < seamCount; i++) {
      const sa = a0 + (i / seamCount) * span;
      const ox = Math.cos(sa), oy = Math.sin(sa);
      ctx.beginPath();
      ctx.moveTo(cx + ox * rInner, cy + oy * rInner);
      ctx.lineTo(cx + ox * rOuter, cy + oy * rOuter);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = `hsla(${H}, 30%, 9%, 0.6)`;
      ctx.stroke();
      // bright machined edge on the up-left side of each seam
      ctx.beginPath();
      ctx.moveTo(cx + ox * rInner - 0.8, cy + oy * rInner - 0.8);
      ctx.lineTo(cx + ox * rOuter - 0.8, cy + oy * rOuter - 0.8);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = `hsla(${H + 15}, 65%, 72%, 0.22)`;
      ctx.stroke();
    }
    ctx.restore();

    // Bright inner-rim catch (rim light on both the outer and inner edges of
    // the tube). Two stacked strokes per edge: thin bright over the dark.
    ctx.globalCompositeOperation = "source-over";
    for (const edgeR of [rOuter, rInner]) {
      ctx.beginPath();
      ctx.arc(cx, cy, edgeR, a0, a1, false);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = `hsla(${H}, 32%, 6%, 0.9)`;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, edgeR, a0, a1, false);
      ctx.lineWidth = 1.1;
      ctx.strokeStyle = `hsla(${H + 12}, 85%, 80%, 0.85)`;
      ctx.stroke();
    }

    // Energy studs: a row of glowing nodes along the tube centreline, additive,
    // so the ring reads as a powered machine. These are the anchor points the
    // live connecting-energy thread reaches toward at render time.
    ctx.globalCompositeOperation = "lighter";
    const studStep = 0.5;
    const studCount = Math.max(2, Math.round(span / studStep));
    for (let i = 0; i <= studCount; i++) {
      if (!full && (i === 0 || i === studCount)) continue;
      const sa = a0 + (i / studCount) * span;
      const sx = cx + Math.cos(sa) * rMid;
      const sy = cy + Math.sin(sa) * rMid;
      drawGlow(ctx, sx, sy, rMid * 0.16, H, 0.5);
      ctx.fillStyle = `hsla(${H + 30}, 95%, 90%, 0.9)`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.6, 0, TAU);
      ctx.fill();
    }
  }

  // Pre-bake the whole mechanical ring: a single lit annulus centred in the
  // sprite, plus a soft additive halo behind it. Per-frame render is one
  // drawImage + the cheap hit/beat flash overlay.
  private buildTorusSprite(): HTMLCanvasElement {
    const rOuter = this.radius;
    const rInner = this.radius * (1 - ENTITY_CONFIG.torus.tubeFrac);
    const halo = rOuter * 1.25;
    const padding = 14;
    const size = Math.ceil(2 * (halo + padding));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    this.spriteHalfSize = size / 2;
    ctx.translate(size / 2, size / 2);
    // Soft halo behind the ring (additive) so it glows like the other kinds.
    ctx.globalCompositeOperation = "lighter";
    drawGlow(ctx, 0, 0, halo, this.hue, 0.18);
    this.paintTorusBand(ctx, 0, 0, rOuter, rInner, 0, TAU);
    return canvas;
  }

  // Pre-bake one arc fragment (a torusArc C / sliver, or a torusChunk nub). The
  // arc curves along a phantom ring of radius `torusBendRadius`; its bend-centre
  // sits at local (-torusBendRadius, 0), so the arc bulges toward +x. The
  // fragment's own `radius` (hitbox) is the half-chord of the arc, computed at
  // split time. render() draws this at the centroid with `rotation` aiming the
  // bulge radially outward from the group centre.
  private buildTorusArcSprite(): HTMLCanvasElement {
    const bend = this.torusBendRadius || this.radius;
    const tube = bend * ENTITY_CONFIG.torus.tubeFrac;
    const rOuter = bend + tube / 2;
    const rInner = bend - tube / 2;
    const span = this.torusArcSpan || 0.5;
    // Local bend-centre to the left so the arc's mid-point lands near origin.
    const cx = -bend;
    const cy = 0;
    const a0 = -span / 2;
    const a1 = span / 2;
    // Sprite must cover the arc's bounding box generously (+ halo for studs).
    const reach = tube * 1.4 + bend * 0.18;
    const halfW = Math.max(rOuter - bend, bend - bend * Math.cos(span / 2)) + reach;
    const halfH = bend * Math.sin(span / 2) + reach;
    const half = Math.ceil(Math.max(halfW, halfH)) + 14;
    const sizeC = half * 2;
    const canvas = document.createElement("canvas");
    canvas.width = sizeC;
    canvas.height = sizeC;
    const ctx = canvas.getContext("2d")!;
    this.spriteHalfSize = half;
    // Translate so local origin (arc centroid ≈ 0,0) is the sprite centre.
    ctx.translate(half, half);
    ctx.globalCompositeOperation = "lighter";
    drawGlow(ctx, 0, 0, tube * 2, this.hue, 0.16);
    this.paintTorusBand(ctx, cx, cy, rOuter, rInner, a0, a1);
    // Cap the freshly-cut ends with a brighter break-face so a severed arc reads
    // as "snapped off the ring", echoing the boss hemisphere's cut diameter.
    ctx.globalCompositeOperation = "source-over";
    for (const cap of [a0, a1]) {
      const ox = Math.cos(cap), oy = Math.sin(cap);
      ctx.beginPath();
      ctx.moveTo(cx + ox * rInner, cy + oy * rInner);
      ctx.lineTo(cx + ox * rOuter, cy + oy * rOuter);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = `hsla(${this.hue + 18}, 70%, 64%, 0.85)`;
      ctx.stroke();
    }
    return canvas;
  }

  // Bake a blurred copy of the crisp warble sprite once. Drawn in place of the
  // sharp body while the rock is phased out, so the intangible window reads as a
  // faint smear "out of phase" instead of a solid asteroid. The source sprite is
  // padded (halo room), so the blur has margin and won't clip at the edges.
  private buildWarbleBlurSprite(src: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext("2d")!;
    // Capped so the citadel's huge body smears without dissolving entirely.
    ctx.filter = `blur(${Math.max(3, Math.min(20, this.radius * 0.35))}px)`;
    ctx.drawImage(src, 0, 0);
    if (this.kind === "citadel") {
      // The blur smears shell glow across the escape hole, and the phased-out
      // window is exactly when the ship sits inside it — re-punch the hole so
      // the ghost keeps showing bare space through the middle.
      ctx.filter = "none";
      ctx.save();
      ctx.translate(src.width / 2, src.height / 2);
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      traceCitadelHolePath(ctx);
      ctx.fill();
      ctx.restore();
    }
    return canvas;
  }

  // Warble interior — a slice of the citadel it phases with, painted as one.
  // Every course and joint is laid out in the PARENT's frame (concentric about
  // the wedge's apex, radial out of it), so the stonework curves with the
  // fortress the chunk came off rather than following the chunk's own outline;
  // the clip cuts each course dead at the fracture faces, which is what shows
  // the wall's laminated cross-section. The two straight faces then get the
  // pale-lit-lip-over-dark-shadow treatment of freshly broken stone. Feature
  // count steps down with size: a large fragment still carries a battlemented
  // rampart and a lit lancet bay, a small one is just courses and breaks — a
  // chip off a chunk. The live phase-ring overlay in renderWarblePhase rides on
  // top of this baked base.
  private paintWarbleBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    const { apexX, arcR, halfSpan } = this.wedgeGeom();
    const isBig = this.size === "large" || this.size === "huge";

    // Presence halo — the parent's glow at fragment scale, offset onto the mass
    // so it doesn't bloom out of the empty corner behind the apex.
    const haloR = R * 1.5;
    const halo = ctx.createRadialGradient(apexX + arcR * 0.5, 0, R * 0.4, apexX + arcR * 0.5, 0, haloR);
    halo.addColorStop(0, `hsla(${H}, 100%, 60%, 0.1)`);
    halo.addColorStop(1, `hsla(${H}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(apexX + arcR * 0.5, 0, haloR, 0, TAU);
    ctx.fill();
    // Bake-stable jitter off already-rolled per-rock values (the citadel
    // shell's trick) — the bake must not consume fresh seeded draws.
    const jitter01 = (i: number): number => {
      const h = this.harmonics[i % this.harmonics.length];
      return (Math.sin(h.phase * (2.9 + i) + this.membranePhase * (1.3 + i)) + 1) / 2;
    };
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();

    // The citadel shell's lit armour-stone gradient, so a warble reads as a
    // literal piece of the parent fortress.
    ctx.globalCompositeOperation = "source-over";
    const body = ctx.createRadialGradient(-R * 0.35, -R * 0.45, R * 0.1, 0, 0, R * 1.35);
    body.addColorStop(0, `hsla(${H + 12}, 50%, 38%, 0.95)`);
    body.addColorStop(0.55, `hsla(${H}, 45%, 18%, 0.93)`);
    body.addColorStop(1, `hsla(${H - 14}, 40%, 8%, 0.92)`);
    ctx.fillStyle = body;
    ctx.fillRect(-R * 1.2, -R * 1.2, R * 2.4, R * 2.4);

    const catchGrad = ctx.createLinearGradient(-R, -R, R, R);
    catchGrad.addColorStop(0, `hsla(${H + 30}, 85%, 78%, 0.7)`);
    catchGrad.addColorStop(0.6, `hsla(${H + 30}, 85%, 78%, 0.12)`);
    catchGrad.addColorStop(1, `hsla(${H + 30}, 85%, 78%, 0)`);

    // The shell band — this fragment's stretch of the citadel's outermost
    // armour course, laid down a shade lighter than the core it was cast
    // around. This is what carries the read at 50 px, long before any of the
    // stonework below is legible: finished wall out at the curve, broken rock
    // behind it. An annular sector struck from the apex, overshooting the span
    // so the clip trims it against the fracture faces.
    ctx.beginPath();
    ctx.arc(apexX, 0, arcR * 1.06, -halfSpan * 1.3, halfSpan * 1.3);
    ctx.arc(apexX, 0, arcR * 0.83, halfSpan * 1.3, -halfSpan * 1.3, true);
    ctx.closePath();
    ctx.fillStyle = `hsla(${H + 8}, 45%, 29%, 0.6)`;
    ctx.fill();

    // Curtain-wall courses, concentric with the PARENT shell: arcs struck from
    // the wedge's apex, overshooting the span so the clip ends them on the
    // fracture faces rather than curling back inside the fragment.
    const course = (frac: number, lw: number, style: string | CanvasGradient) => {
      ctx.beginPath();
      ctx.arc(apexX, 0, arcR * frac, -halfSpan * 1.3, halfSpan * 1.3);
      ctx.lineWidth = lw;
      ctx.strokeStyle = style;
      ctx.stroke();
    };
    // A large chunk carries two walls of the fortress; smaller pieces came off
    // between the walls and keep one.
    const courseFracs = isBig ? [0.87, 0.71] : [0.8];
    for (const frac of courseFracs) {
      course(frac, 2.6, `hsla(${H}, 40%, 5%, 0.8)`);
      course(frac, 1.2, catchGrad);
    }
    // Battlement teeth along the shell edge — a dashed dark bite, the parent's
    // crenellation at fragment scale. Only the big pieces kept a rampart top.
    if (isBig) {
      const tooth = Math.max(3, R * 0.11);
      ctx.setLineDash([tooth, tooth * 0.75]);
      ctx.lineDashOffset = R * jitter01(0);
      course(0.96, Math.max(2.5, R * 0.08), `hsla(${H - 6}, 45%, 8%, 0.5)`);
      ctx.setLineDash([]);
    }

    // Radial joints out of the apex cut the band into dressed masonry blocks —
    // the fortress's bays, sliced through by the break.
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = `hsla(${H}, 35%, 7%, 0.55)`;
    const jointCount = isBig ? 6 : this.size === "medium" ? 4 : 3;
    ctx.beginPath();
    for (let i = 1; i < jointCount; i++) {
      const a = -halfSpan + (i / jointCount) * 2 * halfSpan + (jitter01(i) - 0.5) * 0.07;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      ctx.moveTo(apexX + cosA * arcR * 0.58, sinA * arcR * 0.58);
      ctx.lineTo(apexX + cosA * arcR * 1.02, sinA * arcR * 1.02);
    }
    ctx.stroke();

    // One carved lancet bay, its glass still burning with the phase energy the
    // fragment carried out of the citadel. Sat in the wall band and aimed
    // radially outward, exactly like the ring of windows on the parent — a
    // rotation of +90° puts local -y (the lancet's tip) on the outward axis.
    // Only the big pieces are wide enough to have taken a whole bay with them.
    if (isBig) {
      ctx.save();
      ctx.translate(apexX + arcR * 0.78, 0);
      ctx.rotate(Math.PI / 2);
      const hw = R * 0.085, top = -R * 0.05, bot = R * 0.13, tip = -R * 0.17;
      const win = (inset: number) => this.lancetPath(ctx, 0, hw, top, bot, tip, inset);
      ctx.fillStyle = `hsla(${H}, 40%, 6%, 0.92)`;
      win(-R * 0.045);
      ctx.fill();
      const glass = ctx.createLinearGradient(0, tip, 0, bot);
      glass.addColorStop(0, `hsla(${H + 45}, 95%, 84%, 0.95)`);
      glass.addColorStop(1, `hsla(${H + 12}, 90%, 52%, 0.8)`);
      ctx.fillStyle = glass;
      win(0);
      ctx.fill();
      // Leaded mullion + transom so it reads as cathedral glass, not a slot.
      ctx.strokeStyle = `hsla(${H}, 45%, 8%, 0.85)`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(0, tip + R * 0.02);
      ctx.lineTo(0, bot);
      ctx.moveTo(-hw, R * 0.05);
      ctx.lineTo(hw, R * 0.05);
      ctx.stroke();
      // Lit stone lip on the carved surround.
      ctx.strokeStyle = `hsla(${H + 25}, 75%, 74%, 0.5)`;
      ctx.lineWidth = 1;
      win(-R * 0.03);
      ctx.stroke();
      // The window casts its light onto the surrounding stone.
      ctx.globalCompositeOperation = "lighter";
      const cast = ctx.createRadialGradient(0, R * 0.02, 0, 0, R * 0.02, R * 0.34);
      cast.addColorStop(0, `hsla(${H + 30}, 90%, 70%, 0.22)`);
      cast.addColorStop(1, `hsla(${H + 30}, 90%, 70%, 0)`);
      ctx.fillStyle = cast;
      ctx.beginPath();
      ctx.arc(0, R * 0.02, R * 0.34, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Lantern glows under the live nucleus pulses (the masonry body buried
    // the generic baked-nuclei pass) — the citadel's shell lanterns at
    // fragment scale, so render()'s pulsing cores sit on light, not on stone.
    ctx.globalCompositeOperation = "lighter";
    for (const n of this.nuclei) {
      const nx = Math.cos(n.angle) * n.dist;
      const ny = Math.sin(n.angle) * n.dist;
      // Capped against the body: a small chip's lanterns are lamps set in its
      // wall, not a glow that swallows the whole fragment.
      const nr = Math.min(n.size * 4, R * 0.22);
      const lantern = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
      lantern.addColorStop(0, `hsla(${H + 20}, 100%, 88%, 0.55)`);
      lantern.addColorStop(0.45, `hsla(${H}, 100%, 65%, 0.22)`);
      lantern.addColorStop(1, `hsla(${H}, 100%, 60%, 0)`);
      ctx.fillStyle = lantern;
      ctx.beginPath();
      ctx.arc(nx, ny, nr, 0, TAU);
      ctx.fill();
    }

    // Specular catch on the lit shoulder, the parent's cue at fragment scale —
    // the one crisp highlight that keeps the slab from reading flat.
    const spx = -R * 0.18;
    const spy = -R * 0.42;
    const spec = ctx.createRadialGradient(spx, spy, 0, spx, spy, R * 0.3);
    spec.addColorStop(0, `hsla(${H + 40}, 95%, 92%, 0.4)`);
    spec.addColorStop(0.4, `hsla(${H + 25}, 90%, 75%, 0.13)`);
    spec.addColorStop(1, `hsla(${H + 25}, 90%, 75%, 0)`);
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(spx, spy, R * 0.3, 0, TAU);
    ctx.fill();

    // The two fracture faces: where the fragment was cut out of the ring. Each
    // gets a band of shadow set into the stone with a pale lit lip riding on
    // top of it — freshly broken rock against the weathered shell above. Drawn
    // slightly inset from the ideal edge so the chipped silhouette can't leave
    // a stroke hanging off in space.
    ctx.globalCompositeOperation = "source-over";
    for (const s of [1, -1]) {
      const a = s * halfSpan;
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      // Inward normal of this face — both lean back toward the fragment's axis.
      const nx = sinA * s;
      const ny = -cosA * s;
      const face = (inset: number, lw: number, style: string) => {
        ctx.beginPath();
        ctx.moveTo(apexX + nx * inset + cosA * arcR * 0.06, ny * inset + sinA * arcR * 0.06);
        ctx.lineTo(apexX + cosA * arcR * 0.99 + nx * inset, sinA * arcR * 0.99 + ny * inset);
        ctx.lineWidth = lw;
        ctx.strokeStyle = style;
        ctx.stroke();
      };
      face(R * 0.1, R * 0.16, `hsla(${H - 6}, 42%, 5%, 0.5)`);
      face(R * 0.026, 2.4, `hsla(${H + 18}, 55%, 80%, 0.75)`);
    }
    // Pooled shadow in the notch where the two faces meet — the deep inside
    // corner of the break, furthest from both the light and the shell.
    const notch = ctx.createRadialGradient(apexX, 0, 0, apexX, 0, arcR * 0.5);
    notch.addColorStop(0, `hsla(${H - 10}, 45%, 5%, 0.55)`);
    notch.addColorStop(1, `hsla(${H - 10}, 45%, 5%, 0)`);
    ctx.fillStyle = notch;
    ctx.beginPath();
    ctx.arc(apexX, 0, arcR * 0.5, 0, TAU);
    ctx.fill();
    ctx.restore();

    // The citadel's double rim at fragment scale — but the bright catch runs
    // along the shell arc ONLY. That asymmetry is the whole read: the curved
    // edge is finished fortress surface catching the light, the two straight
    // edges are raw breaks that never had a face to catch anything.
    ctx.globalCompositeOperation = "source-over";
    this.traceOutline(ctx);
    ctx.lineWidth = 3;
    ctx.strokeStyle = `hsla(${H}, 35%, 6%, 0.9)`;
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = `hsla(${H + 20}, 85%, 74%, 0.85)`;
    ctx.beginPath();
    ctx.arc(apexX, 0, arcR * 0.97, -halfSpan * 0.94, halfSpan * 0.94);
    ctx.stroke();
  }

  // The glass prison is a cut black diamond — the diamondProfile outline
  // (computeOutline) gives it the sharp rhombus silhouette; this paints the
  // gem material. Pre-baked: void interior + faceted glints + rim. Per-frame
  // render() overlays a red eye-glow pulse so it still reads as "something
  // alive is in there, watching". Drawing order: clip → void → facet glints
  // → specular highlight → facet seams → rim.
  private paintGlassPrisonBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    const verts: Vec[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      verts.push(v(Math.cos(angle) * r, Math.sin(angle) * r));
    }

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    ctx.clip();

    // Gem-black void — an offset upper-left hotspot so a lit facet and a
    // near-total-black shadow side fall out of one gradient, same as every
    // other lit body in this file. Never gets bright: this is black diamond,
    // not lit crystal, so the "lit" stop still sits in single-digit lightness.
    const lightX = -R * 0.4;
    const lightY = -R * 0.48;
    ctx.globalCompositeOperation = "source-over";
    const voidGrad = ctx.createRadialGradient(lightX, lightY, R * 0.1, 0, 0, R * 1.25);
    voidGrad.addColorStop(0, `hsla(${H + 6}, 45%, 9%, 1)`);
    voidGrad.addColorStop(0.55, `hsla(${H}, 35%, 4%, 1)`);
    voidGrad.addColorStop(1, `hsla(${H - 6}, 30%, 1.5%, 1)`);
    ctx.fillStyle = voidGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    // Faceted glints — same fan-triangulation as solid crystal, but additive
    // and very low-alpha: black diamond doesn't glow, it glints. Only the
    // facets nearest the light pick up a cold violet sheen; most of the
    // shell stays near-invisible against the void.
    const maxLightDist = R * 1.9;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const cx = (a.x + b.x) / 3;
      const cy = (a.y + b.y) / 3;
      const d = Math.hypot(cx - lightX, cy - lightY);
      const lit = Math.pow(Math.max(0, 1 - d / maxLightDist), 2.2);
      const lightness = 4 + lit * 22;
      const alpha = 0.08 + lit * 0.20;
      ctx.fillStyle = `hsla(${H + 12}, 65%, ${lightness}%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // Crisp specular highlight on the lit shoulder — the single cheapest
    // "this is a polished gem, not a matte rock" cue.
    const specX = lightX * 0.7;
    const specY = lightY * 0.7;
    const specGrad = ctx.createRadialGradient(specX, specY, 0, specX, specY, R * 0.32);
    specGrad.addColorStop(0, `hsla(${H + 20}, 70%, 92%, 0.65)`);
    specGrad.addColorStop(0.4, `hsla(${H + 16}, 70%, 70%, 0.22)`);
    specGrad.addColorStop(1, `hsla(${H + 16}, 70%, 70%, 0)`);
    ctx.fillStyle = specGrad;
    ctx.beginPath();
    ctx.arc(specX, specY, R * 0.32, 0, TAU);
    ctx.fill();

    // Hairline facet seams from centre to each vertex — cold and very faint,
    // just enough to read "cut gem" without lighting up the shell.
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = `hsla(${H + 10}, 60%, 60%, 0.12)`;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (const vtx of verts) {
      ctx.moveTo(0, 0);
      ctx.lineTo(vtx.x * 0.95, vtx.y * 0.95);
    }
    ctx.stroke();

    // Thick shell rim — two stacked strokes: an outer near-black layer for
    // depth/occlusion, a thin cold-bright inner band for the cut-edge catch.
    // Darker and cooler than the solid crystal so the prison reads as dense
    // black gem, not backlit glass.
    const rimPath = () => {
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
    };
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    ctx.strokeStyle = `hsla(${H - 10}, 40%, 2%, 0.95)`;
    ctx.lineWidth = 5.0;
    rimPath();
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 14}, 55%, 62%, 0.75)`;
    ctx.lineWidth = 1.8;
    rimPath();
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 24}, 50%, 88%, 0.4)`;
    ctx.lineWidth = 0.7;
    ctx.save();
    ctx.scale(0.94, 0.94);
    rimPath();
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  // Trace this asteroid's organic outline as a path (no fill/stroke). Shared by
  // the cathedral painters for clip + rim work.
  private traceOutline(ctx: CanvasRenderingContext2D, scale = 1) {
    ctx.beginPath();
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i] * scale;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // The chipped-masonry double rim every cathedral piece wears: a thick dark
  // outer stroke (occlusion contact against the starfield) + a thin bright
  // inset stroke (sunlit stone catching the upper-left light).
  private paintStoneRim(ctx: CanvasRenderingContext2D, H: number) {
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    ctx.strokeStyle = `hsla(${H}, 22%, 7%, 0.92)`;
    ctx.lineWidth = 3.0;
    this.traceOutline(ctx);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 6}, 18%, 72%, 0.45)`;
    ctx.lineWidth = 0.9;
    this.traceOutline(ctx, 0.96);
    ctx.stroke();
  }

  // Weathered raw-asteroid stone: an offset upper-left hot-spot body gradient +
  // a scatter of deterministic crater pits (each with a bright lit lip and a
  // dark floor) so the surface reads as living rock the architecture was carved
  // OUT OF — not a clean built wall. Seeded from the harmonic phases so each
  // bell weathers differently but stably across the bake.
  private paintAsteroidStone(ctx: CanvasRenderingContext2D, H: number, R: number) {
    ctx.globalCompositeOperation = "source-over";
    const stoneGrad = ctx.createRadialGradient(-R * 0.4, -R * 0.5, R * 0.1, 0, 0, R * 1.35);
    stoneGrad.addColorStop(0, `hsla(${H}, 13%, 56%, 1)`);
    stoneGrad.addColorStop(0.5, `hsla(${H}, 11%, 36%, 1)`);
    stoneGrad.addColorStop(1, `hsla(${H + 8}, 18%, 12%, 1)`);
    ctx.fillStyle = stoneGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.45, 0, TAU);
    ctx.fill();

    // Crater pits — concave dimples in the raw rock. Bright up-left lip, dark
    // down-right floor = a believable mini-terminator per pit.
    const seed = this.harmonics.reduce((s, h) => s + h.phase * h.freq, 0);
    const pitCount = 7;
    for (let i = 0; i < pitCount; i++) {
      const a = seed + (i / pitCount) * TAU + Math.sin(i * 2.1 + seed) * 0.6;
      const d = R * (0.30 + 0.55 * Math.abs(Math.cos(i * 1.7 + seed)));
      const px = Math.cos(a) * d;
      const py = Math.sin(a) * d;
      const pr = R * (0.10 + 0.09 * Math.abs(Math.sin(i * 1.3 + seed)));
      const floor = ctx.createRadialGradient(px + pr * 0.2, py + pr * 0.2, 0, px, py, pr);
      floor.addColorStop(0, `hsla(${H}, 16%, 14%, 0.5)`);
      floor.addColorStop(1, `hsla(${H}, 12%, 36%, 0)`);
      ctx.fillStyle = floor;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, TAU);
      ctx.fill();
      const lip = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, 0, px - pr * 0.4, py - pr * 0.4, pr * 0.9);
      lip.addColorStop(0, `hsla(${H + 10}, 14%, 66%, 0.32)`);
      lip.addColorStop(1, `hsla(${H}, 12%, 40%, 0)`);
      ctx.fillStyle = lip;
      ctx.beginPath();
      ctx.arc(px - pr * 0.4, py - pr * 0.4, pr * 0.9, 0, TAU);
      ctx.fill();
    }
  }

  // Draw a beveled recess into the stone: this is what sells "carved into the
  // asteroid" rather than "a window pasted on a wall". The opening is filled
  // dark (the hollow), then an inner highlight stroke on the upper-left edge
  // (stone catching light as it steps down) and a darker stroke on the lower-
  // right (the cut face in shadow). `pathFn(inset)` traces the opening at a
  // given inset so callers reuse their own opening shape.
  private paintCarvedRecess(ctx: CanvasRenderingContext2D, H: number, pathFn: (inset: number) => void) {
    ctx.fillStyle = `hsla(${H}, 14%, 30%, 1)`;
    pathFn(-3.0);
    ctx.fill();
    ctx.fillStyle = `hsla(${H}, 16%, 9%, 1)`;
    pathFn(-1.0);
    ctx.fill();
    ctx.save();
    pathFn(-3.0);
    ctx.clip();
    ctx.lineJoin = "round";
    ctx.strokeStyle = `hsla(${H + 8}, 16%, 70%, 0.6)`;
    ctx.lineWidth = 1.6;
    ctx.translate(-1.1, -1.1);
    pathFn(-1.2);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    pathFn(-3.0);
    ctx.clip();
    ctx.strokeStyle = `hsla(${H}, 22%, 6%, 0.7)`;
    ctx.lineWidth = 1.6;
    ctx.translate(1.1, 1.1);
    pathFn(-1.2);
    ctx.stroke();
    ctx.restore();
  }

  // Fill an opening with dead, unlit stained glass + leaded seams. `pathFn(inset)`
  // traces the opening; `top,bot` the vertical span for the tint gradient; `seams`
  // draws the leading inside a clip. (`_cx,_cy,_glowR` are vestigial from the lit
  // version's interior bleed, now removed.)
  private paintStainedGlass(
    ctx: CanvasRenderingContext2D,
    H: number,
    pathFn: (inset: number) => void,
    top: number,
    bot: number,
    _cx: number,
    _cy: number,
    _glowR: number,
    seams: () => void,
  ) {
    // Dead glass — the lights went out long ago. Only a faint cold tint
    // survives so you can still tell it WAS stained glass; no warmth, no glow.
    const glassGrad = ctx.createLinearGradient(0, top, 0, bot);
    glassGrad.addColorStop(0, `hsla(${H + 8}, 22%, 26%, 1)`);
    glassGrad.addColorStop(0.5, `hsla(${H}, 26%, 16%, 1)`);
    glassGrad.addColorStop(1, `hsla(${H - 12}, 24%, 9%, 1)`);
    ctx.fillStyle = glassGrad;
    pathFn(0);
    ctx.fill();

    ctx.save();
    pathFn(0);
    ctx.clip();
    ctx.strokeStyle = `hsla(${H - 10}, 32%, 8%, 0.85)`;
    ctx.lineWidth = 1.0;
    seams();
    ctx.restore();

    ctx.strokeStyle = `hsla(${H}, 12%, 72%, 0.85)`;
    ctx.lineWidth = 1.8;
    pathFn(0);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H}, 18%, 13%, 0.7)`;
    ctx.lineWidth = 0.9;
    pathFn(1.5);
    ctx.stroke();
  }

  // Lay a band of dressed masonry courses behind an archetype's feature so the
  // carved architecture sits on worked stone, not raw rock — offset-brick
  // mortar lines within the vertical band [yTop, yBot].
  private paintMasonryBand(ctx: CanvasRenderingContext2D, H: number, R: number, yTop: number, yBot: number) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(-R * 1.5, yTop, R * 3, yBot - yTop);
    ctx.clip();
    ctx.fillStyle = `hsla(${H}, 12%, 42%, 0.5)`;
    ctx.fillRect(-R * 1.5, yTop, R * 3, yBot - yTop);
    ctx.strokeStyle = `hsla(${H}, 18%, 8%, 0.6)`;
    ctx.lineWidth = 0.8;
    const courseH = R * 0.2;
    ctx.beginPath();
    for (let y = yTop; y <= yBot; y += courseH) {
      ctx.moveTo(-R * 1.5, y);
      ctx.lineTo(R * 1.5, y);
    }
    ctx.stroke();
    ctx.beginPath();
    const joint = R * 0.34;
    let row = 0;
    for (let y = yTop; y < yBot; y += courseH) {
      const stagger = row % 2 === 0 ? 0 : joint / 2;
      for (let col = -5; col <= 5; col++) {
        const x = col * joint + stagger;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + courseH);
      }
      row++;
    }
    ctx.stroke();
    ctx.restore();
  }

  // Trace a gothic lancet (pointed-arch) opening centred at cx.
  private lancetPath(ctx: CanvasRenderingContext2D, cx: number, halfW: number, top: number, bot: number, tip: number, inset: number) {
    const hw = halfW - inset;
    const t = top + inset;
    const b = bot - inset;
    const tp = tip + inset * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx - hw, b);
    ctx.lineTo(cx - hw, t);
    ctx.quadraticCurveTo(cx - hw, tp, cx, tp);
    ctx.quadraticCurveTo(cx + hw, tp, cx + hw, t);
    ctx.lineTo(cx + hw, b);
    ctx.closePath();
  }

  // A round rose / wheel window carved at (cx, cy) — dark and dead, its glass
  // gone out, only the leaded tracery and a faint cold tint remaining.
  private paintRoseWindow(ctx: CanvasRenderingContext2D, H: number, cx: number, cy: number, rr: number, petals: number) {
    const ringPath = (inset: number) => {
      ctx.beginPath();
      ctx.arc(cx, cy, rr - inset, 0, TAU);
    };
    this.paintCarvedRecess(ctx, H, ringPath);
    ctx.fillStyle = `hsla(${H + 4}, 24%, 14%, 1)`;
    ctx.beginPath();
    ctx.arc(cx, cy, rr - 1.2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H - 10}, 32%, 9%, 0.85)`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * (rr - 1.5), cy + Math.sin(a) * (rr - 1.5));
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 0.6, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H}, 12%, 72%, 0.8)`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `hsla(${H}, 14%, 34%, 0.9)`;
    ctx.beginPath();
    ctx.arc(cx, cy, rr * 0.16, 0, TAU);
    ctx.fill();
  }

  // ----- Archetype: lancet wall (the classic — one tall pointed window) -----
  private paintLancetWall(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.95, R * 0.55);
    const top = -R * 0.6, bot = R * 0.24, halfW = R * 0.22, tip = -R * 0.8;
    const path = (inset: number) => this.lancetPath(ctx, 0, halfW, top, bot, tip, inset);
    this.paintCarvedRecess(ctx, H, path);
    this.paintStainedGlass(ctx, H, path, top, bot, 0, (top + bot) / 2, R * 0.5, () => {
      ctx.beginPath();
      for (let i = 1; i <= 3; i++) {
        const x = -halfW + (i / 4) * (2 * halfW);
        ctx.moveTo(x, tip);
        ctx.lineTo(x, bot);
      }
      const ty = (top + bot) / 2 + R * 0.05;
      ctx.moveTo(-halfW, ty);
      ctx.lineTo(halfW, ty);
      ctx.stroke();
    });
    const sillW = halfW + R * 0.06;
    ctx.fillStyle = `hsla(${H}, 14%, 50%, 1)`;
    ctx.fillRect(-sillW, bot + R * 0.01, sillW * 2, R * 0.05);
    ctx.fillStyle = `hsla(${H}, 18%, 11%, 0.55)`;
    ctx.fillRect(-sillW, bot + R * 0.06, sillW * 2, R * 0.025);
    this.paintRoseWindow(ctx, H, 0, tip - R * 0.18, R * 0.1, 6);
  }

  // ----- Archetype: rose facade (a big wheel window over twin lancets) -----
  private paintRoseFacade(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.9, R * 0.7);
    this.paintRoseWindow(ctx, H, 0, -R * 0.28, R * 0.3, 8);
    const top = R * 0.12, bot = R * 0.6, halfW = R * 0.1, tip = R * 0.0;
    for (const cx of [-R * 0.22, R * 0.22]) {
      const path = (inset: number) => this.lancetPath(ctx, cx, halfW, top, bot, tip, inset);
      this.paintCarvedRecess(ctx, H, path);
      this.paintStainedGlass(ctx, H, path, top, bot, cx, (top + bot) / 2, R * 0.25, () => {
        ctx.beginPath();
        ctx.moveTo(cx, tip);
        ctx.lineTo(cx, bot);
        ctx.stroke();
      });
    }
  }

  // ----- Archetype: spire / belfry tower (tall, stacked slit openings) -----
  private paintSpireTower(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 1.0, R * 0.9);
    const halfW = R * 0.08;
    for (let i = 0; i < 3; i++) {
      const cy0 = -R * 0.55 + i * R * 0.42;
      const top = cy0, bot = cy0 + R * 0.26, tip = cy0 - R * 0.1;
      const path = (inset: number) => this.lancetPath(ctx, 0, halfW, top, bot, tip, inset);
      this.paintCarvedRecess(ctx, H, path);
      this.paintStainedGlass(ctx, H, path, top, bot, 0, (top + bot) / 2, R * 0.22, () => {
        ctx.beginPath();
        ctx.moveTo(0, tip);
        ctx.lineTo(0, bot);
        ctx.stroke();
      });
    }
    ctx.strokeStyle = `hsla(${H}, 12%, 76%, 0.85)`;
    ctx.lineWidth = 1.6;
    const fy = -R * 0.78;
    ctx.beginPath();
    ctx.moveTo(0, fy - R * 0.12);
    ctx.lineTo(0, fy + R * 0.1);
    ctx.moveTo(-R * 0.07, fy - R * 0.03);
    ctx.lineTo(R * 0.07, fy - R * 0.03);
    ctx.stroke();
  }

  // ----- Archetype: arcade (a row of small round-arch openings) -----
  private paintArcade(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.5, R * 0.5);
    const top = -R * 0.18, bot = R * 0.32, halfW = R * 0.13, tip = -R * 0.34;
    for (const cx of [-R * 0.5, 0, R * 0.5]) {
      const path = (inset: number) => this.lancetPath(ctx, cx, halfW, top, bot, tip, inset);
      this.paintCarvedRecess(ctx, H, path);
      this.paintStainedGlass(ctx, H, path, top, bot, cx, (top + bot) / 2, R * 0.28, () => {
        ctx.beginPath();
        ctx.moveTo(cx, tip);
        ctx.lineTo(cx, bot);
        ctx.stroke();
      });
    }
    ctx.fillStyle = `hsla(${H}, 14%, 50%, 1)`;
    ctx.fillRect(-R * 0.85, bot + R * 0.03, R * 1.7, R * 0.05);
    ctx.fillStyle = `hsla(${H}, 18%, 11%, 0.5)`;
    ctx.fillRect(-R * 0.85, bot + R * 0.08, R * 1.7, R * 0.025);
  }

  // ----- Archetype: buttressed ruin (a broken flying-buttress stub) -----
  private paintButtressRuin(ctx: CanvasRenderingContext2D, H: number, R: number) {
    this.paintMasonryBand(ctx, H, R, -R * 0.7, R * 0.8);
    ctx.save();
    ctx.strokeStyle = `hsla(${H}, 13%, 44%, 1)`;
    ctx.lineWidth = R * 0.16;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-R * 0.6, R * 0.55);
    ctx.quadraticCurveTo(-R * 0.1, -R * 0.1, R * 0.35, -R * 0.2);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 8}, 14%, 66%, 0.7)`;
    ctx.lineWidth = R * 0.04;
    ctx.beginPath();
    ctx.moveTo(-R * 0.6, R * 0.5);
    ctx.quadraticCurveTo(-R * 0.12, -R * 0.16, R * 0.33, -R * 0.25);
    ctx.stroke();
    ctx.restore();
    const top = -R * 0.45, bot = R * 0.2, halfW = R * 0.12, tip = -R * 0.6;
    const cx = R * 0.42;
    const path = (inset: number) => this.lancetPath(ctx, cx, halfW, top, bot, tip, inset);
    this.paintCarvedRecess(ctx, H, path);
    this.paintStainedGlass(ctx, H, path, top, bot, cx, (top + bot) / 2, R * 0.3, () => {
      ctx.beginPath();
      ctx.moveTo(cx, tip);
      ctx.lineTo(cx, bot);
      ctx.stroke();
    });
    ctx.fillStyle = `hsla(${H}, 16%, 24%, 0.8)`;
    for (let i = -2; i <= 2; i++) {
      const tx = i * R * 0.22;
      ctx.fillRect(tx, R * 0.6, R * 0.12, R * 0.18);
    }
  }

  // ===== Cathedral debris (terminal small fragments a bell shatters into) =====

  // A wedge-shaped keystone / arch voussoir — the dressed stone block that
  // locked an arch. Trapezoidal block face, chisel grooves, bright sunlit top.
  private paintKeystoneBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    ctx.globalCompositeOperation = "source-over";
    const face = ctx.createLinearGradient(-R, -R, R, R);
    face.addColorStop(0, `hsla(${H + 6}, 14%, 62%, 1)`);
    face.addColorStop(0.5, `hsla(${H}, 12%, 42%, 1)`);
    face.addColorStop(1, `hsla(${H + 8}, 16%, 18%, 1)`);
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.moveTo(-R * 0.62, -R * 0.5);
    ctx.lineTo(R * 0.62, -R * 0.5);
    ctx.lineTo(R * 0.4, R * 0.62);
    ctx.lineTo(-R * 0.4, R * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `hsla(${H}, 18%, 12%, 0.5)`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(i * R * 0.26, -R * 0.46);
      ctx.lineTo(i * R * 0.2, R * 0.56);
    }
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 8}, 16%, 74%, 0.7)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-R * 0.6, -R * 0.48);
    ctx.lineTo(R * 0.6, -R * 0.48);
    ctx.stroke();
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // A sharp sliver of dead stained glass — the light long gone out. A dark
  // splinter with a cold residual tint and a faint stone-grey edge catch.
  private paintGlassShardBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    ctx.globalCompositeOperation = "source-over";
    const glass = ctx.createLinearGradient(-R, -R, R, R);
    glass.addColorStop(0, `hsla(${H + 8}, 24%, 30%, 1)`);
    glass.addColorStop(0.5, `hsla(${H}, 26%, 17%, 1)`);
    glass.addColorStop(1, `hsla(${H - 14}, 24%, 9%, 1)`);
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.2, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H - 12}, 34%, 10%, 0.7)`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * 1.3 + 0.5;
      ctx.moveTo(-R * 0.2, -R * 0.15);
      ctx.lineTo(Math.cos(a) * R * 1.1 - R * 0.2, Math.sin(a) * R * 1.1 - R * 0.15);
    }
    ctx.stroke();
    ctx.fillStyle = `hsla(${H + 6}, 16%, 56%, 0.5)`;
    ctx.beginPath();
    ctx.ellipse(-R * 0.32, -R * 0.34, R * 0.18, R * 0.08, -0.7, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H - 8}, 40%, 8%, 0.9)`;
    ctx.lineWidth = 2.2;
    this.traceOutline(ctx);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 6}, 16%, 60%, 0.5)`;
    ctx.lineWidth = 0.9;
    this.traceOutline(ctx, 0.94);
    ctx.stroke();
    ctx.restore();
  }

  // A drum of a carved column / capital — a near-cylindrical stone section
  // with vertical fluting and a banded capital ring near the top.
  private paintColumnDrumBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    ctx.globalCompositeOperation = "source-over";
    const cyl = ctx.createLinearGradient(-R, 0, R, 0);
    cyl.addColorStop(0, `hsla(${H + 6}, 13%, 30%, 0.8)`);
    cyl.addColorStop(0.32, `hsla(${H + 8}, 14%, 64%, 0.85)`);
    cyl.addColorStop(0.6, `hsla(${H}, 12%, 40%, 0.7)`);
    cyl.addColorStop(1, `hsla(${H + 8}, 16%, 18%, 0.85)`);
    ctx.fillStyle = cyl;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.3, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H}, 18%, 12%, 0.45)`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = -3; i <= 3; i++) {
      const x = i * R * 0.22;
      ctx.moveTo(x, -R * 0.9);
      ctx.lineTo(x, R * 0.9);
    }
    ctx.stroke();
    ctx.fillStyle = `hsla(${H}, 14%, 52%, 1)`;
    ctx.fillRect(-R * 1.2, -R * 0.5, R * 2.4, R * 0.12);
    ctx.fillStyle = `hsla(${H}, 18%, 11%, 0.5)`;
    ctx.fillRect(-R * 1.2, -R * 0.38, R * 2.4, R * 0.04);
    ctx.fillStyle = `hsla(${H + 8}, 16%, 70%, 0.6)`;
    ctx.fillRect(-R * 1.2, -R * 0.52, R * 2.4, R * 0.03);
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // A plain chipped masonry block — the least adorned debris. Dressed-stone
  // courses + a single offset joint, weathered, no glass.
  private paintRubbleBlockBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = `hsla(${H}, 18%, 9%, 0.6)`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(-R * 1.3, -R * 0.2);
    ctx.lineTo(R * 1.3, -R * 0.12);
    ctx.moveTo(-R * 1.3, R * 0.38);
    ctx.lineTo(R * 1.3, R * 0.42);
    ctx.moveTo(R * 0.05, -R * 0.16);
    ctx.lineTo(R * 0.02, R * 0.4);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 8}, 16%, 72%, 0.45)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-R * 0.9, -R * 0.55);
    ctx.lineTo(R * 0.2, -R * 0.7);
    ctx.stroke();
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // Metal chunk / shard — a heavy tungsten block, not a plated hull panel. Deep
  // cold near-black steel with a faint blue cast, given cube-like volume by a
  // few big planar facets fanned off the real polygon corners: each facet takes
  // one FLAT lightness set by how much its outward normal faces the upper-left
  // light, so the face reads as cut planes meeting at hard edges rather than a
  // painted panel. A hard specular on the lit shoulder + a pinpoint corner glint
  // sell the dense-metal sheen; a two-stroke rim seats it against the starfield.
  // No rivets, seams, or gouges — this is a solid ingot, not riveted plate. Both
  // tiers share this; the shard is just a smaller block. Pre-baked, clipped to
  // the silhouette. Deterministic seed off the harmonics so each block is stably
  // distinct across the bake.
  private paintMetalChunkBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue, R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    ctx.globalCompositeOperation = "source-over";

    // Body: deep tungsten — near-black in shadow, dark cold steel through the
    // mid, only a restrained cool highlight up-left. Hue drifts a touch cooler
    // and darker into the far side. Much lower lightness than a hull plate so
    // it reads dense and heavy rather than sheet metal.
    const body = ctx.createRadialGradient(-R * 0.32, -R * 0.42, R * 0.05, 0, 0, R * 1.35);
    body.addColorStop(0, `hsla(${H - 4}, 14%, 40%, 1)`);
    body.addColorStop(0.5, `hsla(${H}, 18%, 19%, 1)`);
    body.addColorStop(1, `hsla(${H + 8}, 24%, 6%, 1)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.5, 0, TAU);
    ctx.fill();

    // Planar facets: fan triangles from the block's center out to each polygon
    // edge, and flat-shade each one by its outward-normal alignment to the
    // upper-left light. lit faces catch a cold pewter, away faces sink toward
    // black — the abrupt lightness step between neighbours is the cube read.
    const lightX = -0.7, lightY = -0.72; // upper-left
    const n = this.outlineSamples;
    const vert = (i: number): { x: number; y: number } => {
      const a = (i / n) * TAU;
      const r = this.outline[(i % n + n) % n];
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    };
    for (let i = 0; i < n; i++) {
      const p0 = vert(i), p1 = vert(i + 1);
      // Outward normal of this edge = its midpoint direction from center.
      const mx = (p0.x + p1.x) * 0.5, my = (p0.y + p1.y) * 0.5;
      const ml = Math.hypot(mx, my) || 1;
      const facing = (mx / ml) * lightX + (my / ml) * lightY; // -1..1
      // Flat plane lightness: bright pewter facing the light, near-black away.
      const L = 8 + Math.max(0, facing) * 34 + (facing < 0 ? facing * 8 : 0);
      const S = 12 + Math.max(0, facing) * 6;
      ctx.fillStyle = `hsla(${H - facing * 4}, ${S}%, ${Math.max(4, L)}%, 0.9)`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.closePath();
      ctx.fill();
    }

    // Interior crease lines from center to the CUBE CORNERS only — the hard
    // edges where the visible faces meet. A corner is a vertex where the
    // silhouette turns sharply (the two adjacent edges bend by a big angle), so
    // the mid-face samples of the rounded square are skipped and we get the ~3
    // creases of a cube seen in three-quarter, not 16 spokes. Bright lip on the
    // lit side, dark groove elsewhere.
    const edgeAngle = (i: number): number => {
      const p0 = vert(i), p1 = vert(i + 1);
      return Math.atan2(p1.y - p0.y, p1.x - p0.x);
    };
    for (let i = 0; i < n; i++) {
      // Turn angle at vertex i: how much the outline direction bends here.
      let turn = edgeAngle(i) - edgeAngle(i - 1);
      while (turn > Math.PI) turn -= TAU;
      while (turn < -Math.PI) turn += TAU;
      if (Math.abs(turn) < 0.45) continue; // mid-face sample, not a corner
      const p = vert(i);
      const pl = Math.hypot(p.x, p.y) || 1;
      const facing = (p.x / pl) * lightX + (p.y / pl) * lightY;
      ctx.strokeStyle = facing > 0.2
        ? `hsla(${H - 6}, 16%, 62%, 0.4)`
        : `hsla(${H}, 24%, 5%, 0.55)`;
      ctx.lineWidth = facing > 0.2 ? 1.0 : 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x * 0.1, p.y * 0.1);
      ctx.lineTo(p.x * 0.92, p.y * 0.92);
      ctx.stroke();
    }

    // Specular catch: one hard, tight bright blob on the lit upper-left shoulder
    // — a dense metal ingot throws a small crisp highlight, not a soft sheen.
    const spec = ctx.createRadialGradient(-R * 0.4, -R * 0.46, 0, -R * 0.4, -R * 0.46, R * 0.42);
    spec.addColorStop(0, `hsla(${H - 8}, 18%, 82%, 0.55)`);
    spec.addColorStop(0.4, `hsla(${H - 4}, 16%, 60%, 0.18)`);
    spec.addColorStop(1, `hsla(${H}, 16%, 50%, 0)`);
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(-R * 0.4, -R * 0.46, R * 0.42, 0, TAU);
    ctx.fill();

    // Pinpoint glint on the corner nearest the light — the single sharpest sheen
    // cue that says polished heavy metal.
    let best = vert(0), bestF = -2;
    for (let i = 0; i < n; i++) {
      const p = vert(i);
      const pl = Math.hypot(p.x, p.y) || 1;
      const f = (p.x / pl) * lightX + (p.y / pl) * lightY;
      if (f > bestF) { bestF = f; best = p; }
    }
    ctx.fillStyle = `hsla(${H - 10}, 20%, 92%, 0.7)`;
    ctx.beginPath();
    ctx.arc(best.x * 0.9, best.y * 0.9, Math.max(1.1, R * 0.05), 0, TAU);
    ctx.fill();

    // Two-stacked-stroke steel rim: a thick dark outer stroke for occlusion
    // contact against the starfield + a thin bright inset catch on the edge.
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    ctx.strokeStyle = `hsla(${H}, 28%, 4%, 0.96)`;
    ctx.lineWidth = 3.2;
    this.traceOutline(ctx);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H - 8}, 20%, 74%, 0.5)`;
    ctx.lineWidth = 1.1;
    this.traceOutline(ctx, 0.95);
    ctx.stroke();

    ctx.restore();
  }

  // The cathedral ("bell") asteroid reads as a fragment of a basilica that a
  // lost civilization carved out of an asteroid — weathered raw rock with
  // architecture recessed INTO it (beveled openings, not pasted-on walls).
  // Five archetypes (rolled at construction) give a row of bells real variety:
  // a lancet-window wall, a rose-window facade, a tapering belfry, an arcade of
  // small arches, and a buttressed ruin. Pre-baked, clipped to the organic
  // silhouette so the carved face bleeds into the chipped stone edge.
  private paintCathedralFragmentBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();
    this.paintAsteroidStone(ctx, H, R);
    switch (this.cathedralArchetype) {
      case "roseFacade": this.paintRoseFacade(ctx, H, R); break;
      case "spireTower": this.paintSpireTower(ctx, H, R); break;
      case "arcade": this.paintArcade(ctx, H, R); break;
      case "buttressRuin": this.paintButtressRuin(ctx, H, R); break;
      default: this.paintLancetWall(ctx, H, R); break;
    }
    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // Paint a faintly visible, blurred gold crystal inside the asteroid body —
  // the player has to *look* to spot it. Drawn at sprite-build time so it
  // pans/rotates with the rock for free. We clip to the asteroid outline so
  // the glow can't bleed past the silhouette and give away the secret. Note
  // the ctx.filter blur is applied inside a save/restore so it doesn't leak
  // to other passes.
  private paintEmbeddedGem(ctx: CanvasRenderingContext2D) {
    const GOLD_HUE = 46;
    ctx.save();
    // Clip to the asteroid silhouette so any blurred bleed stays inside.
    ctx.beginPath();
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();

    // Soft gold halo behind the crystal — sells the "something is glowing
    // through the rock" read even when the facet polygon is too small to
    // pick out by itself. Drawn first so the facets overprint it.
    ctx.globalCompositeOperation = "lighter";
    ctx.filter = "blur(6px)";
    const haloR = this.radius * 0.7;
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
    halo.addColorStop(0, `hsla(${GOLD_HUE}, 85%, 60%, 0.32)`);
    halo.addColorStop(0.55, `hsla(${GOLD_HUE - 6}, 80%, 50%, 0.16)`);
    halo.addColorStop(1, `hsla(${GOLD_HUE}, 80%, 50%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, TAU);
    ctx.fill();

    // Multi-faceted gem polygon — 6 vertices around a tilted hex with mild
    // per-vertex jitter so it reads as "hand-cut crystal" rather than a
    // perfect hexagon. Sized to ~35% of asteroid radius. Heavily blurred so
    // the silhouette is suggestive, not crisp.
    const facetCount = 6;
    const baseR = this.radius * 0.34;
    // Facet geometry is built at draw time and render doesn't run during the
    //   muted replay re-sim — so these MUST draw the cosmetic stream, or the
    //   per-gem draw count diverges between record and replay and desyncs.
    const tilt = cosmeticRand(0, TAU);
    const verts: { x: number; y: number }[] = [];
    for (let i = 0; i < facetCount; i++) {
      const a = tilt + (i / facetCount) * TAU;
      const rj = baseR * cosmeticRand(0.78, 1.08);
      verts.push({ x: Math.cos(a) * rj, y: Math.sin(a) * rj });
    }
    ctx.filter = "blur(3.5px)";
    // Fill — soft gold body.
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    const body = ctx.createRadialGradient(0, 0, 0, 0, 0, baseR);
    body.addColorStop(0, `hsla(${GOLD_HUE + 6}, 95%, 72%, 0.55)`);
    body.addColorStop(0.6, `hsla(${GOLD_HUE}, 90%, 55%, 0.4)`);
    body.addColorStop(1, `hsla(${GOLD_HUE - 8}, 85%, 40%, 0.18)`);
    ctx.fillStyle = body;
    ctx.fill();

    // Faint facet lines from centre to each vertex — gives the gem its
    // internal cut. Low alpha so they read as "hint of structure", not as
    // a vector diagram.
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = `hsla(${GOLD_HUE + 18}, 100%, 85%, 0.35)`;
    for (const vtx of verts) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(vtx.x, vtx.y);
      ctx.stroke();
    }

    // Tiny bright centre highlight so the eye lands on something specific
    // through the blur.
    ctx.filter = "blur(2px)";
    const corePulse = ctx.createRadialGradient(0, 0, 0, 0, 0, baseR * 0.35);
    corePulse.addColorStop(0, `hsla(${GOLD_HUE + 18}, 100%, 92%, 0.55)`);
    corePulse.addColorStop(1, `hsla(${GOLD_HUE + 6}, 95%, 70%, 0)`);
    ctx.fillStyle = corePulse;
    ctx.beginPath();
    ctx.arc(0, 0, baseR * 0.35, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  // Paint a faceted crystal body over the asteroid silhouette. The interior
  // facets are built by triangulating the silhouette polygon itself — each
  // triangle (apex → adjacent outer vertices) gets a fill tinted by its
  // distance from a virtual light source, so the gem reads as one coherent
  // refractive object rather than a polygon with disjoint sparkle stapled on.
  private paintSolidCrystalBody(ctx: CanvasRenderingContext2D) {
    // Glass-prison shard: same kind/outline/physics as a treat solidCrystalSmall,
    // but reads as a splinter of the black diamond it broke off from.
    if (this.isPrisonShard) { this.paintBlackDiamondShardBody(ctx); return; }
    const H = this.hue;
    const R = this.radius;
    // Outer polygon vertices in local space — the same hard polygon the
    // silhouette stroke draws. We reuse these for triangulation so the inner
    // facet seams land *on* the outer corners.
    const verts: Vec[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      verts.push(v(Math.cos(angle) * r, Math.sin(angle) * r));
    }

    ctx.save();
    // Clip to the silhouette so anything we draw stays inside the gem.
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    ctx.clip();

    // Virtual light source — sits up-left, just outside the gem. Each facet's
    // brightness comes from its centroid's distance to this point, so the
    // shading is continuous across the body and the gem looks like one solid
    // object catching light from one direction.
    const lightX = -R * 0.55;
    const lightY = -R * 0.6;
    const maxLightDist = R * 2.0;

    // Slightly inset "core" point each triangle fans from — offset toward the
    // light so the brightest pool isn't pinned to the exact geometric centre
    // (which always looks artificial). Tiny inset, no random jitter — keeps
    // every solid crystal coherent rather than each one looking ad-hoc.
    const coreX = -R * 0.08;
    const coreY = -R * 0.08;

    ctx.globalCompositeOperation = "source-over";

    // Triangulate the polygon as a fan around the core point. Each triangle
    // is one visible facet, shaded by its proximity to the virtual light.
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const cx = (coreX + a.x + b.x) / 3;
      const cy = (coreY + a.y + b.y) / 3;
      const d = Math.hypot(cx - lightX, cy - lightY);
      // 1.0 = right under the light, 0.0 = farthest facet. Power curve makes
      // the lit side noticeably brighter without crushing the shaded side.
      const lit = Math.pow(Math.max(0, 1 - d / maxLightDist), 1.6);
      const lightness = 14 + lit * 46;          // 14% (deep ice) → 60% (frosted highlight)
      // Saturation falls off toward the lit side — frosted ice scatters light
      // and reads near-white where it's hit, deep cool blue where it isn't.
      const sat = 85 - lit * 30;                // 85% (shaded) → 55% (lit, frost-pale)
      const alpha = 0.75 + lit * 0.2;
      ctx.fillStyle = `hsla(${H}, ${sat}%, ${lightness}%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(coreX, coreY);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // Hairline facet seams — the cuts between adjacent fan triangles. Drawn
    // as one path so the seam style is uniform and the alpha doesn't stack
    // at the core point.
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${H + 20}, 100%, 90%, 0.18)`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (const vtx of verts) {
      ctx.moveTo(coreX, coreY);
      ctx.lineTo(vtx.x * 0.96, vtx.y * 0.96);
    }
    ctx.stroke();

    // Frosted veil — a milky pale-blue ring sitting just inside the rim,
    // fading to transparent at the centre. Light scatters near the surface of
    // ice; this is the optical tell. Drawn additive so it brightens facets
    // underneath without flattening them.
    const frostGrad = ctx.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.0);
    frostGrad.addColorStop(0, `hsla(${H + 10}, 30%, 90%, 0)`);
    frostGrad.addColorStop(0.55, `hsla(${H + 8}, 45%, 85%, 0.12)`);
    frostGrad.addColorStop(0.85, `hsla(${H + 6}, 55%, 92%, 0.32)`);
    frostGrad.addColorStop(1, `hsla(${H + 4}, 60%, 96%, 0.45)`);
    ctx.fillStyle = frostGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    // Inner luminous core — small soft pool at the gem's heart, biased toward
    // the light. Sells the "you can see *into* the crystal" depth without
    // burning a bright spot onto the surface like the old highlight did.
    const coreGrad = ctx.createRadialGradient(
      coreX, coreY, 0,
      coreX, coreY, R * 0.55,
    );
    coreGrad.addColorStop(0, `hsla(${H + 15}, 40%, 95%, 0.45)`);
    coreGrad.addColorStop(0.5, `hsla(${H + 5}, 55%, 82%, 0.15)`);
    coreGrad.addColorStop(1, `hsla(${H}, 60%, 65%, 0)`);
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(coreX, coreY, R * 0.55, 0, TAU);
    ctx.fill();

    // Thick shell rim — three stacked strokes along the outer polygon read as
    // a chunky crystalline shell, not a hairline. Outer dark layer gives the
    // gem visible thickness, middle bright layer is the "cut glass" tell, and
    // a thin inner highlight catches the light along the inside of the shell.
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    const rimPath = () => {
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
    };
    // Small variant is more fragile — render with a thinner shell rim.
    const isSmall = this.kind === "solidCrystalSmall";
    // Outer dark shell — gives the rim visible depth before the bright band.
    ctx.strokeStyle = `hsla(${H - 10}, 70%, 22%, 0.85)`;
    ctx.lineWidth = isSmall ? 2.0 : 4.5;
    rimPath();
    ctx.stroke();
    // Frosted highlight band — softer and cooler than a cut-glass edge would
    // be. Lower saturation + a wider shadow blur reads as light scattering on
    // a rimey ice surface instead of a polished gem facet.
    ctx.strokeStyle = `hsla(${H + 18}, 45%, 92%, 0.75)`;
    ctx.lineWidth = isSmall ? 1.2 : 2.6;
    rimPath();
    ctx.stroke();
    // Inner hairline — sits just inside the bright band; the cool, low-sat
    // tint keeps it reading as ice rather than chrome.
    ctx.strokeStyle = `hsla(${H + 25}, 35%, 96%, 0.55)`;
    ctx.lineWidth = 0.8;
    ctx.save();
    ctx.scale(0.93, 0.93);
    rimPath();
    ctx.stroke();
    ctx.restore();

    this.paintFrostedEmbeddedGems(ctx);

    ctx.restore();
  }

  // A splinter of the black diamond prison — same silhouette/facet skeleton
  // as paintGlassPrisonBody's void + glint treatment, just scaled down to the
  // small shard outline with no rune/eye detail (too small to read at this
  // size; the parent's material alone sells "broken-off piece of that thing").
  private paintBlackDiamondShardBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    const verts: Vec[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      verts.push(v(Math.cos(angle) * r, Math.sin(angle) * r));
    }

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    ctx.clip();

    const lightX = -R * 0.4;
    const lightY = -R * 0.48;
    ctx.globalCompositeOperation = "source-over";
    const voidGrad = ctx.createRadialGradient(lightX, lightY, R * 0.1, 0, 0, R * 1.25);
    voidGrad.addColorStop(0, `hsla(${H + 6}, 45%, 10%, 1)`);
    voidGrad.addColorStop(0.55, `hsla(${H}, 35%, 5%, 1)`);
    voidGrad.addColorStop(1, `hsla(${H - 6}, 30%, 2%, 1)`);
    ctx.fillStyle = voidGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();

    const maxLightDist = R * 1.9;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const cx = (a.x + b.x) / 3;
      const cy = (a.y + b.y) / 3;
      const d = Math.hypot(cx - lightX, cy - lightY);
      const lit = Math.pow(Math.max(0, 1 - d / maxLightDist), 2.2);
      const lightness = 5 + lit * 24;
      const alpha = 0.10 + lit * 0.22;
      ctx.fillStyle = `hsla(${H + 12}, 65%, ${lightness}%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // One small specular spark on the lit shoulder — the shard's "it's a cut
    // gem, not a soot fleck" tell, cheap enough to keep even at this size.
    const specX = lightX * 0.7;
    const specY = lightY * 0.7;
    const specGrad = ctx.createRadialGradient(specX, specY, 0, specX, specY, R * 0.4);
    specGrad.addColorStop(0, `hsla(${H + 20}, 70%, 90%, 0.6)`);
    specGrad.addColorStop(1, `hsla(${H + 16}, 70%, 70%, 0)`);
    ctx.fillStyle = specGrad;
    ctx.beginPath();
    ctx.arc(specX, specY, R * 0.4, 0, TAU);
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";
    const rimPath = () => {
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
    };
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    ctx.strokeStyle = `hsla(${H - 10}, 40%, 3%, 0.9)`;
    ctx.lineWidth = 1.6;
    rimPath();
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 14}, 55%, 62%, 0.7)`;
    ctx.lineWidth = 0.9;
    rimPath();
    ctx.stroke();

    ctx.restore();
  }

  // Big chunky solid-gold diamond. Same fan-triangulation skeleton as the solid
  // crystal, retuned for cut metal: high-saturation gold facets with a hard
  // lit/shadow contrast, a brilliant-cut "table" inset so the gem reads as
  // faceted rather than a flat coin, a warm-dark depth rim + bright gold catch,
  // and a single white specular spark on the lit shoulder. No frost veil — gold
  // is reflective, not scattering — and the core glows warm instead of milky.
  private paintBurstGemBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    const isShard = false;
    const verts: Vec[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i];
      verts.push(v(Math.cos(angle) * r, Math.sin(angle) * r));
    }

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
      else ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    ctx.clip();

    // One light, upper-left. Each crown facet shades by its centroid's distance
    // to the light; the contrast is harder than ice so the gold reads metallic.
    const lightX = -R * 0.55;
    const lightY = -R * 0.6;
    const maxLightDist = R * 2.0;
    const coreX = -R * 0.06;
    const coreY = -R * 0.06;

    // The brilliant-cut "table" — a shrunken copy of the outer polygon. Crown
    // facets are the quads between the outer and table rings; the table itself
    // is the flat top plane catching the most light. tableScale tuned so the
    // table dominates (chunky brilliant) without swallowing the crown.
    const tableScale = 0.5;
    const table = verts.map((p) => v(p.x * tableScale, p.y * tableScale));

    ctx.globalCompositeOperation = "source-over";

    const goldFacet = (cx: number, cy: number, lift: number) => {
      const d = Math.hypot(cx - lightX, cy - lightY);
      const lit = Math.pow(Math.max(0, 1 - d / maxLightDist), 1.5);
      // Hard ramp: deep amber in shadow → near-white gold under the light.
      const lightness = 22 + lift + lit * 58;
      // Hue drifts warm-orange in shadow, pale-yellow in the light.
      const hue = H - 8 + lit * 10;
      const sat = 95 - lit * 22;
      return `hsl(${hue}, ${sat}%, ${Math.min(96, lightness)}%)`;
    };

    // Crown facets — the bevelled ring between the outer edge and the table.
    // Each is a quad (outer edge → table edge) shaded as its own plane.
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const ta = table[i];
      const tb = table[(i + 1) % verts.length];
      const cx = (a.x + b.x + ta.x + tb.x) / 4;
      const cy = (a.y + b.y + ta.y + tb.y) / 4;
      ctx.fillStyle = goldFacet(cx, cy, 0);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(tb.x, tb.y);
      ctx.lineTo(ta.x, ta.y);
      ctx.closePath();
      ctx.fill();
    }

    // The table plane — brightest, fanned into its own facets from the core so
    // the flat top still catches a graded sheen rather than a single flat fill.
    for (let i = 0; i < table.length; i++) {
      const a = table[i];
      const b = table[(i + 1) % table.length];
      const cx = (coreX + a.x + b.x) / 3;
      const cy = (coreY + a.y + b.y) / 3;
      ctx.fillStyle = goldFacet(cx, cy, 14);
      ctx.beginPath();
      ctx.moveTo(coreX, coreY);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // Facet seams — bright hairlines along the crown bevels + the table girdle.
    // Additive so the cut edges glint rather than darkening the metal.
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${H + 12}, 100%, 82%, 0.3)`;
    ctx.lineWidth = isShard ? 0.5 : 0.8;
    ctx.beginPath();
    for (let i = 0; i < verts.length; i++) {
      ctx.moveTo(verts[i].x, verts[i].y);
      ctx.lineTo(table[i].x, table[i].y);
    }
    // table girdle
    for (let i = 0; i < table.length; i++) {
      const a = table[i];
      const b = table[(i + 1) % table.length];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    // Warm inner glow — gold has depth, not a milky frost. Biased toward the
    // light so the brightest pool sits on the lit shoulder of the table.
    const coreGrad = ctx.createRadialGradient(coreX, coreY, 0, coreX, coreY, R * 0.5);
    coreGrad.addColorStop(0, `hsla(${H + 10}, 100%, 88%, 0.5)`);
    coreGrad.addColorStop(0.5, `hsla(${H}, 95%, 65%, 0.18)`);
    coreGrad.addColorStop(1, `hsla(${H - 6}, 90%, 50%, 0)`);
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(coreX, coreY, R * 0.5, 0, TAU);
    ctx.fill();

    // Single crisp specular spark on the lit shoulder — the cheapest "it's a
    // hard reflective solid" cue.
    const sparkR = R * (isShard ? 0.16 : 0.12);
    const spark = ctx.createRadialGradient(lightX * 0.5, lightY * 0.5, 0, lightX * 0.5, lightY * 0.5, sparkR);
    spark.addColorStop(0, "hsla(48, 100%, 98%, 0.9)");
    spark.addColorStop(1, "hsla(48, 100%, 90%, 0)");
    ctx.fillStyle = spark;
    ctx.beginPath();
    ctx.arc(lightX * 0.5, lightY * 0.5, sparkR, 0, TAU);
    ctx.fill();

    // Thick shell rim — warm-dark outer for occlusion depth + a bright gold
    // catch on top. Mitred so the cut corners stay sharp.
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    const rimPath = () => {
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
    };
    ctx.strokeStyle = `hsla(${H - 16}, 85%, 18%, 0.9)`;
    ctx.lineWidth = isShard ? 1.8 : 4.0;
    rimPath();
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 6}, 95%, 72%, 0.85)`;
    ctx.lineWidth = isShard ? 1.0 : 2.2;
    rimPath();
    ctx.stroke();

    ctx.restore();
  }

  // Heavily blurred gold gem hints visible through the crystal — same hue as
  // the Gem collectible they'll drop on death so the player can read
  // the loot in advance. Painted while the surrounding paintSolidCrystalBody
  // clip is still active, so any blurred bleed stays inside the silhouette.
  private paintFrostedEmbeddedGems(ctx: CanvasRenderingContext2D) {
    if (this.embeddedGemCount === 0) return;
    const GOLD_HUE = 46;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const spot of this.embeddedGemSpots) {
      ctx.save();
      ctx.translate(spot.x, spot.y);
      ctx.rotate(spot.tilt);
      // Soft halo behind the gem so it reads as "something glowing through
      // the ice" even when the hex polygon is too small to pick out.
      ctx.filter = "blur(5px)";
      const haloR = spot.r * 1.5;
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloR);
      halo.addColorStop(0, `hsla(${GOLD_HUE}, 90%, 65%, 0.55)`);
      halo.addColorStop(0.6, `hsla(${GOLD_HUE - 6}, 85%, 55%, 0.22)`);
      halo.addColorStop(1, `hsla(${GOLD_HUE}, 80%, 50%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, haloR, 0, TAU);
      ctx.fill();
      // Faceted gem body — heavy blur keeps the silhouette suggestive.
      const facetCount = 6;
      const verts: { x: number; y: number }[] = [];
      for (let i = 0; i < facetCount; i++) {
        const a = (i / facetCount) * TAU;
        // Draw-time facet jitter → cosmetic stream (render is skipped in the
        //   replay re-sim; gameplay stream here would desync). See paintEmbeddedGem.
        const rj = spot.r * cosmeticRand(0.82, 1.04);
        verts.push({ x: Math.cos(a) * rj, y: Math.sin(a) * rj });
      }
      ctx.filter = "blur(3px)";
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        if (i === 0) ctx.moveTo(verts[i].x, verts[i].y);
        else ctx.lineTo(verts[i].x, verts[i].y);
      }
      ctx.closePath();
      const body = ctx.createRadialGradient(0, 0, 0, 0, 0, spot.r);
      body.addColorStop(0, `hsla(${GOLD_HUE + 6}, 95%, 75%, 0.7)`);
      body.addColorStop(0.6, `hsla(${GOLD_HUE}, 90%, 58%, 0.5)`);
      body.addColorStop(1, `hsla(${GOLD_HUE - 8}, 85%, 42%, 0.22)`);
      ctx.fillStyle = body;
      ctx.fill();
      // Tiny bright core through the frost.
      ctx.filter = "blur(2px)";
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, spot.r * 0.4);
      core.addColorStop(0, `hsla(${GOLD_HUE + 18}, 100%, 92%, 0.7)`);
      core.addColorStop(1, `hsla(${GOLD_HUE + 6}, 95%, 70%, 0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, spot.r * 0.4, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // Pre-rendered modular bassteroid body. Hard-edged panels with bright
  // outlines, a tight halo, engine glow, and "running lights" give each kind
  // a memorable silhouette distinct from the organic shapes everything else
  // uses. Cracks and the beat-flash are drawn live in `render()` because
  // they animate per frame.
  buildBassteroidSprite(): HTMLCanvasElement {
    const haloRadius = this.radius * 1.6;
    const padding = 18;
    const size = Math.ceil(2 * (haloRadius + padding));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    this.spriteHalfSize = size / 2;
    const ship = this.bassShip!;
    const r = this.radius;
    const baseHue = this.hue;

    ctx.translate(size / 2, size / 2);
    ctx.globalCompositeOperation = "lighter";

    const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, haloRadius);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 60%, 0.22)`);
    halo.addColorStop(0.6, `hsla(${baseHue + 12}, 100%, 55%, 0.06)`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    const tracePanel = (module: BassModule) => {
      ctx.beginPath();
      for (let i = 0; i < module.vertices.length; i++) {
        const x = module.vertices[i].x * r;
        const y = module.vertices[i].y * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    // ---- Phase A: solid body (source-over) ----
    // Each panel is lit by a single upper-left sun, same recipe as the boss
    // body, so a bassteroid reads as a chunk of the same planetoid rather than
    // a flat neon decal. The fill is opaque (source-over) — this is matter,
    // not glow; the additive halo/lights come back in Phase C.
    ctx.globalCompositeOperation = "source-over";
    for (const module of ship.modules) {
      tracePanel(module);
      // Directional body gradient: hot-spot offset up-left, hue drifting warmer
      // and lighter in the lit corner, cooler and darker in shadow.
      const body = ctx.createLinearGradient(-r * 0.6, -r * 0.6, r * 0.6, r * 0.6);
      body.addColorStop(0, `hsl(${baseHue + 8}, 70%, 42%)`);
      body.addColorStop(0.5, `hsl(${baseHue}, 72%, 26%)`);
      body.addColorStop(1, `hsl(${baseHue - 8}, 78%, 11%)`);
      ctx.fillStyle = body;
      ctx.fill();
    }

    // Per-panel bevel: a bright strip along the top edge and a dark strip along
    // the bottom, clipped to the panel, so each plate catches the sun on its
    // upper lip and falls into shadow below — the boss-ring plate trick.
    for (const module of ship.modules) {
      ctx.save();
      tracePanel(module);
      ctx.clip();
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      for (const p of module.vertices) {
        minY = Math.min(minY, p.y * r); maxY = Math.max(maxY, p.y * r);
        minX = Math.min(minX, p.x * r); maxX = Math.max(maxX, p.x * r);
      }
      const w = maxX - minX;
      ctx.fillStyle = `hsla(${baseHue + 20}, 100%, 80%, 0.5)`;
      ctx.fillRect(minX, minY, w, 1.6);
      ctx.fillStyle = `hsla(${baseHue - 10}, 70%, 5%, 0.5)`;
      ctx.fillRect(minX, maxY - 1.6, w, 1.6);
      // Inner panel-line accent — a thin bright stripe through the panel so the
      // surface reads as plated metal rather than a flat fill.
      const cx = module.vertices.reduce((s, p) => s + p.x, 0) / module.vertices.length * r;
      const cy = module.vertices.reduce((s, p) => s + p.y, 0) / module.vertices.length * r;
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 85%, 0.45)`;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.4, cy);
      ctx.lineTo(cx + r * 0.4, cy);
      ctx.stroke();
      ctx.restore();
    }

    // Crater/mottle pass — a few deterministic craters (seeded from the hue so
    // they're stable) clipped to the panels. Each is a dark pit plus a bright
    // upper-left crescent rim, lit by the same sun. The single strongest "same
    // rock as the boss" cue. Clipped to the union of panels via per-panel clip.
    for (const module of ship.modules) {
      ctx.save();
      tracePanel(module);
      ctx.clip();
      const cx = module.vertices.reduce((s, p) => s + p.x, 0) / module.vertices.length * r;
      const cy = module.vertices.reduce((s, p) => s + p.y, 0) / module.vertices.length * r;
      for (let i = 0; i < 3; i++) {
        const s1 = Math.abs(Math.sin(baseHue * 12.9 + i * 78.2 + cx * 0.7));
        const s2 = Math.abs(Math.sin(baseHue * 39.3 + i * 17.7 + cy * 0.7));
        const s3 = Math.abs(Math.sin(baseHue * 4.41 + i * 91.0));
        const px = cx + (s1 - 0.5) * r * 0.7;
        const py = cy + (s2 - 0.5) * r * 0.7;
        const cr = r * (0.05 + s3 * 0.08);
        ctx.fillStyle = `hsla(${baseHue - 10}, 80%, 5%, 0.55)`;
        ctx.beginPath();
        ctx.arc(px, py, cr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = `hsla(${baseHue + 20}, 80%, 45%, 0.45)`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(px - cr * 0.25, py - cr * 0.25, cr * 0.85, Math.PI * 0.6, Math.PI * 1.7);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- Phase B: rim light (source-over) ----
    // Two stacked strokes on the panel outlines: a dark outer line that seats
    // the body against the dark backdrop, then a bright inner line that catches
    // the sun — the house-style rim that makes the boss read as solid. Drawn
    // per module so concave hulls keep a crisp edge.
    for (const module of ship.modules) {
      tracePanel(module);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `hsla(${baseHue}, 40%, 5%, 0.9)`;
      ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `hsla(${baseHue + 15}, 100%, 78%, 0.95)`;
      ctx.stroke();
    }

    // ---- Phase C: additive energy (lighter) ----
    // Running lights now read as brass power-cores fitted to a solid plate —
    // brass (hue ~48) is the boss eye-aperture colour, the shared family
    // signature marking both as built by the same hand.
    ctx.globalCompositeOperation = "lighter";
    for (const light of ship.lights) {
      const lx = light.pos.x * r;
      const ly = light.pos.y * r;
      const lr = light.size * r * 1.4;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr * 3);
      lg.addColorStop(0, `hsla(48, 100%, 96%, 1)`);
      lg.addColorStop(0.35, `hsla(${baseHue + 10}, 100%, 75%, 0.6)`);
      lg.addColorStop(1, `hsla(${baseHue}, 100%, 60%, 0)`);
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `hsla(48, 100%, 98%, 1)`;
      ctx.beginPath();
      ctx.arc(lx, ly, lr * 0.6, 0, TAU);
      ctx.fill();
    }

    return canvas;
  }

  // Burst gems are cut as a crisp d8 (octahedron) silhouette: a true rhombus
  // with STRAIGHT edges and sharp points, taller than wide. The rhombus support
  // function r(θ) = a·b / (b·|cosθ| + a·|sinθ|) gives dead-straight edges
  // between the four vertices (a = half-width, b = half-height), which reads as
  // a faceted die rather than the soft cosine-rounded gem we had before. The
  // upper crown is nudged a touch fuller than the lower pavilion so the top
  // point sits slightly proud, the way a real brilliant's crown does.
  private diamondProfile(angle: number): number {
    const a = 0.72; // half-width at the girdle (pulled in for a tall diamond)
    const b = 1.18; // half-height at the points (pushed out → sharp top/bottom)
    const c = Math.abs(Math.cos(angle));
    const s = Math.abs(Math.sin(angle));
    const rhombus = (a * b) / (b * c + a * s);
    const up = -Math.sin(angle); // +1 at top point, -1 at bottom point
    const crown = up > 0 ? 0.06 * up : 0; // crown slightly taller than pavilion
    return rhombus + crown;
  }

  // Square radius profile for the tungsten hull blocks: r = 1/max(|cos|,|sin|)
  // traces an exact square, so the block reads as a solid cube face rather than
  // a lumpy rock. The per-block tilt is SNAPPED to the outline sample grid
  // (TAU/outlineSamples) so a corner always lands on a vertex — otherwise the
  // fixed-angle sampler misses the corner apex and the square rounds off to a
  // near-circle. outlineSamples is a multiple of 4, so all four corners land.
  // The harmonic wobble in computeOutline rides on top for chipped-edge chunks.
  private cubeProfile(angle: number): number {
    const step = TAU / this.outlineSamples;
    const rawTilt = this.harmonics.reduce((s, h) => s + h.phase * h.freq, 0);
    const tilt = Math.round(rawTilt / step) * step;
    const a = angle - tilt;
    return 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
  }

  // Wedge geometry for a citadel fragment, in world px and cached (the outline
  // sampler and every collision test ask for it). The shape is the sector of a
  // disc of radius `arcR` centred on `apex` — which sits behind the fragment's
  // own centre, on the -x axis — spanning ±`halfSpan` about +x. Centring on the
  // sector's centroid rather than its apex is what makes it tumble like a chunk
  // of masonry instead of pivoting on its point. `radius` stays the bounding
  // radius: the sector is scaled to touch it at whichever point sits farthest
  // from that centroid.
  private wedgeCache: { apexX: number; arcR: number; halfSpan: number } | null = null;
  wedgeGeom(): { apexX: number; arcR: number; halfSpan: number } {
    if (this.wedgeCache) return this.wedgeCache;
    const halfSpan = WARBLE_WEDGE_SPAN[this.size] / 2;
    // Centroid of a unit sector sits this far along the axis from the apex.
    const g = (2 * Math.sin(halfSpan)) / (3 * halfSpan);
    // Farthest point from it: a corner where the arc meets a fracture face —
    // or, once the slice is thin enough, the middle of the arc.
    const corner = Math.hypot(Math.cos(halfSpan) - g, Math.sin(halfSpan));
    const k = this.radius / Math.max(corner, 1 - g);
    this.wedgeCache = { apexX: -g * k, arcR: k, halfSpan };
    return this.wedgeCache;
  }

  // Support radius of that wedge at a local angle, as a multiple of `radius`.
  // The ray out of the centre is clipped by the outer arc and by the two
  // fracture faces; the sector is convex, so whichever bites first IS the
  // boundary. Drives both the drawn outline and the collision surface, so the
  // visible edge stays the hitbox even though the silhouette is no longer a lump.
  private wedgeProfile(angle: number): number {
    const { apexX, arcR, halfSpan } = this.wedgeGeom();
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    // Outer arc: solve |t·û − apex| = arcR for the positive root.
    const ua = ux * apexX;
    let t = ua + Math.sqrt(Math.max(0, ua * ua + arcR * arcR - apexX * apexX));
    // Fracture faces: half-planes through the apex whose outward normals lean
    // ± across the span. A face only bounds the ray if the ray leans into it.
    const sinH = Math.sin(halfSpan);
    const cosH = Math.cos(halfSpan);
    for (const s of [1, -1]) {
      const denom = -sinH * ux + s * cosH * uy;
      if (denom > 1e-6) t = Math.min(t, (-sinH * apexX) / denom);
    }
    return t / this.radius;
  }

  computeOutline(): number[] {
    const isClamped = this.kind === "solidCrystal" || this.kind === "solidCrystalSmall" || isGlassPrison(this.kind) || this.kind === "bell" || isBurstGem(this.kind) || CATHEDRAL_DEBRIS_KINDS.includes(this.kind) || isMetalHull(this.kind);
    const isDiamond = isDiamondCut(this.kind) || this.isPrisonShard;
    const isCube = isMetalHull(this.kind);
    const isWedge = this.kind === "warble";
    const samples: number[] = [];
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      let r = 1;
      for (const harmonic of this.harmonics) {
        r += harmonic.amp * Math.cos(angle * harmonic.freq + harmonic.phase);
      }
      // Crystals + bell run with aggressive harmonic amps to get dramatic
      // shard / wall-chunk silhouettes; clamp so an unlucky phase alignment
      // can't collapse a vertex to (or past) the origin.
      if (isClamped) r = Math.max(0.45, Math.min(1.55, r));
      if (isDiamond) r *= this.diamondProfile(angle);
      if (isCube) r *= this.cubeProfile(angle);
      if (isWedge) r *= this.wedgeProfile(angle);
      samples.push(r * this.radius);
    }
    return samples;
  }

  radiusAtAngle(angle: number): number {
    let r = 1;
    for (const harmonic of this.harmonics) {
      r += harmonic.amp * Math.cos(angle * harmonic.freq + harmonic.phase);
    }
    // Mirror the clamp in computeOutline so the collision surface matches
    // the visible silhouette for the high-amp crystal / cathedral harmonics.
    if (this.kind === "solidCrystal" || this.kind === "solidCrystalSmall" || isGlassPrison(this.kind) || this.kind === "bell" || isBurstGem(this.kind) || isMetalHull(this.kind)) {
      r = Math.max(0.45, Math.min(1.55, r));
    }
    if (isDiamondCut(this.kind) || this.isPrisonShard) r *= this.diamondProfile(angle);
    if (isMetalHull(this.kind)) r *= this.cubeProfile(angle);
    if (this.kind === "warble") r *= this.wedgeProfile(angle);
    return r * this.radius;
  }

  // A phased rock (warble / citadel) in the dim stretch of its cycle is phased
  // out: intangible to both bullets and the ship, just like a dormant boss.
  // Driven by bassClock from the music clock so the ghost-window lines up with
  // the visible fade. The citadel's inner wall is the one exception — see
  // citadelInnerHit.
  isPhasedOut(): boolean {
    return isPhasedKind(this.kind) && !this.warbleSolid;
  }

  // True when the point sits inside the citadel's ship-shaped escape hole
  // (body-local, rotating with the shell). The hole is permanently safe: no
  // collision for the ship or for bullets whose centre is still inside it.
  citadelHoleContains(px: number, py: number): boolean {
    const [dx, dy] = toroidalDelta(px - this.pos.x, py - this.pos.y, WORLD_W, WORLD_H);
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    return pointInTriangle(dx * cos - dy * sin, dx * sin + dy * cos, CITADEL_HOLE_VERTS);
  }

  // The citadel's intended kill: a bullet fired from within the escape hole
  // strikes the unarmoured inner wall — even while the shell is phased out.
  // Collision handlers use this alongside collidesWith; a true result also
  // means the hit should bypass damageReduction.
  citadelInnerHit(firePos: Vec | null, point: Vec, pointRadius: number): boolean {
    if (this.kind !== "citadel" || !firePos) return false;
    if (!this.citadelHoleContains(firePos.x, firePos.y)) return false;
    // Still travelling inside the hole — no wall contact yet.
    if (this.citadelHoleContains(point.x, point.y)) return false;
    const [dx, dy] = toroidalDelta(point.x - this.pos.x, point.y - this.pos.y, WORLD_W, WORLD_H);
    const distance = Math.hypot(dx, dy);
    const surface = this.radiusAtAngle(Math.atan2(dy, dx) - this.rotation);
    return distance < surface + pointRadius;
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    // Dormant boss is intangible during the 8s grow-and-reveal — neither
    // bullets nor the ship can interact with the looming silhouette. The
    // transition to "live" enables both at once on the same frame as the
    // eye opens.
    if (this.isDormantSilhouette()) return false;
    // Phased-out warble/citadel: bullets and the ship pass clean through
    // during the dim window.
    if (this.isPhasedOut()) return false;
    // The citadel's escape hole is safe even while the shell is solid.
    if (this.kind === "citadel" && this.citadelHoleContains(point.x, point.y)) return false;
    const hit = this.hitTest(point, pointRadius);
    // Real contact ends the entrance presentation so the impact and its
    // effects land at the true torus position (see game/entrance.ts).
    if (hit) completeEntrance(this);
    return hit;
  }

  private hitTest(point: Vec, pointRadius: number): boolean {
    const [dx, dy] = toroidalDelta(point.x - this.pos.x, point.y - this.pos.y, WORLD_W, WORLD_H);
    const distance = Math.hypot(dx, dy);
    if (distance > this.radius * 1.3 + pointRadius) return false;
    // Bassteroids are modular silhouettes, not organic blobs — use a tight
    // circle for the hitbox. 0.88 is a feel-tuned shrink so glancing shots
    // miss the gaps between modules instead of registering on empty space.
    if (this.isBass()) return distance < this.radius * 0.88 + pointRadius;
    // Boss planetoid is a round body — circle hitbox at near-full radius.
    // Boss-family fragments use the same circular hitbox at slightly looser
    // radius so all the awkward shard shapes register cleanly.
    if (this.isBoss() || this.isSepulchre()) return distance < this.radius * 0.95 + pointRadius;
    if (this.isBossFragment()) return distance < this.radius * 0.92 + pointRadius;
    // Torus kinds carry an explicit circular hitbox (the whole ring's outer
    // radius; each arc/chunk's chord-derived radius from makeTorusArc). They
    // never went through the organic harmonic outline, so use a plain circle.
    if (this.kind === "torus") return distance < this.radius * 0.97 + pointRadius;
    if (this.kind === "torusArc" || this.kind === "torusChunk") return distance < this.radius + pointRadius;
    const localAngle = Math.atan2(dy, dx) - this.rotation;
    const surface = this.radiusAtAngle(localAngle);
    return distance < surface + pointRadius;
  }

  hit() {
    this.flashAmount = 1;
  }

  // Effective armour for a hit landing at `point`. The boss hemisphere's
  // armour is directional: the rounded outer shell keeps its damage reduction
  // while the freshly-cut flat face is bare molten interior. Side test is the
  // sign of the hit's local x — the half-disc body lives on +x (see
  // renderBossHemisphere). Every other kind (or a caller with no hit
  // position) gets the flat damageReduction.
  damageReductionAt(point: Vec | null): number {
    if (this.kind !== "bossHemisphere" || !point) return this.damageReduction;
    const [dx, dy] = toroidalDelta(point.x - this.pos.x, point.y - this.pos.y, WORLD_W, WORLD_H);
    const facing = this.rotation + this.bossFragmentAngle;
    return dx * Math.cos(facing) + dy * Math.sin(facing) > 0 ? this.damageReduction : 0;
  }

  // Apply `amount` damage to this asteroid. Armour is subtracted first —
  // resolved through damageReductionAt when the caller passes the hit
  // position, so the hemisphere's bare cut face takes full damage; a hit that
  // doesn't break through deals no HP loss and reports `bounced` so the
  // caller can deflect the shot instead of consuming it as a real hit.
  // Decrements HP and returns whether it's now dead. Non-killing hits reveal
  // one or more cracks (the number revealed scales with the damage dealt so a
  // 4-damage rhythm hit visibly cracks the asteroid harder than a 1-damage
  // plain hit, even if it didn't kill). Caller is responsible for sound,
  // particles, and split.
  // `ignoreArmor` is the citadel inner-wall path: a shot from inside the
  // escape hole lands its full damage regardless of damageReduction.
  applyDamage(amount: number = 1, ignoreArmor: boolean = false, hitPoint: Vec | null = null): { killed: boolean; bounced: boolean; dealt: number } {
    const dealt = Math.max(0, amount - (ignoreArmor ? 0 : this.damageReductionAt(hitPoint)));
    if (dealt <= 0) return { killed: false, bounced: true, dealt: 0 };
    this.hp = Math.max(0, this.hp - dealt);
    this.flashAmount = 1;
    return { killed: this.hp <= 0, bounced: false, dealt };
  }

  // a non-killing hit should visibly shove the target — fraction of "kill-worth"
  // damage maps to a fraction of a reference speed bump along the impact direction.
  // Heavier targets (high maxHp + armor) get pushed proportionally less for the
  // same damage; counting damageReduction keeps a low-hp armored crystal from
  // weighing nothing and taking the full reference speed per blocked shot.
  applyKnockback(dirX: number, dirY: number, amount: number, referenceSpeed: number = 120) {
    const len = Math.hypot(dirX, dirY);
    if (len === 0) return;
    const fraction = Math.min(1, amount / Math.max(1, this.maxHp + this.damageReduction));
    const dv = fraction * referenceSpeed;
    this.vel.x += (dirX / len) * dv;
    this.vel.y += (dirY / len) * dv;
  }

  update(dt: number, w: number, h: number) {
    // Torus fragments don't integrate their own position — their pos + rotation
    // are dictated by the shared phantom ring, recomputed once per frame in
    // tickTorusGroup. Tick only the cheap decays here and bail before the
    // standard linear integration (which would fight the orbit).
    if (this.kind === "torusArc" || this.kind === "torusChunk") {
      this.membranePhase += dt * 0.8;
      if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
      return;
    }
    this.rotation += this.rotSpeed * dt;
    this.membranePhase += dt * 0.8;
    addScaledMut(this.pos, this.vel, dt);
    const off = foldWithEntrance(this, w, h);
    // Carry the drone trail (gen-0 large) across a fold so the wake stays
    // attached at the seam. The radiator is deliberately untouched — each
    // wave anchors to its own emission origin, so a fold simply means future
    // waves emit from the new side while older waves age out where they were.
    if (off && this.trail) this.trail.shift(off.x, off.y);
    if (this.trail) this.trail.update(dt, this.pos.x, this.pos.y);
    if (this.radiator) this.radiator.update(dt, this.pos.x, this.pos.y, this.vel.x, this.vel.y);
    // Ease the displayed laser aim toward the committed aim so the telegraph
    // and beam slew smoothly across the discrete per-beat re-target steps.
    if (this.isBoss() || this.kind === "bossEye") {
      const committed = Math.atan2(this.bossEyeAimY - this.pos.y, this.bossEyeAimX - this.pos.x);
      if (this.bossAimDisplayAngle === -999) {
        this.bossAimDisplayAngle = committed;
      } else {
        let d = committed - this.bossAimDisplayAngle;
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        // Exponential approach with a ~150ms time constant (1 - e^(-dt/τ)).
        const k = 1 - Math.exp(-dt / AIM_DISPLAY_TAU);
        this.bossAimDisplayAngle += d * k;
      }
    }
    if (this.flashAmount > 0) this.flashAmount = Math.max(0, this.flashAmount - dt * 4);
    // Beat flare decays a touch slower than the hit flash so the visible
    // pulse rides the audio kick all the way through the beat window.
    if (this.beatFlash > 0) this.beatFlash = Math.max(0, this.beatFlash - dt * 2.6);
    // Echo outlives the flash so the expanding combo-halo ring rides well past
    // the on-beat bloom; slow enough to read as a soundwave dissipating.
    if (this.haloEcho > 0) this.haloEcho = Math.max(0, this.haloEcho - dt * 0.85);
    if (this.bossTopFlash > 0) this.bossTopFlash = Math.max(0, this.bossTopFlash - dt * 1.6);
    if (this.bossBottomFlash > 0) this.bossBottomFlash = Math.max(0, this.bossBottomFlash - dt * 1.6);
    if (this.bossIrisFlash > 0) this.bossIrisFlash = Math.max(0, this.bossIrisFlash - dt * 1.8);
    if (this.bossPupilFlash > 0) this.bossPupilFlash = Math.max(0, this.bossPupilFlash - dt * 2.4);
    // Whole-body boss reveal: ticks the dormant timer toward revealDuration,
    // then transitions to live. While dormant the asteroid cannot take
    // damage (gateApplyDamage) and the eye cannot fire. Rendering holds a
    // quiet black silhouette for most of the window, then shudders, dusts off
    // its crust, and opens the eye in the trailing revealActiveDuration.
    if (this.hasRevealPhase() && this.bossPhase === "dormant") {
      this.bossRevealT += dt;
      if (this.bossRevealT >= this.revealTiming().total) {
        this.bossPhase = "live";
        // One-shot edge flag picked up next frame by gameUpdate to play the
        // dissonant eye-open stinger and zero out the player's combo. Cleared
        // after the consumer reads it.
        this.bossJustOpenedEye = this.isBoss();
        // Reset rhythm state so the first cycle's beat 1 lands wherever
        // game.beatTime currently is, not back-dated to a stale cooldown.
        this.bossRhythmT = 0;
        this.bossDidTop = false;
        this.bossDidBottom = false;
        this.bossDidIris = false;
        this.bossDidPupil1 = false;
        this.bossDidPupil2 = false;
        this.bossPlasmaFired = false;
      }
    }
    // Nucleus orbital drift is baked into the sprite so we no longer rotate
    // it here — the per-frame pulse highlight handles the only visible motion.
  }

  // Update the iris to track the player. Caller (gameUpdate) passes the
  // current ship position so the boss/eye can do its slit-pupil aim. Done
  // outside `update()` because the asteroid module doesn't know about Ship.
  trackPlayer(shipX: number, shipY: number) {
    if (!this.isBoss() && this.kind !== "bossEye") return;
    // Cache for the windup aim slew in tickLaserAim.
    this.bossTrackedShipX = shipX;
    this.bossTrackedShipY = shipY;
    // Seed the locked aim on the first track so the telegraph doesn't slew
    // up from the (0,0) origin on the eye's first live frame.
    if (this.bossEyeAimX === 0 && this.bossEyeAimY === 0) {
      this.bossEyeAimX = shipX;
      this.bossEyeAimY = shipY;
    }
    const target = Math.atan2(shipY - this.pos.y, shipX - this.pos.x);
    // Smoothly slew the iris toward the player along the shorter angular
    // path. Constant lerp factor keeps it from snapping during dodges so the
    // sightline (when a telegraph is up) reads as a deliberate aim.
    let diff = target - this.bossIrisAngle;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    this.bossIrisAngle += diff * 0.18;
    // The worldspace aim point is no longer slewed here — the targeting line
    // snaps to the player on each windup beat inside tickBossRhythm, so it
    // reads as a discrete "re-target" tick rather than a smooth drag.
  }

  // Tick the targeting aim toward the player once per beat across the windup.
  // Beats 4..7 land at t = 1.5, 2.0, 2.5, 3.0 → indices 0..3. On each new
  // beat the aim *rotates* toward the player by at most a capped angular step,
  // so the sightline slews around like a turret rather than snapping onto a
  // moving target. The cap means a player who keeps circling the boss can
  // outrun the sweep — the shot only lands if you let the line catch you.
  // Beat 7 (index 3) is the final tick; the aim then holds all the way to the
  // fire, so juking after the last tick slips the shot. Outside the windup
  // the aim tracks the player each frame so an idle eye still looks alive.
  // `tNow` is the phase within the 8.0s cycle.
  private tickLaserAim(tNow: number) {
    // The aim re-targets only on the 4 windup beats (t = 1.5, 2.0, 2.5, 3.0).
    // From the last tick it must HOLD through the fire so the shot commits to
    // the telegraphed line, not to wherever the ship slipped to by the fire
    // frame — that hold is what lets a running player slip the shot. Only once
    // the cycle has wrapped back into its early "idle" stretch (before the next
    // windup) do we resume tracking the live ship position so an idle eye still
    // looks alive.
    const inWindup = tNow >= LASER_AIM_START && tNow < LASER_AIM_END;
    const inIdle = tNow < LASER_AIM_START;
    if (inIdle) {
      this.bossAimBeatIndex = -1;
      this.bossEyeAimX = this.bossTrackedShipX;
      this.bossEyeAimY = this.bossTrackedShipY;
      return;
    }
    if (!inWindup) return; // post-aim hold: keep the locked aim frozen to fire
    const beatIndex = Math.floor((tNow - LASER_AIM_START) / 0.5);
    if (beatIndex > this.bossAimBeatIndex) {
      this.bossAimBeatIndex = beatIndex;
      // Current aim direction and the direction to the player, both as angles.
      const cur = Math.atan2(this.bossEyeAimY - this.pos.y, this.bossEyeAimX - this.pos.x);
      const target = Math.atan2(this.bossTrackedShipY - this.pos.y, this.bossTrackedShipX - this.pos.x);
      // Shortest signed angular gap.
      let diff = target - cur;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      // Turn toward the player, but no faster than MAX_AIM_TURN_PER_BEAT.
      const turn = Math.max(-MAX_AIM_TURN_PER_BEAT, Math.min(MAX_AIM_TURN_PER_BEAT, diff));
      const next = cur + turn;
      // Re-project the aim point out to the player's distance so the telegraph
      // line reaches the same span as the shot.
      const dist = Math.max(1, Math.hypot(this.bossTrackedShipX - this.pos.x, this.bossTrackedShipY - this.pos.y));
      this.bossEyeAimX = this.pos.x + Math.cos(next) * dist;
      this.bossEyeAimY = this.pos.y + Math.sin(next) * dist;
    }
  }

  // Drives a wraith's stalk/strike cycle and writhe phase. Called once per tick
  // from the game loop with dt + ship position + ship heading + beatTime, and
  // updates velocity in place. The rotation field is overwritten with the gaze
  // angle so the renderer can place the eyes along it.
  //
  // The whole entity is built around one decision the player keeps having to
  // make: face it, or run from it.
  //   FAR — "stalk": it steers for a standoff anchor cfg.flankDist behind the
  //     ship's tail, with a tangential swirl term so it arcs around rather than
  //     driving straight in. Turning to face it moves the anchor to your new
  //     tail, so it has to give up the approach and start the arc over. Keeping
  //     your nose on it is an actual defensive option.
  //   CLOSE — it holds a tight orbit and strikes on the beat:
  //     windup (brakes hard, coils, eyes flare — the readable telegraph)
  //     → lunge (direction LOCKED at ignition, so it is dodgeable)
  //     → recover (unsteered and heavily damped: the window to kill it).
  // Close/far uses hysteresis (lungeRange in, stalkRange out) so a wraith
  // hovering at the boundary doesn't stutter between the two.
  //
  // Returns "windup"/"lunge" on the tick that phase ignites so the caller can
  // play the matching SFX, else null.
  tickWraith(dt: number, shipX: number, shipY: number, shipHeading: number, beatTime: number): "windup" | "lunge" | null {
    if (this.kind !== "wraith") return null;
    const cfg = ENTITY_CONFIG.wraith;
    // Emerge fade-in over emergeDuration. While < 1, damage gating + visuals
    // both scale down — the wraith should not feel suddenly there.
    if (this.wraithEmerge < 1) {
      this.wraithEmerge = Math.min(1, this.wraithEmerge + dt / cfg.emergeDuration);
    }
    // Writhe advances steadily; tendril/body deformation reads from it.
    this.writhePhase += dt * 2.2;

    const dx = shipX - this.pos.x;
    const dy = shipY - this.pos.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const toShipX = dx / dist;
    const toShipY = dy / dist;
    // Gaze: at the ship, except mid-lunge, where the eyes stay on the committed
    // line so a dodged strike visibly overshoots.
    this.rotation = this.wraithMode === "lunge"
      ? Math.atan2(this.lungeDirY, this.lungeDirX)
      : Math.atan2(dy, dx);

    // Nothing steers or strikes until it has finished manifesting.
    if (this.wraithEmerge < 1) return null;

    // Close/far latch with hysteresis.
    if (!this.wraithClose && dist <= cfg.lungeRange) this.wraithClose = true;
    else if (this.wraithClose && dist > cfg.stalkRange) this.wraithClose = false;

    // Tangential unit vector around the ship, on this wraith's preferred side.
    const swirlX = -toShipY * this.wraithSwirlDir;
    const swirlY = toShipX * this.wraithSwirlDir;

    let event: "windup" | "lunge" | null = null;
    // Only the far-and-not-behind-you branch below re-raises this.
    this.wraithCircling = false;
    if (this.wraithMode === "windup") {
      this.windupActiveT = Math.max(0, this.windupActiveT - dt);
      this.wraithModeT = this.windupActiveT;
      // Coil: brake hard so the strike starts from near-stationary and the
      // telegraph is a visible stop, not just a colour change.
      const brake = 1 / (1 + cfg.windupDrag * dt);
      this.vel.x *= brake;
      this.vel.y *= brake;
      if (this.windupActiveT <= 0) {
        // Commit. Direction is locked HERE, from where the ship is at ignition.
        this.wraithMode = "lunge";
        this.lungeActiveT = cfg.lungeDuration;
        this.wraithModeT = cfg.lungeDuration;
        this.lungeDirX = toShipX;
        this.lungeDirY = toShipY;
        event = "lunge";
      }
    } else if (this.wraithMode === "lunge") {
      this.lungeActiveT = Math.max(0, this.lungeActiveT - dt);
      this.wraithModeT = this.lungeActiveT;
      // Charge along the locked ray — no re-homing.
      const burst = cfg.lungeAccel * dt;
      this.vel.x += this.lungeDirX * burst;
      this.vel.y += this.lungeDirY * burst;
      if (this.lungeActiveT <= 0) {
        this.wraithMode = "recover";
        this.wraithModeT = cfg.recoverDuration;
      }
    } else if (this.wraithMode === "recover") {
      this.wraithModeT = Math.max(0, this.wraithModeT - dt);
      // Spent: no steering at all, just drag. This is the player's opening.
      const damp = 1 / (1 + cfg.recoverDrag * dt);
      this.vel.x *= damp;
      this.vel.y *= damp;
      if (this.wraithModeT <= 0) {
        this.wraithMode = "stalk";
        // Hover before the next strike, and forget the beat slot so re-arming
        // waits for a fresh crossing rather than firing off a stale one.
        this.wraithStrikeCooldown = cfg.strikeCooldown;
        this.wraithBeatSlot = -1;
      }
    } else if (this.wraithClose) {
      // Close and idle: hold a tight predatory orbit at the strike radius while
      // waiting for the beat. Radial term corrects toward the hold distance so
      // it neither drifts off nor crowds straight in.
      const holdDist = cfg.lungeRange * 0.6;
      const radial = Math.max(-1, Math.min(1, (dist - holdDist) / holdDist));
      const accel = cfg.stalkAccel * dt;
      this.vel.x += toShipX * radial * accel + swirlX * cfg.swirlAccel * dt;
      this.vel.y += toShipY * radial * accel + swirlY * cfg.swirlAccel * dt;
      // Strikes ignite on the beat grid so the fight sits inside the music.
      // Snapped to a half-measure; the per-wraith swirl side plus staggered
      // recover timings keep a brood from firing in lockstep.
      const slot = Math.floor(beatTime / WRAITH_STRIKE_GRID);
      if (this.wraithStrikeCooldown > 0) {
        this.wraithStrikeCooldown = Math.max(0, this.wraithStrikeCooldown - dt);
        this.wraithBeatSlot = slot;
      } else if (this.wraithBeatSlot < 0) {
        this.wraithBeatSlot = slot;
      } else if (slot > this.wraithBeatSlot) {
        this.wraithBeatSlot = slot;
        this.wraithMode = "windup";
        this.windupActiveT = cfg.windupDuration;
        this.wraithModeT = cfg.windupDuration;
        event = "windup";
      }
    } else {
      // Far: work around to the player's blind side, and only then close.
      this.wraithBeatSlot = -1;
      // Bearing = where the wraith sits relative to the ship's nose, wrapped to
      // (-pi, pi]. 0 means dead ahead of the ship; ±pi means directly behind it.
      let bearing = Math.atan2(this.pos.y - shipY, this.pos.x - shipX) - shipHeading;
      while (bearing > Math.PI) bearing -= TAU;
      while (bearing < -Math.PI) bearing += TAU;
      // Sweep direction: whichever way round the ship shortens the trip to the
      // tail. Dead ahead (where both ways are equal) it falls back to this
      // wraith's own preferred side, so a brood peels off in both directions.
      const sweep = Math.abs(bearing) < 0.35 ? this.wraithSwirlDir : Math.sign(bearing) || 1;
      // Counter-clockwise tangent around the ship; times `sweep` it points the
      // short way toward the tail.
      const tanX = toShipY * sweep;
      const tanY = -toShipX * sweep;
      const accel = cfg.stalkAccel * dt;
      const swirl = cfg.swirlAccel * dt;
      const isCircling = Math.abs(bearing) < cfg.behindAngle;
      if (isCircling) {
        // Still inside the player's forward arc: hold the standoff ring and
        // sweep sideways. Facing it pins it out here — it will circle all day
        // rather than come at your guns.
        const radial = Math.max(-1, Math.min(1, (dist - cfg.holdRadius) / cfg.holdRadius));
        // radial > 0 means it is outside the ring, so it pulls inward along
        // toShip; inside the ring the sign flips and it backs off.
        this.vel.x += toShipX * radial * accel + tanX * swirl;
        this.vel.y += toShipY * radial * accel + tanY * swirl;
      } else {
        // Behind you now — commit to the standoff anchor off the ship's tail,
        // which is inside lungeRange, so arriving arms a strike. Turning to face
        // it moves the anchor and throws it back out to the circling arc.
        const anchorX = shipX - Math.cos(shipHeading) * cfg.flankDist;
        const anchorY = shipY - Math.sin(shipHeading) * cfg.flankDist;
        const ax = anchorX - this.pos.x;
        const ay = anchorY - this.pos.y;
        const aLen = Math.max(1, Math.hypot(ax, ay));
        this.vel.x += (ax / aLen) * accel + tanX * swirl * 0.3;
        this.vel.y += (ay / aLen) * accel + tanY * swirl * 0.3;
      }
      this.wraithCircling = isCircling;
    }

    // Writhe drag: perpendicular sinusoidal nudge that flips sign, making
    // the path slither instead of arrow straight in. Small magnitude so it
    // reads as a body motion rather than wild swerves.
    const perpX = -toShipY;
    const perpY = toShipX;
    const writheStr = Math.sin(this.writhePhase * 0.9) * 30 * dt;
    this.vel.x += perpX * writheStr;
    this.vel.y += perpY * writheStr;

    // Cap speed. A lunge briefly exceeds the stalk cap by design — that burst
    // of speed is what makes the strike feel dangerous.
    const maxSpeed = this.wraithMode === "lunge"
      ? cfg.maxStalkSpeed * cfg.lungeSpeedMul
      : this.wraithCircling ? cfg.maxStalkSpeed * cfg.circleSpeedMul
      : cfg.maxStalkSpeed;
    const speed = Math.hypot(this.vel.x, this.vel.y);
    if (speed > maxSpeed) {
      const k = maxSpeed / speed;
      this.vel.x *= k;
      this.vel.y *= k;
    }
    return event;
  }

  // Step the 16-beat boss rhythm and return slot events for this tick.
  // beatTime = game.beatTime in seconds. The 8.0s cycle:
  //   beat 1 (t=0.0) top hemisphere flashes (post-break: top fires plasma)
  //   beat 3 (t=1.0) bottom hemisphere flashes (post-break: bottom fires)
  //   beat 4 (t=1.5) laser aim windup begins (4-beat aim slew onto the player)
  //   beat 5 (t=2.0) brass iris ring flashes
  //   beat 7 (t=3.0) pupil flash #1 + aim locks
  //   beats 9-11 (t=4.0-5.0) pre-fire wind-up surge — eye spools up, 3 beats
  //   beat 12 (t=5.5) pupil flash #2 + laser fires
  //   beats 13-16 (t=6.0-8.0) rest, so the laser fires once per 8s block
  // The live whole-body boss runs every slot. Post-break hemispheres run
  // only their assigned half; bossEye runs iris + pupil + laser.
  tickBossRhythm(beatTime: number): {
    topFlash: boolean;
    bottomFlash: boolean;
    irisFlash: boolean;
    pupilFlash: boolean;
    fireLaser: boolean;
    firePlasma: "top" | "bottom" | null;
  } {
    const events = {
      topFlash: false,
      bottomFlash: false,
      irisFlash: false,
      pupilFlash: false,
      fireLaser: false,
      firePlasma: null as null | "top" | "bottom",
    };
    if (!this.isBossLikeRhythmHolder()) return events;
    const CYCLE = 8.0;
    const tPrev = this.bossRhythmT;
    const tNow = beatTime - Math.floor(beatTime / CYCLE) * CYCLE;
    // First time this asteroid joins the rhythm — pre-arm any slots already
    // past in the current cycle so we don't cascade-fire every prior slot
    // at once. Marked by bossRhythmInit; flipped true after the first tick.
    if (!this.bossRhythmInit) {
      this.bossRhythmInit = true;
      this.bossRhythmT = tNow;
      this.bossDidTop = tNow >= 0.0;
      this.bossDidBottom = tNow >= 1.0;
      this.bossDidIris = tNow >= 2.0;
      this.bossDidPupil1 = tNow >= 3.0;
      this.bossDidPupil2 = tNow >= LASER_FIRE_T;
      this.bossPlasmaFired = tNow >= 0.0 && tNow < 1.0 ? false : tNow >= 1.0;
      return events;
    }
    this.bossRhythmT = tNow;
    if (tNow < tPrev) {
      this.bossDidTop = false;
      this.bossDidBottom = false;
      this.bossDidIris = false;
      this.bossDidPupil1 = false;
      this.bossDidPupil2 = false;
      this.bossPlasmaFired = false;
    }
    // Aim windup: the sightline telegraph ramps from beat 4 (t=1.5) through the
    // aim lock, giving the player a long read before the shot commits. The
    // charge eases up to a plateau across the aim windup, then the pre-fire
    // wind-up surge (below) carries the eye the rest of the way to full.
    if (tNow >= LASER_AIM_START && tNow < LASER_FIRE_T) {
      const aimFrac = Math.min(1, (tNow - LASER_AIM_START) / (LASER_AIM_END - LASER_AIM_START));
      this.bossLaserCharge = 0.35 + 0.4 * aimFrac;
    } else {
      // After the fire the telegraph drops quickly so it doesn't hang over the
      // live sweep beam.
      this.bossLaserCharge = Math.max(0, this.bossLaserCharge - 0.16);
    }
    // Pre-fire wind-up surge across the final 3 beats — a steep escalation on
    // top of the charge plateau so the eye visibly spools up before it fires.
    if (tNow >= LASER_WINDUP_START && tNow < LASER_FIRE_T) {
      this.bossLaserWindup = (tNow - LASER_WINDUP_START) / (LASER_FIRE_T - LASER_WINDUP_START);
    } else {
      this.bossLaserWindup = Math.max(0, this.bossLaserWindup - 0.25);
    }

    const role = this.bossRhythmRole();
    if (role === "whole" || role === "eye") this.tickLaserAim(tNow);

    if (!this.bossDidTop && tNow >= 0.0) {
      if (role === "whole" || role === "top") {
        this.bossTopFlash = 1;
        events.topFlash = true;
        if (role === "top" && !this.bossPlasmaFired) {
          events.firePlasma = "top";
          this.bossPlasmaFired = true;
        }
      }
      this.bossDidTop = true;
    }
    if (!this.bossDidBottom && tNow >= 1.0) {
      if (role === "whole" || role === "bottom") {
        this.bossBottomFlash = 1;
        events.bottomFlash = true;
        if (role === "bottom" && !this.bossPlasmaFired) {
          events.firePlasma = "bottom";
          this.bossPlasmaFired = true;
        }
      }
      this.bossDidBottom = true;
    }
    if (!this.bossDidIris && tNow >= 2.0) {
      if (role === "whole" || role === "eye") {
        this.bossIrisFlash = 1;
        events.irisFlash = true;
      }
      this.bossDidIris = true;
    }
    if (!this.bossDidPupil1 && tNow >= 3.0) {
      if (role === "whole" || role === "eye") {
        this.bossPupilFlash = 1;
        events.pupilFlash = true;
        // Aim was already locked at the windup start (t=1.5); don't re-snap
        // here or the 4-beat telegraph would lie about the final direction.
      }
      this.bossDidPupil1 = true;
    }
    if (!this.bossDidPupil2 && tNow >= LASER_FIRE_T) {
      if (role === "whole" || role === "eye") {
        this.bossPupilFlash = 1;
        events.pupilFlash = true;
        events.fireLaser = true;
      }
      this.bossDidPupil2 = true;
    }
    return events;
  }

  private isBossLikeRhythmHolder(): boolean {
    if (this.isBoss() && this.bossPhase === "live") return true;
    if (this.kind === "bossHemisphere") return true;
    if (this.kind === "bossEye") return true;
    return false;
  }

  // The whole-body live boss owns every section; a hemisphere owns its
  // half (top = the one whose cut diameter points upward); the detached
  // eye-core owns iris + pupil + laser.
  bossRhythmRole(): "whole" | "top" | "bottom" | "eye" | "none" {
    if (this.isBoss() && this.bossPhase === "live") return "whole";
    if (this.kind === "bossEye") return "eye";
    if (this.kind === "bossHemisphere") {
      const sy = Math.sin(this.bossFragmentAngle);
      return sy <= 0 ? "top" : "bottom";
    }
    return "none";
  }

  // Direction from the iris toward its locked aim point. Used both by the
  // telegraph renderer and by the bullet-spawn so the rendered sightline
  // matches the shot.
  eyeAimAngle(): number {
    // The eased display angle, so the telegraph and the bolt both follow the
    // smooth slew rather than the committed aim's per-beat jumps. Falls back to
    // the committed direction before the display angle is seeded.
    if (this.bossAimDisplayAngle !== -999) return this.bossAimDisplayAngle;
    const dx = this.bossEyeAimX - this.pos.x;
    const dy = this.bossEyeAimY - this.pos.y;
    return Math.atan2(dy, dx);
  }

  // Per-kind score from ENTITY_STATS (boss ladder / eye bump / gem / wraith /
  // torus all carry their own), falling back to the stock asteroid size band for
  // plain kinds. Combo multiplier applies on top at the call site.
  scoreValue(): number {
    return entityStat(this.kind, this.size, "score");
  }

  isBass(): boolean {
    return this.kind === "bassA" || this.kind === "bassB" || this.kind === "bassC" || this.kind === "bassD";
  }

  isWraith(): boolean { return this.kind === "wraith"; }
  isGlassPrison(): boolean { return isGlassPrison(this.kind); }

  isBoss(): boolean {
    return this.kind === "boss";
  }

  // The level-10 boss fragments after the planetoid breaks: hemispheres,
  // eye core, plates, iris shards, ember. They share the boss hue / scoring
  // / shatter-aesthetic but render and split differently than the whole-body
  // planetoid.
  isBossFragment(): boolean {
    return this.kind === "bossHemisphere" || this.kind === "bossEye"
      || this.kind === "bossPlate" || this.kind === "bossIrisShard" || this.kind === "bossEmber";
  }

  isBossFamily(): boolean {
    return this.isBoss() || this.isBossFragment();
  }

  isSepulchre(): boolean {
    return this.kind === "sepulchre";
  }

  // The tomb and the four bearers carrying it — one encounter, so armour,
  // rhythm and rendering all ask about the family rather than the kind.
  isSepulchreFamily(): boolean {
    return this.kind === "sepulchre" || this.kind === "pallbearer";
  }

  // Kinds that arrive dormant: a long approach where the body is still
  // masquerading as the background object it just detached from.
  hasRevealPhase(): boolean {
    return this.isBoss() || this.isSepulchre();
  }

  // While dormant a boss is intangible, undamageable and not a target — it is
  // scenery. Collision, targeting and the beat-flash pass all gate on this
  // rather than re-testing kind + phase at each site.
  isDormantSilhouette(): boolean {
    if (this.bossPhase !== "dormant") return false;
    // A Pallbearer keeps no clock of its own: it is carrying a sleeping tomb,
    // and it wakes when the tomb does (see tickSepulchre).
    return this.hasRevealPhase() || this.kind === "pallbearer";
  }

  // Terminal boss shards that ring like Bassteroids: they flash on a measure
  // slot (silently — the boss music carries the audio), and as the planetoid
  // breaks into more of them the collective pulse subdivides into faster beats
  // (splitLevel rises). These also act as bass-echo lightning sources and
  // carry a live-field resonance bounty. The ember stays inert.
  isBeatFragment(): boolean {
    return this.kind === "bossPlate" || this.kind === "bossIrisShard";
  }

  // `impactDir` is the bullet's velocity direction at the moment of the kill.
  // Falls back to the parent's velocity direction when no impactDir is given
  // (e.g. shockwave splits).
  //
  // Bass/boss splits use a heading-based fan (fragments fly out into the
  // forward hemisphere relative to the impact direction). Regular splits
  // build fragment velocities as `parent_vel + bullet-push + perp-burst`
  // with mass-weighted perpendicular kicks summing to zero — see
  // splitRegular() for the momentum-conservation details.
  //
  // For regular (non-bass, non-boss) *large* asteroids, the optional
  // `impactPos`, `combo`, and `onBeat` inputs steer the breakup pattern:
  //   - A center hit cleanly splits the rock into 2 mediums; a glancing hit
  //     spalls 2 small chips off the struck side while one medium continues
  //     mostly forward along the original trajectory.
  //   - An on-beat hit while combo ≥ 2 pulverises a large into 4 smalls —
  //     the skill-and-rhythm reward for staying in the pocket.
  // Mediums always split into the classic 2-small wedge regardless of hit
  // context.

  // Construct one ring fragment (a torusArc C / sliver, or a torusChunk nub)
  // belonging to `group`, occupying angular `slot` on the phantom ring and
  // spanning `arcSpan` radians. Bakes the curved sprite, derives a circular
  // hitbox from the arc's chord, and snaps the fragment onto the ring so it's
  // already in place the frame it spawns. The group's per-frame tick (tickTorus
  // Group) takes over position + rotation from there.
  private makeTorusArc(
    group: TorusGroup, size: AsteroidSize, slot: number, arcSpan: number, kind: AsteroidKind = "torusArc",
  ): Asteroid {
    const ringR = group.ringRadius;
    const tube = ringR * ENTITY_CONFIG.torus.tubeFrac;
    // Hitbox radius: half the arc chord on the centreline, plus the tube half
    // -thickness, so the circle hugs the curved fragment without swallowing the
    // gaps between fragments.
    const chordHalf = ringR * Math.sin(Math.min(Math.PI, arcSpan) / 2);
    const hitR = Math.max(tube * 0.6, chordHalf * 0.6 + tube * 0.5);
    // Spawn directly on the slot so there's no one-frame pop before the tick.
    const ang = slot + group.phase;
    const pos = { x: group.center.x + Math.cos(ang) * ringR, y: group.center.y + Math.sin(ang) * ringR };
    const a = new Asteroid(pos, { x: group.vel.x, y: group.vel.y }, size, group.hue, kind);
    a.torusGroup = group;
    a.torusSlot = slot;
    a.torusArcSpan = arcSpan;
    a.torusBendRadius = ringR;
    a.radius = hitR;
    a.rotation = ang; // bulge points radially outward; tick keeps it aligned
    // Rebuild the sprite now that bend/span/radius are known (the constructor
    // baked a placeholder with default geometry before these were set).
    a.sprite = a.buildTorusArcSprite();
    return a;
  }

  split(opts?: { impactDir?: Vec; impactPos?: Vec; combo?: number; onBeat?: boolean; awayFrom?: Vec; shipHeading?: number; shipVel?: Vec; bulletSpeed?: number }): Asteroid[] {
    const impactDir = opts?.impactDir;
    // Boss whole-body: cracks open into two hemisphere halves + the iris
    // eye-core (3 mediums total, but with distinct identities). Cleavage
    // axis is perpendicular to the killing-shot direction so the bullet
    // visibly "splits the planet in two", and the hemispheres fly out along
    // that perpendicular while the eye drifts forward along the bullet's
    // line of travel.
    if (this.isBoss()) {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      // perpendicular to the bullet: cleavage plane direction
      const cutAxis = baseAngle + Math.PI / 2;
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      // Halves are nearly full-body sized now, so push their spawn centres
      // farther apart and drive them outward harder — they overlap at the
      // instant of the cut and need to clear each other quickly.
      const ejectDist = this.radius * 0.72;
      const fragmentList: Asteroid[] = [];
      // Two hemispheres — one to each side of the cut axis.
      for (let i = 0; i < 2; i++) {
        const sign = i === 0 ? -1 : 1;
        const childAngle = cutAxis + sign * 0.15;
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        const speedMag = parentSpeed * rand(0.9, 1.3) + 95;
        const hemi = new Asteroid(childPos, fromAngle(childAngle, speedMag), "medium", this.hue, "bossHemisphere");
        // Remember which side of the cut this hemisphere came from so the
        // renderer can paint the flat diameter facing back along the cut
        // axis — that's the freshly-revealed cross-section of the broken
        // planet, with the inner ring laid bare.
        hemi.bossFragmentAngle = cutAxis + (sign === -1 ? Math.PI : 0);
        // Seed a half-measure-apart base so each hemisphere's eventual plates
        // subdivide off a distinct slot — the two halves' debris interleaves
        // instead of stacking on the same beats.
        hemi.measureOffset = i * (BASS_MEASURE_LENGTH / 2);
        // Inherit the parent's rhythm position + slot latches so each
        // fragment marches on the same downbeat the whole-body boss was on
        // when it cracked.
        hemi.bossRhythmT = this.bossRhythmT;
        hemi.bossDidTop = this.bossDidTop;
        hemi.bossDidBottom = this.bossDidBottom;
        hemi.bossDidIris = this.bossDidIris;
        hemi.bossDidPupil1 = this.bossDidPupil1;
        hemi.bossDidPupil2 = this.bossDidPupil2;
        hemi.bossPlasmaFired = false;
        hemi.bossRhythmInit = true;
        fragmentList.push(hemi);
      }
      // Eye core — flies forward along the bullet's line, slightly slower
      // than the hemispheres so the player can tell the moving threat from
      // the rubble. Inherits the iris angle so its first telegraphed shot
      // points roughly where it was already aiming.
      const eyePos = {
        x: this.pos.x + Math.cos(baseAngle) * ejectDist * 0.4,
        y: this.pos.y + Math.sin(baseAngle) * ejectDist * 0.4,
      };
      const eyeSpeed = parentSpeed * rand(0.7, 1.0) + 30;
      const eye = new Asteroid(eyePos, fromAngle(baseAngle, eyeSpeed), "medium", this.hue, "bossEye");
      // Offset the eye's base a quarter measure off the hemispheres so its two
      // iris shards ring in the gaps between the plate flashes.
      eye.measureOffset = BASS_MEASURE_LENGTH / 4;
      eye.bossIrisAngle = this.bossIrisAngle;
      eye.bossEyeAimX = this.bossEyeAimX;
      eye.bossEyeAimY = this.bossEyeAimY;
      eye.bossRhythmT = this.bossRhythmT;
      eye.bossDidTop = this.bossDidTop;
      eye.bossDidBottom = this.bossDidBottom;
      eye.bossDidIris = this.bossDidIris;
      eye.bossDidPupil1 = this.bossDidPupil1;
      eye.bossDidPupil2 = this.bossDidPupil2;
      eye.bossLaserCharge = this.bossLaserCharge;
      eye.bossLaserWindup = this.bossLaserWindup;
      eye.bossRhythmInit = true;
      fragmentList.push(eye);
      return fragmentList;
    }
    // Boss hemisphere: shatters into three modular plate fragments — each
    // a sliver of the equatorial Bassteroid-style ring this hemisphere wore.
    // Each plate carries one of the four bass-hue bands so the rubble paints
    // a recognisable echo of the parent's architecture.
    if (this.kind === "bossHemisphere") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 3; i++) {
        const childAngle = baseAngle + (i - 1) * 0.9 + rand(-0.18, 0.18);
        const speedMag = Math.hypot(this.vel.x, this.vel.y) * rand(1.0, 1.5) + 80;
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * this.radius * 0.4,
          y: this.pos.y + Math.sin(childAngle) * this.radius * 0.4,
        };
        const plate = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "bossPlate");
        // Distribute the four bass-band hues across the three plates: the
        // hemisphere wore two color rings (each plate gets a distinct one,
        // the third samples a third). Modular indices into BASS_KIND_BASE.
        plate.bossPlateBand = (i + Math.floor(rng() * 2)) % 4;
        // Beat-active like a Bassteroid: gen-2 (quarter-measure subdivision),
        // each plate offset onto a distinct slot off the parent's so a single
        // hemisphere's three plates fan across the measure rather than
        // strobing in unison. Spread the hemisphere shatter across the field
        // and the flashes thicken into the escalating pulse.
        plate.splitLevel = 2;
        plate.measureOffset = (this.measureOffset + i * (BASS_MEASURE_LENGTH / 4)) % BASS_MEASURE_LENGTH;
        fragmentList.push(plate);
      }
      return fragmentList;
    }
    // Boss eye-core: shatters into two iris-crescent shards + one inert
    // ember (the burnt-out pupil). The shards fan opposite the bullet,
    // the ember drifts slowly forward — a final remnant cooling off.
    if (this.kind === "bossEye") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 2; i++) {
        const sign = i === 0 ? -1 : 1;
        const childAngle = baseAngle + sign * 1.4 + rand(-0.15, 0.15);
        const speedMag = Math.hypot(this.vel.x, this.vel.y) * rand(1.1, 1.5) + 90;
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * this.radius * 0.5,
          y: this.pos.y + Math.sin(childAngle) * this.radius * 0.5,
        };
        const shard = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "bossIrisShard");
        // Track which side of the iris this shard came from so the renderer
        // can draw the brass rim arc on the correct edge.
        shard.bossFragmentAngle = sign === -1 ? -1 : 1;
        // Beat-active like a Bassteroid: the two shards sit half a measure
        // apart so the dead eye keeps ringing on opposite beats. See bossPlate.
        shard.splitLevel = 2;
        shard.measureOffset = (this.measureOffset + i * (BASS_MEASURE_LENGTH / 2)) % BASS_MEASURE_LENGTH;
        fragmentList.push(shard);
      }
      // The ember drifts slowly forward along the impact line — a tiny
      // black sphere with a smouldering core. No firing, no telegraph.
      const emberSpeed = Math.hypot(this.vel.x, this.vel.y) * rand(0.4, 0.7) + 20;
      const ember = new Asteroid({ ...this.pos }, fromAngle(baseAngle, emberSpeed), "small", this.hue, "bossEmber");
      fragmentList.push(ember);
      return fragmentList;
    }
    // Boss small-tier shards are terminal — they break into nothing further.
    if (this.kind === "bossPlate" || this.kind === "bossIrisShard" || this.kind === "bossEmber") {
      return [];
    }
    // Torus: the whole ring cleaves into two C-shaped half-rings that keep
    // orbiting a shared phantom-ring centre (the donut gap survives the split).
    // A half-ring later breaks into one shorter sliver arc + a couple of small
    // terminal chunks. Every fragment shares the parent's TorusGroup and holds a
    // fixed angular slot on the ring, so the pieces look like they're still
    // trying to reassemble. See tickTorusGroup for the orbit + the connecting
    // energy thread.
    if (this.kind === "torus") {
      const cfg = ENTITY_CONFIG.torus;
      // The fragments settle onto a ring blown outward from the intact
      // centreline (breakExpand), so the broken formation opens up.
      const ringRadius = this.radius * (1 - cfg.tubeFrac / 2) * cfg.breakExpand;
      // Hand the broken ring a faint outward drift so the cluster keeps moving
      // across the field rather than freezing where it cracked.
      const group: TorusGroup = {
        center: { x: this.pos.x, y: this.pos.y },
        vel: { x: this.vel.x, y: this.vel.y },
        ringRadius,
        phase: 0,
        spin: cfg.ringSpin * (rng() < 0.5 ? -1 : 1),
        hue: this.hue,
        members: [],
      };
      // Two half-rings: slots π apart, each spanning well under π so there's a
      // comfortably wide gap at the top + bottom for the ship to thread between
      // the two C's (as well as through the hole).
      const span = Math.PI * 0.6;
      const halves = [0, Math.PI].map((slot) => this.makeTorusArc(group, "large", slot, span));
      group.members = halves;
      return halves;
    }
    if (this.kind === "torusArc" || this.kind === "torusChunk") {
      // Sliver arcs + chunks are terminal; only a large C-half breaks further.
      if (!this.torusGroup || this.kind === "torusChunk" || this.size !== "large") return [];
      const cfg = ENTITY_CONFIG.torus;
      const group = this.torusGroup;
      // Each further break blows the shared phantom ring wider again, so the
      // whole formation (this half's fragments AND any surviving siblings)
      // spreads outward with every generation.
      group.ringRadius *= cfg.breakExpand;
      const out: Asteroid[] = [];
      // One shorter sliver keeps the centre of the parent's slot.
      const sliverSpan = this.torusArcSpan * 0.6;
      out.push(this.makeTorusArc(group, "medium", this.torusSlot, sliverSpan));
      // A couple of small chunks spall off toward the parent slot's two ends.
      for (let i = 0; i < cfg.chunkCount; i++) {
        const edge = (i === 0 ? -1 : 1) * this.torusArcSpan * 0.32;
        const chunk = this.makeTorusArc(group, "small", this.torusSlot + edge, 0.42, "torusChunk");
        out.push(chunk);
      }
      // Replace this dead half-ring in the shared group with its fragments.
      group.members = group.members.filter((m) => m !== this).concat(out);
      return out;
    }
    // Bassteroid: each split subdivides the parent's beat slot. Gen-0 (large)
    // → 2 gen-1 (medium) half a measure apart, gen-1 → 2 gen-2 (small) a
    // quarter measure apart, gen-2 is terminal. Children keep the parent's
    // kind (and therefore the parent's voice) so the four percussive timbres
    // spread across the measure as the field thickens. Fresh HP per the
    // child size — no carryover from the parent.
    if (this.isBass()) {
      if (this.splitLevel >= BASS_MAX_SPLIT_LEVEL) return [];
      const childLevel = this.splitLevel + 1;
      const childSize: AsteroidSize = childLevel === 1 ? "medium" : "small";
      const splitDelta = BASS_MEASURE_LENGTH / Math.pow(2, childLevel);
      const childOffsets = [
        this.measureOffset,
        (this.measureOffset + splitDelta) % BASS_MEASURE_LENGTH,
      ];
      const fragmentList: Asteroid[] = [];
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      // Carve the parent into its 2 authored fragments (deterministic — same
      // pieces every time). A gen-0 large yields its two mediums; a gen-1
      // medium yields the two smalls authored for the medium it came from, so
      // each terminal small is a single connected blob, no gaps. Every shape
      // here was prewarmed at module load, so no halo union runs at runtime.
      const tree = BASS_SPLIT_TREES[this.kind as "bassA" | "bassB" | "bassC" | "bassD"];
      const childFragments: BassFragment[] =
        childLevel === 1
          ? tree.mediums.map(m => m.fragment)
          : tree.mediums[this.bassMediumIndex].smalls;
      for (let i = 0; i < 2; i++) {
        // Fan ±~0.9 rad off the bullet's heading (one to each side), forward
        // of the impact point — within ~±π/2, so both pieces head away from
        // where the bullet came from.
        const sideOffset = (i === 0 ? -1 : 1) * (0.9 + rand(-0.2, 0.2));
        const a = baseAngle + sideOffset + rand(-0.2, 0.2);
        // Gen-2 smalls (the terminal, fastest pieces) are throttled until the
        // player has built FAST_SHARD_RHYTHM; mediums keep their stock speed.
        const shardMul = childSize === "small" ? fastShardSpeedMul(opts?.combo) : 1;
        const speedMag = splitChildSpeed(this.vel, childSize) * shardMul;
        const child = new Asteroid({ ...this.pos }, fromAngle(a, speedMag), childSize, this.hue, this.kind, normalizeFragment(childFragments[i]));
        child.splitLevel = childLevel;
        // A gen-1 medium records which authored medium it is so its own split
        // reaches the right smalls pair; gen-2 smalls are terminal.
        if (childLevel === 1) child.bassMediumIndex = i;
        child.measureOffset = childOffsets[i];
        // Broken pieces tumble. Mediums (gen-1) drift with a gentle wobble;
        // smalls (gen-2) — the lightest fragments — spin noticeably faster.
        const spinMag = childSize === "medium" ? rand(0.4, 0.9) : rand(1.4, 2.6);
        child.rotSpeed = spinMag * (rng() < 0.5 ? -1 : 1);
        // Outline was baked at module load (deterministic shape set); resolve
        // the cached entry now so the first render is a pure lookup.
        child.haloOutline = child.buildHaloOutline(BASS_HALO_GAP_PX);
        fragmentList.push(child);
      }
      return fragmentList;
    }
    // Glass prison: shatters into its captive wraith (or, for the big shell, a
    // brood of them) born at the prison's centre + a few inert crystal
    // fragments fanning out from the impact. The wraiths start stationary
    // (their tickWraith emerge phase handles the fade-in); the shards fly
    // outward fast so the visual reads as "the prison just broke open and
    // something stepped out".
    if (isGlassPrison(this.kind)) {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const fragmentList: Asteroid[] = [];
      // Brood size was rolled at construction (prisonCaptives) so the eyes the
      // player counted through the shell are exactly what comes out.
      const wraithCount = Math.max(1, this.prisonCaptives);
      // Spread the brood around the prison centre so they don't stack into one
      // sprite; each gets a small positional offset and the same stationary
      // emerge contract as a lone wraith.
      for (let i = 0; i < wraithCount; i++) {
        const spreadAngle = baseAngle + (i - (wraithCount - 1) / 2) * 0.8;
        const spreadDist = wraithCount > 1 ? this.radius * 0.35 : 0;
        const wraithPos = {
          x: this.pos.x + Math.cos(spreadAngle) * spreadDist,
          y: this.pos.y + Math.sin(spreadAngle) * spreadDist,
        };
        const wraith = new Asteroid(wraithPos, v(0, 0), "medium", undefined, "wraith");
        fragmentList.push(wraith);
      }
      // Small black-diamond shards as the prison's broken pieces (more from the
      // bigger shell). Reuse the solidCrystalSmall kind so they keep the same
      // HP/physics/ring-on-hit sound; isPrisonShard only swaps the paint to a
      // black diamond splinter instead of the standalone treat pickup's
      // ice-blue crystal. They hand the player a small extra payout for
      // cracking the prison.
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      const ejectDist = this.radius * 0.5;
      const shardCount = this.kind === "bigGlassPrison" ? 5 : 3;
      for (let i = 0; i < shardCount; i++) {
        const childAngle = baseAngle + (i - (shardCount - 1) / 2) * 0.9 + rand(-0.18, 0.18);
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        const speedMag = parentSpeed * rand(1.0, 1.4) + rand(160, 220);
        const shard = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "solidCrystalSmall");
        shard.rotSpeed = rand(1.2, 2.4) * (rng() < 0.5 ? -1 : 1);
        // isPrisonShard swaps the silhouette to a clean diamond: low-amp
        // harmonics (freq 4 — avoids aliasing against the 6 outlineSamples,
        // unlike the treat pickup's jagged [1,2,4,5]/1.8 wobble) so the
        // diamondProfile's sharp points survive. Outline + sprite already
        // ran once in the constructor before this flag existed, so redo them.
        shard.isPrisonShard = true;
        shard.harmonics = [{ amp: rand(0.05, 0.12), freq: 4, phase: rand(0, TAU) }];
        shard.outline = shard.computeOutline();
        shard.sprite = shard.buildSprite();
        fragmentList.push(shard);
      }
      return fragmentList;
    }
    // Wraith: terminal — no split. The escaping puff is handled by
    // particle/sound effects in killEffects.
    if (this.kind === "wraith") return [];
    // Citadel: the fortress shell breaks up into the phased rocks it was built
    // from — a fan of full-size warbles thrown clear of the collapsing hole.
    if (this.kind === "citadel") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      // A fragment must be BORN clear of the hull, not merely aimed away from
      // it: its own radius, the ship's silhouette, the ±18 px the rhythm
      // aligner may nudge it back down its ray (alignSplitChildToRhythm), and
      // a little slack. A large warble is r=50 against a 140-radius shell, so
      // the old radius·0.5 ring put fragment bodies straight over the centre —
      // exactly where the player is standing for the intended kill.
      const clearance = entityStat("warble", "large", "radius") + SHIP_CLEAR_RADIUS + 18 + 16;
      // Ship in this citadel's unwrapped frame; null for a shockwave-driven
      // break, where there's no shooter standing in the blast to protect.
      let ship: Vec | null = null;
      let shipDist = Infinity;
      if (opts?.awayFrom) {
        const [sx, sy] = toroidalDelta(this.pos.x - opts.awayFrom.x, this.pos.y - opts.awayFrom.y, WORLD_W, WORLD_H);
        ship = { x: this.pos.x - sx, y: this.pos.y - sy };
        shipDist = Math.hypot(sx, sy);
      }
      // The intended kill is fired from inside the escape hole, so the player
      // is usually at the dead centre of this explosion. Whenever they're
      // inside the footprint the fan is struck from THEM rather than from the
      // shell's centre — three rays spread evenly around the ship, each piece
      // born past `clearance` down its own ray and flying straight out along
      // it, so the gap only ever grows. From outside, pieces come off the
      // shell band as before and are only shoved out if one lands on the ship.
      const shipInside = ship !== null && shipDist <= this.radius;
      const origin = shipInside ? (ship as Vec) : this.pos;
      // 0.8·radius is the shell band the fragments visually tore off of.
      const spawnDist = shipInside ? Math.max(clearance, this.radius * 0.8) : this.radius * 0.8;
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 3; i++) {
        // Spread evenly around the origin, anchored on the killing shot.
        const spawnAngle = baseAngle + i * (TAU / 3) + rand(-0.2, 0.2);
        const childPos = {
          x: origin.x + Math.cos(spawnAngle) * spawnDist,
          y: origin.y + Math.sin(spawnAngle) * spawnDist,
        };
        let flyAngle = spawnAngle;
        if (ship) {
          const ox = childPos.x - ship.x;
          const oy = childPos.y - ship.y;
          const d = Math.hypot(ox, oy);
          if (d > 1e-3) {
            // Radially away from the shooter, and if this piece still landed
            // inside their personal space, slide it out along the same ray
            // until it can't be touching them.
            flyAngle = Math.atan2(oy, ox);
            if (d < clearance) {
              childPos.x = ship.x + (ox / d) * clearance;
              childPos.y = ship.y + (oy / d) * clearance;
            }
          }
        }
        wrapMut(childPos, WORLD_W, WORLD_H);
        // Outrun the player: a ship already travelling down this ray catches a
        // fragment carrying only the shell's ponderous drift. Adding the ship's
        // own speed along the ray is exactly the condition that makes the gap
        // monotonic — a fragment moving straight out from the ship faster than
        // the ship closes on it can never be reached, from any angle, however
        // the two coast afterwards. Pre-divided by the rhythm aligner's lowest
        // speed multiplier so even a fragment it slows down keeps the property.
        // Zero in the usual case: you drift into the hole, you don't race in.
        const chase = opts?.shipVel
          ? Math.max(0, opts.shipVel.x * Math.cos(flyAngle) + opts.shipVel.y * Math.sin(flyAngle))
          : 0;
        const speedMag = parentSpeed * rand(0.9, 1.3) + rand(70, 120) + chase / 0.65;
        const child = new Asteroid(childPos, fromAngle(flyAngle, speedMag), "large", this.hue, "warble");
        fragmentList.push(child);
      }
      return fragmentList;
    }
    // Metal chunk: the slab breaks into 4 slow shards that barely drift (dense
    // scrap that just sits there once cracked) and keep the parent's DR 8, so
    // each one is another drift-shot the player has to line up. This IS the
    // entity's job — teach the drift shot — so it makes the reward legible: two
    // of the four shards are placed on the ship's ACTUAL prong-bullet rays. The
    // first prong pair fans ±half a prong step off the heading, but each bullet
    // also inherits BULLET_VEL_INHERIT·shipVel, so at speed the rays bend off
    // the pure heading; we reproduce that bend here and drop a shard on each
    // true ray at the slab's distance. A player who owns prong and fires right
    // now, at this velocity, threads both. The other two fling off to the sides
    // so the break still reads as a burst. metalShards are terminal.
    if (this.kind === "metalChunk") {
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      // Slow shove on top of the ponderous parent drift, so shards linger.
      const shardSpeed = () => parentSpeed * rand(0.7, 1.0) + rand(20, 45);
      const newShard = (pos: Vec, vel: Vec): Asteroid => {
        const s = new Asteroid(pos, vel, "small", this.hue, "metalShard");
        s.rotSpeed = rand(-0.5, 0.5);
        return s;
      };
      const fragmentList: Asteroid[] = [];
      const half = PRONG_ANGLE_STEP / 2; // first prong pair sits at heading ± this
      // Ship→slab direction + distance, torus-correct. When we don't have the
      // ship pose (shockwave-driven split), fall back to a plain radial burst.
      const ship = opts?.awayFrom;
      const heading = opts?.shipHeading;
      if (ship && heading !== undefined) {
        const [sx, sy] = toroidalDelta(this.pos.x - ship.x, this.pos.y - ship.y, WORLD_W, WORLD_H);
        const dist = Math.max(this.radius, Math.hypot(sx, sy));
        const shipVel = opts?.shipVel ?? { x: 0, y: 0 };
        const bulletSpeed = opts?.bulletSpeed ?? 0;
        // True unit direction a prong bullet at `offset` flies, matching
        // launchBullet: speed·dir + inherit·shipVel, renormalised.
        const prongRayDir = (offset: number): { x: number; y: number } => {
          const a = heading + offset;
          const vx = Math.cos(a) * bulletSpeed + shipVel.x * BULLET_VEL_INHERIT;
          const vy = Math.sin(a) * bulletSpeed + shipVel.y * BULLET_VEL_INHERIT;
          const m = Math.hypot(vx, vy) || 1;
          return { x: vx / m, y: vy / m };
        };
        // Two shards, one on each true prong ray, at the slab's distance — the
        // pair sits right where the slab was, so the prong shot threads both.
        for (const sign of [-1, 1] as const) {
          const d = prongRayDir(sign * half);
          const pos = { x: ship.x + d.x * dist, y: ship.y + d.y * dist };
          wrapMut(pos, WORLD_W, WORLD_H);
          // Drift roughly outward along the ray so alignment nudges them little.
          const outAngle = Math.atan2(d.y, d.x) + rand(-0.1, 0.1);
          fragmentList.push(newShard(pos, fromAngle(outAngle, shardSpeed())));
        }
        // Remaining two spall off perpendicular to the heading, one per side, so
        // the four together read as the slab bursting apart.
        for (const sign of [-1, 1] as const) {
          const sideAngle = heading + sign * (Math.PI / 2) + rand(-0.2, 0.2);
          const pos = {
            x: this.pos.x + Math.cos(sideAngle) * this.radius * 0.5,
            y: this.pos.y + Math.sin(sideAngle) * this.radius * 0.5,
          };
          fragmentList.push(newShard(pos, fromAngle(sideAngle, shardSpeed())));
        }
        return fragmentList;
      }
      // Fallback: even radial burst around the impact when there's no ship pose.
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const shardCount = ENTITY_CONFIG.metalChunk.shardCount;
      for (let i = 0; i < shardCount; i++) {
        const childAngle = baseAngle + (i / shardCount) * TAU + rand(-0.15, 0.15);
        const pos = {
          x: this.pos.x + Math.cos(childAngle) * this.radius * 0.5,
          y: this.pos.y + Math.sin(childAngle) * this.radius * 0.5,
        };
        fragmentList.push(newShard(pos, fromAngle(childAngle, shardSpeed())));
      }
      return fragmentList;
    }
    if (this.kind === "metalShard") return [];
    // Solid crystal: large shatters into 2 fast-moving small crystal
    // fragments fanning around the bullet's heading. Smalls don't split
    // further — they're the terminal tier.
    if (this.kind === "solidCrystal") {
      const baseAngle = impactDir
        ? Math.atan2(impactDir.y, impactDir.x)
        : Math.atan2(this.vel.y, this.vel.x);
      const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
      const ejectDist = this.radius * 0.55;
      const fragmentList: Asteroid[] = [];
      for (let i = 0; i < 2; i++) {
        // Two pieces fanned forward of the impact — neither flying straight
        // back at the shooter.
        const offsets = [-0.7, 0.7];
        const childAngle = baseAngle + offsets[i] + rand(-0.12, 0.12);
        const childPos = {
          x: this.pos.x + Math.cos(childAngle) * ejectDist,
          y: this.pos.y + Math.sin(childAngle) * ejectDist,
        };
        // Fast-moving: parent speed + a generous burst kick. Floor ensures
        // even a stationary parent ejects sharp shards. Throttled to a calmer
        // drift until the player has built FAST_SHARD_RHYTHM.
        const speedMag = (parentSpeed * rand(1.1, 1.5) + rand(180, 240)) * fastShardSpeedMul(opts?.combo);
        const child = new Asteroid(childPos, fromAngle(childAngle, speedMag), "small", this.hue, "solidCrystalSmall");
        child.rotSpeed = rand(1.2, 2.4) * (rng() < 0.5 ? -1 : 1);
        fragmentList.push(child);
      }
      return fragmentList;
    }
    if (this.kind === "solidCrystalSmall") return [];
    // Burst gem: emits no asteroid fragments. Its whole payout is a fan of
    // fast-flying Gem pickups, spawned in killEffects (which has the gem array
    // and the killing-shot direction).
    if (isBurstGem(this.kind)) return [];
    // Cathedral ("bell"): doesn't crumble into smaller cathedrals — it breaks
    // into recognisable carved building pieces, the way a bassteroid breaks
    // into ship chunks. A keystone (the wedge that locked an arch), a glowing
    // stained-glass shard, a column drum, and a plain rubble block fan out from
    // the impact. Each is a terminal small. Larger fragments throw more pieces;
    // a small bell throws a representative subset so the read survives at every
    // tier. The mandatory debris is glass + keystone (the iconic pair); column
    // and rubble fill in for bigger breaks.
    if (this.kind === "bell") {
      // Glass + keystone always; add column + rubble as the fragment grows.
      const pieces: AsteroidKind[] =
        this.size === "large" ? ["glassShard", "cathedralKeystone", "columnDrum", "rubbleBlock"]
        : this.size === "medium" ? ["glassShard", "cathedralKeystone", "rubbleBlock"]
        : ["glassShard", "cathedralKeystone"];
      return this.fanCathedralDebris(pieces, impactDir, "small", 1.7);
    }
    // A Pallbearer is a block of the tomb's own masonry, so it comes apart into
    // the same carved pieces a bell does — its lamp face going out as the
    // glass slivers off it.
    if (this.kind === "pallbearer") {
      return this.fanCathedralDebris(
        ["glassShard", "cathedralKeystone", "columnDrum", "rubbleBlock", "glassShard"],
        impactDir,
        "small",
        2.3,
      );
    }
    // The tomb itself: the building comes down. A ring of medium wreckage
    // thrown wide, with a spray of smaller carved pieces behind it — every one
    // of them a shape the player has been shooting since level 11.
    if (this.isSepulchre()) {
      return [
        ...this.fanCathedralDebris(
          ["cathedralKeystone", "columnDrum", "rubbleBlock", "glassShard"],
          impactDir,
          "medium",
          2.6,
        ),
        ...this.fanCathedralDebris(
          ["glassShard", "rubbleBlock", "glassShard", "columnDrum", "cathedralKeystone", "rubbleBlock"],
          impactDir,
          "small",
          3.4,
        ),
      ];
    }
    // Cathedral debris is terminal — carved chunks don't subdivide further.
    if (CATHEDRAL_DEBRIS_KINDS.includes(this.kind)) return [];
    if (this.size === "small") return [];
    return this.splitRegular(opts);
  }

  // Break a piece of the cathedral into recognisable carved building parts —
  // the keystone that locked an arch, a sliver of stained glass, a column drum,
  // a plain rubble block — fanned forward of the impact in an even spread so
  // none flies straight back at the shooter. Glass is the lightest and sharpest
  // so it flies fastest and spins hardest; stone tumbles.
  private fanCathedralDebris(
    pieces: AsteroidKind[],
    impactDir: Vec | undefined,
    size: AsteroidSize,
    spread: number,
  ): Asteroid[] {
    const baseAngle = impactDir
      ? Math.atan2(impactDir.y, impactDir.x)
      : Math.atan2(this.vel.y, this.vel.x);
    const parentSpeed = Math.hypot(this.vel.x, this.vel.y);
    const ejectDist = this.radius * 0.45;
    const fragmentList: Asteroid[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const frac = pieces.length === 1 ? 0 : i / (pieces.length - 1) - 0.5;
      const childAngle = baseAngle + frac * spread + rand(-0.12, 0.12);
      const childPos = {
        x: this.pos.x + Math.cos(childAngle) * ejectDist,
        y: this.pos.y + Math.sin(childAngle) * ejectDist,
      };
      const isGlass = pieces[i] === "glassShard";
      const speedMag = parentSpeed * rand(1.0, 1.4) + (isGlass ? rand(150, 210) : rand(90, 150));
      const child = new Asteroid(childPos, fromAngle(childAngle, speedMag), size, this.hue, pieces[i]);
      child.rotSpeed = (isGlass ? rand(1.6, 2.8) : rand(0.6, 1.4)) * (rng() < 0.5 ? -1 : 1);
      fragmentList.push(child);
    }
    return fragmentList;
  }

  // Pick a fragment recipe for a non-bass, non-boss kill, with fragment
  // velocities built to respect momentum conservation.
  //
  // Model: each fragment's velocity is
  //   v_frag = v_parent + bulletKick * d̂_bullet + perpKick * n̂
  // where n̂ is perpendicular to the bullet's direction. The mass-weighted
  // sum of perpKicks across fragments is forced to zero so the fragments
  // don't gain net perpendicular momentum out of nowhere; bulletKick
  // accounts for the small forward push the (low-mass, high-speed) bullet
  // imparts to the rubble cloud. Mass lost to dust/vapour just doesn't
  // appear as a fragment — the dust is modelled as drifting at parent
  // velocity, which conserves momentum trivially.
  //
  // Hit-angle bands for large (driven by perpFrac = |perp|/radius):
  //   < 0.35  → "center"   — clean 2-medium split
  //   > 0.7   → "glancing" — 1 medium continues + 2 small chips off struck side
  //   else    → "normal"   — 2-medium wedge
  // Large kills have a flat 1-in-10 chance to pulverise into 4 smalls — rare
  // so it stays a treat. Two flavours, picked 50/50: "line" (four smalls
  // fanned along the perpendicular axis) and "cross" (four smalls at 90°
  // apart around the bullet axis). Both conserve perpendicular momentum.
  // Medium always → 2-small wedge.
  private splitRegular(opts?: { impactDir?: Vec; impactPos?: Vec; combo?: number; onBeat?: boolean }): Asteroid[] {
    const impactDir = opts?.impactDir;
    // Unit bullet-direction d̂ and perpendicular n̂ (rotated +90°, so "left of
    // bullet"). Fall back to parent-velocity direction if no impact info.
    let dx: number, dy: number;
    if (impactDir && (impactDir.x !== 0 || impactDir.y !== 0)) {
      const L = Math.hypot(impactDir.x, impactDir.y);
      dx = impactDir.x / L; dy = impactDir.y / L;
    } else {
      const L = Math.hypot(this.vel.x, this.vel.y) || 1;
      dx = this.vel.x / L; dy = this.vel.y / L;
    }
    const nx = -dy, ny = dx;

    let hitClass: "center" | "normal" | "glancing" = "normal";
    let perpSign = rng() < 0.5 ? -1 : 1;
    if (impactDir && opts?.impactPos) {
      const ox = this.pos.x - opts.impactPos.x;
      const oy = this.pos.y - opts.impactPos.y;
      const perp = ox * nx + oy * ny;
      const perpFrac = Math.abs(perp) / Math.max(1, this.radius);
      if (perpFrac < 0.35) hitClass = "center";
      else if (perpFrac > 0.7) hitClass = "glancing";
      perpSign = perp >= 0 ? 1 : -1;
    }

    // Rare 4-small pulverise: a flat 1-in-10 roll on any large kill. Kept
    // rare so it stays a treat rather than the default outcome.
    const PULVERISE_CHANCE = 0.1;
    const pulverise = rng() < PULVERISE_CHANCE;
    // When the pulverise fires, pick line vs cross 50/50.
    const pulveriseCross = pulverise && rng() < 0.5;

    // Mass units (small = 1, medium = 8, large = 64, huge = 128). Used only for
    // the momentum-balance arithmetic below, not for any other game system.
    // Huge follows the gameplay ladder (1 huge = 2 large) rather than the
    // geometric 8× so the break math matches the 2-2-2-2 fragment recipes.
    const massOf = (s: AsteroidSize): number => (s === "small" ? 1 : s === "medium" ? 8 : s === "large" ? 64 : 128);

    // Each fragment carries a perpendicular kick (signed, in px/s along n̂)
    // and a forward bullet-kick (in px/s along d̂). The fragment's final
    // velocity is parent_vel + bulletKick * d̂ + perpKick * n̂.
    type FragSpec = { size: AsteroidSize; perpKick: number; bulletKick: number };

    // Speed scale for the perpendicular spray. Calibrated so the visible
    // outward velocity feels like the original heading-fan version, which
    // sat at parentSpeed * ~1.4 at ±0.9 rad. sin(0.9) ≈ 0.78 → perp ≈ 110.
    // We use a fixed budget (not parent-speed-scaled) so a slow rock still
    // visibly bursts when hit and a fast one doesn't catapult absurdly.
    const PERP_BURST = 110;

    // Bullet's forward push on the rubble. Small but non-zero — the rubble
    // cloud's centre-of-mass picks up a touch of the bullet's momentum.
    const BULLET_PUSH = 50;

    // Build a momentum-conserving fan from a fixed list of child sizes: fan
    // them across the perpendicular axis, then null out net perpendicular
    // momentum by subtracting the mass-weighted mean perp kick. The forward
    // bullet push shifts the whole rubble cloud slightly along the bullet line.
    const fanSpecs = (sizes: AsteroidSize[]): FragSpec[] => {
      const n = sizes.length;
      const raw = sizes.map((size, i) => {
        // Spread evenly across [-1, 1] of the perp axis; a lone fragment goes
        // straight forward (perp 0). Heavier pieces ride nearer the centre.
        const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        return { size, perp: t * PERP_BURST * 1.25 };
      });
      const totalMass = raw.reduce((s, f) => s + massOf(f.size), 0);
      const meanPerp = raw.reduce((s, f) => s + massOf(f.size) * f.perp, 0) / totalMass;
      return raw.map((f) => ({
        size: f.size,
        perpKick: f.perp - meanPerp,
        bulletKick: BULLET_PUSH,
      }));
    };

    let specs: FragSpec[];
    if (this.size === "huge") {
      // Twice-as-big rock: cleaves into a mass-conserving combo along the
      // 2-2-2-2 ladder (1 huge = 2 large = 4 medium = 8 small). Roll one of a
      // few mixed recipes — pure 2-large, blends, and the full pulverise — so
      // the same monster reads differently each kill. Every recipe sums to the
      // same large-equivalent mass (2.0 large-units).
      const HUGE_RECIPES: AsteroidSize[][] = [
        ["large", "large"],
        ["large", "medium", "medium"],
        ["large", "medium", "small", "small"],
        ["medium", "medium", "medium", "medium"],
        ["large", "medium", "medium"],
        ["medium", "medium", "small", "small", "small", "small"],
        ["small", "small", "small", "small", "small", "small", "small", "small"],
      ];
      const recipe = HUGE_RECIPES[Math.floor(rng() * HUGE_RECIPES.length)];
      specs = fanSpecs(recipe);
    } else if (this.size === "large" && this.kind === "asteroidWithGem") {
      // Gold-crystal large drops the embedded crystal pickup as its primary
      // payload (handled by killEffects), and only spits out a small handful
      // of fragments instead of the usual 2-medium / 4-small patterns. The
      // recipe is rolled 50/50:
      //   "trio" → 3 smalls fanning out (Σ perp = 0 by symmetry).
      //   "pair" → 1 small + 1 medium (mass-weighted Σ perp = 0; medium
      //            counter-recoils at 1/8 of the small's perp kick).
      // Both conserve momentum within the perpendicular axis and apply the
      // usual forward bullet push to the cloud's centre of mass.
      const trio = rng() < 0.5;
      if (trio) {
        // 3 smalls: symmetric around the bullet axis. One straight forward
        // (perp = 0), two flanking at ±PERP. Forward push spread so the
        // forward chip doesn't stack on top of the flanks.
        specs = [
          { size: "small", perpKick: -PERP_BURST, bulletKick: BULLET_PUSH * 0.9 },
          { size: "small", perpKick: 0,           bulletKick: BULLET_PUSH * 1.4 },
          { size: "small", perpKick: PERP_BURST,  bulletKick: BULLET_PUSH * 0.9 },
        ];
      } else {
        // 1 small + 1 medium: small kicks hard sideways, medium counter-
        // recoils at 1/8 of the small's perp magnitude (8 = mass ratio).
        const smallSign = rng() < 0.5 ? -1 : 1;
        const smallPerp = smallSign * PERP_BURST * 1.25;
        const medPerp = -smallPerp / massOf("medium");
        specs = [
          { size: "small",  perpKick: smallPerp, bulletKick: BULLET_PUSH * 1.1 },
          { size: "medium", perpKick: medPerp,   bulletKick: BULLET_PUSH * 0.7 },
        ];
      }
    } else if (this.size === "large") {
      if (pulverise && pulveriseCross) {
        // 4 small in a cross: four equal-mass fragments at 90° apart around the
        // bullet axis. The four perp/forward kicks sum to zero in the burst
        // frame, so parent momentum is preserved. A uniform forward bullet-push
        // shifts the rubble cloud's centre of mass slightly along the bullet
        // direction (same intent as BULLET_PUSH in the other branches).
        // Rotate the cross by 45° off the bullet axis so no fragment flies
        // straight back at the shooter.
        const crossSpeed = PERP_BURST * 1.15;
        specs = [
          { size: "small", perpKick:  crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH + crossSpeed * Math.SQRT1_2 },
          { size: "small", perpKick:  crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH - crossSpeed * Math.SQRT1_2 },
          { size: "small", perpKick: -crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH + crossSpeed * Math.SQRT1_2 },
          { size: "small", perpKick: -crossSpeed * Math.SQRT1_2, bulletKick: BULLET_PUSH - crossSpeed * Math.SQRT1_2 },
        ];
      } else if (pulverise) {
        // 4 small in a line: symmetric ±k, ±3k pattern (mass-weighted perp
        // sums to 0). All four fragments share the same forward bullet-push,
        // so they spread out along the perpendicular axis.
        specs = [
          { size: "small", perpKick: -PERP_BURST * 1.6, bulletKick: BULLET_PUSH },
          { size: "small", perpKick: -PERP_BURST * 0.55, bulletKick: BULLET_PUSH },
          { size: "small", perpKick: PERP_BURST * 0.55, bulletKick: BULLET_PUSH },
          { size: "small", perpKick: PERP_BURST * 1.6, bulletKick: BULLET_PUSH },
        ];
      } else if (hitClass === "glancing") {
        // Two small chips fly off the struck side (the centre lies perpSign-ward
        // of the bullet path, so the bullet hits the -perpSign edge). The
        // medium must counter-recoil to the perpSign side to conserve
        // perpendicular momentum.
        //   Σ m_i * perpKick_i = 0
        //   8 * v_med + 1 * v_c1 + 1 * v_c2 = 0
        // With v_c1 = -perpSign * 1.3 * PERP and v_c2 = -perpSign * 0.85 * PERP
        // (both chips off the struck side, the bullet-direction chip kicked
        // harder), v_med = perpSign * (1.3 + 0.85) / 8 * PERP ≈ 0.27 * PERP.
        const chipSign = -perpSign;
        const c1 = chipSign * 1.3 * PERP_BURST;
        const c2 = chipSign * 0.85 * PERP_BURST;
        const vMed = -(c1 + c2) / massOf("medium");
        specs = [
          { size: "medium", perpKick: vMed, bulletKick: BULLET_PUSH * 0.4 },
          { size: "small",  perpKick: c1,   bulletKick: BULLET_PUSH * 1.2 },
          { size: "small",  perpKick: c2,   bulletKick: BULLET_PUSH * 1.1 },
        ];
      } else {
        // Center / normal: symmetric 2-medium wedge, equal opposite perp kicks.
        specs = [
          { size: "medium", perpKick: -PERP_BURST, bulletKick: BULLET_PUSH },
          { size: "medium", perpKick:  PERP_BURST, bulletKick: BULLET_PUSH },
        ];
      }
    } else {
      // Medium → 2 small symmetric wedge.
      specs = [
        { size: "small", perpKick: -PERP_BURST, bulletKick: BULLET_PUSH },
        { size: "small", perpKick:  PERP_BURST, bulletKick: BULLET_PUSH },
      ];
    }

    const fragmentList: Asteroid[] = [];
    // Gold-crystal fragments are just plain rock chunks — the embedded
    // crystal was the payload, and it's been ejected as a pickup elsewhere.
    // Don't propagate the "asteroidWithGem" kind to children or we'd cascade.
    const childKind: AsteroidKind = this.kind === "asteroidWithGem" ? "normal" : this.kind;
    for (const spec of specs) {
      // Apply jitter to perp kick only (forward kick is small enough that
      // jitter on it is just noise). Keep jitter small relative to PERP_BURST
      // so the conservation arithmetic above isn't drowned out.
      const perpJ = spec.perpKick + rand(-12, 12);
      const fk = spec.bulletKick;
      const vx = this.vel.x + fk * dx + perpJ * nx;
      const vy = this.vel.y + fk * dy + perpJ * ny;
      fragmentList.push(new Asteroid({ ...this.pos }, { x: vx, y: vy }, spec.size, this.hue, childKind));
    }
    return fragmentList;
  }

  render(ctx: CanvasRenderingContext2D, t: number, comboHalo?: ComboHalo) {
    if (this.isBoss()) {
      // Dormant boss draws the swelling planetoid silhouette + the slow
      // architecture reveal; live boss draws the fully-built body with the
      // tracking eye and any in-progress fire telegraph.
      if (this.bossPhase === "dormant") this.renderBossDormant(ctx, t);
      else this.renderBossLive(ctx, t);
      return;
    }
    if (this.kind === "bossHemisphere") { this.renderBossHemisphere(ctx, t); return; }
    if (this.kind === "bossEye") { this.renderBossEye(ctx, t); return; }
    if (this.kind === "bossPlate") { this.renderBossPlate(ctx, t); return; }
    if (this.kind === "bossIrisShard") { this.renderBossIrisShard(ctx, t); return; }
    if (this.kind === "bossEmber") { this.renderBossEmber(ctx, t); return; }
    if (this.isSepulchre()) {
      if (this.bossPhase === "dormant") this.renderSepulchreDormant(ctx, t);
      else this.renderSepulchreLive(ctx, t);
      return;
    }
    if (this.kind === "pallbearer" && this.bossPhase === "dormant") {
      this.renderPallbearerDormant(ctx);
      return;
    }
    if (this.kind === "wraith") { this.renderWraith(ctx, t); return; }
    if (this.kind === "torus" || this.kind === "torusArc" || this.kind === "torusChunk") {
      this.renderTorus(ctx, t);
      return;
    }
    if (this.isBass()) {
      this.renderBass(ctx, t, comboHalo);
      return;
    }
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    const baseHue = this.hue;
    const time = t * 0.001;
    const membraneSwell = 1 + 0.025 * Math.sin(this.membranePhase * 0.5);
    ctx.scale(membraneSwell, membraneSwell);

    // Cathedral pieces are dead derelict stone — blit opaque like a solid plate
    // so the rock sits against the starfield instead of glowing through it.
    // Metal hull is the same: inert plate, drawn opaque, not glowing through.
    const isArchitectural = this.kind === "bell" || this.kind === "pallbearer" || CATHEDRAL_DEBRIS_KINDS.includes(this.kind) || isMetalHull(this.kind);
    ctx.globalCompositeOperation = isArchitectural ? "source-over" : "lighter";

    // A warble dims its whole body toward the void as it phases out. Under the
    // additive blend, a low globalAlpha reads as "fading into nothing" rather
    // than going grey — which is exactly the ghosting we want. Once it crosses
    // out of phase (warbleSolid === false) we swap the crisp body for a
    // pre-baked blurred copy at very low opacity, so the intangible window reads
    // as a faint smear rather than a solid rock.
    const isWarble = isPhasedKind(this.kind);
    if (isWarble && this.warbleBlurSprite) {
      this.renderWarbleBody(ctx);
    } else if (this.sprite) {
      ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    }
    ctx.globalCompositeOperation = "lighter";

    // Phase-ring overlay: concentric rings that bloom outward as the warble
    // ghosts away, so the player reads "it's leaving this plane". Skipped while
    // phased out — there the blurry faint body carries the read on its own.
    if (isWarble && this.warbleSolid) this.renderWarblePhase(ctx, time);

    // Pallbearer lamp + toll ring, over the baked block.
    if (this.kind === "pallbearer") this.renderPallbearerLive(ctx, time);

    // Glass prison: live eye-glow pulse over the baked silhouette. One pair of
    // faint red pinpricks per captive, breathing in and out so the figures
    // inside read as "alive, watching" — and so the player can COUNT what a
    // shell is holding before deciding to crack it. Drawn additive so it
    // brightens through the void without flattening the frosted facets.
    if (isGlassPrison(this.kind)) {
      ctx.globalCompositeOperation = "lighter";
      for (let c = 0; c < this.prisonCaptives; c++) {
        // Stagger the brood across the shell interior: alternating sides,
        // descending rows, each on its own breath phase so they never blink in
        // unison. A lone captive sits dead centre where it always has.
        const spread = this.prisonCaptives > 1 ? (c - (this.prisonCaptives - 1) / 2) : 0;
        const cx = spread * this.radius * 0.30;
        const cy = -this.radius * 0.30 + Math.abs(spread) * this.radius * 0.16;
        const eyePulse = 0.55 + 0.45 * Math.sin(time * 1.6 + this.membranePhase + c * 1.9);
        const eyeX = this.radius * 0.055;
        const glowR = this.radius * 0.22 * (0.7 + 0.3 * eyePulse);
        drawGlow(ctx, cx - eyeX, cy, glowR, 0, 0.55 * eyePulse);
        drawGlow(ctx, cx + eyeX, cy, glowR, 0, 0.55 * eyePulse);
        ctx.globalAlpha = 1;
        // Tight bright pupil dots over the glow so each gaze has a centre.
        ctx.fillStyle = `hsla(8, 100%, 80%, ${0.85 * eyePulse})`;
        ctx.beginPath();
        ctx.arc(cx - eyeX, cy, 1.2, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx + eyeX, cy, 1.2, 0, TAU);
        ctx.fill();
      }
    }

    const isPlain = this.kind === "normal" || this.kind === "asteroidWithGem";
    const nSat = isPlain ? 6 : 100;
    // Bell asteroid + its carved debris are baked architectural sprites —
    // drifting bioluminescent nuclei would read as bright pinpricks floating
    // on a stone wall.
    if (!isArchitectural) {
      const nucleusList = this.nuclei;
      for (const n of nucleusList) {
        const driftR = n.dist + Math.sin(time * n.pulseSpeed + n.pulsePhase) * 2;
        const nx = Math.cos(n.angle) * driftR;
        const ny = Math.sin(n.angle) * driftR;
        const pulse = 0.6 + 0.4 * Math.sin(time * n.pulseSpeed * 2 + n.pulsePhase);
        ctx.fillStyle = `hsla(${baseHue + 30}, ${nSat}%, 96%, ${pulse})`;
        ctx.beginPath();
        ctx.arc(nx, ny, n.size * 0.9, 0, TAU);
        ctx.fill();
      }
    }

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, ${nSat}%, 95%, ${this.flashAmount * 0.25})`;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.1, 0, TAU);
      if (this.kind === "citadel") {
        // The escape hole is bare space — the hit flash must not fill it.
        traceCitadelHolePath(ctx);
        ctx.fill("evenodd");
      } else {
        ctx.fill();
      }
    }

    this.renderCracks(ctx);

    ctx.restore();
  }

  // Render a torus body (whole ring) or one of its arc/chunk fragments: blit
  // the pre-baked mechanical sprite (no organic membrane swell / drifting
  // nuclei — these are machines), add the hit/beat flash, then for a fragment
  // draw the flickering energy thread to its next neighbour around the ring so
  // the broken pieces read as still electrically bound into one ring.
  private renderTorus(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    // Connecting energy is drawn in world space (it spans two fragments), so
    // paint it before the local-space body transform.
    if ((this.kind === "torusArc" || this.kind === "torusChunk") && this.torusGroup) {
      this.renderTorusThread(ctx, time);
    }
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);
    ctx.globalCompositeOperation = "lighter";
    if (this.sprite) ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    // Hit flash: a quick bright bloom over the tube when shot.
    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${this.hue + 20}, 90%, 92%, ${this.flashAmount * 0.22})`;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius * 1.05, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // Flickering energy thread from this fragment to the next fragment around the
  // shared ring (ordered by slot, wrapping). Each fragment draws exactly one
  // segment — the segment to its clockwise neighbour — so the whole group's
  // chain is painted collectively with no duplication. The arc follows the
  // phantom-ring path between the two break-faces and periodically flickers
  // on/off (per-segment phase from the slot so they don't pulse in unison).
  private renderTorusThread(ctx: CanvasRenderingContext2D, time: number) {
    const group = this.torusGroup;
    if (!group) return;
    const living = group.members.filter((m) => m.alive);
    if (living.length < 2) return;
    // Find the neighbour with the next-larger slot (wrap to the smallest).
    const mySlot = this.torusSlot;
    let next: Asteroid | null = null;
    let bestDelta = Infinity;
    for (const m of living) {
      if (m === this) continue;
      let d = m.torusSlot - mySlot;
      while (d <= 1e-3) d += TAU;
      while (d > TAU) d -= TAU;
      if (d < bestDelta) { bestDelta = d; next = m; }
    }
    if (!next) return;

    // Flicker: a fast-ish on/off envelope, per-segment phase from the slot. The
    // thread is fully dark for part of every cycle (the "periodic flickering").
    const phase = this.torusSlot * 1.7;
    const flick = Math.sin(time * 6.5 + phase) * 0.5 + 0.5;
    const env = Math.max(0, flick - 0.35) / 0.65; // dark below 0.35, ramps to 1
    if (env <= 0.01) return;

    const H = group.hue;
    const cx = group.center.x;
    const cy = group.center.y;
    const r = group.ringRadius;
    // Walk the phantom-ring arc from this fragment's leading edge to the
    // neighbour's trailing edge, jittering radius for a crackling-energy look.
    const a0 = mySlot + group.phase + this.torusArcSpan * 0.5;
    const a1 = a0 + (bestDelta - this.torusArcSpan * 0.5 - next.torusArcSpan * 0.5);
    const steps = 14;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Two passes: a soft wide glow underlay, then a hot thin core.
    for (const pass of [0, 1] as const) {
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const ang = a0 + (a1 - a0) * f;
        // Energy arcs bow slightly off the centreline and crackle along its run.
        const bow = Math.sin(f * Math.PI) * r * 0.06;
        const crackle = Math.sin(time * 22 + f * 19 + phase) * r * 0.03 * env;
        const rr = r + bow + crackle;
        const px = cx + Math.cos(ang) * rr;
        const py = cy + Math.sin(ang) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      if (pass === 0) {
        ctx.lineWidth = 6;
        ctx.strokeStyle = `hsla(${H + 10}, 90%, 60%, ${0.18 * env})`;
      } else {
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = `hsla(${H + 35}, 100%, 88%, ${0.85 * env})`;
      }
      ctx.stroke();
    }
    // Bright nodes where the thread meets each break-face.
    const endA = a1;
    const ex = cx + Math.cos(endA) * r;
    const ey = cy + Math.sin(endA) * r;
    const sx = cx + Math.cos(a0) * r;
    const sy = cy + Math.sin(a0) * r;
    drawGlow(ctx, sx, sy, r * 0.1 * env, H, 0.6 * env);
    drawGlow(ctx, ex, ey, r * 0.1 * env, H, 0.6 * env);
    ctx.restore();
  }

  // Draw the warble body: the crisp baked sprite while solid, crossfading into
  // the pre-baked blurred copy as it phases out, so out-of-phase reads as a
  // faint smeared ghost. warbleOpacity runs 1 (peak) down to lowOpacity
  // (trough); solidThreshold splits solid from phased-out. In the phased-out
  // trough we drop the alpha well below warbleOpacity so it goes genuinely
  // wispy, not merely dim. Leaves globalAlpha at the faint body level on exit
  // (matching the old renderWarblePhase contract) so the nuclei / flash drawn
  // afterward fade in step with the body.
  private renderWarbleBody(ctx: CanvasRenderingContext2D) {
    const dx = -this.spriteHalfSize;
    const dy = -this.spriteHalfSize;
    if (this.warbleSolid || !this.warbleBlurSprite) {
      ctx.globalAlpha = this.warbleOpacity;
      if (this.sprite) ctx.drawImage(this.sprite, dx, dy);
      return;
    }
    const warble = this.kind === "citadel" ? ENTITY_CONFIG.citadel : ENTITY_CONFIG.warble;
    const th = warble.solidThreshold;
    // 0 at the threshold → 1 at the deepest trough; how far "out of phase" we are.
    const phased = Math.max(0, Math.min(1, (th - this.warbleOpacity) / (th - warble.lowOpacity)));
    // The citadel's phased-out window is when the player lines up with the
    // escape hole, so its trough stays brighter and keeps a healthy share of
    // the crisp sprite — the warble goes properly wispy.
    const troughDrop = this.kind === "citadel" ? 0.25 : 0.7;
    const blurMix = this.kind === "citadel" ? 0.55 * phased : phased;
    // Ramp the whole body down to a faint smear at the trough, then split it
    // between the fading crisp sprite and the rising blurred one.
    const faint = this.warbleOpacity * (1 - troughDrop * phased);
    if (this.sprite && blurMix < 1) {
      ctx.globalAlpha = faint * (1 - blurMix);
      ctx.drawImage(this.sprite, dx, dy);
    }
    ctx.globalAlpha = faint * (0.4 + 0.6 * blurMix);
    ctx.drawImage(this.warbleBlurSprite, dx, dy);
    // Leave the ambient alpha at the faint level for the overlays below.
    ctx.globalAlpha = faint;
  }

  // Warble phase overlay. Concentric rings ripple outward from the body and
  // intensify as the rock ghosts out, so "this thing is phasing between planes"
  // reads at a glance. Only drawn while solid — once phased out the faint
  // blurred body carries the read on its own. Sets its own additive alpha and
  // restores warbleOpacity on exit so the body overlays drawn after this stay
  // dimmed in step with the body.
  private renderWarblePhase(ctx: CanvasRenderingContext2D, time: number) {
    // 0 at solid peak → 1 at the dim trough. Drives ring bloom + brightness.
    const ghost = 1 - this.warbleOpacity;
    const hue = this.hue;
    ctx.globalCompositeOperation = "lighter";
    // Two outward-rippling rings, phase-staggered, that swell with `ghost`.
    const ringCount = 2;
    for (let i = 0; i < ringCount; i++) {
      const ripple = (time * 0.6 + i / ringCount) % 1;
      const r = this.radius * (0.7 + ripple * (0.9 + ghost * 0.8));
      const alpha = ghost * 0.5 * (1 - ripple);
      if (alpha <= 0.001) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = `hsl(${hue + 40}, 90%, 70%)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = this.warbleOpacity;
  }

  // Wraith renderer — fully live-painted. The whole point of this entity is
  // motion that "shouldn't be possible", so a baked sprite would defeat it.
  // Layered approach: outer aura → 3 drifting noisy silhouettes at different
  // writhe phases (the "ghost in multiple film exposures" read) → wispy
  // tendrils extruding outward → eyes tracking the ship. Hue shifts from
  // deep violet (idle) toward red while lunging.
  private renderWraith(ctx: CanvasRenderingContext2D, t: number) {
    const time = t * 0.001;
    const phase = this.writhePhase;
    const emerge = this.wraithEmerge;
    // Lunge mix: smooth 0→1 by how active the lunge is. Drives hue shift
    // toward red and brightens the eyes.
    const lungeCfg = ENTITY_CONFIG.wraith;
    const lungeMix = lungeCfg.lungeDuration > 0
      ? Math.min(1, Math.max(0, this.lungeActiveT / lungeCfg.lungeDuration))
      : 0;
    // Windup mix ramps 0→1 as the telegraph completes (it counts DOWN, so
    // invert), so the coil tightens and the eyes redden right up to ignition —
    // the player's cue to break off.
    const windupMix = this.wraithMode === "windup" && lungeCfg.windupDuration > 0
      ? Math.min(1, Math.max(0, 1 - this.windupActiveT / lungeCfg.windupDuration))
      : 0;
    // Recovery mix 1→0 across the vulnerable window; dims and slackens the body
    // so "hit it NOW" is legible at a glance.
    const recoverMix = this.wraithMode === "recover" && lungeCfg.recoverDuration > 0
      ? Math.min(1, Math.max(0, this.wraithModeT / lungeCfg.recoverDuration))
      : 0;
    // Both the strike phases pull the body toward red; recovery pulls nothing
    // (it stays violet, and goes dim).
    const heatMix = Math.max(lungeMix, windupMix);
    const hue = this.hue + (0 - this.hue) * heatMix * 0.35;
    // Coil: contract during the windup, sag outward while spent.
    const R = this.radius * (1 - 0.16 * windupMix + 0.10 * recoverMix);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.globalCompositeOperation = "lighter";

    // (1) Outer aura — dim purple haze, larger than the body. Sells the
    // "this thing has a presence around it" read without using shadowBlur.
    // Windup swells the aura (pressure building); recovery guts it.
    const auraAlpha = 0.28 * emerge * (0.7 + 0.3 * Math.sin(phase * 0.7))
      * (1 + 0.8 * windupMix) * (1 - 0.55 * recoverMix);
    drawGlow(ctx, 0, 0, R * (2.6 + 0.5 * windupMix), hue, auraAlpha);
    ctx.globalAlpha = 1;

    // (2) Three drifting noisy body layers. Each layer is a closed wobble
    // polygon, offset in phase + tinted at a different lightness, so the
    // body reads as "ghost in multiple exposures". The polygons are drawn
    // around a base radius modulated by sin-harmonics of `phase`.
    const layers: Array<{ phaseOff: number; rMul: number; alpha: number; lightness: number }> = [
      { phaseOff: 0.0, rMul: 1.00, alpha: 0.45, lightness: 22 },
      { phaseOff: 1.3, rMul: 0.85, alpha: 0.35, lightness: 32 },
      { phaseOff: 2.6, rMul: 0.72, alpha: 0.30, lightness: 44 },
    ];
    const wobbleSamples = 24;
    for (const layer of layers) {
      ctx.fillStyle = `hsla(${hue}, 75%, ${layer.lightness}%, ${layer.alpha * emerge})`;
      ctx.beginPath();
      for (let i = 0; i < wobbleSamples; i++) {
        const a = (i / wobbleSamples) * TAU;
        // 3-fold + 5-fold deformation with phase offset per layer gives each
        // layer its own "breathing" rhythm.
        const dist = R * layer.rMul * (
          1
          + 0.18 * Math.sin(a * 3 + phase + layer.phaseOff)
          + 0.10 * Math.sin(a * 5 - phase * 1.3 + layer.phaseOff)
          + 0.05 * Math.cos(a * 7 + phase * 0.6)
        );
        const x = Math.cos(a) * dist;
        const y = Math.sin(a) * dist;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // (3) Tendrils — wispy extrusions per stored phase offset. Length
    // oscillates so they look like reaching limbs. Drawn as tapered lines
    // (thicker near the body, thin at the tip) using a small gradient stroke
    // approximation: draw segments with decreasing alpha + width.
    const tendrilSegments = 6;
    for (const baseAngle of this.wraithTendrils) {
      const a = baseAngle + Math.sin(phase * 0.4 + baseAngle) * 0.25;
      // Length ramps with lungeMix — tendrils extend during a lunge.
      // Tendrils draw IN as it coils (windupMix), whip out during the strike,
      // and hang slack while spent.
      const lengthMul = 0.95 + 0.55 * Math.sin(phase * 0.8 + baseAngle * 1.3)
        + lungeMix * 0.6 - windupMix * 0.45 - recoverMix * 0.25;
      const length = R * lengthMul;
      for (let s = 0; s < tendrilSegments; s++) {
        const f0 = s / tendrilSegments;
        const f1 = (s + 1) / tendrilSegments;
        // Curl: each segment offset slightly perpendicular to the tendril
        // axis, growing with distance from the body. Curl direction flips
        // with phase so the tendril wriggles instead of holding a static curve.
        const curl0 = Math.sin(phase + baseAngle + f0 * 3.0) * R * 0.18 * f0;
        const curl1 = Math.sin(phase + baseAngle + f1 * 3.0) * R * 0.18 * f1;
        const r0 = R * 0.85 + f0 * length;
        const r1 = R * 0.85 + f1 * length;
        const px = Math.cos(a) * r0 - Math.sin(a) * curl0;
        const py = Math.sin(a) * r0 + Math.cos(a) * curl0;
        const qx = Math.cos(a) * r1 - Math.sin(a) * curl1;
        const qy = Math.sin(a) * r1 + Math.cos(a) * curl1;
        const segAlpha = (1 - f0) * 0.55 * emerge;
        ctx.strokeStyle = `hsla(${hue + 8}, 80%, ${50 - f0 * 30}%, ${segAlpha})`;
        ctx.lineWidth = (1 - f0) * 3.2 + 0.3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(qx, qy);
        ctx.stroke();
      }
    }

    // (4) Inner dark heart — a small near-black pit at centre. Without this
    // the wraith reads as a soft cloud; the dark core makes it feel hollow.
    const heartR = R * 0.35;
    const heartGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, heartR);
    heartGrad.addColorStop(0, `hsla(${hue - 10}, 90%, 4%, 0.85)`);
    heartGrad.addColorStop(1, `hsla(${hue}, 80%, 8%, 0)`);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = heartGrad;
    ctx.beginPath();
    ctx.arc(0, 0, heartR, 0, TAU);
    ctx.fill();

    // (5) Eyes — two pinpricks tracking the ship. The local-space angle was
    // resolved in update() and stored on `rotation`; we just place the eyes
    // along that direction. Brighter, redder, larger while lunging.
    const gazeX = Math.cos(this.rotation) * R * 0.18;
    const gazeY = Math.sin(this.rotation) * R * 0.18;
    const perpX = -Math.sin(this.rotation) * R * 0.10;
    const perpY =  Math.cos(this.rotation) * R * 0.10;
    const eyeHue = 286 - heatMix * 280;  // violet → red
    // The windup is the telegraph, so the eyes must be at their brightest
    // BEFORE the strike, not during it.
    const eyeBright = (0.6 + 0.4 * Math.sin(time * 5 + phase) + heatMix * 0.8 + windupMix * 0.5)
      * (1 - 0.5 * recoverMix);
    const eyeR = R * 0.18 * (0.6 + 0.4 * eyeBright);
    ctx.globalCompositeOperation = "lighter";
    drawGlow(ctx, gazeX + perpX, gazeY + perpY, eyeR, eyeHue, 0.7 * eyeBright * emerge);
    drawGlow(ctx, gazeX - perpX, gazeY - perpY, eyeR, eyeHue, 0.7 * eyeBright * emerge);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `hsla(${eyeHue}, 100%, 90%, ${0.95 * emerge})`;
    ctx.beginPath();
    ctx.arc(gazeX + perpX, gazeY + perpY, 1.4, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(gazeX - perpX, gazeY - perpY, 1.4, 0, TAU);
    ctx.fill();

    // (6) Hit flash — same approach as the standard render, but in the
    // wraith's body-tint so the flash feels of-a-piece with the entity.
    if (this.flashAmount > 0) {
      ctx.globalCompositeOperation = "lighter";
      drawGlow(ctx, 0, 0, R * 1.6, hue + 20, this.flashAmount * 0.45);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  // Trace this asteroid's silhouette into the current path, in local space
  // (assumes caller has already translated to pos and rotated by rotation),
  // scaled by `scale` relative to radius=1. For bassteroids the path is the
  // union of all module polygons (each module is a subpath); for organic
  // asteroids it's the lumpy Fourier outline. Use this to draw silhouette-
  // shaped pulses, halos, or hit flashes instead of a generic circle.
  // `offX`/`offY` shift the whole path (the citadel's stacked plate bands).
  tracePath(ctx: CanvasRenderingContext2D, scale: number, offX = 0, offY = 0) {
    ctx.beginPath();
    if (this.isBass() && this.bassShip) {
      for (const module of this.bassShip.modules) {
        for (let i = 0; i < module.vertices.length; i++) {
          const x = module.vertices[i].x * this.radius * scale;
          const y = module.vertices[i].y * this.radius * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      return;
    }
    for (let i = 0; i < this.outlineSamples; i++) {
      const angle = (i / this.outlineSamples) * TAU;
      const r = this.outline[i] * scale;
      const x = offX + Math.cos(angle) * r;
      const y = offY + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  // Combo-halo outline: the boundary of the union of every module polygon,
  // each inflated outward by gapPx with sharp mitered corners. Tracing the
  // union (rather than each module) drops the interior shared edges that used
  // to criss-cross multi-module rocks, while still following the true outer
  // perimeter exactly — every concave notch and sharp corner preserved.
  // Pixel-space (already × radius); served from the shared shape cache so the
  // O(edges²) clip runs once per distinct shape, never per frame.
  buildHaloOutline(gapPx: number): { x: number; y: number }[][] {
    if (!this.bassShip) return [];
    return getHaloOutline(this.bassShip, this.radius, gapPx);
  }

  // Trace the cached combo-halo outline into the current path (local space,
  // caller already translated/rotated). The shape cache means the offset
  // polygons are computed once per (geometry, radius, gap) and reused.
  traceHaloOutline(ctx: CanvasRenderingContext2D) {
    if (!this.haloOutline) this.haloOutline = this.buildHaloOutline(BASS_HALO_GAP_PX);
    ctx.beginPath();
    for (const poly of this.haloOutline) {
      for (let i = 0; i < poly.length; i++) {
        if (i === 0) ctx.moveTo(poly[i].x, poly[i].y);
        else ctx.lineTo(poly[i].x, poly[i].y);
      }
      ctx.closePath();
    }
  }

  // Generic crack overlay used by both organic asteroids and bassteroids.
  // Draws one crack per HP lost (jagged fracture-lines radiating from the
  // impact point) as a dark inner stroke plus a thin bright over-stroke
  // (heat/strain glow). Caller must have already translated to the
  // asteroid's centre and rotated into its frame.
  renderCracks(ctx: CanvasRenderingContext2D) {
    const cracksToDraw = Math.min(this.maxHp - this.hp, this.cracks.length);
    if (cracksToDraw <= 0) return;
    ctx.save();
    this.tracePath(ctx, 1);
    if (this.kind === "citadel") {
      // Keep the fractures on the shell — the escape hole stays bare space.
      traceCitadelHolePath(ctx);
      ctx.clip("evenodd");
    } else {
      ctx.clip();
    }
    const crackScale = 0.7;
    for (let i = 0; i < cracksToDraw; i++) {
      const crack = this.cracks[i];
      const dx = crack.pos.x * this.radius;
      const dy = crack.pos.y * this.radius;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(crack.angle);
      ctx.scale(crackScale, crackScale);

      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(245,245,250,0.45)";
      ctx.lineWidth = 1.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const branch of crack.branches) {
        ctx.beginPath();
        for (let p = 0; p < branch.points.length; p++) {
          const px = branch.points[p].x * this.radius;
          const py = branch.points[p].y * this.radius;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(255,255,255,0.3)`;
      ctx.lineWidth = 0.5;
      for (const branch of crack.branches) {
        ctx.beginPath();
        for (let p = 0; p < branch.points.length; p++) {
          const px = branch.points[p].x * this.radius;
          const py = branch.points[p].y * this.radius;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // Render path for bassteroids: pre-baked modular sprite + live cracks
  // (one per HP lost) + a big bright beat flare on the beat. The beat flare
  // gates the visual rhythm — when all four kinds are active it reads as a
  // syncopated lighthouse sweep across the screen.
  renderBass(ctx: CanvasRenderingContext2D, t: number, comboHalo?: ComboHalo) {
    const baseHue = this.hue;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Breathing corona — the boss's slow living-planet pulse, given to the
    // bassteroids so they're never inert between beats. One cached glow-sprite
    // blit (no per-frame gradient), drawn behind the body so it reads as the
    // rock's own aura. Same breath math as the boss corona.
    {
      const breath = 0.5 + 0.5 * Math.sin(t * 0.0018 + this.pos.x * 0.01);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      drawGlow(ctx, 0, 0, this.radius * (1.4 + 0.12 * breath), baseHue, 0.1 + 0.06 * breath);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Beat-time bloom drawn as scaled copies of the bassteroid silhouette
    // rather than a generic circle, so the pulse reads as "the shape getting
    // bigger" instead of an unrelated disc. Two concentric scaled outlines
    // (outer = soft glow, inner = bright rim) sell the shockwave.
    if (this.beatFlash > 0) {
      const a = this.beatFlash;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const outerScale = 1.7 + 0.6 * a;
      ctx.fillStyle = `hsla(${baseHue + 25}, 100%, 70%, ${0.22 * a})`;
      this.tracePath(ctx, outerScale);
      ctx.fill();

      const innerScale = 1.25 + 0.18 * a;
      ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 90%, ${0.95 * a})`;
      ctx.lineWidth = 2.4 + 2.6 * a;
      this.tracePath(ctx, innerScale);
      ctx.stroke();
      ctx.restore();
    }

    // A small scale-up on the beat (cosmetic only — collisions still use
    // this.radius). Capped low enough that the bassteroid doesn't appear to
    // grow into the player's path during a rhythm window.
    const beatScale = 1 + 0.06 * this.beatFlash;
    ctx.scale(beatScale, beatScale);
    ctx.globalCompositeOperation = "lighter";

    // Combo halo: at 4+ rhythm (ship halo tier 2) every bassteroid wears the
    // same gold beat-pulsing outline the ship does, shifting to white at 12+
    // (tier 3) — same hue/sat/light/alpha math as shipComboHalo.paintActiveHalo,
    // gated by tier2 so it only exists once the ship halo has turned gold.
    // Eased by the ship's comboHaloIntensity so it ignites and fades in
    // lockstep with the ship's own halo. Traced on the bassteroid's silhouette
    // (just outside the hull) so it reads as the rock joining the combo, not a
    // HUD ring.
    if (comboHalo) {
      const tier2 = Math.max(0, Math.min(1, comboHalo.intensity - 1));
      const tier3 = Math.max(0, Math.min(1, comboHalo.intensity - 2));
      if (tier2 > 0.001) {
        const hue = 195 + (45 - 195) * tier2;
        const sat = 100 * (1 - tier3);
        const flash = this.beatFlash;
        // Overdrive above rhythm 12: the tier system tops out at white here, so
        // `sup` (0→1 as rhythm climbs 12→24) is the only headroom left. It fattens
        // the aura and drives an extra white bloom pass so the halos read as
        // "much brighter" the deeper into the streak the player is.
        const sup = comboHalo.super;

        // Shimmer: a low-amplitude twinkle on the resting line so the halo is
        // never perfectly static. Two incommensurate sines (one slow drift,
        // one faster glint that travels via the phase term) keep it from
        // reading as a single throb.
        const shimmer =
          0.5 +
          0.5 * (0.6 * Math.sin(t * 0.0021 + this.beatPhase * 7) +
                 0.4 * Math.sin(t * 0.0047 + this.pos.x * 0.03));

        // Warm-up: in the last slice of the beat interval the rim tightens and
        // brightens — a held breath before the downbeat. Eased so it ramps in
        // gently over the final ~22% rather than snapping on.
        const WARMUP_FROM = 0.78;
        const warm =
          this.beatPhase > WARMUP_FROM
            ? Math.pow((this.beatPhase - WARMUP_FROM) / (1 - WARMUP_FROM), 1.6)
            : 0;

        // Resting line is faint now; the on-beat flash, the warm-up and the
        // shimmer are what carry it. beatFlash still whites it out on the hit.
        const light = Math.min(100, 70 + (100 - 70) * tier3 + 22 * flash + 12 * warm);
        const alpha =
          (0.22 + 0.12 * comboHalo.beatPulse + 0.08 * shimmer + 0.5 * flash + 0.2 * warm) * tier2 *
          (1 + 0.9 * sup);

        // Expanding soundwave echo: on the beat the perimeter sheds a small
        // family of staggered copies that ride outward and dissolve. Driven by
        // haloEcho (slow-decaying, ~1.2s) so the wave outlives the on-beat
        // flash entirely — a halo that breathes a ring out into the dark after
        // every pulse. Each ring lags the previous by a fixed phase so they
        // read as a soft expanding train, not one fat band.
        if (this.haloEcho > 0.001) {
          const ECHO_RINGS = 3;
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          for (let r = 0; r < ECHO_RINGS; r++) {
            // Age 0→1 across this ring's life; staggered so trailing rings are
            // younger (tighter) than leading ones at any instant.
            const age = (1 - this.haloEcho) + r * 0.16;
            if (age <= 0 || age >= 1) continue;
            // Decelerating expansion (ease-out) out to ~2.4× — soundwave-like.
            const eased = 1 - (1 - age) * (1 - age);
            const ringScale = 1 + 1.4 * eased;
            // Fade as it expands; leading rings are dimmer so the train tapers.
            const fade = (1 - age) * (1 - age);
            const ringA = 0.4 * fade * tier2 * (1 - r * 0.22);
            if (ringA <= 0.003) continue;
            ctx.save();
            ctx.scale(ringScale, ringScale);
            this.traceHaloOutline(ctx);
            ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${ringA})`;
            // Keep an even apparent thickness as the ring grows.
            ctx.lineWidth = Math.max(0.8, this.radius * 0.05) / ringScale;
            ctx.stroke();
            ctx.restore();
          }
          ctx.restore();
        }

        // On-beat flare: a fat, bright additive bloom that only swells when the
        // beat is active. Drawn under the resting outline so the active-beat
        // pop reads as the rim igniting — much larger and brighter than the
        // resting line, then gone as beatFlash decays. Squared on flash so the
        // growth front-loads onto the downbeat instead of fading linearly.
        if (flash > 0.001) {
          const f2 = flash * flash;
          const w = Math.max(1, this.radius * 0.04);
          this.traceHaloOutline(ctx);
          ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${Math.min(100, light + 8)}%, ${0.7 * f2 * tier2})`;
          ctx.lineWidth = w * (3 + 9 * flash);
          ctx.stroke();
        }

        // The bassteroid body is a big bright additive sprite, so a hairline
        // stroke vanishes against it — the halo carries its own glow. Same
        // path stroked twice: a wide faint aura pass, a narrow bright rim pass
        // (the trick the beat flare uses instead of shadowBlur). Both widen on
        // the beat and the warm-up so the anticipation reads as a bloom.
        const w = Math.max(1, this.radius * 0.04);
        this.traceHaloOutline(ctx);
        ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${Math.min(100, light - 10)}%, ${(0.3 + 0.2 * flash + 0.15 * warm) * alpha})`;
        ctx.lineWidth = w * (2.4 + 4.5 * flash + 1.2 * warm) * (1 + 1.1 * sup);
        ctx.stroke();
        ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
        ctx.lineWidth = w * (1 + 0.6 * flash + 0.3 * warm) * (1 + 0.5 * sup);
        ctx.stroke();

        // Overdrive white bloom: past rhythm 12 a fat, near-white halo pass rides
        // on top of the coloured rim, so the whole outline blazes hotter the
        // deeper the streak. Widens with the beat + warm-up like the rim itself.
        if (sup > 0.001) {
          this.traceHaloOutline(ctx);
          ctx.strokeStyle = `hsla(${hue}, ${sat * 0.5}%, 100%, ${(0.14 + 0.16 * flash + 0.08 * warm) * sup})`;
          ctx.lineWidth = w * (3.5 + 6 * flash + 1.5 * warm) * sup;
          ctx.stroke();
        }
      }
    }

    if (this.sprite) {
      ctx.drawImage(this.sprite, -this.spriteHalfSize, -this.spriteHalfSize);
    }

    // Live rim shimmer — a faint additive glint travelling along the baked rim,
    // driven by the same incommensurate-sines used by the combo halo and the
    // boss rim, so boss and bassteroid edges glint in one shared rhythm. The
    // baked rim (Phase B of the sprite) is the resting line; this rides on top.
    {
      const shimmer =
        0.5 +
        0.5 * (0.6 * Math.sin(t * 0.0021 + this.beatPhase * 7) +
               0.4 * Math.sin(t * 0.0047 + this.pos.x * 0.03));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      this.tracePath(ctx, 1);
      ctx.strokeStyle = `hsla(${baseHue + 18}, 100%, 82%, ${0.1 + 0.16 * shimmer})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }

    this.renderCracks(ctx);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 95%, ${this.flashAmount * 0.32})`;
      this.tracePath(ctx, 1.05);
      ctx.fill();
    }

    ctx.restore();
  }

  // Boss eased reveal curve. 0 → 1 over the 8s dormant window, with a
  // Two-phase dormant intro keyed off absolute seconds:
  //   quiet  (all but the last revealActiveDuration s): a black, subdued
  //          silhouette slowly swelling toward full size — reads as part of
  //          the background. No architecture, no colour, no motion.
  //   active (the final revealActiveDuration s): the planetoid shudders,
  //          dusts its crust off to expose the boss architecture, makes its
  //          final swell to full radius, and the eye begins to crack. The eye
  //          barely parts for most of this window, then snaps fully open over
  //          the last 100ms.
  // Returns: swellT (0..1 body size), revealT (0..1 architecture visibility),
  // shudder (0..1 shake intensity), dust (0..1 crust-shedding amount), and
  // lidOpen (0..1 eye-open progress).
  // Both bosses run the same dormant clock off their own config block: the
  // planetoid's crust-and-eye reveal and the tomb's shudder-and-shutter arrival
  // are the same shape of event, so they share the phase math below.
  revealTiming(): { total: number; active: number } {
    const cfg = this.isSepulchre() ? ENTITY_CONFIG.sepulchre : ENTITY_CONFIG.boss;
    const total = Math.max(0.001, cfg.revealDuration);
    return { total, active: Math.min(total, cfg.revealActiveDuration) };
  }

  bossDormantPhase(): { swellT: number; revealT: number; shudder: number; dust: number; lidOpen: number } {
    const { total, active } = this.revealTiming();
    const elapsed = this.bossRevealT;
    const activeStart = total - active;
    // Seconds into the active window (negative while still quiet).
    const aS = elapsed - activeStart;
    // 0..1 progress through the active window.
    const a = Math.max(0, Math.min(1, aS / active));

    // Quiet swell: slow creep from the planet's last silhouette size up to
    // ~88% across the whole long approach. Background-like, never hurried.
    const quietProgress = Math.min(1, elapsed / activeStart);
    const quietSwell = quietProgress * 0.88;
    // Active swell: finish from 88% to full over the active window, eased so
    // the body settles into its final size rather than lurching.
    const activeSwell = a * a * (3 - 2 * a) * 0.12;
    const swellT = aS < 0 ? quietSwell : 0.88 + activeSwell;

    // Architecture only resolves during the active window — before that the
    // body is a pure black disc. Ramps in over the first ~70% of the window
    // (the dust-off) and is fully painted before the eye snaps open.
    const revealT = aS < 0 ? 0 : Math.min(1, a / 0.7);

    // Shudder ramps up across the active window (quadratic so it builds), so
    // the planetoid trembles harder the closer it is to waking.
    const shudder = aS < 0 ? 0 : a * a;
    // Dust sheds most heavily in the first half of the active window as the
    // crust breaks away, then tapers as the architecture stands revealed.
    const dust = aS < 0 ? 0 : Math.sin(Math.min(1, a * 1.3) * Math.PI);

    // Eye: barely cracks for most of the active window (creeps to ~0.14),
    // then snaps fully open over the last 100ms, smoothly continuing from the
    // partly-open form rather than jumping.
    const snapWindow = 0.1; // seconds of the final fast open
    const sliver = 0.08;    // how far the eye barely cracks before the snap
    const secsLeft = total - elapsed;
    let lidOpen: number;
    if (aS < 0) {
      lidOpen = 0;
    } else if (secsLeft > snapWindow) {
      // Slow creep to a bare sliver across the whole active window.
      lidOpen = sliver * a;
    } else {
      // Final 100ms: smoothstep from the sliver to fully open, continuing
      // smoothly from the partly-cracked form rather than jumping.
      const s = Math.max(0, Math.min(1, 1 - secsLeft / snapWindow));
      const eased = s * s * (3 - 2 * s);
      lidOpen = sliver + (1 - sliver) * eased;
    }
    return { swellT, revealT, shudder, dust, lidOpen };
  }

  // Render the dormant whole-body boss: a swelling planet silhouette that
  // gradually reveals modular architecture as it rotates. Mimics the
  // background-planet renderer (dark disc + faint rim) at the start so the
  // hand-off from background planet → boss is seamless.
  renderBossDormant(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const phase = this.bossDormantPhase();
    const r = this.radius * (0.42 + 0.58 * phase.swellT);

    ctx.save();
    // Shudder: as the planetoid wakes it trembles in place, harder the closer
    // it is to bursting. Pure cosmetic jitter — collisions are off while
    // dormant. A fast wobble plus a coarse per-frame kick so it reads as a
    // strained rumble, not a smooth orbit.
    let shakeX = 0, shakeY = 0;
    if (phase.shudder > 0.001) {
      const amp = phase.shudder * 6;
      shakeX = Math.sin(t * 0.05) * amp * 0.5 + (cosmeticRng() - 0.5) * amp;
      shakeY = Math.cos(t * 0.061) * amp * 0.5 + (cosmeticRng() - 0.5) * amp;
    }
    ctx.translate(this.pos.x + shakeX, this.pos.y + shakeY);

    // Soft outer corona — invisible during the quiet black approach, blooms
    // only as the architecture is dusted off in the active window.
    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const coronaA = 0.05 + 0.18 * phase.revealT;
      const coronaR = r * (1.25 + 0.18 * phase.revealT);
      const corona = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, coronaR);
      corona.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${coronaA * 0.5})`);
      corona.addColorStop(0.55, `hsla(${baseHue - 8}, 100%, 45%, ${coronaA * 0.25})`);
      corona.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(0, 0, coronaR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Dark silhouette body — matches the background planet's near-black so the
    // quiet phase reads as part of the backdrop, not a thing to shoot. Stays
    // essentially black until the reveal window, when it lifts toward a faintly
    // lit body.
    ctx.save();
    const dark = 1 + phase.revealT * 11;
    const sat = 90 - phase.revealT * 20;
    ctx.fillStyle = `hsl(${baseHue}, ${sat}%, ${dark}%)`;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Crust shedding — chunks of the dark exterior flake off and drift outward
    // during the dust-off, exposing the architecture beneath. Deterministic
    // per chunk so they stream consistently; driven by `dust`.
    if (phase.dust > 0.001) this.paintBossDustOff(ctx, r, phase.dust, phase.revealT, t);

    // Architecture: clipped to the disc, alpha climbing with revealT so the
    // body stays a clean black silhouette until the crust breaks away.
    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.clip();

      // Equatorial Bassteroid-style ring of plated panels — four hue bands
      // (red/amber/blue/violet) span the visible arc. Modeled as a wide
      // horizontal band across the body, clipped by the disc so the curved
      // limb cuts the bottom and top of the band.
      const bandHeight = r * 0.42;
      const bassHues = [0, 28, 192, 290];
      const panelCount = 14;
      for (let i = 0; i < panelCount; i++) {
        const u = i / panelCount;
        const x0 = -r * 1.2 + u * r * 2.4;
        const x1 = -r * 1.2 + (u + 1 / panelCount) * r * 2.4;
        const hueBand = bassHues[Math.floor(u * 4) % 4];
        const panel = ctx.createLinearGradient(0, -bandHeight, 0, bandHeight);
        const a = 0.55 * phase.revealT;
        panel.addColorStop(0, `hsla(${hueBand}, 60%, 18%, ${a * 0.7})`);
        panel.addColorStop(0.45, `hsla(${hueBand}, 75%, 30%, ${a})`);
        panel.addColorStop(0.55, `hsla(${hueBand}, 75%, 22%, ${a})`);
        panel.addColorStop(1, `hsla(${hueBand}, 60%, 10%, ${a * 0.7})`);
        ctx.fillStyle = panel;
        ctx.fillRect(x0, -bandHeight, x1 - x0, bandHeight * 2);
        // Plate seam
        ctx.strokeStyle = `hsla(${hueBand + 20}, 100%, 80%, ${0.55 * phase.revealT})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, -bandHeight);
        ctx.lineTo(x1, bandHeight);
        ctx.stroke();
      }

      // Polar caps (north + south) — darker hex-paneled lids stitched on
      // top of the ring. Just a darker fill with one bright rim arc on the
      // ring-facing edge.
      for (const sign of [-1, 1]) {
        ctx.fillStyle = `hsla(${baseHue}, 70%, 10%, ${0.7 * phase.revealT})`;
        ctx.beginPath();
        ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = `hsla(${baseHue + 10}, 100%, 55%, ${0.5 * phase.revealT})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
        ctx.stroke();
      }

      // Closed-eye seam: a thin horizontal canyon across the equator where
      // the lid will part. Just a faint dark line while shut; the actual
      // opening is drawn un-rotated below so the eye faces the camera.
      const seamGlow = 0.3 * phase.revealT * (1 - phase.lidOpen);
      ctx.strokeStyle = `hsla(${baseHue}, 100%, 30%, ${seamGlow})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-r * 0.75, 0);
      ctx.lineTo(r * 0.75, 0);
      ctx.stroke();

      ctx.restore();
    }

    // ---- Eye-opening: armored lids part to reveal the iris ----
    // Drawn un-rotated (the eye opens square to the camera). The two lids are
    // armored shutters covering the aperture; as lidOpen ramps they slide
    // apart vertically — upper lid retracts up, lower lid drops down —
    // uncovering a vesica-shaped gap that the brass aperture + iris fill.
    if (phase.lidOpen > 0.001) this.paintBossEyeOpening(ctx, r, phase.lidOpen, t);

    // Outline rim — fully absent during the quiet silhouette so the body has no
    // edge to give it away against the starfield, then sharpens in as the reveal
    // builds. This is what sells "thing in space" once the boss is waking.
    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${baseHue + 12}, 100%, 65%, ${0.8 * phase.revealT})`;
      ctx.lineWidth = 1.2 + 1.6 * phase.revealT;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // Crust shedding for the dust-off: dark exterior flakes break loose around
  // the limb and drift outward, plus a haze of fine dust motes — the rock
  // sloughing off its disguise to expose the boss. `dust` 0..1 sets emission;
  // `reveal` brightens the freshly-exposed under-edges. Deterministic per
  // chunk (seeded off the boss hue) so a chunk streams smoothly across frames.
  paintBossDustOff(ctx: CanvasRenderingContext2D, r: number, dust: number, reveal: number, t: number) {
    const baseHue = this.hue;
    ctx.save();
    // Flaking plates: 14 dark shards lifting off the limb, each easing outward
    // on its own phase. Drawn dark (they're crust) with a hot inner edge where
    // they tore free.
    const CHUNKS = 14;
    for (let i = 0; i < CHUNKS; i++) {
      const seed = Math.abs(Math.sin(baseHue * 7.3 + i * 53.7));
      const ang = (i / CHUNKS) * TAU + seed * 0.6;
      // Per-chunk drift phase loops so chunks keep peeling for the whole
      // dust-off rather than launching once.
      const ph = ((t * 0.0006 + seed) % 1);
      const lift = ph * (0.5 + 0.5 * dust);
      const cr = r * (0.07 + seed * 0.06);
      const cx = Math.cos(ang) * (r * 0.92 + r * 0.7 * lift);
      const cy = Math.sin(ang) * (r * 0.92 + r * 0.7 * lift);
      const alpha = dust * (1 - ph) * 0.85;
      if (alpha < 0.02) continue;
      ctx.fillStyle = `hsla(${baseHue}, 60%, 6%, ${alpha})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, cr, cr * 0.7, ang, 0, TAU);
      ctx.fill();
      // Hot torn edge facing the body.
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${baseHue + 25}, 100%, 60%, ${alpha * reveal})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, ang + Math.PI * 0.6, ang + Math.PI * 1.4);
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }
    // Fine dust haze drifting off — a scatter of tiny motes in a ring just
    // outside the limb, additive so they glint against the dark.
    ctx.globalCompositeOperation = "lighter";
    const MOTES = 40;
    for (let i = 0; i < MOTES; i++) {
      const s1 = Math.abs(Math.sin(baseHue * 3.1 + i * 12.9));
      const s2 = Math.abs(Math.sin(baseHue * 9.7 + i * 4.33));
      const ph = ((t * 0.0011 + s1) % 1);
      const ang = s1 * TAU;
      const rad = r * (0.95 + ph * 0.55);
      const mx = Math.cos(ang) * rad;
      const my = Math.sin(ang) * rad;
      const alpha = dust * (1 - ph) * 0.5 * s2;
      if (alpha < 0.02) continue;
      ctx.fillStyle = `hsla(${baseHue + 15}, 80%, 55%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(mx, my, 0.8 + s2 * 1.2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // The multi-part eye-open, drawn at the body centre in local space (caller
  // has already translated to pos). `open` is 0..1. Moving parts, in order of
  // appearance:
  //   1. a hot light-bleed glow grows out of the parting seam
  //   2. the iris + slit pupil are revealed through the parting gap — clipped
  //      to the opening, so a thin horizontal strip shows first and widens to
  //      the full disc
  //   3. two armored lids (upper + lower) slide apart, each trailing a hot
  //      inner edge where it tore away from the other
  paintBossEyeOpening(ctx: CanvasRenderingContext2D, bodyR: number, open: number, t: number) {
    const hue = this.hue;
    // The fully-open eye matches the live boss's eye radius, scaled by how
    // far the body has swelled so the reveal lands on the live size.
    const eyeR = this.bossEyeRadius * (bodyR / this.radius);
    // Vertical half-height of the open gap. Starts as a sliver, widens to the
    // full eye height. The horizontal extent (the canthi) is always the full
    // eye width so the gap reads as an eye, not a growing circle.
    const gapH = eyeR * (0.06 + 0.94 * open);
    const gapW = eyeR * (1.02 + 0.04 * open);

    ctx.save();

    // 1. Light bleeding through the seam — hottest right as it cracks, settles
    // as the eye fully opens and the iris (darker) takes over the centre.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const bleed = Math.sin(Math.min(1, open * 1.4) * Math.PI);
    const bleedR = eyeR * (0.9 + 0.7 * open);
    const bleedGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, bleedR);
    bleedGrad.addColorStop(0, `hsla(48, 100%, 95%, ${0.5 * bleed})`);
    bleedGrad.addColorStop(0.4, `hsla(${hue + 30}, 100%, 70%, ${0.35 * bleed})`);
    bleedGrad.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
    ctx.fillStyle = bleedGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, bleedR, bleedR * (0.4 + 0.6 * open), 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 2+3. The iris, revealed through the open gap. Clip to the vesica so the
    // eye appears progressively as the lids part — early on only a thin
    // horizontal strip of iris shows, widening to the full disc as it opens.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, gapW, gapH, 0, 0, TAU);
    ctx.clip();
    this.paintBossEyeAt(ctx, 0, 0, eyeR, hue, this.bossIrisAngle, 0, t, 0, 0);
    ctx.restore();

    // 4. The two armored lids. Each is the body-coloured armor that covered
    // the eye, now a shutter sliding away from the equator. We draw them as
    // filled half-bands whose inner edge is the parting line; the inner edge
    // carries a hot rim where it tore from its partner.
    const lidShift = gapH; // each lid's inner edge sits at the gap boundary
    for (const sign of [-1, 1]) {
      ctx.save();
      // Lid plate — a rounded armored cap covering from its inner edge out
      // past the eye. Body-dark with a beveled brass lip on the inner edge.
      const innerY = sign * lidShift;
      const outerY = sign * (eyeR * 1.35 + lidShift);
      const lidGrad = ctx.createLinearGradient(0, innerY, 0, outerY);
      lidGrad.addColorStop(0, `hsl(${hue + 6}, 70%, 12%)`);
      lidGrad.addColorStop(0.5, `hsl(${hue + 2}, 72%, 8%)`);
      lidGrad.addColorStop(1, `hsl(${hue - 6}, 78%, 4%)`);
      ctx.fillStyle = lidGrad;
      ctx.beginPath();
      // Inner edge is a shallow arc (the lid's curved rim) so the gap reads
      // as a lens; the rest is a wide rect out past the eye.
      ctx.ellipse(0, innerY, gapW, eyeR * 0.28, 0, 0, Math.PI, sign < 0);
      ctx.lineTo(eyeR * 1.6, outerY);
      ctx.lineTo(-eyeR * 1.6, outerY);
      ctx.closePath();
      ctx.fill();
      // Hot inner lip — the freshly-separated edge glows.
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(48, 100%, ${70 + 20 * open}%, ${0.5 + 0.4 * open})`;
      ctx.lineWidth = 1.4 + 2.2 * open;
      ctx.beginPath();
      ctx.ellipse(0, innerY, gapW, eyeR * 0.28, 0, 0, Math.PI, sign < 0);
      ctx.stroke();
      // A couple of plate rivets along the lid so it reads as armor.
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `hsla(48, 100%, 88%, 0.7)`;
      for (const rx of [-eyeR * 0.55, eyeR * 0.55]) {
        ctx.beginPath();
        ctx.arc(rx, innerY + sign * eyeR * 0.5, 1.6, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  // Render the live whole-body boss: layered orrery with a tracking eye.
  // The architecture stays static (cached painting overlaid live) and the
  // iris + telegraph + damage cracks are the only animated overlays.
  renderBossLive(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    // Slow corona breath. Stronger at high damage so the planet visibly
    // stresses as it takes hits.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.0018);
    const breathAlpha = 0.18 + 0.12 * breath + 0.35 * damageT;
    const breathR = r * (1.35 + 0.05 * breath + 0.15 * damageT);
    const grad = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, breathR);
    grad.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${breathAlpha * 0.4})`);
    grad.addColorStop(0.6, `hsla(${baseHue + 8}, 100%, 55%, ${breathAlpha})`);
    grad.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, breathR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Body — dark planetoid base with a directional gradient (sun up-left).
    ctx.save();
    const body = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    body.addColorStop(0, `hsl(${baseHue + 8}, 70%, 22%)`);
    body.addColorStop(0.45, `hsl(${baseHue + 4}, 75%, 14%)`);
    body.addColorStop(0.9, `hsl(${baseHue - 6}, 80%, 6%)`);
    body.addColorStop(1, `hsl(${baseHue - 10}, 80%, 3%)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Architecture (clipped to body). Equatorial plated ring + hex pole
    // caps + storm-band texture + rivet seams. Drawn each frame so the live
    // boss reads as fully alive — no static sprite.
    this.paintBossArchitecture(ctx, r, t);

    // Live damage cracks
    this.renderBossCracks(ctx, damageT);

    // Section flashes (beats 1 + 3). Top/bottom half blooms — drawn after
    // the architecture so the flash reads as the panels themselves lighting
    // up, not a separate overlay floating above the body.
    if (this.bossTopFlash > 0) this.paintBossHalfFlash(ctx, r, -1, this.bossTopFlash);
    if (this.bossBottomFlash > 0) this.paintBossHalfFlash(ctx, r, 1, this.bossBottomFlash);

    // Eye — sits at the body center, iris rotates to track player. Drawn
    // last (above architecture + cracks) so it always reads as the primary
    // focal point. Iris/pupil flashes + laser charge layer on top.
    this.paintBossEyeAt(ctx, 0, 0, this.bossEyeRadius, baseHue, this.bossIrisAngle, this.bossLaserCharge, t, this.bossIrisFlash, this.bossPupilFlash, this.bossLaserWindup);

    // Outline rim — glints with the same incommensurate-sines shimmer the
    // bassteroid rims use, so boss and rocks share one rhythm at the edge.
    {
      const shimmer =
        0.5 +
        0.5 * (0.6 * Math.sin(t * 0.0021) +
               0.4 * Math.sin(t * 0.0047 + this.pos.x * 0.03));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `hsla(${baseHue + 15}, 100%, 75%, ${0.7 + 0.25 * shimmer})`;
      ctx.lineWidth = 2.2 + 0.6 * shimmer;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 90%, ${this.flashAmount * 0.35})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // Laser charge sightline grows across beats 7→8 and snaps off at fire.
    if (this.bossLaserCharge > 0.05) this.paintBossLaserChargeBeam(ctx);
  }

  // Top/bottom hemisphere flash bloom — used by the live whole-body boss
  // for its beat-1 + beat-3 pulses. `side` = -1 paints the upper half,
  // +1 paints the lower half. The bloom reads as the panels of that half
  // catching a sudden internal light: a clipped overlay tinted with a
  // hot-white inner gradient + a soft rim flare.
  paintBossHalfFlash(ctx: CanvasRenderingContext2D, r: number, side: 1 | -1, amount: number) {
    if (amount <= 0) return;
    const baseHue = this.hue;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Clip to this half-circle so the bloom only fills the matching panels.
    ctx.beginPath();
    ctx.arc(0, 0, r, side < 0 ? Math.PI : 0, side < 0 ? Math.PI * 2 : Math.PI);
    ctx.closePath();
    ctx.clip();
    // Hot inner gradient toward the equator — feels like light pouring out
    // of the seam between top and bottom, not a flat colour wash.
    const grad = ctx.createLinearGradient(0, -side * r * 0.95, 0, side * r * 0.05);
    grad.addColorStop(0, `hsla(${baseHue + 25}, 100%, 65%, ${0.28 * amount})`);
    grad.addColorStop(0.55, `hsla(${baseHue + 35}, 100%, 78%, ${0.55 * amount})`);
    grad.addColorStop(1, `hsla(48, 100%, 96%, ${0.85 * amount})`);
    ctx.fillStyle = grad;
    ctx.fillRect(-r * 1.1, -r * 1.1, r * 2.2, r * 2.2);
    // Equator seam crack — a bright glowing line right along the cut where
    // the flash erupts. Sells the "the planet is breathing through the seam."
    ctx.strokeStyle = `hsla(48, 100%, 95%, ${0.85 * amount})`;
    ctx.lineWidth = 1.6 + 3.0 * amount;
    ctx.beginPath();
    ctx.moveTo(-r * 0.95, 0);
    ctx.lineTo(r * 0.95, 0);
    ctx.stroke();
    ctx.restore();
    // Outer rim halo on the lit half — drawn outside the clip so the
    // crescent of light spills slightly past the silhouette.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.18, side < 0 ? Math.PI : 0, side < 0 ? Math.PI * 2 : Math.PI);
    ctx.closePath();
    ctx.clip();
    const rim = ctx.createRadialGradient(0, 0, r * 0.95, 0, 0, r * 1.25);
    rim.addColorStop(0, `hsla(${baseHue + 30}, 100%, 75%, 0)`);
    rim.addColorStop(0.6, `hsla(${baseHue + 30}, 100%, 80%, ${0.45 * amount})`);
    rim.addColorStop(1, `hsla(${baseHue + 30}, 100%, 80%, 0)`);
    ctx.fillStyle = rim;
    ctx.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);
    ctx.restore();
  }

  // Targeting telegraph: a single crisp sightline down the locked aim, capped
  // by a lock-on reticle. The aim ticks toward the player once per windup beat
  // (see tickLaserAim), so the line visibly steps onto the player each beat
  // and then holds — the player reads exactly where the beam will fire. The
  // beam fires straight down this line, so the telegraph is an honest
  // predictor of the shot. World-space; drawn source-over as a HUD cue.
  paintBossLaserChargeBeam(ctx: CanvasRenderingContext2D) {
    const charge = this.bossLaserCharge;
    if (charge <= 0.02) return;
    const windup = this.bossLaserWindup;
    const a = this.eyeAimAngle();
    const startR = (this.kind === "bossEye" ? this.radius : this.bossEyeRadius) * 1.05;
    const aimDist = Math.hypot(this.bossEyeAimX - this.pos.x, this.bossEyeAimY - this.pos.y);
    // The line runs the full length the beam will reach so the threat covers
    // the same span as the shot, not just up to the player.
    const reach = Math.max(startR + 200, aimDist + 600);
    const alpha = 0.3 + 0.6 * charge;
    const sx = this.pos.x + Math.cos(a) * startR;
    const sy = this.pos.y + Math.sin(a) * startR;
    const ex = this.pos.x + Math.cos(a) * reach;
    const ey = this.pos.y + Math.sin(a) * reach;

    ctx.save();
    // Soft underlay along the line — widens with the charge, then surges hard
    // in the final 3 beats so the sightline visibly thickens into "about to
    // fire" as the wind-up completes, without yet becoming a live beam.
    ctx.strokeStyle = `hsla(${this.hue}, 100%, ${60 + 20 * windup}%, ${(0.12 * charge + 0.16 * windup).toFixed(3)})`;
    ctx.lineWidth = 4 + 6 * charge + 14 * windup;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Crisp dashed sightline — the readable aim. Steps onto the player on each
    // windup beat.
    ctx.strokeStyle = `hsla(${this.hue}, 100%, ${62 + 30 * charge}%, ${alpha})`;
    ctx.lineWidth = 1.4 + 1.2 * charge;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);

    // Lock-on reticle on the aim point: an outer ring that contracts as the
    // charge completes (acquiring → locked) plus a four-tick crosshair, so the
    // exact target reads unmistakably.
    const tx = this.pos.x + Math.cos(a) * Math.max(startR + 30, aimDist);
    const ty = this.pos.y + Math.sin(a) * Math.max(startR + 30, aimDist);
    // Contracts across the charge, then clamps tight for the wind-up so the
    // lock reads as fully acquired while the shot spools up.
    const ringR = 26 - 14 * charge - 6 * windup;
    ctx.lineWidth = 1.4 + 1.6 * windup;
    ctx.beginPath();
    ctx.arc(tx, ty, ringR, 0, TAU);
    ctx.stroke();
    const tickOut = ringR + 7;
    const tickIn = ringR + 2;
    for (let k = 0; k < 4; k++) {
      const ang = a + (k * TAU) / 4;
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(ang) * tickIn, ty + Math.sin(ang) * tickIn);
      ctx.lineTo(tx + Math.cos(ang) * tickOut, ty + Math.sin(ang) * tickOut);
      ctx.stroke();
    }
    // Wind-up: four converging chevrons closing onto the lock — a countdown
    // that visibly draws inward across the final 3 beats before the shot.
    if (windup > 0.02) {
      const converge = 44 * (1 - windup);
      ctx.strokeStyle = `hsla(${this.hue}, 100%, 80%, ${(0.7 * windup).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      for (let k = 0; k < 4; k++) {
        const ang = a + Math.PI / 4 + (k * TAU) / 4;
        const cd = ringR + 6 + converge;
        const cx = tx + Math.cos(ang) * cd;
        const cy = ty + Math.sin(ang) * cd;
        const wing = 5;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang + 2.4) * wing, cy + Math.sin(ang + 2.4) * wing);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang - 2.4) * wing, cy + Math.sin(ang - 2.4) * wing);
        ctx.stroke();
      }
      ctx.strokeStyle = `hsla(${this.hue}, 100%, ${62 + 30 * charge}%, ${alpha})`;
      ctx.lineWidth = 1.4 + 1.2 * charge;
    }
    ctx.fillStyle = `hsla(${this.hue}, 100%, ${60 + 35 * charge}%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(tx, ty, 1.5 + 1.5 * charge, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Surface architecture for the live boss. Pulled apart into named layers
  // so the texture reads as a constructed body — not a beach ball with
  // stripes. Layer order, top to bottom on screen:
  //   1. storm-band turbulence rendered across the equator (multiple thin
  //      arc bands + scatter of pock craters; deterministic from the boss's
  //      hue+angle seed so it's stable across frames)
  //   2. equatorial Bassteroid plated ring — same 4-hue bands but with
  //      proper bevel highlights + rivet pins along each plate seam
  //   3. polar hex panel caps — actual hex grid pattern, not just stripes
  //   4. meridian fracture seams running pole-to-pole (3 of them)
  //   5. the broken lid scar where the eye opened
  paintBossArchitecture(ctx: CanvasRenderingContext2D, r: number, t: number) {
    const baseHue = this.hue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.clip();

    // ---- 1. Storm-band turbulence ----
    // Three soft horizontal arcs swept across the body — suggestive of an
    // atmosphere or molten band layered under the plating. Drawn first so
    // the plate ring covers most of it; the band peeks out top and bottom
    // of the ring like weather curling out of an exhaust grille.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let k = 0; k < 3; k++) {
      const yC = (k - 1) * r * 0.55;
      const bandH = r * (0.18 + 0.06 * k);
      const seed = Math.abs(Math.sin(baseHue * 0.317 + k * 9.111));
      const grad = ctx.createLinearGradient(0, yC - bandH, 0, yC + bandH);
      grad.addColorStop(0, `hsla(${baseHue + 6 + 8 * seed}, 90%, 24%, 0)`);
      grad.addColorStop(0.5, `hsla(${baseHue + 6 + 8 * seed}, 90%, 30%, 0.32)`);
      grad.addColorStop(1, `hsla(${baseHue + 6 + 8 * seed}, 90%, 24%, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(-r * 1.2, yC - bandH, r * 2.4, bandH * 2);
    }
    ctx.restore();
    // Scatter pock craters across the body — deterministic from the boss
    // seed. Each crater is a soft dark disc + bright crescent rim, so the
    // surface reads as cratered rock under the architecture.
    {
      const craterCount = 22;
      for (let i = 0; i < craterCount; i++) {
        const s1 = Math.abs(Math.sin(baseHue * 12.9 + i * 78.2));
        const s2 = Math.abs(Math.sin(baseHue * 39.3 + i * 17.7));
        const s3 = Math.abs(Math.sin(baseHue * 4.41 + i * 91.0));
        const ang = s1 * TAU;
        const rad = r * (0.05 + s2 * 0.92);
        const cx = Math.cos(ang) * rad;
        const cy = Math.sin(ang) * rad;
        const cr = r * (0.025 + s3 * 0.055);
        const inBand = Math.abs(cy) < r * 0.32;
        if (inBand) continue;
        ctx.fillStyle = `hsla(${baseHue - 10}, 80%, 5%, 0.65)`;
        ctx.beginPath();
        ctx.arc(cx, cy, cr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = `hsla(${baseHue + 20}, 80%, 40%, 0.45)`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(cx - cr * 0.25, cy - cr * 0.25, cr * 0.85, Math.PI * 0.6, Math.PI * 1.7);
        ctx.stroke();
      }
    }

    // ---- 2. Equatorial Bassteroid plate ring ----
    // Four-hue band wrapping the body. Each panel gets a top-edge highlight
    // and a bottom-edge shadow (bevel), an interior brace line, and rivet
    // pins at the corners along the seams. The result reads as plated armor,
    // not a stripe.
    const bandHeight = r * 0.42;
    const bassHues = [0, 28, 192, 290];
    const panelCount = 14;
    // Per-quadrant beat pulse: the red/orange/blue/purple quadrants light in
    // sequence (kick→pluck→boom→snap), borrowing the bassteroids' rhythm. Four
    // free-running phases a quarter-measure apart over a 2s measure; each is a
    // sharp attack + decay so the quadrant flares as its voice would fire. (A
    // free-running phase from t, not the live bass clock — render() isn't given
    // the clock; this reads near-identically and keeps the signature unchanged.)
    const MEASURE_MS = 2000;
    const quadPulse = (q: number) => {
      const ph = (((t - q * (MEASURE_MS / 4)) % MEASURE_MS) + MEASURE_MS) % MEASURE_MS / MEASURE_MS;
      // ph 0 = the quadrant's downbeat: snap to 1 then ease back down.
      return Math.pow(1 - ph, 3);
    };
    for (let i = 0; i < panelCount; i++) {
      const u = i / panelCount;
      const x0 = -r * 1.2 + u * r * 2.4;
      const x1 = -r * 1.2 + (u + 1 / panelCount) * r * 2.4;
      const quad = Math.floor(u * 4) % 4;
      const hueBand = bassHues[quad];
      const panel = ctx.createLinearGradient(0, -bandHeight, 0, bandHeight);
      panel.addColorStop(0, `hsla(${hueBand}, 60%, 18%, 0.65)`);
      panel.addColorStop(0.45, `hsla(${hueBand}, 75%, 32%, 0.92)`);
      panel.addColorStop(0.55, `hsla(${hueBand}, 75%, 22%, 0.92)`);
      panel.addColorStop(1, `hsla(${hueBand}, 60%, 10%, 0.65)`);
      ctx.fillStyle = panel;
      ctx.fillRect(x0, -bandHeight, x1 - x0, bandHeight * 2);
      // Top bevel — bright thin strip across the panel top edge.
      ctx.fillStyle = `hsla(${hueBand + 20}, 100%, 80%, 0.55)`;
      ctx.fillRect(x0 + 1, -bandHeight, x1 - x0 - 2, 1.8);
      // Bottom shadow — dark thin strip at the bottom for depth.
      ctx.fillStyle = `hsla(${hueBand - 10}, 70%, 5%, 0.55)`;
      ctx.fillRect(x0 + 1, bandHeight - 1.8, x1 - x0 - 2, 1.8);
      // Plate seam (vertical line at panel boundary).
      ctx.strokeStyle = `hsla(${hueBand + 25}, 100%, 82%, 0.65)`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x1, -bandHeight);
      ctx.lineTo(x1, bandHeight);
      ctx.stroke();
      // Rivet pins at the seam (top + bottom of each plate boundary).
      ctx.fillStyle = `hsla(48, 100%, 92%, 0.85)`;
      ctx.beginPath();
      ctx.arc(x1, -bandHeight + 3.5, 1.4, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x1, bandHeight - 3.5, 1.4, 0, TAU);
      ctx.fill();
      // Interior brace — a thin horizontal accent in the panel mid-band.
      // Offset every other panel so the ring doesn't look like a stencil.
      const braceY = (i % 2 === 0 ? -1 : 1) * bandHeight * 0.32;
      ctx.strokeStyle = `hsla(${hueBand + 30}, 90%, 70%, 0.35)`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * 0.18, braceY);
      ctx.lineTo(x0 + (x1 - x0) * 0.82, braceY);
      ctx.stroke();
      // Beat pulse — this quadrant's voice firing lights the whole plate
      // additively. Flat rect, no gradient; the brightest beat for the brightest
      // plate, sweeping around the ring in voice order.
      const pulse = quadPulse(quad);
      if (pulse > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `hsla(${hueBand + 18}, 100%, 70%, ${0.32 * pulse})`;
        ctx.fillRect(x0 + 1, -bandHeight, x1 - x0 - 2, bandHeight * 2);
        ctx.restore();
      }
    }

    // ---- 3. Polar caps with proper hex grid ----
    for (const sign of [-1, 1]) {
      // Dark fill — chunkier than before, with a stronger gradient so the
      // cap reads as curving away from the eye instead of being flat.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
      ctx.clip();
      const capGrad = ctx.createLinearGradient(0, sign * r * 0.1, 0, sign * r * 1.05);
      capGrad.addColorStop(0, `hsla(${baseHue}, 75%, 14%, 0.85)`);
      capGrad.addColorStop(1, `hsla(${baseHue - 10}, 90%, 3%, 0.95)`);
      ctx.fillStyle = capGrad;
      ctx.fillRect(-r * 1.2, sign > 0 ? 0 : -r * 1.1, r * 2.4, r * 1.1);
      // Hex grid — small honeycomb of darker outlines. Two staggered rows of
      // hexes per band; rows are clipped to the cap ellipse.
      const hexR = r * 0.075;
      const hexW = hexR * Math.sqrt(3);
      const hexH = hexR * 1.5;
      ctx.strokeStyle = `hsla(${baseHue + 10}, 65%, 22%, 0.75)`;
      ctx.lineWidth = 0.7;
      const rows = 6;
      for (let row = 0; row < rows; row++) {
        const ry = sign * (r * 0.18 + row * hexH);
        const xOff = (row % 2) * hexW * 0.5;
        const cols = 10;
        for (let col = -cols; col <= cols; col++) {
          const cx = col * hexW + xOff;
          ctx.beginPath();
          for (let v = 0; v < 6; v++) {
            const ang = (v / 6) * TAU + Math.PI / 6;
            const px = cx + Math.cos(ang) * hexR;
            const py = ry + Math.sin(ang) * hexR;
            if (v === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.restore();
      // Cap inner rim — bright crisp line where the cap meets the equator.
      ctx.strokeStyle = `hsla(${baseHue + 10}, 100%, 60%, 0.65)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, sign * r * 0.55, r * 1.1, r * 0.5, 0, 0, TAU);
      ctx.stroke();
      // Cap rivets — three pinprick highlights along the rim edge.
      ctx.fillStyle = `hsla(48, 100%, 95%, 0.85)`;
      for (const xR of [-r * 0.7, 0, r * 0.7]) {
        const yR = sign * (r * 0.55 - r * 0.46);
        ctx.beginPath();
        ctx.arc(xR, yR, 1.4, 0, TAU);
        ctx.fill();
      }
    }

    // ---- 4. Meridian fractures ----
    // Three thin curved scars running pole-to-pole, dark with a faint hot
    // inner glow. They sell the boss as a tectonic body that's been holding
    // together under stress, not a smooth ball.
    for (const mx of [-r * 0.62, -r * 0.05, r * 0.55]) {
      ctx.strokeStyle = `hsla(${baseHue - 6}, 80%, 4%, 0.85)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(mx, -r * 0.95);
      ctx.bezierCurveTo(mx + r * 0.05, -r * 0.4, mx - r * 0.04, r * 0.4, mx + r * 0.02, r * 0.95);
      ctx.stroke();
      // Hot inner glint — only faint, suggests pressure inside.
      ctx.strokeStyle = `hsla(${baseHue + 25}, 90%, 55%, 0.18)`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(mx, -r * 0.95);
      ctx.bezierCurveTo(mx + r * 0.05, -r * 0.4, mx - r * 0.04, r * 0.4, mx + r * 0.02, r * 0.95);
      ctx.stroke();
    }

    // ---- 5. Broken-lid scar at the equator centre ----
    ctx.strokeStyle = `hsla(${baseHue}, 90%, 28%, 0.6)`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, 0);
    ctx.lineTo(-r * 0.32, 0);
    ctx.moveTo(r * 0.32, 0);
    ctx.lineTo(r * 0.85, 0);
    ctx.stroke();
    // Hot glint along the scar — the lid is broken; light leaks out faintly.
    ctx.strokeStyle = `hsla(${baseHue + 30}, 100%, 70%, 0.35)`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, 0);
    ctx.lineTo(-r * 0.32, 0);
    ctx.moveTo(r * 0.32, 0);
    ctx.lineTo(r * 0.85, 0);
    ctx.stroke();

    ctx.restore();
    void t;
  }

  // Iris + pupil + brass aperture rim. Shared by the whole-body boss
  // (drawn at the planet center) and the detached eye-core. `irisAngle`
  // is the world-space pupil aim. `chargeT` 0..1 is the beat-7→beat-8
  // laser charge ramp (paints a hot inner core glow). `irisFlashAmp` is
  // the beat-5 brass-ring pulse amplitude; `pupilFlashAmp` is the beat-7
  // /beat-8 pupil double-pulse amplitude.
  paintBossEyeAt(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    eyeR: number,
    hue: number,
    irisAngle: number,
    chargeT: number,
    t: number,
    irisFlashAmp: number = 0,
    pupilFlashAmp: number = 0,
    windupT: number = 0,
  ) {
    ctx.save();
    ctx.translate(x, y);
    // Pre-fire wind-up: a fast shudder that jitters the whole eye harder as the
    // shot nears, so the barrel visibly rattles under the load before it fires.
    if (windupT > 0.01) {
      const shudder = eyeR * 0.05 * windupT * windupT;
      const jx = Math.sin(t * 0.09) * shudder;
      const jy = Math.cos(t * 0.113) * shudder;
      ctx.translate(jx, jy);
    }

    // Brass aperture rim — a wide ring framing the iris. Brass = warm
    // ochre, distinct from the body's red so the eye reads as a fitted
    // device rather than a wound. On beat 5 the rim blooms.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const rimBoost = 1 + irisFlashAmp * 0.9;
    const rimR = eyeR * (1.12 + 0.18 * irisFlashAmp);
    const rim = ctx.createRadialGradient(0, 0, eyeR * 0.85, 0, 0, rimR);
    rim.addColorStop(0, `hsla(38, 80%, 55%, 0)`);
    rim.addColorStop(0.45, `hsla(38, 95%, ${60 + 25 * irisFlashAmp}%, ${0.55 * rimBoost})`);
    rim.addColorStop(1, `hsla(28, 90%, 45%, 0)`);
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(0, 0, rimR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Iris — dark crimson disc. Subtle radial gradient gives it depth.
    const irisFill = ctx.createRadialGradient(0, 0, 0, 0, 0, eyeR);
    irisFill.addColorStop(0, `hsl(${hue + 8}, 90%, 22%)`);
    irisFill.addColorStop(0.55, `hsl(${hue - 4}, 85%, 11%)`);
    irisFill.addColorStop(1, `hsl(${hue - 10}, 90%, 4%)`);
    ctx.fillStyle = irisFill;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR, 0, TAU);
    ctx.fill();

    // Brass rim outline — thin precise ring. Brightens with the beat-5 pulse.
    ctx.strokeStyle = `hsla(38, 95%, ${65 + 30 * irisFlashAmp}%, ${0.85 + 0.15 * irisFlashAmp})`;
    ctx.lineWidth = 1.8 + 2.4 * irisFlashAmp;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR, 0, TAU);
    ctx.stroke();

    // Inner sclera ring — concentric darker line. Lifted to brass-bright
    // during the iris flash so the ring reads as the whole aperture firing.
    ctx.strokeStyle = irisFlashAmp > 0.1
      ? `hsla(48, 100%, ${70 + 20 * irisFlashAmp}%, ${0.6 + 0.4 * irisFlashAmp})`
      : `hsla(${hue}, 80%, 18%, 0.85)`;
    ctx.lineWidth = 0.9 + 1.8 * irisFlashAmp;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR * 0.78, 0, TAU);
    ctx.stroke();

    // Pupil — vertical slit aligned to irisAngle. Drawn as a tall, narrow
    // black ellipse; rotation by irisAngle aims it at the player. A slow
    // dilate breath modulates the slit width; the pupil flash dilates the
    // slit and lights the inner core white-hot.
    ctx.save();
    ctx.rotate(irisAngle);
    const dilate = 1 + 0.1 * Math.sin(t * 0.003) + 0.6 * pupilFlashAmp;
    const slitW = eyeR * 0.16 * dilate;
    const slitH = eyeR * 0.7;
    ctx.fillStyle = `hsla(0, 0%, 0%, ${0.95 - 0.4 * pupilFlashAmp})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, slitW, slitH, 0, 0, TAU);
    ctx.fill();
    // Laser charge core. Ramps from a faint glow on beat 7 to a brilliant
    // white-hot ball on beat 8. Independent of pupilFlashAmp so the charge
    // is visible across the entire beat-7→beat-8 window, not just on the
    // beat hits themselves.
    if (chargeT > 0.02 || pupilFlashAmp > 0.05 || windupT > 0.02) {
      // Wind-up drives the core the rest of the way past the charge plateau, so
      // the eye visibly spools brighter and larger across the final 3 beats.
      const amp = Math.max(chargeT, pupilFlashAmp, chargeT + windupT * 0.55);
      ctx.globalCompositeOperation = "lighter";
      const coreR = slitW * (0.8 + 2.4 * amp) * (1 + 0.5 * windupT);
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      core.addColorStop(0, `hsla(48, 100%, 98%, ${0.95 * amp})`);
      core.addColorStop(0.45, `hsla(${hue + 35}, 100%, 75%, ${0.7 * amp})`);
      core.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, TAU);
      ctx.fill();
      // Two stretched lensflare spikes along the slit axis on peak charge —
      // sells "barrel about to fire" instead of just "warm pupil".
      if (amp > 0.4) {
        ctx.strokeStyle = `hsla(48, 100%, 98%, ${(amp - 0.4) * 1.4})`;
        ctx.lineWidth = slitW * 0.4;
        ctx.lineCap = "round";
        const spike = eyeR * (0.55 + 0.7 * amp);
        ctx.beginPath();
        ctx.moveTo(0, -spike);
        ctx.lineTo(0, spike);
        ctx.stroke();
      }
      // Spooling energy ring that contracts inward as the wind-up completes —
      // a shrinking aperture drawing the charge into the barrel before the shot.
      if (windupT > 0.02) {
        const ringR = eyeR * (0.9 - 0.55 * windupT);
        ctx.strokeStyle = `hsla(48, 100%, 95%, ${0.5 * windupT})`;
        ctx.lineWidth = 1 + 2 * windupT;
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Pupil flash bloom — radiates OUT from the iris on the pupil double-
    // pulse. Wide soft halo so the entire eye visibly throbs.
    if (pupilFlashAmp > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const haloR = eyeR * (1.6 + 0.6 * pupilFlashAmp);
      const halo = ctx.createRadialGradient(0, 0, eyeR * 0.2, 0, 0, haloR);
      halo.addColorStop(0, `hsla(48, 100%, 96%, ${0.55 * pupilFlashAmp})`);
      halo.addColorStop(0.55, `hsla(${hue + 30}, 100%, 70%, ${0.4 * pupilFlashAmp})`);
      halo.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, haloR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Highlight glint — small bright spot on the upper-left of the iris,
    // sells "wet" reflective optic rather than dull cratered rock.
    ctx.fillStyle = `hsla(48, 100%, 92%, 0.7)`;
    ctx.beginPath();
    ctx.arc(-eyeR * 0.35, -eyeR * 0.35, eyeR * 0.08, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  // (Old dt-based sightline removed — replaced by paintBossLaserChargeBeam
  // which is driven by bossLaserCharge from the 8-beat rhythm.)

  // Hemisphere fragment: a half-disc with the freshly-revealed inner
  // cross-section facing the cut axis. The straight edge (the diameter) is
  // the unarmoured molten interior — strata, hot core, spilling furnace
  // light — while the curved limb wears its share of the equatorial
  // Bassteroid ring under a heavy plated rim. The visual armour split
  // matches the mechanical one in damageReductionAt.
  renderBossHemisphere(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // The hemisphere is the half-disc on the side opposite the cut axis.
    // In its own local frame we draw the half on +x side (so the cut
    // diameter is the y-axis), then the outer rotation places it correctly.
    // Apply the fragment angle so the cut faces the recorded direction.
    ctx.rotate(this.bossFragmentAngle);

    // Wide outer corona — same hue family as the whole boss
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.002);
    const coronaA = 0.14 + 0.08 * breath + 0.3 * damageT;
    const coronaR = r * (1.35 + 0.18 * damageT);
    const corona = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, coronaR);
    corona.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${coronaA * 0.5})`);
    corona.addColorStop(0.6, `hsla(${baseHue + 8}, 100%, 50%, ${coronaA})`);
    corona.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(0, 0, coronaR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // The half-disc body itself (curved side on +x). Clip a circular path
    // to the +x half-plane so the renderer can paint architecture inside.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(0, -r);
    ctx.closePath();
    ctx.clip();

    // Body fill — dark planetoid base
    const body = ctx.createRadialGradient(r * 0.4, -r * 0.3, r * 0.1, 0, 0, r);
    body.addColorStop(0, `hsl(${baseHue + 8}, 70%, 22%)`);
    body.addColorStop(0.5, `hsl(${baseHue}, 75%, 12%)`);
    body.addColorStop(1, `hsl(${baseHue - 8}, 80%, 4%)`);
    ctx.fillStyle = body;
    ctx.fillRect(0, -r, r, r * 2);

    // Equatorial ring slice — this hemisphere wore half the boss's ring.
    // Draw it as a horizontal band on the +x side; the diameter edge cuts
    // the band so its left edge is the broken cross-section.
    const bandHeight = r * 0.36;
    const bassHues = [0, 28, 192, 290];
    for (let i = 0; i < 7; i++) {
      const u = i / 7;
      const x0 = u * r * 1.05;
      const x1 = (u + 1 / 7) * r * 1.05;
      const hueBand = bassHues[Math.floor(u * 4) % 4];
      const panel = ctx.createLinearGradient(0, -bandHeight, 0, bandHeight);
      panel.addColorStop(0, `hsla(${hueBand}, 60%, 18%, 0.5)`);
      panel.addColorStop(0.5, `hsla(${hueBand}, 75%, 28%, 0.8)`);
      panel.addColorStop(1, `hsla(${hueBand}, 60%, 10%, 0.5)`);
      ctx.fillStyle = panel;
      ctx.fillRect(x0, -bandHeight, x1 - x0, bandHeight * 2);
      ctx.strokeStyle = `hsla(${hueBand + 20}, 100%, 80%, 0.5)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x1, -bandHeight);
      ctx.lineTo(x1, bandHeight);
      ctx.stroke();
    }

    ctx.restore();

    // The cut cross-section — the flat diameter face of the broken planet.
    // This is the unarmoured side (see damageReductionAt), so it has to read
    // as soft exposed viscera against the plated shell: furnace light spills
    // off the open face, molten mantle strata layer into the body, a
    // white-hot core sits at the centre, and heat veins crawl into the rock.
    // The whole face breathes, flares when this half fires its plasma, and
    // burns angrier as the hemisphere takes damage.
    const facePulse = 0.5 + 0.5 * Math.sin(t * 0.004 + this.membranePhase);
    const fireFlare = Math.max(this.bossTopFlash, this.bossBottomFlash);
    const heat = Math.min(1, 0.55 + 0.25 * facePulse + 0.6 * fireFlare + 0.3 * damageT);

    // Furnace light escaping the wound — additive half-glow on the bare side
    // only, so the open face casts light where the shell casts none.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const spillR = r * (0.5 + 0.14 * facePulse + 0.3 * fireFlare);
    const spill = ctx.createRadialGradient(0, 0, r * 0.04, 0, 0, spillR);
    spill.addColorStop(0, `hsla(${baseHue + 22}, 100%, 62%, ${0.5 * heat})`);
    spill.addColorStop(0.5, `hsla(${baseHue + 10}, 100%, 52%, ${0.25 * heat})`);
    spill.addColorStop(1, `hsla(${baseHue}, 100%, 45%, 0)`);
    ctx.fillStyle = spill;
    ctx.beginPath();
    ctx.arc(0, 0, spillR, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Exposed interior, clipped to the body so the strata stop at the shell.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(0, -r);
    ctx.closePath();
    ctx.clip();

    // Mantle strata: nested half-ellipses reaching into the body, each layer
    // hotter and brighter than the one wrapping it — the sliced planet's
    // insides laid bare. Each stratum fades with depth so the face stays the
    // hottest edge.
    const strata = [
      { depth: 0.44, span: 0.97, hueOff: 0, light: 26 },
      { depth: 0.3, span: 0.78, hueOff: 10, light: 40 },
      { depth: 0.18, span: 0.55, hueOff: 20, light: 54 },
    ];
    for (const s of strata) {
      const molten = ctx.createLinearGradient(0, 0, r * s.depth, 0);
      molten.addColorStop(0, `hsla(${baseHue + s.hueOff + 8}, 100%, ${s.light + 10}%, ${0.95 * heat})`);
      molten.addColorStop(1, `hsla(${baseHue + s.hueOff - 4}, 95%, ${s.light - 8}%, ${0.8 * heat})`);
      ctx.fillStyle = molten;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * s.depth, r * s.span, 0, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fill();
      // Hairline seam where this stratum meets the cooler one around it.
      ctx.strokeStyle = `hsla(${baseHue + s.hueOff + 24}, 100%, 72%, ${0.35 * heat})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * s.depth, r * s.span, 0, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = "lighter";

    // White-hot core — the softest spot, breathing at the heart of the face.
    const coreR = r * (0.16 + 0.05 * facePulse + 0.12 * fireFlare);
    const core = ctx.createRadialGradient(r * 0.05, 0, coreR * 0.1, r * 0.06, 0, coreR);
    core.addColorStop(0, `hsla(${baseHue + 38}, 100%, 95%, ${heat})`);
    core.addColorStop(0.5, `hsla(${baseHue + 24}, 100%, 68%, ${0.75 * heat})`);
    core.addColorStop(1, `hsla(${baseHue + 10}, 100%, 50%, 0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(r * 0.05, 0, coreR, 0, TAU);
    ctx.fill();

    // Heat veins crawling off the face into the rock — brightest at the cut,
    // dying out where the armoured depth begins. Deterministic zig-zags (pure
    // functions of the vein index) so the render draws nothing from the rng.
    for (let v = 0; v < 5; v++) {
      const vy = (v / 4 - 0.5) * 2 * r * 0.7;
      const reach = r * (0.34 + 0.22 * Math.abs(Math.sin(v * 2.4 + 1.7)));
      const shimmer = (0.4 + 0.35 * Math.sin(t * 0.005 + v * 1.9)) * heat;
      const vein = ctx.createLinearGradient(0, vy, reach, vy);
      vein.addColorStop(0, `hsla(${baseHue + 26}, 100%, 70%, ${shimmer})`);
      vein.addColorStop(1, `hsla(${baseHue + 8}, 100%, 50%, 0)`);
      ctx.strokeStyle = vein;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(r * 0.02, vy);
      for (let k = 1; k <= 3; k++) {
        ctx.lineTo((k / 3) * reach, vy + r * 0.05 * Math.sin(v * 3.1 + k * 2.3));
      }
      ctx.stroke();
    }
    ctx.restore();

    // Molten seam at the cut itself: a soft hot flank under a thin white-hot
    // line — the glowing lip of the wound.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${baseHue + 18}, 100%, 60%, ${0.5 * heat})`;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(0, r);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${baseHue + 32}, 100%, 92%, ${0.6 + 0.4 * heat})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(0, r);
    ctx.stroke();
    ctx.restore();

    // Armoured limb rim — dark occlusion stroke under a bright catch, so the
    // curved shell reads as heavy plating against the soft open face.
    ctx.save();
    ctx.strokeStyle = `hsla(${baseHue}, 45%, 7%, 0.9)`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${baseHue + 15}, 100%, 75%, 0.85)`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.restore();

    // Damage cracks (clipped to the half-disc)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(0, -r);
    ctx.closePath();
    ctx.clip();
    this.renderBossCracks(ctx, damageT);
    ctx.restore();

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 90%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(0, -r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  // Eye-core fragment: a free-floating iris that keeps firing on its 4s
  // cadence. Renders very similarly to the whole-body eye but as its own
  // standalone entity (smaller, more agile target).
  renderBossEye(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    // Corona — slightly more agitated than the whole-body boss; this thing
    // is detached and angry. Pulses harder with damage.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.003);
    const coronaA = 0.22 + 0.16 * breath + 0.4 * damageT;
    const coronaR = r * (1.6 + 0.25 * damageT);
    const corona = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, coronaR);
    corona.addColorStop(0, `hsla(${baseHue}, 100%, 50%, ${coronaA * 0.6})`);
    corona.addColorStop(0.55, `hsla(${baseHue + 12}, 100%, 55%, ${coronaA})`);
    corona.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(0, 0, coronaR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Iris/pupil — full eye-core uses the same painter, with the eye
    // occupying its entire body. Beat-5 iris + beat-7/8 pupil flashes are
    // forwarded so the detached eye-core keeps its rhythm post-break.
    this.paintBossEyeAt(ctx, 0, 0, r, baseHue, this.bossIrisAngle, this.bossLaserCharge, t, this.bossIrisFlash, this.bossPupilFlash, this.bossLaserWindup);

    // Damage cracks
    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 92%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.1, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    if (this.bossLaserCharge > 0.05) this.paintBossLaserChargeBeam(ctx);
  }

  // Plate fragment: a single Bassteroid-style modular shard, painted in
  // one of the four ring hues. Tumbles freely. Reads as a literal piece of
  // the equatorial band that just flew off.
  // Trapezoidal plate silhouette with bevelled corners, in radius units so a
  // beat bloom can re-trace it at a larger scale. Caller has already
  // translated/rotated into the plate's local frame.
  private traceBossPlatePath(ctx: CanvasRenderingContext2D, scale: number) {
    const r = this.radius * scale;
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, -r * 0.45);
    ctx.lineTo(r * 0.65, -r * 0.7);
    ctx.lineTo(r * 0.95, -r * 0.1);
    ctx.lineTo(r * 0.75, r * 0.55);
    ctx.lineTo(-r * 0.55, r * 0.75);
    ctx.lineTo(-r * 0.95, r * 0.1);
    ctx.closePath();
  }

  renderBossPlate(ctx: CanvasRenderingContext2D, t: number) {
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;
    const bassHues = [0, 28, 192, 290];
    const hue = bassHues[this.bossPlateBand];

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // On-beat bloom — scaled copies of the plate silhouette pulse outward like
    // a Bassteroid's, so the broken hull-plate rings on its measure slot
    // instead of sitting inert. Drawn before the body so the rim reads on top.
    if (this.beatFlash > 0) {
      const a = this.beatFlash;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${hue + 20}, 100%, 65%, ${0.2 * a})`;
      this.traceBossPlatePath(ctx, 1.7 + 0.6 * a);
      ctx.fill();
      ctx.strokeStyle = `hsla(${hue + 30}, 100%, 90%, ${0.9 * a})`;
      ctx.lineWidth = 2.0 + 2.4 * a;
      this.traceBossPlatePath(ctx, 1.2 + 0.18 * a);
      ctx.stroke();
      ctx.restore();
    }

    // Small hue-tinted halo
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.8);
    halo.addColorStop(0, `hsla(${hue}, 100%, 60%, 0.4)`);
    halo.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.8, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Plate silhouette — a chunky trapezoidal panel with bevelled corners.
    // Hand-built shape so it doesn't read as a generic rock.
    ctx.fillStyle = `hsl(${hue}, 60%, 14%)`;
    this.traceBossPlatePath(ctx, 1);
    ctx.fill();

    // Panel inner gradient — bright top edge, dark bottom (suggests light
    // reflecting off the plated surface)
    ctx.save();
    this.traceBossPlatePath(ctx, 1);
    ctx.clip();
    const sheen = ctx.createLinearGradient(0, -r, 0, r);
    sheen.addColorStop(0, `hsla(${hue + 10}, 90%, 50%, 0.55)`);
    sheen.addColorStop(0.5, `hsla(${hue}, 75%, 25%, 0.4)`);
    sheen.addColorStop(1, `hsla(${hue - 10}, 80%, 8%, 0.5)`);
    ctx.fillStyle = sheen;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    // Inner stripe — Bassteroid plate accent
    ctx.strokeStyle = `hsla(${hue + 30}, 100%, 80%, 0.55)`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, 0);
    ctx.lineTo(r * 0.5, 0);
    ctx.stroke();
    ctx.restore();

    // Panel outline — bright rim, whitens on the beat so the hit reads.
    const rimLight = 75 + 20 * this.beatFlash;
    ctx.strokeStyle = `hsla(${hue + 20}, 100%, ${rimLight}%, 0.9)`;
    ctx.lineWidth = 1.4 + 1.2 * this.beatFlash;
    this.traceBossPlatePath(ctx, 1);
    ctx.stroke();

    // One running light — pinprick glow at a corner
    ctx.fillStyle = `hsla(${hue + 40}, 100%, 95%, 1)`;
    ctx.beginPath();
    ctx.arc(r * 0.6, -r * 0.4, r * 0.08, 0, TAU);
    ctx.fill();

    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${hue + 30}, 100%, 92%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
    void t;
  }

  // Iris-shard fragment: a crescent sliver of the brass aperture rim with
  // a sliver of pupil. Reads as a slice of the dead eye.
  renderBossIrisShard(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;
    const side = this.bossFragmentAngle >= 0 ? 1 : -1;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // On-beat bloom — a scaled copy of the crescent flares outward on the
    // shard's measure slot, mirroring a Bassteroid's pulse so the dead eye's
    // sliver keeps ringing.
    if (this.beatFlash > 0) {
      const a = this.beatFlash;
      const bloomR = r * (1.5 + 0.5 * a);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${baseHue + 20}, 100%, 70%, ${0.18 * a})`;
      ctx.beginPath();
      ctx.arc(0, 0, bloomR, side * -Math.PI / 2, side * Math.PI / 2, side < 0);
      ctx.arc(0, 0, r * 0.55, side * Math.PI / 2, side * -Math.PI / 2, side > 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = `hsla(40, 100%, 88%, ${0.9 * a})`;
      ctx.lineWidth = 1.6 + 2.0 * a;
      ctx.beginPath();
      ctx.arc(0, 0, r * (1.18 + 0.1 * a), side * -Math.PI / 2, side * Math.PI / 2, side < 0);
      ctx.stroke();
      ctx.restore();
    }

    // Faint halo
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.6);
    halo.addColorStop(0, `hsla(${baseHue}, 100%, 55%, 0.4)`);
    halo.addColorStop(1, `hsla(${baseHue}, 100%, 55%, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.6, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Crescent shape — outer arc + inner arc on the same side.
    ctx.fillStyle = `hsl(${baseHue}, 80%, 10%)`;
    ctx.beginPath();
    ctx.arc(0, 0, r, side * -Math.PI / 2, side * Math.PI / 2, side < 0);
    ctx.arc(0, 0, r * 0.55, side * Math.PI / 2, side * -Math.PI / 2, side > 0);
    ctx.closePath();
    ctx.fill();

    // Brass rim on the outer arc — whitens on the beat.
    ctx.strokeStyle = `hsla(38, 90%, ${60 + 30 * this.beatFlash}%, 0.9)`;
    ctx.lineWidth = 1.8 + 1.2 * this.beatFlash;
    ctx.beginPath();
    ctx.arc(0, 0, r, side * -Math.PI / 2, side * Math.PI / 2, side < 0);
    ctx.stroke();
    // Dim inner edge
    ctx.strokeStyle = `hsla(${baseHue}, 80%, 30%, 0.7)`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, side * -Math.PI / 2, side * Math.PI / 2, side < 0);
    ctx.stroke();

    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(${baseHue + 30}, 100%, 92%, ${this.flashAmount * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
    void t;
  }

  // Inert pupil ember — a tiny black sphere with a final smouldering core.
  // Doesn't fire, doesn't telegraph. Pure remnant.
  renderBossEmber(ctx: CanvasRenderingContext2D, t: number) {
    const baseHue = this.hue;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const r = this.radius;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.rotation);

    // Tiny corona — the last warmth
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const flicker = 0.5 + 0.5 * Math.sin(t * 0.004);
    const coreA = 0.4 + 0.25 * flicker;
    const coreR = r * 1.8;
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, `hsla(48, 100%, 90%, ${coreA})`);
    core.addColorStop(0.35, `hsla(${baseHue + 30}, 100%, 60%, ${coreA * 0.7})`);
    core.addColorStop(1, `hsla(${baseHue}, 100%, 50%, 0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Black ember body
    ctx.fillStyle = `hsl(${baseHue}, 80%, 5%)`;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();

    // Hot pinprick at center
    ctx.fillStyle = `hsla(48, 100%, 95%, ${0.6 + 0.3 * flicker})`;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.22, 0, TAU);
    ctx.fill();

    this.renderBossCracks(ctx, damageT);

    if (this.flashAmount > 0) {
      ctx.fillStyle = `hsla(48, 100%, 90%, ${this.flashAmount * 0.5})`;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  // Boss-specific crack overlay. We draw a dramatic radial-fracture pattern
  // proportional to damage taken — at low damage just a few hairline
  // fractures, at high damage the body is criss-crossed with glowing
  // molten gashes. Different look from the bassteroid renderCracks because
  // the boss is a planetoid, not an armoured ship.
  renderBossCracks(ctx: CanvasRenderingContext2D, damageT: number) {
    if (damageT <= 0.01) return;
    const cracksToDraw = Math.min(Math.ceil(damageT * this.cracks.length * 1.4), this.cracks.length);
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, TAU);
    ctx.clip();
    const crackScale = 0.7;
    for (let i = 0; i < cracksToDraw; i++) {
      const crack = this.cracks[i];
      const dx = crack.pos.x * this.radius;
      const dy = crack.pos.y * this.radius;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(crack.angle);
      ctx.scale(crackScale, crackScale);

      // Faint white fracture line (the crack itself).
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = `rgba(245,245,250, ${0.35 + 0.2 * damageT})`;
      ctx.lineWidth = 1.4 + damageT * 1.0;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const branch of crack.branches) {
        ctx.beginPath();
        for (let p = 0; p < branch.points.length; p++) {
          const px = branch.points[p].x * this.radius;
          const py = branch.points[p].y * this.radius;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      // Subtle bright over-stroke — still scales with damage so the boss
      // visibly stresses, but desaturated to white rather than molten orange.
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(255,255,255, ${0.25 + 0.3 * damageT})`;
      ctx.lineWidth = 0.6 + damageT * 0.8;
      for (const branch of crack.branches) {
        ctx.beginPath();
        for (let p = 0; p < branch.points.length; p++) {
          const px = branch.points[p].x * this.radius;
          const py = branch.points[p].y * this.radius;
          if (p === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // The Sepulchre and its Pallbearers (level-20 boss). Everything here is
  // carved from the same violet cathedral stone the `bell` archetypes use, so
  // the tomb reads as the building all that Act II rubble fell off — the
  // masonry, recess, dead-glass and rose-window painters below are the very
  // ones a bell fragment wears.
  // ---------------------------------------------------------------------

  // A Pallbearer, baked: a funeral lantern cut from a block of the tomb's own
  // masonry. The round lamp face is deliberately radially symmetric — a bearer
  // is re-aimed every tick as the bier turns, and a face that reads the same at
  // every angle keeps the silhouette legible while it wheels. The yoke bar
  // across it runs along the ring's tangent, so the four of them read as
  // shoulders under one bier rather than four loose rocks.
  private paintPallbearerBody(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    const R = this.radius;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    this.traceOutline(ctx);
    ctx.clip();

    this.paintAsteroidStone(ctx, H, R);
    ctx.save();
    ctx.globalAlpha = 0.5;
    this.paintMasonryBand(ctx, H, R * 0.8, -R * 0.9, R * 0.9);
    ctx.restore();

    // The yoke: a dressed bar of stone laid across the block along the bier's
    // tangent, with a lit upper lip and a shadowed under-edge so it stands
    // proud of the courses behind it.
    const yokeHalf = R * 0.16;
    ctx.fillStyle = `hsla(${H}, 12%, 30%, 0.95)`;
    ctx.fillRect(-yokeHalf, -R, yokeHalf * 2, R * 2);
    ctx.strokeStyle = `hsla(${H + 8}, 16%, 68%, 0.55)`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-yokeHalf, -R);
    ctx.lineTo(-yokeHalf, R);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H}, 22%, 6%, 0.7)`;
    ctx.beginPath();
    ctx.moveTo(yokeHalf, -R);
    ctx.lineTo(yokeHalf, R);
    ctx.stroke();

    // The lamp face. Dead tracery over dead glass — the light in it is a live
    // overlay that only arrives on the bearer's beat (see renderPallbearerLive).
    this.paintRoseWindow(ctx, H, 0, 0, R * 0.42, 8);

    // Specular catch on the lit shoulder.
    const spec = ctx.createRadialGradient(-R * 0.45, -R * 0.5, 0, -R * 0.45, -R * 0.5, R * 0.5);
    spec.addColorStop(0, `hsla(${H + 12}, 20%, 88%, 0.3)`);
    spec.addColorStop(1, `hsla(${H}, 16%, 60%, 0)`);
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(-R * 0.45, -R * 0.5, R * 0.5, 0, TAU);
    ctx.fill();

    this.paintStoneRelight(ctx, H, R);
    ctx.restore();

    this.paintStoneRim(ctx, H);
    ctx.restore();
  }

  // A Pallbearer still riding the bier in. It reads exactly as the dormant tomb
  // does — a black cut-out with the faintest rim — because that is the game's
  // word for "scenery, not a target": both are intangible until the tomb wakes,
  // and a bearer painted as a lit rock would just eat the player's shots and
  // their combo.
  renderPallbearerDormant(ctx: CanvasRenderingContext2D) {
    const H = this.hue;
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.fillStyle = `hsl(${H}, 40%, 3%)`;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H + 10}, 50%, 40%, 0.3)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, this.radius, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // Live overlay for a Pallbearer, drawn in the body's own rotated frame over
  // the baked block. Two things animate: a cold ember that never quite goes out
  // (so a dark bearer still reads as lit from within) and the toll — the lamp
  // flaring and shedding a ring on the beat this bearer owns.
  renderPallbearerLive(ctx: CanvasRenderingContext2D, time: number) {
    const H = this.hue;
    const R = this.radius;
    // Everything here fades with the body: a bearer that has phased out is a
    // smear, and a bright lamp floating where the smear is would read as a
    // separate object rather than the same one going thin.
    if (this.bossPhase === "dormant") return;
    const presence = this.warbleOpacity;
    const toll = this.tollFlash * presence;
    const ember = (0.16 + 0.06 * Math.sin(time * 1.1 + this.membranePhase)) * presence;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    const lampR = R * 0.42;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, lampR * (1.6 + 0.9 * toll));
    glow.addColorStop(0, `hsla(${H + 20}, 100%, 92%, ${(ember + 0.75 * toll) * 0.9})`);
    glow.addColorStop(0.35, `hsla(${H + 6}, 100%, 68%, ${(ember + 0.6 * toll) * 0.5})`);
    glow.addColorStop(1, `hsla(${H}, 100%, 55%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, lampR * (1.6 + 0.9 * toll), 0, TAU);
    ctx.fill();

    // The knell made visible: the toll throws a ring off the lamp that widens
    // and thins as it goes, so the beat is readable from across the field even
    // when the bearer itself is small on screen.
    if (toll > 0.02) {
      const ringR = R * (0.6 + 1.5 * (1 - toll));
      ctx.strokeStyle = `hsla(${H + 14}, 100%, 82%, ${0.55 * toll})`;
      ctx.lineWidth = 1.2 + 3.2 * toll;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  // The dormant Sepulchre: the same long approach the planetoid makes, but the
  // thing that swells out of the background is a slab of architecture, not a
  // world. It stays a flat black cut-out until the active window, when it
  // shudders, sheds its shroud of dust and stands revealed as a building.
  renderSepulchreDormant(ctx: CanvasRenderingContext2D, t: number) {
    const H = this.hue;
    const phase = this.bossDormantPhase();
    const r = this.radius * (0.42 + 0.58 * phase.swellT);

    ctx.save();
    let shakeX = 0, shakeY = 0;
    if (phase.shudder > 0.001) {
      const amp = phase.shudder * 6;
      shakeX = Math.sin(t * 0.05) * amp * 0.5 + (cosmeticRng() - 0.5) * amp;
      shakeY = Math.cos(t * 0.061) * amp * 0.5 + (cosmeticRng() - 0.5) * amp;
    }
    ctx.translate(this.pos.x + shakeX, this.pos.y + shakeY);

    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const coronaA = 0.04 + 0.14 * phase.revealT;
      const coronaR = r * (1.22 + 0.16 * phase.revealT);
      const corona = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, coronaR);
      corona.addColorStop(0, `hsla(${H}, 80%, 45%, ${coronaA * 0.5})`);
      corona.addColorStop(0.55, `hsla(${H - 12}, 80%, 40%, ${coronaA * 0.25})`);
      corona.addColorStop(1, `hsla(${H}, 80%, 45%, 0)`);
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(0, 0, coronaR, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.fillStyle = `hsl(${H}, ${80 - phase.revealT * 30}%, ${1 + phase.revealT * 9}%)`;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (phase.dust > 0.001) this.paintBossDustOff(ctx, r, phase.dust, phase.revealT, t);

    if (phase.revealT > 0.001) {
      ctx.save();
      ctx.globalAlpha = phase.revealT;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.clip();
      this.paintSepulchreMasonry(ctx, r);
      this.paintStoneRelight(ctx, H, r);
      ctx.restore();
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${H + 10}, 70%, ${30 + 45 * phase.revealT}%, ${0.35 + 0.4 * phase.revealT})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  // The live Sepulchre. The body is a wall, not a planet: courses of dressed
  // masonry, buttress ribs standing off it, and a great rose window for a face,
  // shuttered by two stone leaves. While the bier holds, the shutter is closed
  // and the tomb is inert scenery you cannot hurt; as the bearers fall the
  // leaves grind apart and the reliquary behind them starts to show.
  renderSepulchreLive(ctx: CanvasRenderingContext2D, t: number) {
    const H = this.hue;
    const r = this.radius;
    const damageT = 1 - this.hp / Math.max(1, this.maxHp);
    const open = this.shutterOpen;
    const time = t * 0.001;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);

    // Slow corona breath, widening as the tomb opens and as it takes damage.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const breath = 0.5 + 0.5 * Math.sin(t * 0.0014);
    const breathAlpha = 0.06 + 0.05 * breath + 0.2 * open + 0.16 * damageT;
    const breathR = r * (1.18 + 0.04 * breath + 0.1 * open);
    const corona = ctx.createRadialGradient(0, 0, r * 0.75, 0, 0, breathR);
    corona.addColorStop(0, `hsla(${H}, 90%, 50%, ${breathAlpha * 0.4})`);
    corona.addColorStop(0.6, `hsla(${H + 10}, 90%, 55%, ${breathAlpha})`);
    corona.addColorStop(1, `hsla(${H}, 90%, 50%, 0)`);
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(0, 0, breathR, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.rotate(this.rotation);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.clip();
    this.paintSepulchreMasonry(ctx, r);
    this.paintSepulchreFace(ctx, r, open);
    this.paintStoneRelight(ctx, H, r);
    this.paintReliquaryLight(ctx, r, open, time);
    ctx.restore();

    this.renderBossCracks(ctx, damageT);

    // Rim: the dark contact edge that seats the tomb against the starfield,
    // then a thin catch of light on top of it that glints on the same
    // incommensurate sines the bassteroid rims use.
    const shimmer = 0.5 + 0.5 * (0.6 * Math.sin(t * 0.0019) + 0.4 * Math.sin(t * 0.0041 + this.pos.x * 0.03));
    ctx.save();
    ctx.strokeStyle = `hsla(${H}, 30%, 5%, 0.9)`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = `hsla(${H + 14}, 90%, ${58 + 14 * open}%, ${0.5 + 0.3 * shimmer})`;
    ctx.lineWidth = 1.6 + 0.7 * shimmer;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.985, 0, TAU);
    ctx.stroke();
    ctx.restore();

    if (this.flashAmount > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `hsla(${H + 25}, 100%, 90%, ${this.flashAmount * 0.3})`;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  // The tomb's wall. Order matters: the stone body and everything carved into
  // it go down first, then a single relight pass drops one terminator across
  // the whole face — without it, the masonry's own flat fills wash the lighting
  // out and the tomb reads as a printed pattern rather than a lit building.
  // Called inside a clip to the body disc by both the dormant reveal and the
  // live render, so the architecture resolves out of the black silhouette
  // rather than being swapped in.
  private paintSepulchreMasonry(ctx: CanvasRenderingContext2D, r: number) {
    const H = this.hue;
    ctx.globalCompositeOperation = "source-over";
    const body = ctx.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.1, 0, 0, r * 1.2);
    body.addColorStop(0, `hsl(${H + 6}, 22%, 26%)`);
    body.addColorStop(0.5, `hsl(${H}, 26%, 13%)`);
    body.addColorStop(1, `hsl(${H - 14}, 36%, 4%)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.05, 0, TAU);
    ctx.fill();

    // One belt of dressed courses across the middle, the way a bell fragment
    // wears its band. Banding rather than tiling the whole disc is what leaves
    // the crown and the foot as plain shadowed mass, so the eye reads a round
    // body with a course line round it instead of a flat brick circle.
    ctx.save();
    ctx.globalAlpha = 0.55;
    this.paintMasonryBand(ctx, H, r * 0.55, -r * 0.55, r * 0.55);
    ctx.restore();

    // Buttress ribs — dressed piers standing off the wall on radial lines. Each
    // gets a lit up-left edge and a shadowed down-right one, which is what makes
    // the face read as built depth rather than a painted pattern.
    const ribs = 12;
    for (let i = 0; i < ribs; i++) {
      ctx.save();
      ctx.rotate((i / ribs) * TAU);
      const halfW = r * 0.045;
      const inner = r * 0.5;
      ctx.fillStyle = `hsla(${H}, 20%, 17%, 0.9)`;
      ctx.fillRect(inner, -halfW, r - inner, halfW * 2);
      ctx.strokeStyle = `hsla(${H + 8}, 20%, 62%, 0.4)`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(inner, -halfW);
      ctx.lineTo(r, -halfW);
      ctx.stroke();
      ctx.strokeStyle = `hsla(${H}, 28%, 4%, 0.7)`;
      ctx.beginPath();
      ctx.moveTo(inner, halfW);
      ctx.lineTo(r, halfW);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Drop one light direction over everything painted so far. Multiply keeps the
  // masonry and tracery underneath legible while pushing the lower-right of the
  // body into shadow, so a face built out of many flat fills still ends up lit
  // by the same upper-left sun as the rest of the game.
  private paintStoneRelight(ctx: CanvasRenderingContext2D, hue: number, r: number) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    const shade = ctx.createRadialGradient(-r * 0.45, -r * 0.5, r * 0.15, 0, 0, r * 1.25);
    shade.addColorStop(0, "hsl(0, 0%, 100%)");
    shade.addColorStop(0.55, `hsl(${hue}, 20%, 52%)`);
    shade.addColorStop(1, `hsl(${hue - 10}, 30%, 14%)`);
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // The face, in stone: a great rose window and the two shutter leaves that
  // hold it shut. `open` (0..1) parts the leaves, so the player reads exactly
  // how much of the bier is left from across the field. The light behind it is
  // a separate additive pass (see paintReliquaryLight) laid down after the
  // relight, so the one thing in the frame that is actually glowing doesn't get
  // shaded like stone.
  private paintSepulchreFace(ctx: CanvasRenderingContext2D, r: number, open: number) {
    const H = this.hue;
    const drumR = r * 0.5;
    const roseR = r * 0.34;

    // The drum: a raised round housing standing proud of the wall, where the
    // ribs all run to. It gives the rose something to be set into, so the face
    // reads as a building's west front rather than a pattern on a ball.
    const drum = ctx.createRadialGradient(-drumR * 0.4, -drumR * 0.45, drumR * 0.1, 0, 0, drumR);
    drum.addColorStop(0, `hsl(${H + 6}, 22%, 30%)`);
    drum.addColorStop(0.7, `hsl(${H}, 24%, 17%)`);
    drum.addColorStop(1, `hsl(${H - 10}, 30%, 8%)`);
    ctx.fillStyle = drum;
    ctx.beginPath();
    ctx.arc(0, 0, drumR, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `hsla(${H}, 28%, 5%, 0.85)`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, drumR, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `hsla(${H + 10}, 22%, 70%, 0.4)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, drumR * 0.94, Math.PI * 0.75, Math.PI * 1.85);
    ctx.stroke();

    this.paintRoseWindow(ctx, H, 0, 0, roseR, 12);

    // Two shutter leaves, cut to the rose and no wider — the lid over the
    // reliquary, not a slab over the whole front. They are darker than the wall
    // they sit in, so a shut tomb reads as a hole where the light should be and
    // `open` is unmistakable from across the field.
    const travel = open * roseR * 1.15;
    const leafW = roseR * 1.04;
    const leafH = roseR * 1.04;
    for (const side of [-1, 1] as const) {
      ctx.save();
      ctx.translate(side * travel, 0);
      const x = side < 0 ? -leafW : 0;
      const grad = ctx.createLinearGradient(x, -leafH, x + leafW, leafH);
      grad.addColorStop(0, `hsl(${H + 4}, 24%, ${side < 0 ? 15 : 10}%)`);
      grad.addColorStop(1, `hsl(${H - 8}, 30%, ${side < 0 ? 8 : 4}%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x, -leafH, leafW, leafH * 2);
      // Bevel: a lit lip along the meeting edge and a shadowed one along the
      // outer, so the pair reads as two slabs being drawn apart.
      ctx.strokeStyle = `hsla(${H + 10}, 24%, 76%, 0.55)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(side < 0 ? -1 : 1, -leafH);
      ctx.lineTo(side < 0 ? -1 : 1, leafH);
      ctx.stroke();
      ctx.strokeStyle = `hsla(${H}, 30%, 3%, 0.85)`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x + (side < 0 ? 0 : leafW), -leafH);
      ctx.lineTo(x + (side < 0 ? 0 : leafW), leafH);
      ctx.stroke();
      ctx.restore();
    }
  }

  // The reliquary itself, welling up through the tracery as the leaves part.
  // Additive and unshaded: this is the only light source on the body, and how
  // bright it is IS the fight's state.
  private paintReliquaryLight(ctx: CanvasRenderingContext2D, r: number, open: number, time: number) {
    if (open <= 0.001) return;
    const H = this.hue;
    const lightR = r * (0.5 + 0.3 * open);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const pulse = 0.7 + 0.3 * Math.sin(time * 2.1);
    const light = ctx.createRadialGradient(0, 0, 0, 0, 0, lightR);
    light.addColorStop(0, `hsla(${H + 25}, 100%, 95%, ${0.85 * open * pulse})`);
    light.addColorStop(0.4, `hsla(${H + 8}, 100%, 70%, ${0.45 * open * pulse})`);
    light.addColorStop(1, `hsla(${H}, 100%, 55%, 0)`);
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(0, 0, lightR, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

// Advance one torus fragment cluster for the frame: drift the phantom-ring
// centre, spin the ring, prune dead members, and snap every living fragment
// onto its fixed angular slot (position + outward-facing rotation). This is the
// "reassemble the ring" motion — the broken pieces hold their slots on a slowly
// rotating ring rather than flying apart on momentum. Called once per group per
// frame from the game loop (see tickTorusGroups), NOT per member.
//
// Returns false once the group is empty so the caller can drop it.
export const tickTorusGroup = (group: TorusGroup, dt: number, w: number, h: number): boolean => {
  group.members = group.members.filter((m) => m.alive && m.torusGroup === group);
  if (group.members.length === 0) return false;
  // Drift + wrap the shared centre (so the cluster scrolls like everything else)
  // and rotate the ring.
  group.center.x += group.vel.x * dt;
  group.center.y += group.vel.y * dt;
  wrapMut(group.center, w, h);
  group.phase += group.spin * dt;
  for (const m of group.members) {
    const ang = m.torusSlot + group.phase;
    m.pos.x = group.center.x + Math.cos(ang) * group.ringRadius;
    m.pos.y = group.center.y + Math.sin(ang) * group.ringRadius;
    // The baked arc bulges toward +x in its local frame; rotate so the bulge
    // faces radially outward from the ring centre.
    m.rotation = ang;
  }
  return true;
};

// Tick every distinct torus group represented in `asteroids` exactly once.
// Groups are shared by reference across their fragments, so we dedupe via a Set
// before ticking — otherwise a 4-fragment ring would advance its phase 4× per
// frame. Call after the per-asteroid update() pass, before collision.
export const tickTorusGroups = (asteroids: Asteroid[], dt: number, w: number, h: number) => {
  const groups = collectTorusGroups(asteroids);
  if (groups) for (const g of groups) tickTorusGroup(g, dt, w, h);
};

const collectTorusGroups = (asteroids: Asteroid[]): Set<TorusGroup> | null => {
  let groups: Set<TorusGroup> | null = null;
  for (const a of asteroids) {
    if (a.torusGroup) (groups ??= new Set()).add(a.torusGroup);
  }
  return groups;
};

// Does the point (px,py) within `reach` touch any energy thread strung between a
// torus group's adjacent fragments? Threads follow the phantom-ring arc between
// neighbouring fragments (the same path renderTorusThread paints), so we sample
// a few points along each gap arc and test distance. Used to charge the ship's
// super-laser when it flies through a thread. The flicker is purely cosmetic —
// the thread is "there" for gameplay the whole time two fragments span a gap.
export const shipTouchingTorusThread = (
  asteroids: Asteroid[], px: number, py: number, reach: number,
): boolean => {
  const groups = collectTorusGroups(asteroids);
  if (!groups) return false;
  const reachSq = reach * reach;
  for (const g of groups) {
    const living = g.members.filter((m) => m.alive);
    if (living.length < 2) continue;
    // Unfold the ship point to the group's frame so a ring straddling the
    // seam still registers the pass-through.
    const p = nearestImageOf({ x: px, y: py }, g.center, WORLD_W, WORLD_H);
    const gpx = p.x;
    const gpy = p.y;
    // Order fragments by their current ring angle so neighbours are adjacent.
    const byAngle = living
      .map((m) => ({ m, ang: m.torusSlot + g.phase, span: m.torusArcSpan }))
      .sort((a, b) => a.ang - b.ang);
    for (let i = 0; i < byAngle.length; i++) {
      const cur = byAngle[i];
      const nxt = byAngle[(i + 1) % byAngle.length];
      // Arc gap from cur's leading edge to nxt's trailing edge (wrap on last).
      const a0 = cur.ang + cur.span * 0.5;
      let a1 = nxt.ang - nxt.span * 0.5;
      while (a1 <= a0) a1 += TAU;
      // Broad cull: if the point is nowhere near the ring radius, skip.
      const dxc = gpx - g.center.x;
      const dyc = gpy - g.center.y;
      const distFromCenter = Math.hypot(dxc, dyc);
      if (Math.abs(distFromCenter - g.ringRadius) > reach + g.ringRadius * 0.12) continue;
      const steps = 8;
      for (let s = 0; s <= steps; s++) {
        const ang = a0 + (a1 - a0) * (s / steps);
        const tx = g.center.x + Math.cos(ang) * g.ringRadius;
        const ty = g.center.y + Math.sin(ang) * g.ringRadius;
        const dx = gpx - tx;
        const dy = gpy - ty;
        if (dx * dx + dy * dy <= reachSq) return true;
      }
    }
  }
  return false;
};

// Drop the boss directly at the screen position the looming planetoid was
// occupying, with a slow drift toward the screen centre. We don't aim at
// the ship — the boss is a planetoid, not a hunter — and we pick a gentle
// speed so the player has time to react to the new threat.
export const spawnBossAt = (
  pos: Vec,
  w: number,
  h: number,
): Asteroid => {
  const cx = w / 2;
  const cy = h / 2;
  const dx = cx - pos.x;
  const dy = cy - pos.y;
  const norm = Math.max(1, Math.hypot(dx, dy));
  const speed = 5;
  const vel = v((dx / norm) * speed, (dy / norm) * speed);
  return new Asteroid({ x: pos.x, y: pos.y }, vel, "large", undefined, "boss");
};

// min sin of angle between trajectory and the spawn edge. sin(30°) = 0.5 — at
// shallower angles an edge spawn skims along its own edge for a long time
// before drifting inward, which reads as the rock briefly hugging the border.
const EDGE_SPAWN_MIN_INWARD = 0.5;

export const spawnAsteroidAtEdge = (
  w: number,
  h: number,
  hue?: number,
  kind: AsteroidKind = "normal",
  size: AsteroidSize = "large",
): Asteroid => {
  const edge = Math.floor(rng() * 4);
  let pos: Vec;
  let inwardAxis: "x" | "y";
  let inwardSign: 1 | -1;
  if (edge === 0)      { pos = v(rand(0, w), -40);       inwardAxis = "y"; inwardSign = 1;  }
  else if (edge === 1) { pos = v(w + 40, rand(0, h));    inwardAxis = "x"; inwardSign = -1; }
  else if (edge === 2) { pos = v(rand(0, w), h + 40);    inwardAxis = "y"; inwardSign = -1; }
  else                 { pos = v(-40, rand(0, h));       inwardAxis = "x"; inwardSign = 1;  }
  const center = v(w / 2 + rand(-w * 0.2, w * 0.2), h / 2 + rand(-h * 0.2, h * 0.2));
  let dirX = center.x - pos.x;
  let dirY = center.y - pos.y;
  const norm = Math.hypot(dirX, dirY);
  dirX /= norm;
  dirY /= norm;
  // enforce minimum steepness off the spawning edge. component along the
  // outward-edge axis is what determines how shallow the angle is; scale up
  // until its absolute value matches the min threshold.
  const inwardComp = inwardAxis === "x" ? dirX * inwardSign : dirY * inwardSign;
  if (inwardComp < EDGE_SPAWN_MIN_INWARD) {
    if (inwardAxis === "x") {
      dirX = inwardSign * EDGE_SPAWN_MIN_INWARD;
      const tangentMag = Math.sqrt(1 - EDGE_SPAWN_MIN_INWARD * EDGE_SPAWN_MIN_INWARD);
      dirY = Math.sign(dirY) * tangentMag;
    } else {
      dirY = inwardSign * EDGE_SPAWN_MIN_INWARD;
      const tangentMag = Math.sqrt(1 - EDGE_SPAWN_MIN_INWARD * EDGE_SPAWN_MIN_INWARD);
      dirX = Math.sign(dirX) * tangentMag;
    }
  }
  const [speedMin, speedMax] = SIZE_SPAWN_SPEED[size];
  const speed = rand(speedMin, speedMax);
  return new Asteroid(pos, v(dirX * speed, dirY * speed), size, hue, kind);
};
