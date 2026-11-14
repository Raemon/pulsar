// node --import tsx --test scripts/check-acquisition-gameplay.mjs
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import test from "node:test";
import { installHeadlessStubs, makeCanvas, makeStub } from "./headless-stubs.mjs";

test("a first-time pilot qualifies through real play, including a later run after an abort", async () => {
  const dims = { w: 1920, h: 1080, dpr: 1 };
  installHeadlessStubs(dims);
  const { Game } = await import("../src/Game.ts");
  const { initAcquisition } = await import("../src/game/acquisitionEvents.ts");
  const { requestStart, showTitle, togglePause, abortMission, startGame, unfreezeIntroWorld } = await import("../src/game/lifecycle.ts");
  const { applyHitToCombo } = await import("../src/game/killEffects.ts");
  const game = new Game(makeCanvas(dims.w, dims.h));
  game.sound = makeStub();
  const accepted = [];
  let online = false;
  globalThis.fetch = async (url, options) => {
    if (url !== "/api/acquisition") throw Error("Unrelated request in offline test");
    if (!online) throw Error("offline");
    accepted.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };
  initAcquisition();
  requestStart(game);
  await settle();
  assert.equal(game.calibrationIntro, true);
  assert.equal(game.acquisitionRun, null);
  window.dispatchEvent(new CustomEvent("beat-calibrator:done", { detail: { offsetSec: 0, origin: "intro" } }));
  unfreezeIntroWorld(game);
  unfreezeIntroWorld(game);
  const firstRun = game.acquisitionRun.id;
  game.beatCombo = 10;
  applyHitToCombo(game, true, game.ship.pos);
  game.update(1 / 60);
  assert.equal(game.acquisitionRun.reached12, false);
  game.beatCombo = 11;
  applyHitToCombo(game, true, game.ship.pos);
  game.update(1 / 60);
  game.update(1 / 60);
  togglePause(game);
  togglePause(game);
  togglePause(game);
  abortMission(game);
  assert.equal(game.state, "gameover");
  assert.equal(game.acquisitionRun, null);
  showTitle(game);
  requestStart(game);
  await settle();
  unfreezeIntroWorld(game);
  const secondRun = game.acquisitionRun.id;
  assert.notEqual(firstRun, secondRun);
  game.state = "dying";
  game.lives = 0;
  game.dyingTimer = 0;
  game.update(1 / 60);
  assert.equal(game.state, "gameover");

  // Replay construction calls startGame again, including on backward seeks.
  startGame(game, { seed: 123, recorder: false, beatOffset: 0, veteran: true, tutorial: false });
  game.maxCombo = 25;
  game.update(1 / 60);
  assert.equal(game.acquisitionRun, null);
  await settle();
  assert.equal(accepted.length, 0);
  online = true;
  window.dispatchEvent(new Event("online"));
  await settle();
  assert.deepEqual(accepted.map(event => [event.type, event.runId]), [
    ["visit", undefined],
    ["run_started", firstRun], ["rhythm_12", firstRun],
    ["run_started", secondRun], ["run_completed", secondRun],
  ]);
  assert.equal(new Set(accepted.map(event => event.playerId)).size, 1);
});

test("reload retries the original unacknowledged run and milestone", async () => {
  installHeadlessStubs({ w: 800, h: 450, dpr: 1 });
  const entries = new Map();
  window.localStorage = globalThis.localStorage = {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
  const first = await import("../src/game/acquisitionEvents.ts?page=first");
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response("temporarily unavailable", { status: 503 });
  };
  first.initAcquisition();
  const run = first.startAcquisitionRun();
  first.recordAcquisitionRhythm(run, 13);
  await settle();
  assert.equal(requests.length, 1);
  const stored = [...entries.values()].map(value => JSON.parse(value)).filter(event => event.runId === run.id);
  assert.equal(stored.length, 2);

  const next = await import("../src/game/acquisitionEvents.ts?page=next");
  const recovered = [];
  globalThis.fetch = async (_url, options) => {
    recovered.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  };
  next.initAcquisition();
  await settle();
  assert.deepEqual(recovered.filter(event => event.runId), stored);
  assert.equal([...entries.keys()].some(key => key.startsWith("pulsar.acquisition.pending.")), false);
});
