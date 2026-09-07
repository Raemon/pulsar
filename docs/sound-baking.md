# Baked sounds

Every sound effect in Pulsar is described exactly once, as a Web Audio graph
built by a `build*Graph(ctx, dest, t, …)` method on `Sound`. That one
description gets used two ways:

- **baked** — rendered offline into an `OfflineAudioContext`, encoded to
  `public/sounds/baked/<name>__<key>.mp3`, and played back as a buffer;
- **live** — built straight into the live `AudioContext` at play time.

The live path is the fallback. A voice plays live only while its mp3 is still
in flight (or missing/failed), which is why adding a bake can never make a
sound disappear — the worst case is the game does exactly what it did before
the file existed.

Key facts:

- The bake key is `pitchRatio` in `playBaked(name, key)`, quantized to four
  decimals for the filename. It usually isn't a pitch at all — it's whatever
  discrete parameter distinguishes the variants (a tier, a chord index, a
  fundamental in Hz).
- Rendering happens in the browser (`Sound.bakeSound`), dev-only, and POSTs
  the WAV to the `/__bake-dump__` hook in `vite.config.ts`, which pipes it
  through ffmpeg. **Existing files win** — the hook refuses to overwrite, so
  ordinary dev play never churns good bakes.
- A one-shot mp3 holds the **bare voice**, with none of the master chain in
  it, and plays back through the same compressor + limiter the live fallback
  does. Its encode level is normalized and undone on decode via
  `bake-gains.json` (see *Where a bake can drift*, 1 and 1b).
- `npm run check:bake-fidelity` renders every one-shot both ways and prints
  the per-band difference — the check that a bake still sounds like its graph.
  `npm run check:mix-stress` is the companion for the busy-moment mix.
- `npm run bake` does that headlessly: boots `vite dev`, opens the page in
  Chromium (`playwright-core`, `CHROME_PATH` to point at a browser), and waits
  for `warmBakedCache` to drain. Requires ffmpeg with libmp3lame on PATH.
  `npm run bake -- --list` reports cache state without writing anything.

---

## When each sound loads

`src/game/soundSchedule.ts` declares, for every baked variant, the earliest
wave it can be heard on — and those numbers are mostly `CFG.<thing>.firstWave`,
the same value the wave director gates the spawn on, so a spawn rule and its
sound can't drift apart. `Sound` walks that schedule and loads in that order.

**The gate** is the set marked `gate: true`: 21 files, ~560 KB, and it is the
only thing the title screen waits on. The bar for joining it is narrow — a
cache miss on this voice is *silent* (its play path has no live-synth
fallback) **and** it can be heard in the first seconds. That's `bgBeat`'s
opening intensity bucket, `fireBeat`, the three engine drones, the charge bed
and laser-shot tiers, and the first three hover hums. Everything with a live
fallback stays out: the worst case there is one hit rendering the way the game
rendered it before the cache existed, which is inaudible, and not worth a
second of start latency.

**Everything else** drains through one paced queue, ordered by
`max(0, job.wave - currentWave)` and then by declaration order.
`setLoadWave(wave)` (called from `updateBgBeatIntensity`, so once per wave)
moves the front of the queue along with the run.

The pacing has two separate limits because there are two separate costs:

- **Fetches** are network-bound and nearly free on the main thread, so they
  are not idle-gated at all — 6 run at once and the response is assembled off
  the main thread.
- **`decodeAudioData` is the expensive one**, and a hundred of them landing
  together is what starves the beat scheduler (the symptom that already forced
  the halo-music preload to be hand-spread). Every background decode in the
  game — baked one-shots, music stems, vocal takes — goes into one queue,
  drained inside `requestIdleCallback` with a 6 ms wall-clock budget per slot.

  Two things about that were learned the hard way and are worth not
  re-litigating. Gating the *fetch* on idle too just cost a frame of latency
  per file for nothing. And demanding a minimum `timeRemaining()` before
  taking an idle slot is worse than useless: on a page that never has that
  much headroom the queue spins until the timeout fires and throughput
  collapses to one slot per timeout. `requestIdleCallback` firing already
  means the browser has nothing better to do — take the slot.

