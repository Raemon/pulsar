// Halo music selection. Stems live in /sounds/halo-music/{variation}-{ambient,melodic,layer3}.mp3.
//
// Each time the player crosses combo ≥ 4 from below, syncHaloAmbient picks
// a random variation from the wave-appropriate pool. The chosen variation
// persists for the lifetime of that halo (so 6x melodic and 12x layer3 use
// the same variation's stems); a new pick happens on the next 4x trigger
// after combo breaks.
//
// Pool selection follows the wave:
//   - internal waves 1–10 (display levels 0–9): HALO_MUSIC_POOL — the
//     standard six-variation rotation.
//   - internal wave 11 (display level 10, boss): BOSS_MUSIC_VARIATION
//     (vigil-sb) is force-picked.
//   - internal waves 12–20 (display levels 11–19): HAUNTING_MUSIC_POOL —
//     three ElevenLabs variations designed to feel creepier/more haunting
//     while still beautiful. The 24x climax swap stays inside this pool so
//     the arc's tone is preserved.
//
// To disable music entirely and fall back to the legacy synthesized pad,
// set HALO_MUSIC_POOL to []. To force a specific variation for an A/B test,
// set the pool to a single entry.
//
// Pool (32-second C-pedal loops, 4 phrases ×4 bars, calibrated against the
// in-game-mix audit, beat-clock-aligned start). Each variation's layer 3
// introduces a single new element thematically matched to its ambient +
// melodic stems:
//   cinematic-el  ElevenLabs cinematic bed + felt piano + a lonely solo violin
//          (sfizz + VPO3 — three single-pitch held notes A4/C5/G4, each
//          a chord tone of the underlying bed at that phrase).
//   musicbox-sb  Procedural sine pad + FluidSynth felt piano + slow felt-mallet
//          glockenspiel arpeggio (warm chime, not a kit — extends the
//          felt-piano sparkle into the upper octave).
//   synthwave-el  ElevenLabs analog-synthwave Juno pad + soft lead + pulsed
//          synth-bass arp on the off-beats (synthwave-appropriate motion,
//          octave-low to fill the space the lead leaves).
//   vaporwave-el  ElevenLabs dawn/vaporwave: glassy string-choir pad (ambient) +
//          sparse felt-bell sustains (melodic) + bright crystal-glockenspiel
//          arpeggio (layer 3). All three stems live in mid-upper register so
//          the bass field stays clean even with all layers active.
//   outerwilds-el  ElevenLabs Outer-Wilds folk: distant drone pad (ambient) +
//          fingerpicked acoustic guitar in G mixolydian (melodic, plucks
//          quantized to the 8th-note grid via piecewise rubberband stretch)
//          + sparse held-note pump organ in upper register (layer 3, three
//          long notes per 32s loop, Cmaj7 voicing). The melodic guitar is
//          G-rooted over the bass field's C — a deliberate V-over-I
//          suspension that never resolves, suiting the haunting vibe.
//
// Every pool entry is fetched + decoded at startGame so the first 4x
// doesn't pay fetch latency regardless of which one comes up.
import { BOSS_ENCOUNTERS, bossEncounterForWave, type BossKind } from "./acts";

import type { HaloMusicVariation } from "../Sound";
// Music-track variation picks are audio/cosmetic and fire from syncHaloAmbient,
//   which branches on live audio state the muted replay re-sim doesn't share —
//   so they must draw the cosmetic stream, never the gameplay one (would desync).
import { cosmeticRng as rng } from "./rng";

// Master on/off for the combo-driven music layers. When false, the 4x/6x/12x
// halo tiers still light up visually but no music (pre-rendered or legacy
// synth pad) starts — the field stays at bass-only.
export const PLAY_COMBO_MUSIC = true;

export const HALO_MUSIC_POOL: readonly HaloMusicVariation[] = ["cinematic-el", "musicbox-sb", "synthwave-el", "vaporwave-el", "outerwilds-el"];

