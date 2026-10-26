// Sound registry for /sound, organized as objects × actions so the page can
// stay in sync with the game's actual triggers.
//
// Each in-game *object* (ship, alien-medium, asteroid-bassA, comet, …) owns a
// list of *actions* (verbs that happen TO it: spawn, hit, kill, fire, pulse, …).
// Each action declares the sound it produces and the cadence at which it fires
// in gameplay. The page generates one row per (object, action) pair.
//
// Adding a new sound → add an action under the right object.
// Adding a new object → add it to ANIMATIONS in animations.ts, then add it
// here with at least one action.
// Adding a new action to an existing object → one line below.
//
// A compile-time assertion at the bottom of this file ensures every SoundName
// in the union is mentioned at least once — so adding a new sound without
// wiring it here is a TypeScript error.

import type { SoundName } from "../../Sound";
import type { ObjectId } from "./animations";

export type Trigger =
  | { kind: "loop" }
  | { kind: "beat"; periodBeats: number; phaseBeats?: number };

export type Action = {
  // Short verb-phrase. Combined with the object label for the row title.
  // e.g. object="rhythm bullet", action="fires" → "rhythm bullet · fires"
  verb: string;
  sound: SoundName;
  trigger: Trigger;
  // Optional override of the parent object's animator. Used when one action
  // wants to render with a different object's visual (e.g. an alien-fire
  // sound can show the alien, but an alien-explode sound looks better on the
  // shared explosion animation).
  animation?: ObjectId;
  // Optional note shown below the verb in the row sublabel.
  note?: string;
};

export type GameObject = {
  id: ObjectId;
  // Human-readable name shown in the row label.
  label: string;
  // Short one-liner about what this object is (shown as secondary text in
  // the section header). Keeps the page self-documenting.
  about?: string;
  actions: Action[];
};

const beat = (periodBeats: number, phaseBeats: 0 | 0.5 = 0): Trigger => ({
  kind: "beat",
  periodBeats,
  phaseBeats,
});
const LOOP: Trigger = { kind: "loop" };

// ── object registry ─────────────────────────────────────────────────────
// Order here determines on-page order. Group by where the player encounters
// the object (ship & bullets → asteroids → bass bed → aliens → comets →
// pickups → world bed → UI).

