// Trailer choreography engine, injected into the running game page.
//
// The ship is scripted, not driven by keys: it drifts at a constant velocity,
// eases its heading between aim keyframes (smootherstep, so every turn starts
// and lands gently), and gives a short forward nudge along its new heading to
// match the drift of the rock it is about to shoot. Shots fire on exact beats.
//
// Rocks are placed by back-solving: a dry run fires the same shots into an
// empty field and records where each bullet is on its hit beat; each target is
// then spawned so its edge meets that bullet exactly on the beat, drifting at
// the velocity the ship matched — so the drift-lock ring holds while they
// travel together. A validation pass reports hits, combo, drift tiers and the
// ship's clearance from every body.
import { startGame } from "/src/game/lifecycle.ts";
import { markVeteranPilot, spawnWave, spawnComet, spawnAlien, alignBassBeat, updateBgBeatIntensity } from "/src/game/waveDirector.ts";
import { renderGame } from "/src/game/gameRender.ts";
import { CaptureAudioContext, ExportClock, encodeWavBlob } from "/src/game/audioCapture.ts";
import { Asteroid, spawnBossAt } from "/src/Asteroid.ts";
import { bulletCollisionRadius } from "/src/Bullet.ts";
import { stageEntrance } from "/src/game/entrance.ts";

const DT = 1 / 60;
const TAU = Math.PI * 2;
const W = 1920, H = 1080;
const rad = (d) => (d * Math.PI) / 180;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
const smoother = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * t * (t * (t * 6 - 15) + 10); };
const fold = (p) => ({ x: ((p.x % W) + W) % W, y: ((p.y % H) + H) % H });
const tdelta = (a, b) => { let dx = a.x - b.x, dy = a.y - b.y; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W; if (dy > H / 2) dy -= H; if (dy < -H / 2) dy += H; return { x: dx, y: dy }; };

class ScriptInput {
  keys = new Set(); justPressed = new Set();
  down(k) { return this.keys.has(k); }
  pressed(k) { return this.justPressed.has(k); }
  endFrame() { this.justPressed.clear(); }
  set(k, on) { if (on) { if (!this.keys.has(k)) this.justPressed.add(k); this.keys.add(k); } else this.keys.delete(k); }
}

// ---- ship script ---------------------------------------------------------
// spec.ship = { vel:[vx,vy], heading: deg }
// spec.shots[i] = { t: fire beat time (s), h: heading deg, dv: nudge px/s,
//   lock: seconds of coast before the shot (drift-lock hold), fire: optional
//   explicit fire time offset (s, e.g. -0.08) for short-range shots }
// spec.moves = [{ t0, t1, h?, dv }] extra nudges (e.g. drifting into the citadel)
const NUDGE_ACCEL = 150;
const burnsOf = (s) => s.burns ? s.burns.map((b) => ({ dv: b.dv, acc: b.acc ?? 240, gap: b.gap ?? 0 }))
  : s.dv ? [{ dv: s.dv, acc: s.acc ?? NUDGE_ACCEL, gap: 0 }] : [];
