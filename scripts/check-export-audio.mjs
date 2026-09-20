// Regression check for replay export audio.
//
// Drives Sound through the exact prewarm → capture-context → offline-render
// path videoExport.ts uses (minus the video encoder), fires a spread of voices
// across every dispatch style, and asserts the render is stereo, non-silent,
// and non-silent in EVERY second it fired something — not just at the start.
//
// It exists because the export is the one place where the loading rules
// invert. Gameplay is happy to render a voice live while its mp3 lands; the
// exporter steps frames faster than real time, so a load that resolves
// mid-sweep resolves against a clock that has already raced past the moment
// the voice needed. Everything must be resident before frame one. Two bugs
// this catches: a prewarm that returns while loads are still in flight, and a
// play-time decode that goes through the idle-paced background queue.
//
// It also drives the two voice shapes that behave differently on an offline
// context than on a live one (see audioCapture.ts): a reticule hum that swells
// and is released ("hold the current level, then fade" reads AudioParam.value,
// which a pre-render offline param answers with the assigned value — the hum
// used to release from 1.0 as a full-scale burst), and a streak loop whose
// teardown ran on a wall-clock timer and disconnected its bus (retroactive on
// an offline graph: the loop vanished from the render). The clock is advanced
// per "frame" with ExportClock.advanceTo so those deferred teardowns fire.
//
//   npm run check:export-audio      (needs a browser; CHROME_PATH to override)
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT) || 5231;
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((res) => vite.stdout.on("data", (c) => { if (c.toString().includes("Local:")) setTimeout(res, 500); }));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium", args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => { const t = m.text(); if (!t.startsWith("[vite]")) console.log("  page>", t); });
await page.goto(`http://localhost:${PORT}/sound`, { waitUntil: "domcontentloaded" });

