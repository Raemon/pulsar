"""Assemble the trailer as one continuous soundtrack.

Every clip is placed so (trailer start - scene in-point) is a whole number of
bars (2 s). Each scene's own beat clock starts at 0 on a bar, so the game's
bassteroid kit, hits and lightning in every clip land on the same grid as one
continuous game pulse (rendered once, under the whole trailer) and the score
(cinematic-el stems, phase-continuous). The score never drops out; it only
swells and hushes.
"""
import os, subprocess, sys

S = "scenes"
VO_FILE = "../public/sounds/vocals/in-use/6x/ralf-deep.mp3"
STEM = "../public/sounds/halo-music/cinematic-el-{}.mp3"
ENC = "-c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -r 60".split()
ZOOM = "scale=2208:1242:flags=lanczos,crop=1920:1080"
AUDIO_ONLY = "--audio-only" in sys.argv
BAR = 2.0

INTRO = 4.0                # hints every 2 beats; the last is in by beat 8
HOLD = 4.0                 # ...and hangs 8 beats while the first shot dissolves in under it
# (trailer start, scene, scene in, duration, extra video filter)
CLIPS = [
    (4.0, "open", 0, 16.55, ",fade=t=in:st=0:d=4.0"),   # dissolves in over the HOLD   # cut on the last hit's impact
    (20.55, "bass", 0.55, 5.45, ""),
    (26.0, "comet", 0, 4, ""),
    (30.0, "alien", 0, 4.5, ""),
    (34.5, "bosslive", 4.5, 2.0, ""),
    (36.5, "citadel", 0.5, 11.5, ",fade=t=out:st=9.0:d=2.5"),
]
VO = 18.0                  # bar after ×6 (×6 at 16.5)
TITLE, END = 50.0, 55.0
TM, TP, TV = 12.0, 18.0, 26.0   # bed (bar after ×4), piano (×6), violin (×12)
GAME_GAIN, DUCK_GAIN, PULSE_GAIN = 1.25, 0.6, 0.9

for t0, sc, sin, dur, _ in CLIPS:
    off = t0 - sin
    assert abs(off / BAR - round(off / BAR)) < 1e-6, f"{sc}: offset {off} is not a whole number of bars"

def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)

if not AUDIO_ONLY:
    os.makedirs("parts", exist_ok=True)
    ff("-f", "lavfi", "-i", f"color=black:s=1920x1080:r=60:d={INTRO}", "-framerate", "60", "-i", "intro/f%04d.png",
       "-filter_complex", f"[0][1]overlay=eof_action=pass,trim=duration={INTRO}", *ENC, "parts/c0.mp4")
    names = ["c0.mp4"]
    for i, (_, sc, sin, dur, extra) in enumerate(CLIPS, 1):
        if sc == "open":
            # the held hint lines ride over the opening as it dissolves in from black
            ff("-ss", str(sin), "-i", f"{S}/{sc}.mp4", "-framerate", "60", "-start_number", str(int(INTRO * 60)), "-i", "intro/f%04d.png", "-t", str(dur),
               "-filter_complex", f"[0]{ZOOM}{extra}[g];[g][1]overlay=eof_action=pass", "-an", *ENC, f"parts/c{i}.mp4")
        else:
            ff("-ss", str(sin), "-i", f"{S}/{sc}.mp4", "-t", str(dur), "-vf", ZOOM + extra, "-an", *ENC, f"parts/c{i}.mp4")
        names.append(f"c{i}.mp4")
    gap = TITLE - (CLIPS[-1][0] + CLIPS[-1][3])
    ff("-f", "lavfi", "-i", f"color=black:s=1920x1080:r=60:d={gap}", *ENC, "parts/gap.mp4"); names.append("gap.mp4")
    # title lands on the downbeat; the subtitle breathes in a second later
    ff("-loop", "1", "-framerate", "60", "-i", "title.png", "-loop", "1", "-framerate", "60", "-i", "subtitle.png", "-t", str(END - TITLE),
       "-filter_complex", f"[1]format=rgba,fade=t=in:st=1.0:d=1.4:alpha=1[sub];[0][sub]overlay=shortest=1,"
       f"fade=t=in:st=0:d=0.12,fade=t=out:st={END - TITLE - 1.0}:d=1.0", *ENC, "parts/title.mp4"); names.append("title.mp4")
    open("parts/list.txt", "w").write("".join(f"file '{n}'\n" for n in names))
    ff("-f", "concat", "-safe", "0", "-i", "parts/list.txt", "-c", "copy", "parts/video.mp4")