const buildScript = (spec) => {
  const N = Math.round(spec.secs / DT) + 2;
  const keys = [];      // heading keyframes: {start, end, from, to}
  const nudges = [];    // {t0, t1, dir, accel}
  // Shots and free moves share one chronological heading timeline, so a turn
  //   always starts from wherever the previous one left the ship.
  const items = [
    ...(spec.shots ?? []).map((s) => ({ kind: "shot", s, at: s.t - (s.lock ?? 0.6) - burnsOf(s).reduce((a, b) => a + Math.abs(b.dv) / b.acc + b.gap, 0) })),
    ...(spec.moves ?? []).map((m) => ({ kind: "move", m, at: m.t1 ?? m.tn })),
  ].sort((x, y) => x.at - y.at);
  let h = rad(spec.ship.heading ?? 0);
  let prevEnd = -1;
  for (const it of items) {
    if (it.kind === "shot") {
      const s = it.s;
      const to = h + wrapA(rad(s.h) - h);
      const turnEnd = it.at;
      const want = Math.max(0.45, Math.abs(to - h) / (s.turnRate ?? 1.6));
      const turnStart = Math.max(prevEnd + 0.12, turnEnd - want, 0);
      if (Math.abs(to - h) > 1e-6) keys.push({ start: turnStart, end: Math.max(turnStart + 0.2, turnEnd), from: h, to });
      // burns along the new heading: forward (dv > 0) or retro brake (dv < 0), each followed by a coast
      let tb = turnEnd;
      for (const bn of burnsOf(s)) {
        const d = Math.abs(bn.dv) / bn.acc;
        nudges.push({ t0: tb, t1: tb + d, dir: to, accel: Math.sign(bn.dv) * bn.acc, reverse: bn.dv < 0 });
        tb += d + bn.gap;
      }
      h = to; prevEnd = s.t;
    } else {
      const m = it.m;
      if (m.h != null) { const to = h + wrapA(rad(m.h) - h); keys.push({ start: m.t0, end: m.t1, from: h, to }); h = to; prevEnd = Math.max(prevEnd, m.t1); }
      if (m.dv) { const t0 = m.tn ?? m.t1, acc = m.acc ?? NUDGE_ACCEL; nudges.push({ t0, t1: t0 + Math.abs(m.dv) / acc, dir: m.dir != null ? rad(m.dir) : h, accel: Math.sign(m.dv) * acc, reverse: m.dv < 0 }); prevEnd = Math.max(prevEnd, t0 + Math.abs(m.dv) / acc); }
    }
  }
  keys.sort((a, b) => a.start - b.start);
  const heading = new Float64Array(N), vx = new Float64Array(N), vy = new Float64Array(N), thrust = new Uint8Array(N);
  let cvx = spec.ship.vel[0], cvy = spec.ship.vel[1];
  let hk = rad(spec.ship.heading ?? 0);
  for (let f = 0; f < N; f++) {
    const t = f * DT;
    for (const k of keys) if (t >= k.start) hk = t >= k.end ? k.to : k.from + (k.to - k.from) * smoother((t - k.start) / (k.end - k.start));
    heading[f] = hk;
    for (const n of nudges) if (t >= n.t0 && t < n.t1) { cvx += Math.cos(n.dir) * n.accel * DT; cvy += Math.sin(n.dir) * n.accel * DT; thrust[f] = n.reverse ? 2 : 1; }
    vx[f] = cvx; vy[f] = cvy;
  }
  const fireFrames = new Map();
  (spec.shots ?? []).forEach((s, i) => fireFrames.set(Math.round((s.t + (s.fire ?? 0)) / DT) - 1, i));
  return { N, heading, vx, vy, thrust, fireFrames };
};

