import type { Game } from "../Game";

// Veteran pilots skip the single-rock warm-up and the wave-title teaching
// hints. The "Show Tutorial" setting is the inverse of this flag. It flips on
// by itself exactly once, when the pilot first climbs to a 12x rhythm combo on
// VETERAN_STREAKS_NEEDED separate streaks; after that only the setting moves
// it, so a pilot who turns tutorials back on keeps them. Pilots stamped under
// the older one-streak rule keep their flag. Kept import-light so the settings
// dialog and the reticule can read it without the wave director's graph.
const VETERAN_KEY = "pulsar.veteran";
const VETERAN_STREAKS_KEY = "pulsar.veteranStreaks";
const VETERAN_COMBO_THRESHOLD = 12;
const VETERAN_STREAKS_NEEDED = 3;

export const isVeteranPilot = (): boolean => {
  try {
    return localStorage.getItem(VETERAN_KEY) === "1";
  } catch {
    return false;
  }
};

export const setVeteranPilot = (veteran: boolean) => {
  try {
    if (veteran) localStorage.setItem(VETERAN_KEY, "1");
    else localStorage.removeItem(VETERAN_KEY);
  } catch {
    // localStorage may be blocked (private mode); the setting just won't stick.
  }
};

// Call after any combo increase with the combo it climbed from; counts one
// streak each time the combo crosses the threshold. Replays never count.
export const noteRhythmComboClimb = (game: Game, before: number) => {
  if (game.replayPlayer || before >= VETERAN_COMBO_THRESHOLD || game.beatCombo < VETERAN_COMBO_THRESHOLD) return;
  try {
    const streaks = (Number(localStorage.getItem(VETERAN_STREAKS_KEY)) || 0) + 1;
    localStorage.setItem(VETERAN_STREAKS_KEY, String(streaks));
    if (streaks === VETERAN_STREAKS_NEEDED) setVeteranPilot(true);
  } catch {
    // localStorage may be blocked (private mode); next run just won't skip.
  }
};