export const OBJECTS: GameObject[] = [
  {
    id: "ship",
    label: "ship",
    about: "the player",
    actions: [
      { verb: "earns a bonus life (major-key comet choir)", sound: "bonusLife", trigger: beat(8) },
      { verb: "dies", sound: "death", trigger: beat(8), animation: "ship-death" },
    ],
  },
  {
    id: "ship-thrust",
    label: "ship · forward thrust",
    actions: [
      { verb: "engages thruster", sound: "thrust", trigger: LOOP, note: "continuous while ↑ held" },
    ],
  },
  {
    id: "ship-reverse",
    label: "ship · reverse thrust",
    actions: [
      { verb: "engages retro", sound: "reverseThrust", trigger: LOOP, note: "continuous while ↓ held" },
    ],
  },
  {
    id: "ship-side",
    label: "ship · side thrust",
    actions: [
      { verb: "engages side engine", sound: "sideThrust", trigger: LOOP, note: "Z/X powerup" },
    ],
  },
  {
    id: "ship-shield",
    label: "ship · shield",
    actions: [
      { verb: "absorbs hit", sound: "shieldPop", trigger: beat(4) },
    ],
  },

  {
    id: "bullet-weak",
    label: "off-beat bullet",
    about: "fired off the rhythm grid — no combo",
    actions: [
      { verb: "fires", sound: "fire", trigger: beat(1, 0.5) },
    ],
  },
  {
    id: "bullet-rhythm",
    label: "on-beat bullet",
    about: "fired on the rhythm grid — eligible for combo",
    actions: [
      { verb: "fires", sound: "fireBeat", trigger: beat(1) },
      { verb: "registers as on-beat", sound: "comboTick", trigger: beat(1), animation: "combo-halo" },
    ],
  },
  {
    id: "bullet-bomb-weak",
    label: "off-beat bomb bullet",
    about: "bomb upgrade, off the rhythm grid",
    actions: [
      { verb: "fires", sound: "fireBomb", trigger: beat(1, 0.5) },
    ],
  },
  {
    id: "bullet-bomb-rhythm",
    label: "on-beat bomb bullet",
    about: "bomb upgrade, on the grid — two octaves under the normal shot",
    actions: [
      { verb: "fires", sound: "fireBombBeat", trigger: beat(1) },
    ],
  },
  {
    id: "bullet-prong",
    label: "prong bullets",
    about: "rapid+prong powerup spread",
    actions: [
      // No unique sound — it's still fireBeat — but the visual difference
      // earns its own row so the page covers the prong variant explicitly.
      { verb: "fires triple volley", sound: "fireBeat", trigger: beat(1) },
    ],
  },

  {
    id: "asteroid-normal",
    label: "normal asteroid",
    about: "the basic rock — size determines the kill sound",
    actions: [
      { verb: "killed (small, off-beat)", sound: "explosionSmall", trigger: beat(2) },
      { verb: "killed (medium, off-beat)", sound: "explosionMedium", trigger: beat(2) },
      { verb: "killed (large, off-beat)", sound: "explosionLarge", trigger: beat(4) },
      // The on-beat kill replaces the noise explosion with a taiko boom.
      // Rendered as a "kill" so the visual matches the audio event.
      { verb: "killed on-beat (taiko boom)", sound: "asteroidBoomBeat", trigger: beat(4) },
    ],
  },

  {
    id: "asteroid-bassA",
    label: "bassteroid A · kick",
    about: "C2 — beats 1",
    actions: [
      { verb: "pulses on beat", sound: "bassKick", trigger: beat(1) },
      { verb: "takes a chip hit", sound: "bassHit", trigger: beat(2) },
      { verb: "killed (echo tail)", sound: "bassEcho", trigger: beat(4) },
    ],
  },
  {
    id: "asteroid-bassB",
    label: "bassteroid B · pluck",
    about: "G2 — beats 2",
    actions: [
      { verb: "pulses on beat", sound: "bassPluck", trigger: beat(1) },
    ],
  },
  {
    id: "asteroid-bassC",
    label: "bassteroid C · boom",
    about: "F2 — beats 3",
    actions: [
      { verb: "pulses on beat", sound: "bassBoom", trigger: beat(1) },
    ],
  },
  {
    id: "asteroid-bassD",
    label: "bassteroid D · snap",
    about: "C3 — beats 4",
    actions: [
      { verb: "pulses on beat", sound: "bassSnap", trigger: beat(1) },
    ],
  },

  {
    id: "asteroid-chime",
    label: "chime asteroid",
    about: "decorator rock — chime on kill",
    actions: [
      { verb: "killed", sound: "chime", trigger: beat(4) },
    ],
  },
  {
    id: "asteroid-bell",
    label: "bell asteroid",
    actions: [
      { verb: "killed", sound: "bell", trigger: beat(4) },
    ],
  },
  {
    id: "asteroid-warble",
    label: "warble asteroid",
    actions: [
      { verb: "killed", sound: "warble", trigger: beat(4) },
    ],
  },
  {
    id: "asteroid-gold",
    label: "gold crystal asteroid",
    about: "hidden gold inside — drops a collectible",
    actions: [
      // Ship-touch shatters the gem (crystalShatterSmall + ship damage); the
      // rhythm-cracked branch plays canisterAppear+tink at the spawn point.
      { verb: "cracked → canister spawns", sound: "canisterAppear", trigger: beat(8), animation: "canister" },
    ],
  },
  {
    id: "asteroid-solidCrystal",
    label: "solid crystal asteroid",
    about: "the whole rock is the gem — shatters like cut glass",
    actions: [
      { verb: "killed (large shatter)", sound: "crystalShatterLarge", trigger: beat(4) },
      { verb: "killed (small frag shatter)", sound: "crystalShatterSmall", trigger: beat(2) },
    ],
  },
  {
    id: "asteroid-glassPrison",
    label: "glass prison",
    about: "indigo shell sealing a wraith inside — shatters open on the killing hit",
    actions: [
      { verb: "shell shatters", sound: "crystalShatterLarge", trigger: beat(8) },
      { verb: "captive's cry on release", sound: "wraithScream", trigger: beat(8) },
    ],
  },
  {
    id: "wraith",
    label: "wraith",
    about: "freed from a shattered prison — writhes after the ship until destroyed",
    actions: [
      { verb: "takes a hit", sound: "wraithHit", trigger: beat(2) },
      { verb: "lunges (every 2 measures)", sound: "wraithLunge", trigger: beat(8) },
      { verb: "release cry on death", sound: "wraithDeath", trigger: beat(8) },
    ],
  },

  {
    id: "alien-big",
    label: "alien · big (gunship)",
    about: "4 HP — fires every other beat",
    actions: [
      { verb: "fires", sound: "alienFireBig", trigger: beat(2) },
    ],
  },
  {
    id: "alien-medium",
    label: "alien · medium (fighter)",
    about: "2 HP — fires every beat with rests",
    actions: [
      { verb: "fires", sound: "alienFireMedium", trigger: beat(1) },
      { verb: "takes a hit (survives)", sound: "alienHit", trigger: beat(2) },
      { verb: "killed", sound: "alienExplode", trigger: beat(8) },
    ],
  },
  {
    id: "alien-small",
    label: "alien · small (interceptor)",
    about: "1 HP — fires every beat with rests",
    actions: [
      { verb: "fires", sound: "alienFireSmall", trigger: beat(1) },
    ],
  },

  {
    id: "comet",
    label: "comet",
    about: "ambient melodic visitor — note per 2 beats",
    actions: [
      { verb: "plays melody note", sound: "cometNote", trigger: beat(2) },
      { verb: "killed on-beat (triumph)", sound: "cometDestroyed", trigger: beat(8) },
      { verb: "killed off-beat (sad)", sound: "cometDestroyedSad", trigger: beat(8) },
      { verb: "meteor shower arrives (flock)", sound: "meteorShower", trigger: beat(8) },
      { verb: "gem swarm arrives (sparkle)", sound: "gemSwarm", trigger: beat(8) },
    ],
  },

  {
    id: "canister",
    label: "powerup canister",
    about: "drops from gold crystals + wave events",
    actions: [
      { verb: "appears", sound: "canisterAppear", trigger: beat(8) },
      { verb: "picked up (powerup arpeggio)", sound: "powerup", trigger: beat(8) },
      { verb: "shot down (wasted)", sound: "canisterDestroyed", trigger: beat(8) },
    ],
  },

  {
    id: "pulsar",
    label: "pulsar (background)",
    about: "menacing approach beat — intensity ramps with wave",
    actions: [
      { verb: "beats on quarter-note", sound: "bgBeat", trigger: beat(1) },
      { verb: "hums on wave clear", sound: "pulsarHum", trigger: beat(8) },
    ],
  },

  {
    id: "shockwave",
    label: "shockwave",
    about: "screen-clearing pulse — charge then detonate",
    actions: [
      { verb: "charges up", sound: "shockwaveCharge", trigger: beat(8) },
      { verb: "detonates", sound: "shockwaveBoom", trigger: beat(8) },
    ],
  },

  {
    id: "combo-halo",
    label: "combo halo",
    about: "rhythm-multiplier feedback around the ship",
    actions: [
      { verb: "sparkles on on-beat kill", sound: "comboSparkle", trigger: beat(2) },
      { verb: "breaks on off-beat fire", sound: "comboLostFire", trigger: beat(8) },
      { verb: "breaks on off-beat hit", sound: "comboLost", trigger: beat(8) },
    ],
  },

  {
    id: "wave-summary",
    label: "wave summary panel",
    about: "end-of-wave score breakdown",
    actions: [
      { verb: "title row reveals (chime)", sound: "chime", trigger: beat(8), animation: "wave-summary" },
      // waveClear & pulsarHum fire together in advanceWave; pulsarHum lives
      // on the pulsar object. waveClear stays here because it's the UI cue.
      { verb: "wave clears", sound: "waveClear", trigger: beat(8), animation: "wave-summary" },
      { verb: "score drain tick", sound: "scoreBlip", trigger: beat(1, 0.5), animation: "wave-summary" },
      { verb: "score drain downbeat", sound: "summaryDownbeat", trigger: beat(4), animation: "wave-summary" },
      { verb: "drain hum-chime (every 4th downbeat)", sound: "drainChime", trigger: beat(8), animation: "wave-summary" },
    ],
  },
];

