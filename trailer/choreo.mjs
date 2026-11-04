// node choreo.mjs specs/<name>.json [--capture]
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
const [,, specFile, mode] = process.argv;
const spec = JSON.parse(readFileSync(specFile, "utf8"));
const name = spec.name;
mkdirSync("scenes", { recursive: true });
const vpath = `scenes/${name}.h264`;
if (mode === "--capture") writeFileSync(vpath, "");
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const page = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
page.on("pageerror", (e) => console.log("  pageerror>", e.message));
await page.exposeFunction("__sink", (kind, data) => { const buf = Buffer.from(data, "base64"); if (kind === "v") appendFileSync(vpath, buf); else writeFileSync(`scenes/${name}.wav`, buf); });
await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
for (let attempt = 1; ; attempt++) {
  try {
    if (attempt === 1 || !(await page.evaluate(() => !!window.__game))) await page.goto("http://localhost:5288/", { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => !!window.__game, null, { timeout: 120000 });
    await page.addScriptTag({ type: "module", content: readFileSync(new URL("./choreo.js", import.meta.url), "utf8") });
    await page.waitForFunction(() => !!window.__choreo, null, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3000));
    if (await page.evaluate(() => !!window.__choreo)) break;
  } catch (e) { if (attempt >= 6) throw e; console.log(`  load attempt ${attempt} failed; retrying`); }
}
import { existsSync } from "node:fs";
const specBin = `spectra/${name}.u8`;
if (mode === "--capture" && existsSync(specBin)) {
  await page.evaluate((b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); window.__spectrum = u; }, readFileSync(specBin).toString("base64"));
  console.log(`  spectrum: ${specBin}`);
}
const rep = await page.evaluate(([s, c]) => window.__choreo(s, c), [spec, mode === "--capture"]);
writeFileSync(`specs/${name}.report.json`, JSON.stringify(rep, null, 1));
const ev = rep.capturedEvents ?? rep.events;
console.log(`${name}: clearance ${rep.clearance.toFixed(0)}px (${JSON.stringify(rep.clearWho)})`);
for (const e of ev) console.log("  ", JSON.stringify(e));
if (rep.cit) console.log("  citadel:", rep.cit.join(" "));
if (rep.citOff) console.log("  citOff:", rep.citOff.join(" "));
if (process.env.HOVER) console.log("  hover:", rep.hover.join(" "));
if (rep.capturedCombo) console.log("  capture combo matches validation:", JSON.stringify(rep.capturedCombo) === JSON.stringify(rep.combo));
await b.close();
