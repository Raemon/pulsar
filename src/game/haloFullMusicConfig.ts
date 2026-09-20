// Full-length halo music — a SEPARATE system from the 32s-loop pool in
// haloMusicConfig.ts. Where the loop pool plays a short C-pedal loop with three
// combo-tier layers (4x/6x/12x), a full song plays a whole through-composed
// track (~2:10) split into SIX layers that fade in at 4x/6x/12x/18x/24x/32x.
//
// All six layers are the full song length and phase-locked, so a tier change is
// just a gain ramp (same contract as the loop system). The track does NOT loop:
// when it reaches its end the player is switched to the next full song (see
// pickFullHaloSongExcluding). Scoped to internal waves 1–10 (display levels 0–9)
// — the same range the standard loop pool covers — and gated behind
// USE_FULL_HALO_MUSIC so the loop pool stays the default until this is enabled.
//
// Stems live in /sounds/halo-music-full/{song}-l1..l6.mp3, built by
// scripts/music-gen/process_mothlight-full.py (115 BPM → locked to 120, key
// shifted to C major to sit on the bass field's C bed like the loop pool).
import { audioRng as rng } from "./rng";

// The combo thresholds at which each of the six layers fades in. Index i is the
// combo at which layer (i+1) becomes audible. Shared by every full song.
export const FULL_HALO_TIER_THRESHOLDS = [4, 6, 12, 18, 24, 32] as const;

export type FullHaloSong = "mothlight";

// Registry of full-length songs. Each song is six layer stems
// ({song}-l1..l6.mp3); layerOrder documents what each layer is (the build
// script's taste call) so the /music page and future tuning know the palette.
export type FullHaloSongDef = {
  song: FullHaloSong;
  // Track length in seconds — used to schedule the end-of-song switch. Must
  // match the built stems' duration (all six layers are equal length).
  durationS: number;
  // Human-readable layer roster, l1→l6 (low combo → climax).
  layerOrder: readonly string[];
};

export const FULL_HALO_SONGS: Record<FullHaloSong, FullHaloSongDef> = {
  mothlight: {
    song: "mothlight",
    durationS: 119.88,
    layerOrder: ["atmosphere-bed", "pulse-no-guitar", "guitar", "bass", "drums-high", "shimmer"],
  },
};

// Master switch: when true, internal waves 1–10 play a full-length song instead
// of a 32s loop from HALO_MUSIC_POOL. Leaves the loop pool (and the haunting /
// boss pools) untouched on every other wave.
// TEMPORARILY DISABLED: falls back to the 32s loop pool on waves 1–10 while the
// mothlight beat-sync is being dialed in. Flip back to true to re-enable.
export const USE_FULL_HALO_MUSIC = false;

// Internal-wave range that gets full-length songs (display levels 0–9). Matches
// the standard loop pool's range; boss (11) and haunting (12–20) are unaffected.
const FULL_HALO_WAVE_MIN = 1;
const FULL_HALO_WAVE_MAX = 10;

export function isFullHaloWave(wave: number): boolean {
  return USE_FULL_HALO_MUSIC && wave >= FULL_HALO_WAVE_MIN && wave <= FULL_HALO_WAVE_MAX;
}

const ALL_SONGS = Object.keys(FULL_HALO_SONGS) as FullHaloSong[];

// Pick a random full song. Like the loop pool's picker this draws the
//   audio-pick stream (see game/rng.ts), never the gameplay one.
export function pickFullHaloSong(): FullHaloSong {
  return ALL_SONGS[Math.floor(rng() * ALL_SONGS.length)];
}

// Pick a full song different from `current` — used when a track reaches its end
// and we roll over to the next one. Falls back to `current` if it's the only
// song available (so a single-song roster just repeats).
export function pickFullHaloSongExcluding(current: FullHaloSong): FullHaloSong {
  const others = ALL_SONGS.filter((s) => s !== current);
  if (others.length === 0) return current;
  return others[Math.floor(rng() * others.length)];
}
