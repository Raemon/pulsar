// Frame-stepped capture of the live Pulsar game in headless Chromium.
//
// A page.screenshot() of the full-res canvas takes ~400ms, so real-time
// captures miss anything shorter than a second. This freezes the game's clock
// instead: an init script swaps requestAnimationFrame for a queue that only
// advances when you call step(n), each step feeding the loop a timestamp
// exactly 1/60s later, and the audio clock is disabled so main.tsx's tick
// falls back to those timestamps. Between steps the world is frozen, so you
// can screenshot every frame of a 10-frame animation.
//
// Usage (from a scratch script — see SKILL.md):
//   const { openStepped } = require("/home/user/pulsar/.claude/skills/pulsar-frame-capture/frameStepper.cjs");
//   const s = await openStepped({ url: "http://localhost:5199/" });
//   await s.betaStart(["normal", "warpCannon"]);
//   await s.game((g) => { g.ship.heading = 0; });
//   await s.fire();
//   for (let f = 0; f < 30; f += 2) { await s.shot(`f${f}`, s.clipAround(200, 0, 300, 200)); await s.step(2); }
//   await s.close();

const { chromium } = require("playwright");

const openStepped = async ({
  url = "http://localhost:5199/",
  viewport = { width: 1280, height: 800 },
  dpr = 1,
  outDir = process.cwd(),
} = {}) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, deviceScaleFactor: dpr });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ""}`));
  await page.addInitScript(() => {
    window.__rafQ = [];
    window.__vt = 0;
    window.requestAnimationFrame = (cb) => {
      window.__rafQ.push(cb);
      return window.__rafQ.length;
    };
    window.__step = (n) => {
      for (let i = 0; i < n; i++) {
        window.__vt += 1000 / 60;
        const q = window.__rafQ;
        window.__rafQ = [];
        for (const cb of q) cb(window.__vt);
      }
    };
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  // The loop prefers the AudioContext clock when audio runs; force the
  // stepped timestamps instead, then let the title screen settle.
  await page.evaluate(() => {
    window.__game.sound.runningAudioTime = () => null;
    window.__step(30);
  });

  const step = (n = 1) => page.evaluate((k) => window.__step(k), n);

  // Run `fn(game, arg)` in the page. fn is serialised, so it can't close over
  // Node variables — pass them through `arg`.
  const game = (fn, arg) => page.evaluate(([src, a]) => (0, eval)(`(${src})`)(window.__game, a), [fn.toString(), arg]);

  // Start a beta-panel run (Ctrl+B) with the given tile ids — AsteroidKind,
  // PowerupKind, "alienSmall" / "alienMedium" / "alienBig", "comet", ….
  // Beta runs never spawn skip portals and never end the wave; set
  // g.betaMode = false afterwards if you need either.
  const betaStart = async (tileIds) => {
    await page.keyboard.press("Control+b");
    await page.waitForSelector("#beta-panel:not(.hidden)");
    for (const id of tileIds) await page.click(`.beta-tile[data-id="${id}"]`);
    await page.click("#beta-start");
    await step(10);
  };

  // Tap the fire key for one frame pair.
  const fire = async () => {
    await page.keyboard.down(" ");
    await step(2);
    await page.keyboard.up(" ");
  };

  // The camera pins the ship to the canvas centre, so a world offset from the
  // ship maps to a fixed screen point. Returns CSS px in the viewport.
  const screenOf = async (dx, dy) => {
    const m = await page.evaluate(() => {
      const g = window.__game;
      const r = g.canvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, w: g.w, h: g.h };
    });
    const k = m.width / m.w;
    return { x: m.left + m.width / 2 + dx * k, y: m.top + m.height / 2 + dy * k, scale: k };
  };

  // A screenshot clip of width×height CSS px centred on a world offset from the ship.
  const clipAround = async (dx, dy, width, height) => {
    const p = await screenOf(dx, dy);
    return { x: Math.round(p.x - width / 2), y: Math.round(p.y - height / 2), width, height };
  };

  const shot = async (name, clip) => {
    const path = `${outDir}/${name}.png`;
    await page.screenshot({ path, clip: clip instanceof Promise ? await clip : clip });
    return path;
  };

  const close = async () => {
    if (errors.length) console.log("page errors:\n" + errors.join("\n"));
    await browser.close();
    return errors;
  };

  return { page, step, game, betaStart, fire, screenOf, clipAround, shot, close, errors };
};

module.exports = { openStepped };
