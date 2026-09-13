import type { Game } from "../Game";
import { resetAimHint } from "./aimHint";
import { Ship } from "../Ship";
import { ParticleSystem } from "../Particle";
import { v } from "../vec";
import { AsteroidKind, AsteroidSize, spawnBossAt, BASS_KINDS } from "../Asteroid";
import { spawnSepulchreEncounter } from "./sepulchre";
import { AlienSize } from "../Alien";
import { PowerupKind, POWERUP_KINDS, spawnCanister } from "../Canister";
import { syncHud, syncPowerupHud } from "./hud";
import { stopParade } from "./killedParade";
import { hideWaveSummary } from "./waveSummary";
import { newWaveEventSchedule } from "./waveEvents";
import {
  alignBassBeat,
  spawnAlien,
  spawnAsteroidAway,
  spawnComet,
  updateBgBeatIntensity,
} from "./waveDirector";
import { startShockwave } from "./shockwave";
import { FIRST_BONUS_LIFE_SCORE } from "./bonusLife";
import { SLOW_MO_DURATION } from "./slowMo";

// beta panel exposes every spawnable + powerup so a tester can dial in any combination
//   for a one-off wave, bypassing the normal random wave director.
type BetaElement = {
  id: string;
  label: string;
  group: "Asteroid" | "Special Rock" | "Hazard" | "Enemy" | "Pickup" | "Powerup";
  // each element knows how to apply itself; the start handler just iterates selected ones.
  apply: (game: Game) => void;
};

// Route through the wave-director helper so beta-panel spawns behave like
// wave spawns (ship-relative edge entry + staged entrance).
const spawnAsteroid = (game: Game, kind: AsteroidKind = "normal", size?: AsteroidSize) => {
  const a = spawnAsteroidAway(game, kind, size);
  if (a.isBass()) alignBassBeat(game, a);
  if (a.isBass() && (a.size === "medium" || a.size === "small")) {
    game.sound.startBassteroidDrone(a, kind as "bassA" | "bassB" | "bassC" | "bassD", a.size, a.pos);
  }
  game.asteroids.push(a);
};

const applyPowerup = (game: Game, kind: PowerupKind) => {
  if (kind === "prong") game.ship.prongCount += 1;
  else if (kind === "rapid") game.ship.rapidActive = true;
  else if (kind === "pierce") game.ship.pierceActive = true;
  else if (kind === "shield") game.ship.shieldActive = true;
  else if (kind === "radar") game.ship.radarActive = true;
  else if (kind === "longshot") game.ship.longshotActive = true;
  else if (kind === "sideEngines") game.ship.sideEnginesActive = true;
  else if (kind === "lasershot") game.ship.lasershotActive = true;
  else if (kind === "bomb") game.ship.bombActive = true;
  else if (kind === "slow") game.slowMoTimer = SLOW_MO_DURATION;
};

// Each registry below is keyed by the canonical union type, so adding a new
//   AsteroidKind / PowerupKind / AlienSize forces a compile error here until it
//   is classified — that is what keeps the palette exhaustive automatically.
// A tile can only name a kind that still exists in its union, so a deleted kind
//   can never linger as a ghost tile. Powerups additionally render only the
//   POWERUP_KINDS drop pool, dropping retired-but-still-coded kinds.

type AsteroidTile = { label: string; group: "Asteroid" | "Special Rock"; size?: AsteroidSize };
// null = fragment/child kind (boss parts, bell debris, glassPrison spawn) that
//   only exists as the byproduct of another kind, so it gets no standalone tile.
const ASTEROID_TILES: Record<AsteroidKind, AsteroidTile | null> = {
  normal: { label: "Asteroid", group: "Asteroid" },
  bassA: { label: "Bass A", group: "Special Rock" },
  bassB: { label: "Bass B", group: "Special Rock" },
  bassC: { label: "Bass C", group: "Special Rock" },
  bassD: { label: "Bass D", group: "Special Rock" },
  chime: { label: "Chime", group: "Special Rock" },
  bell: { label: "Bell", group: "Special Rock" },
  warble: { label: "Warble", group: "Special Rock" },
  citadel: { label: "Citadel", group: "Special Rock" },
  asteroidWithGem: { label: "Gold Rock", group: "Special Rock" },
  burstGemMedium: { label: "Burst Gem", group: "Special Rock" },
  burstGemBig: { label: "Burst Gem (big)", group: "Special Rock" },
  solidCrystal: { label: "Crystal", group: "Special Rock", size: "medium" },
  solidCrystalSmall: { label: "Crystal (sm)", group: "Special Rock", size: "small" },
  glassPrison: { label: "Glass Prison", group: "Special Rock" },
  bigGlassPrison: { label: "Big Prison", group: "Special Rock" },
  metalChunk: { label: "Metal Chunk", group: "Special Rock", size: "medium" },
  metalShard: null,
  torus: { label: "Torus Ring", group: "Special Rock" },
  torusArc: null,
  torusChunk: null,
  boss: null,
  bossHemisphere: null,
  bossEye: null,
  bossPlate: null,
  bossIrisShard: null,
  bossEmber: null,
  wraith: null,
  cathedralKeystone: null,
  glassShard: null,
  columnDrum: null,
  rubbleBlock: null,
  sepulchre: null,
  pallbearer: null,
};

