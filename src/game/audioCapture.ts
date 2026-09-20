// Offline audio capture for the replay MP4/WAV exporter. Sound.ts drives every
//   voice off `this.ctx` (node factories + currentTime + the lookahead
//   scheduler's runningAudioTime), so capture works by swapping that field for
//   a CaptureAudioContext: the same dispatch code computes its parameters and
//   builds its real node graph, but on an OfflineAudioContext whose "now" is
//   the export clock — accumulated recorded dt, the same timeline the video
//   frames are stamped with. One startRendering() pass then produces the whole
//   soundtrack. No live audio plays and nothing is approximated per-voice:
//   baked one-shots, live-synth one-shots, spatial drones (per-frame
//   setTargetAtTime automation), halo music stems (gain-ramp tiers), vocals
//   and beat-scheduled cues all land through their normal code paths.
//
// Three things about an OfflineAudioContext differ from a live one in ways
//   that voice code written for live playback trips over, and this file is
//   where each is absorbed so Sound.ts stays context-agnostic:
//   1. Before rendering starts, an AudioParam's `.value` reports the last value
//      *assigned* to it (or its default), never the value its automation has
//      reached — the timeline is only evaluated by the render thread. Every
//      "hold the current level, then fade" release in Sound.ts reads `.value`,
//      so on a raw offline param a hum that had swelled to 0.07 released from
//      1.0: a full-scale burst at the moment the reticule left the target.
//      Capture nodes therefore hand out tracking params that mirror every
//      automation call into a small JS timeline and answer `.value` from it.
//   2. Graph topology is not time-stamped: a `disconnect()` during the sweep
//      removes that path for the whole render, past included, deleting the
//      voice from the movie. Capture nodes ignore disconnect; sources are
//      already silenced on the timeline by their stop() times and gain fades.
//   3. Wall-clock timers don't track the export clock: the sweep runs at CPU
//      speed, so a setTimeout release teardown fires at an unrelated point of
//      the rendered timeline. ExportClock owns a deferred-callback queue that
//      Sound.ts uses in place of setTimeout/setInterval while capturing;
//      videoExport advances the clock with advanceTo(), which fires due ones.

export type CaptureTimerHandle = { cancel(): void };

type CaptureTimer = {
  at: number;
  every: number | null;
  cb: () => void;
  cancelled: boolean;
};

// Export clock: seconds of replay time consumed so far. The exporter advances
//   it to the frame's presentation time before stepping the sim, so every
//   ctx.currentTime read during that frame's update+render resolves to it.
//   This is the entire clock translation: beat-aligned voices compute
//   "runningAudioTime() + beatDelta / rate", which becomes an absolute offline
//   timestamp because runningAudioTime() reads this clock during capture.
export class ExportClock {
  now = 0;
  private timers: CaptureTimer[] = [];

  // Move to `t` and run every deferred callback whose time has come, oldest
  //   first. A repeating timer that fell behind catches up within the same
  //   call, the way a backgrounded setInterval does.
  advanceTo(t: number): void {
    this.now = t;
    while (this.timers.length > 0 && this.timers[0].at <= this.now) {
      const timer = this.timers.shift()!;
      if (timer.cancelled) continue;
      timer.cb();
      if (timer.every !== null && !timer.cancelled) {
        timer.at += timer.every;
        this.insert(timer);
      }
    }
  }

  // setTimeout / setInterval on the export timeline. Fires from advanceTo.
  defer(cb: () => void, delaySec: number, everySec: number | null = null): CaptureTimerHandle {
    const timer: CaptureTimer = {
      at: this.now + Math.max(0, delaySec),
      every: everySec !== null && everySec > 0 ? everySec : null,
      cb,
      cancelled: false,
    };
    this.insert(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  private insert(timer: CaptureTimer) {
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1].at > timer.at) i--;
    this.timers.splice(i, 0, timer);
  }
}

// ── AudioParam tracking ──────────────────────────────────────────────────

type AutomationEvent =
  | { kind: "set"; time: number; value: number }
  | { kind: "linear"; time: number; value: number }
  | { kind: "exp"; time: number; value: number }
  // v0 is only set on a folded event (see AutomationTimeline.fold): the level
  //   the approach was at when the older history it replaces was collapsed.
  | { kind: "target"; time: number; value: number; tc: number; v0?: number };

