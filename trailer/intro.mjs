// Renders (held version) the fullHints intro text layer (transparent PNGs, 60fps) with the
// exact IntroSequence envelope, plus bg.txt opacity per frame.
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
const HINTS = JSON.parse(process.argv[2]);
const FPS = 60, BEAT = 0.5, TOTAL_BEATS = 16;
const smooth = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
const env = (b, s, d) => (b < s ? 0 : b - s < d ? smooth((b - s) / d) : 1);
mkdirSync("intro", { recursive: true });
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] });
const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("file://" + process.cwd() + "/intro.html");
await page.evaluate(async (h) => { h.forEach((t, i) => (document.getElementById("l" + i).textContent = t)); await document.fonts.ready; }, HINTS);
console.log("font:", await page.evaluate(() => document.fonts.check('500 64px "Space Grotesk"')));
const bg = [];
const n = Math.round(TOTAL_BEATS * BEAT * FPS);
for (let f = 0; f < n; f++) {
  const beat = f / FPS / BEAT;
  const out = 1 - smooth((beat - 8) / 8);   // crossfades away as the game fades in (beats 8-16)
  const ops = [env(beat, 1, 1), env(beat, 3, 1), env(beat, 5, 1), env(beat, 7, 1)].map((o) => o * out);
  bg.push((1 - smooth((beat - 23) / 4)).toFixed(4));
  await page.evaluate((o) => o.forEach((v, i) => (document.getElementById("l" + i).style.opacity = v)), ops);
  await page.screenshot({ path: `intro/f${String(f).padStart(4, "0")}.png`, omitBackground: true });
}
writeFileSync("intro/bg.txt", bg.join("\n"));
await b.close();
console.log("frames", n);
