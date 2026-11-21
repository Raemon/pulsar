import type { ReplayPayload } from "./replayFormat";

// A rhythm chain reconstructed from a *stored* replay — the climb from a frame
//   where the combo was 0 up to wherever it got before it broke.
//
// Live runs segment their chains exactly (game/highlightTimeline.ts watches
//   every frame), but that timeline is in-memory: it never travelled with the
//   uploaded replay. Re-deriving it exactly would mean re-simulating the whole
//   run, which is far too much work to do for every candidate the title reel
//   considers. The replay's checkpoints already carry beatCombo once a second
//   (recorded as a desync guard — see ReplayCheckpoint), so the reel reads the
//   chain off those samples instead: no simulation, and the numbers are the
//   recording's own ground truth rather than a re-derivation.
//
// What the sampling costs: chain bounds land on a checkpoint frame rather than
//   the exact fire that primed the chain, and a chain that broke and re-primed
//   between two samples reads as one chain. Both are fine for picking a clip —
//   startFrame is a frame the combo *was* verifiably 0 on, so the clip still
//   opens from nothing and climbs.
export type ComboChain = {
  // A frame the recording was at combo 0 on; the clip starts here.
  startFrame: number;
  // The last sampled frame of the chain (the first sample back at 0, or the
  //   final sample if the run ended mid-chain).
  endFrame: number;
  // Highest combo seen in the samples spanning this chain.
  peak: number;
};

// Segment a stored replay into chains using its checkpoint samples. Returns []
//   when the recording carries no checkpoints (nothing to read a combo off).
export const chainsFromCheckpoints = (payload: ReplayPayload): ComboChain[] => {
  const samples = payload.checkpoints ?? [];
  const chains: ComboChain[] = [];
  let open: ComboChain | null = null;
  for (let i = 0; i < samples.length; i++) {
    const { frame, beatCombo } = samples[i];
    if (beatCombo > 0) {
      if (open) {
        open.peak = Math.max(open.peak, beatCombo);
        open.endFrame = frame;
      } else {
        // Open at the previous sample: the combo was 0 there, so the clip gets
        //   the wind-up into the first on-beat hit for free.
        open = { startFrame: samples[i - 1]?.frame ?? frame, endFrame: frame, peak: beatCombo };
        chains.push(open);
      }
      continue;
    }
    if (open) {
      // This sample is back at 0 — the streak is over by here. Keep the frame
      //   so the clip plays through the break rather than cutting on the peak.
      open.endFrame = frame;
      open = null;
    }
  }
  return chains;
};

// Two sampled hits in a row is the floor for calling something a chain at all —
//   the same floor the live picker uses (highlightTimeline.pickHighlightChain).
//   It matters here because the samples are a second apart: a run that qualified
//   on its recorded max combo can still have every chain fall between samples.
const MIN_SHOWABLE_PEAK = 2;

// The chain to showcase: highest peak, ties broken toward the earliest (which
//   is also the cheapest to seek to). Null when the replay never held a chain
//   the samples can see.
export const pickLongestChain = (payload: ReplayPayload): ComboChain | null => {
  let best: ComboChain | null = null;
  for (const chain of chainsFromCheckpoints(payload)) {
    if (chain.peak < MIN_SHOWABLE_PEAK) continue;
    if (best === null || chain.peak > best.peak) best = chain;
  }
  return best;
};
