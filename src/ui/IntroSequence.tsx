import { useEffect, useRef, useState } from "react";
import { BEAT_GRID } from "../game/rhythmConstants";

// Beat-locked intro overlay. Three flavors share one component:
//   - "latency":    "Latency calibrated" — fades in, holds, fades out.
//   - "fullHints":  3 stacked hints + closing "Become one with the Pulsar".
//   - "shortHint":  one hint, 1-beat in / hold 4 / 4-beat out / 1-beat reveal of game.
// The game's bgBeat keeps ticking under all of these (Game.introOverlayActive
// gates the sim the same way `calibrationIntro` does). When the sequence is
// done, we fire `intro-sequence:done` and the lifecycle hands off to play.

const BEAT_SEC = BEAT_GRID;

type Kind = "latency" | "fullHints" | "shortHint";

type StartDetail = { kind: Kind; hints?: string[] };

type LineState = { text: string; opacity: number };

const getGameBeatTime = (): number => {
  const g = (window as unknown as { __game?: { beatTime: number } }).__game;
  return g ? g.beatTime : 0;
};

// Smoothstep so the fades feel less linear than a CSS ease; matched to the
// game's existing on-beat envelopes.
const smooth = (t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

// envelope: 0 before fadeInStart, ramps to 1 by fadeInStart+fadeInBeats, holds at 1,
// then ramps back to 0 between fadeOutStart and fadeOutStart+fadeOutBeats.
const envelope = (
  beat: number,
  fadeInStart: number,
  fadeInBeats: number,
  fadeOutStart: number | null,
  fadeOutBeats: number,
): number => {
  if (beat < fadeInStart) return 0;
  const inFrac = (beat - fadeInStart) / fadeInBeats;
  if (inFrac < 1) return smooth(inFrac);
  if (fadeOutStart === null || beat < fadeOutStart) return 1;
  const outFrac = (beat - fadeOutStart) / fadeOutBeats;
  if (outFrac >= 1) return 0;
  return smooth(1 - outFrac);
};

export const IntroSequence = () => {
  const [active, setActive] = useState(false);
  const [kind, setKind] = useState<Kind>("latency");
  const [lines, setLines] = useState<LineState[]>([]);
  const [bgOpacity, setBgOpacity] = useState(1);
  const startBeatRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const detailRef = useRef<StartDetail | null>(null);
  const doneRef = useRef(false);

  const stopLoop = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // fired once per sequence at the moment the bg starts fading from black —
  //   the lifecycle handler flips introOverlayActive off here, so the world
  //   wakes up *during* the fade-in instead of after it.
  const unfreezeFiredRef = useRef(false);
  const fireUnfreeze = () => {
    if (unfreezeFiredRef.current) return;
    unfreezeFiredRef.current = true;
    window.dispatchEvent(new CustomEvent("intro-sequence:unfreeze"));
  };

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    stopLoop();
    setActive(false);
    window.dispatchEvent(new CustomEvent("intro-sequence:done"));
  };

  useEffect(() => {
    const onStart = (e: Event) => {
      const detail = (e as CustomEvent<StartDetail>).detail;
      detailRef.current = detail;
      doneRef.current = false;
      unfreezeFiredRef.current = false;
      setKind(detail.kind);
      setActive(true);
      setBgOpacity(1);
      // initial state: all lines blank, opacity 0
      const initial: LineState[] =
        detail.kind === "latency"
          ? [{ text: "Latency calibrated", opacity: 0 }]
          : detail.kind === "fullHints"
            ? [
                { text: detail.hints?.[0] ?? "", opacity: 0 },
                { text: detail.hints?.[1] ?? "", opacity: 0 },
                { text: detail.hints?.[2] ?? "", opacity: 0 },
                { text: "Become one with the Pulsar", opacity: 0 },
              ]
            : [{ text: detail.hints?.[0] ?? "", opacity: 0 }];
      setLines(initial);
      startBeatRef.current = null;
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
    };
    window.addEventListener("intro-sequence:start", onStart as EventListener);
    return () => {
      window.removeEventListener("intro-sequence:start", onStart as EventListener);
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loop = () => {
    const bt = getGameBeatTime();
    if (startBeatRef.current === null) startBeatRef.current = bt;
    const beat = (bt - startBeatRef.current) / BEAT_SEC;
    const detail = detailRef.current;
    if (!detail) { rafRef.current = requestAnimationFrame(loop); return; }

    if (detail.kind === "latency") {
      // beats 0..1 silence to let the black settle, 1..4 fade in, 4..6 hold, 6..8 fade out, then done.
      // Bg stays black — the chain hands off to fullHints next without revealing the world.
      const op = envelope(beat, 1, 3, 6, 2);
      setLines([{ text: "Latency calibrated", opacity: op }]);
      if (beat >= 9) { finish(); return; }
    } else if (detail.kind === "fullHints") {
      // 1 fade-in beat of silence; hints arrive 4 beats apart; closing line 4 beats later;
      // hold 4 beats, then fade text out over 8 beats. The game starts unfreezing 4 beats
      // into that text fade-out (2s) and the bg fade-in finishes alongside the text.
      const op0 = envelope(beat, 1, 2, null, 0);
      const op1 = envelope(beat, 5, 2, null, 0);
      const op2 = envelope(beat, 9, 2, null, 0);
      const opClose = envelope(beat, 13, 2, null, 0);
      const holdEnd = 19; // 13 close-start + 2 fade-in + 4 hold
      const textFadeOutBeats = 4;
      const outFrac = Math.max(0, Math.min(1, (beat - holdEnd) / textFadeOutBeats));
      const outMul = 1 - smooth(outFrac);
      setLines([
        { text: detail.hints?.[0] ?? "", opacity: op0 * outMul },
        { text: detail.hints?.[1] ?? "", opacity: op1 * outMul },
        { text: detail.hints?.[2] ?? "", opacity: op2 * outMul },
        { text: "Become one with the Pulsar", opacity: opClose * outMul },
      ]);
      const bgStart = holdEnd + 4; 
      const bgFade = 4; 
      if (beat >= bgStart) fireUnfreeze();
      const bgFrac = Math.max(0, Math.min(1, (beat - bgStart) / bgFade));
      setBgOpacity(1 - smooth(bgFrac));
      if (beat >= bgStart + bgFade + 0.2) { finish(); return; }
    } else {
      // shortHint: 1-beat fade-in, then fade-out begins on the 4th beat and
      //   runs 4 beats. The bg fade-in runs alongside the text fade-out
      //   (same 4 beats), ending together — the world wakes up the moment the
      //   text starts fading.
      const op = envelope(beat, 0, 1, 4, 2);
      setLines([{ text: detail.hints?.[0] ?? "", opacity: op }]);
      const bgStart = 4;
      const bgFade = 4;
      if (beat >= bgStart) fireUnfreeze();
      const bgFrac = Math.max(0, Math.min(1, (beat - bgStart) / bgFade));
      setBgOpacity(1 - smooth(bgFrac));
      if (beat >= bgStart + bgFade + 0.2) { finish(); return; }
    }
    rafRef.current = requestAnimationFrame(loop);
  };

  if (!active) return null;

  const slot =
    kind === "latency"
      ? "single"
      : kind === "fullHints"
        ? "stack"
        : "single";

  return (
    <div
      className={`intro-sequence intro-sequence--${slot}`}
      style={{ ["--bg-opacity" as string]: bgOpacity.toFixed(3) }}
      aria-live="polite"
    >
      <div className="intro-sequence__stack">
        {lines.map((line, i) => {
          const isClose = kind === "fullHints" && i === lines.length - 1;
          return (
            <div
              key={i}
              className={`intro-sequence__line ${isClose ? "intro-sequence__line--close" : ""}`}
              style={{ opacity: line.opacity.toFixed(3) }}
            >
              {isClose ? (
                <>
                  Become one with the <span className="intro-sequence__accent">Pulsar</span>
                </>
              ) : (
                line.text
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