Measured on a synthetic frame loop that deliberately burns 8 ms of every
frame: gate resolves in ~200 ms, the remaining ~180 files drain at ~2.4/s, and
the worst frame stall is indistinguishable from the loop's own jitter.

A **cache miss at play time skips all of it**: `playBaked` promotes that job
and decodes it immediately. Pacing exists to protect the frame loop from work
nobody is waiting on; there, somebody is.

### Export inverts the rules

Gameplay is happy to render a voice live while its mp3 lands. The replay
exporter is not: it steps frames faster than real time, so a load resolving
mid-sweep resolves against a clock that has already raced past the moment the
voice needed to start. Everything must be resident before frame one, which is
what `prewarmForExport` → `loadAllAssets()` is for.

Two rules follow, and both are easy to break by accident:

- **Awaiting a job that is already in flight must await *that* load**, not a
  fresh resolved promise. `AssetJob.inFlight` exists only for this; without it
  the prewarm skips straight over the handful the pacer happens to be holding.
- **Anything that awaits a buffer in order to play it now decodes
  immediately** — `startHaloMusic`, `crossfadeHaloMusic`, `startHaloFullMusic`,
  `playPilotLog`. They each reserve a start time and then await; routing that
  await through the idle-paced queue makes the cue late or drops it, in normal
  play as well as in an export. Only true preloads pace.

`npm run check:export-audio` drives the real prewarm → capture-context →
offline-render path and asserts the render is stereo, non-silent, and
non-silent in every second it fired a voice.

One consequence worth knowing: **`bgBeat`'s intensity buckets are derived from
`CFG.bgBeatIntensity`**, not hardcoded. The ramp runs 0.6 → 1.0 over 30 waves,
so only 5 of the 11 buckets are reachable and the other 24 files are never
requested. They stay on disk deliberately — retuning the ramp re-schedules
them and the file is already there, and `bgBeat` is the one voice where a miss
is always silent.

---

## Inventory

### Now baked (this pass added 97 variants)

| Voice | Variants baked | Key | Notes |
| --- | --- | --- | --- |
| `fire` | 1 | — | reads the `fire` semantic config block |
| `calibrationTap` | 1 | — | same recipe as `fire` minus the attack ramp |
| `explosionLarge/Medium/Small` | 3 | — | one graph, three config blocks |
| `asteroidBoomBeat` | 1 | — | rendered flat; the ±3% per-hit wobble rides as a `playbackRate` |
| `death` | 1 | — | config-driven |
| `bassHit`, `bassEcho` | 2 | — | |
| `bell` | 3 | pitch ratio | `1` (asteroid toll), `1.189` (wave-summary row), `0.55` (non-lethal chip) |
| `warble`, `comboTick`, `tink`, `shieldPop` | 4 | — | |
| `comboSparkle` | 2 | duration scale | `1` in game, `0.5` in the killed parade |
| `crystalShatterLarge/Small` | 6 | ring pitch ratio | `0` = the on-beat "snap to G" sentinel, `1` = natural, `0.55` = non-lethal chip |
| `scoreBlip` | 7 | pitch ratio | the distinct pitches of the drain's 16-step line |
| `summaryDownbeat` / `…Ducked` | 8 | chord index | the i–VI–III–VII rotation, ducked and not |
| `pulsarHum` | 1 | — | 20 s graph, rendered to 5 s (see *tails*) |
| `shockwaveCharge`, `shockwaveBoom` | 2 | — | 12 s windup and the drop |
| `alienFireBig/Medium` | 8 | riff variant 0–3 | 8-shot cycle × 2 samples collapses to 4 renders each |
| `alienFireSmall`, `alienHit`, `alienExplode` | 3 | — | |
| `meteorShower`, `gemSwarm` | 2 | — | |
| `canisterAppear`, `canisterDestroyed` | 2 | — | |
| `comboLost`, `comboLostFire` | 2 | — | |
| `bossPulse`, `bossHit`, `bossEyeOpenStinger` | 3 | — | |
| `driftShotHit` | 6 | drift tier 1–6 | |
| `laserCharge` | 4 | charge dot 1–4 | |
| `laserChargeFail` | 1 | — | |
| `comboChime` | 24 | fundamental (Hz) | see below |

