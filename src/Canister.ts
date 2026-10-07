import { Vec, v, mul, sub, len, rand, pick, TAU, addScaledMut, circleHit, wrapMut } from "./vec";
import { ENTITY_CONFIG } from "./game/entityConfig";
import { OCTAHEDRON_EDGES, projectOctahedron } from "./octahedron";
import { SIDE_THRUST_ALWAYS_ON } from "./ship/shipPhysics";

// Powerup kinds. The canister doesn't reveal which one it holds — the
// player finds out on pickup.
export type PowerupKind = "prong" | "rapid" | "pierce" | "shield" | "slow" | "radar" | "longshot" | "sideEngines" | "lasershot" | "bomb";

// Hue is kept for downstream effects (pickup burst tinting) but the canister
// itself renders pure white so the player reads it as "incoming pod" first
// and only learns its kind on pickup.
export const POWERUP_HUE: Record<PowerupKind, number> = {
  prong: 180,
  rapid: 300,
  pierce: 60,
  shield: 200,
  slow: 130,
  radar: 30,
  longshot: 270,
  sideEngines: 25,
  lasershot: 195,
  bomb: 0,
};

// sideEngines is dropped from the pool when side thrust is always-on (it would
// be a no-op pickup); flip SIDE_THRUST_ALWAYS_ON back to false to restore it.
export const POWERUP_KINDS: PowerupKind[] = (["prong", "shield", "slow", "radar", "longshot", "sideEngines", "lasershot", "bomb"] as PowerupKind[])
  .filter((k) => !(k === "sideEngines" && SIDE_THRUST_ALWAYS_ON));

// warp-out plays a brief vortex flash before the canister vanishes so the player
//   sees a deliberate departure (not just a soft offscreen fade) when they let a pod drift past.
const WARP_DURATION = ENTITY_CONFIG.canister.warpDuration;

export class Canister {
  pos: Vec;
  vel: Vec;
  kind: PowerupKind;
  hue: number;
  radius = ENTITY_CONFIG.canister.radius;
  age = 0;
  alive = true;
  // travel budget from spawn — once exceeded, warp-out triggers instead of waiting for an offscreen test.
  pathLength: number;
  traveled = 0;
  warpTimer: number | null = null;
  // Three independent tumble axes so the projected silhouette never settles
  // into a flat 2D spin — gives the eye a clear "3D object" read.
  rotX: number;
  rotY: number;
  rotZ: number;
  rotSpeedX: number;
  rotSpeedY: number;
  rotSpeedZ: number;

  constructor(pos: Vec, vel: Vec, kind: PowerupKind, pathLength: number) {
    this.pos = pos;
    this.vel = vel;
    this.kind = kind;
    this.hue = POWERUP_HUE[kind];
    this.pathLength = pathLength;
    this.rotX = rand(0, TAU);
    this.rotY = rand(0, TAU);
    this.rotZ = rand(0, TAU);
    this.rotSpeedX = rand(-2.2, 2.2);
    this.rotSpeedY = rand(-2.2, 2.2);
    this.rotSpeedZ = rand(-1.2, 1.2);
  }

  update(dt: number, w: number, h: number) {
    this.age += dt;
    this.rotX += this.rotSpeedX * dt;
    this.rotY += this.rotSpeedY * dt;
    this.rotZ += this.rotSpeedZ * dt;
    if (this.warpTimer === null) {
      addScaledMut(this.pos, this.vel, dt);
      wrapMut(this.pos, w, h);
      this.traveled += Math.hypot(this.vel.x, this.vel.y) * dt;
      if (this.traveled >= this.pathLength) this.warpTimer = 0;
    } else {
      this.warpTimer += dt;
      if (this.warpTimer >= WARP_DURATION) this.alive = false;
    }
  }

  get warping(): boolean {
    return this.warpTimer !== null;
  }

  get warpProgress(): number {
    return this.warpTimer === null ? 0 : Math.min(1, this.warpTimer / WARP_DURATION);
  }

  collidesWith(point: Vec, pointRadius: number): boolean {
    // warp-out is a commit — pickups and bullet hits stop registering once
    //   the vortex kicks off so the player can't "save" a pod by clipping it mid-warp.
    if (this.warping) return false;
    return circleHit(this.pos, this.radius, point, pointRadius);
  }

  render(ctx: CanvasRenderingContext2D, t: number) {
    if (this.warping) {
      this.renderWarp(ctx, t);
      return;
    }
    const time = t * 0.001;
    const pulse = 0.75 + 0.25 * Math.sin(time * 3 + this.age * 2);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Soft white bloom around the pod.
    const haloGrad = ctx.createRadialGradient(this.pos.x, this.pos.y, 0, this.pos.x, this.pos.y, this.radius * 3.2);
    haloGrad.addColorStop(0, `rgba(255, 255, 255, ${0.55 * pulse})`);
    haloGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = haloGrad;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius * 3.2, 0, TAU);
    ctx.fill();

    // 3D tumble: a wireframe octahedron whose crossing edges stay legible
    // even when only a few pixels move per frame.
    const r = this.radius * 1.05;
    const projected = projectOctahedron(this.rotX, this.rotY, this.rotZ, r);