// ---- sandbox ---------------------------------------------------------------
const setup = (spec) => {
  markVeteranPilot();
  const game = window.__game;
  const sound = game.sound;
  sound.ensureContext();
  sound.audioBeatTimeFromMusic = () => null;
  sound.playPilotLog = async () => {};
  sound.startHaloMusic = async () => {};
  sound.crossfadeHaloMusic = async () => {};
  const realGRV = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = spec.seed >>> 0; return arr; };
  const input = new ScriptInput();
  game.localInput = input;
  startGame(game, undefined);
  crypto.getRandomValues = realGRV;
  game.input = input;
  if (spec.wave && spec.wave !== game.wave) { game.wave = spec.wave; game.pulsar.setWaveLevel(game.wave); updateBgBeatIntensity(game); spawnWave(game); }
  game.betaMode = true;
  game.waveEvents = { events: [] };
  sound.stopAllBassteroidDrones(); sound.stopAllAlienDrones(); sound.stopAllWarbleDrones(); sound.stopAllCometShimmers();
  game.asteroids = []; game.comets = []; game.aliens = []; game.canisters = []; game.gems = [];
  game.controlsHintActive = false; game.aimHintShown = true; game.hasShownDriftShotLabel = true; game.hasLostComboEver = true;
  try { localStorage.setItem("pulsar.driftLockHintSeen", "1"); } catch {}
  game.nextBonusLifeScore = 1e15;
  game.ship.pos = { x: W / 2, y: H / 2 };
  game.ship.vel = { x: spec.ship.vel[0], y: spec.ship.vel[1] };
  game.ship.heading = rad(spec.ship.heading ?? 0);
  game.ship.invuln = 0;
  for (const [k, v] of Object.entries(spec.powerups ?? {})) game.ship[k] = v;
  if (spec.combo) { game.beatCombo = spec.combo; game.maxCombo = spec.combo; }
  if (spec.betaMode === false) game.betaMode = false;
  // pin the pulsar where the shot wants it on frame 0 (it then rides its own parallax)
  // Render-only nudge of the sky (pulsar, its rings, planets): the boss hangs off
  // the same sky geometry, so moving the real offsets would move the fight too.
  {
    const p = game.pulsar, P = Object.getPrototypeOf(p);
    const [dx, dy] = spec.pulsar?.shift ?? [0, 0];
    for (const m of ["render", "renderShockwaveOverlay"]) {
      p[m] = function (ctx) { ctx.save(); ctx.translate(dx, dy); P[m].call(this, ctx); ctx.restore(); };
    }
    p.visualizerAnchor = function () { const a = P.visualizerAnchor.call(this); return { ...a, x: a.x + dx, y: a.y + dy }; };
  }
  if (spec.pulsar?.at) {
    const p = game.pulsar;
    if (spec.pulsar.wave) p.targetWaveLevel = spec.pulsar.wave;
    p.displayWaveLevel = p.targetWaveLevel;
    const k = 1 - Math.min(0.78, (p.displayWaveLevel - 1) * 0.06);
    p.baseOffsetX = (spec.pulsar.at[0] - game.w / 2) / k;
    p.baseOffsetY = (spec.pulsar.at[1] - game.h / 2) / k;
  }
  return { game, input };
};

const makeRock = (game, r) => {
  if (r.kind === "alien") {
    // a weaving alien placed relative to the ship, its first volley on a chosen beat
    spawnAlien(game, r.size ?? "medium");
    const a = game.aliens[game.aliens.length - 1];
    a.pos = fold({ x: game.ship.pos.x + r.rel[0], y: game.ship.pos.y + r.rel[1] });
    a.vel = { x: r.vel[0], y: r.vel[1] };
    a.entering = false; a.enterOffX = 0; a.enterOffY = 0;
    a.nextFireAt = r.fireAt;
    a.firePatternIndex = 0;
    a.__tag = r.tag;
    return a;
  }
  if (r.kind === "boss") {
    // the Act I planetoid materialises where it hangs in the sky
    const pos = game.pulsar.bossBodyPos(1);
    game.pulsar.setBossPlanetState("active", 1);
    const b = spawnBossAt(pos, game.w, game.h);
    if (r.revealLead != null && b.hasRevealPhase?.()) b.bossRevealT = b.revealTiming().total - r.revealLead;
    // already awake: skip the reveal (and its combo-zeroing eye-open) entirely
    if (r.live) { b.bossRevealT = b.revealTiming().total; b.bossPhase = "live"; }
    b.__tag = r.tag;
    game.asteroids.push(b);
    return b;
  }
  if (!r.pos && r.rel) r = { ...r, pos: [game.ship.pos.x + r.rel[0], game.ship.pos.y + r.rel[1]] };
  const a = new Asteroid(fold({ x: r.pos[0], y: r.pos[1] }), { x: r.vel[0], y: r.vel[1] }, r.size ?? "medium", r.hue, r.kind ?? "normal");
  if (r.rotation != null) a.rotation = rad(r.rotation);
  if (r.rotSpeed != null) a.rotSpeed = r.rotSpeed;
  if (r.warblePhaseOffset != null) a.warblePhaseOffset = r.warblePhaseOffset;
  game.asteroids.push(a);
  if (a.isBass?.()) {
    alignBassBeat(game, a);
    if (a.size === "medium" || a.size === "small") game.sound.startBassteroidDrone(a, a.kind, a.size, a.pos);
  }
  a.__tag = r.tag;
  return a;
};

