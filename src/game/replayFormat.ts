// Replay wire format. JSON shape is stable across (v: 2) revisions; bump the
// version when the binary layout or sim semantics change.

export const REPLAY_FORMAT_VERSION = 37;

// v2 added tutorial/veteran/bindings so wave-1 spawn (which forks on those
//   flags) and per-action key mapping reproduce on a different machine.
// v4 restores the recorded beatOffset on playback and moves wave-transition
//   spawn + death-respawn onto the sim clock; pre-v4 re-sims desync, so decode
//   rejects them rather than replaying a run that drifts off the recording.
// v5 records the beat-resnap watchdog's per-frame beatTime adjustments. Live
//   play nudges beatTime toward the audio clock once a measure (bleed) or hard-
//   snaps after a stall; replay has no audio clock and disables the watchdog, so
//   without these the recorded beatTime trajectory is unreproducible and the run
//   drifts off-beat ~30s in. See ReplayBeatResnap + beatResnapForCurrentFrame.
// v6 adds sparse tracker-style sim-state checkpoints (ReplayCheckpoint) that
//   replay asserts against, so a future desync surfaces the exact frame + field
//   that drifted instead of being noticed by eye. Verification only — not load-
//   bearing for the re-sim.
// v7 adds rngState to each checkpoint: the mulberry32 state, which fingerprints
//   the seeded-draw stream. A matching beatTime + score but mismatched rngState
//   localises a desync to an unseeded code path; matching rngState + mismatched
//   score points at a rhythm-judgment drift instead. Diagnostic only.
// v8 marks the torus-native world: ship-relative staged edge spawns (no
//   spawn-away rng retries), toroidal collision everywhere, and
//   contact-completed entrances all change sim semantics, so v7 recordings
//   would re-sim into a different run.
// v9 keys the end-of-wave transition (score drain + next-wave spawn) on
//   beatTime instead of summed dt, snapped to the beat grid — the payout and
//   spawn land at different sim moments than v8, and now stretch under
//   slow-mo, so v8 recordings would fail their checkpoints.
// v10 force-completes an entrance whose image recedes/exits fully off-screen
//   (the ship outran it). Entrance completion gates alien fire, so v9
//   recordings with a receding alien re-sim into different bullets.
// v11 rekeys the streak-end timeout: from raw beatTime since the last hit
//   instant to perceivedBeatTime since the last hit's beat center, in the
//   streak's own grid units (streakWindowClosed). Streak lifetime gates +1
//   rhythm bonuses, so v10 recordings re-sim with different combo totals.
// v12 stops counting a streak's seed shot: only 2nd-and-onward shots are
//   streak shots, so streakShots (the orb count / metric) runs one lower.
//   The metric feeds the wave bonus → score → bonus lives, so v11
//   recordings re-sim into different runs.
// v13 swaps the streak's per-shot +1 rhythm bonus for flat score payouts that
//   double with each counted shot, and rekeys the wave-summary streak metric
//   from total streak shots to the wave's largest streak (it feeds the wave
//   bonus). Combo totals AND score (→ bonus lives) both diverge, so v12
//   recordings re-sim into different runs.
// v14 flushes pending drift/rhythm bonuses at wave closure so the wave-ending
//   shot's staged +1s land inside the summary snapshot instead of being paid
//   mid-transition (or lost). Combo totals and the wave bonus shift at every
//   wave boundary cleared by a staged bonus, so v13 recordings desync.
// v15 reweighs knockback (mass proxy is maxHp + damageReduction, so armored
//   low-hp crystals no longer take the full reference speed per blocked shot)
//   and lets a bullet transfer momentum at most once, ever (repeat deflections
//   and later pierce hits shove nothing). Asteroid velocities → positions →
//   the whole run diverge, so v14 recordings re-sim into different runs.
// v16 resets the post-boss per-wave entity count to a flat 3 and adds the
//   phase citadel (its own spawn roll + seeded construction draws), so v15
//   recordings re-sim with a different wave roster from display-level 11 on.
// v17 lengthens the shockwave rumble (vibrate window before detonation) and
//   defers its start to the next beat tick, so the field-shatter + ship kick
//   land at a different sim moment and v16 recordings re-sim into different
//   runs.
// v18 reworks the citadel: no rotation (fewer constructor rng draws), a wider
//   escape hole (collision surface), and break-up warbles ejected away from
//   the ship, so v17 recordings with a citadel re-sim into different runs.
// v19 (retired before shipping — the slot is kept so v20 numbering stands)
//   briefly added a wave-skip wormhole; the feature was pulled and is being
//   rebuilt, so no v19 recordings exist.
// v20 re-ramps the post-boss per-wave entity count (3, 3, 4, 4, ... on the
//   pre-boss cadence instead of a flat 3), so v19 recordings re-sim with a
//   different wave roster from display-level 13 on.
// v21 widens the citadel's escape hole again (collision surface: the ship-safe
//   pocket and the inner-hit fire test both grow), so v20 recordings with a
//   citadel re-sim into different runs.
// v22 adds the alien wave-skip wormhole: player-killed aliens roll a seeded
//   skip depth and leave an enterable portal; entering it sweeps the field,
//   ends the wave toward a farther target, and holds the ship absent through
//   a title cascade before it re-emerges. New rng draws per alien kill plus
//   the changed wave roster mean v21 recordings re-sim into different runs.
// v23 makes each bonus-life score threshold double the previous one instead
//   of advancing by a fixed interval, so v22 recordings that cross the second
//   threshold re-sim with fewer lives and fail their checkpoints.
// v24 adds the lasershot refire lockout (a shot rejects new charge presses
//   until LASER_REFIRE_BEATS after the fire beat), so v23 recordings whose
//   presses land inside the lockout re-sim without those shots.
// v25 inserts a second rookie warm-up (a single solid crystal at internal
//   wave 1, after the single rock) for non-veteran Start-button runs, so a
//   v24 non-veteran recording's post-warm-up wave sequence and rng draws shift.
// v26 delays the boss laser fire 4 beats (beat 8 → beat 12, t=3.5 → t=5.5)
//   with a 3-beat pre-fire wind-up, so the sweep beam spawns at a later sim
//   moment and a v25 recording of a boss fight re-sims into different beams.
// v27 makes the boss hemispheres' armour directional (the rounded shell
//   deflects what the bare cut face lets through, resolved at the impact
//   point), so a v26 recording's post-break boss fight re-sims with different
//   deflections, damage, and knockback.
// v28 halves the lasershot refire lockout (LASER_REFIRE_BEATS 4 → 2), so a v27
//   recording whose charge presses landed in the now-unlocked beats re-sims
//   with those shots firing instead of being rejected.
// v29 makes a timed-out comet burst apart in place instead of diving through a
//   departure portal: it leaves game.comets the instant it hits its lifetime
//   (was ~0.68s later, after the warp-out) and stays a tangible target through
//   that final window (was intangible mid-warp), so a v28 recording that shot
//   or grazed a comet near end-of-life re-sims with a different hit outcome and
//   comet-count timing.
// v30 adds the metalChunk special rock (a per-slot spawn roll from internal
//   wave 6 on, before the solid/gem rolls), so a v29 recording of any wave ≥ 6
//   consumes a different rng draw sequence and re-sims into a different field.
// v31 gates rhythm/combo/streak gains on actual kills: a hit that
//   only cracks its target (bass chips, armor, multi-hp aliens) or
//   wastes a gem no longer increments the combo or stages drift
//   bonuses, and bass chip score pays flat (no combo multiply).
//   Off-beat hits still lose the combo; an on-beat non-kill hit
//   refreshes the streak's gap window without adding an orb
//   (extendStreakWindow). Combo totals and score both diverge, so
//   v30 recordings re-sim into different runs.
// v32 drops the eighth-note grid at combo ≥ 32: the cap now judges fires/hits on
//   quarter-notes (only the rapid powerup still doubletimes), so off-beat presses
//   no longer land on a slot and same-beat pairs no longer double-hit. The on-beat
//   window also stops tightening 40ms at the cap. Rhythm judging + combo/score
//   both diverge for any v31 run that reached 32, so those recordings re-sim into
//   different runs.
// v33 rebuilds the citadel break-up around the player standing inside it: the
//   three warbles are struck from the SHIP (not the shell centre) whenever it's
//   inside the footprint, born past a clearance that accounts for their own
//   radius, and given enough speed to outrun a ship travelling down their ray.
//   Shockwave-driven citadel breaks now get the ship pose too. Fragment
//   positions and speeds all move, so v32 recordings with a citadel re-sim into
//   different runs.
// v34 adds the bomb powerup to the canister drop pool. The pool is picked from
//   with a single seeded draw either way, so the RNG stream is untouched, but a
//   v33 recording's canister would now resolve to a different upgrade — and a
//   bomb changes bullet speed, size and damage, so the run diverges from there.
// v35 pulls every on-beat aim dot back by the shot's REAL collision reach instead of
//   a hardcoded stock-bullet one. A bomb's dot moves 25.7px further from the target
//   (its shells reach twice as far) and a combo>=12 dot 10.3px closer (that tier's
//   halo, and so its reach, is tighter). Dot positions feed the drift-lock proximity
//   test, which is sim state, so a v34 recording that hovered a lock at either of
//   those can lock on a different frame and re-sim into a different run.
// v36 adds the Far Shot rhythm bonus (a combo hit that lands N >= 2 quarter-note
//   beats after its shot was fired pays N-1 rhythm) and makes the trajectory preview
//   toroidal: every on-screen image of a target is walked, and an entering body only
//   at its entrance image. Combo totals move wherever a range-boosted shot lands deep,
//   and the drift-lock proximity (sim state) can now see a dot through the seam, so
//   v35 recordings re-sim into different runs.
// v37 adds the level-20 Sepulchre encounter (internal wave 21): the tomb and
//   its four Pallbearers replace what was an ordinary Act II wave, and the boss
//   table now absorbs a wave-skip landing at 21, so a v36 recording that
//   reached the end of Act II re-sims into a different wave.
// Beat-clock snapshot taken on the recording's first captured frame. These are
//   all deterministic dt-sums / dt-derived indices accumulated during the held
//   intro; restoring them on replay reproduces the recording's frame-0 beat
//   state. beatTime drives perceivedBeatTime (the whole on-beat gate); the
//   indices keep the bass pulse scheduler + combo evaluator from replaying a
//   backlog or stalling on frame 0.
export type ReplayStartBeat = {
  beatTime: number;
  lastBgBeatIndex: number;
  nextBeatToEvaluate: number;
  lastBeatResnapAt: number;
};

