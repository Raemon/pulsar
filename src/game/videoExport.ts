// Offline replay → MP4 exporter. Re-steps the open replay from frame 0 as
//   fast as the CPU allows (the sim is a deterministic input re-sim), rendering
//   every frame to canvas and encoding a fixed EXPORT_FPS video with WebCodecs,
//   each output tick showing the sim frame whose recorded interval contains it.
//   Audio never plays live: Sound runs in export capture (audioCapture.ts) so
//   every voice schedules onto one OfflineAudioContext, which is rendered in a
//   single pass after the sim sweep and muxed with the video (mp4-muxer). No
//   MediaRecorder anywhere.

import type { Game } from "../Game";
import type { ReplayPlayer } from "./replayPlayer";
import { restartReplayWorld, emitGameState } from "./lifecycle";
import { stepReplayFrame } from "./gameUpdate";
import { renderGame } from "./gameRender";
import { CaptureAudioContext, ExportClock, encodeWavBlob } from "./audioCapture";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export type ExportPhase = "prewarm" | "render" | "audio" | "mux" | "done";

const MAX_OUT_W = 1920;
const MAX_OUT_H = 1080;
// The video track runs at a fixed rate. Encoding every sim step as its own frame
//   made a recording from a 120 Hz display into a ~119 fps variable-rate stream:
//   twice the intended size, and more frames than a 1080p High@4.2 stream may
//   carry, which is the kind of file players handle unpredictably. Each output
//   tick k / EXPORT_FPS shows the sim frame whose interval [acc, acc + dt)
//   contains it, so a long recorded frame holds for several ticks and a 120 Hz
//   run shows every other step. Audio is untouched: it schedules on the same
//   `acc` timeline the ticks index, so the two stay locked.
const EXPORT_FPS = 60;
const EXPORT_FRAME_SEC = 1 / EXPORT_FPS;
const VIDEO_BITRATE = 12_000_000;
const AUDIO_BITRATE = 192_000;
const KEYFRAME_INTERVAL_SEC = 2;
const RENDER_TAIL_SEC = 1;
// Fraction of the progress bar the sim+encode sweep occupies; the offline
//   audio render and mux split the remainder.
const RENDER_SHARE = 0.8;
const PROGRESS_EVERY_FRAMES = 16;
const YIELD_EVERY_FRAMES = 64;
const MAX_ENCODE_QUEUE = 30;
const AUDIO_CHUNK_FRAMES = 4096;

type ActiveExport = { cancelled: boolean };

let activeExport: ActiveExport | null = null;

export const isReplayExporting = (): boolean => activeExport !== null;

export const cancelReplayExport = (): void => {
  if (activeExport) activeExport.cancelled = true;
};

// Download-button entry point: starts an export, or cancels the one in flight.
export const toggleReplayExport = (game: Game): void => {
  if (activeExport) {
    activeExport.cancelled = true;
    return;
  }
  void runVideoExport(game);
};

const emitProgress = (frac: number, phase: ExportPhase) => {
  window.dispatchEvent(new CustomEvent("replay:export-progress", {
    detail: {
      frac: Math.max(0, Math.min(1, frac)),
      phase,
    },
  }));
};

const macroYield = () => new Promise<void>((r) => setTimeout(r, 0));

// Let the microtasks queued during a frame run before the clock moves on: the
//   cached-buffer awaits inside async voice starts (startHaloMusic and its
//   siblings read the clock AFTER `await Promise.all(loads)`) settle within a
//   handful of promise hops. Hopping the microtask queue is free; a task
//   boundary per frame is not, since the page then paints the dirty canvas
//   every frame (a 1080p software raster on a weak machine).
const SETTLE_HOPS = 32;
const settleMicrotasks = async () => {
  for (let i = 0; i < SETTLE_HOPS; i++) await undefined;
};