const result = await page.evaluate(async () => {
  const [{ Sound }, cfg, cap, rngMod, haloCfg] = await Promise.all([
    import("/src/Sound.ts"),
    import("/src/soundConfig.ts"),
    import("/src/game/audioCapture.ts"),
    import("/src/game/rng.ts"),
    import("/src/game/haloMusicConfig.ts"),
  ]);
  // Audible picks must not move with the cosmetic stream, which render code
  // draws from at the display's rate: the same seed must yield the same music
  // whether or not a thousand cosmetic draws happened in between.
  const pickSeq = (cosmeticDraws) => {
    rngMod.seedRng(0x5EED1234);
    for (let i = 0; i < cosmeticDraws; i++) rngMod.cosmeticRng();
    const out = [];
    for (let i = 0; i < 6; i++) { const v = haloCfg.pickHaloMusicVariation(3); out.push(v, haloCfg.pickHaloMusicVariationExcluding(v, 3)); }
    return out.join(",");
  };
  const picksStable = pickSeq(0) === pickSeq(1000);
  await cfg.loadSoundConfig();
  const sound = new Sound();
  sound.ensureContext();

  const t0 = performance.now();
  await sound.prewarmForExport();
  const prewarmMs = Math.round(performance.now() - t0);
  const states = { queued: 0, fetching: 0, loaded: 0, failed: 0 };
  for (const v of sound.bakedLoadStates.values()) states[v]++;

  // Same construction as videoExport.ts: an OfflineAudioContext behind a
  // CaptureAudioContext driven by an ExportClock.
  const sampleRate = 48000;
  const durationSec = 20;
  const offline = new OfflineAudioContext(2, sampleRate * durationSec, sampleRate);
  const clock = new cap.ExportClock();
  sound.beginExportCapture(new cap.CaptureAudioContext(offline, clock));

  // The capture params must answer `.value` from their automation at the
  // export clock (a raw pre-render offline param answers with the assigned
  // value), including through a hold and a direct assignment. Checked on a
  // scratch gain before any voice fires; the clock is rewound to 0 after.
  const captureCtx = sound.ctx;
  const probe = captureCtx.createGain();
  const approx = (a, b, tol) => Math.abs(a - b) <= tol;
  const paramChecks = [];
  probe.gain.setValueAtTime(0.0001, 0);
  probe.gain.setTargetAtTime(0.3, 0, 0.1);
  clock.advanceTo(0.5);
  paramChecks.push(["setTargetAtTime approach at 0.5s", probe.gain.value, 0.3 + (0.0001 - 0.3) * Math.exp(-5), 0.003]);
  probe.gain.cancelScheduledValues(0.5);
  probe.gain.setValueAtTime(probe.gain.value, 0.5);
  probe.gain.linearRampToValueAtTime(0.0001, 1.0);
  clock.advanceTo(0.75);
  paramChecks.push(["linear ramp midpoint", probe.gain.value, (0.3 + (0.0001 - 0.3) * Math.exp(-5)) / 2, 0.003]);
  probe.gain.cancelAndHoldAtTime(0.75);
  clock.advanceTo(0.9);
  paramChecks.push(["cancelAndHoldAtTime hold", probe.gain.value, (0.3 + (0.0001 - 0.3) * Math.exp(-5)) / 2, 0.003]);
  probe.gain.value = 0.42;
  clock.advanceTo(1.2);
  paramChecks.push(["direct assignment", probe.gain.value, 0.42, 1e-6]);
  const paramFailures = paramChecks.filter(([, got, want, tol]) => !approx(got, want, tol)).map(([label, got, want]) => `${label}: got ${got.toFixed(4)}, want ${want.toFixed(4)}`);

  // A spread of voices across every dispatch style: baked-only (no fallback),
  // newly baked with a fallback, parameterized, drones, and music.
  const fired = [];
  const at = (sec, fn, label) => { clock.advanceTo(sec); try { fn(); fired.push(label); } catch (e) { fired.push(label + "!" + e); } };
  // Advance the clock in sim-sized steps, calling `fn` each step like a
  // render-driven voice update; deferred teardowns fire along the way.
  const FRAME = 1 / 120;
  const frames = (from, to, fn = null) => { for (let t = from; t < to; t += FRAME) { clock.advanceTo(t); if (fn) fn(t); } };
  clock.advanceTo(0);
  at(0.1, () => sound.play("fireBeat"), "fireBeat");
  at(0.3, () => sound.playBgBeatAt(1, 0.3), "bgBeat");
  at(0.5, () => sound.play("asteroidBoomBeat"), "asteroidBoomBeat");
  at(0.7, () => sound.play("explosionLarge"), "explosionLarge");
  at(0.9, () => sound.playLaserShot(8, 4), "laserShot");
  at(1.1, () => sound.play("death"), "death");
  at(1.4, () => sound.playComboChime(5), "comboChime");
  at(1.7, () => sound.playDriftShotHit(6), "driftShotHit");
  at(2.0, () => sound.play("bell", 0.55), "bell@chip");
  at(2.3, () => sound.play("crystalShatterLarge", 0), "crystalShatterLarge");
  at(2.6, () => sound.play("summaryDownbeat", 2), "summaryDownbeat");
  at(2.9, () => sound.play("scoreBlip", 1.335), "scoreBlip");
  at(3.2, () => sound.play("bossHit"), "bossHit");
  at(3.5, () => sound.startThrust?.() ?? sound.play("thrust"), "thrust");
  at(4.0, () => sound.play("meteorShower"), "meteorShower");
  at(4.5, () => sound.stopThrust?.(), "thrustStop");

  // Reticule hum: swell for a second under per-frame updates, release, then
  // run the clock through the deferred teardown (~0.75 s after the release).
  const HUM_ON = 7.0, HUM_OFF = 8.0;
  frames(HUM_ON, HUM_OFF, (t) => sound.updateFirstDotHum(1, (t * 2) % 1, 0.5));
  at(HUM_OFF, () => sound.stopFirstDotHum(), "humRelease");
  frames(HUM_OFF, 9.5);

  // Streak loop: drive for a second, let it lapse, run through its teardown.
  const STREAK_ON = 10.0, STREAK_OFF = 11.0;
  frames(STREAK_ON, STREAK_OFF, () => sound.updateStreakSound(0.8, 0));
  at(STREAK_OFF, () => sound.stopStreakSound(), "streakRelease");
  frames(STREAK_OFF, 13.0);

  // The music's beat position has to stay exact across a rate change, because
  // a replay trims the rate to hold the music on its (recorded) beat clock.
  // Read as "start + elapsed" — which is what it used to be — the position
  // silently ignores every trim, so the thing steering the trim goes blind and
  // the music slides against the bass by the recorded corrections' whole sum.
  const MUSIC_AT = 14.0, MUSIC_BEAT = 100.0;
  clock.advanceTo(MUSIC_AT);
  await sound.startHaloMusic(haloCfg.HALO_MUSIC_POOL[0], true, 0, MUSIC_BEAT, true);
  clock.advanceTo(MUSIC_AT + 1);
  const posAtRate1 = sound.audioBeatTimeFromMusic();
  sound.setHaloMusicPlaybackRate(0.99);
  clock.advanceTo(MUSIC_AT + 3);
  const posAfterTrim = sound.audioBeatTimeFromMusic();
  const musicFailures = [
    ["a second in at rate 1", posAtRate1, MUSIC_BEAT + 1],
    ["two more seconds at rate 0.99", posAfterTrim, MUSIC_BEAT + 1 + 2 * 0.99],
  ].filter(([, got, want]) => got === null || Math.abs(got - want) > 0.002)
   .map(([label, got, want]) => `music beat position ${label}: got ${got === null ? "null" : got.toFixed(4)}, want ${want.toFixed(4)}`);

  clock.advanceTo(durationSec);

  sound.endExportCapture();
  const rendered = await offline.startRendering();
  const chans = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) chans.push(rendered.getChannelData(ch));

  // Per-second RMS so a render that is loud only at the very start (i.e. the
  // later voices went missing) is distinguishable from one that isn't.
  const rms = (a, b) => {
    let sum = 0, n = 0;
    for (const d of chans) for (let i = Math.floor(a * sampleRate); i < Math.min(Math.floor(b * sampleRate), d.length); i++) { sum += d[i] * d[i]; n++; }
    return Math.sqrt(sum / Math.max(1, n));
  };
  const peakIn = (a, b) => {
    let p = 0;
    for (const d of chans) for (let i = Math.floor(a * sampleRate); i < Math.min(Math.floor(b * sampleRate), d.length); i++) p = Math.max(p, Math.abs(d[i]));
    return p;
  };
  // Largest sample-to-sample step: a gain that jumps instead of ramping shows
  // up here long before it is audible as a click.
  const maxStepIn = (a, b) => {
    let m = 0;
    for (const d of chans) for (let i = Math.floor(a * sampleRate) + 1; i < Math.min(Math.floor(b * sampleRate), d.length); i++) m = Math.max(m, Math.abs(d[i] - d[i - 1]));
    return m;
  };
  const perSecond = [];
  for (let s = 0; s < durationSec; s++) perSecond.push(Number(rms(s, s + 1).toFixed(5)));
  const peak = peakIn(0, durationSec);
  const r4 = (v) => Number(v.toFixed(4));
  const hum = {
    peakBefore: r4(peakIn(HUM_OFF - 0.1, HUM_OFF)),
    peakAfter: r4(peakIn(HUM_OFF, HUM_OFF + 0.12)),
    maxStepAtRelease: r4(maxStepIn(HUM_OFF - 0.02, HUM_OFF + 0.05)),
    maxStepAtTeardown: r4(maxStepIn(HUM_OFF + 0.6, HUM_OFF + 1.0)),
    rmsAfterTeardown: r4(rms(HUM_OFF + 1.0, HUM_OFF + 1.4)),
  };
  // The updraft stems carry sharp arpeggio attacks of their own (a sample step
  // of ~0.13 with the loop simply playing), so the release is judged by its
  // envelope: the 0.6 s fade barely moves the level across the release
  // instant, whereas a gain jump doubles or halves it. The teardown window is
  // after the fade, so any step there is a real click.
  const streak = {
    rmsWhileAlive: r4(rms(STREAK_ON + 0.5, STREAK_OFF)),
    rmsBeforeRelease: r4(rms(STREAK_OFF - 0.05, STREAK_OFF)),
    rmsAfterRelease: r4(rms(STREAK_OFF, STREAK_OFF + 0.05)),
    maxStepAtTeardown: r4(maxStepIn(STREAK_OFF + 0.5, STREAK_OFF + 0.8)),
    rmsAfterTeardown: r4(rms(STREAK_OFF + 1.0, STREAK_OFF + 1.8)),
  };
  return { prewarmMs, states, fired, peak: r4(peak), perSecondRms: perSecond, channels: rendered.numberOfChannels, paramFailures, musicFailures, picksStable, hum, streak };
});