### Already baked before this pass

`bgBeat`, `fireBeat`, `chime`, `drainChime`, `powerup`, `waveClear`,
`bassKick/Boom/Pluck/Snap`, `cometNote`, `cometDestroyed(Sad)`, `bonusLife`,
`laserShot`, `chargeBed`, `streakShimmer`, `thrust`/`reverseThrust`/
`sideThrust`, `bassteroidDrone`, `alienDrone`, `firstDotHum`, `warbleDrone`,
and the four ElevenLabs `wraith*` one-shots.

### Deliberately still live

| Voice | Why | What baking it would take |
| --- | --- | --- |
| `startCometShimmer` | An indefinite pad whose first ~4 s is a scripted entrance (whoosh sweep, tension cluster) and whose remainder is a steady drone with three independent slow tremolos. | Split it the way `warbleDrone` is split: bake the entrance as a one-shot, bake the steady state as a seamless loop with every LFO rate snapped by `snapToLoop`, and cross the two at the seam. |
| `startHaloAmbient` | Same shape, plus two live morphs (`setHaloAmbientTier`, `setHaloAmbientCometMode`) that reshape the voicing while it sustains. | Bake one seamless loop per endpoint state and crossfade, exactly as `warbleDrone` does for phased-in/phased-out. |
| `playChime` at non-1 pitch | Already plays the baked buffer through `playbackRate`. | — |
| `bell` / `scoreBlip` / `crystalShatter` at pitches outside the tables above | The music page's piano roll can trigger them at arbitrary pitch. | Nothing — the live fallback is the feature here. But check gameplay call sites before assuming a pitch is rare: `onAsteroidCrackedByBullet` plays the body's own kill sound at 0.55 for a non-lethal chip, which is a *common* key and is baked. |
| `playComboChime` at `durationScale ≠ 1` | Only the killed-parade replay shortens the note; a stretched buffer would shorten the attack and detune it. | — |

### The comboChime refactor

`playComboChime` was the one voice that genuinely rendered "slightly different
ways in different situations": the note it plays depends on the combo value
*and* on which halo music is up, because each music variation gets its own
13-note modal tail (minor/dorian, major pentatonic, or no-3rd). Keyed the
obvious way — (variation, combo step) — that's 42 renders.

The three tails overlap heavily, so the code now keys the bake by **the
fundamental in Hz** instead. 42 combinations collapse to 24 distinct notes,
`comboChime__261.6300.mp3` is shared by all three scales, and re-ordering or
extending a tail reuses the notes it already has rather than invalidating
every file. `Sound.COMBO_CHIME_PITCHES` is derived from the three tail tables,
so the enumeration can't drift from the thing being enumerated.

The same trick shrinks `alienFireBig/Medium`: an 8-step riff over 2 sampled
guitars looks like 8 renders per size, but the note alternates every shot and
the sample flips at the halfway point, so there are only 4 distinct
(sample, note) pairs. `Sound.alienFireVariant(step)` does that mapping.

---

## Where a bake can drift from the live render

Worth reading before adding a voice to the registry — most of these are the
reason a baked sound comes out subtly wrong rather than obviously broken.

**1. What a file holds, and which leg it plays on.** A raw-voice bake — every
`oneShotGraph` recipe and every seamless drone loop — is the bare output of
the graph, nothing else. It plays back through `chSfxLive → liveSum →
compressor → limiter → soft clip`, the same chain the live fallback of that
same graph runs through, so the baked and live legs are the same signal by
construction and a cache miss is inaudible.

