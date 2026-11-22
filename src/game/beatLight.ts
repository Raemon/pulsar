import { Asteroid, AsteroidKind, isBeatShieldKind, traceCitadelHolePath } from "../Asteroid";
import { Alien } from "../Alien";
import { Canister } from "../Canister";
import { Comet } from "../Comet";
import { FuelOrb } from "../FuelOrb";
import { Gem } from "../Gem";
import { Shard } from "../Shard";
import { drawGlow } from "../glow";
import { OCTAHEDRON_EDGES, projectOctahedron } from "../octahedron";
import { ENTITY_CONFIG } from "./entityConfig";
import { TAU, Vec } from "../vec";

// Every body on the field carries the beat as a wave of light that crosses it and
// peaks the instant the beat lands: it enters dim BEAT_LIGHT_LEAD before, snaps to
// full brightness on the beat at the body's centre, and is gone BEAT_LIGHT_TRAIL
// after. The timing is shared so the whole field pulses as one; the shape of the
// wave is each material's own — a ripple through a membrane, a scan down a
// bassteroid's modules, candlelight rising up cathedral stone — so the beat reads
// everywhere without the field turning into a sheet of identical flashes.
// The beat cube is the one body left out: its beat is a vulnerability, drawn in
// beatShieldRender instead.
export const BEAT_LIGHT_LEAD = 0.19;
export const BEAT_LIGHT_TRAIL = 0.19;
const PRE_PEAK = 0.4;

// s: −1 as the wave enters → 0 on the beat → +1 as it leaves (constant speed).
// u: the same travel as 0..1. level: builds to PRE_PEAK, snaps to 1 on the beat, falls away.
export type BeatLight = { s: number; u: number; level: number };

let clock: number | null = null;

// Signed seconds from the nearest beat the player hears; null = nothing to cue.
export const setBeatLightClock = (secondsFromBeat: number | null) => {
  clock = secondsFromBeat;
};

export const beatLightAt = (tau: number): BeatLight | null => {
  if (tau < -BEAT_LIGHT_LEAD || tau >= BEAT_LIGHT_TRAIL) return null;
  const s = tau < 0 ? tau / BEAT_LIGHT_LEAD : tau / BEAT_LIGHT_TRAIL;
  const level = tau < 0 ? PRE_PEAK * (1 + s) * (1 + s) : (1 - s) * (1 - s);
  return { s, u: (s + 1) / 2, level };
};

// ---------------------------------------------------------------- helpers

// The body's own baked art, re-blitted additively: wherever the wave's clip lets
// it through, the body brightens in its own colours rather than under a white wash.
const reblit = (ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement | null, half: number, alpha: number) => {
  if (!sprite || alpha <= 0.003) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sprite, -half, -half);
  ctx.globalAlpha = 1;
};

// Clip to a straight band whose normal points along `normalAngle`, centred `center` along it.
const clipBand = (ctx: CanvasRenderingContext2D, normalAngle: number, center: number, halfWidth: number, reach: number) => {
  ctx.rotate(normalAngle);
  ctx.beginPath();
  ctx.rect(center - halfWidth, -reach, halfWidth * 2, reach * 2);
  ctx.rotate(-normalAngle);
  ctx.clip();
};

