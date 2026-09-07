// /music — manual mixer for the combo-halo music stems. Lets the user start
// any subset of variation×layer stems at once and tweak their gains live, so
// they can A/B variations side-by-side without playing the game to combo 12x.
//
// In-game these stems are gated by combo tier and only one variation plays at
// a time (see Sound.startHaloMusic). This page bypasses that — each
// (variation, layer) gets its own AudioBufferSourceNode + GainNode and the
// user toggles them independently.

import { useEffect, useMemo, useRef, useState } from "react";
import { PianoKeyboard } from "./PianoKeyboard";
import { BeatSyncEditor } from "./BeatSyncEditor";
import { HALO_MUSIC_POOL } from "../../game/haloMusicConfig";
import { BEAT_GRID } from "../../game/rhythmConstants";
import { getChannelVolume, setChannelVolume } from "../../game/audioPrefs";
import {
  loadMusicConfig,
  getMusicConfig,
  saveMusicConfig,
  type MusicConfig,
} from "../../musicConfig";
import type { HaloMusicVariation } from "../../Sound";

// Baked bgBeat mp3s — same downbeat + offbeat files Sound.ts plays in-game,
// so the pulse here matches what the player hears late-wave.
const BG_BEAT_DOWN_URL = "/sounds/baked/bgBeat__101.0000.mp3";
const BG_BEAT_OFF_URL = "/sounds/baked/bgBeat__113.2000.mp3";

// Driven off the canonical HALO_MUSIC_POOL so adding a variation in
// haloMusicConfig.ts auto-surfaces here. Per-variation labels/blurbs/gains
// still live in this map — add an entry when introducing a new variation
// or the page falls back to a placeholder row.
type Variation = Exclude<HaloMusicVariation, "none">;
type Layer = "ambient" | "melodic" | "layer3";

type StemKey = `${Variation}::${Layer}`;

type VariationInfo = {
  label: string;
  blurb: string;
  // In-game peak gains — shown as the slider defaults so the page mirrors
  // what the player actually hears. Kept in sync with Sound.haloMusicGain /
  // Sound.haloMusicLayer3Gain.
  gains: Record<Layer, number>;
};