// Labels for every powerup the type allows; the palette only renders the ones
//   in POWERUP_KINDS (the live drop pool), so a retired powerup (rapid/pierce,
//   kept in the type for their still-wired effects) drops out automatically.
const POWERUP_LABELS: Record<PowerupKind, string> = {
  prong: "Prong",
  rapid: "Rapid Fire",
  pierce: "Pierce",
  shield: "Shield",
  slow: "Slow-Mo",
  radar: "Radar",
  longshot: "Farshot",
  sideEngines: "Side Engines",
  lasershot: "Laser",
  bomb: "Bomb",
};

const ALIEN_TILES: Record<AlienSize, string> = {
  small: "Alien (S)",
  medium: "Alien (M)",
  big: "Alien (L)",
};

const asteroidElements: BetaElement[] = (Object.keys(ASTEROID_TILES) as AsteroidKind[])
  .map((kind): BetaElement | null => {
    const tile = ASTEROID_TILES[kind];
    if (!tile) return null;
    return { id: kind, label: tile.label, group: tile.group, apply: (g: Game) => spawnAsteroid(g, kind, tile.size) };
  })
  .filter((e): e is BetaElement => e !== null);

const powerupElements: BetaElement[] = POWERUP_KINDS.map((kind) => ({
  id: kind,
  label: POWERUP_LABELS[kind],
  group: "Powerup",
  apply: (g: Game) => applyPowerup(g, kind),
}));

const alienElements: BetaElement[] = (Object.keys(ALIEN_TILES) as AlienSize[]).map((size) => ({
  id: "alien" + size[0].toUpperCase() + size.slice(1),
  label: ALIEN_TILES[size],
  group: "Enemy",
  apply: (g: Game) => spawnAlien(g, size),
}));

const ELEMENTS: BetaElement[] = [
  ...asteroidElements,
  {
    id: "boss",
    label: "Boss",
    group: "Enemy",
    apply: (g) => {
      const pos = g.pulsar.bossBodyPos(1);
      g.pulsar.setBossPlanetState("active", 1);
      g.asteroids.push(spawnBossAt(pos, g.w, g.h));
    },
  },
  {
    id: "sepulchre",
    label: "Sepulchre",
    group: "Enemy",
    apply: (g) => {
      const pos = g.pulsar.bossBodyPos(2);
      g.pulsar.setBossPlanetState("active", 2);
      const encounter = spawnSepulchreEncounter(g, pos);
      // The panel exists to put a combination on the field now; a minute of
      // dormant approach before the tomb is even damageable defeats that.
      for (const piece of encounter) piece.bossPhase = "live";
      g.asteroids.push(...encounter);
    },
  },
  { id: "comet", label: "Comet", group: "Hazard", apply: (g) => spawnComet(g) },
  { id: "shockwave", label: "Shockwave", group: "Hazard", apply: (g) => startShockwave(g) },
  ...alienElements,
  {
    id: "canister",
    label: "Powerup Pod",
    group: "Pickup",
    apply: (g) => {
      const c = spawnCanister(g.w, g.h, g.ship.pos);
      g.canisters.push(c);
      g.sound.play("canisterAppear", 1, c.pos);
    },
  },
  ...powerupElements,
];

const GROUP_ORDER: BetaElement["group"][] = [
  "Asteroid",
  "Special Rock",
  "Hazard",
  "Enemy",
  "Pickup",
  "Powerup",
];