// One pass of the scene. mode: "probe" (no targets, record bullets) | "run".
const runPass = async (spec, script, rocks, opts = {}) => {
  if (opts.preSetup) opts.preSetup();
  const { game, input } = setup(spec);
  for (const r of rocks) if (!(r.spawnAt > 0)) makeRock(game, r);
  if (spec.ship.fromBoss) {
    // start the ship clear of the boss's silhouette, at a set range and bearing from it
    const b = game.asteroids.find((a) => a.__tag === "boss");
    const [dist, deg] = spec.ship.fromBoss;
    game.ship.pos = fold({ x: b.pos.x + dist * Math.cos(rad(deg)), y: b.pos.y + dist * Math.sin(rad(deg)) });
  }
  const bodies = () => [...game.asteroids, ...game.comets, ...game.aliens];
  const rec = { bullets: {}, combo: [], events: [], clearance: Infinity, clearWho: null, tiers: [], ship: [] };
  const late = rocks.filter((r) => r.spawnAt > 0).sort((a, b) => a.spawnAt - b.spawnAt);
  const tracked = new Map(); // shot index -> bullet
  let prevCombo = game.beatCombo, prevBursts = 0;
  const events = [...(spec.events ?? [])].sort((a, b) => a.at - b.at);
  for (let f = 0; f < script.N - 2 && f < Math.round(spec.secs / DT); f++) {
    const t = f * DT;
    if (opts.onFrameStart) opts.onFrameStart(t);
    while (events.length && events[0].at <= t) {
      const e = events.shift();
      if (e.kind === "comet") { spawnComet(game); game.comets[game.comets.length - 1].__tag = e.tag ?? "comet"; }
      // fast-forward a phasing body's cycle while it is invisible (no visible jump)
      if (e.kind === "phaseJump") for (const a of game.asteroids) if (a.__tag === e.tag) a.warblePhaseOffset += e.add;
    }
    while (late.length && late[0].spawnAt <= t + 1e-9) {
      // enter from just off-screen, the way the game slides wave rocks in
      const r = late.shift();
      const a = makeRock(game, { ...r, pos: [0, 0] });
      a.pos = { x: game.ship.pos.x + r.rel[0], y: game.ship.pos.y + r.rel[1] };
      stageEntrance(game, a);
    }
    game.ship.heading = script.heading[f];
    game.ship.vel = { x: script.vx[f], y: script.vy[f] };
    input.set("arrowup", script.thrust[f] === 1);
    input.set("arrowdown", script.thrust[f] === 2);
    const shotIdx = script.fireFrames.get(f);
    input.set(" ", shotIdx !== undefined);
    const before = new Set(game.bullets);
    game.ship.invuln = 1e9;
    game.update(DT);
    game.ship.invuln = 0;
    game.ship.heading = script.heading[f + 1];
    game.ship.vel = { x: script.vx[f + 1], y: script.vy[f + 1] };
    game.popups = game.popups.filter((p) => p.text !== "RHYTHM LOST");
    if (shotIdx !== undefined) {
      const nb = game.bullets.filter((b) => !before.has(b));
      if (nb[0]) tracked.set(shotIdx, nb[0]);
      rec.events.push({ t: +t.toFixed(3), ev: "fire", shot: shotIdx, onBeat: nb[0]?.onBeat, bullets: nb.length, tier: nb[0]?.driftTierAtHit?.() ?? null });
    }
    for (const [i, b] of tracked) {
      const s = spec.shots[i];
      const hitF = Math.round((s.t + (s.hitBeats ?? 1) * 0.5) / DT) - 1;
      if (f === hitF) rec.bullets[i] = { x: b.pos.x, y: b.pos.y, vx: b.vel.x, vy: b.vel.y, alive: game.bullets.includes(b) };
    }
    if (game.beatCombo !== prevCombo) { rec.events.push({ t: +t.toFixed(3), ev: "combo", from: prevCombo, to: game.beatCombo }); prevCombo = game.beatCombo; }
    if ((game.driftBursts?.length ?? 0) > prevBursts) rec.events.push({ t: +t.toFixed(3), ev: "driftBurst", tier: game.driftBursts[game.driftBursts.length - 1].tier });
    prevBursts = game.driftBursts?.length ?? 0;
    if (game.bassLightnings?.length && !rec.events.some((e) => e.ev === "lightning" && Math.abs(e.t - t) < 0.3)) rec.events.push({ t: +t.toFixed(3), ev: "lightning" });
    // boss beams / plasma: record firings and any frame one would touch the ship
    if ((game.bossBeams?.length ?? 0) > (rec.nBeams ?? 0)) rec.events.push({ t: +t.toFixed(3), ev: "beam" });
    rec.nBeams = game.bossBeams?.length ?? 0;
    if ((game.alienBullets?.length ?? 0) > (rec.nBolts ?? 0)) rec.events.push({ t: +t.toFixed(3), ev: "bolt" });
    rec.nBolts = game.alienBullets?.length ?? 0;
    const judged = !spec.clearWindow || (t >= spec.clearWindow[0] && t <= spec.clearWindow[1]);
    for (const bm of game.bossBeams ?? []) if (judged && bm.hitsShip?.(game)) { rec.clearance = Math.min(rec.clearance, -100); rec.clearWho = { t: +t.toFixed(2), kind: "beam" }; }
    for (const ab of game.alienBullets ?? []) {
      const d = tdelta(ab.pos, game.ship.pos);
      const clear = Math.hypot(d.x, d.y) - (game.ship.hitRadius ?? 38) - 8;
      if (judged && clear < rec.clearance) { rec.clearance = clear; rec.clearWho = { t: +t.toFixed(2), kind: "bolt" }; }
    }
    for (const a of bodies()) {
      if (a.isPhasedOut?.() || (a.kind === "citadel" && a.citadelHoleContains?.(game.ship.pos.x, game.ship.pos.y))) continue;
      const d = tdelta(a.pos, game.ship.pos); const r = a.radius ?? 20;
      const clear = Math.hypot(d.x, d.y) - (1.3 * r + 38);
      if (judged && clear < rec.clearance) { rec.clearance = clear; rec.clearWho = { t: +t.toFixed(2), kind: a.kind, size: a.size, tag: a.__tag }; }
    }
    rec.ship.push({ x: game.ship.pos.x, y: game.ship.pos.y });
    for (const al of game.aliens) if (al.__tag && al.hp !== al.__lastHp) { if (al.__lastHp != null) rec.events.push({ t: +t.toFixed(3), ev: "alienHp", hp: al.hp }); al.__lastHp = al.hp; }
    if (rec.__alienAlive && !game.aliens.some((al) => al.__tag)) rec.events.push({ t: +t.toFixed(3), ev: "alienDead" });
    rec.__alienAlive = game.aliens.some((al) => al.__tag);
    if (spec.debugAlien && f % 3 === 0) for (const al of game.aliens) if (al.__tag) { const sd = tdelta(al.pos, game.ship.pos); const bd = game.bullets.map((b) => { const d = tdelta(b.pos, al.pos); return Math.round(Math.hypot(d.x, d.y)); }); rec.events.push({ t: +t.toFixed(2), ev: "dbg", shipDist: Math.round(Math.hypot(sd.x, sd.y)), bulletDist: bd, entering: al.entering, alive: al.alive }); }
    for (const al of [...game.aliens, ...game.comets]) if (al.__tag) { rec.track = rec.track ?? {}; (rec.track[al.__tag] = rec.track[al.__tag] ?? [])[f] = { x: al.pos.x, y: al.pos.y, r: al.radius ?? 48 }; }
    if (f % 15 === 0) rec.combo.push(game.beatCombo);
    if (f % 15 === 0) for (const c of game.comets) if (c.__tag) { const d = tdelta(c.pos, game.ship.pos); rec.cometDist = rec.cometDist ?? []; rec.cometDist.push(`${t.toFixed(2)}:${Math.round(Math.hypot(d.x, d.y))}@${Math.round(Math.atan2(d.y, d.x) * 180 / Math.PI)}`); }
    for (const a of game.asteroids) if (a.kind === "citadel") rec.citGhost = { x: a.pos.x, y: a.pos.y, vx: a.vel.x, vy: a.vel.y, rot: a.rotation, t };
    if (f % 15 === 0 && rec.citGhost) { const g = rec.citGhost, dt = t - g.t, dx = game.ship.pos.x - (g.x + g.vx * dt), dy = game.ship.pos.y - (g.y + g.vy * dt), c = Math.cos(-g.rot), s = Math.sin(-g.rot); rec.citOff = rec.citOff ?? []; rec.citOff.push(`${t.toFixed(2)}:${(dx * c - dy * s).toFixed(0)},${(dx * s + dy * c).toFixed(0)}`); }
    if (f % 15 === 0) for (const a of game.asteroids) if (a.kind === "citadel") { rec.cit = rec.cit ?? []; rec.cit.push(`${t.toFixed(2)}:${a.warbleSolid ? 'S' : 'o'}${a.citadelHoleContains(game.ship.pos.x, game.ship.pos.y) ? 'IN' : ''}`); }
    if (f % 6 === 0 && opts.hoverLog) { const r = game.ship.hoverDotRingStates?.[0]; rec.hover = rec.hover ?? []; rec.hover.push(`${t.toFixed(1)}:${r?.hoverStartBeatTime != null ? 'H' + (game.beatTime - r.hoverStartBeatTime).toFixed(1) : '-'}`); }
    if (opts.onFrame) await opts.onFrame(f, t, game);
  }
  return { rec, game };
};