type ParamState =
  | { kind: "hold"; value: number }
  | { kind: "target"; target: number; t0: number; v0: number; tc: number };

const stateAt = (s: ParamState, t: number): number =>
  s.kind === "hold" ? s.value : s.target + (s.v0 - s.target) * Math.exp(-(t - s.t0) / s.tc);

const applyEvent = (state: ParamState, e: AutomationEvent): ParamState => {
  switch (e.kind) {
    case "set":
    case "linear":
    case "exp":
      return { kind: "hold", value: e.value };
    case "target": {
      const v0 = e.v0 ?? stateAt(state, e.time);
      return e.tc > 0
        ? { kind: "target", target: e.value, t0: e.time, v0, tc: e.tc }
        : { kind: "hold", value: e.value };
    }
  }
};

// Per-frame drones push a setTargetAtTime every sim step; fold the history
//   whenever the list grows past this so a long replay stays O(1) per param.
const FOLD_AT = 64;

// The value-vs-time model of the Web Audio automation rules, kept in JS so a
//   capture param can answer `.value` at the export clock. Covers what Sound.ts
//   schedules: setValueAtTime, linear/exponential ramps, setTargetAtTime,
//   cancelScheduledValues. A ramp takes its start point from the event before
//   it (Sound always pins one with setValueAtTime first); an exponential ramp
//   across zero or a sign change holds its start value, as the spec says.
class AutomationTimeline {
  private events: AutomationEvent[] = [];

  constructor(private readonly initial: number, private readonly clock: ExportClock) {}

  push(e: AutomationEvent): void {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > e.time) i--;
    this.events.splice(i, 0, e);
    if (this.events.length > FOLD_AT) this.fold();
  }

  // cancelScheduledValues: drop every event at or after `t`.
  cancelFrom(t: number): void {
    this.events = this.events.filter((e) => e.time < t);
  }

  valueAt(t: number): number {
    let state: ParamState = { kind: "hold", value: this.initial };
    let prevTime = 0;
    for (const e of this.events) {
      if (e.time > t) {
        if (e.kind === "linear" || e.kind === "exp") {
          const v0 = stateAt(state, prevTime);
          const span = e.time - prevTime;
          if (span <= 0) return e.value;
          const f = (t - prevTime) / span;
          if (e.kind === "linear") return v0 + (e.value - v0) * f;
          if (v0 === 0 || (v0 > 0) !== (e.value > 0)) return v0;
          return v0 * Math.pow(e.value / v0, f);
        }
        break;
      }
      state = applyEvent(state, e);
      prevTime = e.time;
    }
    return stateAt(state, t);
  }

  // Collapse everything at or before the clock into one event carrying the
  //   state at the last of them. Values from that time on are unchanged (an
  //   exponential approach is memoryless given its level at any instant), and
  //   the clock never reads earlier than now, so nothing observable is lost.
  private fold(): void {
    const now = this.clock.now;
    let cut = -1;
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].time <= now) cut = i;
      else break;
    }
    if (cut < 1) return;
    let state: ParamState = { kind: "hold", value: this.initial };
    for (let i = 0; i <= cut; i++) state = applyEvent(state, this.events[i]);
    const time = this.events[cut].time;
    const folded: AutomationEvent = state.kind === "hold"
      ? { kind: "set", time, value: state.value }
      : { kind: "target", time, value: state.target, tc: state.tc, v0: stateAt(state, time) };
    this.events.splice(0, cut + 1, folded);
  }
}

// A param whose automation calls go to the real offline param AND into a
//   timeline, so `.value` can be answered at the export clock. Assigning
//   `.value` becomes setValueAtTime(v, now), which is what the assignment
//   means on a running context; on a pre-render offline param it would
//   instead take effect from t = 0.
// Proxy → real param, so a node connecting an LFO to a tracked param can hand
//   the real one to the WebIDL `connect` (a Proxy fails its type check).
const realParams = new WeakMap<AudioParam, AudioParam>();

