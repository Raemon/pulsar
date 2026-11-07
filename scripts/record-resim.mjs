// Closed-loop determinism test on the CURRENT working tree — no DB, no browser,
//   no stale recordings. It:
//     1. boots a real Game headless with a recorder,
//     2. drives it with a scripted, deterministic input pattern for N frames
//        (fixed dt) while it captures a replay,
//     3. serialises that replay,
//     4. re-sims it (startReplay → precompute sweep asserts every checkpoint).
//   If the re-sim diverges from the recording it just produced, the CURRENT code
//   has a record-vs-replay determinism leak — with a 100%-reproducible repro you
//   fully control (vary SEED / FRAMES / input pattern). If it's clean, the sim is
//   deterministic in the audio-free regime and any DB-replay divergence needs the
//   audio/beat-resnap path to manifest.
//
// Usage:
//   node scripts/record-resim.mjs                 # default seed, 4000 frames
//   SEED=12345 FRAMES=8000 node scripts/record-resim.mjs
//   node scripts/record-resim.mjs --save out.json # also write the payload JSON
//
// Runs under tsx (re-execs itself) so it can import the game's .ts sources.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

if (!process.env.__RESIM_UNDER_TSX) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, __RESIM_UNDER_TSX: "1" } },
  );
  process.exit(r.status ?? 1);
}

const DIMS = { w: 1920, h: 1080, dpr: 2 };
const SEED = Number(process.env.SEED ?? 0x1234abcd) >>> 0;
const FRAMES = Number(process.env.FRAMES ?? 4000);
const DT = 1 / 60; // fixed-step; faithfully recorded + replayed

const { installHeadlessStubs, makeCanvas } = await import("./headless-stubs.mjs");
const { windowStub } = installHeadlessStubs(DIMS);

// Force startGame's seed: with no overrides it draws runSeed from
//   crypto.getRandomValues, so pin that to SEED for a reproducible run.
const fixedCrypto = {
  getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = SEED >>> 0; return arr; },
  randomUUID: () => "00000000-0000-0000-0000-000000000000",
};
try { globalThis.crypto = fixedCrypto; }
catch { Object.defineProperty(globalThis, "crypto", { value: fixedCrypto, configurable: true }); }

const { Game } = await import("../src/Game.ts");
const { startGame, startReplay } = await import("../src/game/lifecycle.ts");

// ---------------------------------------------------------------------------
// Synthetic input: a deterministic IInput we mutate per frame. Mirrors the
//   Input class's keys/justPressed surface so the recorder + gameUpdate read it
//   exactly like live keyboard input.
// ---------------------------------------------------------------------------
class ScriptedInput {
  keys = new Set();
  justPressed = new Set();
  down(k) { return this.keys.has(k.toLowerCase()); }
  pressed(k) { return this.justPressed.has(k.toLowerCase()); }
  endFrame() { this.justPressed.clear(); }
  set(k, on) {
    const key = k.toLowerCase();
    if (on) { if (!this.keys.has(key)) this.justPressed.add(key); this.keys.add(key); }
    else this.keys.delete(key);
  }
}

const TAU = Math.PI * 2;
const wrapDelta = (d, span) => (d > span / 2 ? d - span : d < -span / 2 ? d + span : d);

const nearestAsteroid = (game) => {
  const ship = game.ship;
  let nearest = null;
  for (const a of game.asteroids) {
    const dx = wrapDelta(a.pos.x - ship.pos.x, game.w);
    const dy = wrapDelta(a.pos.y - ship.pos.y, game.h);
    const dist = Math.hypot(dx, dy);
    if (!nearest || dist < nearest.dist) nearest = { dx, dy, dist };
  }
  return nearest;
};

const driveInput = (input, f, game) => {
  const idle = () => { for (const k of ["arrowleft", "arrowright", "arrowup", "arrowdown", " "]) input.set(k, false); };
  if (!game.ship) return idle();
  const target = nearestAsteroid(game);
  if (!target) return idle();
  let diff = Math.atan2(target.dy, target.dx) - game.ship.heading;
  while (diff > Math.PI) diff -= TAU;
  while (diff < -Math.PI) diff += TAU;
  const aimed = Math.abs(diff) < 0.12;
  input.set("arrowleft", !aimed && diff < 0);
  input.set("arrowright", !aimed && diff > 0);
  input.set("arrowup", aimed && target.dist > 700 && f % 4 < 2);
  input.set("arrowdown", target.dist < 220);
  input.set(" ", aimed && f % 6 === 0);
};

const game = new Game(makeCanvas(DIMS.w, DIMS.h));
// localInput is what startGame assigns to game.input; swap in our scripted one.
const scripted = new ScriptedInput();
game.localInput = scripted;

startGame(game, undefined); // no overrides → fresh run, recorder created, wave 1
game.input = scripted;       // startGame set game.input = game.localInput already, but be explicit
// startGame leaves intro flags clear, so advanceFrame → updatePlaying runs directly.
// Hold our own recorder handle: a game-over mid-run calls finalizeRecorder, which
//   nulls game.recorder — but the recorder object (with all captured frames) lives
//   on, so we can still build its payload and re-sim the partial run.
const recorder = game.recorder;
if (!recorder) { console.error("no recorder on the game — startGame override path?"); process.exit(2); }

