// Sprite preview gallery (/sprites) — every drawable body in the game, laid
// out on one page and rendered live.
//
// The point of this page is to look at art without playing the game: you get
// each entity at true scale, at any zoom, tumbling or held still, with the
// collision surface overlaid — and you get it in a second, instead of hunting
// for one rare rock through a run.
//
// SILENT BY CONSTRUCTION. Nothing here imports Game or Sound, so no
// AudioContext is ever created and no bake is ever triggered. Entities are
// built and drawn directly; keep it that way — if you find yourself needing
// something out of Game to preview a body, lift that state onto the entity
// rather than booting the engine here.
import { Asteroid, AsteroidKind, AsteroidSize } from "../Asteroid";
import { Alien, AlienSize } from "../Alien";
import { Canister, PowerupKind } from "../Canister";
import { Gem } from "../Gem";
import { Ship } from "../Ship";
import { renderShipBody } from "../ship/shipRender";
import { seedRng } from "../game/rng";
import { TAU } from "../vec";

// One previewable body: how to build it, and how to draw it at the origin.
// `radius` is only used to pick a sensible default zoom for the cell.
type Subject = {
  group: string;
  label: string;
  radius: number;
  // t is milliseconds, matching every render(ctx, t) in the game.
  draw: (ctx: CanvasRenderingContext2D, t: number) => void;
  // Local-space collision surface, when the body has one worth overlaying.
  surfaceAt?: (angle: number) => number;
  // Held so the toolbar can drive per-frame state (tumble, phase).
  tick?: (dt: number, opts: ViewOptions) => void;
};

type ViewOptions = {
  zoom: number;
  tumble: boolean;
  hitbox: boolean;
  phase: boolean;
};

// ---------------------------------------------------------------- catalogue

// Sizes worth showing per kind. Most kinds ladder through the standard four;
// the fixed-radius specials (citadel, boss parts, torus fragments) only ever
// exist at one, so showing four copies of the same sprite would be noise.
const ALL_SIZES: AsteroidSize[] = ["huge", "large", "medium", "small"];
const SIZES_FOR: Partial<Record<AsteroidKind, AsteroidSize[]>> = {
  citadel: ["large"],
  boss: ["huge"],
  bossHemisphere: ["medium"],
  bossEye: ["medium"],
  bossPlate: ["small"],
  bossIrisShard: ["small"],
  bossEmber: ["small"],
  wraith: ["medium"],
  glassPrison: ["large"],
  bigGlassPrison: ["large"],
  solidCrystalSmall: ["small"],
  burstGemMedium: ["medium"],
  burstGemBig: ["large"],
  metalChunk: ["medium"],
  metalShard: ["small"],
  torus: ["large"],
  cathedralKeystone: ["small"],
  glassShard: ["small"],
  columnDrum: ["small"],
  rubbleBlock: ["small"],
  sepulchre: ["large"],
  pallbearer: ["medium"],
};

// Grouped so the page reads as a contact sheet of the game's material families
// rather than one flat wall of rocks.
const ASTEROID_GROUPS: { group: string; kinds: AsteroidKind[] }[] = [
  { group: "Rock", kinds: ["normal", "asteroidWithGem", "solidCrystal", "solidCrystalSmall"] },
  { group: "Bassteroid", kinds: ["bassA", "bassB", "bassC", "bassD"] },
  { group: "Phased", kinds: ["citadel", "warble"] },
  { group: "Cathedral", kinds: ["bell", "cathedralKeystone", "glassShard", "columnDrum", "rubbleBlock", "chime"] },
  { group: "Treasure", kinds: ["burstGemMedium", "burstGemBig"] },
  { group: "Prison", kinds: ["glassPrison", "bigGlassPrison", "wraith"] },
  { group: "Torus", kinds: ["torus"] },
  { group: "Metal", kinds: ["metalChunk", "metalShard"] },
  { group: "Boss", kinds: ["boss", "bossHemisphere", "bossEye", "bossPlate", "bossIrisShard", "bossEmber"] },
  { group: "Sepulchre", kinds: ["sepulchre", "pallbearer"] },
];