export type ReplayHeader = {
  v: number;
  build: string;
  seed: number;
  beatOffset: number;
  w: number;
  h: number;
  dpr: number;
  keyVocab: string[];
  startedAt: number;
  // pre-sim flags that fork beginFirstWaveByTutorialFlag — without these the
  //   watcher's localStorage decides wave 1, which can disagree with the run.
  tutorial: boolean;
  veteran: boolean;
  // recorded action→keys map so the replay-time isDown lookup matches the
  //   recording even if the watcher has rebound their controls.
  bindings: Record<string, string[]>;
  // Beat-clock state at the first captured frame. The run holds the world under
  //   the calibration/pilot's-log intro (beatTime ticks, no frames captured), so
  //   by the time recording's frame 0 lands beatTime is already T_intro — but a
  //   replay's startGame resets it to 0 with no intro. Restoring this snapshot
  //   before the first recorded frame aligns the beat gate + bass clock with the
  //   recording from frame 0. See ReplayStartBeat.
  startBeat: ReplayStartBeat;
  score: number;
  wave: number;
  maxCombo: number;
  killCount: number;
};

// One frame = [dtSeconds, downMask, upMask]. Masks are bit-indexed against
//   header.keyVocab. dt stored as a raw float (seconds) so there's zero
//   quantization drift between recording and replay — any rounding would
//   compound in scale-with-dt physics like turn rate and thrust ramp.
export type ReplayFrame = [number, number, number];