The files that *do* carry their own dynamics are the Tone recipes (rendered
through the Tone engine's compressor + limiter) and the ElevenLabs `wraith*`
one-shots, which arrived mastered. `Sound.PREMASTERED_BAKES` lists them, and
they alone take the baked leg: `chSfxBaked → bakedSum → glue → trim →
limiter → soft clip`. The glue (2.5:1 above −10 dB, slow release, trimmed by
`BAKED_GLUE_TRIM` to unity for a lone voice) is there because per-file
dynamics cannot duck one voice against another: a same-frame stack of
pre-limited mp3s used to hit the master limiter with the full linear sum,
which the limiter — a DynamicsCompressor at 20:1, not a true brick wall —
passed partly through to hard-clip at the DAC.

This is worth stating plainly because the first version of the baked path did
the opposite: it rendered each one-shot through a frozen copy of the master
chain, so every mp3 was a snapshot of one voice compressed *alone*, and then
played that snapshot through the glue instead of the compressor. Measured
against its own live fallback, `comboTick` came back 8 dB down, `fire` lost
8 dB of its tick, and everything quiet sat about 1.6 dB under — the thin,
tinny versions of themselves. A mix cannot be pre-rendered; only a voice can.
`scripts/check-bake-fidelity.mjs` is the guard: it renders every one-shot both
ways and reports the per-band difference, which should be a fraction of a dB
in any band carrying audible energy.

**1b. Encode gain.** Raw voices span a huge range — `comboSparkle` peaks at
0.10 and `asteroidBoomBeat` at 3.85 — so each render is normalized to
`BAKE_ENCODE_PEAK` before ffmpeg sees it and scaled back on decode by the
multiplier in `public/sounds/baked/bake-gains.json`, which the dev bake hook
writes beside the mp3s. Headroom is a property of the file, never of the
sound. A file with no manifest entry plays at the level it was rendered at.

**2. The compressor is program-dependent.** A bake can only ever capture one
voice; how voices duck each other is a property of the moment they land in.
That is exactly why raw bakes keep the compressor live rather than freezing
it into the file, and why the pre-mastered files — which have no choice —
still need the glue.

**3. Tails get chopped.** `ONE_SHOT_BAKE_LEN` must cover the graph's latest
`stop()`, not its perceptual length. A chop is an audible click, and it also
throws away reverb/echo tails that the live path would have kept ringing
(`asteroidBoomBeat`'s 1.3 s convolution tail outlasts every oscillator in the
graph). Overshooting is nearly free — trailing silence is what VBR mp3
compresses best. One entry deliberately undershoots the graph's stop time:
`pulsarHum` runs oscillators for 20 s but the rendered file is already at
−71 dBFS by 4.9 s, so cutting at 5.0 s is inaudible.

**3b. Channel count.** A one-shot renders mono unless it's listed in
`STEREO_BAKES`. A 1-channel offline context downmixes any genuinely stereo
node to `0.5·(L+R)`, which for the decorrelated noise in a reverb IR costs
~3 dB of wet level and all of the stereo width — the live path plays it into a
stereo destination and keeps both. `asteroidBoomBeat` is the only newly-baked
voice this applies to (its convolver runs a 2-channel IR).

**4. Noise buffers are shared, and only within a session.** The live path
caches one white-noise buffer per duration (`makeNoiseBuffer`), so repeated
plays of `explosionLarge` already reuse the same noise — but a fresh draw
happens on every page load. Baking freezes one particular draw forever.
White noise is white noise, so this is a statistical identity rather than a
sample-for-sample one; it is only worth worrying about for a voice whose
character comes from a *specific* noise realization, and none do.
`Sound.noiseBuffer(ctx, dur)` routes to the live cache when it's handed the
live context and allocates fresh otherwise, so the live path's allocation
behaviour is unchanged.

**5. Context-owned buffers can't cross contexts.** `boomReverbIR` caches its
impulse response for the live context only; an offline render builds its own.
A cached live buffer used in an offline render is a silent-failure class of
bug. (`AudioBuffer`s that come from `decodeAudioData` — the guitar samples —
*are* portable, which is why the sampled alien voices can bake at all.)

**6. Randomness in the recipe freezes.** `asteroidBoomBeat` picked a fresh ±3%
pitch jitter per hit; baked, that would become one fixed pitch and a burst of
kills would read as a single sample retriggering. The jitter now rides as a
`playbackRate` on the buffer source (the same trick `laserShot` uses), so the
variation survives. Note that a `playbackRate` wobble shifts the noise layers
along with the oscillators, where the live jitter only detuned the two
oscillators — at ±3% that is not audible, but it is a real difference.

**7. Config is frozen into the render.** `cfgN(...)` semantic knobs — `fire`'s
body/tick shape, the explosion trio, `death`, `bell`, `tink` — are read inside
the graph builders, so their values land in the mp3. **After editing a
semantic knob in `public/sounds/config.json`, delete that voice's mp3 and
re-bake, or the change won't be audible.** The bake script loads the config
before rendering anything, so it never freezes the hardcoded fallbacks.

The `universal` knobs behave differently, and not well: `volume` is applied by
`play()` through the per-call master swap, which `playBaked` bypasses, and
`pitch` is ignored by every voice that doesn't thread `pitchRatio` into its
recipe. So for a baked voice both universal knobs are dead. Today that changes
nothing — every voice baked here has `volume: 1` — but `fireBeat`'s
`volume: 0.93` and `pitch: 1.24` are already being silently dropped, and any
future tuning through the universal knobs on a baked sound will be too. Worth
fixing separately; it is not a regression from this change.

**8. Timing.** Live voices scheduled through `playAt` (the wave-summary cues)
have to honour `scheduledWhenForCall`, which is what `voiceTime(name)` is for.
All the new wrappers pass `voiceTime(name)` rather than `currentTime`, so the
live fallback lands on the same sample as the baked buffer would.

**9. The same-sound pileup duck.** `playBaked` attenuates the k-th copy of one
key started within 30 ms to `1/√k`, because identical buffers sum coherently
in a way live re-synthesis doesn't quite. So a same-frame multi-kill is
slightly quieter baked than live. That is intentional (it's what stopped the
mix clipping), and it now applies to voices that previously piled up
unattenuated.

**10. Sample rate.** Renders happen at the baking machine's `AudioContext`
rate; playback decodes and resamples to the player's. Nothing to do, but it
means bakes are not bit-reproducible across machines.

---

## Adding a voice to the bake

1. Split the play method into a `build<Name>Graph(ctx, dest, t, …)` that
   touches no live state — no `this.ctx`, no `this.master`, no
   `ctx.currentTime`, all times relative to `t`.
2. Make the play method `if (this.playBaked(name, key)) return;` and then call
   the builder into `this.master` at `this.voiceTime(name)`. Both legs end up
   in the same place — `playBaked` sends a raw bake to `this.master` too.
3. Register the builder in `Sound.oneShotGraph` and add a length to
   `Sound.ONE_SHOT_BAKE_LEN`.
4. Add the variants to `SOUND_LOAD_SCHEDULE` with the earliest wave they can
   be heard on — prefer `CFG.<thing>.firstWave` over a literal. Leave `gate`
   off: the gate is for voices with no fallback, and a voice you just added to
   the registry has one.
5. `npm run bake`, then commit the mp3s.

If you add a variant whose key the game computes rather than declares (a pitch
threaded through `play()`, a config-scaled ratio like `bassPluck`'s), check the
call sites — a key nobody scheduled loads on demand at first play, every
session, forever.
