// Per-song timing config for the full-length halo songs (the L1–9 "different
// system" in haloFullMusicConfig.ts). The on-disk source of truth is
// /sounds/halo-full-config.json; the /music page's Beat Sync section POSTs
// changes back via the dev plugin in vite.config.ts (route /__halo-full-config__)
// so a drag-to-align edit is committable.
//
// Same load/save shape as musicConfig.ts. The only tunable today is a per-song
// `offsetS` — how far the stems are slid against the game's beat grid so the
// song's musical downbeat lands on the bass-field downbeat. It's applied as a
// buffer read offset (with wraparound) in Sound.startHaloFullMusic, NOT a
// rebuild — so tuning by ear here translates 1:1 to in-game playback.

import type { FullHaloSong } from "./game/haloFullMusicConfig";

export type HaloFullConfig = {
  _version: number;
  // Seconds to advance each song's playback start within its own buffer. May be
  // negative; Sound.startHaloFullMusic wraps it into [0, duration) so the track
  // cycles end→beginning. Absent song = 0 offset. This is the SHARED base
  // offset applied to every layer that has no per-layer override below.
  offsets: Partial<Record<FullHaloSong, number>>;
  // Optional per-layer (l1..l6) overrides. layerOffsets[song][i] supersedes the
  // shared offsets[song] for layer i when finite; otherwise the layer inherits
  // the shared value. Used to nudge a single stem that was baked a hair off the
  // others (cmd-drag in the Beat Sync editor). Absent / NaN entry = inherit.
  layerOffsets?: Partial<Record<FullHaloSong, number[]>>;
};

let current: HaloFullConfig = { _version: 1, offsets: {} };
let loaded = false;

export async function loadHaloFullConfig(): Promise<HaloFullConfig> {
  if (loaded) return current;
  try {
    const res = await fetch("/sounds/halo-full-config.json", { cache: "no-store" });
    if (res.ok) {
      const json = (await res.json()) as HaloFullConfig;
      if (json && typeof json === "object") current = json;
    }
  } catch {
    // No config — songs play at offset 0 (stems' sample-0).
  }
  loaded = true;
  return current;
}

export function getHaloFullConfig(): HaloFullConfig {
  return current;
}

export function setHaloFullConfig(c: HaloFullConfig) {
  current = c;
  loaded = true;
}

// Per-song shared offset in seconds, defaulting to 0 when unset. Sound.ts reads
// this when starting a full song so the page's drag-aligned value is what plays.
export function fullHaloOffset(song: FullHaloSong): number {
  const v = current.offsets[song];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Effective offset for one layer (0-based l1..l6): the per-layer override if
// finite, else the shared song offset. This is what Sound.startHaloFullMusic
// applies per source so a single nudged stem stays nudged in-game.
export function fullHaloLayerOffset(song: FullHaloSong, layerIdx: number): number {
  const perLayer = current.layerOffsets?.[song];
  const v = perLayer?.[layerIdx];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fullHaloOffset(song);
}

// POST the config to the dev endpoint, then update local state. Returns true on
// a successful dev write; false in prod (the page still works, edits just don't
// hit disk). Mirrors saveMusicConfig.
export async function saveHaloFullConfig(c: HaloFullConfig): Promise<boolean> {
  setHaloFullConfig(c);
  try {
    const res = await fetch("/__halo-full-config__", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c, null, 2),
    });
    return res.ok;
  } catch {
    return false;
  }
}