// Back-solve target placement from the probe's bullet positions.
const placeTargets = (spec, probe) => {
  const out = [];
  spec.shots.forEach((s, i) => {
    if (s.target === "none" || s.existing) return;
    const b = probe.rec.bullets[i];
    if (!b) return;
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const dir = { x: b.vx / sp, y: b.vy / sp };
    const tmp = new Asteroid({ x: 0, y: 0 }, { x: 0, y: 0 }, s.size ?? "medium", undefined, s.kind ?? "normal");
    // the game's lock dot sits one on-beat bullet radius off the surface
    const reach = tmp.radius + bulletCollisionRadius({ onBeat: true, superBoosted: !!s.super }) + (s.depthAdj ?? 0);
    const tHit = s.t + (s.hitBeats ?? 1) * 0.5;
    const f = Math.round(s.t / DT);
    const m = [window.__script.vx[f + 2], window.__script.vy[f + 2]];
    const u = s.vel ?? (s.relVel ? [m[0] + s.relVel[0], m[1] + s.relVel[1]] : m);
    const c = { x: b.x + dir.x * reach, y: b.y + dir.y * reach };
    const rock = { tag: `shot${i}`, kind: s.kind ?? "normal", size: s.size ?? "medium", vel: u, pos: [c.x - u[0] * tHit, c.y - u[1] * tHit], hue: s.hue, rotation: s.rotation };
    if (spec.entrances && !s.atStart) {
      // walk back from the hit until the rock, relative to the ship, is just outside the view
      const sc = window.__script;
      const fh = Math.min(Math.round(tHit / DT), probe.rec.ship.length - 1);
      const d0 = tdelta(c, probe.rec.ship[fh]);
      let dx = d0.x, dy = d0.y, fs = 0;
      const mx = W / 2 / 1.15 + tmp.radius + 30, my = H / 2 / 1.15 + tmp.radius + 30;
      for (let g = fh; g > 0; g--) {
        dx -= (u[0] - sc.vx[g]) * DT; dy -= (u[1] - sc.vy[g]) * DT;
        if (Math.abs(dx) > mx || Math.abs(dy) > my) { fs = g; break; }
      }
      if (fs > 0) { rock.spawnAt = fs * DT; rock.rel = [dx, dy]; }
    }
    out.push(rock);
  });
  return out;
};