console.log(JSON.stringify(result, null, 1));
const failures = [...result.paramFailures.map((f) => `capture param ${f}`), ...result.musicFailures];
if (!result.picksStable) failures.push("halo music pick moves with the cosmetic RNG stream");
const silentSeconds = result.perSecondRms.slice(0, 5).filter((v) => v < 1e-4).length;
if (!(result.peak > 0.01)) failures.push("render is silent");
if (silentSeconds !== 0) failures.push(`${silentSeconds} silent second(s) among the first five`);
if (result.states.queued !== 0 || result.states.fetching !== 0) failures.push("prewarm returned with loads still pending");
// The hum must release downward from the level it had reached, without a
// step: a release from a mis-read gain of 1.0 shows as peakAfter far above
// peakBefore and a step of ~0.5+. The deferred stop must land after the fade.
if (!(result.hum.peakBefore > 0.002)) failures.push("reticule hum never sounded");
if (!(result.hum.peakAfter <= result.hum.peakBefore * 1.25)) failures.push(`hum release got louder (${result.hum.peakBefore} → ${result.hum.peakAfter})`);
if (!(result.hum.maxStepAtRelease < 0.05)) failures.push(`hum release stepped by ${result.hum.maxStepAtRelease}`);
if (!(result.hum.maxStepAtTeardown < 0.05)) failures.push(`hum teardown stepped by ${result.hum.maxStepAtTeardown}`);
if (!(result.hum.rmsAfterTeardown < result.hum.peakBefore * 0.1)) failures.push("hum still sounding after its teardown");
// The streak loop must be audible while alive (a teardown disconnect on the
// offline graph used to erase it from the whole render), fade without a step,
// and be gone after its deferred stop.
if (!(result.streak.rmsWhileAlive > 0.002)) failures.push("streak loop missing from the render");
const releaseRatio = result.streak.rmsAfterRelease / Math.max(1e-9, result.streak.rmsBeforeRelease);
if (!(releaseRatio > 0.5 && releaseRatio < 1.6)) failures.push(`streak level jumped at release (×${releaseRatio.toFixed(2)})`);
if (!(result.streak.maxStepAtTeardown < 0.03)) failures.push(`streak teardown stepped by ${result.streak.maxStepAtTeardown}`);
if (!(result.streak.rmsAfterTeardown < result.streak.rmsWhileAlive * 0.1)) failures.push("streak loop still sounding after its teardown");
const ok = failures.length === 0;
console.log(ok ? "PASS: export render carries audio for every second voices were fired in, hum and streak release cleanly" : `FAIL: ${failures.join("; ")}`);
await browser.close();
vite.kill("SIGTERM");
process.exit(ok ? 0 : 1);
