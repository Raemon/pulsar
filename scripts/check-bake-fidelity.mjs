// Checks that a baked one-shot still sounds like the graph it was baked from,
// without ears. A raw-voice bake should be indistinguishable from its own live
// fallback: same file, same mix chain, the mp3 is only a cached render.
//
// Boots vite and renders each one-shot three ways in headless Chromium, then
// reports per-band energy deltas in dB:
//
//   live    graph -> bus gain -> master comp -> limiter -> soft clip
//   baked   mp3 x bake-gain -> the same chain
//   raw     graph -> bus gain only                    [no dynamics at all]
//
//   baked - live    what a player would hear as a change. Everything here is
//                   codec: expect well under a dB in any band that carries
//                   audible energy. A band 30+ dB below the loudest one is
//                   bookkeeping, not timbre.
//
// "Tinny" shows up as a negative low-band delta (body gone) and/or a positive
// high-band delta (fizz added), plus a positive centroid shift.
//
//   node scripts/check-bake-fidelity.mjs               # every baked one-shot
//   node scripts/check-bake-fidelity.mjs fire death    # just these voices

import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";
const PORT = Number(process.env.PORT) || 5202;
const FILTER = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// --dump-wav writes each voice's pre-encode render (exactly what ffmpeg is
// handed at bake time) next to the report, so the mp3 can be diffed against
// its own source and encoder settings compared offline.
const DUMP = process.argv.includes("--dump-wav") ? process.argv[process.argv.indexOf("--dump-wav") + 1] : null;