const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const settle = async () => { for (let i = 0; i < 32; i++) await undefined; };

const resolveMovingTargets = async (spec) => {
  const shots = spec.shots ?? [];
  for (let k = 0; k < shots.length; k++) {
    const s = shots[k];
    if (!s.target || s.target === "none") continue;
    const tmp = JSON.parse(JSON.stringify(spec));
    tmp.shots = shots.filter((x, i) => i < k || !x.target);
    const script = buildScript(tmp);
    window.__script = script;
    const probe = await runPass(tmp, script, [...(tmp.rocks ?? []), ...placeTargets(tmp, await runPass(tmp, script, tmp.rocks ?? []))]);
    const ff = Math.round((s.t + (s.fire ?? 0)) / DT) - 1;
    const hf = Math.round((s.t + (s.hitBeats ?? 1) * 0.5) / DT) - 1;
    const A = probe.rec.track?.[s.target]?.[hf];
    const S = probe.rec.ship[ff];
    if (!A || !S) continue;
    const d = tdelta(A, S); const dist = Math.hypot(d.x, d.y);
    const lead = (A.r + bulletCollisionRadius({ onBeat: true, superBoosted: !!s.super })) * (s.leadMul ?? 1);
    if (s.placeTarget && !s.__placed) {
      // slide the mover's whole path so it sits exactly one bullet-flight out at this hit
      const dtH = (hf - ff) * DT;
      const ox = 0.4 * script.vx[ff] * dtH, oy = 0.4 * script.vy[ff] * dtH;
      const ux = d.x - ox, uy = d.y - oy, un = Math.hypot(ux, uy) || 1;
      const reach = 26 + 620 * dtH + lead;
      const cx = ox + (ux / un) * reach, cy = oy + (uy / un) * reach;
      const rock = spec.rocks.find((r) => r.tag === s.target);
      rock.rel = [rock.rel[0] + (cx - d.x), rock.rel[1] + (cy - d.y)];
      s.__placed = true; k--; continue;
    }
    const tx = d.x - (d.x / dist) * lead, ty = d.y - (d.y / dist) * lead;
    const dtHit = (hf - ff) * DT;
    s.h = (Math.atan2(ty - 0.4 * script.vy[ff] * dtHit, tx - 0.4 * script.vx[ff] * dtHit) * 180) / Math.PI;
    s.existing = true;
  }
  return spec;
};