// A soft-edged light band (transparent → colour → transparent across its width).
const fillBandGlow = (
  ctx: CanvasRenderingContext2D, normalAngle: number, center: number, halfWidth: number, reach: number,
  hsl: string, alpha: number,
) => {
  if (alpha <= 0.003) return;
  ctx.save();
  ctx.rotate(normalAngle);
  const g = ctx.createLinearGradient(center - halfWidth, 0, center + halfWidth, 0);
  g.addColorStop(0, `hsla(${hsl}, 0)`);
  g.addColorStop(0.5, `hsla(${hsl}, ${Math.min(1, alpha).toFixed(3)})`);
  g.addColorStop(1, `hsla(${hsl}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(center - halfWidth, -reach, halfWidth * 2, reach * 2);
  ctx.restore();
};

const clipAnnulus = (ctx: CanvasRenderingContext2D, inner: number, outer: number) => {
  ctx.beginPath();
  ctx.arc(0, 0, outer, 0, TAU);
  ctx.arc(0, 0, Math.max(0, inner), TAU, 0, true);
  ctx.clip();
};

const strokeRing = (ctx: CanvasRenderingContext2D, r: number, hsl: string, alpha: number, width: number) => {
  if (alpha <= 0.003 || r <= 0) return;
  ctx.strokeStyle = `hsla(${hsl}, ${Math.min(1, alpha).toFixed(3)})`;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();
};

// A four-point twinkle held square to the screen, for the faceted bodies.
const paintStar = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, hue: number, alpha: number, rotation: number) => {
  if (alpha <= 0.01 || size <= 0.5) return;
  drawGlow(ctx, x, y, size * 0.55, hue, 0.6 * alpha);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-rotation);
  ctx.strokeStyle = `hsla(${hue}, 60%, 97%, ${Math.min(1, alpha).toFixed(3)})`;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.beginPath();
  ctx.moveTo(-size, 0); ctx.lineTo(size, 0);
  ctx.moveTo(0, -size * 0.75); ctx.lineTo(0, size * 0.75);
  ctx.stroke();
  ctx.restore();
};

const outlinePoint = (a: Asteroid, i: number): Vec => {
  const angle = (i / a.outlineSamples) * TAU;
  return { x: Math.cos(angle) * a.outline[i], y: Math.sin(angle) * a.outline[i] };
};

// Local outline point that sits highest on screen (light from above lands there first).
const topmostOutlinePoint = (a: Asteroid): Vec => {
  const sin = Math.sin(a.rotation), cos = Math.cos(a.rotation);
  let best = outlinePoint(a, 0), bestY = Infinity;
  for (let i = 0; i < a.outlineSamples; i += 2) {
    const p = outlinePoint(a, i);
    const worldY = p.x * sin + p.y * cos;
    if (worldY < bestY) { bestY = worldY; best = p; }
  }
  return best;
};

// The outline's corners — samples further out than both neighbours — where a crystal catches light.
const outlineCorners = (a: Asteroid, count: number): Vec[] => {
  const n = a.outlineSamples;
  const peaks: { i: number; r: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = a.outline[i];
    if (r >= a.outline[(i + n - 1) % n] && r > a.outline[(i + 1) % n]) peaks.push({ i, r });
  }
  peaks.sort((p, q) => q.r - p.r);
  return peaks.slice(0, count).map((p) => outlinePoint(a, p.i));
};

// Light that comes from the upper left of the screen, whatever way the body has tumbled.
const screenDiagonal = (a: { rotation: number }) => Math.PI / 4 - a.rotation;
const screenUp = (a: { rotation: number }) => -Math.PI / 2 - a.rotation;
const screenRight = (a: { rotation: number }) => -a.rotation;

// ---------------------------------------------------------------- asteroid families

type RockPainter = (ctx: CanvasRenderingContext2D, a: Asteroid, L: BeatLight) => void;

// A crest ring fades out as it nears the rim, so it never needs clipping to the outline
// (the re-blitted sprite already carries the body's own shape).
const rimFade = (rr: number, R: number) => Math.max(0, Math.min(1, (0.95 - rr / R) / 0.3));

// Bioluminescent membrane: a ring of the body's own glow breathes out from the
// nuclei to the rim, with a fine bright crest on it.
const membraneRipple: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const rr = R * (0.08 + 1.0 * L.u);
  const w = R * 0.2;
  ctx.save();
  clipAnnulus(ctx, rr - w, rr + w);
  reblit(ctx, a.sprite, a.spriteHalfSize, 0.9 * L.level);
  ctx.restore();
  strokeRing(ctx, rr, `${a.hue + 30}, 30%, 92%`, 0.45 * L.level * rimFade(rr, R), Math.max(1, R * 0.035));
};

// Struck chime: the ripple rings twice, a fundamental and a fainter overtone inside it.
const chimeRings: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const rr = R * (0.12 + 1.0 * L.u);
  ctx.save();
  clipAnnulus(ctx, rr - R * 0.14, rr + R * 0.14);
  reblit(ctx, a.sprite, a.spriteHalfSize, 0.7 * L.level);
  ctx.restore();
  strokeRing(ctx, rr, `${a.hue + 8}, 100%, 82%`, 0.75 * L.level * rimFade(rr, R), Math.max(1.2, R * 0.04));
  strokeRing(ctx, rr * 0.62, `${a.hue + 8}, 100%, 86%`, 0.45 * L.level, Math.max(1, R * 0.025));
};

// Rock with a gem inside: the light gathers inward and the gem kindles on the beat.
const gatherToGem: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const rr = R * (1.05 - 1.0 * L.u);
  ctx.save();
  clipAnnulus(ctx, rr - R * 0.16, rr + R * 0.16);
  reblit(ctx, a.sprite, a.spriteHalfSize, 0.8 * L.level);
  ctx.restore();
  strokeRing(ctx, rr, `${a.hue + 30}, 70%, 90%`, 0.4 * L.level * rimFade(rr, R), Math.max(1, R * 0.03));
  drawGlow(ctx, 0, 0, R * 0.5, a.hue + 30, 0.65 * L.level);
  ctx.globalAlpha = 1;
  paintStar(ctx, 0, 0, R * 0.42 * L.level, a.hue + 30, L.level, a.rotation);
};

// Cut crystal: a specular sheet crosses the facets and its corners twinkle as it passes.
const facetGlints: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const n = screenDiagonal(a);
  const center = L.s * R * 1.25;
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  ctx.save();
  clipBand(ctx, n, center, R * 0.22, R * 1.5);
  reblit(ctx, a.sprite, a.spriteHalfSize, 0.8 * L.level);
  ctx.restore();
  fillBandGlow(ctx, n, center, R * 0.3, R * 1.5, `${a.hue}, 60%, 92%`, 0.3 * L.level);
  ctx.restore();
  const nx = Math.cos(n), ny = Math.sin(n);
  for (const p of outlineCorners(a, 3)) {
    const near = Math.max(0, 1 - Math.abs(p.x * nx + p.y * ny - center) / (R * 0.45));
    paintStar(ctx, p.x * 0.9, p.y * 0.9, R * 0.3 * near, a.hue, near * L.level * 1.4, a.rotation);
  }
};

// Treasure: a narrow gold gleam runs across the gem and one big star flares at its crown.
const treasureGleam: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const n = screenDiagonal(a);
  const center = L.s * R * 1.25;
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  ctx.save();
  clipBand(ctx, n, center, R * 0.12, R * 1.5);
  reblit(ctx, a.sprite, a.spriteHalfSize, 1.0 * L.level);
  ctx.restore();
  fillBandGlow(ctx, n, center, R * 0.4, R * 1.5, "46, 100%, 75%", 0.35 * L.level);
  ctx.restore();
  const crown = topmostOutlinePoint(a);
  paintStar(ctx, crown.x * 0.72, crown.y * 0.72, R * 0.38 * L.level, 48, L.level, a.rotation);
};

// Bassteroid: a scan line runs down the hull and each module lights as the scan crosses it.
const moduleScan: RockPainter = (ctx, a, L) => {
  const ship = a.bassShip;
  if (!ship) return;
  const R = a.radius;
  const scanX = L.s * R * 1.1;
  ctx.lineJoin = "round";
  for (const module of ship.modules) {
    let cx = 0;
    for (const v of module.vertices) cx += v.x;
    cx = (cx / module.vertices.length) * R;
    const m = Math.max(0, 1 - Math.abs(cx - scanX) / (R * 0.5)) * L.level;
    if (m <= 0.01) continue;
    ctx.beginPath();
    module.vertices.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x * R, v.y * R) : ctx.lineTo(v.x * R, v.y * R)));
    ctx.closePath();
    ctx.fillStyle = `hsla(${a.hue}, 100%, 72%, ${(0.42 * m).toFixed(3)})`;
    ctx.fill();
    ctx.strokeStyle = `hsla(${a.hue + 25}, 100%, 90%, ${Math.min(1, m).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  ctx.strokeStyle = `hsla(${a.hue + 30}, 100%, 92%, ${(0.8 * L.level).toFixed(3)})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(scanX, -R * 1.5);
  ctx.lineTo(scanX, R * 1.5);
  ctx.stroke();
  ctx.restore();
};

// Citadel and its warbles: a sonar ping spreads out from the fortress's heart.
const sonarPing: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const rr = R * (0.15 + 1.0 * L.u);
  const level = L.level * a.warbleOpacity;
  ctx.save();
  a.tracePath(ctx, 1);
  if (a.kind === "citadel") {
    traceCitadelHolePath(ctx);
    ctx.clip("evenodd");
  } else {
    ctx.clip();
  }
  ctx.save();
  clipAnnulus(ctx, rr - R * 0.12, rr + R * 0.12);
  reblit(ctx, a.sprite, a.spriteHalfSize, 0.85 * level);
  ctx.restore();
  strokeRing(ctx, rr, `${a.hue + 10}, 100%, 80%`, 0.55 * level, 1.4);
  strokeRing(ctx, rr * 0.82, `${a.hue + 10}, 100%, 80%`, 0.25 * level, 1);
  ctx.restore();
};

// Cathedral stone: warm candlelight climbs the masonry from below, whichever way it tumbles.
const candlelight: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const n = screenUp(a);
  const center = L.s * R * 1.25;
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  ctx.save();
  clipBand(ctx, n, center, R * 0.16, R * 1.5);
  reblit(ctx, a.sprite, a.spriteHalfSize, 0.3 * L.level);
  ctx.restore();
  fillBandGlow(ctx, n, center, R * 0.45, R * 1.5, "40, 100%, 58%", 0.45 * L.level);
  ctx.restore();
};

// Stained glass: the same rising light, split into rose, violet and azure as it passes through.
const prismaticLight: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const n = screenUp(a);
  const center = L.s * R * 1.25;
  const hw = R * 0.5;
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  ctx.rotate(n);
  const g = ctx.createLinearGradient(center - hw, 0, center + hw, 0);
  const alpha = 0.5 * L.level;
  g.addColorStop(0, "hsla(340, 100%, 70%, 0)");
  g.addColorStop(0.3, `hsla(340, 100%, 70%, ${(alpha * 0.8).toFixed(3)})`);
  g.addColorStop(0.5, `hsla(275, 100%, 75%, ${alpha.toFixed(3)})`);
  g.addColorStop(0.7, `hsla(205, 100%, 72%, ${(alpha * 0.8).toFixed(3)})`);
  g.addColorStop(1, "hsla(205, 100%, 72%, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(center - hw, -R * 1.5, hw * 2, R * 3);
  ctx.restore();
};

// Glass prison: bars of light slide across the cell.
const prisonBars: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const n = screenRight(a);
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  for (let k = 0; k < 4; k++) {
    const center = L.s * R * 1.3 + (k - 1.5) * R * 0.24;
    fillBandGlow(ctx, n, center, R * 0.06, R * 1.5, `${a.hue + 10}, 80%, 85%`, 0.55 * L.level);
    ctx.save();
    ctx.rotate(n);
    ctx.strokeStyle = `hsla(${a.hue + 10}, 60%, 95%, ${(0.6 * L.level).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center, -R * 1.5);
    ctx.lineTo(center, R * 1.5);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
};

// Wraith: a faint cold ripple, scaled by how far it has surfaced so a hidden one stays hidden.
const ghostRipple: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const vis = 0.15 + 0.85 * a.wraithEmerge;
  strokeRing(ctx, R * (0.3 + 0.9 * L.u), `${a.hue}, 60%, 88%`, 0.4 * L.level * vis, 1.5);
  strokeRing(ctx, R * (0.15 + 0.7 * L.u), `${a.hue}, 60%, 88%`, 0.2 * L.level * vis, 1);
};

const TORUS_TUBE = ENTITY_CONFIG.torus.tubeFrac;

// A runner of light along an arc: a hairline core with a comet of cached glow blits
// trailing behind its head (a tube-wide stroke would cost far more to rasterise).
const RUNNER_BLOBS = 5;
const strokeRunner = (
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, from: number, to: number,
  tube: number, hue: number, level: number,
) => {
  ctx.lineCap = "round";
  ctx.strokeStyle = `hsla(${hue}, 100%, 90%, ${(0.9 * level).toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.min(from, to), Math.max(from, to));
  ctx.stroke();
  for (let k = 0; k < RUNNER_BLOBS; k++) {
    const ang = to + (from - to) * (k / RUNNER_BLOBS);
    const fade = 1 - k / RUNNER_BLOBS;
    drawGlow(ctx, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, tube * 0.6 * (0.6 + 0.4 * fade), hue, 0.7 * level * fade);
  }
  ctx.globalAlpha = 1;
};

// Torus: two runners leave the top of the ring and race round its lamps in opposite directions.
const ringRunners: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const rc = R * (1 - TORUS_TUBE / 2);
  const tube = R * TORUS_TUBE;
  const top = screenUp(a);
  const reach = Math.PI * L.u;
  const tail = 0.5;
  strokeRunner(ctx, 0, 0, rc, top + reach - tail, top + reach, tube, a.hue + 10, L.level);
  strokeRunner(ctx, 0, 0, rc, top - reach + tail, top - reach, tube, a.hue + 10, L.level);
};

// Torus fragment: a single runner travels the length of the broken arc.
const arcRunner: RockPainter = (ctx, a, L) => {
  const bend = a.torusBendRadius || a.radius;
  const span = a.torusArcSpan || 0.5;
  const tube = bend * TORUS_TUBE;
  const head = -span / 2 + span * L.u;
  strokeRunner(ctx, -bend, 0, bend, Math.max(-span / 2, head - span * 0.35), head, tube, a.hue + 10, L.level);
};

// Metal: a hard, narrow specular streak flicks across the plate.
const metalStreak: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const n = screenDiagonal(a);
  const center = L.s * R * 1.2;
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  fillBandGlow(ctx, n, center, R * 0.1, R * 1.5, "210, 25%, 96%", 0.55 * L.level);
  ctx.rotate(n);
  ctx.strokeStyle = `hsla(210, 30%, 99%, ${(0.85 * L.level).toFixed(3)})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(center, -R * 1.5);
  ctx.lineTo(center, R * 1.5);
  ctx.stroke();
  ctx.restore();
};

// Void square: a square of light closes in from the striped frame onto the dark centre.
const squareClose: RockPainter = (ctx, a, L) => {
  const hs = a.radius * (0.95 - 0.75 * L.u);
  ctx.lineJoin = "miter";
  ctx.strokeStyle = `hsla(280, 100%, 75%, ${(0.25 * L.level).toFixed(3)})`;
  ctx.lineWidth = 6;
  ctx.strokeRect(-hs, -hs, hs * 2, hs * 2);
  ctx.strokeStyle = `hsla(285, 90%, 90%, ${(0.85 * L.level).toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(-hs, -hs, hs * 2, hs * 2);
};

// Boss eye and embers: a ring of fire closes from the rim onto the pupil, which flares on the beat.
const fireIris: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const rr = R * (1.0 - 0.85 * L.u);
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R * 1.02, 0, TAU);
  ctx.clip();
  strokeRing(ctx, rr, "28, 100%, 60%", 0.2 * L.level, R * 0.16);
  strokeRing(ctx, rr, "36, 100%, 76%", 0.7 * L.level, Math.max(1.5, R * 0.04));
  ctx.restore();
  drawGlow(ctx, 0, 0, R * 0.35, 20, 0.5 * L.level);
  ctx.globalAlpha = 1;
};

// Boss hemisphere: a surge of magma heat rolls across the broken half.
const magmaSurge: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const n = screenRight(a);
  const center = L.s * R * 1.25;
  ctx.save();
  a.tracePath(ctx, 1);
  ctx.clip();
  ctx.save();
  clipBand(ctx, n, center, R * 0.2, R * 1.5);
  reblit(ctx, a.sprite, a.spriteHalfSize, 0.7 * L.level);
  ctx.restore();
  fillBandGlow(ctx, n, center, R * 0.4, R * 1.5, "22, 100%, 58%", 0.45 * L.level);
  ctx.restore();
};

// Boss plate: two embers chase each other round the plate's bevelled edge.
const BOSS_PLATE_PERIMETER = 5.55; // of the traceBossPlatePath trapezoid, in radius units
const plateEmbers: RockPainter = (ctx, a, L) => {
  const P = BOSS_PLATE_PERIMETER * a.radius;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash([P * 0.14, P * 0.36]);
  ctx.lineDashOffset = -L.u * P * 0.5;
  a.traceBossPlatePath(ctx, 1);
  ctx.strokeStyle = `hsla(18, 100%, 60%, ${(0.3 * L.level).toFixed(3)})`;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.strokeStyle = `hsla(30, 100%, 80%, ${(0.95 * L.level).toFixed(3)})`;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
};

// Iris shard: an ember runs the length of the dead eye's crescent.
const crescentEmber: RockPainter = (ctx, a, L) => {
  const r = a.radius;
  const start = a.bossFragmentAngle >= 0 ? -Math.PI / 2 : Math.PI / 2;
  const head = start + Math.PI * L.u;
  strokeRunner(ctx, 0, 0, r * 0.8, Math.max(start, head - 0.9), head, r * 0.4, 32, L.level);
};

// Sepulchre: shafts of reliquary light fan out from the rose window.
const reliquaryRays: RockPainter = (ctx, a, L) => {
  const R = a.radius;
  const rays = 10;
  const spin = L.u * 0.6;
  const half = 0.06;
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.clip();
  ctx.fillStyle = `hsla(285, 80%, 80%, ${(0.22 * L.level).toFixed(3)})`;
  ctx.beginPath();
  for (let k = 0; k < rays; k++) {
    const ang = (k / rays) * TAU + spin;
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R * (0.4 + 0.6 * L.u), ang - half, ang + half);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
  drawGlow(ctx, 0, 0, R * 0.3, 285, 0.5 * L.level);
  ctx.globalAlpha = 1;
};

// Pallbearer: its lamp tolls a single ring outward.
const tollRing: RockPainter = (ctx, a, L) => {
  strokeRing(ctx, a.radius * (0.3 + 0.9 * L.u), "285, 70%, 85%", 0.55 * L.level, 1.5);
};

const ROCK_PAINTERS: Partial<Record<AsteroidKind, RockPainter>> = {
  normal: membraneRipple,
  chime: chimeRings,
  asteroidWithGem: gatherToGem,
  solidCrystal: facetGlints,
  solidCrystalSmall: facetGlints,
  burstGemMedium: treasureGleam,
  burstGemBig: treasureGleam,
  bassA: moduleScan,
  bassB: moduleScan,
  bassC: moduleScan,
  bassD: moduleScan,
  citadel: sonarPing,
  warble: sonarPing,
  bell: candlelight,
  cathedralKeystone: candlelight,
  columnDrum: candlelight,
  rubbleBlock: candlelight,
  glassShard: prismaticLight,
  glassPrison: prisonBars,
  bigGlassPrison: prisonBars,
  wraith: ghostRipple,
  torus: ringRunners,
  torusArc: arcRunner,
  torusChunk: arcRunner,
  metalChunk: metalStreak,
  metalShard: metalStreak,
  superBassCrystal: squareClose,
  boss: fireIris,
  bossEye: fireIris,
  bossEmber: fireIris,
  bossHemisphere: magmaSurge,
  bossPlate: plateEmbers,
  bossIrisShard: crescentEmber,
  sepulchre: reliquaryRays,
  pallbearer: tollRing,
};

const paintRock = (ctx: CanvasRenderingContext2D, a: Asteroid, L: BeatLight) => {
  if (isBeatShieldKind(a.kind)) return;
  const painter = ROCK_PAINTERS[a.kind];
  if (!painter) return;
  ctx.save();
  ctx.translate(a.pos.x, a.pos.y);
  ctx.rotate(a.rotation);
  ctx.globalCompositeOperation = "lighter";
  painter(ctx, a, L);
  ctx.restore();
};

// ---------------------------------------------------------------- other bodies

// Comet: a bead of light runs up the tail and reaches the head on the beat, which flares.
const paintComet = (ctx: CanvasRenderingContext2D, c: Comet, L: BeatLight) => {
  const b = c.brightness();
  if (b <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const trail = c.trail;
  if (L.s < 0 && trail.length > 1) {
    const f = (trail.length - 1) * (1 - L.u * 2);
    const i = Math.min(trail.length - 2, Math.floor(f));
    const k = f - i;
    const p = trail[i].pos, q = trail[i + 1].pos;
    const x = p.x + (q.x - p.x) * k, y = p.y + (q.y - p.y) * k;
    drawGlow(ctx, x, y, 9 * c.scale, c.hue, (0.35 + 0.65 * L.u * 2) * b);
  }
  if (L.s >= 0) {
    drawGlow(ctx, c.pos.x, c.pos.y, Comet.HIT_RADIUS * 3 * c.scale, c.hue, 0.9 * L.level * b);
    drawGlow(ctx, c.pos.x, c.pos.y, Comet.HIT_RADIUS * 1.2 * c.scale, 0, 0.8 * L.level * b, true);
  }
  ctx.restore();
};

// Manta: the chevron ribs light in turn from tail to nose — a wingbeat of light.
const paintAlien = (ctx: CanvasRenderingContext2D, al: Alien, L: BeatLight) => {
  const ribs = al.shape.ribs;
  if (ribs.length === 0) return;
  const r = al.radius;
  let minX = Infinity, maxX = -Infinity;
  for (const rib of ribs) { minX = Math.min(minX, rib.mid.x); maxX = Math.max(maxX, rib.mid.x); }
  const front = minX - 0.25 + (maxX - minX + 0.5) * L.u;
  ctx.save();
  ctx.translate(al.pos.x, al.pos.y);
  ctx.rotate(al.rotation);
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const rib of ribs) {
    const m = Math.max(0, 1 - Math.abs(rib.mid.x - front) / 0.45) * L.level;
    if (m <= 0.01) continue;
    for (const side of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(rib.start.x * r, side * rib.start.y * r);
      ctx.lineTo(rib.mid.x * r, side * rib.mid.y * r);
      ctx.lineTo(rib.end.x * r, side * rib.end.y * r);
      ctx.strokeStyle = `hsla(${al.hue + 20}, 100%, 65%, ${(0.4 * m).toFixed(3)})`;
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = `hsla(${al.hue + 30}, 100%, 88%, ${Math.min(1, m).toFixed(3)})`;
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
  }
  const cockpit = al.shape.cockpit.vertices;
  let cx = 0, cy = 0;
  for (const p of cockpit) { cx += p.x; cy += p.y; }
  cx = (cx / cockpit.length) * r;
  cy = (cy / cockpit.length) * r;
  if (L.s >= 0) drawGlow(ctx, cx, cy, r * 0.35, al.hue + 30, 0.7 * L.level);
  ctx.restore();
};

// Wireframe octahedra (powerup pods, fuel cells): a plane of light passes through the
// lattice back to front, lighting each edge in the cell's own colour as it crosses —
// coloured rather than white, since a pod's white frame and bloom would swallow white.
const paintLattice = (
  ctx: CanvasRenderingContext2D, pos: Vec, radius: number, rot: { rotX: number; rotY: number; rotZ: number },
  hue: number, sat: number, L: BeatLight,
) => {
  const r = radius * 1.05;
  const verts = projectOctahedron(rot.rotX, rot.rotY, rot.rotZ, r);
  const front = r * (-1.3 + 2.6 * L.u);
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const [i, j] of OCTAHEDRON_EDGES) {
    const va = verts[i], vb = verts[j];
    const m = Math.max(0, 1 - Math.abs((va.z + vb.z) / 2 - front) / (r * 0.32)) * L.level;
    if (m <= 0.01) continue;
    ctx.beginPath();
    ctx.moveTo(va.x, va.y);
    ctx.lineTo(vb.x, vb.y);
    ctx.strokeStyle = `hsla(${hue}, ${sat}%, 75%, ${(0.2 * m).toFixed(3)})`;
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = `hsla(${hue}, ${sat * 0.6}%, 97%, ${(0.85 * m).toFixed(3)})`;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  ctx.restore();
};

// Gem: gold surges along its polished veins as a band of light crosses it.
const paintGem = (ctx: CanvasRenderingContext2D, g: Gem, L: BeatLight) => {
  const R = g.radius;
  const n = Math.PI / 4 - g.rot;
  const center = L.s * R * 1.3;
  ctx.save();
  ctx.translate(g.pos.x, g.pos.y);
  ctx.rotate(g.rot);
  ctx.globalCompositeOperation = "lighter";
  clipBand(ctx, n, center, R * 0.35, R * 1.6);
  g.paintVeins(ctx, L.level);
  g.paintVeins(ctx, L.level);
  fillBandGlow(ctx, n, center, R * 0.35, R * 1.6, "46, 100%, 70%", 0.25 * L.level);
  ctx.restore();
};

// Debris shard: its edges catch the beat as a brief bright trace.
const paintShard = (ctx: CanvasRenderingContext2D, sh: Shard, L: BeatLight) => {
  const life = sh.life / sh.maxLife;
  if (life <= 0) return;
  ctx.save();
  ctx.translate(sh.pos.x, sh.pos.y);
  ctx.rotate(sh.rotation);
  ctx.globalCompositeOperation = "lighter";
  ctx.beginPath();
  sh.vertices.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
  ctx.closePath();
  ctx.strokeStyle = `hsla(${sh.hue + 15}, 100%, 92%, ${(0.8 * L.level * life * life).toFixed(3)})`;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.restore();
};

export type BeatLitBody = Asteroid | Comet | Alien | Canister | FuelOrb | Gem | Shard;

// Paints `body`'s wave for the current clock (set once per frame with setBeatLightClock).
export const paintBeatLight = (ctx: CanvasRenderingContext2D, body: BeatLitBody) => {
  if (clock === null) return;
  const L = beatLightAt(clock);
  if (!L || L.level <= 0.03) return;
  if (body instanceof Asteroid) paintRock(ctx, body, L);
  else if (body instanceof Comet) paintComet(ctx, body, L);
  else if (body instanceof Alien) paintAlien(ctx, body, L);
  else if (body instanceof Canister) { if (!body.warping) paintLattice(ctx, body.pos, body.radius, body, body.hue, 100, L); }
  else if (body instanceof FuelOrb) paintLattice(ctx, body.pos, body.radius, body, body.hue, 95, L);
  else if (body instanceof Gem) paintGem(ctx, body, L);
  else if (body instanceof Shard) paintShard(ctx, body, L);
};