// One beat-resnap correction the live run applied: [frameIndex, beatTimeDelta].
//   beatTimeDelta is the net change the watchdog made to beatTime on that frame
//   (a small bleed delta, or a large jump on a hard-snap). Sparse — only frames
//   with a nonzero correction are stored; a clean run records none. Replay adds
//   each delta back on its frame to reproduce the recording's beatTime exactly.
export type ReplayBeatResnap = [number, number];

// Tracker-style ground-truth checkpoint of settled sim state at one frame. SC2's
//   replays carry an equivalent side-channel so external tools (and the engine)
//   can detect a re-sim that has drifted instead of silently rendering a wrong
//   replay. Unlike ReplayBeatResnap (load-bearing INPUT the sim can't recompute)
//   these are redundant OUTPUT: the re-sim should already produce them, and replay
//   asserts against them to catch the first frame + field that diverges. Sampled
//   sparsely (every N frames) so the always-on cost stays tiny — no per-frame ship
//   snapshot bloat. assertCheckpoint pinpoints the drift; see ReplayPlayer.
export type ReplayCheckpoint = {
  frame: number;
  score: number;
  wave: number;
  lives: number;
  beatCombo: number;
  beatTime: number;
  asteroids: number;
  bullets: number;
  aliens: number;
  // Current mulberry32 state — a fingerprint of how many seeded draws have run
  //   from the seed. Matches between record/replay IFF the rng streams are aligned;
  //   a mismatch means an UNSEEDED branch (or a differing count of seeded draws)
  //   was taken — i.e. a true determinism leak, vs. a pure rhythm-judgment drift
  //   that leaves rng untouched. The single most diagnostic checkpoint field.
  rngState: number;
};

