"""Per-frame AnalyserNode spectra of the trailer mix, one file per scene.

The game's pulsar ring reads Sound.readSpectrum() (an AnalyserNode on the
master bus: fftSize 1024, smoothing 0.78, -100..-30 dB). Offline capture has
no live analyser, so we compute the same bytes from the finished soundtrack and
hand each scene the slice that plays under it: scene frame f sits at trailer
time (clip start - in-point) + f/60.
"""
import ast, subprocess, sys
import numpy as np

AUDIO = sys.argv[1] if len(sys.argv) > 1 else "parts/audio.wav"
SR, N, TAU, FPS = 48000, 1024, 0.78, 60
src = open(sys.argv[2] if len(sys.argv) > 2 else "build.py").read()
clips = next(ast.literal_eval(n.value) for n in ast.parse(src).body
             if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "CLIPS")
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", AUDIO, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                     capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.float32)
n = np.arange(N)
win = 0.42 - 0.5 * np.cos(2 * np.pi * n / N) + 0.08 * np.cos(4 * np.pi * n / N)   # WebAudio Blackman (a=0.16)
frames = len(x) * FPS // SR
smooth = np.zeros(N // 2)
out = np.zeros((frames, N // 2), dtype=np.uint8)
for k in range(frames):
    end = k * SR // FPS
    seg = x[max(0, end - N):end]
    seg = np.pad(seg, (N - len(seg), 0))
    mag = np.abs(np.fft.rfft(seg * win))[: N // 2] / N
    smooth = TAU * smooth + (1 - TAU) * mag
    db = 20 * np.log10(np.maximum(smooth, 1e-12))
    out[k] = np.clip(255 * (db + 100) / 70, 0, 255).astype(np.uint8)
spec_secs = {}
for t0, sc, sin, dur, _ in clips:
    off = t0 - sin
    f = np.arange(int((sin + dur + 1.0) * FPS))
    k = np.clip(np.round((off + f / FPS) * FPS).astype(int), 0, frames - 1)
    out[k].tofile(f"spectra/{sc}.u8")
    print(sc, "offset", off, "frames", len(f))