const trackParam = (param: AudioParam, clock: ExportClock): AudioParam => {
  const timeline = new AutomationTimeline(param.value, clock);
  const handler: ProxyHandler<AudioParam> = {
    get(target, prop) {
      switch (prop) {
        case "value":
          return timeline.valueAt(clock.now);
        case "setValueAtTime":
          return (value: number, time: number) => {
            timeline.push({ kind: "set", time, value });
            target.setValueAtTime(value, time);
            return proxy;
          };
        case "linearRampToValueAtTime":
          return (value: number, time: number) => {
            timeline.push({ kind: "linear", time, value });
            target.linearRampToValueAtTime(value, time);
            return proxy;
          };
        case "exponentialRampToValueAtTime":
          return (value: number, time: number) => {
            timeline.push({ kind: "exp", time, value });
            target.exponentialRampToValueAtTime(value, time);
            return proxy;
          };
        case "setTargetAtTime":
          return (value: number, time: number, tc: number) => {
            timeline.push({ kind: "target", time, value, tc });
            target.setTargetAtTime(value, time, tc);
            return proxy;
          };
        case "setValueCurveAtTime":
          return (curve: Float32Array | number[], time: number, duration: number) => {
            if (curve.length > 0) {
              timeline.push({ kind: "set", time, value: curve[0] });
              timeline.push({ kind: "set", time: time + duration, value: curve[curve.length - 1] });
            }
            target.setValueCurveAtTime(curve as Float32Array<ArrayBuffer>, time, duration);
            return proxy;
          };
        case "cancelScheduledValues":
          return (time: number) => {
            timeline.cancelFrom(time);
            target.cancelScheduledValues(time);
            return proxy;
          };
        case "cancelAndHoldAtTime":
          // Chromium's own hold evaluates a setTargetAtTime param from its
          //   pre-render state (measured: it holds 0), so emulate it from ours.
          return (time: number) => {
            const held = timeline.valueAt(time);
            timeline.cancelFrom(time);
            timeline.push({ kind: "set", time, value: held });
            target.cancelScheduledValues(time);
            target.setValueAtTime(held, time);
            return proxy;
          };
        default: {
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
        }
      }
    },
    set(target, prop, value) {
      if (prop === "value") {
        const time = clock.now;
        timeline.push({ kind: "set", time, value: value as number });
        target.setValueAtTime(value as number, time);
        return true;
      }
      return Reflect.set(target, prop, value, target);
    },
  };
  const proxy = new Proxy(param, handler);
  realParams.set(proxy, param);
  return proxy;
};

// Every AudioParam name a node Sound.ts creates can carry.
const AUDIO_PARAM_NAMES = [
  "gain", "frequency", "detune", "Q", "pan", "playbackRate", "offset",
  "threshold", "knee", "ratio", "attack", "release", "delayTime",
] as const;

const trackNode = <T extends AudioNode>(node: T, clock: ExportClock): T => {
  for (const name of AUDIO_PARAM_NAMES) {
    const param = (node as unknown as Record<string, unknown>)[name];
    if (param instanceof AudioParam) {
      Object.defineProperty(node, name, { value: trackParam(param, clock), configurable: true, enumerable: true });
    }
  }
  // connect(param) must receive the real AudioParam behind a tracking proxy.
  const rawConnect = node.connect.bind(node) as (dest: AudioNode | AudioParam, output?: number, input?: number) => AudioNode | void;
  Object.defineProperty(node, "connect", {
    value: (dest: AudioNode | AudioParam, output?: number, input?: number) => {
      const real = dest instanceof AudioNode ? dest : realParams.get(dest) ?? dest;
      if (input !== undefined) return rawConnect(real, output, input);
      if (output !== undefined) return rawConnect(real, output);
      return rawConnect(real);
    },
    configurable: true,
  });
  // See point 2 in the header: topology changes are not time-stamped on an
  //   offline graph, so a teardown disconnect would erase the voice's past.
  //   Sound.ts only disconnects after a fade to silence and a scheduled stop,
  //   so leaving the node attached changes nothing audible.
  Object.defineProperty(node, "disconnect", { value: () => {}, configurable: true });
  return node;
};

type StartableNode = AudioBufferSourceNode | OscillatorNode | ConstantSourceNode;