    ctx.translate(this.pos.x, this.pos.y);
    ctx.lineWidth = 1.4;
    for (const [a, b] of OCTAHEDRON_EDGES) {
      const va = projected[a];
      const vb = projected[b];
      // Depth fade: edges with a vertex behind the "camera" plane dim a
      // bit so the front faces pop. Cheap fake-shading that still sells
      // the 3D read.
      const depth = (va.z + vb.z) * 0.5;
      const depthAlpha = 0.55 + 0.45 * ((depth + r) / (2 * r));
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.85 * pulse * depthAlpha).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(va.x, va.y);
      ctx.lineTo(vb.x, vb.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  // vortex-warp instead of a soft fade — radial streaks collapse into a bright
  //   point so the player reads "pod warped out" as a deliberate event.
  private renderWarp(ctx: CanvasRenderingContext2D, t: number) {
    const p = this.warpProgress;
    const time = t * 0.001;
    // Ease-in collapse: streaks pull inward faster as p → 1.
    const collapse = 1 - Math.pow(1 - p, 2);
    // Flash brightens midway then snaps off in the final frames.
    const flash = Math.sin(p * Math.PI);
    const baseR = this.radius;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(this.pos.x, this.pos.y);

    // Outer halo briefly blooms then snaps in.
    const haloRadius = baseR * (3.6 - 2.8 * collapse);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloRadius);
    halo.addColorStop(0, `rgba(255, 255, 255, ${0.85 * flash})`);
    halo.addColorStop(0.45, `rgba(190, 230, 255, ${0.45 * flash})`);
    halo.addColorStop(1, "rgba(120, 180, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, haloRadius, 0, TAU);
    ctx.fill();

    // Radial streaks: 14 lines whose outer ends spiral as they pull inward —
    // gives the eye the rotational vortex read without needing a textured swirl.
    const spokes = 14;
    const swirl = collapse * 1.6 + time * 4;
    const outerStart = baseR * 3.2;
    const outerEnd = baseR * 0.25;
    const outerR = outerStart + (outerEnd - outerStart) * collapse;
    const innerR = baseR * 0.05;
    ctx.lineWidth = 1.4;
    for (let i = 0; i < spokes; i++) {
      const theta = (i / spokes) * TAU + swirl;
      const x1 = Math.cos(theta) * outerR;
      const y1 = Math.sin(theta) * outerR;
      const x2 = Math.cos(theta + 0.35) * innerR;
      const y2 = Math.sin(theta + 0.35) * innerR;
      const alpha = (0.35 + 0.55 * flash) * (1 - p * 0.4);
      ctx.strokeStyle = `rgba(220, 240, 255, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Bright core that pinches to a point near the end.
    const coreRadius = baseR * (0.9 - 0.7 * collapse);
    if (coreRadius > 0.5) {
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreRadius);
      core.addColorStop(0, `rgba(255, 255, 255, ${0.95 * (1 - p * 0.2)})`);
      core.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, coreRadius, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }
}

// pods enter close to one edge and cross the playfield toward the opposite side so
//   they read as "incoming traffic" rather than random middle-of-screen drift; path length
//   randomised so the warp-out point isn't always the same spot near the far edge.
const EDGE_INSET_MIN = 28;
const EDGE_INSET_MAX = 70;
const PATH_FACTOR_MIN = 0.75;
const PATH_FACTOR_MAX = 0.95;
const LATERAL_JITTER = 0.32;

type EdgeSide = "top" | "bottom" | "left" | "right";

const pickSpawnFromEdge = (w: number, h: number): { pos: Vec; side: EdgeSide } => {
  const side = pick<EdgeSide>(["top", "bottom", "left", "right"]);
  const inset = rand(EDGE_INSET_MIN, EDGE_INSET_MAX);
  if (side === "top") return { pos: v(rand(80, w - 80), inset), side };
  if (side === "bottom") return { pos: v(rand(80, w - 80), h - inset), side };
  if (side === "left") return { pos: v(inset, rand(80, h - 80)), side };
  return { pos: v(w - inset, rand(80, h - 80)), side };
};

// aim point on the opposite edge with a wide lateral jitter so the trajectory crosses
//   the play area at varied angles instead of always being purely horizontal/vertical.
const pickAimPoint = (w: number, h: number, side: EdgeSide): Vec => {
  const inset = rand(EDGE_INSET_MIN, EDGE_INSET_MAX);
  if (side === "top") return v(rand(w * LATERAL_JITTER, w * (1 - LATERAL_JITTER)), h - inset);
  if (side === "bottom") return v(rand(w * LATERAL_JITTER, w * (1 - LATERAL_JITTER)), inset);
  if (side === "left") return v(w - inset, rand(h * LATERAL_JITTER, h * (1 - LATERAL_JITTER)));
  return v(inset, rand(h * LATERAL_JITTER, h * (1 - LATERAL_JITTER)));
};

export const spawnCanister = (w: number, h: number, _shipPos: Vec): Canister => {
  const { pos, side } = pickSpawnFromEdge(w, h);
  const aim = pickAimPoint(w, h, side);
  const delta = sub(aim, pos);
  const fullDist = len(delta) || 1;
  const dir = mul(delta, 1 / fullDist);
  const pathLength = fullDist * rand(PATH_FACTOR_MIN, PATH_FACTOR_MAX);
  const driftSpeed = rand(60, 110);
  const kind = pick(POWERUP_KINDS);
  return new Canister(pos, mul(dir, driftSpeed), kind, pathLength);
};