const BAKED_DIR = new URL("../public/sounds/baked", import.meta.url).pathname;
const files = (await readdir(BAKED_DIR))
  .filter((f) => f.endsWith(".mp3"))
  .map((f) => {
    const [name, key] = f.slice(0, -4).split("__");
    return { file: f, name, key: Number(key) };
  })
  .filter((v) => Number.isFinite(v.key))
  .filter((v) => FILTER.length === 0 || FILTER.includes(v.name));

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
});
vite.stderr.on("data", (c) => process.stderr.write(c));
vite.stdout.on("data", () => {});
const deadline = Date.now() + 90_000;
for (;;) {
  try {
    const r = await fetch(`http://localhost:${PORT}/sound`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) throw new Error("vite did not start");
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("  page error>", e));

let rows;
try {
  await page.goto(`http://localhost:${PORT}/sound`, { waitUntil: "domcontentloaded" });
  rows = await page.evaluate(async ({ voices, dumpWav }) => {
    const [{ Sound }, cfg] = await Promise.all([
      import("/src/Sound.ts"),
      import("/src/soundConfig.ts"),
    ]);
    await cfg.loadSoundConfig();
    const sound = new Sound();
    sound.ensureContext();

    const RATE = 48000;
    const VOLUME = 2; // Sound.volume default, on both summing buses

    const comp = (ctx, threshold, ratio, knee, attack, release) => {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = threshold; c.ratio.value = ratio; c.knee.value = knee;
      c.attack.value = attack; c.release.value = release;
      return c;
    };
    const softClip = (ctx) => {
      const w = ctx.createWaveShaper();
      const N = 8192, knee = 0.87, ceiling = 0.985;
      const curve = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * 2 - 1;
        const a = Math.abs(x);
        curve[i] = a <= knee ? x : Math.sign(x) * (knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
      }
      w.curve = curve;
      return w;
    };
    const busGain = (ctx, head) => {
      const g = ctx.createGain();
      g.gain.value = VOLUME;
      g.connect(head);
      return g;
    };
    // Mirrors of buildMixGraph's two legs and of buildBakedMasterChain.
    const liveChainIn = (ctx) => {
      const clip = softClip(ctx); clip.connect(ctx.destination);
      const lim = comp(ctx, -2, 20, 6, 0.003, 0.12); lim.connect(clip);
      const c = comp(ctx, -18, 3, 12, 0.01, 0.18); c.connect(lim);
      return busGain(ctx, c);
    };
    const bakedChainIn = (ctx) => {
      const clip = softClip(ctx); clip.connect(ctx.destination);
      const lim = comp(ctx, -2, 20, 6, 0.003, 0.12); lim.connect(clip);
      const trim = ctx.createGain(); trim.gain.value = 0.83; trim.connect(lim);
      const glue = comp(ctx, -10, 2.5, 12, 0.006, 0.25); glue.connect(trim);
      return busGain(ctx, glue);
    };
    // Mirrors Sound.PREMASTERED_BAKES — those files carry their own dynamics
    // and play through the glue leg; a raw-voice bake plays through the live one.
    const PREMASTERED = new Set([
      "bgBeat", "fireBeat", "bassKick", "bassBoom", "bassPluck", "bassSnap",
      "chime", "drainChime", "powerup", "waveClear", "cometNote",
      "wraithScream", "wraithHit", "wraithLunge", "wraithDeath",
    ]);
    const bakeGains = await fetch("/sounds/baked/bake-gains.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));

    const encodeWav = (data) => {
      const bytes = new ArrayBuffer(44 + data.length * 4);
      const view = new DataView(bytes);
      const ascii = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
      ascii(0, "RIFF"); view.setUint32(4, 36 + data.length * 4, true); ascii(8, "WAVEfmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
      view.setUint32(24, RATE, true); view.setUint32(28, RATE * 4, true);
      view.setUint16(32, 4, true); view.setUint16(34, 32, true);
      ascii(36, "data"); view.setUint32(40, data.length * 4, true);
      for (let i = 0; i < data.length; i++) view.setFloat32(44 + i * 4, data[i], true);
      return bytes;
    };

    const decodeCtx = new AudioContext({ sampleRate: RATE });
    const fft = (re, im) => {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        for (let i = 0; i < n; i += len) {
          for (let k = 0; k < len / 2; k++) {
            const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
            const ur = re[i + k], ui = im[i + k];
            const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
            const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
            re[i + k] = ur + vr; im[i + k] = ui + vi;
            re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          }
        }
      }
    };
    const BANDS = [[20, 150], [150, 600], [600, 2500], [2500, 6000], [6000, 16000]];
    const spectrum = (data) => {
      let n = 1; while (n < data.length) n <<= 1;
      n = Math.min(n, 1 << 19);
      const re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < Math.min(n, data.length); i++) re[i] = data[i];
      fft(re, im);
      const half = n / 2;
      const power = new Float64Array(half);
      for (let i = 0; i < half; i++) power[i] = re[i] * re[i] + im[i] * im[i];
      const binHz = RATE / n;
      const bands = BANDS.map(([lo, hi]) => {
        let s = 0;
        for (let i = Math.ceil(lo / binHz); i < Math.min(half, hi / binHz); i++) s += power[i];
        return s;
      });
      let num = 0, den = 0;
      for (let i = Math.ceil(20 / binHz); i < Math.min(half, 16000 / binHz); i++) {
        num += power[i] * i * binHz; den += power[i];
      }
      return { bands, centroid: den > 0 ? num / den : 0, total: den };
    };
    const rms = (d) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
    const peak = (d) => { let p = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; } return p; };
    const db = (a, b) => 20 * Math.log10((a + 1e-12) / (b + 1e-12));
    const dbfs = (a) => 20 * Math.log10(a + 1e-12);
    const out = [];
    for (const v of voices) {
      const builder = sound.oneShotGraph(v.name, v.key);
      if (!builder) continue;
      const secs = (Sound.ONE_SHOT_BAKE_LEN[v.name] ?? 1.5) + 0.5;
      const len = Math.ceil(RATE * secs);

      const renderGraph = async (mode) => {
        const ctx = new OfflineAudioContext(1, len, RATE);
        let head;
        if (mode === "live") head = liveChainIn(ctx);
        else if (mode === "raw") { const g = ctx.createGain(); g.gain.value = VOLUME; g.connect(ctx.destination); head = g; }
        else head = bakedChainIn(ctx);
        builder(ctx, head, 0);
        return (await ctx.startRendering()).getChannelData(0);
      };

      let mp3;
      try {
        const ab = await (await fetch(`/sounds/baked/${v.file}`)).arrayBuffer();
        mp3 = await decodeCtx.decodeAudioData(ab);
      } catch { continue; }
      const bakedCtx = new OfflineAudioContext(1, len, RATE);
      const src = bakedCtx.createBufferSource();
      src.buffer = mp3;
      // Undo the encode-time normalization, as Sound does on decode.
      const g = bakedCtx.createGain();
      g.gain.value = bakeGains[`${v.name}__${v.key.toFixed(4)}`] ?? 1;
      src.connect(g);
      g.connect(PREMASTERED.has(v.name) ? bakedChainIn(bakedCtx) : liveChainIn(bakedCtx));
      src.start(0);
      const baked = (await bakedCtx.startRendering()).getChannelData(0);

      const live = await renderGraph("live");
      const raw = await renderGraph("raw");

      const sl = spectrum(live), sb = spectrum(baked), sr = spectrum(raw);
      // Codec noise floor: how loud the mp3 is in the top octaves relative to
      // its own peak. A quiet render leaves the encoder's noise proportionally
      // louder, which is what "tinny" sounds like on a soft one-shot.
      out.push({
        name: v.name,
        key: v.key,
        rawPeak: peak(raw),
        livePeak: peak(live),
        bakedPeak: peak(baked),
        mp3Peak: peak(mp3.getChannelData(0)),
        rmsDelta: db(rms(baked), rms(live)),
        bandsBakedVsLive: sb.bands.map((b, i) => db(Math.sqrt(b), Math.sqrt(sl.bands[i]))),
        bandsLiveAbs: sl.bands.map((b) => dbfs(Math.sqrt(b) / Math.sqrt(live.length))),
        wav: dumpWav ? {
          live: Array.from(new Uint8Array(encodeWav(live))),
          baked: Array.from(new Uint8Array(encodeWav(baked))),
        } : null,
        centroidLive: sl.centroid,
        centroidBaked: sb.centroid,
        rawVsLive: db(Math.sqrt(sr.total), Math.sqrt(sl.total)),
      });
    }
    await decodeCtx.close();
    return out;
  }, { voices: files, dumpWav: !!DUMP });
  if (DUMP) {
    await mkdir(DUMP, { recursive: true });
    for (const r of rows) {
      if (!r.wav) continue;
      for (const [leg, bytes] of Object.entries(r.wav)) {
        await writeFile(`${DUMP}/${r.name}__${r.key}.${leg}.wav`, Buffer.from(bytes));
      }
      delete r.wav;
    }
    console.log(`wrote pre-encode renders to ${DUMP}`);
  }
} finally {
  await browser.close();
  vite.kill("SIGTERM");
}