// A source node's no-arg start()/stop() means "at ctx.currentTime" — but an
//   OfflineAudioContext's real currentTime is frozen at 0 until rendering, so
//   those calls must be re-anchored to the export clock. stop() additionally
//   swallows errors: a stray cleanup can still reach a node after the capture
//   ended, against an already-rendered graph.
const wrapSourceTiming = <T extends StartableNode>(node: T, clock: ExportClock): T => {
  const rawStart = node.start.bind(node) as (when?: number, offset?: number, duration?: number) => void;
  const rawStop = node.stop.bind(node);
  (node as AudioBufferSourceNode).start = (when?: number, offset?: number, duration?: number) => {
    if (duration !== undefined) rawStart(when ?? clock.now, offset, duration);
    else if (offset !== undefined) rawStart(when ?? clock.now, offset);
    else rawStart(when ?? clock.now);
  };
  node.stop = (when?: number) => {
    try { rawStop(when ?? clock.now); } catch { /* post-capture stray cleanup */ }
  };
  return node;
};

// The AudioContext surface Sound.ts actually touches (audit: grep `this.ctx.`
//   / `ctx.` in Sound.ts — the factories below plus currentTime, sampleRate,
//   state, destination, decodeAudioData, resume). `state` reports "running" so
//   runningAudioTime() keeps feeding the lookahead scheduler during capture.
//   Sound stores this as its ctx via `as unknown as AudioContext` and keeps a
//   typed reference for the deferred-timer API.
export class CaptureAudioContext {
  readonly offline: OfflineAudioContext;
  readonly clock: ExportClock;

  constructor(offline: OfflineAudioContext, clock: ExportClock) {
    this.offline = offline;
    this.clock = clock;
  }

  get currentTime(): number { return this.clock.now; }
  get sampleRate(): number { return this.offline.sampleRate; }
  get state(): AudioContextState { return "running"; }
  get destination(): AudioDestinationNode { return this.offline.destination; }

  resume(): Promise<void> { return Promise.resolve(); }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.offline.decodeAudioData(data);
  }

  // setTimeout / setInterval equivalents on the export clock (point 3 above).
  deferTimeout(cb: () => void, ms: number): CaptureTimerHandle {
    return this.clock.defer(cb, ms / 1000);
  }

  deferInterval(cb: () => void, ms: number): CaptureTimerHandle {
    return this.clock.defer(cb, ms / 1000, ms / 1000);
  }

  createGain(): GainNode { return trackNode(this.offline.createGain(), this.clock); }
  createBiquadFilter(): BiquadFilterNode { return trackNode(this.offline.createBiquadFilter(), this.clock); }
  createDynamicsCompressor(): DynamicsCompressorNode { return trackNode(this.offline.createDynamicsCompressor(), this.clock); }
  createWaveShaper(): WaveShaperNode { return trackNode(this.offline.createWaveShaper(), this.clock); }
  createStereoPanner(): StereoPannerNode { return trackNode(this.offline.createStereoPanner(), this.clock); }
  createConvolver(): ConvolverNode { return trackNode(this.offline.createConvolver(), this.clock); }
  createAnalyser(): AnalyserNode { return trackNode(this.offline.createAnalyser(), this.clock); }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return this.offline.createBuffer(channels, length, sampleRate);
  }

  createOscillator(): OscillatorNode {
    return trackNode(wrapSourceTiming(this.offline.createOscillator(), this.clock), this.clock);
  }

  createBufferSource(): AudioBufferSourceNode {
    return trackNode(wrapSourceTiming(this.offline.createBufferSource(), this.clock), this.clock);
  }

  createConstantSource(): ConstantSourceNode {
    return trackNode(wrapSourceTiming(this.offline.createConstantSource(), this.clock), this.clock);
  }
}

// 16-bit PCM WAV blob from a rendered AudioBuffer — the Stage-A verification
//   artifact (window.__exportReplayAudio) for by-ear A/B against live playback.
export const encodeWavBlob = (buf: AudioBuffer): Blob => {
  const numCh = buf.numberOfChannels;
  const frames = buf.length;
  const dataBytes = frames * numCh * 2;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
};
