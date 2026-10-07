// Slow-mo slows the whole world — asteroids, comets, aliens, bullets,
// beatTime and bass audio all step at SLOW_MO_FACTOR speed. The player
// ship and the slowMoTimer itself keep wall-clock dt so the player's
// reactions feel responsive and the effect doesn't extend its own lifespan.
export const SLOW_MO_DURATION = 36;
export const SLOW_MO_FACTOR = 0.75;
// Ease the music-clock factor 1.0 ↔ SLOW_MO_FACTOR over this many seconds at
// each edge of the slow-mo window. The pulsar's quarter-note beat audibly
// stretches into and out of slow-mo instead of snapping rate-changes mid-bar.
export const SLOW_MO_RAMP = 3.5;

// Smoothstep eases the slowdown so the beat doesn't decelerate at a constant
// rate — the rate-of-change itself fades in/out, which is what makes it read
// as "the world is sinking into molasses" rather than a tape-speed shift.
const smoothstep = (t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

// Compute the music-clock delta for this frame, given the wall-clock dt
// and the remaining slow-mo timer. Doesn't decrement the timer — caller
// owns its lifetime so slow-mo's lifespan isn't shortened by its own effect.
// At each edge of the timer window, the factor eases between 1 and
// SLOW_MO_FACTOR over SLOW_MO_RAMP seconds so the beat tempo glides.
export const musicDtForFrame = (dt: number, slowMoTimer: number): number => {
  if (slowMoTimer <= 0) return dt;
  const elapsed = SLOW_MO_DURATION - slowMoTimer;
  // Ramp-in progress at the start of the effect; ramp-out progress at the end.
  // min() gates the steady-state interior at full slow-mo even if the two
  // ramps would otherwise overlap on a very short SLOW_MO_DURATION.
  const rampIn = smoothstep(elapsed / SLOW_MO_RAMP);
  const rampOut = smoothstep(slowMoTimer / SLOW_MO_RAMP);
  const slowness = Math.min(rampIn, rampOut);
  const factor = 1 + (SLOW_MO_FACTOR - 1) * slowness;
  return dt * factor;
};
