// Does an exported replay movie sound like the game that recorded it?
//
// Both legs render into an OfflineAudioContext through Sound's own
// buildMixGraph, so the only variable is how Sound reaches its context:
//
//   engine   sound.ctx = the OfflineAudioContext itself, with the voice fired
//            from inside an offline suspend(t) callback — so ctx.currentTime
//            genuinely reads t, exactly as the live AudioContext does when the
//            game plays that voice.
//   export   the real beginExportCapture, driven by an ExportClock.
//
// Firing at t > 0 is the whole point of the timing section: at t = 0 the
// export clock and a real ctx.currentTime agree by accident, so the
// re-anchoring in audioCapture's wrapSourceTiming is a no-op and the legs
// match whether or not it is correct.
//
// The drive section is the other half, and the one that bites hardest. The
// master volume sits AHEAD of the master compressor and limiter, so it sets
// how hard both are driven — capture at a level the player wasn't listening
// at and the movie is a differently-squashed mix, flattest on exactly the
// transient voices (shots, hits) a player notices first.
//
//   npm run check:capture-parity
//   node scripts/check-capture-parity.mjs fire bell   # filter the timing cases
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";
const PORT = Number(process.env.PORT) || 5233;
const FILTER = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// A leg is "the same mix" only if the waveforms line up; anything audible
// shows up far above this.
const MAX_DIFF = 1e-3;

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
vite.stderr.on("data", (c) => process.stderr.write(c));
vite.stdout.on("data", () => {});
const deadline = Date.now() + 90_000;
for (;;) {
  try { const r = await fetch(`http://localhost:${PORT}/sound`); if (r.ok) break; } catch { /* not up */ }
  if (Date.now() > deadline) throw new Error("vite did not start");
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("  page error>", e));
page.on("console", (m) => { const t = m.text(); if (!t.startsWith("[vite]")) console.log("  page>", t); });