let panelEl: HTMLDivElement | null = null;
const selected = new Set<string>();

const buildPanel = (game: Game) => {
  const panel = document.createElement("div");
  panel.id = "beta-panel";
  panel.className = "hidden";

  const title = document.createElement("h2");
  title.textContent = "Beta Test";
  panel.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "beta-sub";
  sub.innerHTML = 'click tiles to select &nbsp;·&nbsp; <span class="key">esc</span> close &nbsp;·&nbsp; <span class="key">⌘B</span> toggle';
  panel.appendChild(sub);

  for (const group of GROUP_ORDER) {
    const groupEls = ELEMENTS.filter((e) => e.group === group);
    if (groupEls.length === 0) continue;
    const groupWrap = document.createElement("div");
    groupWrap.className = "beta-group";
    const groupTitle = document.createElement("div");
    groupTitle.className = "beta-group-title";
    groupTitle.textContent = group;
    groupWrap.appendChild(groupTitle);
    const grid = document.createElement("div");
    grid.className = "beta-grid";
    for (const el of groupEls) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "beta-tile";
      tile.dataset.id = el.id;
      tile.innerHTML = `<div class="beta-icon">${iconFor(el.id)}</div><div class="beta-label">${el.label}</div>`;
      tile.addEventListener("click", () => toggleTile(el.id, tile));
      grid.appendChild(tile);
    }
    groupWrap.appendChild(grid);
    panel.appendChild(groupWrap);
  }

  const actions = document.createElement("div");
  actions.className = "beta-actions";
  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.id = "beta-start";
  startBtn.textContent = "Start";
  startBtn.addEventListener("click", () => startBetaWave(game));
  actions.appendChild(startBtn);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.id = "beta-close";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => closePanel());
  actions.appendChild(closeBtn);
  panel.appendChild(actions);

  document.body.appendChild(panel);
  return panel;
};

