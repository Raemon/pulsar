// Shared halo-music tuning config — loaded by both the game (Sound.ts) and
// the /music page. The on-disk source of truth is /sounds/music-config.json;
// the page POSTs changes back via the dev plugin in vite.config.ts so edits
// are committable.
//
// Mirrors the pattern in soundConfig.ts. Each variation has three layer gains
// (ambient / melodic / layer3) that override the hardcoded defaults in
// Sound.haloMusicGain / Sound.haloMusicLayer3Gain when present.

import type { HaloMusicVariation } from "./Sound";

type TunableVariation = Exclude<HaloMusicVariation, "none">;
export type MusicLayer = "ambient" | "melodic" | "layer3";

export type LayerGains = Record<MusicLayer, number>;

export type MusicConfig = {
  _version: number;
  variations: Partial<Record<TunableVariation, Partial<LayerGains>>>;
};

let current: MusicConfig = { _version: 1, variations: {} };
let loaded = false;

export async function loadMusicConfig(): Promise<MusicConfig> {
  if (loaded) return current;
  try {
    const res = await fetch("/sounds/music-config.json", { cache: "no-store" });
    if (res.ok) {
      const json = (await res.json()) as MusicConfig;
      if (json && typeof json === "object") current = json;
    }
  } catch {
    // No config — run on hardcoded defaults baked into Sound.ts.
  }
  loaded = true;
  return current;
}

export function getMusicConfig(): MusicConfig {
  return current;
}

export function setMusicConfig(c: MusicConfig) {
  current = c;
  loaded = true;
}

// Look up the tuned gain for a (variation, layer), falling back to the
// hardcoded default the caller passes. Sound.ts uses this so the page's
// edits take effect without changing call sites.
export function musicGain(variation: HaloMusicVariation, layer: MusicLayer, fallback: number): number {
  if (variation === "none") return fallback;
  const entry = current.variations[variation as TunableVariation];
  if (!entry) return fallback;
  const v = entry[layer];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// Editor uses this. POSTs the config to the dev endpoint then updates local
// state. Returns true on a successful dev write; false in prod (the page
// still works, edits just don't hit disk).
export async function saveMusicConfig(c: MusicConfig): Promise<boolean> {
  setMusicConfig(c);
  try {
    const res = await fetch("/__music-config__", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c, null, 2),
    });
    return res.ok;
  } catch {
    return false;
  }
}
