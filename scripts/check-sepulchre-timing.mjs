import assert from "node:assert/strict";
import { test } from "node:test";
import { installHeadlessStubs, makeCanvas } from "./headless-stubs.mjs";

installHeadlessStubs({ w: 1920, h: 1080, dpr: 1 });
const { Game } = await import("../src/Game.ts");
const { spawnSepulchreEncounter, tickSepulchre } = await import("../src/game/sepulchre.ts");
const { tickBassBeats } = await import("../src/game/bassClock.ts");
const { ENTITY_CONFIG } = await import("../src/game/entityConfig.ts");

const encounter = () => {
  const game = new Game(makeCanvas(1920, 1080));
  game.asteroids = spawnSepulchreEncounter(game, { x: 960, y: 540 });
  return game;
};

const step = (game, dt) => {
  tickBassBeats(game, dt);
  for (const piece of game.asteroids) piece.update(dt, game.w, game.h);
  tickSepulchre(game, dt);
};

const assertSlots = (bearers) => {
  for (const bearer of bearers) {
    assert.equal(bearer.nextBeatAt % 2, bearer.bearerBeat * 0.5,
      `bearer ${bearer.bearerBeat} must retain its measure slot`);
  }
};

test("the real dormant approach wakes bearers on four distinct beat slots", () => {
  const game = encounter();
  const frames = Math.ceil(ENTITY_CONFIG.sepulchre.revealDuration * 60) + 1;
  for (let i = 0; i < frames; i++) step(game, 1 / 60);
  assert.ok(game.asteroids.every((piece) => piece.bossPhase === "live"));
  assertSlots(game.asteroids.slice(1));
  for (let i = 0; i < 600; i++) step(game, 1 / 60);
  assertSlots(game.asteroids.slice(1));
});

test("a bearer's own elapsed time cannot wake it ahead of the tomb", () => {
  const game = encounter();
  const bearer = game.asteroids[1];
  bearer.update(ENTITY_CONFIG.boss.revealDuration + 1, game.w, game.h);
  tickSepulchre(game, 0);
  assert.equal(bearer.bossPhase, "dormant");
  assert.equal(game.alienBullets.length, 0);
});

test("stalled and rewound clocks rearm without collapsing slots or paying a backlog", () => {
  const game = encounter();
  game.asteroids[0].bossPhase = "live";
  tickSepulchre(game, 0);
  for (const beatTime of [101.2, 4.2, 80.75]) {
    game.beatTime = beatTime;
    game.alienBullets = [];
    tickSepulchre(game, 0);
    assertSlots(game.asteroids.slice(1));
    for (const bearer of game.asteroids.slice(1)) {
      assert.ok(bearer.nextBeatAt >= beatTime && bearer.nextBeatAt <= beatTime + 2);
    }
    assert.equal(game.alienBullets.length, 0);
  }
});

test("killing the tomb releases surviving bearers even though kills do not clear alive", () => {
  const game = encounter();
  const [tomb, ...bearers] = game.asteroids;
  tomb.bossPhase = "live";
  tickSepulchre(game, 0.1);
  assert.equal(tomb.applyDamage(1000).killed, true);
  assert.equal(tomb.alive, true);
  game.asteroids = bearers;
  tickSepulchre(game, 0.1);
  for (const bearer of bearers) {
    assert.equal(bearer.bierCore, null);
    assert.equal(bearer.rotSpeed, 0.4);
    assert.ok(Math.hypot(bearer.vel.x, bearer.vel.y) > 0);
  }
});
