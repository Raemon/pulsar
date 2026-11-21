// Player audio preferences: per-channel volume for the four mix groups
//   - basePulse: the background pulsar approach beat (bgBeat).
//   - sfx:       gameplay one-shots (fire, explosions, alien fire, bass kit, …).
//   - music:     combo-halo halo music stems (ambient/melodic/layer3).
//   - vocals:    Pilot's Log captain VO.
//
// Each channel is stored 0..1 in localStorage; Sound applies it as a
//   multiplier on the per-channel gain node. SettingsDialog reads + writes
//   the values and dispatches `audio-pref:changed` so a running Sound
//   instance can update its gain nodes live.
//
// Migration: older builds used `pulsar.vocalsEnabled.v1` ("1"/"0") to toggle
//   vocals on/off. If we see that key on first read we collapse it into the
//   new vocals volume (0 if disabled, 1 if enabled) and leave the legacy key
//   in place (harmless if it's still there).

export type AudioChannel = "basePulse" | "sfx" | "music" | "vocals";

const STORAGE_KEYS: Record<AudioChannel, string> = {
  basePulse: "pulsar.audio.basePulse.v1",
  sfx:       "pulsar.audio.sfx.v1",
  music:     "pulsar.audio.music.v1",
  vocals:    "pulsar.audio.vocals.v1",
};

const DEFAULTS: Record<AudioChannel, number> = {
  basePulse: 1,
  sfx:       1,
  music:     1,
  vocals:    1,
};

const LEGACY_VOCALS_KEY = "pulsar.vocalsEnabled.v1";

const cache: Partial<Record<AudioChannel, number>> = {};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export const CHANNEL_ORDER: readonly AudioChannel[] = ["basePulse", "sfx", "music", "vocals"];

export const CHANNEL_LABELS: Record<AudioChannel, string> = {
  basePulse: "Base Pulse",
  sfx:       "Sound Effects",
  music:     "Music",
  vocals:    "Vocals",
};

export const getChannelVolume = (channel: AudioChannel): number => {
  const cached = cache[channel];
  if (cached !== undefined) return cached;
  let v = DEFAULTS[channel];
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[channel]);
    if (raw !== null) {
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed)) v = clamp01(parsed);
    } else if (channel === "vocals") {
      const legacy = localStorage.getItem(LEGACY_VOCALS_KEY);
      if (legacy === "0") v = 0;
    }
  } catch {
    // private mode / blocked storage — fall through with the default.
  }
  cache[channel] = v;
  return v;
};

export const setChannelVolume = (channel: AudioChannel, v: number): void => {
  const clamped = clamp01(v);
  cache[channel] = clamped;
  try {
    localStorage.setItem(STORAGE_KEYS[channel], String(clamped));
  } catch {
    // preference applies for the session only.
  }
  try {
    window.dispatchEvent(new CustomEvent("audio-pref:changed", {
      detail: { channel, value: clamped },
    }));
  } catch {
    // no-op in non-DOM contexts.
  }
};
