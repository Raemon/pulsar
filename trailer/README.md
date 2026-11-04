# Pulsar trailer

`pulsar-trailer.mp4` is the finished 55s trailer. Everything else here rebuilds it.

## Steps

Run all of these from `trailer/`.

1. Start the game: `npx vite --port 5288 --strictPort` (from the repo root).
2. Render the stills:
   - `node title.mjs`
   - `node subtitle.mjs`
   - `node intro.mjs`
   - `node pulseaudio.mjs` (writes `pulse_audio.wav`)
3. Capture each scene, for `open`, `bass`, `comet`, `alien`, `bosslive` and `citadel`:
   - `node choreo.mjs specs/<scene>.json` validates the choreography and writes a report.
   - `node choreo.mjs specs/<scene>.json --capture` writes `scenes/<scene>.mp4` and `.wav`.
4. Build the soundtrack, then the spectrum ring data:
   - `python3 build.py --audio-only`
   - `python3 spectrum.py parts/audio.wav`

   This writes `spectra/<scene>.u8`, which the pulsar's spectrum ring follows. Recapture the scenes (step 3) after this.
5. Assemble the trailer: `python3 build.py`

Set `CHROMIUM_PATH` if Playwright can't find a browser on its own.

`choreo.js` is the in-page engine that drives the ship. Each spec lists:

- the scene setup (seed, wave, combo, rocks, aliens, comets);
- timed shots, which aim with smooth turns and fire on the beat;
- moves.