window.__choreo = async (spec, capture) => {
  await resolveMovingTargets(spec);
  const game = window.__game;
  const script = buildScript(spec);
  window.__script = script;
  game.sound.enabled = false;
  const probe = await runPass(spec, script, spec.rocks ?? []);
  const placed = placeTargets(spec, probe);
  const rocks = [...(spec.rocks ?? []), ...placed];
  const run = await runPass(spec, script, rocks, { hoverLog: true });
  game.sound.enabled = true;
  const report = { headings: spec.shots.map((x) => Math.round(x.h)), placed, probeFires: probe.rec.events.filter((e) => e.ev === "fire"), events: run.rec.events, combo: run.rec.combo, clearance: run.rec.clearance, clearWho: run.rec.clearWho, hover: run.rec.hover, cit: run.rec.cit, citOff: run.rec.citOff, cometDist: run.rec.cometDist };
  if (!capture) return report;

  // Capture: same pass, rendered and encoded, with offline game audio (SFX only).
  const sound = game.sound;
  await sound.prewarmForExport();
  const sr = sound.ctx.sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil((spec.secs + 1) * sr), sr);
  const clock = new ExportClock();
  let err = null, enc = null;
  const cap = await runPass(spec, script, rocks, {
    preSetup: () => {
      sound.beginExportCapture(new CaptureAudioContext(offline, clock));
      const play = sound.play.bind(sound);
      sound.play = (name, ...r) => (["comboLost", "comboLostFire", "bgBeat", "bgBeatLight"].includes(name) ? undefined : play(name, ...r));
      sound.playBgBeatAt = () => {}; sound.playBgBeatLightAt = () => {}; sound.playBgBeatLight = () => {};
      // the pulsar's spectrum ring hears the trailer's own soundtrack, frame by frame
      const S = window.__spectrum;
      if (S) sound.readSpectrum = () => S.subarray(Math.min(window.__specFrame, S.length / 512 - 1) * 512, Math.min(window.__specFrame, S.length / 512 - 1) * 512 + 512);
    },
    onFrameStart: (t) => {
      if (!enc) {
        enc = new VideoEncoder({ output: (chunk) => { const u = new Uint8Array(chunk.byteLength); chunk.copyTo(u); window.__sink("v", b64(u)); }, error: (e) => { err = e; } });
        enc.configure({ codec: "avc1.640028", width: game.canvas.width, height: game.canvas.height, bitrate: 16_000_000, framerate: 60, avc: { format: "annexb" } });
      }
      clock.advanceTo(t);
      window.__specFrame = Math.max(0, Math.round(t / DT));
    },
    onFrame: async (f, t) => {
      renderGame(game);
      const vf = new VideoFrame(game.canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(DT * 1e6) });
      enc.encode(vf, { keyFrame: f % 60 === 0 });
      vf.close();
      while (enc.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 0));
      await settle();
      if (f % 64 === 0) await new Promise((r) => setTimeout(r, 0));
      if (err) throw err;
    },
  });
  await enc.flush(); enc.close();
  sound.endExportCapture();
  const rendered = await offline.startRendering();
  window.__sink("a", b64(new Uint8Array(await encodeWavBlob(rendered).arrayBuffer())));
  report.capturedCombo = cap.rec.combo;
  report.capturedEvents = cap.rec.events;
  return report;
};

