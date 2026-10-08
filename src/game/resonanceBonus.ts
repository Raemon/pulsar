import type { Game } from "../Game";
import type { Asteroid, AsteroidSize } from "../Asteroid";
import { ENTITY_CONFIG } from "./entityConfig";

// Per-piece resonance value by size. Large bassteroids are worth nothing (an
//   unbroken rock gives no bonus); the medium and small fragments a break leaves
//   behind are each worth a flat point bounty while they're still on the field.
export const RESONANCE_VALUE: Record<AsteroidSize, number> = {
  // A giant (huge) bassteroid is unbroken too, so it pays nothing either.
  huge: 0,
  large: 0,
  medium: 10,
  small: 25,
};

// Beat-active boss shards are worth more than a stock small piece — they're
//   the rare late-game rubble that rings on its own slot, so cashing the field
//   while it pulses pays out heavier than a Bassteroid splinter.
const BEAT_FRAGMENT_VALUE = 40;

// One ringing piece's standalone contribution — used for the live-field total
//   and the bass-echo "+N" tag a lightning arc pins beside the piece. Both
//   Bassteroid splinters and beat-active boss shards qualify.
export const resonanceValueOf = (a: Asteroid): number =>
  a.isBass() ? RESONANCE_VALUE[a.size]
  : a.isBeatFragment() ? BEAT_FRAGMENT_VALUE
  : a.isSuperBassCrystal() ? ENTITY_CONFIG.superBassCrystal.resonanceValue
  : 0;

// Resonance bonus: the summed value of every live bassteroid piece on the field.
//   Each piece contributes independently of the others, so destroying one medium
//   leaves its sibling still worth +10. Added to a kill's base score before the
//   Rhythm multiply (see awardScoreForKill), and applied to ALL on-beat kills, not
//   just bass kills — sweep the field while the broken pieces still ring.
export const resonanceBonus = (game: Game): number => {
  let bonus = 0;
  for (const a of game.asteroids) bonus += resonanceValueOf(a);
  return bonus;
};
