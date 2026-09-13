import type { Game } from "../Game";
import { Asteroid, isBurstGem, isGlassPrison, isMetalHull, isPhasedKind } from "../Asteroid";
import { Alien } from "../Alien";
import { AlienBullet } from "../AlienBullet";
import { Comet } from "../Comet";
import { Bullet } from "../Bullet";
import { effectiveBulletSpeed } from "../ship/shipWeapons";
import { Vec, nearestImageOf } from "../vec";
import { ENTITY_CONFIG } from "./entityConfig";
import { spawnGemFan, spawnBurstGemFan } from "../Gem";
import { loseCombo, rebaseBeatEval } from "./rhythmGate";
import { syncComboHud, syncHud, flashScoreGain } from "./hud";
import { setFirstWaveHintStage, emitFirstWaveHintHitProgress, emitFirstWaveHintStage3Ready, emitFirstWaveHintRhythmProgress } from "./lifecycle";
import { tryUnlockPilotLog1, tryUnlockPilotLog3 } from "./pilotLog";
import { popupCombo, popupScore, popupDriftCombo } from "./popups";
import { resonanceBonus } from "./resonanceBonus";
import { trackRhythmComboHit, extendStreakWindow, beatsAwayAtHit } from "./rhythmBonus";
import { triggerBassLightning } from "./bassLightning";
import { spawnDriftBurst } from "./driftBurst";
import { checkBonusLife } from "./bonusLife";
import { spawnInkPatch } from "./inkCloud";
import { BEAT_GRID, DRIFT_RHYTHM_BONUS } from "./rhythmConstants";
import {
  emitExplosion,
  emitCrackParticles,
  emitAlienExplosion,
  emitCometExplosion,
  emitGlassPrisonShatter,
  emitWraithDeath,
} from "./particleBursts";
import { snapshotAsteroidKill, snapshotAlienKill, snapshotCometKill } from "./killSnapshot";
import { alignBassBeat, alignSplitChildToRhythm, newBeatClaimSet, markVeteranPilot } from "./waveDirector";
import { BASS_KIND_SOUND } from "./bassClock";
import { maybeSpawnSkipPortal } from "./waveSkip";
import type { KillBucket } from "./killBuckets";

