// Where the run's seams fall. Each act is the span of waves running up to and
// including its own boss, and this table is the single source of truth for
// both — the wave the boss fights on, and the wave before it that puts the
// thing in the sky.
//
// Act I (internal waves 1-11) is the rock field learning to play the song: the
// bassteroids lay the measure down, aliens and comets cut across it, and the
// looming red planet that has been drifting overhead the whole time turns out
// to have an eye. Act II (12-21) is the wake — cathedral rubble, phase
// citadels, prisons full of wraiths — and it ends at the tomb all that
// masonry fell off: the Sepulchre and the four Pallbearers carrying it.
//
// Internal wave numbering stays 1-based (displayWave labels it one lower), so
// these two fights are the player's "level 10" and "level 20".

export type BossKind = "boss" | "sepulchre";

export type BossEncounter = {
  act: number;
  kind: BossKind;
  // Internal wave the fight itself happens on.
  wave: number;
  // The wave before it. The boss is already visible overhead — the sky work
  // is the only thing that happens on it (see Pulsar.setBossPlanetState).
  foreshadowWave: number;
};

export const BOSS_ENCOUNTERS: readonly BossEncounter[] = [
  { act: 1, kind: "boss", wave: 11, foreshadowWave: 10 },
  { act: 2, kind: "sepulchre", wave: 21, foreshadowWave: 20 },
];

export const BOSS_WAVES: readonly number[] = BOSS_ENCOUNTERS.map((b) => b.wave);
export const BOSS_FORESHADOW_WAVES: readonly number[] = BOSS_ENCOUNTERS.map((b) => b.foreshadowWave);

// The encounter fought on `wave`, or null on any ordinary wave.
export const bossEncounterForWave = (wave: number): BossEncounter | null =>
  BOSS_ENCOUNTERS.find((b) => b.wave === wave) ?? null;

// Which act a wave belongs to. Waves past the last boss keep that act's number
// so the endless tail doesn't fall off the end of the table.
export const actOfWave = (wave: number): number => {
  for (const encounter of BOSS_ENCOUNTERS) {
    if (wave <= encounter.wave) return encounter.act;
  }
  return BOSS_ENCOUNTERS[BOSS_ENCOUNTERS.length - 1].act;
};

const ACT_TWO = BOSS_ENCOUNTERS[1];
const ACT_TWO_FIRST_WAVE = BOSS_ENCOUNTERS[0].wave + 1;

// How far into Act II a (possibly fractional) wave level sits, 0 at its first
// wave and 1 on the boss wave. The sky reads this to walk the Sepulchre's
// satellites out of the background and into the field around the player, so it
// takes the smoothed wave level rather than the integer wave — the swarm has
// to glide across a wave boundary, not jump.
export const actTwoProgress = (waveLevel: number): number => {
  const span = ACT_TWO.wave - ACT_TWO_FIRST_WAVE;
  return Math.max(0, Math.min(1, (waveLevel - ACT_TWO_FIRST_WAVE) / span));
};