const timestampSlug = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const replayDurationSec = (player: ReplayPlayer): number => {
  let total = 0;
  for (const f of player.payload.frames) total += f[0];
  return total;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

// The replay-locked backing store can exceed 1080p on retina recordings
//   (logical 1920x1080 × dpr); cap the encode at 1080p, keeping aspect and
//   the even dimensions H.264 requires.
const fitOutputDims = (srcW: number, srcH: number): { outW: number; outH: number } => {
  const scale = Math.min(1, MAX_OUT_W / srcW, MAX_OUT_H / srcH);
  return {
    outW: Math.max(2, Math.round((srcW * scale) / 2) * 2),
    outH: Math.max(2, Math.round((srcH * scale) / 2) * 2),
  };
};

// H.264 profile ladder, highest first; the level must cover 1080p at the
//   recording's frame rate, so the higher level of each profile is tried first.
const H264_CANDIDATES = ["avc1.64002a", "avc1.640028", "avc1.4d402a", "avc1.4d4028", "avc1.42e02a"];

const pickVideoConfig = async (width: number, height: number): Promise<VideoEncoderConfig | null> => {
  for (const codec of H264_CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: EXPORT_FPS,
      avc: {
        format: "avc",
      },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch { /* malformed codec string for this UA — try the next */ }
  }
  return null;
};

type AudioChoice = {
  config: AudioEncoderConfig;
  muxCodec: "aac" | "opus";
};

const pickAudioConfig = async (sampleRate: number): Promise<AudioChoice | null> => {
  if (typeof AudioEncoder === "undefined") return null;
  const candidates: AudioChoice[] = [
    {
      config: {
        codec: "mp4a.40.2",
        sampleRate,
        numberOfChannels: 2,
        bitrate: AUDIO_BITRATE,
      },
      muxCodec: "aac",
    },
  ];
  // Opus-in-mp4 only supports one fixed rate; offer it only when the audio
  //   context happens to match.
  if (sampleRate === 48000) {
    candidates.push({
      config: {
        codec: "opus",
        sampleRate,
        numberOfChannels: 2,
        bitrate: AUDIO_BITRATE,
      },
      muxCodec: "opus",
    });
  }
  for (const c of candidates) {
    try {
      if ((await AudioEncoder.isConfigSupported(c.config)).supported) return c;
    } catch { /* try the next */ }
  }
  return null;
};

// Undo the export's world takeover: hand the replay back to the normal loop
//   and queue a muted seek back to where the viewer was (seekReplayToTarget
//   rebuilds + fast-steps on the next update tick).
const restoreViewerPosition = (game: Game, resumePos: number, resumeSpeed: number) => {
  game.replayExporting = false;
  if (!game.replayPlayer) return;
  game.replaySeekTarget = resumePos;
  game.replaySpeed = resumeSpeed;
  game.replayStepAccumulator = 0;
  emitGameState(game);
};

// Rebuild at frame 0 and step every recorded frame, rendering each one (some
//   voices — reticule hums, streak stems — are driven from render code, so the
//   render call is part of audio capture too). The clock is advanced to the
//   frame's start time BEFORE stepping the sim, so all audio scheduled during
//   the frame lands at the timeline position the frame's video ticks are
//   stamped from, and voice teardowns deferred on the export clock fire at
//   their own point of the timeline rather than at CPU speed.
//   `onFrame` (video path) encodes the just-rendered canvas once per output
//   tick that falls inside the frame. Every frame then drains the microtask
//   queue so the cached-buffer awaits inside async voice starts (halo music,
//   Pilot's Log) settle before the clock moves on: startHaloMusic reads the
//   clock after its await, which live resolves in the same task as the
//   trigger. Draining only at the 64-frame macro yield started the music up
//   to half a second late in the audio-only export.
const runSimCapturePass = async (
  game: Game,
  clock: ExportClock,
  state: ActiveExport,
  onFrame: ((presentationSec: number, dtSec: number) => Promise<void> | void) | null,
): Promise<void> => {
  restartReplayWorld(game);
  const player = game.replayPlayer!;
  // The open-replay precompute sweep already audited this recording; don't
  //   re-spam its divergence warnings from the export sweep.
  player.logDivergences = false;
  const total = Math.max(1, player.total());
  let acc = 0;
  let frame = 0;
  let tick = 0;
  try {
    while (!state.cancelled) {
      const dt = player.peekFrameDt();
      if (dt === null) break;
      clock.advanceTo(acc);
      if (!stepReplayFrame(game)) break;
      renderGame(game);
      if (onFrame) {
        const frameEnd = acc + dt;
        while (tick / EXPORT_FPS < frameEnd && !state.cancelled) {
          await onFrame(tick / EXPORT_FPS, EXPORT_FRAME_SEC);
          tick++;
        }
      }
      await settleMicrotasks();
      acc += dt;
      frame++;
      if (frame % PROGRESS_EVERY_FRAMES === 0) emitProgress((frame / total) * RENDER_SHARE, "render");
      if (frame % YIELD_EVERY_FRAMES === 0) await macroYield();
    }
  } finally {
    player.logDivergences = true;
    // The sweep ran silent; say so if the movie's re-sim drifted off the
    //   recording, since that is a movie that shows a run nobody played.
    const divs = player.divergences;
    if (divs.length > 0) {
      const first = divs[0];
      const fields = first.fields.map((f) => `${f.field} ${f.recorded}→${f.replayed}`).join(", ");
      console.warn(`[export] re-sim diverged from the recording at ${divs.length} checkpoint(s); first at frame ${first.frame} (${first.timeSec.toFixed(2)}s in): ${fields}`);
    }
  }
};

const encodeRenderedAudio = async (
  rendered: AudioBuffer,
  choice: AudioChoice,
  muxer: Muxer<ArrayBufferTarget>,
  state: ActiveExport,
): Promise<void> => {
  let encodeError: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { encodeError = e; state.cancelled = true; },
  });
  encoder.configure(choice.config);
  const ch0 = rendered.getChannelData(0);
  const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;
  const rate = rendered.sampleRate;
  for (let off = 0; off < rendered.length && !state.cancelled; off += AUDIO_CHUNK_FRAMES) {
    const n = Math.min(AUDIO_CHUNK_FRAMES, rendered.length - off);
    const data = new Float32Array(n * 2);
    data.set(ch0.subarray(off, off + n), 0);
    data.set(ch1.subarray(off, off + n), n);
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: rate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((off / rate) * 1e6),
      data,
    });
    encoder.encode(audioData);
    audioData.close();
    if (encoder.encodeQueueSize > 20) await macroYield();
  }
  if (!state.cancelled) await encoder.flush();
  try { encoder.close(); } catch { /* already closed */ }
  if (encodeError) throw encodeError;
};