ms = lambda t: int(round(t * 1000))
inputs = ["pulse_audio.wav"] + [f"{S}/{c[1]}.wav" for c in CLIPS] + [VO_FILE, STEM.format("ambient"), STEM.format("melodic"), STEM.format("layer3")]
I_PULSE, I_VO = 0, 1 + len(CLIPS)
I_AMB, I_MEL, I_L3 = I_VO + 1, I_VO + 2, I_VO + 3
g = [f"[{I_PULSE}]aresample=44100,atrim=0:{END},volume={PULSE_GAIN}[pulse]"]
sfx = []
for i, (t0, sc, sin, dur, _) in enumerate(CLIPS, 1):
    # 30 ms crossfades at cuts: the beat underneath never stops, so hard cuts don't click
    fout = 2.5 if sc == "citadel" else 0.03
    # the opening's last kill rings on under the cut into the next shot
    tail = 0.8 if sc == "open" else 0.0
    if tail: fout = tail
    g.append(f"[{i}]aresample=44100,atrim={sin}:{sin + dur + tail},asetpts=PTS-STARTPTS,afade=t=in:d={HOLD if sc == "open" else 0.03},"
             f"afade=t=out:st={dur + tail - fout}:d={fout},adelay={ms(t0)}|{ms(t0)}[x{i}]")
    sfx.append(f"[x{i}]")
phrases = [(0.3, 1.0), (3.3, 4.6), (7.5, 9.1), (11.0, 12.3), (14.9, 16.6), (18.0, 19.2), (20.8, 22.3), (24.0, 24.9), (28.2, 29.2), (30.4, 31.7)]
duck = "+".join(f"between(t,{VO + a:.2f},{VO + b:.2f})" for a, b in phrases)
# "Ain't" is a soft vowel that lands on the alien fight's first hit: duck that hit hard for its quarter-second
aint = f"between(t,{VO + 14.8:.2f},{VO + 15.25:.2f})"
g.append(f"{''.join(sfx)}amix=inputs={len(sfx)}:normalize=0,volume='{GAME_GAIN}*if({aint},0.3,if({duck},{DUCK_GAIN},1))':eval=frame[game]")
g.append(f"[{I_VO}]aresample=44100,volume=1.8,adelay={ms(VO)}|{ms(VO)}[vo]")

def env(points):
    """piecewise-linear gain over trailer time t (points: [(t, gain), ...])."""
    expr = f"{points[-1][1]}"
    for (t0, g0), (t1, g1) in reversed(list(zip(points, points[1:]))):
        expr = f"if(lt(t,{t1}),{g0}+({g1}-{g0})*(t-{t0})/{max(t1 - t0, 1e-3)},{expr})"
    return f"if(lt(t,{points[0][0]}),0,{expr})"
CIT_OUT, CIT_IN, BOOM = 38.5, 41.0, 42.0   # shell fades, rematerialises, explodes
# never silent once in: build → hush as the ship slides into the citadel → swell → climax → settle under the last lines
amb = [(TM, 0), (TM + 1.5, 1.0), (CIT_OUT, 1.0), (CIT_OUT + 1.0, 0.55), (CIT_IN, 0.55), (BOOM, 1.25), (44.5, 1.25), (46.0, 0.6), (TITLE + 2.5, 0.6), (END, 0)]
mel = [(TP, 0), (TP + 1.0, 1.0), (CIT_OUT, 1.0), (CIT_OUT + 1.0, 0.45), (CIT_IN, 0.45), (BOOM, 1.25), (44.5, 1.25), (46.0, 0.5), (TITLE + 2.5, 0.5), (END, 0)]
l3 = [(TV, 0), (TV + 2.0, 1.0), (CIT_OUT, 1.0), (CIT_OUT + 1.0, 0.25), (CIT_IN, 0.25), (BOOM, 1.3), (44.5, 1.3), (46.0, 0.35), (TITLE + 2.5, 0.35), (END, 0)]
MUSIC_GAIN = 1.4
for lab, idx, pts in (("mA", I_AMB, amb), ("mM", I_MEL, mel), ("mL", I_L3, l3)):
    g.append(f"[{idx}]aresample=44100,atrim=0:{END - TM},asetpts=PTS-STARTPTS,adelay={ms(TM)}|{ms(TM)},"
             f"volume='{MUSIC_GAIN}*({env(pts)})*if({duck},0.65,1)':eval=frame[{lab}]")
g.append(f"[pulse][game][vo][mA][mM][mL]amix=inputs=6:normalize=0:duration=longest,apad=whole_dur={END},atrim=0:{END},"
         f"afade=t=out:st={END - 1.0}:d=1.0,loudnorm=I=-14:TP=-1.5:LRA=14,aresample=48000[out]")
args = []
for k, f in enumerate(inputs):
    if k in (I_AMB, I_MEL, I_L3):
        args += ["-stream_loop", "3"]
    args += ["-i", f]
os.makedirs("parts", exist_ok=True)
ff(*args, "-filter_complex", ";\n".join(g), "-map", "[out]", "-c:a", "pcm_s16le", "parts/audio.wav")
ff("-i", "parts/video.mp4", "-i", "parts/audio.wav", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
   "-shortest", "-movflags", "+faststart", "pulsar-trailer.mp4")
print(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "pulsar-trailer.mp4"], capture_output=True, text=True).stdout.strip())
