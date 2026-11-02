import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const page = await b.newPage();
page.on("console", (m) => console.log("  page>", m.text().slice(0, 200)));
await page.goto("http://localhost:5288/sound", { waitUntil: "domcontentloaded", timeout: 300000 });
const wav = await page.evaluate(async () => {
  const [{ Sound }, cfg, cap] = await Promise.all([import("/src/Sound.ts"), import("/src/soundConfig.ts"), import("/src/game/audioCapture.ts")]);
  await cfg.loadSoundConfig();
  const sound = new Sound();
  sound.ensureContext();
  await sound.prewarmForExport();
  const sr = 48000, dur = 57;
  const offline = new OfflineAudioContext(2, sr * dur, sr);
  const clock = new cap.ExportClock();
  sound.beginExportCapture(new cap.CaptureAudioContext(offline, clock));
  sound.bgBeatIntensity = 0.6;
  for (let q = 0; q * 0.5 < 56; q++) { clock.advanceTo(q * 0.5); sound.playBgBeatAt((q & 1) ? 1.122 : 1, q * 0.5); }
  clock.advanceTo(dur);
  sound.endExportCapture();
  const r = await offline.startRendering();
  const blob = cap.encodeWavBlob(r);
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
});
writeFileSync("pulse_audio.wav", Buffer.from(wav));
await b.close();