const runVideoExport = async (game: Game): Promise<void> => {
  if (activeExport) return;
  if (typeof VideoEncoder === "undefined") {
    console.warn("[export] WebCodecs (VideoEncoder) unavailable in this browser — cannot export video.");
    return;
  }
  const player = game.replayPlayer;
  const liveCtx = game.sound.ctx;
  if (!player || !liveCtx) {
    console.warn("[export] no open replay / audio context — nothing to export.");
    return;
  }

  // Claim the export slot synchronously — everything past here is async, and
  //   a second click must toggle-cancel rather than start a parallel export.
  const state: ActiveExport = { cancelled: false };
  activeExport = state;
  game.replayExporting = true;
  const resumePos = player.position();
  const resumeSpeed = game.replaySpeed;
  game.replaySeekTarget = null;
  game.replayStepAccumulator = 0;
  emitProgress(0, "render");

  let videoEncoder: VideoEncoder | null = null;
  let encodeError: unknown = null;
  try {
    const srcW = game.canvas.width;
    const srcH = game.canvas.height;
    const { outW, outH } = fitOutputDims(srcW, srcH);
    const videoConfig = await pickVideoConfig(outW, outH);
    if (!videoConfig) {
      console.warn("[export] no supported H.264 encoder config — cannot export video.");
      return;
    }
    const sampleRate = liveCtx.sampleRate;
    const audioChoice = await pickAudioConfig(sampleRate);
    if (!audioChoice) {
      console.warn("[export] no supported audio encoder (AAC/Opus) — exporting video-only.");
    }

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: {
        codec: "avc",
        width: outW,
        height: outH,
      },
      audio: audioChoice
        ? {
            codec: audioChoice.muxCodec,
            numberOfChannels: 2,
            sampleRate,
          }
        : undefined,
      fastStart: "in-memory",
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encodeError = e; state.cancelled = true; },
    });
    videoEncoder = encoder;
    encoder.configure(videoConfig);

    const needsComposite = outW !== srcW || outH !== srcH;
    const compositeCanvas = needsComposite ? new OffscreenCanvas(outW, outH) : null;
    const compositeCtx = compositeCanvas ? compositeCanvas.getContext("2d") : null;
    if (compositeCtx) {
      compositeCtx.imageSmoothingEnabled = true;
      compositeCtx.imageSmoothingQuality = "high";
    }

    // Every lazily-fetched voice (halo music variations, Pilot's Log takes,
    //   the guitar sample) must be cached before the frame sweep starts: a
    //   cache miss mid-sweep means the fetch resolves against a clock.now
    //   that has already raced past the moment the voice needed to start —
    //   an audible glitch plus the decode work stalling frame production.
    emitProgress(0, "prewarm");
    await game.sound.prewarmForExport();
    if (state.cancelled) return;

    const duration = replayDurationSec(player);
    const clock = new ExportClock();
    const offline = new OfflineAudioContext(
      2, Math.max(1, Math.ceil((duration + RENDER_TAIL_SEC) * sampleRate)), sampleRate,
    );
    game.sound.beginExportCapture(new CaptureAudioContext(offline, clock));

    let sinceKeySec = Infinity;
    const encodeFrame = async (presentationSec: number, dtSec: number) => {
      const init: VideoFrameInit = {
        timestamp: Math.round(presentationSec * 1e6),
        duration: Math.max(1, Math.round(dtSec * 1e6)),
      };
      let frame: VideoFrame;
      if (compositeCanvas && compositeCtx) {
        compositeCtx.drawImage(game.canvas, 0, 0, outW, outH);
        frame = new VideoFrame(compositeCanvas, init);
      } else {
        frame = new VideoFrame(game.canvas, init);
      }
      const keyFrame = sinceKeySec >= KEYFRAME_INTERVAL_SEC;
      if (keyFrame) sinceKeySec = 0;
      sinceKeySec += dtSec;
      encoder.encode(frame, { keyFrame });
      frame.close();
      while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE && !state.cancelled) await macroYield();
    };

    try {
      await runSimCapturePass(game, clock, state, encodeFrame);
      if (!state.cancelled) await encoder.flush();
    } finally {
      // Restore live audio + viewer position immediately after the sim sweep;
      //   the offline render + mux below don't touch the game.
      game.sound.endExportCapture();
      restoreViewerPosition(game, resumePos, resumeSpeed);
    }
    if (!state.cancelled) {
      emitProgress(RENDER_SHARE, "audio");
      const rendered = await offline.startRendering();
      if (audioChoice) await encodeRenderedAudio(rendered, audioChoice, muxer, state);
    }
    if (!state.cancelled) {
      emitProgress(0.97, "mux");
      muxer.finalize();
      const blob = new Blob([target.buffer], { type: "video/mp4" });
      downloadBlob(blob, `pulsar-replay-${timestampSlug()}.mp4`);
    }
  } catch (e) {
    console.warn("[export] replay export failed:", e);
  } finally {
    if (encodeError) console.warn("[export] encoder error:", encodeError);
    try { videoEncoder?.close(); } catch { /* already closed */ }
    // Belt-and-braces: the inner finally normally handled both of these.
    game.sound.endExportCapture();
    if (game.replayExporting) restoreViewerPosition(game, resumePos, resumeSpeed);
    activeExport = null;
    emitProgress(1, "done");
  }
};