let out;
try {
  await page.goto(`http://localhost:${PORT}/sound`, { waitUntil: "domcontentloaded" });
  out = await page.evaluate(async (filter) => {
    const [{ Sound }, cfg, cap] = await Promise.all([
      import("/src/Sound.ts"), import("/src/soundConfig.ts"), import("/src/game/audioCapture.ts"),
    ]);
    await cfg.loadSoundConfig();
    const sound = new Sound();
    sound.ensureContext();
    await sound.prewarmForExport();
    const liveCtx = sound.ctx;

    const RATE = 48000, SECONDS = 4, HIT = { x: 220, y: 90 };
    const seeded = () => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
    const realRandom = Math.random;
    const quantize = (t) => Math.max(0, Math.round((t * RATE) / 128) * 128) / RATE;

    // A level-1 shape: a burst of shots with hits landing between them. This
    //   is the material the drive section measures, because it is what a
    //   player reported hearing wrong in a downloaded movie.
    const volley = (() => {
      const evs = [];
      for (let i = 0; i < 12; i++) evs.push([0.2 + i * 0.18, (s) => s.play("fire")]);
      for (let i = 0; i < 6; i++) evs.push([0.35 + i * 0.36, (s) => s.play("crystalShatterSmall", 1, HIT)]);
      for (let i = 0; i < 3; i++) evs.push([0.5 + i * 0.7, (s) => s.play("asteroidBoomBeat", 1, HIT)]);
      return evs.sort((a, b) => a[0] - b[0]);
    })();

    const CASES = {
      "fire@t=0":            [[0.0, (s) => s.play("fire")]],
      "fire@t=1.5":          [[1.5, (s) => s.play("fire")]],
      "fireBeat@t=1.5":      [[1.5, (s) => s.play("fireBeat")]],
      "fire@pos@t=1.5":      [[1.5, (s) => s.play("fire", 1, HIT)]],
      "crystalLarge@t=1.5":  [[1.5, (s) => s.play("crystalShatterLarge", 1, HIT)]],
      "crystalLarge@onbeat": [[1.5, (s) => s.play("crystalShatterLarge", 0, HIT)]],
      "crystalSmall@t=1.5":  [[1.5, (s) => s.play("crystalShatterSmall", 1, HIT)]],
      "asteroidBoom@t=1.5":  [[1.5, (s) => s.play("asteroidBoomBeat", 1, HIT)]],
      "bell@t=1.5":          [[1.5, (s) => s.play("bell", 1, HIT)]],
      "chime@t=1.5":         [[1.5, (s) => s.play("chime", 1, HIT)]],
      "warble@t=1.5":        [[1.5, (s) => s.play("warble", 1, HIT)]],
      "explosionMed@t=1.5":  [[1.5, (s) => s.play("explosionMedium", 1, HIT)]],
      "tink@t=1.5":          [[1.5, (s) => s.play("tink", 1, HIT)]],
      "bassHit@t=1.5":       [[1.5, (s) => s.play("bassHit", 1, HIT)]],
      "comboChime@t=1.5":    [[1.5, (s) => s.playComboChime(5)]],
      "level1 volley":       volley,
      "same-frame x4":       [0, 1, 2, 3].map(() => [1.5, (s) => s.play("crystalShatterSmall", 1, HIT)]),
    };

    // Engine leg: fire from inside suspend(t) so ctx.currentTime really is t.
    const renderEngine = async (events, volume) => {
      const offline = new OfflineAudioContext(2, RATE * SECONDS, RATE);
      sound.bakedBursts.clear();
      sound.ctx = offline;
      sound.volume = volume;
      sound.pauseFadeFactor = 1;
      sound.buildMixGraph();
      const byTime = new Map();
      for (const [t, fn] of events) {
        const q = quantize(t);
        if (!byTime.has(q)) byTime.set(q, []);
        byTime.get(q).push(fn);
      }
      for (const [q, fns] of byTime) {
        offline.suspend(q).then(() => {
          for (const fn of fns) { try { fn(sound); } catch (e) { console.log("engine fire error", String(e)); } }
          offline.resume();
        });
      }
      Math.random = seeded();
      const buf = await offline.startRendering();
      Math.random = realRandom;
      sound.ctx = liveCtx;
      return buf;
    };

    // Export leg: the real capture path, entered at the player's live level.
    const renderExport = async (events, volume) => {
      const offline = new OfflineAudioContext(2, RATE * SECONDS, RATE);
      const clock = new cap.ExportClock();
      clock.now = 0;
      sound.ctx = liveCtx;
      sound.volume = volume;
      sound.beginExportCapture(new cap.CaptureAudioContext(offline, clock));
      Math.random = seeded();
      for (const [t, fn] of events) {
        clock.now = quantize(t);
        try { fn(sound); } catch (e) { console.log("export fire error", String(e)); }
      }
      Math.random = realRandom;
      sound.endExportCapture();
      return await offline.startRendering();
    };

    const db = (v) => (v > 0 ? 20 * Math.log10(v) : -999);
    const measure = (a, b) => {
      let maxDiff = 0, sumA = 0, sumB = 0, peakA = 0, peakB = 0, n = 0;
      for (let ch = 0; ch < 2; ch++) {
        const x = a.getChannelData(ch), y = b.getChannelData(ch);
        for (let i = 0; i < x.length; i++) {
          maxDiff = Math.max(maxDiff, Math.abs(x[i] - y[i]));
          peakA = Math.max(peakA, Math.abs(x[i])); peakB = Math.max(peakB, Math.abs(y[i]));
          sumA += x[i] * x[i]; sumB += y[i] * y[i]; n++;
        }
      }
      const rmsA = Math.sqrt(sumA / n), rmsB = Math.sqrt(sumB / n);
      return {
        maxDiff, rmsEngine: rmsA, rmsExport: rmsB,
        levelDeltaDb: db(rmsB) - db(rmsA),
        // Crest factor is the transient-shape number: the harder the
        //   compressor is driven, the flatter it gets.
        crestEngine: rmsA > 0 ? peakA / rmsA : 0,
        crestExport: rmsB > 0 ? peakB / rmsB : 0,
      };
    };

    const timing = [];
    for (const [label, events] of Object.entries(CASES)) {
      if (filter.length && !filter.some((f) => label.includes(f))) continue;
      try {
        const a = await renderEngine(events, Sound.DEFAULT_VOLUME);
        const b = await renderExport(events, Sound.DEFAULT_VOLUME);
        timing.push({ label, ...measure(a, b) });
      } catch (e) { timing.push({ label, error: String(e) }); }
    }

    // Drive: the movie must match the mix at the level the player was on.
    const drive = [];
    for (const volume of [Sound.DEFAULT_VOLUME, 1.5, 1.0, 0.5]) {
      try {
        const a = await renderEngine(volley, volume);
        const b = await renderExport(volley, volume);
        drive.push({ volume, ...measure(a, b) });
      } catch (e) { drive.push({ volume, error: String(e) }); }
    }

    // Muted is the one level capture can't honour: it must fall back rather
    //   than render a silent movie.
    let muted = null;
    try {
      const b = await renderExport(volley, 0);
      const m = measure(b, b);
      muted = { rms: m.rmsEngine };
    } catch (e) { muted = { error: String(e) }; }
    sound.ctx = liveCtx;
    sound.volume = Sound.DEFAULT_VOLUME;

    return { timing, drive, muted };
  }, FILTER);
} finally {
  await browser.close();
  vite.kill();
}