// Post-boss "haunting" pool. Picked from on internal waves 12–20 (display
// levels 11–19) instead of HALO_MUSIC_POOL. Three ElevenLabs variations
// designed to feel creepier/more haunting than the standard rotation while
// still beautiful: cathedral hymn with a low monastic chant, an AM-radio
// ghost transmission with whispered breaths, and a submerged requiem with
// ghostly celesta. spectral-toll-sb adds a fourth: a deep C/G drone under a
// mournful solo cello, answered by sparse procedural glass bells. Each is 32 s
// C-pedal-tolerant just like the standard pool, so the same combo-tier layering
// still works.
export const HAUNTING_MUSIC_POOL: readonly HaloMusicVariation[] = ["cathedral-hymn-el", "lost-transmission-el", "underwater-requiem-el", "spectral-toll-sb"];

// Internal-wave range during which HAUNTING_MUSIC_POOL replaces HALO_MUSIC_POOL.
// Display level = wave - 1, so internal 12..20 = display 11..19. Internal
// wave 11 is the boss (display "10") and uses BOSS_MUSIC_VARIATION instead.
const HAUNTING_WAVE_MIN = 12;
const HAUNTING_WAVE_MAX = 20;

export function isHauntingWave(wave: number): boolean {
  return wave >= HAUNTING_WAVE_MIN && wave <= HAUNTING_WAVE_MAX;
}

// Dedicated boss-fight variations. Force-picked by syncHaloAmbient whenever the
// current wave is a boss wave (see BOSS_ENCOUNTERS), so the fight's own theme
// replaces the random halo pick for the whole engagement. Kept out of
// HALO_MUSIC_POOL so neither appears at random on an ordinary wave.
//
// "vigil-sb" is built as the *climax of the levels 1–9 halo music* — the same
// felt-piano + sine-pad + glassy-chime palette, turned climactic-and-scary
// (minor-leaning drift, a Db♭9/tritone "scare" phrase, an accelerating
// heartbeat) rather than swapping to a new instrument family.
//
// "knell-sb" is the funeral death-knell track (tolling bell + ghost choir +
// string ostinato) — the Sepulchre's own music. Its tolling tubular bell is
// literally what the four Pallbearers are playing along to.
//
// Keyed by boss kind so each act's fight brings its own theme: the planetoid
// gets the climax of the music the player has been flying to all of Act I, and
// the tomb gets the knell Act II has been haunted by.
const BOSS_MUSIC_BY_KIND: Record<BossKind, HaloMusicVariation> = {
  boss: "vigil-sb",
  sepulchre: "knell-sb",
};

// Every boss theme, for the preload paths that need the whole set.
export const BOSS_MUSIC_VARIATIONS: readonly HaloMusicVariation[] = BOSS_ENCOUNTERS.map(
  (encounter) => BOSS_MUSIC_BY_KIND[encounter.kind],
);

// The theme forced on a boss wave, or null on any ordinary wave.
export function bossMusicVariation(wave: number): HaloMusicVariation | null {
  const encounter = bossEncounterForWave(wave);
  return encounter ? BOSS_MUSIC_BY_KIND[encounter.kind] : null;
}

// Effective per-wave pool used by the pickers below. Internal waves 12–20
// see only the haunting trio; every other wave sees the regular pool.
function poolForWave(wave: number): readonly HaloMusicVariation[] {
  return isHauntingWave(wave) ? HAUNTING_MUSIC_POOL : HALO_MUSIC_POOL;
}

// Pick a random variation from the wave-appropriate pool, or "none" if the
// pool is empty (which routes syncHaloAmbient to the legacy synthesized pad
// path).
export function pickHaloMusicVariation(wave: number): HaloMusicVariation {
  const pool = poolForWave(wave);
  if (pool.length === 0) return "none";
  return pool[Math.floor(rng() * pool.length)];
}

// Pick a random variation from the wave-appropriate pool excluding the
// currently-playing one. Used by the 24x climax swap so the new track always
// sounds different. During haunting waves the swap stays inside the haunting
// trio so the arc's tone doesn't break mid-combo.
export function pickHaloMusicVariationExcluding(current: HaloMusicVariation, wave: number): HaloMusicVariation {
  const pool = poolForWave(wave);
  if (pool.length === 0) return "none";
  if (pool.length === 1) return pool[0];
  const others = pool.filter((v) => v !== current);
  if (others.length === 0) return pool[0];
  return others[Math.floor(rng() * others.length)];
}