const POWERUPS: PowerupKind[] = ["prong", "shield", "slow", "radar", "longshot", "sideEngines", "lasershot", "bomb"];

const makeAsteroid = (group: string, kind: AsteroidKind, size: AsteroidSize): Subject => {
  const a = new Asteroid({ x: 0, y: 0 }, { x: 0, y: 0 }, size, undefined, kind);
  a.pos = { x: 0, y: 0 };
  a.rotation = 0;
  // A fresh boss is born dormant — it would preview as the growing silhouette
  // of the reveal rather than the built body, so skip it to the live phase.
  if (a.hasRevealPhase()) a.bossPhase = "live";
  // A shuttered tomb previews as a blank wall; show it mid-open so the rose
  // window and the reliquary behind it are both legible on the sheet.
  if (a.isSepulchre()) a.shutterOpen = 0.6;
  return {
    group,
    label: `${kind} · ${size}`,
    radius: a.radius,
    draw: (ctx, t) => a.render(ctx, t),
    surfaceAt: (angle) => a.radiusAtAngle(angle),
    tick: (dt, opts) => {
      if (opts.tumble) a.rotation += a.rotSpeed * dt;
      // The phased kinds spend half their cycle ghosting out; drive that here
      // so the preview shows the blurred body too, not only the crisp bake.
      if (a.kind === "warble" || a.kind === "citadel") {
        const cycle = opts.phase ? (Math.sin(performance.now() / 1400) + 1) / 2 : 1;
        a.warbleOpacity = 0.35 + 0.65 * cycle;
        a.warbleSolid = a.warbleOpacity > 0.6;
      }
    },
  };
};

// Ring fragments only have a shape once they belong to a TorusGroup — arc span,
// bend radius and hitbox all come from the break, not the constructor. So we
// break a real ring and preview the actual children, drawn back at the origin
// (they live out on the phantom ring, not at their own centre).
const torusFragments = (): Subject[] => {
  const ring = new Asteroid({ x: 0, y: 0 }, { x: 0, y: 0 }, "large", undefined, "torus");
  return ring.split().map((frag) => ({
    group: "Torus",
    label: `${frag.kind} · off the ring`,
    radius: frag.radius,
    draw: (ctx: CanvasRenderingContext2D, t: number) => {
      ctx.save();
      ctx.translate(-frag.pos.x, -frag.pos.y);
      frag.render(ctx, t);
      ctx.restore();
    },
  }));
};

const buildCatalogue = (): Subject[] => {
  const out: Subject[] = [];
  for (const { group, kinds } of ASTEROID_GROUPS) {
    for (const kind of kinds) {
      for (const size of SIZES_FOR[kind] ?? ALL_SIZES) {
        try {
          out.push(makeAsteroid(group, kind, size));
        } catch (err) {
          // A fragment kind that needs state it only gets from its parent
          // (torus arcs need a ring group) still earns a labelled cell.
          out.push(brokenCell(group, `${kind} · ${size}`, err));
        }
      }
    }
  }

  try {
    out.push(...torusFragments());
  } catch (err) {
    out.push(brokenCell("Torus", "ring fragments", err));
  }

  const ship = new Ship({ x: 0, y: 0 });
  ship.heading = -Math.PI / 2;
  out.push({
    group: "Ship",
    label: "ship",
    radius: ship.hitRadius,
    draw: (ctx, t) => renderShipBody(ctx, ship, t, 0),
    surfaceAt: (angle) => ship.hitDistanceToward(angle),
  });
  out.push({
    group: "Ship",
    label: "ship · thrusting",
    radius: ship.hitRadius,
    draw: (ctx, t) => {
      ship.thrustOn = true;
      renderShipBody(ctx, ship, t, 1);
      ship.thrustOn = false;
    },
  });

  for (const size of ["big", "medium", "small"] as AlienSize[]) {
    try {
      const alien = new Alien({ x: 0, y: 0 }, { x: 0, y: 0 }, size);
      alien.pos = { x: 0, y: 0 };
      out.push({ group: "Alien", label: `alien · ${size}`, radius: alien.radius, draw: (ctx, t) => alien.render(ctx, t) });
    } catch (err) {
      out.push(brokenCell("Alien", `alien · ${size}`, err));
    }
  }

  for (const kind of POWERUPS) {
    try {
      const can = new Canister({ x: 0, y: 0 }, { x: 0, y: 0 }, kind, 1e6);
      can.pos = { x: 0, y: 0 };
      out.push({ group: "Pickup", label: `pod · ${kind}`, radius: can.radius, draw: (ctx, t) => can.render(ctx, t) });
    } catch (err) {
      out.push(brokenCell("Pickup", `pod · ${kind}`, err));
    }
  }

  const gem = new Gem({ x: 0, y: 0 }, { x: 0, y: 0 });
  gem.pos = { x: 0, y: 0 };
  out.push({ group: "Pickup", label: "gem", radius: gem.radius, draw: (ctx, t) => gem.render(ctx, t) });

  return out;
};