const VARIATION_META: Record<Variation, VariationInfo> = {
  "cinematic-el": {
    label: "cinematic-el — cinematic bed + felt piano + lonely violin",
    blurb: "ElevenLabs cinematic bed (ambient) + felt piano (melodic) + a lonely solo violin (layer 3, FluidSynth strings).",
    gains: { ambient: 0.25, melodic: 0.25, layer3: 0.45 },
  },
  "musicbox-sb": {
    label: "musicbox-sb — sine pad + felt piano + felt glockenspiel",
    blurb: "Procedural sine pad (ambient) + FluidSynth felt piano (melodic) + slow felt-mallet glockenspiel arpeggio (layer 3).",
    gains: { ambient: 0.30, melodic: 0.30, layer3: 0.40 },
  },
  "synthwave-el": {
    label: "synthwave-el — Juno pad + soft lead + echo-cascade pluck",
    blurb: "ElevenLabs analog-synthwave Juno pad (ambient) + soft lead (melodic) + plucked detuned-saw motif with dotted-eighth ping-pong delay cascading through the upper register (layer 3).",
    gains: { ambient: 0.22, melodic: 0.22, layer3: 0.38 },
  },
  "vaporwave-el": {
    label: "vaporwave-el — glassy string-choir pad + felt bells + crystal glockenspiel",
    blurb: "ElevenLabs dawn/vaporwave: glassy string-choir pad (ambient) + sparse felt-bell sustains (melodic) + bright crystal-glockenspiel arpeggio (layer 3). All stems live mid-upper register so the bass field stays clean.",
    gains: { ambient: 0.25, melodic: 0.28, layer3: 0.32 },
  },
  "outerwilds-el": {
    label: "outerwilds-el — drone pad + fingerpicked guitar + plucked countermelody",
    blurb: "ElevenLabs Outer-Wilds folk: distant drone pad (ambient) + fingerpicked acoustic guitar in G mixolydian (melodic, plucks quantized to the 8th-note grid) + sparse plucked acoustic-guitar countermelody (layer 3, D-centered upper register, HPF'd at 500 Hz so its body clears the fingerpicking). G-rooted melodic over the bass field's C — V-over-I suspension that never resolves.",
    gains: { ambient: 0.22, melodic: 0.25, layer3: 0.30 },
  },
  "vigil-sb": {
    label: "vigil-sb — level-10 boss: the climax of the levels 1–9 music",
    blurb: "Force-picked during the level-10 boss fight (kept out of HALO_MUSIC_POOL so it doesn't roll randomly). Built as the CLIMAX of the levels 1–9 halo music — same felt-piano + sine-pad + glassy-chime palette, turned climactic-and-scary through tension inside the warmth rather than a genre change. Ambient = warm minor C-pedal pad + an accelerating C2 heartbeat (quarter-notes, doubling to eighths in the final phrase); melodic = insistent rising felt-piano minor-pentatonic arpeggio (C-Eb-G-Bb-C) that densifies each phrase; layer 3 = glassy celesta countermelody on tense scale tones (anxious-beautiful sparkle) + a felt-piano low-octave toll on phrase downbeats for weight. The B phrase swaps the halo pool's hopeful Cmaj7 lift for a Db(♭9)+F# tritone shadow that swells and recedes — the scare. The 24x climax crossfade is suppressed on the boss wave so this plays the whole engagement.",
    gains: { ambient: 0.30, melodic: 0.30, layer3: 0.32 },
  },
  "knell-sb": {
    label: "knell-sb — funeral death-knell (level-20 boss)",
    blurb: "Funeral death-knell boss track — the Sepulchre's theme, forced on the level-20 boss wave. Ambient = C-minor pad + C1 lub-dub double-pulse heartbeat + faint G5 shimmer swelling mid-loop; melodic = relentless staccato string-ensemble eighth-note ostinato around C3/Eb3/G3 with tremolo-string swells into each phrase; layer 3 = ghost choir singing a Dies-irae-shaded descending motif (C5-Bb4-Ab4-G4) + tubular bell tolling each phrase downbeat. A-A'-B-A2 shape: the B phrase stops the ostinato and lifts to Cmaj7 before the minor resolve.",
    gains: { ambient: 0.30, melodic: 0.32, layer3: 0.32 },
  },
  "cathedral-hymn-el": {
    label: "cathedral-hymn-el — bowed-string cathedral pad + distant felt piano + low monastic chant",
    blurb: "ElevenLabs haunting variation, post-boss (waves 12–20). Ambient = slow legato bowed-string pad in a cathedral, long reverb tail; melodic = sparse distant felt-piano single tones, one note per measure; layer 3 = quiet low monastic male chant on 'ooo/aaa' vowels, sotto-voce. Designed to feel sacred and slightly otherworldly without tipping into horror.",
    gains: { ambient: 0.27, melodic: 0.27, layer3: 0.30 },
  },
  "lost-transmission-el": {
    label: "lost-transmission-el — AM-radio analog pad + musical-saw lead + whispered breaths",
    blurb: "ElevenLabs haunting variation, post-boss (waves 12–20). Ambient = warm analog pad through tape-hiss + AM-radio bandlimiting + gentle wow/flutter; melodic = frail musical-saw lead, slow vibrato, transmissions almost lost in static; layer 3 = subliminal breathy whispered exhalations + faint short-wave crackle (non-instrumental texture). Frail, cold, lonely.",
    gains: { ambient: 0.22, melodic: 0.22, layer3: 0.28 },
  },
  "underwater-requiem-el": {
    label: "underwater-requiem-el — submerged orchestral pad + glass harmonica + ghostly celesta",
    blurb: "ElevenLabs haunting variation, post-boss (waves 12–20). Ambient = submerged orchestral string pad, heavy lowpass + watery shimmer reverb; melodic = faint sustained glass-harmonica tones; layer 3 = sparse upper-register celesta countermelody (HPF'd 500 Hz to clear the bass kit). Mournful and beautiful.",
    gains: { ambient: 0.25, melodic: 0.25, layer3: 0.32 },
  },
  "spectral-toll-sb": {
    label: "spectral-toll-sb — deep C/G drone + mournful cello + glass bells",
    blurb: "Haunting variation, post-boss (waves 12–20). Ambient = deep C/G open-fifth drone (ElevenLabs, bowed bass + low choir); melodic = mournful solo cello, slow legato (ElevenLabs); layer 3 = sparse inharmonic glass-bell strikes with dotted-quarter ping-pong echo (procedural, G5-E6, placed in the cello's rests). Sorrowful and beautiful.",
    gains: { ambient: 0.27, melodic: 0.27, layer3: 0.45 },
  },
};

