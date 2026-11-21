// Cryptic, oblique gameplay advice in the Pulsar voice — half-prose, half-lullaby,
//   rhymes that almost land. Three are picked at random for the daily intro
//   sequence: one from each slot pool so the sequence progresses from
//   arrival → skill → letting-go, leading into "Become one with the Pulsar."
//   Keep each line short enough to fit on one screen-width row at the
//   typography used in <IntroSequence>.

const SLOT_1_POOL: readonly string[] = [
  "Take a breath.",
  "Take it slow.",
  "Listen to the stars.",
  "Feel the pulse.",
  "Feel the beat.",
  "Aim for the target.",
];

const SLOT_2_POOL: readonly string[] = [
  "Aim carefully.",
  "One shot. One kill.",
  "Hit on the beat.",
  "It's okay to wait.",
  "Patience.",
  "Drift gently.",
  "Trust your instincts. (Also your targeting system.)",
  "Fire on the beat. Hit on the beat.",
  "Build rhythm, carefully.",
  "Find the rhythm.",
  "Become stronger.",
  "Drift among the asteroids.",
  "Get in sync.",
  "Heartbeat to heartbeat.",
];

const SLOT_3_POOL: readonly string[] = [
  "Dance with the void.",
  "Keep a warm mug of coffee. This'll be a long job.",
  "Don't forget your son.",
  "Don't lose contact with command.",
  "Tell your son you'll be home soon.",
  "Remember your promise to your wife.",
  "The stars are singing.",
  "You have all the time in the world.",
  "Don't forget the way back.",
  "Don't lose the way forward.",
  "Don't get lost.",
  "Unfold the photo on your cockpit dashboard.",
];

// One line under the "Wave N" title, for pilots who are not yet veterans (12× on three streaks).
//   Drawn at random each wave, including the Wave 0 title after the first
//   clear. The line just shown is skipped so two waves don't repeat it.
const WAVE_INTRO_HINTS: readonly string[] = [
  "Fire on the beat. Hit on the beat.",
  "Use your targeting system",
  "Drift awhile. Line up the perfect shot",
  "Line up the perfect shot",
  "Use your side thrusters",
  "Fire (and hit) on the beat",
  "One shot. One kill",
  "Patience. Drift gently",
  "Slow down",
  "Feel the beat",
  "Feel the beat. Fire on the beat. Hit on the beat",
  "Slow down and dance with the asteroids",
  "Sometimes, the key is to slow down",
  "Use retro thrusters to slow down",
  "Line up your reticule with the target",
  "Match velocity for a Drift Shot",
];

let lastWaveIntroHint: string | null = null;

export const waveIntroHint = (): string => {
  const fresh = WAVE_INTRO_HINTS.filter((hint) => hint !== lastWaveIntroHint);
  const pool = fresh.length > 0 ? fresh : WAVE_INTRO_HINTS;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  lastWaveIntroHint = pick;
  return pick;
};

const SLOT_POOLS: readonly (readonly string[])[] = [SLOT_1_POOL, SLOT_2_POOL, SLOT_3_POOL];

const HINT_KEY = "pulsar.lastIntroHints.v1";

const loadRecent = (): string[] => {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
};

const saveRecent = (hints: string[]) => {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(hints));
  } catch {
    // ignore
  }
};

const pickFromPool = (pool: readonly string[], avoid: Set<string>): string => {
  const fresh = pool.filter((h) => !avoid.has(h));
  const usable = fresh.length > 0 ? fresh : pool;
  return usable[Math.floor(Math.random() * usable.length)];
};

// Picks `count` hints. For count===3, draws one from each slot pool so the
//   sequence reads opener → middle → closer. For count===1 (shortHint flavor),
//   pulls from the combined pool so single-hint intros aren't stuck on
//   openers. In both cases, prefers lines not used last run.
export const pickIntroHints = (count: number): string[] => {
  const recent = new Set(loadRecent());

  if (count === 3) {
    const out = SLOT_POOLS.map((pool) => pickFromPool(pool, recent));
    saveRecent(out);
    return out;
  }

  const combined = SLOT_POOLS.flat();
  const pool = [...combined];
  const out: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const fresh = pool.filter((h) => !recent.has(h));
    const usable = fresh.length > 0 ? fresh : pool;
    const pick = usable[Math.floor(Math.random() * usable.length)];
    out.push(pick);
    const idx = pool.indexOf(pick);
    if (idx >= 0) pool.splice(idx, 1);
  }
  saveRecent(out);
  return out;
};