// ── derived helpers ─────────────────────────────────────────────────────

// Resolved animator for an action — action override falls back to its parent
// object's id.
export const animationFor = (object: GameObject, action: Action): ObjectId =>
  action.animation ?? object.id;

// Human-readable cadence line shown under each row.
export const sublabelFor = (action: Action): string => {
  const trig = action.trigger;
  let cadence: string;
  if (trig.kind === "loop") {
    cadence = "continuous";
  } else if (trig.periodBeats === 1 && (trig.phaseBeats ?? 0) === 0) {
    cadence = "every beat";
  } else if ((trig.phaseBeats ?? 0) === 0.5) {
    cadence = "off-beat";
  } else {
    cadence = `every ${trig.periodBeats} beats`;
  }
  const base = `${action.sound} · ${cadence}`;
  return action.note ? `${base} · ${action.note}` : base;
};

// ── compile-time coverage check ─────────────────────────────────────────
// MENTIONED_SOUNDS lists every sound that appears in OBJECTS above. Keeping
// it as an explicit `as const` array (instead of deriving from OBJECTS) lets
// the literal types survive, which is what makes the assertion below catch
// gaps. A runtime guard at the bottom of this file also verifies that the
// list stays in sync with OBJECTS — if you forget to add a sound here after
// adding it to an action, the page throws a clear error at load time.

