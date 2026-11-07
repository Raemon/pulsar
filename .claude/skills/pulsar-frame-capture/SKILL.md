---
name: pulsar-frame-capture
description: Capture a short Pulsar animation frame by frame (a hit, an explosion, a wormhole swallow, a warp-out, a weapon's projectile in flight) by freezing the game's clock in headless Chromium and stepping it 1/60s at a time, then tiling the frames into a contact sheet you can actually look at. Use whenever you need to SEE a fast in-game effect to verify or tune it — real-time screenshots (~400ms each) miss anything under a second.
---

# Frame-stepped capture

`page.screenshot()` of the 1920×1080 game canvas takes ~400ms, so capturing a
live game in real time gets one or two frames of a half-second animation.
Instead, freeze time: an init script replaces `requestAnimationFrame` with a
queue that only advances when you call `step(n)`, feeding `main.tsx`'s tick a
timestamp exactly 1/60s later each step (the audio clock is disabled so the
loop uses those timestamps). Between steps nothing moves, so every frame can
be screenshotted, and the run is reproducible.

Everything lives in this folder:
- `frameStepper.cjs` — `openStepped()` → `{ step, game, betaStart, fire, clipAround, shot, close }`.
- `sheet.py` — tiles a list of PNGs into one labelled contact sheet.

## 1. Start the dev server

```bash
cd /home/user/pulsar && (npx vite --port 5199 --strictPort > "$SCRATCH/vite.log" 2>&1 &)
```

Wait for it (`curl -s -o /dev/null -w "%{http_code}" http://localhost:5199/` → 200).
Run `npm ci` first if `node_modules` is missing. Playwright and Chromium are
pre-installed in cloud sessions — don't install them.

## 2. Write a scenario script in the scratchpad

```js
const { openStepped } = require("/home/user/pulsar/.claude/skills/pulsar-frame-capture/frameStepper.cjs");
(async () => {
  const s = await openStepped({ outDir: process.env.OUT, dpr: 1 });
  await s.betaStart(["normal", "warpCannon"]);          // beta-panel tile ids
  // Stage the scene relative to the ship (the camera pins it to screen centre).
  await s.game((g, d) => {
    const a = g.asteroids[0];
    a.pos.x = g.ship.pos.x + d; a.pos.y = g.ship.pos.y; a.vel.x = 0; a.vel.y = 0; a.entering = false;
    g.ship.heading = 0; g.ship.vel.x = 0; g.ship.vel.y = 0; g.ship.invuln = 99;
  }, 330);
  await s.fire();
  for (let f = 0; f < 60; f += 2) {
    const info = await s.game((g) => ({ bullets: g.bullets.length, swallows: g.swallows.length }));
    console.log(f, JSON.stringify(info));                // log sim state beside each frame
    await s.shot(`f${String(f).padStart(3, "0")}`, s.clipAround(200, 0, 520, 340));
    await s.step(2);
  }
  await s.close();                                        // prints any page errors
})();
```

Run it with `OUT=$SCRATCH/shots node scenario.cjs` (make the folder first).

## 3. Look at it as one image

```bash
python3 /home/user/pulsar/.claude/skills/pulsar-frame-capture/sheet.py \
  "$SCRATCH/shots/sheet.png" $(ls "$SCRATCH"/shots/f*.png) --cols 4 --scale 1.5
```

Then `Read` the sheet. One sheet of ~12–16 frames shows a whole effect;
a 4-column sheet much wider than ~2000px gets downscaled when viewed, so crop
(`--crop L,T,R,B`) or lower `--scale` instead of adding frames.

## Tips

- **Staging.** `s.game(fn, arg)` runs `fn(window.__game, arg)` in the page —
  move bodies, zero velocities, set `entering = false` on fresh spawns, flip
  upgrade flags (`g.ship.warpCannonActive = true`), or force a bullet's tier
  (`Object.assign(g.bullets.at(-1), { onBeat: true, boosted: true })`). It is
  serialised, so pass Node values through `arg`, not closures.
- **Beta runs** (`betaStart`) never end the wave and never open wave-skip
  portals. For either, set `g.betaMode = false` after starting — and keep one
  rock alive far off, or the empty field advances the wave.
- **Coordinates.** The canvas is 1920×1080 logical, scaled into the viewport
  (×⅔ at 1280×800). `clipAround(dx, dy, w, h)` takes a world offset from the
  ship and handles the scale. Use `dpr: 2` for close-ups of small things
  (bullets); 1 is plenty for anything you only look at yourself.
- **What the clock covers.** Everything on `game.update(dt)` — the sim,
  musicDt, the wormholes, particles. Real `setTimeout`s and CSS/DOM
  animations (popups in the HUD, overlays) still run on wall time.
- **Errors.** `close()` prints uncaught page errors; a 500 on `/api/*` is just
  the missing database in dev and harmless.
- Leave the server running between scenarios; kill it when done
  (`pkill -f "vite --port 5199"`).