// Search small perturbations of shot headings / burn strengths for a variant
// where every shot is an on-beat kill at its required drift tier and nothing
// comes within `minClear` px of the ship's hit margin.
const evaluate = async (spec) => {
  await resolveMovingTargets(spec);
  const script = buildScript(spec);
  window.__script = script;
  const probe = await runPass(spec, script, spec.rocks ?? []);
  const rocks = [...(spec.rocks ?? []), ...placeTargets(spec, probe)];
  const run = await runPass(spec, script, rocks);
  const ev = run.rec.events;
  let ok = true;
  spec.shots.forEach((s, i) => {
    const fire = ev.find((e) => e.ev === "fire" && e.shot === i);
    if (!fire || !fire.onBeat || fire.bullets === 0) ok = false;
    if ((s.minTier ?? 0) > 0 && !((fire?.tier ?? 0) >= s.minTier)) ok = false;
    const hitT = s.t + (s.hitBeats ?? 1) * 0.5;
    if (!s.noKillCheck && !ev.some((e) => e.ev === "combo" && e.to > e.from && Math.abs(e.t - hitT) < 0.13)) ok = false;
    if (s.lightning && !ev.some((e) => e.ev === "lightning" && Math.abs(e.t - hitT) < 0.15)) ok = false;
  });
  if (ev.some((e) => e.ev === "combo" && e.to < e.from && !spec.allowDrop?.some((t) => Math.abs(t - e.t) < 0.3))) ok = false;
  return { ok, clearance: run.rec.clearance, clearWho: run.rec.clearWho };
};

window.__choreoSearch = async (spec, trials, minClear) => {
  const game = window.__game;
  game.sound.enabled = false;
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  let best = null;
  for (let i = 0; i < trials; i++) {
    const cand = JSON.parse(JSON.stringify(spec));
    let cost = 0;
    if (i > 0) cand.shots.forEach((s, k) => {
      if (s.fixed) return;
      const dh = Math.round(rnd() * (spec.jitterH ?? 30)), ddv = s.dv ? Math.round(rnd() * Math.abs(s.dv) * 0.3) : 0;
      if (k > 0 || spec.jitterFirst) s.h += dh;
      s.dv = (s.dv ?? 0) + ddv;
      if (!s.dv) delete s.dv;
      for (const bn of s.burns ?? []) { const d = Math.round(rnd() * Math.abs(bn.dv) * 0.3); bn.dv += d; cost += Math.abs(d) / 20; }
      cost += Math.abs(dh) / 10 + Math.abs(ddv) / 20;
    });
    const r = await evaluate(cand);
    const good = r.ok && r.clearance >= minClear;
    window.__stats = window.__stats ?? { ok: 0, bestClearOk: -1e9, who: null };
    if (r.ok) { window.__stats.ok++; if (r.clearance > window.__stats.bestClearOk) { window.__stats.bestClearOk = r.clearance; window.__stats.who = r.clearWho; } }
    if (good && (!best || cost < best.cost)) best = { cost, spec: cand, clearance: r.clearance };
    if (good && cost === 0) break;
  }
  game.sound.enabled = true;
  return best;
};