const BAND_LABELS = ["sub", "low", "mid", "hi", "air"];
const fmt = (n, w = 6) => (n >= 0 ? "+" : "") + n.toFixed(1).padStart(w - 1);

rows.sort((a, b) => (b.bandsBakedVsLive[4] - b.bandsBakedVsLive[0]) - (a.bandsBakedVsLive[4] - a.bandsBakedVsLive[0]));

console.log("\nbaked - live, per band (dB). Negative sub/low + positive hi/air = tinnier.");
console.log("voice".padEnd(34) + BAND_LABELS.map((l) => l.padStart(7)).join("") + "   tilt   rms   peak(live→baked)");
for (const r of rows) {
  const tilt = r.bandsBakedVsLive[4] - r.bandsBakedVsLive[0];
  console.log(
    `${r.name}__${r.key}`.padEnd(34) +
    r.bandsBakedVsLive.map((d) => fmt(d, 7)).join("") +
    fmt(tilt, 8) + fmt(r.rmsDelta, 7) +
    `   ${r.livePeak.toFixed(2)}→${r.bakedPeak.toFixed(2)}`
  );
}

console.log("\nabsolute band levels of the live render (dBFS) — deltas in bands 30+ dB");
console.log("below the loudest band are inaudible bookkeeping, not a timbre change.");
console.log("voice".padEnd(34) + BAND_LABELS.map((l) => l.padStart(8)).join(""));
for (const r of rows) {
  console.log(`${r.name}__${r.key}`.padEnd(34) + r.bandsLiveAbs.map((d) => d.toFixed(1).padStart(8)).join(""));
}

console.log("\ncentroid Hz (live → baked), and how hot the raw graph is before any dynamics");
for (const r of rows) {
  console.log(
    `${r.name}__${r.key}`.padEnd(34) +
    `${r.centroidLive.toFixed(0)} → ${r.centroidBaked.toFixed(0)}`.padEnd(20) +
    `voice peak ${r.rawPeak.toFixed(2)}  file peak ${r.mp3Peak.toFixed(2)}`
  );
}