const PLACEHOLDER_META: VariationInfo = {
  label: "(missing label — add entry to VARIATION_META)",
  blurb: "This variation is in HALO_MUSIC_POOL but has no metadata in MusicMixer.tsx. Defaults of 0.25 / 0.25 / 0.30 are used.",
  gains: { ambient: 0.25, melodic: 0.25, layer3: 0.30 },
};

// Boss-fight variation lives outside HALO_MUSIC_POOL so it never rolls
// randomly, but the mixer page should still expose it for tuning and
// audition. Append after the pool so the listing order matches "random
// rotation first, then specials".
const NON_POOL_VARIATIONS: readonly Variation[] = ["vigil-sb", "knell-sb", "cathedral-hymn-el", "lost-transmission-el", "underwater-requiem-el", "spectral-toll-sb"];
const VARIATIONS: readonly (VariationInfo & { id: Variation })[] = [
  ...HALO_MUSIC_POOL.map((id) => ({
    id: id as Variation,
    ...(VARIATION_META[id as Variation] ?? PLACEHOLDER_META),
  })),
  ...NON_POOL_VARIATIONS.map((id) => ({
    id,
    ...(VARIATION_META[id] ?? PLACEHOLDER_META),
  })),
];

const LAYERS: readonly Layer[] = ["ambient", "melodic", "layer3"];

const stemKey = (v: Variation, l: Layer): StemKey => `${v}::${l}`;
const stemUrl = (v: Variation, l: Layer) => `/sounds/halo-music/${v}-${l}.mp3`;

type StemNode = {
  src: AudioBufferSourceNode;
  gain: GainNode;
};