// Per-frame fine-state capture so we can diff RECORD vs REPLAY at single-frame /
//   sub-pixel resolution (checkpoints only sample counts every 60 frames).
const snap = (g) => ({
  blt: g.bullets.length, ast: g.asteroids.length, sc: g.score, lives: g.lives, cmb: g.beatCombo,
  bt: g.beatTime, pbt: g.perceivedBeatTime,
  shipX: g.ship?.pos.x, shipY: g.ship?.pos.y, vx: g.ship?.vel.x, vy: g.ship?.vel.y, hd: g.ship?.heading,
  bx: g.bullets[0]?.pos.x, by: g.bullets[0]?.pos.y, blife: g.bullets[0]?.life,
});
const recSnaps = [];

// Drive the live recording. game.update(dt) routes (no replayPlayer) to
//   advanceFrame → updatePlaying, which captures the frame + checkpoints.
let aliveFrames = 0;
for (let f = 0; f < FRAMES; f++) {
  driveInput(scripted, f, game);
  game.update(DT);
  recSnaps.push(snap(game));
  // game.render() is intentionally NOT called — render runs live but not in the
  //   muted re-sim, so skipping it here keeps the cosmetic-stream draw count
  //   symmetric with the re-sim (the whole point of the determinism contract).
  if (game.state === "playing" || game.state === "dying" || game.state === "replaying") aliveFrames++;
  else if (game.state === "gameover") break; // ship died out — stop recording
}

const summary = {
  score: game.score, wave: game.wave, maxCombo: game.maxCombo,
  killCount: Object.values(game.killTally ?? {}).reduce((s, n) => s + n, 0),
};
const payload = recorder.buildPayload(summary);

console.log(`\n=== closed-loop record→resim (current working tree) ===`);
console.log(`  seed=${SEED} framesDriven=${FRAMES} captured=${payload.frames.length} dt=${DT.toFixed(5)}s`);
console.log(`  final: score=${summary.score} wave=${game.wave} lives=${game.lives} state=${game.state}`);
console.log(`  checkpoints=${(payload.checkpoints ?? []).length} beatResnaps=${(payload.beatResnaps ?? []).length}\n`);

const saveIdx = process.argv.indexOf("--save");
if (saveIdx >= 0) {
  payload.header.startedAt = 0;
  writeFileSync(process.argv[saveIdx + 1], JSON.stringify(payload));
  console.log(`  wrote payload → ${process.argv[saveIdx + 1]}\n`);
}

// ---- re-sim the freshly-recorded payload, stepping frame-by-frame ----
const { encodeReplay } = await import("../src/game/replayFormat.ts");
const { __stepReplayFrameForTest } = await import("../src/game/gameUpdate.ts");
const bytes = await encodeReplay(payload);
// Fresh Game for the replay so no live state leaks across. startReplay seeds the
//   world, runs the precompute sweep (asserts checkpoints), and rewinds to frame 0.
const game2 = new Game(makeCanvas(DIMS.w, DIMS.h));
await startReplay(game2, bytes);

const divs = windowStub.__replayDivergences ?? game2.replayPlayer?.divergences ?? [];

// Frame-by-frame fine diff: the replay world is at frame 0 after startReplay; step
//   it and compare each frame's fine-state to the recording's. Catches the exact
//   frame a position/bullet first drifts — long before a 60-frame checkpoint flips.
const approx = (a, b, eps = 1e-6) => a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= eps);
const diffFields = (r, p) => {
  const out = [];
  for (const k of ["blt", "ast", "sc", "lives", "cmb"]) if (r[k] !== p[k]) out.push(`${k}:rec ${r[k]}≠rep ${p[k]}`);
  for (const k of ["bt", "pbt", "shipX", "shipY", "vx", "vy", "hd", "bx", "by", "blife"]) if (!approx(r[k], p[k])) out.push(`${k}:Δ${((p[k] ?? NaN) - (r[k] ?? NaN)).toExponential(2)}`);
  return out;
};
let fineFirst = null;
{
  const player = game2.replayPlayer;
  while (player && player.position() < recSnaps.length) {
    const i = player.position();
    const more = __stepReplayFrameForTest(game2);
    const d = diffFields(recSnaps[i], snap(game2));
    if (d.length) { fineFirst = { frame: i, fields: d, rec: recSnaps[i], rep: snap(game2) }; break; }
    if (!more) break;
  }
}

if (!divs.length && !fineFirst) {
  console.log("RESULT: ✅ CLEAN — the re-sim reproduced the freshly-recorded run exactly");
  console.log("        (checkpoints AND per-frame fine-state). Current code is deterministic");
  console.log("        in the audio-free regime.\n");
  process.exit(0);
}

console.log(`RESULT: ❌ CURRENT-CODE determinism leak — ${divs.length} divergent checkpoint(s).`);
if (fineFirst) {
  console.log(`\nEARLIEST per-frame divergence — frame ${fineFirst.frame} (${(fineFirst.frame * DT).toFixed(2)}s in):`);
  console.log(`    diffs: ${fineFirst.fields.join("  ")}`);
  console.log(`    recorded:`, fineFirst.rec);
  console.log(`    replayed:`, fineFirst.rep);
}
if (divs.length) {
  const f0 = divs[0];
  console.log(`\nFirst CHECKPOINT divergence — frame ${f0.frame}: ${f0.fields.map((x) => `${x.field}(rec ${x.recorded}→rep ${x.replayed})`).join(", ")}`);
}
console.log();
process.exit(1);