// lightweight SVG glyphs keep the panel readable without pulling per-element render code.
const iconFor = (id: string): string => {
  const c = "currentColor";
  if (id === "normal") {
    return `<svg viewBox="0 0 24 24"><polygon points="12,3 20,8 19,17 12,21 5,17 4,8" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  }
  if (id === "bassA" || id === "bassB" || id === "bassC" || id === "bassD") {
    return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="${c}" stroke-width="1.5"/><text x="12" y="15" text-anchor="middle" font-size="8" fill="${c}" font-family="sans-serif" font-weight="bold">${id.slice(-1)}</text></svg>`;
  }
  if (id === "chime") return `<svg viewBox="0 0 24 24"><path d="M8 4 L8 14 a3 3 0 1 0 2 0 L10 5 z" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  if (id === "bell") return `<svg viewBox="0 0 24 24"><path d="M6 16 Q6 7 12 7 Q18 7 18 16 Z M10 18 a2 2 0 0 0 4 0" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  if (id === "warble") return `<svg viewBox="0 0 24 24"><path d="M3 12 Q6 4 9 12 T15 12 T21 12" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  if (id === "asteroidWithGem") return `<svg viewBox="0 0 24 24"><polygon points="12,3 20,8 19,17 12,21 5,17 4,8" fill="none" stroke="${c}" stroke-width="1.5"/><polygon points="12,8 15,11 14,16 12,17 10,16 9,11" fill="${c}" opacity="0.6"/></svg>`;
  if (id === "burstGemMedium" || id === "burstGemBig") return `<svg viewBox="0 0 24 24"><polygon points="12,2 19,9 12,22 5,9" fill="${c}" opacity="0.35" stroke="${c}" stroke-width="1.5"/><path d="M5,9 L19,9 M12,2 L12,22" stroke="${c}" stroke-width="0.8" opacity="0.6"/></svg>`;
  if (id === "solidCrystal") return `<svg viewBox="0 0 24 24"><polygon points="12,3 19,8 17,16 12,21 7,16 5,8" fill="${c}" opacity="0.35" stroke="${c}" stroke-width="1.5"/><path d="M12,3 L12,21 M5,8 L19,8 M7,16 L17,16" stroke="${c}" stroke-width="0.8" opacity="0.5"/></svg>`;
  if (id === "solidCrystalSmall") return `<svg viewBox="0 0 24 24"><polygon points="12,7 17,10 16,16 12,19 8,16 7,10" fill="${c}" opacity="0.35" stroke="${c}" stroke-width="1.4"/></svg>`;
  if (id === "glassPrison") return `<svg viewBox="0 0 24 24"><polygon points="12,2 20,12 12,22 4,12" fill="${c}" opacity="0.18" stroke="${c}" stroke-width="1.5"/><path d="M9 9 L9 15 M12 8 L12 16 M15 9 L15 15" stroke="${c}" stroke-width="1.2" opacity="0.8"/></svg>`;
  if (id === "bigGlassPrison") return `<svg viewBox="0 0 24 24"><polygon points="12,1 23,12 12,23 1,12" fill="${c}" opacity="0.18" stroke="${c}" stroke-width="1.5"/><path d="M7 10 L7 14 M10 8 L10 16 M14 8 L14 16 M17 10 L17 14" stroke="${c}" stroke-width="1.2" opacity="0.8"/></svg>`;
  if (id === "boss") return `<svg viewBox="0 0 24 24"><polygon points="12,2 22,9 18,21 6,21 2,9" fill="none" stroke="${c}" stroke-width="1.7"/><circle cx="12" cy="13" r="3" fill="${c}"/></svg>`;
  if (id === "comet") return `<svg viewBox="0 0 24 24"><circle cx="17" cy="7" r="3" fill="${c}"/><path d="M14 10 L4 20" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>`;
  if (id === "shockwave") return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="12" cy="12" r="7" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.6"/><circle cx="12" cy="12" r="11" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.3"/></svg>`;
  if (id === "alienSmall") return `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="13" rx="5" ry="2" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M9 11 Q12 8 15 11" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  if (id === "alienMedium") return `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="14" rx="7" ry="2.5" fill="none" stroke="${c}" stroke-width="1.5"/><path d="M8 12 Q12 7 16 12" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  if (id === "alienBig") return `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="15" rx="9" ry="3" fill="none" stroke="${c}" stroke-width="1.7"/><path d="M6 13 Q12 5 18 13" fill="none" stroke="${c}" stroke-width="1.7"/></svg>`;
  if (id === "canister") return `<svg viewBox="0 0 24 24"><polygon points="12,3 21,12 12,21 3,12" fill="none" stroke="${c}" stroke-width="1.5"/><text x="12" y="15" text-anchor="middle" font-size="9" fill="${c}" font-family="sans-serif" font-weight="bold">?</text></svg>`;
  if (id === "prong") return `<svg viewBox="0 0 24 24"><path d="M7 4 L7 11 L9 13 M17 4 L17 11 L15 13 M9 13 L15 13 M12 13 L12 21 M9 19 L15 19" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (id === "rapid") return `<svg viewBox="0 0 24 24"><path d="M4 12 L10 12 M6 7 L12 12 L6 17 M12 7 L18 12 L12 17 M18 7 L20 9" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (id === "pierce") return `<svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="2.5" fill="none" stroke="${c}" stroke-width="1.7"/><circle cx="16" cy="12" r="2.5" fill="none" stroke="${c}" stroke-width="1.7"/><path d="M2 12 L22 12 M19 9 L22 12 L19 15" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (id === "shield") return `<svg viewBox="0 0 24 24"><path d="M12 3 L20 6 L20 12 Q20 17 12 21 Q4 17 4 12 L4 6 Z" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (id === "slow") return `<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7" fill="none" stroke="${c}" stroke-width="1.7"/><path d="M12 13 L12 8 M12 13 L16 15 M9 3 L15 3 M12 3 L12 6" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
  if (id === "radar") return `<svg viewBox="0 0 24 24"><path d="M12 21 L3 6 L21 6 Z" fill="none" stroke="${c}" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="21" r="1.4" fill="${c}"/></svg>`;
  if (id === "longshot") return `<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2" fill="none" stroke="${c}" stroke-width="1.7"/><circle cx="18" cy="12" r="2" fill="none" stroke="${c}" stroke-width="1.7"/><path d="M3 12 L21 12 M18 9 L21 12 L18 15" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (id === "sideEngines") return `<svg viewBox="0 0 24 24"><path d="M12 4 L8 10 L12 8 L16 10 Z" fill="none" stroke="${c}" stroke-width="1.7" stroke-linejoin="round"/><path d="M2 12 L8 12 M22 12 L16 12 M5 9 L2 12 L5 15 M19 9 L22 12 L19 15" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (id === "lasershot") return `<svg viewBox="0 0 24 24"><path d="M3 12 L21 12" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/><path d="M3 12 L21 12" stroke="${c}" stroke-width="1" stroke-linecap="round" opacity="0.5"/><path d="M18 7 L21 12 L18 17" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (id === "bomb") return `<svg viewBox="0 0 24 24"><circle cx="11" cy="14" r="7" fill="none" stroke="${c}" stroke-width="1.7"/><path d="M15 8 L18 5 M18 5 L21 3 M18 5 L20 7" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/></svg>`;
  return "";
};