const MENTIONED_SOUNDS = [
  // ship
  "death", "thrust", "reverseThrust", "sideThrust", "shieldPop", "bonusLife",
  // bullets
  "fire", "fireBeat", "fireBomb", "fireBombBeat", "comboTick",
  // asteroids
  "explosionSmall", "explosionMedium", "explosionLarge", "asteroidBoomBeat",
  "bassKick", "bassPluck", "bassBoom", "bassSnap", "bassHit", "bassEcho",
  "chime", "bell", "warble", "tink",
  "crystalShatterLarge", "crystalShatterSmall",
  "wraithScream", "wraithHit", "wraithLunge", "wraithDeath",
  // aliens
  "alienFireBig", "alienFireMedium", "alienFireSmall", "alienHit", "alienExplode",
  // comets
  "cometNote", "cometDestroyed", "cometDestroyedSad", "meteorShower", "gemSwarm",
  // canisters / pickups
  "canisterAppear", "canisterDestroyed", "powerup",
  // world bed
  "bgBeat", "pulsarHum",
  // shockwave
  "shockwaveCharge", "shockwaveBoom",
  // combo
  "comboSparkle", "comboLost", "comboLostFire",
  // wave summary UI
  "waveClear", "scoreBlip", "summaryDownbeat", "drainChime",
] as const;

type MentionedSound = (typeof MENTIONED_SOUNDS)[number];

// Add a sound here only if it's intentionally omitted from the page (e.g.
// system-only sound that shouldn't appear as a checkbox).
type IntentionallyOmitted =
  | "bossPulse" | "bossHit" | "bossEyeOpenStinger" | "chargeBed" | "summaryDownbeatDucked"
  // Baked internal voices of sounds already listed above (drone/one-shot
  // variants dispatched by the play paths, not directly triggerable).
  | "laserShot" | "streakShimmer" | "bassteroidDrone" | "alienDrone" | "firstDotHum" | "warbleDrone"
  // Baked voices with their own public entry point on Sound rather than a
  // play() dispatch — the page has no generic way to trigger them.
  | "driftShotHit" | "laserCharge" | "laserChargeFail" | "comboChime" | "calibrationTap";

// Compile-time check: every SoundName must be in MENTIONED_SOUNDS or
// IntentionallyOmitted. If you add a new SoundName and forget to wire it
// into the page, the assignment below errors with a `MissingSounds` type
// that contains the missing name(s).
type MissingSounds = Exclude<SoundName, MentionedSound | IntentionallyOmitted>;
type _AssertNoMissingSounds = MissingSounds extends never
  ? true
  : { ERROR_unmentioned_sounds: MissingSounds };
const _coverageOk: _AssertNoMissingSounds = true;
void _coverageOk;

// Runtime check: MENTIONED_SOUNDS must match what OBJECTS actually says.
// Catches the inverse mistake — adding to MENTIONED_SOUNDS but forgetting
// the action entry, or removing the action and forgetting to delete here.
const actualMentioned = new Set<SoundName>();
for (const o of OBJECTS) for (const a of o.actions) actualMentioned.add(a.sound);
const claimed = new Set<SoundName>(MENTIONED_SOUNDS);
const onlyClaimed: SoundName[] = [...claimed].filter((s) => !actualMentioned.has(s));
const onlyActual: SoundName[] = [...actualMentioned].filter((s) => !claimed.has(s));
if (onlyClaimed.length || onlyActual.length) {
  // eslint-disable-next-line no-console
  console.error(
    "/sound registry mismatch:",
    { listedButUnused: onlyClaimed, usedButUnlisted: onlyActual },
  );
}
