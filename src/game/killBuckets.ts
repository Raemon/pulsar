// shared bucket names for kill-tally. killEffects.ts emits these strings into
//   game.killTally, and highscores.ts maps them to human-readable labels for the
//   leaderboard summary. Keeping the union here means a rename only needs to happen
//   in one place and TS will catch any drift.
export type KillBucket =
  | "asteroid_huge"
  | "asteroid_large"
  | "asteroid_medium"
  | "asteroid_small"
  | "bassteroid"
  | "chime"
  | "bell"
  | "warble"
  | "citadel"
  | "asteroidWithGem"
  | "burstGem"
  | "solidCrystal"
  | "metalChunk"
  | "alien_big"
  | "alien_medium"
  | "alien_small"
  | "comet"
  | "boss"
  | "sepulchre"
  | "glassPrison"
  | "wraith";