// A cell for a body that couldn't be built standalone — better than silently
// dropping it, since "this kind needs a parent" is itself useful to see.
const brokenCell = (group: string, label: string, err: unknown): Subject => ({
  group,
  label: `${label} — ${err instanceof Error ? err.message : String(err)}`,
  radius: 30,
  draw: (ctx) => {
    ctx.strokeStyle = "#c25";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-14, -14);
    ctx.lineTo(14, 14);
    ctx.moveTo(14, -14);
    ctx.lineTo(-14, 14);
    ctx.stroke();
  },
});

// -------------------------------------------------------------------- page

const CELL = 190;

const style = `
  :root { color-scheme: dark; }
  body {
    margin: 0; background: #06080c; color: #9fb4c8;
    font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  header {
    position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap;
    align-items: center; gap: 18px; padding: 12px 18px;
    background: rgba(6, 8, 12, 0.94); border-bottom: 1px solid #16202c;
    backdrop-filter: blur(6px);
  }
  h1 { font-size: 13px; font-weight: 600; letter-spacing: 0.18em; margin: 0; color: #cfe3f5; }
  .note { color: #4e6479; }
  label { display: flex; align-items: center; gap: 6px; user-select: none; }
  input[type="range"] { width: 110px; }
  input[type="search"] {
    background: #0c1219; border: 1px solid #1d2b3a; color: #cfe3f5;
    padding: 4px 8px; border-radius: 4px; font: inherit; width: 160px;
  }
  button {
    background: #0c1219; border: 1px solid #1d2b3a; color: #cfe3f5;
    padding: 4px 10px; border-radius: 4px; font: inherit; cursor: pointer;
  }
  button:hover { border-color: #2f4a63; }
  h2 {
    grid-column: 1 / -1; margin: 22px 0 2px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.22em; color: #5f7d99; text-transform: uppercase;
  }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(${CELL}px, 1fr)); gap: 10px; padding: 14px 18px 60px; }
  figure { margin: 0; border: 1px solid #121b25; border-radius: 6px; background: #080b10; overflow: hidden; }
  figure canvas { display: block; width: 100%; height: ${CELL}px; }
  figcaption { padding: 5px 7px; border-top: 1px solid #121b25; color: #7e94a8; word-break: break-word; }
  .hidden { display: none; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), props);

const start = () => {
  document.head.append(el("style", { textContent: style }));
  const root = document.getElementById("sprites-root")!;

  const opts: ViewOptions = { zoom: 1, tumble: true, hitbox: false, phase: true };

  const header = el("header");
  const zoomInput = el("input", { type: "range", min: "0.5", max: "6", step: "0.1", value: "1" });
  const filterInput = el("input", { type: "search", placeholder: "filter…" });
  const tumbleInput = el("input", { type: "checkbox", checked: true });
  const hitboxInput = el("input", { type: "checkbox" });
  const phaseInput = el("input", { type: "checkbox", checked: true });
  const reseed = el("button", { textContent: "reroll shapes" });
  const zoomOut = el("span", { textContent: "1.0×" });

  const labelled = (text: string, control: HTMLElement) => {
    const l = el("label");
    l.append(control, document.createTextNode(text));
    return l;
  };
  header.append(
    el("h1", { textContent: "PULSAR SPRITES" }),
    el("span", { className: "note", textContent: "live render · no audio" }),
    labelled("", zoomInput),
    zoomOut,
    labelled("tumble", tumbleInput),
    labelled("hitbox", hitboxInput),
    labelled("phase", phaseInput),
    filterInput,
    reseed,
  );

  const grid = el("main");
  root.append(header, grid);

  // Every cell shares one rAF loop — 100+ independent loops would spend more
  // time in scheduling than in drawing.
  let cells: { fig: HTMLElement; canvas: HTMLCanvasElement; subject: Subject }[] = [];
  let headings: { el: HTMLElement; group: string }[] = [];

  const build = () => {
    grid.textContent = "";
    cells = [];
    headings = [];
    // Stable group-by so a family appended out of order (the ring fragments
    // have to be built after their parent) still lands under one heading.
    const built = buildCatalogue();
    const order = [...new Set(built.map((s) => s.group))];
    const subjects = order.flatMap((g) => built.filter((s) => s.group === g));
    let group = "";
    for (const subject of subjects) {
      if (subject.group !== group) {
        group = subject.group;
        const h = el("h2", { textContent: group });
        headings.push({ el: h, group });
        grid.append(h);
      }
      const fig = el("figure");
      const canvas = el("canvas");
      const dpr = window.devicePixelRatio || 1;
      canvas.width = CELL * dpr;
      canvas.height = CELL * dpr;
      const caption = el("figcaption", { textContent: subject.label });
      fig.append(canvas, caption);
      grid.append(fig);
      cells.push({ fig, canvas, subject });
    }
    applyFilter();
  };

  // Matches on the group name too, so "boss" or "cathedral" pulls a whole
  // family; a group whose every cell filtered out drops its heading with them.
  const applyFilter = () => {
    const q = filterInput.value.trim().toLowerCase();
    const matches = (s: Subject) => q === "" || `${s.group} ${s.label}`.toLowerCase().includes(q);
    for (const c of cells) c.fig.classList.toggle("hidden", !matches(c.subject));
    for (const h of headings) {
      h.el.classList.toggle("hidden", !cells.some((c) => c.subject.group === h.group && matches(c.subject)));
    }
  };

  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const dpr = window.devicePixelRatio || 1;
    for (const { fig, canvas, subject } of cells) {
      if (fig.classList.contains("hidden")) continue;
      const ctx = canvas.getContext("2d")!;
      subject.tick?.(dt, opts);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(CELL / 2, CELL / 2);
      // Fit the body to the cell, then apply the toolbar zoom on top, so a
      // 16px shard and a 140px citadel are both legible at 1×.
      const fit = (CELL * 0.4) / Math.max(12, subject.radius);
      ctx.scale(fit * opts.zoom, fit * opts.zoom);
      try {
        subject.draw(ctx, now);
      } catch {
        // A body that throws mid-render shouldn't take the whole page down.
      }
      if (opts.hitbox && subject.surfaceAt) {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(90,170,255,0.75)";
        ctx.lineWidth = 1 / (fit * opts.zoom);
        ctx.beginPath();
        for (let i = 0; i <= 120; i++) {
          const angle = (i / 120) * TAU;
          const r = subject.surfaceAt(angle);
          const x = Math.cos(angle) * r;
          const y = Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    requestAnimationFrame(frame);
  };

  zoomInput.oninput = () => {
    opts.zoom = Number(zoomInput.value);
    zoomOut.textContent = `${opts.zoom.toFixed(1)}×`;
  };
  tumbleInput.onchange = () => { opts.tumble = tumbleInput.checked; };
  hitboxInput.onchange = () => { opts.hitbox = hitboxInput.checked; };
  phaseInput.onchange = () => { opts.phase = phaseInput.checked; };
  filterInput.oninput = applyFilter;
  // Shapes are seeded draws, so a reroll is just a fresh seed + rebuild — the
  // fastest way to check that a silhouette holds up across the whole roll.
  reseed.onclick = () => {
    seedRng((Math.random() * 0x100000000) >>> 0);
    build();
  };

  build();
  requestAnimationFrame(frame);
};

start();