// Shared start time for every stem in a given mixer session. All stems start
// at the same audio time so loops stay phase-locked; per-stem gain ramps
// handle play/stop. Aligns with how Sound.startHaloMusic does it in-game.
//
// We open the context lazily on first user interaction so autoplay doesn't
// block, then everything sticks to a single shared clock.
export const MusicMixer = () => {
  const [ready, setReady] = useState(false);
  const [bufStatus, setBufStatus] = useState<Record<StemKey, "idle" | "loading" | "ready" | "error">>(() => {
    const init: Record<string, "idle"> = {};
    for (const v of VARIATIONS) for (const l of LAYERS) init[stemKey(v.id, l)] = "idle";
    return init as Record<StemKey, "idle">;
  });
  const [playing, setPlaying] = useState<Record<StemKey, boolean>>({} as Record<StemKey, boolean>);
  // Start from VARIATION_META defaults; a useEffect below pulls
  // music-config.json once and overlays whatever's persisted so the page
  // opens with the current on-disk values. Until the fetch resolves, the
  // sliders show the audit-calibrated baseline — close enough to the saved
  // values that the moment of update isn't jarring.
  const [gains, setGains] = useState<Record<StemKey, number>>(() => {
    const init: Record<string, number> = {};
    for (const v of VARIATIONS) for (const l of LAYERS) {
      init[stemKey(v.id, l)] = v.gains[l];
    }
    return init as Record<StemKey, number>;
  });
  // Master/pulse sliders mirror the saved audio prefs ("music" and "basePulse"
  // channels) so adjusting them here updates the same localStorage values the
  // in-game settings dialog uses. Initialized from whatever the player last
  // saved; writes go through setChannelVolume which persists + broadcasts.
  const [masterGain, setMasterGain] = useState(() => getChannelVolume("music"));
  const savedPulse = getChannelVolume("basePulse");
  const [pulseEnabled, setPulseEnabled] = useState(savedPulse > 0);
  const [pulseGain, setPulseGain] = useState(savedPulse > 0 ? savedPulse : 1.0);

  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const buffersRef = useRef<Map<StemKey, AudioBuffer>>(new Map());
  const nodesRef = useRef<Map<StemKey, StemNode>>(new Map());
  // Shared start time so every stem we kick off lands on the same loop phase
  // as anything already playing. Reset whenever every stem is stopped.
  const startAtRef = useRef<number>(0);

  // Background pulsar beat. Two buffers (downbeat + offbeat) fire on a 0.5s
  // grid anchored to startAtRef, matching the in-game bassClock pattern.
  const pulseDownBufRef = useRef<AudioBuffer | null>(null);
  const pulseOffBufRef = useRef<AudioBuffer | null>(null);
  const pulseGainNodeRef = useRef<GainNode | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  // Index of the next quarter-beat slot we'll schedule (0-based from startAt).
  const pulseNextBeatRef = useRef<number>(0);

  const ensureContext = (): AudioContext => {
    if (ctxRef.current) return ctxRef.current;
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = masterGain;
    master.connect(ctx.destination);
    const pulseG = ctx.createGain();
    pulseG.gain.value = pulseEnabled ? pulseGain : 0;
    pulseG.connect(master);
    ctxRef.current = ctx;
    masterRef.current = master;
    pulseGainNodeRef.current = pulseG;
    return ctx;
  };

  const loadPulseBuffers = async (): Promise<void> => {
    if (pulseDownBufRef.current && pulseOffBufRef.current) return;
    const ctx = ensureContext();
    const fetchOne = async (url: string): Promise<AudioBuffer | null> => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        return await ctx.decodeAudioData(ab);
      } catch {
        return null;
      }
    };
    const [d, o] = await Promise.all([
      pulseDownBufRef.current ? Promise.resolve(pulseDownBufRef.current) : fetchOne(BG_BEAT_DOWN_URL),
      pulseOffBufRef.current ? Promise.resolve(pulseOffBufRef.current) : fetchOne(BG_BEAT_OFF_URL),
    ]);
    if (d) pulseDownBufRef.current = d;
    if (o) pulseOffBufRef.current = o;
  };

  // Lookahead scheduler — fires every 100ms, schedules any beats whose audio
  // time falls in the next 200ms window. Each beat is a one-shot
  // AudioBufferSourceNode routed through pulseGainNodeRef so the user's pulse
  // slider rides everything. Pattern matches game/bassClock.ts: even beat
  // indices are downbeats (pitchRatio 1.0), odd are offbeats (1.122).
  const schedulePulseTick = () => {
    const ctx = ctxRef.current;
    const sink = pulseGainNodeRef.current;
    if (!ctx || !sink) return;
    const lookahead = 0.2;
    const horizon = ctx.currentTime + lookahead;
    while (true) {
      const slotTime = startAtRef.current + pulseNextBeatRef.current * BEAT_GRID;
      if (slotTime > horizon) break;
      // Don't bother scheduling beats that have already passed by more than
      // one slot (can only happen if the page was backgrounded mid-loop).
      if (slotTime >= ctx.currentTime - BEAT_GRID) {
        const isOffbeat = (pulseNextBeatRef.current & 1) === 1;
        const buf = isOffbeat ? pulseOffBufRef.current : pulseDownBufRef.current;
        if (buf) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(sink);
          src.start(Math.max(slotTime, ctx.currentTime));
        }
      }
      pulseNextBeatRef.current += 1;
    }
  };

  const startPulseScheduler = async () => {
    if (pulseTimerRef.current !== null) return;
    await loadPulseBuffers();
    const ctx = ctxRef.current;
    if (!ctx) return;
    // Snap to the same quarter-beat slot we'd be on if the music had been
    // running all along: figure out the next slot >= now and start there.
    const now = ctx.currentTime;
    const elapsed = Math.max(0, now - startAtRef.current);
    pulseNextBeatRef.current = Math.ceil(elapsed / BEAT_GRID);
    schedulePulseTick();
    pulseTimerRef.current = window.setInterval(schedulePulseTick, 100);
  };

  const stopPulseScheduler = () => {
    if (pulseTimerRef.current !== null) {
      window.clearInterval(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
  };

  const loadBuffer = async (v: Variation, l: Layer): Promise<AudioBuffer | null> => {
    const key = stemKey(v, l);
    const cached = buffersRef.current.get(key);
    if (cached) return cached;
    setBufStatus((s) => ({ ...s, [key]: "loading" }));
    try {
      const ctx = ensureContext();
      const r = await fetch(stemUrl(v, l));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ab = await r.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      buffersRef.current.set(key, buf);
      setBufStatus((s) => ({ ...s, [key]: "ready" }));
      return buf;
    } catch {
      setBufStatus((s) => ({ ...s, [key]: "error" }));
      return null;
    }
  };

  const stopStem = (key: StemKey) => {
    const node = nodesRef.current.get(key);
    if (!node || !ctxRef.current) return;
    const ctx = ctxRef.current;
    const t = ctx.currentTime;
    node.gain.gain.cancelScheduledValues(t);
    node.gain.gain.setValueAtTime(node.gain.gain.value, t);
    node.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    try { node.src.stop(t + 0.55); } catch { /* already stopped */ }
    nodesRef.current.delete(key);
    if (nodesRef.current.size === 0) stopPulseScheduler();
  };

  const startStem = async (v: Variation, l: Layer) => {
    const key = stemKey(v, l);
    const buf = await loadBuffer(v, l);
    if (!buf) return;
    const ctx = ensureContext();
    if (ctx.state === "suspended") await ctx.resume();
    const master = masterRef.current!;
    // Reuse existing shared start time if anything else is currently playing
    // so the new stem lands on the same loop phase. Otherwise reset to now.
    if (nodesRef.current.size === 0 || startAtRef.current < ctx.currentTime - 1) {
      startAtRef.current = ctx.currentTime + 0.05;
    }
    const startAt = startAtRef.current;
    // If the shared start is in the past (other stems already running), we
    // need to set the source's loop offset so it lines up phase-correctly.
    const now = ctx.currentTime;
    const elapsed = Math.max(0, now - startAt);
    const offset = elapsed > 0 ? elapsed % buf.duration : 0;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    const target = gains[key] ?? 0.25;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), now + 0.5);
    src.connect(gain);
    gain.connect(master);
    if (offset > 0) src.start(now, offset);
    else src.start(startAt);
    nodesRef.current.set(key, { src, gain });
    void startPulseScheduler();
  };

  // Live gain updates — slide the slider and you hear the change immediately.
  // Snap rather than ramp; the user's pulling on the knob, they want the
  // change *now*.
  useEffect(() => {
    if (!ctxRef.current) return;
    const t = ctxRef.current.currentTime;
    for (const [key, node] of nodesRef.current) {
      const target = Math.max(0.0001, gains[key]);
      node.gain.gain.cancelScheduledValues(t);
      node.gain.gain.setTargetAtTime(target, t, 0.05);
    }
  }, [gains]);

  useEffect(() => {
    setChannelVolume("music", masterGain);
    if (!masterRef.current || !ctxRef.current) return;
    const t = ctxRef.current.currentTime;
    masterRef.current.gain.cancelScheduledValues(t);
    masterRef.current.gain.setTargetAtTime(masterGain, t, 0.05);
  }, [masterGain]);

  useEffect(() => {
    setChannelVolume("basePulse", pulseEnabled ? pulseGain : 0);
    if (!pulseGainNodeRef.current || !ctxRef.current) return;
    const t = ctxRef.current.currentTime;
    const target = pulseEnabled ? Math.max(0.0001, pulseGain) : 0.0001;
    pulseGainNodeRef.current.gain.cancelScheduledValues(t);
    pulseGainNodeRef.current.gain.setTargetAtTime(target, t, 0.05);
  }, [pulseGain, pulseEnabled]);

  // Preload everything in the background once the user signals readiness.
  useEffect(() => {
    if (!ready) return;
    for (const v of VARIATIONS) {
      for (const l of LAYERS) void loadBuffer(v.id, l);
    }
    void loadPulseBuffers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    return () => stopPulseScheduler();
  }, []);

  // Pull the on-disk gains once and overlay them on the meta defaults. Sound.ts
  // reads the same file, so this keeps the page in sync with what plays
  // in-game.
  useEffect(() => {
    let cancelled = false;
    void loadMusicConfig().then((cfg) => {
      if (cancelled) return;
      setGains((g) => {
        const next = { ...g };
        for (const v of VARIATIONS) {
          const entry = cfg.variations[v.id];
          if (!entry) continue;
          for (const l of LAYERS) {
            const saved = entry[l];
            if (typeof saved === "number" && Number.isFinite(saved)) {
              next[stemKey(v.id, l)] = saved;
            }
          }
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, []);

  // Mutate one (variation, layer) gain on the in-memory config, POST the
  // whole blob to disk, and broadcast `halo-music-pref:changed` so a running
  // game can ramp the active stem's gain live without waiting for the next
  // halo-music start.
  const persistLayerGain = (v: Variation, l: Layer, value: number) => {
    const cur = getMusicConfig();
    const nextVars: MusicConfig["variations"] = { ...cur.variations };
    const entry = { ...(nextVars[v] ?? {}) };
    entry[l] = value;
    nextVars[v] = entry;
    const next: MusicConfig = { ...cur, variations: nextVars };
    void saveMusicConfig(next);
    try {
      window.dispatchEvent(new CustomEvent("halo-music-pref:changed", {
        detail: { variation: v, layer: l, value },
      }));
    } catch {
      // no-op
    }
  };

  const togglePlay = async (v: Variation, l: Layer) => {
    const key = stemKey(v, l);
    setReady(true);
    if (playing[key]) {
      stopStem(key);
      setPlaying((p) => ({ ...p, [key]: false }));
    } else {
      setPlaying((p) => ({ ...p, [key]: true }));
      await startStem(v, l);
    }
  };

  const stopAll = () => {
    for (const key of Array.from(nodesRef.current.keys())) stopStem(key);
    setPlaying({} as Record<StemKey, boolean>);
  };

  const playWholeVariation = async (v: Variation) => {
    setReady(true);
    for (const l of LAYERS) {
      const key = stemKey(v, l);
      if (!playing[key]) {
        setPlaying((p) => ({ ...p, [key]: true }));
        await startStem(v, l);
      }
    }
  };

  const stopWholeVariation = (v: Variation) => {
    for (const l of LAYERS) {
      const key = stemKey(v, l);
      if (playing[key]) stopStem(key);
    }
    setPlaying((p) => {
      const next = { ...p };
      for (const l of LAYERS) next[stemKey(v, l)] = false;
      return next;
    });
  };

  const anyPlaying = useMemo(() => Object.values(playing).some(Boolean), [playing]);

  return (
    <div className="min-h-screen bg-[#04060a] font-mono text-[#d6ecff]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(106,215,255,0.18)] bg-gradient-to-b from-[rgba(106,215,255,0.06)] to-transparent px-4 py-3">
        <div className="flex items-baseline gap-3">
          <a
            href="/"
            className="text-[16px] font-semibold tracking-[0.18em] text-[#6ad7ff] no-underline [text-shadow:0_0_12px_rgba(106,215,255,0.55)] hover:text-[#b8ecff]"
          >
            ← PULSAR
          </a>
          <span className="text-[14px] tracking-[0.32em] text-[#9bb5d6]">/ MUSIC</span>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
            <input
              type="checkbox"
              checked={pulseEnabled}
              onChange={(e) => setPulseEnabled(e.target.checked)}
              className="accent-[#6ad7ff]"
            />
            pulse
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={pulseGain}
              onChange={(e) => setPulseGain(parseFloat(e.target.value))}
              disabled={!pulseEnabled}
              className="w-32 accent-[#6ad7ff] disabled:opacity-40"
            />
            <span className="w-10 text-right text-[#d6ecff] tabular-nums">{pulseGain.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-2 text-[12px] uppercase tracking-[0.18em] text-[#9bb5d6]">
            master
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={masterGain}
              onChange={(e) => setMasterGain(parseFloat(e.target.value))}
              className="w-40 accent-[#6ad7ff]"
            />
            <span className="w-10 text-right text-[#d6ecff] tabular-nums">{masterGain.toFixed(2)}</span>
          </label>
          <button
            type="button"
            disabled={!anyPlaying}
            onClick={stopAll}
            className="rounded border border-[rgba(255,120,120,0.4)] bg-[rgba(255,120,120,0.08)] px-3 py-1 text-[12px] uppercase tracking-[0.18em] text-[#ff9b9b] disabled:opacity-30"
          >
            stop all
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-6">
        <p className="text-[13px] leading-relaxed text-[#9bb5d6]">
          Toggle any combination of variation × layer to hear them at once.
          Sliders adjust each layer&apos;s gain live; defaults match the in-game
          peak gains. All stems share a common loop phase so re-triggering
          mid-session lines up cleanly.
        </p>

        <PianoKeyboard />

        <BeatSyncEditor />

        <div className="flex flex-col gap-3">
          {VARIATIONS.map((variation) => {
            const allOn = LAYERS.every((l) => playing[stemKey(variation.id, l)]);
            const anyOn = LAYERS.some((l) => playing[stemKey(variation.id, l)]);
            // Split the label "rN-xx — descriptive name" into id + descriptor
            // so the id can act as a stable left-edge anchor while the rest
            // of the label flows into the blurb column.
            const labelParts = variation.label.split(" — ");
            const variationId = labelParts[0];
            const variationDescriptor = labelParts.slice(1).join(" — ");
            return (
              <section
                key={variation.id}
                className="rounded-lg border border-[rgba(106,215,255,0.22)] bg-[rgba(106,215,255,0.04)] px-4 py-3 shadow-[0_0_24px_rgba(106,215,255,0.06)_inset]"
              >
                <header className="mb-2 flex items-baseline gap-4">
                  <h2 className="w-16 shrink-0 text-[15px] font-semibold tracking-[0.12em] text-[#b8ecff]">
                    {variationId}
                  </h2>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium tracking-[0.04em] text-[#d6ecff]">
                      {variationDescriptor}
                    </div>
                    <p className="truncate text-[11px] leading-snug text-[#7a92b0]" title={variation.blurb}>
                      {variation.blurb}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => (allOn ? stopWholeVariation(variation.id) : playWholeVariation(variation.id))}
                    className={
                      "shrink-0 self-center rounded border px-3 py-1 text-[11px] uppercase tracking-[0.18em] " +
                      (anyOn
                        ? "border-[rgba(255,200,120,0.5)] bg-[rgba(255,200,120,0.1)] text-[#ffd49b]"
                        : "border-[rgba(106,215,255,0.4)] bg-[rgba(106,215,255,0.08)] text-[#6ad7ff]")
                    }
                  >
                    {allOn ? "stop all 3" : "play all 3"}
                  </button>
                </header>

                <div className="grid grid-cols-3 gap-3 pl-20">
                  {LAYERS.map((layer) => {
                    const key = stemKey(variation.id, layer);
                    const status = bufStatus[key];
                    const isPlaying = !!playing[key];
                    const statusColor =
                      status === "ready"
                        ? "bg-[#7bd58e]"
                        : status === "loading"
                          ? "bg-[#ffd49b] animate-pulse"
                          : status === "error"
                            ? "bg-[#ff9b9b]"
                            : "bg-[#3a4a5f]";
                    return (
                      <div
                        key={layer}
                        className={
                          "grid grid-cols-[3.5rem_4.5rem_1fr_auto] items-center gap-2 rounded border px-2.5 py-1.5 " +
                          (isPlaying
                            ? "border-[rgba(106,215,255,0.45)] bg-[rgba(106,215,255,0.08)]"
                            : "border-[rgba(106,215,255,0.12)] bg-[rgba(8,12,20,0.5)]")
                        }
                      >
                        <button
                          type="button"
                          onClick={() => void togglePlay(variation.id, layer)}
                          disabled={status === "error"}
                          className={
                            "rounded border px-1 py-0.5 text-[10px] uppercase tracking-[0.16em] " +
                            (isPlaying
                              ? "border-[rgba(255,200,120,0.5)] bg-[rgba(255,200,120,0.18)] text-[#ffd49b]"
                              : "border-[rgba(106,215,255,0.4)] bg-[rgba(106,215,255,0.08)] text-[#6ad7ff]") +
                            " disabled:opacity-30"
                          }
                        >
                          {isPlaying ? "stop" : "play"}
                        </button>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={"inline-block h-1.5 w-1.5 shrink-0 rounded-full " + statusColor}
                            title={status}
                          />
                          <span className="text-[10px] uppercase tracking-[0.16em] text-[#9bb5d6]">
                            {layer}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.005}
                          value={gains[key]}
                          onChange={(e) => {
                            const next = parseFloat(e.target.value);
                            setGains((g) => ({ ...g, [key]: next }));
                            persistLayerGain(variation.id, layer, next);
                          }}
                          className="min-w-0 accent-[#6ad7ff]"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setGains((g) => ({ ...g, [key]: variation.gains[layer] }));
                            persistLayerGain(variation.id, layer, variation.gains[layer]);
                          }}
                          title={`Reset to in-game default (${variation.gains[layer].toFixed(3)})`}
                          className="w-12 shrink-0 text-right text-[11px] tabular-nums text-[#d6ecff] hover:text-[#6ad7ff]"
                        >
                          {gains[key].toFixed(3)}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
};
