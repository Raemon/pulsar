import type { Ship } from "../Ship";

// Ship triangle geometry, shared with anything that needs the hull shape
// without a live Ship instance (e.g. the citadel's ship-shaped escape hole).
// Ship.ts seeds its radius/baseHaloOffset fields from these.
export const SHIP_BODY_RADIUS = 14;
export const SHIP_HALO_OFFSET = 8;
export const SHIP_NOSE_MUL = 1.4;
export const SHIP_WING_ANGLE = Math.PI * 0.78;

// collisions test the visible halo outline, not a bounding circle, so the outline IS the hitbox.
export const haloVertices = (ship: Ship, offset: number = ship.haloOffset): Array<[number, number]> =>
  haloVerticesFor(ship.heading, ship.radius, offset);

const haloVerticesFor = (heading: number, radius: number, offset: number): Array<[number, number]> => {
  const hull: Array<[number, number]> = [
    [Math.cos(heading) * radius * SHIP_NOSE_MUL, Math.sin(heading) * radius * SHIP_NOSE_MUL],
    [Math.cos(heading + SHIP_WING_ANGLE) * radius, Math.sin(heading + SHIP_WING_ANGLE) * radius],
    [Math.cos(heading - SHIP_WING_ANGLE) * radius, Math.sin(heading - SHIP_WING_ANGLE) * radius],
  ];
  const s = polygonOutwardSign(hull);
  const halo: Array<[number, number]> = [];
  for (let k = 0; k < 3; k++) halo.push(miterVertex(hull, k, s, offset));
  return halo;
};

// How far the halo outline reaches from the ship's centre at its furthest — the
// nose tip, whose sharp mitred corner sits well past the hull's nose vertex.
export const haloReach = (radius: number, offset: number): number =>
  Math.max(...haloVerticesFor(0, radius, offset).map(([x, y]) => Math.hypot(x, y)));

// hull winding direction varies with heading; we need it to pick the "outward" normal sign.
const polygonOutwardSign = (hull: Array<[number, number]>): number => {
  const cross =
    (hull[1][0] - hull[0][0]) * (hull[2][1] - hull[0][1]) -
    (hull[1][1] - hull[0][1]) * (hull[2][0] - hull[0][0]);
  return cross < 0 ? 1 : -1;
};

// pushing each vertex along its bisector keeps the offset edges perpendicular to the hull edges.
const miterVertex = (hull: Array<[number, number]>, k: number, s: number, offset: number): [number, number] => {
  const prev = hull[(k + 2) % 3];
  const curr = hull[k];
  const next = hull[(k + 1) % 3];
  const e1x = curr[0] - prev[0], e1y = curr[1] - prev[1];
  const e2x = next[0] - curr[0], e2y = next[1] - curr[1];
  let n1x = s * -e1y, n1y = s * e1x;
  let n2x = s * -e2y, n2y = s * e2x;
  const l1 = Math.hypot(n1x, n1y) || 1;
  const l2 = Math.hypot(n2x, n2y) || 1;
  n1x /= l1; n1y /= l1;
  n2x /= l2; n2y /= l2;
  let bx = n1x + n2x, by = n1y + n2y;
  const bl = Math.hypot(bx, by) || 1;
  bx /= bl; by /= bl;
  const dot = bx * n1x + by * n1y;
  const miter = offset / Math.max(0.2, dot);
  return [curr[0] + bx * miter, curr[1] + by * miter];
};

// bullets/asteroids need the exact reach so glancing hits register if they touch the visible outline.
export const hitDistanceToward = (ship: Ship, theta: number): number => {
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);
  const halo = haloVertices(ship);
  const best = closestHaloRayDistance(halo, dx, dy);
  if (!Number.isFinite(best)) return ship.hitRadius;
  // collision-only padding (uniform + forward bonus) bulks the hitbox without moving the outline.
  const forward = Math.max(0, Math.cos(theta - ship.heading));
  return best + ship.hitPad + ship.hitFrontBonus * forward;
};

// ray-vs-segment per halo edge gives the silhouette distance the player sees in that direction.
const closestHaloRayDistance = (halo: Array<[number, number]>, dx: number, dy: number): number => {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const a = halo[k];
    const b = halo[(k + 1) % 3];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const t = (a[0] * ey - a[1] * ex) / denom;
    const u = (a[0] * dy - a[1] * dx) / denom;
    if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
};

// Anything that answers "does a circle at `point` of radius `r` touch you?" —
// asteroids, pickups, gems, bullets, portals.
export type ContactTarget = {
  pos: { x: number; y: number };
  collidesWith(point: { x: number; y: number }, r: number): boolean;
};

// Does any part of the ship's visible outline touch `target`? `dx, dy` is the
// target's offset from the ship (the caller resolves the toroidal wrap), and
// `pad` grows the outline by that much for the test.
//
// The outline is a long-nosed triangle (the nose tip sits ~3× further out than
// the flanks), so a reach measured along the centre-to-centre line misses
// anything brushing the nose or a wing tip off-axis. Instead the target is
// asked about the actual outline: the point on it closest to the target's
// centre (exact for round targets), plus its corners and points along each
// edge (so a jagged rock poking at a flank still registers), and a target
// whose centre lies inside the outline touches if the target itself agrees
// (its own rules — phased out, dormant, warping — still apply).
export const shipTouches = (
  ship: Ship, target: ContactTarget, dx: number, dy: number, pad: number,
): boolean => {
  const halo = haloVertices(ship);
  // The ship's image nearest the target, in world coords.
  const ox = target.pos.x - dx;
  const oy = target.pos.y - dy;
  if (pointInTriangle(halo, dx, dy) && target.collidesWith(target.pos, pad)) return true;
  const c = closestOnOutline(halo, dx, dy);
  if (target.collidesWith({ x: ox + c[0], y: oy + c[1] }, pad)) return true;
  for (let k = 0; k < 3; k++) {
    const a = halo[k];
    const b = halo[(k + 1) % 3];
    for (let i = 0; i < EDGE_SAMPLES; i++) {
      const t = i / EDGE_SAMPLES;
      const p = { x: ox + a[0] + (b[0] - a[0]) * t, y: oy + a[1] + (b[1] - a[1]) * t };
      if (target.collidesWith(p, pad)) return true;
    }
  }
  return false;
};

const EDGE_SAMPLES = 4;

const pointInTriangle = (tri: Array<[number, number]>, px: number, py: number): boolean => {
  let sign = 0;
  for (let k = 0; k < 3; k++) {
    const a = tri[k];
    const b = tri[(k + 1) % 3];
    const cross = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

const closestOnOutline = (poly: Array<[number, number]>, px: number, py: number): [number, number] => {
  let best: [number, number] = poly[0];
  let bestD = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey) / len2));
    const cx = a[0] + ex * t;
    const cy = a[1] + ey * t;
    const d = (px - cx) ** 2 + (py - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [cx, cy];
    }
  }
  return best;
};