// Last-gasp plasma bolt fired by an eye-core in the same frame it dies —
// a "died with its boots on" beat. Aims at the ship's current position
// (no telegraph; the eye is already broken) and skips the cooldown gate.
const fireBossEyeFinalShot = (game: Game, a: Asteroid) => {
  const shipImg = nearestImageOf(game.ship.pos, a.pos, game.w, game.h);
  const angle = Math.atan2(shipImg.y - a.pos.y, shipImg.x - a.pos.x);
  const speed = ENTITY_CONFIG.boss.eyeBulletSpeed;
  const muzzleDist = a.radius * 1.1;
  const muzzleX = a.pos.x + Math.cos(angle) * muzzleDist;
  const muzzleY = a.pos.y + Math.sin(angle) * muzzleDist;
  const bullet = new AlienBullet(
    { x: muzzleX, y: muzzleY },
    { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    "big",
    a.hue,
    true,
  );
  game.alienBullets.push(bullet);
  game.sound.play("alienFireBig", 1.0, a.pos);
};

// feeds the leaderboard's per-run breakdown; bucket names stay human-readable for display.
const bumpKill = (game: Game, bucket: KillBucket) => {
  game.killTally[bucket] = (game.killTally[bucket] ?? 0) + 1;
};

const asteroidBucket = (a: Asteroid): KillBucket => {
  if (a.kind === "boss" || a.isBossFragment()) return "boss";
  if (a.isSepulchreFamily()) return "sepulchre";
  if (a.isBass()) return "bassteroid";
  if (a.kind === "chime" || a.kind === "bell" || a.kind === "warble" || a.kind === "citadel") return a.kind;
  if (a.kind === "asteroidWithGem") return "asteroidWithGem";
  if (isBurstGem(a.kind)) return "burstGem";
  if (a.kind === "solidCrystal" || a.kind === "solidCrystalSmall") return "solidCrystal";
  if (isMetalHull(a.kind)) return "metalChunk";
  if (isGlassPrison(a.kind)) return "glassPrison";
  if (a.kind === "wraith") return "wraith";
  return `asteroid_${a.size}`;
};

// bassteroids run their own bassHit/bassEcho path; this maps the non-bass kinds to sounds.
export const hitSoundFor = (
  a: Asteroid,
): "explosionLarge" | "explosionMedium" | "explosionSmall" | "chime" | "bell" | "warble" | "crystalShatterLarge" | "crystalShatterSmall" | "wraithHit" | "wraithScream" => {
  if (a.kind === "chime") return "chime";
  if (a.kind === "bell") return "bell";
  if (a.kind === "warble") return "warble";
  // The citadel is a giant warble at heart — same phased ring on the kill.
  if (a.kind === "citadel") return "warble";
  // Solid crystal asteroids shatter like cut glass — the whole body IS the
  // gem, so a noise explosion would feel wrong. Large parent + small frags
  // each get their own size-scaled shatter.
  if (a.kind === "solidCrystal") return "crystalShatterLarge";
  if (a.kind === "solidCrystalSmall") return "crystalShatterSmall";
  // gold gem is a big cut-crystal body; its shards shatter small.
  if (isBurstGem(a.kind)) return "crystalShatterLarge";
  // A cathedral glass shard is still lit stained glass — it rings/shatters
  // like cut glass rather than going off with a stone-rubble thud.
  if (a.kind === "glassShard") return "crystalShatterSmall";
  // The prison's shell IS cut glass — same shatter as a solid crystal. The
  // scream is layered ON TOP by finishAsteroidKillCore (it isn't returned
  // here because callers also use this for the on-crack chip sound).
  if (isGlassPrison(a.kind)) return "crystalShatterLarge";
  // Wraith hit / death — the killing hit plays wraithScream as a second
  // overlay in finishAsteroidKillCore; this is the per-shot thud.
  if (a.kind === "wraith") return "wraithHit";
  return a.size === "huge" || a.size === "large" ? "explosionLarge" : a.size === "medium" ? "explosionMedium" : "explosionSmall";
};

// same combo-update rule for every kill type — one helper means callers don't reimplement.
//   hitPos anchors the "RHYTHM LOST" popup at the target the off-beat shot landed on.
//   Only kills (and gem cracks) route here; a landed hit that
//   didn't earn the kill goes through applyNonKillHitToCombo.
//   beatsAway is the shot's flight in beats (rhythmBonus.beatsAwayAtHit) for the Far Shot
//   bonus; strikes with no flight time (the laser) leave it 0.
export const applyHitToCombo = (game: Game, isOnBeatHit: boolean, hitPos: Vec, beatsAway = 0) => {
  if (isOnBeatHit && game.beatCombo >= 1) {
    const crossedSparkleThreshold = game.beatCombo === 31;
    game.beatCombo += 1;
    if (game.beatCombo > game.maxCombo) game.maxCombo = game.beatCombo;
    if (game.beatCombo > game.maxComboThisWave) game.maxComboThisWave = game.beatCombo;
    if (game.beatCombo >= 6) markVeteranPilot();
    trackRhythmComboHit(game, hitPos, beatsAway);
    // Dismiss the post-rhythm-loss "fire and hit on the beat" hint as soon as
    // the player lands one — reaching here means an on-beat fire was followed
    // by an on-beat hit. The component no-ops if it's not currently visible.
    // Also cancel a hint still deferred behind the controls pane: the player
    //   already demonstrated the skill, so the lesson is moot.
    game.rhythmLossHintPending = false;
    window.dispatchEvent(new CustomEvent("rhythm-loss-hint:dismiss"));
    // grid just halved (quarters→eighths) at the 32x sparkle threshold; resync the evaluator
    // so the freshly-uncovered odd eighths don't all close in a burst on the next frame.
    if (crossedSparkleThreshold && !game.ship.rapidActive) rebaseBeatEval(game);
    syncComboHud(game);
    tryUnlockPilotLog1(game);
    tryUnlockPilotLog3(game);
    advanceFirstWaveHintOnCombo(game);
    if (game.firstWaveHintStage === 4 && game.firstWaveOnBeatHitCount < 3) {
      // fire-and-hit stage. The first on-beat hit graduates the field to the
      //   big-asteroid tutorial phase (tickTutorialSpawn swaps the single small
      //   for one big, respawning on clear) and counts as hit 1 of 3; the
      //   remaining two land on subsequent bigs/children.
      if (game.firstWaveOnBeatHitCount === 0 && game.tutorialActive) game.tutorialFireHitDone = true;
      game.firstWaveOnBeatHitCount += 1;
      emitFirstWaveHintHitProgress(game.firstWaveOnBeatHitCount);
      if (game.firstWaveOnBeatHitCount >= 3) setFirstWaveHintStage(game, 5);
    } else if (game.firstWaveHintStage === 5) {
      // diamond N corresponds to rhythm N+1: 2x lights the first, 3x the
      //   second, 4x+ the third. A loss zeroes the row via loseCombo; this
      //   rebuilds it as on-beat hits restore the streak.
      emitFirstWaveHintRhythmProgress(Math.max(0, Math.min(game.beatCombo - 1, 3)));
      // crossed to 4x rhythm — kick off the React-side 3s hold + fade.
      if (game.beatCombo === 4) emitFirstWaveHintStage3Ready();
    }
  } else if (!isOnBeatHit && game.beatCombo !== 0) {
    loseCombo(game, hitPos, "hit");
  }
};

// 6x is the backstop for the case where the player blasts past the stage
//   progression while a hint is still up. Stage 6 is the closing flourish
//   that auto-dismisses on its own timer; don't cut it short.
const advanceFirstWaveHintOnCombo = (game: Game) => {
  if (game.beatCombo >= 6 && game.firstWaveHintStage !== 0 && game.firstWaveHintStage !== 6) {
    setFirstWaveHintStage(game, 0);
  }
};

// multiplier + sparkle + popup are the on-beat reward — one helper guarantees consistency.
//   Returns the points actually added so the parade can flash the same "+N" per kill.
//   Shared by every scored kill (asteroid/alien/gem) so rhythm-multiply, the combo
//   popup, and the drift-tier bonus staging live in exactly one place.
export const awardScoreForKill = (
  game: Game, hitPos: Vec, baseScore: number, isOnBeatHit: boolean, driftTier: number = 0,
): number => {
  let scoreEarned = baseScore;
  if (isOnBeatHit) {
    // Resonance folds into the item's value first (the live bass fragments'
    //   summed bounty), then Rhythm multiplies the lot — so a shattered field
    //   pays its +10/+25-per-piece bonus times the current combo.
    const multiplier = game.beatCombo;
    scoreEarned = Math.round((scoreEarned + resonanceBonus(game)) * multiplier);
    game.sound.play("comboSparkle", 1, hitPos);
    game.sound.playComboChime(multiplier, hitPos);
    // A drift shot shows its own staged combo numbers (popupDriftCombo, below), so suppress the
    //   generic combo popup for it — otherwise the hit-point combo reads twice.
    if (multiplier >= 2 && driftTier === 0) game.popups.push(popupCombo(hitPos, multiplier));
    // Drift Shot: on-beat hit by a bullet fired while a hover ring was locked queues a +1
    //   rhythm reward 1 beat later — the on-beat hit already bumped combo +1, so the drift's
    //   extra +1 lands the streak at +2 total over the pre-shot value, regardless of tier.
    //   Tier no longer scales rhythm (it scales damage only). Cancelled if the streak breaks.
    if (driftTier > 0) {
      // The on-beat hit already incremented beatCombo, so it now reads C+1; the drift bonus
      //   adds one more a beat later. Stage both so the player watches the streak build.
      const comboAfterHit = game.beatCombo;
      const dmgMult = driftTier + 1;
      const newBest = dmgMult > game.bestDriftDamageMultShown;
      if (newBest) game.bestDriftDamageMultShown = dmgMult;
      game.popups.push(popupDriftCombo(hitPos, comboAfterHit, false));
      game.pendingDriftBonuses.push({
        fireAt: game.perceivedBeatTime + BEAT_GRID,
        pos: { x: hitPos.x, y: hitPos.y },
        amount: DRIFT_RHYTHM_BONUS,
        tier: driftTier,
        showDamageMult: newBest,
      });
      // celebratory fanfare on top of the standard on-beat sparkle/chime —
      // tier scales the sub-boom so the top tier lands with real low-end weight.
      game.sound.playDriftShotHit(driftTier);
      // soundwave-visualizer explosion radiating from the hit, tier-coloured/sized.
      spawnDriftBurst(game, hitPos.x, hitPos.y, driftTier);
    }
  }
  game.score += scoreEarned;
  flashScoreGain(game, scoreEarned);
  checkBonusLife(game);
  return scoreEarned;
};

// only medium/small children carry drones (large bass has its own continuous low end).
const restartChildBassDrones = (game: Game, children: Asteroid[]) => {
  for (const c of children) {
    alignBassBeat(game, c);
    if (c.size === "medium" || c.size === "small") {
      game.sound.startBassteroidDrone(c, c.kind as "bassA" | "bassB" | "bassC" | "bassD", c.size, c.pos);
    }
  }
};

// audio-free core lets bullet vs ram paths stage their own kill-sound order independently.
//   scoreEarned is captured into the snapshot so the parade can flash "+N" beneath each sprite.
//   impactPos is the bullet position at the moment of the kill (or undefined for ram kills);
//   it lets split() classify center vs glancing hits for the asymmetric breakup patterns.
//   comboAtKill is the multiplier that drove the chime pitch; 0 for ram/off-beat kills.
const finishAsteroidKillCore = (
  game: Game,
  a: Asteroid,
  killerVel: Vec,
  isOnBeatHit: boolean,
  scoreEarned: number,
  comboAtKill: number,
  impactPos?: Vec,
): Asteroid[] => {
  // Glass prison + wraith get bespoke kill bursts instead of the generic
  // shard-and-particle explosion. The prison still emits shards (its shell
  // is physical glass that should shatter into Shard objects), but the
  // particle layer is dark/wisp-y rather than sparky; the wraith emits no
  // shards and only a dispersing wisp cloud.
  if (isGlassPrison(a.kind)) {
    emitGlassPrisonShatter(game.particles, game.shards, a);
    // Haunting cry — layered ON TOP of the shatter sound the caller will
    // play (crystalShatterLarge). Position-aware so the cry pans from where
    // the prison broke open.
    game.sound.play("wraithScream", 1, a.pos);
    // Inky blackout spreads from the break point — see game/inkCloud.ts.
    spawnInkPatch(game, a.pos);
  } else if (a.kind === "wraith") {
    emitWraithDeath(game.particles, a);
    // Release cry — layered ON TOP of the per-shot wraithHit thud the caller
    // plays. Echoes the birth scream's voice but resolves into an Eb-major
    // bloom: the captive let go, ascending. Position-aware pan from the kill.
    game.sound.play("wraithDeath", 1, a.pos);
  } else {
    emitExplosion(game.particles, game.shards, a, isOnBeatHit);
  }
  if (a.isBass()) game.sound.stopBassteroidDrone(a);
  if (isPhasedKind(a.kind)) game.sound.stopWarbleDrone(a);
  const asteroidHit = hitSoundFor(a);
  // parade replays the bassteroid's *beat* voice (kick/pluck/boom/snap) rather than the
  //   death-only bassEcho, so the trophy row plays "the sound this rock made", not how it died.
  const paradeSound = a.isBass()
    ? BASS_KIND_SOUND[a.kind as "bassA" | "bassB" | "bassC" | "bassD"]
    : asteroidHit;
  const snap = snapshotAsteroidKill(a, paradeSound, scoreEarned);
  if (snap) {
    // only medium/small bass have drones (large bass relies on its split children), so
    //   the parade only revives the drone bed for snapshots that had one in play.
    if (a.isBass() && (a.size === "medium" || a.size === "small")) {
      snap.bassDrone = { kind: a.kind as "bassA" | "bassB" | "bassC" | "bassD", size: a.size };
    }
    if (isOnBeatHit && comboAtKill >= 1) snap.rhythmHit = { combo: comboAtKill };
    game.killedSnapshots.push(snap);
  }
  bumpKill(game, asteroidBucket(a));
  if (a.kind === "asteroidWithGem") {
    // Eject the embedded gem at the dead rock's position; the fragment recipe
    // (handled inside split() below) takes care of the rubble cloud flying in
    // other directions.
    for (const g of spawnGemFan(a.pos, a.vel, 1)) game.gems.push(g);
  }
  if (isBurstGem(a.kind)) {
    // The burst gem doesn't crumble into rubble — its whole payout is a fan of
    // fast-flying gems thrown out from the kill, each a live rhythm target.
    const tier = a.kind === "burstGemBig" ? ENTITY_CONFIG.burstGem.big : ENTITY_CONFIG.burstGem.medium;
    for (const g of spawnBurstGemFan(a.pos, a.vel, killerVel, tier.shardCount, ENTITY_CONFIG.burstGem.shardSpeed, a.radius * 0.55)) {
      game.gems.push(g);
    }
  }
  if (a.kind === "solidCrystal" && a.embeddedGemCount > 0) {
    // Pure-crystal rock drops the same number of gems that were visible as
    // frosted hints inside its body (decided at spawn), fanned out from the
    // dead rock's position just like a regular gem-bearing asteroid.
    for (const g of spawnGemFan(a.pos, a.vel, a.embeddedGemCount)) game.gems.push(g);
  }
  // Defiant final shot: a boss eye-core that just took its killing hit
  // fires one last plasma bolt before the shards spawn. Skip if no ship to
  // aim at (post-death) — splatting an inert iris on a dead ship would just
  // be visual noise.
  if (a.kind === "bossEye" && game.ship.alive) {
    fireBossEyeFinalShot(game, a);
  }
  const children = a.split({
    impactDir: killerVel,
    impactPos,
    combo: game.beatCombo,
    onBeat: isOnBeatHit,
    awayFrom: game.ship.pos,
    // metalChunk lays two shards on the ship's actual prong-bullet rays (see
    // split). Those rays bend with ship velocity (bullets inherit 0.4·vel), so
    // it needs the live heading, velocity, and bullet speed to place the pair
    // where a prong shot fired right now would truly thread both.
    shipHeading: game.ship.heading,
    shipVel: game.ship.vel,
    bulletSpeed: effectiveBulletSpeed(game.ship),
  });
  // sibling fragments share one beat-claim set so the two pieces target
  //   *different* beats — otherwise the player can only combo one of them
  //   before the second drifts past the engagement ring on the same tick.
  const claimed = newBeatClaimSet();
  for (const c of children) alignSplitChildToRhythm(game, c, claimed);
  if (a.isBass()) restartChildBassDrones(game, children);
  return children;
};

// bassEcho → asteroidHit order matches the original handleCollisions bullet branch.
export const onAsteroidKilledByBullet = (
  game: Game,
  a: Asteroid,
  b: Bullet,
  isOnBeatHit: boolean,
): Asteroid[] => {
  applyHitToCombo(game, isOnBeatHit, b.pos, beatsAwayAtHit(game, b));
  const scoreEarned = awardScoreForKill(game, b.pos, a.scoreValue(), isOnBeatHit, b.driftTierAtHit());
  const comboAtKill = isOnBeatHit ? game.beatCombo : 0;
  if (isOnBeatHit) triggerBassLightning(game, a.pos, a);
  if (a.isBass()) game.sound.play("bassEcho", 1, a.pos);
  // On-beat plain asteroid kills get the taiko boom in place of the noise
  // explosion — replacing rather than layering so the acoustic drum isn't
  // masked by the broadband crash.
  const useTaiko = isOnBeatHit && a.kind === "normal";
  const sound = useTaiko ? "asteroidBoomBeat" : hitSoundFor(a);
  // Solid-crystal shatter: pitch=0 is a sentinel that tunes the long ringing
  // tail to the fireBeat pluck note (G), so an on-beat shot leaves the crystal
  // ringing in key with the rhythm. Off-beat keeps the natural ring pitch.
  const isCrystalShatter = sound === "crystalShatterLarge" || sound === "crystalShatterSmall";
  const pitch = isCrystalShatter && isOnBeatHit ? 0 : 1;
  game.sound.play(sound, pitch, a.pos);
  // Layer the meaty armored-impact on a large shot's killing blow too, so the
  // hit that cleaves the boss lands as heavily as the chips along the way.
  playBossImpactIfLarge(game, a, b);
  return finishAsteroidKillCore(game, a, b.vel, isOnBeatHit, scoreEarned, comboAtKill, b.pos);
};

// asteroidHit → bassEcho (reverse of bullet path) preserves the original ram-branch order.
// ram kills award no points — pass 0 so the parade flash reflects the actual payout.
export const onAsteroidKilledByRam = (game: Game, a: Asteroid, shipVel: Vec): Asteroid[] => {
  if (a.isBass()) game.sound.play("bassHit", 1, a.pos);
  game.sound.play(hitSoundFor(a), 1, a.pos);
  if (a.isBass()) game.sound.play("bassEcho", 1, a.pos);
  return finishAsteroidKillCore(game, a, shipVel, false, 0, 0);
};

// bassteroids take multiple hits to kill; chip points keep the player rewarded for
// every rhythm-good hit along the way, not just the kill shot.
const bassChipScore = (a: Asteroid): number => Math.max(1, Math.round(a.scoreValue() / 4));

// A heavy/large shot — the big on-beat/boosted/pierce rounds (and the charged
// laser, which arrives flagged the same way). These are the hits that should
// land a meaty "bossHit" against the armored planetoid.
const isLargeShot = (b: Bullet): boolean => b.onBeat || b.boosted || b.superBoosted || b.pierce;

// A satisfying armored-impact "CHONK" when a large shot connects with the boss
// family. Plays on both cracks and kills so chipping the 60-HP body feels
// weighty the whole way down, not just on the finishing blow.
const playBossImpactIfLarge = (game: Game, a: Asteroid, b: Bullet) => {
  if (a.isBossFamily() && isLargeShot(b)) game.sound.play("bossHit", 1, a.pos);
};

// a landed hit that earned no kill: no rhythm gain — on-beat keeps
//   the streak window alive, off-beat still breaks the combo.
export const applyNonKillHitToCombo = (game: Game, isOnBeatHit: boolean, hitPos: Vec) => {
  if (isOnBeatHit) extendStreakWindow(game);
  else if (game.beatCombo !== 0) loseCombo(game, hitPos, "hit");
};

// bullet crack — bassHit announces the chip; sparkle layers on if it was on-beat.
// Bassteroid chips also pay small flat points so multi-hit kills
// feel rewarding (no combo multiply — the target survived).
export const onAsteroidCrackedByBullet = (game: Game, a: Asteroid, b: Bullet, isOnBeatHit: boolean) => {
  if (a.isBass()) game.sound.play("bassHit", 1, a.pos);
  // Non-bass chip: play the body's own hit sound at reduced volume so a
  // surviving hit is always audible, even when the shot lands after the beat
  // window has closed (on-beat-fired bullets travel and can connect off-beat).
  else game.sound.play(hitSoundFor(a), 0.55, a.pos);
  playBossImpactIfLarge(game, a, b);
  emitCrackParticles(game.particles, a, isOnBeatHit);
  if (isOnBeatHit) game.sound.play("comboSparkle", 1, b.pos);
  applyNonKillHitToCombo(game, isOnBeatHit, b.pos);
  if (a.isBass()) {
    const points = bassChipScore(a);
    game.score += points;
    flashScoreGain(game, points);
    checkBonusLife(game);
  }
};

// ram crack uses asteroidHit (not bassHit) so the impact reads as a kick, not a chip.
export const onAsteroidCrackedByRam = (game: Game, a: Asteroid) => {
  game.sound.play(a.isBass() ? "bassHit" : hitSoundFor(a), 1, a.pos);
  emitCrackParticles(game.particles, a, false);
};

// no split path here — alien deaths fall into the "single body, fixed sound" pattern.
export const onAlienKilled = (game: Game, al: Alien, b: Bullet, isOnBeatHit: boolean) => {
  applyHitToCombo(game, isOnBeatHit, b.pos, beatsAwayAtHit(game, b));
  const scoreEarned = awardScoreForKill(game, b.pos, al.scoreValue, isOnBeatHit, b.driftTierAtHit());
  const comboAtKill = isOnBeatHit ? game.beatCombo : 0;
  if (isOnBeatHit) triggerBassLightning(game, al.pos);
  game.shake = Math.min(game.shake + 0.5, 1.4);
  game.sound.play("alienExplode", 1, al.pos);
  game.sound.stopAlienDrone(al);
  emitAlienExplosion(game.particles, al);
  // The kill tears open a lingering wave-skip portal — fly into it to end the
  // wave and jump ahead. See game/waveSkip.ts.
  maybeSpawnSkipPortal(game, al);
  const snap = snapshotAlienKill(al, "alienExplode", scoreEarned);
  if (snap) {
    if (isOnBeatHit && comboAtKill >= 1) snap.rhythmHit = { combo: comboAtKill };
    game.killedSnapshots.push(snap);
  }
  bumpKill(game, `alien_${al.size}`);
};

// shared cracked-alien feedback for medium/big saucers since the killing-hit path differs.
export const onAlienCracked = (game: Game, isOnBeatHit: boolean, pos: Vec) => {
  game.sound.play("alienHit", 1, pos);
  game.shake = Math.min(game.shake + 0.18, 1.2);
  if (isOnBeatHit) game.sound.play("comboSparkle", 1, pos);
  applyNonKillHitToCombo(game, isOnBeatHit, pos);
};

// Off-rhythm kills pay a flat 500 — present but unsatisfying. An on-beat kill pays
// 1000 × beatCombo, so the comet rewards rhythm hard (a 6× halo lands 6000+).
// Off-rhythm hits also get a sadder explosion variant so the audio tells the
// player they wasted the celestial visitor.
export const onCometKilled = (game: Game, c: Comet, b: Bullet, isOnBeatHit: boolean) => {
  applyHitToCombo(game, isOnBeatHit, b.pos, beatsAwayAtHit(game, b));
  // Meteors are the cheaper flock: an on-beat hit pays 500 × combo vs the
  // comet's 1000 × combo, but there are many of them. Off-beat pays the same
  // flat amount halved.
  const onBeatBase = c.isMeteor ? ENTITY_CONFIG.meteorShower.baseScore : 1000;
  const offBeat = c.isMeteor ? ENTITY_CONFIG.meteorShower.baseScore / 2 : 500;
  const scoreEarned = isOnBeatHit ? Math.round(onBeatBase * game.beatCombo) : offBeat;
  game.score += scoreEarned;
  flashScoreGain(game, scoreEarned);
  checkBonusLife(game);
  game.popups.push(popupScore(b.pos, scoreEarned));
  if (isOnBeatHit) {
    game.sound.play("comboSparkle", 1, b.pos);
    if (game.beatCombo >= 2) game.popups.push(popupCombo(b.pos, game.beatCombo));
    triggerBassLightning(game, c.pos);
  }
  game.shake = Math.min(game.shake + 0.6, 1.6);
  const deathSound = isOnBeatHit ? "cometDestroyed" : "cometDestroyedSad";
  // No pos: these are big centered "event" sounds — the live graph always
  // played them dead-center at full volume, so the baked buffer must too (a
  // pos would pan + distance-attenuate them via playBaked's spatial splice).
  game.sound.play(deathSound, 1);
  game.sound.stopCometShimmer(c);
  emitCometExplosion(game.particles, c);
  const snap = snapshotCometKill(c, deathSound, scoreEarned);
  if (snap) {
    if (isOnBeatHit && game.beatCombo >= 1) snap.rhythmHit = { combo: game.beatCombo };
    game.killedSnapshots.push(snap);
  }
  bumpKill(game, "comet");
  syncHud(game);
};