// Dev verification hook (window.__exportReplayAudio): capture + offline-render
//   just the audio of the open replay and download it as a WAV, so the export
//   soundtrack can be A/B'd by ear against live replay playback before
//   trusting the video path.
export const exportReplayAudioWav = async (game: Game): Promise<void> => {
  if (activeExport) return;
  const player = game.replayPlayer;
  const liveCtx = game.sound.ctx;
  if (!player || !liveCtx) {
    console.warn("[export] no open replay / audio context — open a replay first.");
    return;
  }
  const state: ActiveExport = { cancelled: false };
  activeExport = state;
  game.replayExporting = true;
  const resumePos = player.position();
  const resumeSpeed = game.replaySpeed;
  game.replaySeekTarget = null;
  game.replayStepAccumulator = 0;
  emitProgress(0, "render");

  try {
    const sampleRate = liveCtx.sampleRate;
    emitProgress(0, "prewarm");
    await game.sound.prewarmForExport();
    if (state.cancelled) return;
    const duration = replayDurationSec(player);
    const clock = new ExportClock();
    const offline = new OfflineAudioContext(
      2, Math.max(1, Math.ceil((duration + RENDER_TAIL_SEC) * sampleRate)), sampleRate,
    );
    game.sound.beginExportCapture(new CaptureAudioContext(offline, clock));
    try {
      await runSimCapturePass(game, clock, state, null);
    } finally {
      game.sound.endExportCapture();
      restoreViewerPosition(game, resumePos, resumeSpeed);
    }
    if (!state.cancelled) {
      emitProgress(RENDER_SHARE, "audio");
      const rendered = await offline.startRendering();
      downloadBlob(encodeWavBlob(rendered), `pulsar-replay-audio-${timestampSlug()}.wav`);
    }
  } catch (e) {
    console.warn("[export] audio export failed:", e);
  } finally {
    game.sound.endExportCapture();
    if (game.replayExporting) restoreViewerPosition(game, resumePos, resumeSpeed);
    activeExport = null;
    emitProgress(1, "done");
  }
};