const f = (v, d = 4) => (v === null || v === undefined ? "  -  " : Number(v).toFixed(d));
let bad = 0;

console.log("\nTiming — one voice, engine clock vs export clock");
console.log("case                        rms(engine)  rms(export)  Δlevel dB    maxDiff");
for (const r of out.timing) {
  if (r.error) { console.log(`${r.label.padEnd(27)} ERROR ${r.error}`); bad++; continue; }
  const differs = r.maxDiff > MAX_DIFF;
  if (differs) bad++;
  console.log(`${r.label.padEnd(27)} ${f(r.rmsEngine, 5).padStart(11)}  ${f(r.rmsExport, 5).padStart(11)}  ${f(r.levelDeltaDb, 2).padStart(9)}  ${f(r.maxDiff, 5).padStart(9)}${differs ? "  <-- DIFFERS" : ""}`);
}

console.log("\nDrive — level-1 volley captured at the player's master level");
console.log("slider   rms(engine)  rms(export)  Δlevel dB   crest(engine)  crest(export)    maxDiff");
for (const r of out.drive) {
  if (r.error) { console.log(`${String(r.volume).padStart(6)} ERROR ${r.error}`); bad++; continue; }
  const differs = r.maxDiff > MAX_DIFF;
  if (differs) bad++;
  console.log(`${String(r.volume).padStart(6)}   ${f(r.rmsEngine, 5).padStart(11)}  ${f(r.rmsExport, 5).padStart(11)}  ${f(r.levelDeltaDb, 2).padStart(9)}  ${f(r.crestEngine, 2).padStart(13)}  ${f(r.crestExport, 2).padStart(13)}  ${f(r.maxDiff, 5).padStart(9)}${differs ? "  <-- DIFFERS" : ""}`);
}

console.log("\nMuted — capture must fall back, not render silence");
if (out.muted?.error) { console.log(`  ERROR ${out.muted.error}`); bad++; }
else {
  const ok = out.muted.rms > 1e-4;
  if (!ok) bad++;
  console.log(`  rms ${f(out.muted.rms, 5)}${ok ? "" : "  <-- SILENT"}`);
}

console.log(bad === 0
  ? "\nExport capture matches the engine on every case."
  : `\n${bad} case(s) differ between engine and export.`);
process.exit(bad === 0 ? 0 : 1);
