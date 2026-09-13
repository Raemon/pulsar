import assert from "node:assert/strict";
import { test } from "node:test";
import { installHeadlessStubs, makeCanvas } from "./headless-stubs.mjs";

installHeadlessStubs({ w: 1920, h: 1080, dpr: 1 });
const { Game } = await import("../src/Game.ts");
const { spawnSepulchreEncounter, tickSepulchre, renderSepulchreCues } = await import("../src/game/sepulchre.ts");

const encounter = () => {
  const game = new Game(makeCanvas(1920, 1080));
  game.asteroids = spawnSepulchreEncounter(game, { x: 960, y: 540 });
  return game;
};

test("the arrival reaches combat in eight measures", () => {
  const game = encounter();
  const tomb = game.asteroids[0];
  tomb.update(15.99, game.w, game.h);
  assert.equal(tomb.bossPhase, "dormant");
  tomb.update(0.02, game.w, game.h);
  assert.equal(tomb.bossPhase, "live");
});

test("breaking the final tether keeps the earned combo and announces the shutter once", () => {
  const game = encounter();
  const [tomb] = game.asteroids;
  tomb.bossPhase = "live";
  game.beatCombo = 24;
  const sounds = [];
  game.sound.play = (name) => sounds.push(name);
  tickSepulchre(game, 0.1);
  assert.equal(tomb.shutterOpen, 0);
  game.asteroids = [tomb];
  tickSepulchre(game, 0.1);
  tickSepulchre(game, 0.1);
  assert.equal(game.beatCombo, 24);
  assert.equal(game.ship.comboLossFlash, 0);
  assert.equal(tomb.damageReduction, 2);
  assert.ok(tomb.shutterOpen > 0 && tomb.shutterOpen < 1);
  assert.equal(sounds.filter((name) => name === "bossEyeOpenStinger").length, 1);
});

test("the tomb's beat flash decays between tolls", () => {
  const game = encounter();
  const [tomb] = game.asteroids;
  game.asteroids = [tomb];
  tomb.bossPhase = "live";
  tomb.shutterOpen = 1;
  game.beatTime = 2;
  tomb.nextBeatAt = 2;
  tickSepulchre(game, 0);
  assert.equal(tomb.tollFlash, 1);
  game.beatTime = 2.25;
  tickSepulchre(game, 0.25);
  assert.ok(tomb.tollFlash > 0 && tomb.tollFlash < 1);
});

for (const shutterOpen of [0.9, 1]) {
  test(`charge spokes predict the next volley, shutter=${shutterOpen}`, () => {
    const game = encounter();
    const [tomb] = game.asteroids;
    game.asteroids = [tomb];
    tomb.bossPhase = "live";
    tomb.shutterOpen = shutterOpen;
    tomb.bierPhase = 0.5;
    tomb.nextBeatAt = 2;
    game.beatTime = 1.8;
    game.ship.alive = true;
    const ctx = makeCanvas(1920, 1080).getContext("2d");
    const tips = [];
    const capture = new Proxy(ctx, {
      get(target, key) { return key === "lineTo" ? (x, y) => tips.push({ x, y }) : target[key]; },
    });
    renderSepulchreCues(capture, game, 1800);
    assert.equal(tips.length, 12);
    assert.equal(game.alienBullets.length, 0, "charge marks are harmless");
    game.beatTime = 2;
    tickSepulchre(game, 0.2);
    assert.equal(game.alienBullets.length, 12);
    for (let i = 0; i < tips.length; i++) {
      const markAngle = Math.atan2(tips[i].y - tomb.pos.y, tips[i].x - tomb.pos.x);
      const shot = game.alienBullets[i];
      const shotAngle = Math.atan2(shot.vel.y, shot.vel.x);
      assert.ok(Math.abs(markAngle - shotAngle) < 1e-10);
    }
  });
}