// Per-frame ship snapshot for replay divergence debugging. Captured during the
//   live recording right after ship.update and packed alongside the input frames.
//   Replay re-captures the same snapshot post-ship.update and logs the first
//   frame whose state differs from the recording. Strip before shipping.
export type ReplayDebugFrame = {
  posX: number;
  posY: number;
  velX: number;
  velY: number;
  heading: number;
  keys: string[];
};

export type ReplayPayload = {
  header: ReplayHeader;
  frames: ReplayFrame[];
  // Sparse beat-resnap corrections, frame-indexed and ascending. Absent/empty
  //   when the run never drifted enough to trigger the watchdog.
  beatResnaps?: ReplayBeatResnap[];
  // Sparse sim-state checkpoints, frame-indexed and ascending. Replay asserts
  //   against them to detect a desync at the frame + field it first appears.
  checkpoints?: ReplayCheckpoint[];
  debugFrames?: ReplayDebugFrame[];
};

// ---------- (de)serialisation ----------

export const encodeReplay = async (payload: ReplayPayload): Promise<Uint8Array> => {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return await gzip(bytes);
};

export class UnsupportedReplayVersionError extends Error {
  constructor(readonly version: number) {
    super(`Unsupported replay version ${version} (expected ${REPLAY_FORMAT_VERSION})`);
    this.name = "UnsupportedReplayVersionError";
  }
}

export const decodeReplay = async (gz: Uint8Array): Promise<ReplayPayload> => {
  const bytes = await gunzip(gz);
  const json = new TextDecoder().decode(bytes);
  const payload = JSON.parse(json) as ReplayPayload;
  // Reject older formats outright: pre-v5 runs re-sim with a different beatOffset
  //   / wave-transition / respawn timing or lack recorded resnap corrections, so
  //   they'd drift off the recording. Better a clear failure than a wrong replay.
  if (payload.header.v !== REPLAY_FORMAT_VERSION) {
    throw new UnsupportedReplayVersionError(payload.header.v);
  }
  return payload;
};

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
};