const toggleTile = (id: string, tile: HTMLElement) => {
  if (selected.has(id)) {
    selected.delete(id);
    tile.classList.remove("selected");
  } else {
    selected.add(id);
    tile.classList.add("selected");
  }
};

const openPanel = (game: Game) => {
  if (!panelEl) panelEl = buildPanel(game);
  panelEl.classList.remove("hidden");
};

const closePanel = () => {
  if (panelEl) panelEl.classList.add("hidden");
};

const isOpen = (): boolean => !!panelEl && !panelEl.classList.contains("hidden");

// Like startGame but skips spawnWave — applies only the selected elements
// so the run shows exactly what was chosen.
const startBetaWave = (game: Game) => {
  game.sound.resume();
  // Reset run state
  game.score = 0;
  game.wave = 1;
  game.lives = 3;
  game.nextBonusLifeScore = FIRST_BONUS_LIFE_SCORE;
  game.beatTime = 0;
  game.lastBeatResnapAt = game.beatTime;
  game.beatPhaseCorrection = 0;
  game.lastBgBeatIndex = -1;
  // A summary/transition in flight when the beta panel launches is keyed to
  //   the old beatTime — left alone it would stall, then fire a rogue spawn
  //   deep into the beta run once the fresh clock catches up to its slots.
  hideWaveSummary(game);
  game.waveTransitioning = false;
  game.waveTransition = null;
  game.beatCues = [];
  game.nextBeatToEvaluate = 0;
  game.beatCombo = 0;
  game.maxCombo = 0;
  game.maxComboThisWave = 0;
  game.firedOffBeatSinceLastBeat = false;
  game.slowMoTimer = 0;
  game.hasLostComboEver = false;
  game.rhythmLossHintPending = false;
  resetAimHint(game);

  game.bullets = [];
  game.popups = [];
  game.bassLightnings = [];
  game.shards = [];
  game.canisters = [];
  game.fuelOrbs = [];
  game.killedSnapshots = [];
  game.killTally = {};
  game.aliens = [];
  game.alienBullets = [];
  game.asteroids = [];
  stopParade(game);
  game.killedRowEl.classList.add("hidden");
  game.sound.stopAllAlienDrones();
  game.sound.stopAllBassteroidDrones();
  game.sound.stopAllWarbleDrones();
  game.sound.stopAllCometShimmers();
  game.sound.stopHaloAmbient();
  game.comets = [];
  game.waveEvents = newWaveEventSchedule();

  // Beta spawns explicit kinds, but keep bassOrder valid for any peekers.
  game.bassOrder = BASS_KINDS.slice();
  game.particles = new ParticleSystem();
  game.ship = new Ship(v(game.w / 2, game.h / 2));
  game.ship.invuln = 2.0;
  game.pulsar.setBossPlanetState("idle");
  game.pulsar.setWaveLevel(game.wave);
  updateBgBeatIntensity(game);

  game.betaMode = true;
  game.state = "playing";
  game.overlayEl.classList.add("hidden");

  // Apply after reset so spawn helpers see the fresh ship.
  for (const id of selected) {
    const el = ELEMENTS.find((e) => e.id === id);
    if (el) el.apply(game);
  }

  syncHud(game);
  syncPowerupHud(game);
  closePanel();
};

// Cmd/Ctrl-B toggles the panel. preventDefault so the browser doesn't
// eat it (Cmd-B bolds text in some inputs).
export const installBetaTest = (game: Game) => {
  window.addEventListener("keydown", (e) => {
    const isToggle = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b";
    if (isToggle) {
      e.preventDefault();
      if (isOpen()) closePanel();
      else openPanel(game);
      return;
    }
    if (isOpen() && e.key === "Escape") {
      e.preventDefault();
      closePanel();
    }
  });
};
