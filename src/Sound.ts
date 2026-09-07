// Tone is dev-only — loaded dynamically by loadTone() so the prod bundle
// doesn't ship the ~150KB library. `import type` keeps the Tone.X type
// annotations on the engine struct without dragging the runtime in.
import type * as Tone from "tone";
import { toroidalDelta } from "./vec";
import { cfgN, cfgU } from "./soundConfig";
import { getChannelVolume, type AudioChannel } from "./game/audioPrefs";
import { musicGain, loadMusicConfig, type MusicLayer } from "./musicConfig";
import { FULL_HALO_TIER_THRESHOLDS, FULL_HALO_SONGS, type FullHaloSong } from "./game/haloFullMusicConfig";
import { fullHaloLayerOffset, loadHaloFullConfig } from "./haloFullConfig";
import { cosmeticRng } from "./game/rng";
import { HALO_MUSIC_POOL, HAUNTING_MUSIC_POOL, BOSS_MUSIC_VARIATION } from "./game/haloMusicConfig";
import { SOUND_LOAD_SCHEDULE, STREAK_SHIMMER_POOL_SIZE, FIRST_DOT_HUM_POOL_SIZE } from "./game/soundSchedule";

type ToneModule = typeof import("tone");
let toneModulePromise: Promise<ToneModule> | null = null;
async function loadTone(): Promise<ToneModule> {
  if (!toneModulePromise) toneModulePromise = import("tone");
  return toneModulePromise;
}

// Master bus. Every voice feeds one of two summing legs (see buildMixGraph):
// Sound.master → liveSum → compressor takes hand-built graphs AND the baked
// mp3s of those same graphs, which hold a bare voice and need the same
// dynamics live synthesis got; Sound.bakedOut → bakedSum → glue compressor
// takes only the files that already carry dynamics of their own (see
// PREMASTERED_BAKES). Both legs join a shared limiter, then a soft-clip
// safety, then the analyser + destination.
// Per-alien drone voice. Two detuned sines through a slow-sweeping lowpass,
// modulated by an LFO on amplitude for the theremin pulse. Held open for the
// lifetime of an alien; torn down on death or mute. The tonal content
// (oscillators, vibrato/pulse LFOs, filter) is a baked seamless loop per
// size (buildAlienDroneGraph); only the fade envelope and spatial pan stay
// live around the looping buffer source.
type AlienDroneNode = {
  src: AudioBufferSourceNode;
  mainGain: GainNode;
  spatial?: SpatialNodes;
};

// Per-warble continuous voice. A soft sustained hum while the rock is phased
// in (solid), morphing toward a deeper, wider, faster vibrato — "warblier" —
// as it phases out (intangible). The two endpoint states (phased-in,
// phased-out) are baked seamless loops (buildWarbleDroneGraph);
// setWarbleDronePhase rides the morph each frame from the rock's ghost
// amount by crossfading the two loops' gains — sources[0]/phaseGains[0] is
// the phased-in loop, sources[1]/phaseGains[1] the phased-out loop. Held for
// the lifetime of the piece.
type WarbleDroneNode = {
  sources: AudioBufferSourceNode[];
  phaseGains: GainNode[];
  mainGain: GainNode;
  spatial?: SpatialNodes;
};

// Soft "mmmm" hum that sustains while the reticule hovers a first-beat dot.
// Pitched at C4 — a perfect fifth below the fireBeat pluck (G4) and one
// octave above the fireBeat body (C3), so when the player executes the
// on-beat shot the hum becomes the bottom voice of a C-major chord with
// fireBeat's G4 pluck landing as the bright top. The bandpass + two
// detuned sines give it a vowel-like "mm" character instead of a sterile
// sine. A single voice held across hover frames; gain rides a target set
// by the caller each frame (0 = silent, 1 = max audible-but-soft).
// pulseGain pumps amplitude on the beat (peak at beat onset, decays across the beat); mainGain
// rides the slow hover-swell. Output = mainGain × pulseGain so the two envelopes compose cleanly.
// lastScheduledBeatAudioTime tracks the most recent beat-onset audio-clock time we've already
// scheduled an envelope for, so each beat onset only gets one pulse even though the caller fires
// updateFirstDotHum every frame.
// releaseCleanupTimer holds a setTimeout id that tears down the buffer source after the two-stage
// release tail finishes — kept on the node so re-hovering mid-release can cancel it and resume.
// The two detuned sines + vibrato LFO (the raw drone tone) are baked into `src`, a looping
// AudioBufferSourceNode — see buildFirstDotHumGraph. filter/pulseGain/mainGain stay live: the
// filter's frequency and pulseGain are automated per-beat by scheduleHumBeatPulse (the beat grid
// isn't known at bake time), and mainGain is ramped per-frame to the caller's intensity/attack.
type FirstDotHumNode = {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  pulseGain: GainNode;
  mainGain: GainNode;
  lastScheduledBeatAudioTime: number;
  releasing: boolean;
  releaseCleanupTimer: ReturnType<typeof setTimeout> | null;
};

// Per-bassteroid ambient drone. Opened when a large bassteroid breaks open
// into mediums (and again when mediums break into smalls), held for the
// lifetime of that piece. Each (kind, size) pairs to one of 8 voices in a
// C-major bed — see startBassteroidDrone for the assignment. The tonal
// content (oscillators, noise, pulse/vibrato LFOs) is a baked seamless loop
// (buildBassteroidDroneGraph); only the fade envelope and spatial pan stay
// live around the looping buffer source.
type BassDroneNode = {
  src: AudioBufferSourceNode;
  mainGain: GainNode;
  spatial?: SpatialNodes;
};

// Streak-shimmer: a fast music-box arpeggio that fades in as a rhythm streak
// grows. Real PITCHED notes (no noise — noise rattled in earlier versions),
// drawn from a Cmaj9 arpeggio so it stays melodic and consonant with every
// C-rooted halo chord. A lookahead scheduler fires one tiny pluck every 16th
// note at first, tightening to 32nds once the streak is long, so it reads as a
// shimmer texture rather than a drum. Each note is a pre-baked music-box tine
// whose baked tail OVERLAPS its neighbours — that overlap is the "sustain", so
// nothing sits static (no drone). The series is a rising arpeggio cycle (the
// same short figure over and over, never a full tune) so it can fade in and
// out without a recognisable melody being cut off. Level fades with streak.
type StreakShimmerNode = {
  out: GainNode; // overall level — eased toward STREAK_SHIMMER_PEAK_GAIN * intensity
  intensity: number; // latest streak intensity (0..1); the scheduler reads this
  nextNoteTime: number; // audio-clock time of the next 16th/32nd pluck to fire
  walkIndex: number; // current position in the arpeggio pool (rising cycle)
  timer: ReturnType<typeof setInterval> | null; // JS-side lookahead pump
  releasing: boolean;
  releaseCleanupTimer: ReturnType<typeof setTimeout> | null;
};

// Which sound a rhythm streak plays. Every streak now uses "updraft"; the
// "tines" path is kept in the union (and its code below) but never selected:
//   "tines"   — the generative music-box arpeggio above (per-note baked
//               buffers driven by a real-time scheduler; no stems anywhere)
//   "updraft" — a pair of pre-rendered ElevenLabs 16s loop stems (glassy
//               breathing pad + ever-climbing 16th-note crystal arpeggio)
//               whose rise layer blooms in as the streak escalates
type StreakSoundSet = "tines" | "updraft";

// Streak-updraft: the looping-stem streak sound. Both sources start together
// (phase-locked, downbeat at sample 0) on a beat boundary and loop for the
// streak's life; escalation is pure gain motion — the base pad follows the
// streak level while the rise arpeggio only enters past the same threshold
// where the tines tighten to 32nds, swelling to full on a long streak.
type StreakLoopNode = {
  out: GainNode; // overall level into master
  baseGain: GainNode; // breathing-pad layer — tracks streak intensity
  riseGain: GainNode; // climbing-arpeggio layer — the escalation reward
  srcs: AudioBufferSourceNode[];
  releasing: boolean;
  releaseCleanupTimer: ReturnType<typeof setTimeout> | null;
};

// Per-comet shimmer pad. Underlies the comet melody for the entire lifetime
// of one comet — a soft chord wash that thickens whenever a comet is on
// screen. Set up once at spawn, torn down on despawn.
type CometShimmerNode = {
  oscs: OscillatorNode[];
  lfos: OscillatorNode[];
  mainGain: GainNode;
  spatial?: SpatialNodes;
};

// Ambient pad that holds for the duration of a yellow-halo combo (≥4) and
// thickens further at white-bullet tier (≥12). Voices C2/C3/G3 are common to
// both the bassteroid C-major bed and the comet's C-rooted phrygian cluster,
// so they layer pleasantly with both. The "third voice" frequency glides
// between E4 (major third, bright with bass field) and Eb4 (minor third,
// neutral with the comet's b2/tritone dissonance) — controlled by
// setHaloAmbientCometMode. On top sits a slow, looping melody voice playing
// a "determined" 8-step motif drawn entirely from mode-invariant pitches
// (C, D, F, G), so the figure stays musical regardless of the wave's mode
// without fighting the comet's b2/tritone cluster.
type HaloAmbientNode = {
  oscs: OscillatorNode[];
  lfos: OscillatorNode[];
  mainGain: GainNode;
  thirdOsc: OscillatorNode;
  // tier1 (yellow halo only): C+G open fifth foundation + E/Eb third voice.
  // tier2 (white bullets): extra octave-up voice swells in for a brighter top.
  tier2Gain: GainNode;
  // Slow melodic voice — a single oscillator whose frequency + gain envelope
  // are re-scheduled once per step by a JS-side interval. Interval handle is
  // stored so stopHaloAmbient can clear it.
  melodyOsc: OscillatorNode;
  melodyGain: GainNode;
  melodyInterval: ReturnType<typeof setInterval> | null;
};

// Pre-rendered music variations for the 4x/6x combo halo. Each variation has
// two looping stems — ambient (4x trigger) and melodic (6x trigger) — that
// share key, tempo (120 BPM), and 8-second loop length so they mix cleanly.
// The user picks one at HALO_MUSIC_VARIATION; "none" falls back to the legacy
// synthesized startHaloAmbient pad.
export type HaloMusicVariation =
  | "cinematic-el"   // ElevenLabs 32-second C-pedal cinematic bed + sustained-tone piano
  | "musicbox-sb"   // Self-built 32-second C-pedal procedural pad + held-tone felt piano
  | "synthwave-el"   // ElevenLabs 32-second C-pedal analog-synthwave: Juno-style pad + soft lead + layer 3
  | "spectral-toll-sb"      // Haunting post-boss (waves 12–20). Deep C/G drone (ambient, EL) / mournful solo cello (melodic, EL) / sparse inharmonic glass bells with ping-pong echo (layer 3, procedural).
  | "vaporwave-el"   // ElevenLabs 32-second C-pedal dawn/vaporwave — glassy string-choir pad + sparse felt-bell sustains + bright crystal-glockenspiel arpeggio
  | "outerwilds-el"  // ElevenLabs 32-second Outer-Wilds folk — distant drone pad + fingerpicked G-rooted acoustic guitar + sparse plucked D-centered acoustic-guitar countermelody (layer 3)
  | "vigil-sb"       // Level-10 boss track, built as the CLIMAX of the levels 1–9 halo music (same felt-piano + sine-pad + glassy-chime palette, turned climactic-and-scary via tension inside the warmth). C-minor pad + accelerating C2 heartbeat (ambient) / insistent rising felt-piano minor-pentatonic arpeggio that densifies per phrase (melodic) / glassy celesta countermelody on tense scale tones + felt-piano low-octave toll (layer 3). The B phrase swaps the halo pool's hopeful Cmaj7 lift for a Db(♭9)+F# tritone shadow — the scare. Force-picked when isBossWave(wave).
  | "knell-sb"       // Funeral death-knell boss track, earmarked for the level-20 boss — C-minor pad + lub-dub heartbeat (ambient) / driving staccato string ostinato + tremolo swells (melodic) / ghost choir on a Dies-irae-shaded motif + tolling tubular bell (layer 3). Auditionable on /music.
  | "cathedral-hymn-el"     // Haunting post-boss (waves 12–20). Stone-cathedral bowed string pad / distant felt-piano line / low monastic male chant (layer 3).
  | "lost-transmission-el"  // Haunting post-boss (waves 12–20). AM-radio analog pad / frail musical-saw lead / whispered breaths with faint radio crackle (layer 3).
  | "underwater-requiem-el" // Haunting post-boss (waves 12–20). Submerged orchestral pad / glass-harmonica lead / ghostly upper-register celesta countermelody (layer 3).
  | "none";          // Legacy synthesized pad (the original startHaloAmbient)

type HaloMusicNode = {
  // Three looping AudioBufferSourceNodes — ambient runs whenever music is
  // active; melodic + layer3 run continuously but their gains are ducked to
  // 0 until their respective tiers are requested (melodic at combo ≥ 6,
  // layer3 at combo ≥ 12). Starting a layer only when its tier first hits
  // would risk a phase-misalignment with the ambient loop, so we keep all
  // three always-playing-but-silent for sample-accurate phase lock.
  ambientSrc: AudioBufferSourceNode;
  melodicSrc: AudioBufferSourceNode;
  // Layer-3 stem may be missing (file deleted / never generated for this
  // variation); ambient + melodic still play normally in that case.
  layer3Src: AudioBufferSourceNode | null;
  ambientGain: GainNode;
  melodicGain: GainNode;
  layer3Gain: GainNode | null;
  mainGain: GainNode;
  // Variation that's currently loaded — preserved so a 6x→4x→6x tier flick
  // doesn't trigger a reload.
  variation: HaloMusicVariation;
  // Whether the melodic layer is currently ducked-up (combo ≥ 6) or down.
  melodicActive: boolean;
  // Whether layer 3 is currently ducked-up (combo ≥ 12) or down.
  layer3Active: boolean;
  // True once the 24x climax crossfade has fired for this halo. Sticks until
  // the halo tears down (combo break) so the swap doesn't re-trigger every
  // tick combo stays ≥ 24, and so dropping back below 24 (but still ≥ 4)
  // doesn't bounce back to the old variation.
  climaxActive: boolean;
  // ctx.currentTime at which the buffer sources were scheduled to start.
  startedAtAudioTime: number;
  // game.beatTime that corresponds to startedAtAudioTime.
  startedAtBeatTime: number;
  // Last commanded playbackRate (1.0 normally, < 1 during slow-mo).
  currentPlaybackRate: number;
};

// Full-length halo song — the parallel "different system" to HaloMusicNode.
// Six phase-locked, NON-looping layer sources fade in at the combo thresholds
// in FULL_HALO_TIER_THRESHOLDS (4x/6x/12x/18x/24x/32x). Unlike the loop node
// every source is the whole ~2:10 track; a tier change is just a gain ramp.
// When the track ends, onTrackEnd fires so the caller can switch songs.
// Song id type is owned by haloFullMusicConfig.ts (re-exported for callers
// that only import from Sound).
export type FullHaloSongId = FullHaloSong;

type HaloFullMusicNode = {
  // l1..l6 buffer sources, one per combo tier. All start at the same audio
  // time and run un-looped for the track's length, so switching a tier is a
  // gain ramp on the matching layerGain — never a fresh .start() (which would
  // desync the layers).
  layerSrcs: AudioBufferSourceNode[];
  layerGains: GainNode[];
  // Per-layer mute gains, downstream of layerGains. The tier logic owns
  // layerGains; the /music editor's solo/mute owns these — they multiply, so a
  // tier ramp never fights a mute. 1.0 in-game (untouched), 0/1 in the editor.
  muteGains: GainNode[];
  mainGain: GainNode;
  song: FullHaloSongId;
  // Highest tier index currently faded up (so a flick down-and-up doesn't
  // re-ramp layers already at their target). -1 = nothing audible yet.
  activeTier: number;
  // ctx.currentTime / game.beatTime at which the sources were scheduled.
  startedAtAudioTime: number;
  startedAtBeatTime: number;
  // Last commanded playbackRate (1.0 normally, < 1 during slow-mo).
  currentPlaybackRate: number;
  // Fired once when the track reaches its natural end (the l1 source's
  // onended). Cleared on teardown so a stop()-triggered onended is a no-op.
  onTrackEnd: (() => void) | null;
  // Wrapped beat-sync offset (seconds) of layer 0 — the playhead reference.
  offset: number;
  // Wrapped per-layer offsets (l1..l6) the sources were started at. Equal to
  // `offset` for every layer unless a stem was nudged independently (cmd-drag).
  layerOffsets: number[];
  // True only for the /music Beat Sync editor: sources loop so the editor can
  // cycle and re-offset live. The game leaves this false (non-looping).
  loopForTuning: boolean;
};

// Optional pan + distance-falloff splice. When a sound (one-shot or drone)
// is positional, its voices feed into spatial.in; spatial.out connects to the
// usual master/bakedOut sink. The Game updates pan/gain values per frame for
// drones via setSpatial.
type SpatialNodes = {
  panner: StereoPannerNode;
  distGain: GainNode;
};

export type Pos = { x: number; y: number };

export type SoundName =
  | "fire"
  | "fireBeat"
  | "fireBomb"
  | "fireBombBeat"
  | "explosionLarge"
  | "explosionMedium"
  | "explosionSmall"
  | "asteroidBoomBeat"
  | "thrust"
  | "reverseThrust"
  | "sideThrust"
  | "death"
  | "waveClear"
  | "bassKick"
  | "bassPluck"
  | "bassBoom"
  | "bassSnap"
  | "bassHit"
  | "bassEcho"
  | "chime"
  | "bell"
  | "warble"
  | "comboTick"
  | "comboSparkle"
  | "tink"
  | "crystalShatterLarge"
  | "crystalShatterSmall"
  | "scoreBlip"
  | "summaryDownbeat"
  | "summaryDownbeatDucked"
  | "drainChime"
  | "powerup"
  | "bonusLife"
  | "shieldPop"
  | "pulsarHum"
  | "bgBeat"
  | "shockwaveCharge"
  | "shockwaveBoom"
  | "alienFireBig"
  | "alienFireMedium"
  | "alienFireSmall"
  | "alienHit"
  | "alienExplode"
  | "cometNote"
  | "cometDestroyed"
  | "cometDestroyedSad"
  | "meteorShower"
  | "gemSwarm"
  | "canisterAppear"
  | "canisterDestroyed"
  | "comboLost"
  | "comboLostFire"
  | "wraithScream"
  | "wraithHit"
  | "wraithLunge"
  | "wraithDeath"
  | "bossPulse"
  | "bossHit"
  | "bossEyeOpenStinger"
  // Hold-to-charge laser bed. One committed loop per tier (0..4), keyed by
  // pitchRatio = tier. Built by buildChargeBedGraph, not the Tone path.
  | "chargeBed"
  // Laser-shot thunderclap. One committed one-shot per charge tier (0..4),
  // keyed by pitchRatio = tier. Built by buildLaserShotGraph, not the Tone path.
  | "laserShot"
  // Streak-shimmer music-box tine. One committed one-shot per pool pitch
  // index (0..STREAK_SHIMMER_POOL.length-1), keyed by pitchRatio = index.
  // Built by buildStreakShimmerNoteGraph, not the Tone path.
  | "streakShimmer"
  // Bassteroid ambient drone. One committed seamless loop per (kind, size)
  // pair (4 kinds x 2 sizes = 8), keyed by pitchRatio = kindIndex*2+sizeIndex.
  // Built by buildBassteroidDroneGraph, not the Tone path.
  | "bassteroidDrone"
  // Alien theremin drone. One committed seamless loop per size (0=big,
  // 1=medium, 2=small), keyed by pitchRatio = size index. Built by
  // buildAlienDroneGraph, not the Tone path.
  | "alienDrone"
  // First-dot hum drone TONE only (two detuned sines + vibrato LFO). One
  // committed seamless loop per hum instance (0..8, see FIRST_DOT_HUM_PITCH),
  // keyed by pitchRatio = hum index. Built by buildFirstDotHumGraph, not the
  // Tone path. The bandpass filter / pulseGain (beat accent) / mainGain
  // (hover swell) stay live downstream of the loop — see createHumVoice.
  | "firstDotHum"
  // Warble continuous drone. Two committed seamless loops — the phased-in
  // endpoint (pitchRatio=0) and phased-out endpoint (pitchRatio=1) — built by
  // buildWarbleDroneGraph, not the Tone path. setWarbleDronePhase crossfades
  // live between the two loops each frame as the rock's ghost01 rides the
  // continuous morph in between; only the crossfade gains and mainGain stay
  // live, the oscillator/vibrato/filter synthesis is baked into each endpoint.
  | "warbleDrone"
  // Voices that aren't dispatched through play() — they have their own public
  // entry points — but are baked one-shots all the same. The key each one
  // uses: driftShotHit = drift tier (1..6), laserCharge = charge dot (1..4),
  // comboChime = the note's fundamental in Hz (see COMBO_CHIME_PITCHES),
  // laserChargeFail / calibrationTap = unused (always 1).
  | "driftShotHit"
  | "laserCharge"
  | "laserChargeFail"
  | "comboChime"
  | "calibrationTap";

// The three explosion voices share one graph and differ only by the config
// block they read, so the builder takes the name rather than three numbers.
export type ExplosionName = "explosionLarge" | "explosionMedium" | "explosionSmall";
  // Note: "thrust" / "reverseThrust" / "sideThrust" are declared above (with
  // the rest of the play() switch names) but are ALSO baked one-shots now —
  // each is one committed seamless loop, pitchRatio unused (always 1). Built
  // by buildThrustGraph / buildReverseThrustGraph / buildSideThrustGraph,
  // not the Tone path.

// Combo-milestone vocal pools. Each milestone (x6, x12) has its own folder
// under /sounds/vocals/in-use/. When the player hits the milestone, one file
// is picked at random from that folder. Adding a new take = drop the mp3 in
// the folder and add its filename here. Picking randomly per fire keeps the
// captain's voice from feeling canned across replays.
const PILOT_LOG_POOLS: Readonly<Record<number, readonly string[]>> = {
  6: ["ralf-deep.mp3"],
  12: ["lullaby.mp3"],
};

// Resolve the URLs for a given combo milestone. Everything lives under
// /sounds/vocals/in-use/<milestone>x/ — that folder is the canonical source
// of truth for what plays in-game. Audition material stays elsewhere.
const pilotLogUrlsForIndex = (milestone: number): string[] => {
  const pool = PILOT_LOG_POOLS[milestone] ?? [];
  return pool.map((f) => `/sounds/vocals/in-use/${milestone}x/${f}`);
};

// One queued asset load. `wave` is the earliest wave it can be heard on and
// `order` its position in the schedule — together they decide what loads next.
type AssetJob = {
  id: string;
  wave: number;
  order: number;
  started: boolean;
  /**
   * Set once the job starts. Awaiting a started job has to await THIS, not a
   * fresh resolved promise — the export prewarm drains the whole queue and
   * would otherwise skip right over everything the pacer had in flight.
   */
  inFlight: Promise<unknown> | null;
  /** `immediate` skips the shared decode pacing — see decodeAsset. */
  run: (immediate: boolean) => Promise<unknown>;
};

export class Sound {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  thrustNode: {
    src: AudioBufferSourceNode;
    mainGain: GainNode;
  } | null = null;
  reverseThrustNode: {
    src: AudioBufferSourceNode;
    mainGain: GainNode;
  } | null = null;
  // Sustained hold-to-charge bed: five pre-baked tier loops (chord + crackle +
  // rolling-thunder rumble baked in), each on its own crossfade gain. Only the
  // active tier is audible; holding crossfades up the tiers as dots land.
  laserChargeNode: {
    sources: AudioBufferSourceNode[];
    tierGains: GainNode[];
    mainGain: GainNode;
  } | null = null;
  // Side engines (Z/X) — third engine voice; pitch sits between forward thrust
  // and retro so the player hears it as a distinct vector.
  sideThrustNode: {
    src: AudioBufferSourceNode;
    mainGain: GainNode;
  } | null = null;
  enabled = true;
  // Master volume multiplier. 1.0 = original baseline (master/bakedOut gains
  // at 0.6); 2.0 = double, the slider's default max. 0 disables playback via
  // `enabled` so per-voice early-outs still kick in.
  // The mix is tuned at this master level (the slider's default and the level
  //   every check:* script drives the bus at); it is also what the export pins.
  static readonly DEFAULT_VOLUME = 2;
  volume = Sound.DEFAULT_VOLUME;
  // Extra multiplier applied on top of `volume` so pause can fade the mix
  // to silence without losing the player's slider setting. 1 = no fade.
  private pauseFadeFactor = 1;
  // Bumped up from 0.6 so the default (volume=2 → 1.2 effective) lands well
  // above the old all-the-way-up calibration; the slider lets players pull
  // back if it's too hot on their setup.
  private static readonly MASTER_BASE_GAIN = 1.0;
  private static readonly BAKED_BASE_GAIN = 1.0;
  // Cancels the baked glue compressor's built-in makeup gain so a lone baked
  // voice passes the glue at unity (measured: 0.04 dB net on a single
  // explosion) — the stage only bites when several voices stack. Retune with
  // scripts/check-mix-stress.mjs if the glue settings change.
  private static readonly BAKED_GLUE_TRIM = 0.83;
  // Window (seconds) within which repeats of the same baked sound count as
  // one burst and get progressively ducked — see playBaked.
  private static readonly BAKED_RETRIGGER_WINDOW = 0.03;

  // Final safety stage after the master limiter: identity below the knee,
  // tanh-rounded above it, saturating at the ceiling. A WaveShaper clamps
  // input outside [-1, 1] to its endpoint values, so nothing the limiter
  // lets through — 1/20th of any overage, plus transients inside its attack
  // — can reach the DAC's hard clip. Limited material peaks below the knee,
  // so in normal play this stage is bit-transparent.
  private static softClipCurveCache: Float32Array<ArrayBuffer> | null = null;
  private static softClipCurve(): Float32Array<ArrayBuffer> {
    if (Sound.softClipCurveCache) return Sound.softClipCurveCache;
    const N = 8192, knee = 0.87, ceiling = 0.985;
    const curve = new Float32Array(new ArrayBuffer(N * 4));
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      const a = Math.abs(x);
      curve[i] = a <= knee
        ? x
        : Math.sign(x) * (knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
    }
    Sound.softClipCurveCache = curve;
    return curve;
  }
  // Wave-scaled intensity (0..1) for the background pulsar-approach beat.
  // 0 = silent, 1 = full ominous rumble at wave 30. Set by Game each wave;
  // read by playBgBeat when each beat fires.
  bgBeatIntensity = 0;
  // Per-alien continuous theremin drone. Keyed by the Alien instance so the
  // Game side can start/stop without us needing an ID scheme.
  alienDrones: Map<object, AlienDroneNode> = new Map();
  // Step index into the big-alien fire note cycle. Each shot advances by 1
  // so the riff plays back in order across hits.
  private bigAlienFireStep = 0;
  // Same idea for the medium alien — independent so its riff position
  // doesn't get tied to the big alien's firing cadence.
  private mediumAlienFireStep = 0;
  // Two electric-guitar candidates loaded for A/B comparison: Jazz (FreePats
  // SF2) and Gretsch (Karoryfer hollowbody). playAlienFireBig/Medium swap
  // between them mid-riff so a single firing burst plays both side by side.
  // Both recorded at A3 (220 Hz) — see SAMPLE_RECORDED_HZ at call sites.
  private guitarSampleJazz: AudioBuffer | null = null;
  private guitarSampleGretsch: AudioBuffer | null = null;
  private guitarSampleLoading = false;
  // Single soft hum held while the reticule hovers the first-beat dot. Null
  // when not hovering. Gain target rides the hover intensity each frame.
  private firstDotHum: FirstDotHumNode | null = null;
  // Octave-up companion hum (C5) that joins the instant the reticule crosses onto the tight
  // target area (the same moment the dashed lock ring begins filling). On/off with the hover.
  private firstDotOctaveHum: FirstDotHumNode | null = null;
  // Perfect-fifth companion hum (G4) that joins the moment the hover ring finishes filling, with
  // a sharper attack that settles into the same chill on-beat pulse as the base hum.
  // Null until startFirstDotLockHum fires; cleared by stopFirstDotLockHum on hover loss.
  private firstDotLockHum: FirstDotHumNode | null = null;
  // Major-third harmony hum (E4) that joins only once a drift shot is fully enabled (ring locked)
  // AND the reticule is still inside the tight hover radius — completing the C-E-G-C triad. Unlike
  // the lock fifth, it drops the instant the reticule leaves the small radius, so it tracks the
  // tighter hover band rather than the persistent lock state.
  private firstDotHarmonyHum: FirstDotHumNode | null = null;
  // Drift-tier-2 sub-octave root hum (C3) — joins once the player holds past the tier-2 threshold,
  // dropping the C-major root a full octave below the base hum to anchor the stack with weight.
  // Tracks the tight hover band with the lock fifth's fast release, same as the harmony third.
  private firstDotSubHum: FirstDotHumNode | null = null;
  // Drift-tier-3 bright fifth hum (G5) — the perfect fifth two octaves up. Sits above the stack
  // reading as "ascending / mastery"; bright formant, low gain.
  private firstDotShimmerHum: FirstDotHumNode | null = null;
  // Drift-tier-4 major-9th hum (D5) — adds the 9th to turn the C triad into a lush Cadd9; D is in
  // both C-major and C-minor scales and the add9 skips the third, so it harmonises with every song
  // (including the C-minor boss track) without ever clashing.
  private firstDotNinthHum: FirstDotHumNode | null = null;
  // Drift-tier-5 major-third hum (E5) — adds the 3rd up high, turning Cadd9 into a full bright
  // C-major chord: a standard, triumphant harmony that sounds like arrival. (Field name kept for
  // continuity; the tone is now the third, not the sixth.)
  private firstDotSixthHum: FirstDotHumNode | null = null;
  // Drift-tier-6 deep-root foundation hum (C2) — grounds the spread with the root an octave BELOW
  // the tier-2 sub root: a deep, chest-felt foundation that crowns the hold. Pure root, the floor.
  private firstDotHaloHum: FirstDotHumNode | null = null;
  // Single streak-shimmer texture voice. Null while no rhythm streak is alive.
  private streakShimmer: StreakShimmerNode | null = null;
  // Looping-stem streak voice (the "updraft" set). Null unless that set is playing.
  private streakLoop: StreakLoopNode | null = null;
  // Which set the live streak rolled. Null while no streak sound is active.
  private streakSet: StreakSoundSet | null = null;
  // Per-bassteroid ambient drone, keyed by the Asteroid instance. Only
  // populated for medium/small bass pieces (a large piece is "sealed" — it
  // hasn't been broken open yet).
  bassDrones: Map<object, BassDroneNode> = new Map();
  // Per-warble continuous hum, keyed by the Asteroid instance. Morphs between
  // a smooth phased-in hum and a warblier phased-out voice each frame.
  warbleDrones: Map<object, WarbleDroneNode> = new Map();
  // Per-comet shimmer pad, keyed by the Comet instance.
  cometShimmers: Map<object, CometShimmerNode> = new Map();
  // Single combo-halo ambient pad. Null when combo < 4 (no yellow halo yet).
  // Tier rides with the halo: 1 = yellow only, 2 = white bullets (combo ≥ 12).
  haloAmbient: HaloAmbientNode | null = null;
  haloAmbientTier = 0;
  // True while any comet is on screen — slides the pad's "third voice" from
  // major-third E4 (bright over the C-major bass bed) down to minor-third
  // Eb4, which is consonant with the comet's phrygian dissonance instead of
  // fighting it.
  haloAmbientCometMode = false;
  // Active pre-rendered halo music node — null when no music is playing
  // (i.e. combo < 4 or the legacy synthesized pad is selected).
  haloMusic: HaloMusicNode | null = null;
  // Active full-length halo song node (the "different system" for levels 1–9).
  // Null unless a full song is playing. Mutually exclusive with haloMusic —
  // syncHaloAmbient routes to one or the other, never both at once.
  haloFullMusic: HaloFullMusicNode | null = null;
  // Current slow-mo playback rate for music, tracked independently of any
  // playing node so music that STARTS mid-slomo also opens at the slowed rate
  // (the start paths seed new sources from this). set*PlaybackRate keeps it live.
  private currentMusicPlaybackRate = 1.0;
  // Per-stem buffer cache, keyed by URL. AudioBuffers are decoded once and
  // reused across all start/stop cycles for a given variation.
  haloMusicBuffers: Map<string, AudioBuffer> = new Map();
  private haloMusicLoading: Map<string, Promise<AudioBuffer | null>> = new Map();
  // Pilot's Log vocal one-shots. Decoded once on first play, cached forever.
  // Voiced (ElevenLabs) + post-processed to scratchy astronaut-radio character;
  // mixed via the baked leg so the live master compressor + reverb don't
  // smear the spoken word (the glue there stays at unity unless the whole
  // mix piles up). pilotLogPlaying is a soft mutex so a repeated trigger
  // doesn't stack a second voice on top of the first.
  //
  // Cache is keyed by URL (not just index) because index 1 (combo-x6 unlock)
  // picks a random take from a pool each fire — see PILOT_LOG_1_TAKES.
  pilotLogBuffers: Map<string, AudioBuffer> = new Map();
  pilotLogPlaying = false;
  private pilotLogLoading: Map<string, Promise<AudioBuffer | null>> = new Map();

  // Listener position (ship). Pan + distance falloff are computed relative
  // to this. Half-width/half-height scale the screen so pan saturates at the
  // edges; updated by the game on resize. Listener defaults to screen center
  // so positional sounds before the first setListener() still pan sensibly.
  listenerX = 0;
  listenerY = 0;
  halfW = 1;
  halfH = 1;
  // Subtle spatial profile: pan saturates at ~60% of full L/R, and volume
  // drops to ~50% by the screen edge.
  private static readonly PAN_MAX = 0.6;
  private static readonly DIST_MIN_GAIN = 0.5;

  // Tell the audio bus where the listener (ship) is and how big the screen is.
  // Called once per frame from the game loop.
  setListener(x: number, y: number, w: number, h: number) {
    this.listenerX = x;
    this.listenerY = y;
    this.halfW = Math.max(1, w * 0.5);
    this.halfH = Math.max(1, h * 0.5);
  }

  // Compute pan + falloff gain from a world position relative to the listener.
  // Pan is the x-offset normalized to [-PAN_MAX, +PAN_MAX]; gain falls off
  // smoothly with euclidean distance, clamped to DIST_MIN_GAIN at the edge.
  // Offsets are toroidal so a source just across the seam pans as nearby.
  private spatialFor(pos: Pos): { pan: number; gain: number } {
    const [tdx, tdy] = toroidalDelta(
      pos.x - this.listenerX, pos.y - this.listenerY, this.halfW * 2, this.halfH * 2,
    );
    const dx = tdx / this.halfW;
    const dy = tdy / this.halfH;
    const pan = Math.max(-1, Math.min(1, dx)) * Sound.PAN_MAX;
    const d = Math.min(1, Math.hypot(dx, dy));
    const gain = 1 - (1 - Sound.DIST_MIN_GAIN) * d;
    return { pan, gain };
  }

  // Build a pan+gain splice node connected to `sink`. Voices in the caller
  // connect into `panner` (or `distGain` — equivalent, both are upstream).
  private makeSpatial(pos: Pos, sink: AudioNode): SpatialNodes | null {
    if (!this.ctx) return null;
    const { pan, gain } = this.spatialFor(pos);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    const distGain = this.ctx.createGain();
    distGain.gain.value = gain;
    panner.connect(distGain);
    distGain.connect(sink);
    return { panner, distGain };
  }

  // Update an existing spatial splice (used per-frame for drones as the
  // underlying entity moves around the screen).
  private updateSpatial(s: SpatialNodes, pos: Pos) {
    if (!this.ctx) return;
    const { pan, gain } = this.spatialFor(pos);
    const t = this.ctx.currentTime;
    // setTargetAtTime smooths the change over a short time constant so we
    // don't hear zipper noise when an entity moves quickly.
    s.panner.pan.setTargetAtTime(pan, t, 0.05);
    s.distGain.gain.setTargetAtTime(gain, t, 0.05);
  }

  ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.buildMixGraph();
    // Pre-fill the noise-buffer cache so the first bassteroid/comet spawn
    // doesn't pay the 6-8s buffer allocation mid-gameplay. AudioBuffers can't
    // be created before the context exists, so this is the earliest we can do
    // it — runs once, on first user interaction.
    this.prewarmNoiseBuffers();
    // The prerender* helpers used to be fired here, which meant ~48 mp3s went
    // out the moment the context existed, outside the loader and ahead of the
    // gate they were competing with. They are now purely on-miss demand loads;
    // warmBakedCache below schedules the same keys in wave order.
    this.loadGuitarSample();
    // Kick off the baked-mp3 fetch + decode for every voice that has a baked
    // recipe. The title screen awaits bakedCacheReady() before letting the
    // player start so playBaked is guaranteed to hit cache. In dev, missing
    // mp3s fall through to a live Tone render via bakeSound and are POSTed
    // back to disk so prod fetches stay 200-only.
    this.warmBakedCache();
  }

  // Master bus + channel mixer, built on whatever this.ctx currently is.
  //   Shared by ensureContext (live AudioContext) and beginExportCapture
  //   (offline capture context) so the export renders through the exact
  //   compressor/limiter/channel chain the player hears.
  private buildMixGraph() {
    if (!this.ctx) return;
    // liveSum / bakedSum are the two summing buses every channel feeds into.
    // liveSum runs through the master compressor (live voices need it; their
    // dynamics aren't pre-baked). bakedSum runs through its own glue
    // compressor instead: each mp3 already carries the master compressor in
    // its tail, but that per-file render can never duck one voice against
    // another the way a shared live compressor does, so a same-frame stack of
    // different one-shots used to hit the limiter with the full linear sum.
    // The glue is trimmed to unity for a lone voice (BAKED_GLUE_TRIM cancels
    // the node's built-in makeup gain) and only leans on pileups, which is
    // exactly the program-dependent stage the live leg always had.
    //
    // Both legs join one shared limiter, and a soft-clip WaveShaper sits
    // after it as the true ceiling. The limiter alone is not one: a
    // DynamicsCompressor at 20:1 still passes 1/20th of the overage plus
    // whatever escapes its attack, and scripts/check-mix-stress.mjs measured
    // 3-4% of samples beyond full scale in a busy moment — hard-clipped by
    // the DAC into the crackle this chain exists to prevent. The limiter's
    // old 10 ms release was also audio-rate gain pumping on bass content;
    // 120 ms keeps its gain moves below the rate that reads as distortion.
    this.liveSum = this.ctx.createGain();
    this.liveSum.gain.value = Sound.MASTER_BASE_GAIN * this.volume * this.pauseFadeFactor;
    const masterCompressor = this.ctx.createDynamicsCompressor();
    masterCompressor.threshold.value = -18;
    masterCompressor.ratio.value = 3;
    masterCompressor.attack.value = 0.01;
    masterCompressor.release.value = 0.18;
    masterCompressor.knee.value = 12;
    const masterLimiter = this.ctx.createDynamicsCompressor();
    masterLimiter.threshold.value = -2;
    masterLimiter.ratio.value = 20;
    masterLimiter.attack.value = 0.003;
    masterLimiter.release.value = 0.12;
    masterLimiter.knee.value = 6;
    const softClip = this.ctx.createWaveShaper();
    softClip.curve = Sound.softClipCurve();
    // Master-bus analyser tap. Both the live and baked legs route through it
    // on their way to destination, so getByteFrequencyData() sees the full
    // mix — sfx, halo music, vocals, base pulse — with zero per-voice wiring.
    // A passthrough node: it observes the signal without altering it.
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    analyser.connect(this.ctx.destination);
    this.masterAnalyser = analyser;
    this.analyserBins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.analyserWave = new Uint8Array(new ArrayBuffer(analyser.fftSize));

    this.liveSum.connect(masterCompressor);
    masterCompressor.connect(masterLimiter);
    masterLimiter.connect(softClip);
    softClip.connect(analyser);

    this.bakedSum = this.ctx.createGain();
    this.bakedSum.gain.value = Sound.BAKED_BASE_GAIN * this.volume * this.pauseFadeFactor;
    const bakedGlue = this.ctx.createDynamicsCompressor();
    bakedGlue.threshold.value = -10;
    bakedGlue.ratio.value = 2.5;
    bakedGlue.attack.value = 0.006;
    bakedGlue.release.value = 0.25;
    bakedGlue.knee.value = 12;
    const bakedGlueTrim = this.ctx.createGain();
    bakedGlueTrim.gain.value = Sound.BAKED_GLUE_TRIM;
    this.bakedSum.connect(bakedGlue);
    bakedGlue.connect(bakedGlueTrim);
    bakedGlueTrim.connect(masterLimiter);

    // Build the four channel pairs (live + baked legs each). Each leg is a
    // gain node whose value is the player's per-channel volume; it sits
    // upstream of liveSum / bakedSum so the volume slider rides everything
    // routed through that channel without re-touching individual voices.
    const liveSum = this.liveSum;
    const bakedSum = this.bakedSum;
    const makeChannel = (channel: AudioChannel): [GainNode, GainNode] => {
      const v = getChannelVolume(channel);
      const live = this.ctx!.createGain();
      live.gain.value = v;
      live.connect(liveSum);
      const baked = this.ctx!.createGain();
      baked.gain.value = v;
      baked.connect(bakedSum);
      return [live, baked];
    };
    [this.chBasePulseLive, this.chBasePulseBaked] = makeChannel("basePulse");
    [this.chSfxLive,       this.chSfxBaked]       = makeChannel("sfx");
    [this.chMusicLive,     this.chMusicBaked]     = makeChannel("music");
    [this.chVocalsLive,    this.chVocalsBaked]    = makeChannel("vocals");

    // master / bakedOut alias the SFX channel so existing voice code (which
    // connects to those fields) lands on the SFX bus with no rewiring.
    this.master = this.chSfxLive;
    this.bakedOut = this.chSfxBaked;
  }

  // Every duration ever passed to makeNoiseBuffer across the codebase. Grep
  // for `makeNoiseBuffer(` if you add a new caller with a fresh duration —
  // missing entries still work (lazy alloc on first call), they just pay
  // the spawn-time stutter you're avoiding here.
  private prewarmNoiseBuffers() {
    const durations = [0.018, 0.025, 0.04, 0.06, 0.08, 0.18, 0.3, 0.34, 0.4, 0.55, 1.3, 2.5, 3, 4, 6, 8];
    for (const d of durations) this.makeNoiseBuffer(d);
  }

  // Fetch + decode both guitar candidates. Single-shot; idempotent. If a
  // file is missing the corresponding voice silent-skips at call time.
  private async loadGuitarSample() {
    if (!this.ctx || this.guitarSampleLoading) return;
    if (this.guitarSampleJazz && this.guitarSampleGretsch) return;
    this.guitarSampleLoading = true;
    const ctx = this.ctx;
    const loadOne = async (url: string): Promise<AudioBuffer | null> => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        return await ctx.decodeAudioData(ab);
      } catch {
        return null;
      }
    };
    try {
      const [jazz, gretsch] = await Promise.all([
        this.guitarSampleJazz ? Promise.resolve(this.guitarSampleJazz) : loadOne("/sounds/guitar/big-alien-jazz.wav"),
        this.guitarSampleGretsch ? Promise.resolve(this.guitarSampleGretsch) : loadOne("/sounds/guitar/big-alien-gretsch.wav"),
      ]);
      if (jazz) this.guitarSampleJazz = jazz;
      if (gretsch) this.guitarSampleGretsch = gretsch;
    } finally {
      this.guitarSampleLoading = false;
    }
  }

  // ── Runtime Tone engine removed ────────────────────────────────────────
  // Live playback no longer touches Tone — every voice is either a baked
  // MP3 or a hand-built WebAudio graph routed through the native master
  // compressor + limiter set up in ensureContext. Tone is still loaded by
  // bakeSound (dev-only) to render fresh MP3s when a recipe changes.

  // Kick off offline-render for every recipe (and every quantized pitch
  // variant) we know about. Fire-and-forget; results land in bakedBuffers as
  // each promise resolves. Safe to call repeatedly — playBaked's in-flight
  // guard de-dupes.
  private warmBakedCache() {
    if (import.meta.env?.DEV) {
      // The schedule carries these sizes as literals (importing them would
      // close a module cycle). A pool that grew without the schedule growing
      // would silently strand its new indices with no file — and both pools
      // are silent-on-miss voices, so the drift would be inaudible until
      // someone noticed a tine or a hum had gone missing.
      if (Sound.STREAK_SHIMMER_POOL.length !== STREAK_SHIMMER_POOL_SIZE ||
          Sound.FIRST_DOT_HUM_PITCH.length !== FIRST_DOT_HUM_POOL_SIZE) {
        // eslint-disable-next-line no-console
        console.warn("[sound] soundSchedule pool sizes are stale — update STREAK_SHIMMER_POOL_SIZE / FIRST_DOT_HUM_POOL_SIZE");
      }
    }
    const gate: Promise<unknown>[] = [];
    let order = 0;
    for (const entry of SOUND_LOAD_SCHEDULE) {
      for (const key of entry.keys) {
        const id = this.bakedKey(entry.name, key);
        // Seed the debug map so the overlay shows "queued" before the fetch
        // starts — queueBake flips it to "fetching" → "loaded".
        if (!this.bakedLoadStates.has(id)) this.bakedLoadStates.set(id, "queued");
        const job = this.enqueueAsset(id, entry.wave, order++, (immediate) => this.queueBake(entry.name, key, immediate));
        // The gate is what the title screen waits on, so it runs immediately
        // and in parallel rather than through the pacer — there is no frame
        // loop to protect yet, and every millisecond here is start latency.
        if (entry.gate) gate.push(this.startAsset(job, true));
      }
    }
    // Tolerant of individual failures: a missing mp3 means one voice
    // silent-misses or renders live, not a run that never starts.
    this.bakedCacheReadyPromise = Promise.allSettled(gate).then(() => undefined);
    this.pumpAssets();
  }

  // ── Paced asset loading ───────────────────────────────────────────────
  // Everything the game fetches after the gate — the rest of the baked mp3s,
  // the halo music stems, the pilot-log takes — goes through one queue,
  // ordered by the wave it can first be heard on (see soundSchedule.ts).
  //
  // Two separate limits, because there are two separate costs. Fetches are
  // network-bound and nearly free on the main thread, so a few run at once.
  // decodeAudioData is the expensive one and is what starves the beat
  // scheduler when a hundred of them land together, so decodes are strictly
  // serialized AND each one waits for an idle callback with real slack in it.
  // The net effect is that background loading only ever consumes time the
  // frame loop didn't want.
  private static readonly ASSET_MAX_IN_FLIGHT = 6;
  // Upper bound on how long the queue can wait for an idle slot. Only bites
  // on a page that is never idle; normally rIC fires long before this.
  private static readonly ASSET_IDLE_TIMEOUT_MS = 500;
  // Fallback pacing where requestIdleCallback doesn't exist (Safari).
  private static readonly ASSET_FALLBACK_GAP_MS = 120;
  // How long one idle slot may spend decoding before handing the frame back.
  private static readonly DECODE_SLOT_BUDGET_MS = 6;

  private assetJobs: AssetJob[] = [];
  private assetsInFlight = 0;
  private assetPumpScheduled = false;
  // Background decodes across every loader — baked one-shots, music stems,
  // vocals — share one queue so they can't pile onto the audio thread
  // together. Drained by pumpDecodes in frame slack.
  private decodeQueue: Array<{ bytes: ArrayBuffer; resolve: (b: AudioBuffer | null) => void }> = [];
  private decodePumpScheduled = false;
  // Highest wave the run has reached. Jobs at or below it are urgent; the
  // rest are ordered by how far ahead they are.
  private loadWave = 1;

  private enqueueAsset(id: string, wave: number, order: number, run: (immediate: boolean) => Promise<unknown>): AssetJob {
    const job: AssetJob = { id, wave, order, started: false, inFlight: null, run };
    this.assetJobs.push(job);
    return job;
  }

  private startAsset(job: AssetJob, immediate = false): Promise<unknown> {
    if (job.started) return job.inFlight ?? Promise.resolve();
    job.started = true;
    job.inFlight = job.run(immediate);
    return job.inFlight;
  }

  // The run has reached a new wave: anything that wave introduces becomes
  // urgent, and the ordering behind it shifts with us. Cheap enough to call
  // on every wave — the queue is a few hundred entries and this is a compare.
  setLoadWave(wave: number) {
    if (wave <= this.loadWave) return;
    this.loadWave = wave;
    this.pumpAssets();
  }

  // Drain the whole queue at once, pacing be damned. Only the video exporter
  // wants this: it steps frames as fast as the CPU allows, so a background
  // load that resolves mid-sweep lands against a clock that has already raced
  // past the moment the voice needed to start. Everything must be resident
  // before the first frame.
  async loadAllAssets(): Promise<void> {
    await Promise.allSettled(this.assetJobs.map((job) => this.startAsset(job, true)));
  }

  // A voice needed a buffer that isn't cached. Pull it out of the background
  // queue and load it unpaced — pacing protects the frame loop from work
  // nobody is waiting on, and here somebody is. Idempotent: queueBake's
  // in-flight guard makes repeat calls while it loads free.
  private demandBake(name: SoundName, pitchRatio: number) {
    if (this.demandAsset(this.bakedKey(name, pitchRatio))) return;
    void this.queueBake(name, pitchRatio, true);
  }

  // A play-time cache miss: this asset is needed NOW, so it skips the queue
  // and the decode pacing both. Pacing exists to protect the frame loop from
  // work nobody is waiting on; here somebody is.
  private demandAsset(id: string): boolean {
    const job = this.assetJobs.find((j) => j.id === id && !j.started);
    if (!job) return false;
    void this.startAsset(job, true);
    return true;
  }

  private nextAssetJob(): AssetJob | null {
    let best: AssetJob | null = null;
    let bestRank = Infinity;
    for (const job of this.assetJobs) {
      if (job.started) continue;
      // Anything the current wave has already reached ranks equally urgent;
      // beyond that, nearest wave first, then declaration order.
      const rank = Math.max(0, job.wave - this.loadWave);
      if (rank < bestRank || (rank === bestRank && best !== null && job.order < best.order)) {
        best = job;
        bestRank = rank;
      }
    }
    return best;
  }

  // Note this does NOT wait for idle: starting a fetch is a few microseconds
  // and the response is assembled off the main thread. The expensive half is
  // the decode, and that is where the idle gating lives (pumpDecodes). Gating
  // the fetch too just added a frame of latency per file for no benefit.
  private pumpAssets() {
    if (this.assetPumpScheduled) return;
    this.assetPumpScheduled = true;
    queueMicrotask(() => {
      this.assetPumpScheduled = false;
      while (this.assetsInFlight < Sound.ASSET_MAX_IN_FLIGHT) {
        const job = this.nextAssetJob();
        if (!job) return;
        this.assetsInFlight++;
        void this.startAsset(job)
          .catch(() => undefined)
          .then(() => {
            this.assetsInFlight--;
            this.pumpAssets();
          });
      }
    });
  }

  // Run `cb` in slack the frame loop didn't use. requestIdleCallback already
  // means "the browser has nothing better to do", so we take whatever slot it
  // hands us rather than second-guessing it on timeRemaining() — an earlier
  // version demanded 4 ms of headroom and, on a page that never had that much,
  // spun until the timeout fired and throughput collapsed to one slot per
  // 800 ms. The timeout stays as the floor: a permanently busy page still
  // makes progress instead of starving the queue forever.
  private whenIdle(cb: () => void) {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback !== "function") {
      setTimeout(cb, Sound.ASSET_FALLBACK_GAP_MS);
      return;
    }
    w.requestIdleCallback(cb, { timeout: Sound.ASSET_IDLE_TIMEOUT_MS });
  }


  // decodeAudioData, either right now (something is waiting on it) or from
  // the shared background queue (nothing is).
  //
  // The background queue is drained inside idle callbacks, several per slot
  // while the slot still has room. One-decode-per-callback was safe but slow:
  // requestIdleCallback fires roughly once a frame at best, so a couple of
  // hundred files took minutes. A wall-clock budget per slot keeps the hit
  // bounded while letting a run of small files clear in one go.
  private decodeAsset(bytes: ArrayBuffer, immediate: boolean): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    if (immediate) return ctx.decodeAudioData(bytes).catch(() => null);
    return new Promise<AudioBuffer | null>((resolve) => {
      this.decodeQueue.push({ bytes, resolve });
      this.pumpDecodes();
    });
  }

  private pumpDecodes() {
    if (this.decodePumpScheduled || this.decodeQueue.length === 0) return;
    this.decodePumpScheduled = true;
    this.whenIdle(async () => {
      this.decodePumpScheduled = false;
      const ctx = this.ctx;
      const startedAt = performance.now();
      // decodeAudioData is async, so the idle deadline object is stale by the
      // time one finishes — measure against the clock instead.
      while (this.decodeQueue.length > 0 && performance.now() - startedAt < Sound.DECODE_SLOT_BUDGET_MS) {
        const item = this.decodeQueue.shift();
        if (!item) break;
        if (!ctx) { item.resolve(null); continue; }
        const buf = await ctx.decodeAudioData(item.bytes).catch(() => null);
        item.resolve(buf);
      }
      this.pumpDecodes();
    });
  }


  // Promise resolves once warmBakedCache's first-pass fetches all complete.
  // Returns an already-resolved promise if warming hasn't started yet (e.g.
  // audio API unavailable) so callers don't hang on the title screen.
  bakedCacheReady(): Promise<void> {
    return this.bakedCacheReadyPromise ?? Promise.resolve();
  }

  // Trigger a bake for one (sound, pitchKey) pair if it isn't cached or in
  // flight. Two-tier flow: first try fetching a pre-baked MP3 from
  // public/sounds/baked/ (no Tone.js work — runs in parallel across calls);
  // only if that 404s do we fall through to the live Tone bake. The live
  // bakes are still serialized via bakeChain because Tone.setContext is
  // global, but in practice (with the MP3s committed) we never hit that
  // path in prod and only hit it on first dev play after a synth-recipe
  // edit. In dev the rendered buffer is POSTed back to /__bake-dump__ so
  // the next reload is fully fetch-only.
  private queueBake(name: SoundName, pitchRatio: number, immediate = false): Promise<void> {
    const key = this.bakedKey(name, pitchRatio);
    if (this.bakedBuffers.has(key) || this.bakingInFlight.has(key)) return Promise.resolve();
    this.bakingInFlight.add(key);
    this.bakedLoadStates.set(key, "fetching");
    return this.fetchBakedMp3(name, pitchRatio, immediate).then((fetched) => {
      if (fetched) {
        this.bakedBuffers.set(key, fetched);
        this.bakingInFlight.delete(key);
        this.bakedLoadStates.set(key, "loaded");
        return;
      }
      this.bakedLoadStates.set(key, "failed");
      // Fall through to live Tone bake (serialized). Fire-and-forget — the
      // returned promise from queueBake resolves on fetch outcome, not on the
      // optional live-bake fallback, because the title-screen gate only cares
      // that the mp3 path has settled.
      this.bakeChain = this.bakeChain.then(() => this.bakeSound(name, pitchRatio).then((rendered) => {
        if (rendered) {
          this.bakedBuffers.set(key, rendered);
          void this.dumpBakedToDev(name, pitchRatio, rendered);
          this.bakedLoadStates.set(key, "loaded");
        }
        this.bakingInFlight.delete(key);
      }).catch(() => { this.bakingInFlight.delete(key); }));
    }).catch(() => {
      this.bakingInFlight.delete(key);
      this.bakedLoadStates.set(key, "failed");
    });
  }

  // ── Pre-rendered Tone one-shots ─────────────────────────────────────────
  // The biggest perf cost of the Tone engine is per-trigger voice allocation
  // inside PolySynth/MembraneSynth/etc. plus the live convolution reverb.
  // For one-shot sounds (kick, fire, chime, etc.) the synth recipe is fixed,
  // so we render it once into an AudioBuffer via OfflineAudioContext and just
  // play that buffer on every subsequent trigger. The reverb/chorus tail is
  // baked into the buffer, so even the wet path costs nothing at runtime.
  //
  // Cache keyed by `${name}|${quantizedPitchRatio}` — pitch ratios from Game
  // are a tiny finite set (1, 0.8409, 1.122 for bassteroids; 1 for everything
  // else), so the cache stays small.
  bakedBuffers: Map<string, AudioBuffer> = new Map();
  // Burst tracker for playBaked's same-sound pileup duck: start time of the
  // current burst and how many copies of the key it holds so far.
  private bakedBursts: Map<string, { start: number; count: number }> = new Map();
  // Sounds we're currently baking — guards against double-bake when the same
  // sound fires several times before the first bake completes.
  bakingInFlight: Set<string> = new Set();
  // Resolves once every Tone-engine sound's baked mp3 is fetched + decoded.
  // The title screen awaits this before letting the player start so we never
  // need the live Tone fallback during gameplay — which is critical because
  // some browsers (Firefox w/ resistFingerprinting and similar privacy
  // setups) stub Web Audio in ways that crash Tone's destination init.
  private bakedCacheReadyPromise: Promise<void> | null = null;
  // Same, for the lazily-warmed one-shots that keep a live-synth fallback and
  // therefore stay out of the start gate. Only the export path awaits it.
  // Per-key load state for the ?debug=true overlay. "queued" = warmBakedCache
  // listed it but the fetch hasn't started; "fetching" = fetch in flight;
  // "loaded" = decoded AudioBuffer in bakedBuffers; "failed" = fetch returned
  // null or threw (live Tone bake may still be running as a fallback).
  bakedLoadStates: Map<string, "queued" | "fetching" | "loaded" | "failed"> = new Map();
  // Serialized bake queue. bakeSound swaps Tone's global context to the
  // OfflineAudioContext for the duration of the render, so running two
  // bakes concurrently would race on Tone.setContext. We chain promises
  // here so each bake completes (and restores Tone's context) before the
  // next starts.
  bakeChain: Promise<unknown> = Promise.resolve();
  // Dedicated GainNode for playing back audio that already contains an FX
  // chain in its tail — the Tone recipes and the ElevenLabs one-shots. Those
  // bypass this.master, or the master compressor would be applied twice; they
  // route through the baked leg's glue instead (unity for a lone voice,
  // ducking pileups) and the shared limiter + soft clip. A raw-voice bake is
  // NOT one of these: it goes to this.master like the graph it came from.
  bakedOut: GainNode | null = null;
  // Per-channel mix gains. Each channel has two legs — a "live" leg into the
  // master compressor, and a "baked" leg that swaps the compressor for the
  // stack-taming glue, for audio that already carries an FX chain in its
  // tail. Both legs share the master limiter + soft clip.
  // setChannelVolume() updates both legs of a channel together.
  //
  // chSfx{Live,Baked} are aliased by this.master and this.bakedOut so the
  // existing voice methods (which connect to those fields directly) sit on
  // the SFX channel without any per-voice rewiring. The other three channels
  // are wired explicitly: bgBeat → chBasePulseBaked, halo music →
  // chMusicLive, pilot log → chVocalsBaked.
  private chBasePulseLive: GainNode | null = null;
  private chBasePulseBaked: GainNode | null = null;
  private chSfxLive: GainNode | null = null;
  private chSfxBaked: GainNode | null = null;
  private chMusicLive: GainNode | null = null;
  private chMusicBaked: GainNode | null = null;
  private chVocalsLive: GainNode | null = null;
  private chVocalsBaked: GainNode | null = null;
  // Final summing buses (after channels, before compressor/destination). Hold
  // the master volume + pause-fade multiplier so a single slider scales
  // everything regardless of which channel a voice lives on.
  private liveSum: GainNode | null = null;
  private bakedSum: GainNode | null = null;
  // Master-bus FFT tap + a reused read buffer. The visualizer pulls the
  // current spectrum each frame via readSpectrum(); allocating the buffer
  // once here keeps the render loop allocation-free.
  private masterAnalyser: AnalyserNode | null = null;
  private analyserBins: Uint8Array<ArrayBuffer> | null = null;
  private analyserWave: Uint8Array<ArrayBuffer> | null = null;
  // Set by play() while a single dispatch is in progress, so playBaked can
  // pick up the position without per-helper plumbing. Null when the call has
  // no spatial position.
  private spatialPosForCall: Pos | null = null;

  // Absolute audio-clock time a baked one-shot should start at, set by the
  // lookahead pulse scheduler so the beat lands sample-accurately regardless
  // of which rAF frame the decision was made on. Null = start immediately.
  private scheduledWhenForCall: number | null = null;

  // Start time for live-synth voices: the pending scheduled start when the
  // lookahead scheduler set one, else "now". Clamped so an already-past
  // schedule still sounds (late) instead of silently misfiring.
  private voiceTime(name: string): number {
    const now = this.ctx!.currentTime;
    const when = this.scheduledWhenForCall;
    if (when === null) return now;
    if ((import.meta.env as unknown as { DEV?: boolean })?.DEV && when < now - 0.001) {
      // eslint-disable-next-line no-console
      console.warn(`[pulse-late] ${name} scheduled ${((now - when) * 1000).toFixed(1)}ms in the past`);
    }
    return Math.max(when, now);
  }

  // Map a (channel, leg) pair to its underlying gain node. Used by
  // setChannelVolume so callers don't need to know about the live/baked
  // split.
  private channelLeg(channel: AudioChannel, leg: "live" | "baked"): GainNode | null {
    switch (channel) {
      case "basePulse": return leg === "live" ? this.chBasePulseLive : this.chBasePulseBaked;
      case "sfx":       return leg === "live" ? this.chSfxLive       : this.chSfxBaked;
      case "music":     return leg === "live" ? this.chMusicLive     : this.chMusicBaked;
      case "vocals":    return leg === "live" ? this.chVocalsLive    : this.chVocalsBaked;
    }
  }

  // Voices whose mp3 holds a finished mix rather than a bare voice: the Tone
  // recipes, which render through the Tone engine's own compressor + limiter,
  // and the ElevenLabs one-shots, which arrived as mastered audio. Those play
  // through the baked leg's glue, which is what keeps a stack of pre-limited
  // files off the master limiter. Everything else is a raw render of the same
  // graph the live fallback builds, so it belongs on the live leg — through
  // the master compressor, exactly as the live voice would be.
  private static readonly PREMASTERED_BAKES: ReadonlySet<SoundName> = new Set<SoundName>([
    "bgBeat", "fireBeat", "bassKick", "bassBoom", "bassPluck", "bassSnap",
    "chime", "drainChime", "powerup", "waveClear", "cometNote",
    "wraithScream", "wraithHit", "wraithLunge", "wraithDeath",
  ]);

  // Where a baked buffer joins the mix. bgBeat is the background pulsar pulse
  // and rides the basePulse slider; everything else is an SFX voice.
  private bakedSink(name: SoundName): GainNode | null {
    if (name === "bgBeat") return this.chBasePulseBaked;
    return Sound.PREMASTERED_BAKES.has(name) ? this.chSfxBaked : this.chSfxLive;
  }

  private bakedKey(name: SoundName, pitchRatio: number): string {
    // Quantize to 4 decimals so floating-point noise doesn't fragment the cache.
    return `${name}|${pitchRatio.toFixed(4)}`;
  }

  // Filename-safe form of bakedKey for disk storage. `|` would force a URL
  // escape on every fetch and trips the dev plugin's path-safety regex, so we
  // swap it for `__`. The 4-decimal quantization stays, dots are file-safe.
  private bakedFileSlug(name: SoundName, pitchRatio: number): string {
    return `${name}__${pitchRatio.toFixed(4)}`;
  }

  private bakedFileUrl(name: SoundName, pitchRatio: number): string {
    return `/sounds/baked/${this.bakedFileSlug(name, pitchRatio)}.mp3`;
  }

  // Encode an AudioBuffer as a 16-bit PCM WAV in a single Uint8Array. Used to
  // ship a freshly-rendered bake to the dev plugin for ffmpeg → MP3 conversion.
  // Stereo interleaved; sample rate from the buffer.
  private encodeWav(buf: AudioBuffer, gain = 1): Uint8Array {
    const numCh = buf.numberOfChannels;
    const sr = buf.sampleRate;
    const frames = buf.length;
    const dataBytes = frames * numCh * 2;
    const out = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(out);
    const writeStr = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);            // PCM chunk size
    view.setUint16(20, 1, true);             // PCM format
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * 2, true);
    view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataBytes, true);
    const channels: Float32Array[] = [];
    for (let c = 0; c < numCh; c++) channels.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i] * gain));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Uint8Array(out);
  }

  // Peak every render is encoded at. A voice is scaled to this before it goes
  // to ffmpeg and scaled back by BAKE_GAINS on decode, so a soft one-shot
  // spends the codec's bits on the sound instead of on headroom it never uses.
  private static readonly BAKE_ENCODE_PEAK = 0.89;
  // Playback multipliers that undo that scaling, keyed by file slug. Fetched
  // once from bake-gains.json, which the dev bake hook writes beside the mp3s.
  private bakeGains: Map<string, number> | null = null;
  private bakeGainsLoading: Promise<void> | null = null;

  private loadBakeGains(): Promise<void> {
    if (this.bakeGains) return Promise.resolve();
    this.bakeGainsLoading ??= fetch("/sounds/baked/bake-gains.json")
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((json: Record<string, number>) => {
        this.bakeGains = new Map(Object.entries(json).filter(([, g]) => Number.isFinite(g) && g > 0));
      });
    return this.bakeGainsLoading;
  }

  // Undo the encode-time normalization in place. A file with no manifest entry
  // (the ElevenLabs one-shots, anything baked before the manifest existed)
  // plays at the level it was rendered at, which is what it did before.
  private applyBakeGain(slug: string, buf: AudioBuffer) {
    const gain = this.bakeGains?.get(slug);
    if (!gain || gain === 1) return;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] *= gain;
    }
  }

  // Fetch a pre-baked MP3 from public/sounds/baked/. Returns the decoded
  // AudioBuffer on hit, null on 404 (so queueBake can fall through to a live
  // Tone bake — which in dev also POSTs the result back for next time).
  private async fetchBakedMp3(name: SoundName, pitchRatio: number, immediate = false): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    try {
      const [r] = await Promise.all([fetch(this.bakedFileUrl(name, pitchRatio)), this.loadBakeGains()]);
      if (!r.ok) return null;
      const ab = await r.arrayBuffer();
      // Fetching is cheap on the main thread; decoding is not. Background
      // loads hand the decode to the shared serialized queue, which only runs
      // it in frame slack. A demand load decodes straight away.
      const buf = await this.decodeAsset(ab, immediate);
      if (buf) this.applyBakeGain(this.bakedFileSlug(name, pitchRatio), buf);
      return buf;
    } catch {
      return null;
    }
  }

  // Dev-only: POST a freshly-rendered bake to the Vite plugin so it lands in
  // public/sounds/baked/ as MP3. The plugin no-ops if the file already exists,
  // so this is safe to call on every bake.
  //
  // The buffer handed here plays at the level the game wants; the file gets a
  // normalized copy plus the gain that restores it, so encode headroom is a
  // property of the file and never of the sound.
  private async dumpBakedToDev(name: SoundName, pitchRatio: number, buf: AudioBuffer): Promise<void> {
    if (!(import.meta.env as unknown as { DEV?: boolean })?.DEV) return;
    try {
      let peak = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const data = buf.getChannelData(c);
        for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
      }
      const norm = peak > 0 ? Sound.BAKE_ENCODE_PEAK / peak : 1;
      const wav = this.encodeWav(buf, norm);
      const slug = this.bakedFileSlug(name, pitchRatio);
      await fetch(`/__bake-dump__?key=${encodeURIComponent(slug)}&gain=${(1 / norm).toFixed(6)}`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }),
      });
    } catch {
      // dev convenience only; never block playback on a dump failure.
    }
  }

  // Extra audio rendered on BOTH sides of every baked drone loop's seamless
  // window. MP3 can't reconstruct a file's first/last frames exactly (the
  // codec's overlapping windows have no neighbor to lean on there), so a
  // loop that plays the decoded buffer end-to-start clicks even when the
  // rendered PCM tiles perfectly. Instead the loop window sits this far
  // inside the buffer (src.loopStart/loopEnd, playback starts at loopStart)
  // and the smeared edge frames never sound. Also swallows filter ring-in
  // at the head of the render and gapless-trim differences across decoders.
  private static readonly LOOP_BAKE_PAD = 0.25;

  // Render length (seconds) for every pure-WebAudio one-shot bake. Each entry
  // must cover its graph's latest stop() plus a hair of settle, so the trailing
  // exponential fades reach true silence inside the buffer instead of being
  // chopped (a chop is an audible click, and it also loses the reverb/echo
  // tail the live path would have kept ringing). Overshooting costs almost
  // nothing — trailing silence is what VBR mp3 compresses best.
  private static readonly ONE_SHOT_BAKE_LEN: Partial<Record<SoundName, number>> = {
    cometDestroyed: 15.4,
    cometDestroyedSad: 6.4,
    bonusLife: 15.4,
    fire: 1.0,
    calibrationTap: 1.0,
    explosionLarge: 1.3,
    explosionMedium: 1.1,
    explosionSmall: 0.9,
    // convolver tail (1.3s IR) rings on past the 1.15s sub stop
    asteroidBoomBeat: 2.7,
    death: 2.3,
    bassHit: 0.7,
    bassEcho: 1.4,
    bell: 1.7,
    warble: 0.8,
    comboTick: 0.15,
    comboSparkle: 0.4,
    tink: 0.6,
    crystalShatterLarge: 3.9,
    crystalShatterSmall: 2.7,
    scoreBlip: 0.6,
    summaryDownbeat: 1.6,
    summaryDownbeatDucked: 1.6,
    shieldPop: 0.5,
    // the whole bus is at -80 dB by 4.5s even though the oscillators run 20s
    pulsarHum: 5.0,
    shockwaveCharge: 12.2,
    shockwaveBoom: 3.4,
    // the guitar sample stretches to ~6s at the medium alien's C2 rate
    alienFireBig: 2.2,
    alienFireMedium: 6.3,
    alienFireSmall: 0.3,
    alienHit: 0.3,
    alienExplode: 2.9,
    meteorShower: 2.6,
    gemSwarm: 1.5,
    canisterAppear: 1.3,
    canisterDestroyed: 1.25,
    comboLost: 0.55,
    comboLostFire: 0.45,
    bossPulse: 0.65,
    bossHit: 0.55,
    bossEyeOpenStinger: 1.25,
    driftShotHit: 1.9,
    laserCharge: 0.6,
    laserChargeFail: 0.35,
    comboChime: 5.3,
  };

  // One-shots whose graph holds a stereo node and so must render in a
  // 2-channel offline context. Only asteroidBoomBeat qualifies: its
  // ConvolverNode runs a 2-channel IR whose channels are independent noise
  // draws. Every other newly-baked voice is oscillators plus mono noise.
  private static readonly STEREO_BAKES: ReadonlySet<SoundName> = new Set<SoundName>(["asteroidBoomBeat"]);

  // Hardcoded fallbacks for the explosion trio's semantic config block.
  private static readonly EXPLOSION_DEFAULTS: Record<ExplosionName, { volume: number; lowpassStart: number; duration: number }> = {
    explosionLarge: { volume: 0.7, lowpassStart: 160, duration: 0.55 },
    explosionMedium: { volume: 0.55, lowpassStart: 230, duration: 0.42 },
    explosionSmall: { volume: 0.4, lowpassStart: 340, duration: 0.3 },
  };

  // Shots per big/medium alien riff cycle, and the four distinct renders that
  // cycle actually contains: the sample flips at the halfway point and the
  // riff note alternates every shot, so step → (note bit, sample bit).
  private static readonly ALIEN_FIRE_CYCLE = 8;
  private static alienFireVariant(step: number): number {
    return (step % 2) + (step < Sound.ALIEN_FIRE_CYCLE / 2 ? 0 : 2);
  }

  // Snap a periodic rate to a whole number of cycles per loopLen. EVERY
  // oscillator and LFO baked into a loop must land exactly back on its
  // starting phase at the seam or the buffer clicks when it repeats — the
  // loop lengths here were originally chosen for the LFOs only, which left
  // the audio-rate oscillators mid-cycle at the seam. The nudge is at most
  // 1/(2·loopLen) Hz; detune pairs snapped to the same grid keep beating,
  // with the beat cycle itself completing whole cycles per loop.
  private static snapToLoop(freqHz: number, loopLen: number): number {
    return Math.round(freqHz * loopLen) / loopLen;
  }

  // Wrap a baked drone loop in a source that loops the interior seamless
  // window (see LOOP_BAKE_PAD). Callers should start playback at
  // `startOffset` so the smeared mp3 head never sounds. Buffers shorter
  // than a padded render (stale pre-padding mp3s) fall back to whole-buffer
  // looping rather than looping a truncated window.
  private makeBakedLoopSource(buf: AudioBuffer, loopLen: number): { src: AudioBufferSourceNode; startOffset: number } {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const pad = Sound.LOOP_BAKE_PAD;
    if (buf.duration >= loopLen + pad * 1.5) {
      src.loopStart = pad;
      src.loopEnd = pad + loopLen;
      return { src, startOffset: pad };
    }
    return { src, startOffset: 0 };
  }

  // Play a pre-rendered buffer through the live master bus. Returns true if
  // a baked buffer was found and played; false if the caller should fall
  // back to live synthesis (typically while the first bake is still running).
  private playBaked(name: SoundName, pitchRatio: number, playbackRate = 1): boolean {
    if (!this.ctx) return false;
    const sink = this.bakedSink(name);
    if (!sink) return false;
    const key = this.bakedKey(name, pitchRatio);
    const buf = this.bakedBuffers.get(key);
    if (buf) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      // Per-play detune (asteroidBoomBeat's ±3% wobble). Left at 1 the source
      // plays at its rendered pitch, so this costs nothing for every other voice.
      if (playbackRate !== 1) src.playbackRate.value = playbackRate;
      const when = this.scheduledWhenForCall;
      const now = this.ctx.currentTime;
      const startAt = when !== null ? Math.max(when, now) : now;
      // Same-sound pileup duck: near-simultaneous copies of one buffer sum
      // almost coherently (a same-frame multi-kill stacks identical
      // waveforms), which is what used to clip the mix. The k-th copy
      // starting within BAKED_RETRIGGER_WINDOW of a burst's first plays at
      // 1/sqrt(k) so the pile gains energy gently instead of linearly.
      const burst = this.bakedBursts.get(key);
      let copies = 1;
      if (burst && Math.abs(startAt - burst.start) <= Sound.BAKED_RETRIGGER_WINDOW) {
        copies = ++burst.count;
      } else {
        this.bakedBursts.set(key, { start: startAt, count: 1 });
      }
      // Positional splice: if play() recorded a pos for this dispatch, route
      // the buffer through the same pan + distance-gain pair we'd use for
      // live voices. Baked buffers don't go through this.master, so we wire
      // them straight into the channel sink.
      let dest: AudioNode = sink;
      const pos = this.spatialPosForCall;
      if (pos) {
        const spatial = this.makeSpatial(pos, sink);
        if (spatial) dest = spatial.panner;
      }
      if (copies > 1) {
        const duck = this.ctx.createGain();
        duck.gain.value = 1 / Math.sqrt(copies);
        duck.connect(dest);
        dest = duck;
      }
      src.connect(dest);
      if (when !== null) {
        // Already-past start times can't sound on time — clamp to "now" so the
        // beat still plays, and surface the deficit in DEV so a frame-cost
        // regression that eats the lookahead budget shows up loudly in the
        // console instead of as subtle audible pulse lag.
        if ((import.meta.env as unknown as { DEV?: boolean })?.DEV && when < now - 0.001) {
          // eslint-disable-next-line no-console
          console.warn(`[pulse-late] ${name} scheduled ${((now - when) * 1000).toFixed(1)}ms in the past`);
        }
        src.start(startAt);
      } else {
        src.start();
      }
      return true;
    }
    // Not cached. Somebody is waiting on this one now, so pull it out of the
    // background queue and load it without pacing; the voice renders live (or
    // silent-misses) this once and hits cache from the next play on.
    this.demandBake(name, pitchRatio);
    return false;
  }

  // Render a single Tone-engine sound recipe into an AudioBuffer. We build
  // the same synth chain (incl. the fx bus + reverb tail) inside an
  // OfflineAudioContext, trigger the voice at t=0, and let it render its
  // full natural decay. Duration is chosen per-sound to fit the longest
  // envelope+release+reverb tail.
  // Registry of the pure-WebAudio one-shot graphs — every voice that is a
  // deterministic function of (name, key) and needs neither Tone nor the
  // reverb bus. Returns a closure that builds the voice at time origin 0 into
  // `dest`, or null when this pair has no offline recipe (Tone-engine voices,
  // the ElevenLabs mp3s, and the seamless drone loops all take other paths).
  //
  // The same builders run live — see each play* wrapper, which falls back to
  // building straight into this.master while the mp3 is still in flight — so
  // there is exactly one definition of each sound and the bake cannot drift
  // away from what the game plays.
  private oneShotGraph(name: SoundName, key: number): ((ctx: BaseAudioContext, dest: AudioNode) => void) | null {
    switch (name) {
      case "cometDestroyed": return (c, d) => this.buildCometDestroyedGraph(c, d);
      case "cometDestroyedSad": return (c, d) => this.buildCometDestroyedSadGraph(c, d);
      case "bonusLife": return (c, d) => this.buildBonusLifeGraph(c, d);
      case "fire": return (c, d) => this.buildFireGraph(c, d, 0);
      case "fireBomb": return (c, d) => this.buildFireBombGraph(c, d, 0);
      case "fireBombBeat": return (c, d) => this.buildFireBombBeatGraph(c, d, 0);
      case "calibrationTap": return (c, d) => this.buildCalibrationTapGraph(c, d, 0);
      case "death": return (c, d) => this.buildDeathGraph(c, d, 0);
      case "bassHit": return (c, d) => this.buildBassHitGraph(c, d, 0);
      case "bassEcho": return (c, d) => this.buildBassEchoGraph(c, d, 0);
      case "comboTick": return (c, d) => this.buildComboTickGraph(c, d, 0);
      case "tink": return (c, d) => this.buildTinkGraph(c, d, 0);
      case "shieldPop": return (c, d) => this.buildShieldPopGraph(c, d, 0);
      case "warble": return (c, d) => this.buildWarbleGraph(c, d, 0);
      case "pulsarHum": return (c, d) => this.buildPulsarHumGraph(c, d, 0);
      case "shockwaveCharge": return (c, d) => this.buildShockwaveChargeGraph(c, d, 0);
      case "shockwaveBoom": return (c, d) => this.buildShockwaveBoomGraph(c, d, 0);
      case "alienFireSmall": return (c, d) => this.buildAlienFireSmallGraph(c, d, 0);
      case "alienHit": return (c, d) => this.buildAlienHitGraph(c, d, 0);
      case "alienExplode": return (c, d) => this.buildAlienExplodeGraph(c, d, 0);
      case "canisterAppear": return (c, d) => this.buildCanisterAppearGraph(c, d, 0);
      case "canisterDestroyed": return (c, d) => this.buildCanisterDestroyedGraph(c, d, 0);
      case "comboLost": return (c, d) => this.buildComboLostGraph(c, d, 0);
      case "comboLostFire": return (c, d) => this.buildComboLostFireGraph(c, d, 0);
      case "bossPulse": return (c, d) => this.buildBossPulseGraph(c, d, 0);
      case "bossHit": return (c, d) => this.buildBossHitGraph(c, d, 0);
      case "bossEyeOpenStinger": return (c, d) => this.buildBossEyeOpenStingerGraph(c, d, 0);
      case "meteorShower": return (c, d) => this.buildMeteorShowerGraph(c, d, 0);
      case "gemSwarm": return (c, d) => this.buildGemSwarmGraph(c, d, 0);
      case "laserChargeFail": return (c, d) => this.buildLaserChargeFailGraph(c, d, 0);
      case "explosionLarge":
      case "explosionMedium":
      case "explosionSmall":
        return (c, d) => this.buildExplosionGraph(c, d, 0, name);
      // Rendered flat; the ±3% per-hit wobble rides as a playbackRate.
      case "asteroidBoomBeat": return (c, d) => this.buildAsteroidBoomBeatGraph(c, d, 0, 1);
      case "bell": return (c, d) => this.buildBellGraph(c, d, 0, key);
      case "scoreBlip": return (c, d) => this.buildScoreBlipGraph(c, d, 0, key);
      case "comboSparkle": return (c, d) => this.buildComboSparkleGraph(c, d, 0, key);
      case "crystalShatterLarge": return (c, d) => this.buildCrystalShatterGraph(c, d, 0, "large", key);
      case "crystalShatterSmall": return (c, d) => this.buildCrystalShatterGraph(c, d, 0, "small", key);
      case "summaryDownbeat": return (c, d) => this.buildSummaryDownbeatGraph(c, d, 0, key, false);
      case "summaryDownbeatDucked": return (c, d) => this.buildSummaryDownbeatGraph(c, d, 0, key, true);
      case "driftShotHit": return (c, d) => this.buildDriftShotHitGraph(c, d, 0, key);
      case "laserCharge": return (c, d) => this.buildLaserChargeGraph(c, d, 0, key);
      // Only the full-length note is baked (durationScale 1); the key is the
      // fundamental in Hz.
      case "comboChime": return (c, d) => this.buildComboChimeGraph(c, d, 0, key, 1);
      case "alienFireBig":
      case "alienFireMedium": {
        // Sample-backed: with no WAV decoded there's nothing to render, and a
        // silent mp3 on disk would permanently mute the voice.
        if (!this.guitarSampleJazz || !this.guitarSampleGretsch) return null;
        return name === "alienFireBig"
          ? (c, d) => this.buildAlienFireBigGraph(c, d, 0, key)
          : (c, d) => this.buildAlienFireMediumGraph(c, d, 0, key);
      }
      default: return null;
    }
  }

  private async bakeSound(name: SoundName, pitchRatio: number): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    if (!(import.meta.env as unknown as { DEV?: boolean })?.DEV) return null;
    const sr = this.ctx.sampleRate;
    const OACearly = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!OACearly) return null;

    // laserShot and streakShimmer are pure-WebAudio one-shots (no Tone, no
    // reverb bus) whose graphs are already a pure function of a small
    // discrete parameter — render them on their own path and skip the Tone
    // fx-bus setup the one-shot recipes need.
    if (name === "laserShot") {
      const tier = Math.max(0, Math.min(4, Math.round(pitchRatio)));
      const len = Math.ceil(sr * this.laserShotBufferLen(tier));
      const offline = new OACearly(1, len, sr);
      this.buildLaserShotGraph(offline, offline.destination, tier);
      return offline.startRendering();
    }
    // thrust/reverseThrust/sideThrust are seamless-loop engine drones (no
    // Tone, no reverb bus, no live modulation): one committed loop each,
    // rendered on their own path like chargeBed.
    if (name === "thrust") {
      const len = Math.ceil(sr * (Sound.THRUST_LOOP_LEN + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(1, len, sr);
      this.buildThrustGraph(offline, offline.destination);
      return offline.startRendering();
    }
    if (name === "reverseThrust") {
      const len = Math.ceil(sr * (Sound.REVERSE_THRUST_LOOP_LEN + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(1, len, sr);
      this.buildReverseThrustGraph(offline, offline.destination);
      return offline.startRendering();
    }
    if (name === "sideThrust") {
      const len = Math.ceil(sr * (Sound.SIDE_THRUST_LOOP_LEN + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(1, len, sr);
      this.buildSideThrustGraph(offline, offline.destination);
      return offline.startRendering();
    }
    if (name === "streakShimmer") {
      const idx = Math.max(0, Math.min(Sound.STREAK_SHIMMER_POOL.length - 1, Math.round(pitchRatio)));
      const len = Math.ceil(sr * Sound.STREAK_SHIMMER_NOTE_SEC);
      const offline = new OACearly(1, len, sr);
      this.buildStreakShimmerNoteGraph(offline, offline.destination, Sound.STREAK_SHIMMER_POOL[idx]);
      const buf = await offline.startRendering();
      // The exponential decay never quite reaches zero — fade the last few
      // ms to true silence so the buffer end can't tick.
      const data = buf.getChannelData(0);
      const fade = Math.min(data.length, Math.floor(sr * 0.05));
      for (let s = 0; s < fade; s++) data[data.length - 1 - s] *= s / fade;
      return buf;
    }

    // chargeBed is a pure-WebAudio seamless loop (no Tone, no reverb bus): one
    // committed mp3 per tier, keyed by pitchRatio = tier. Render it on its own
    // path and skip the Tone fx-bus setup the one-shot recipes need.
    if (name === "chargeBed") {
      const tier = Math.max(0, Math.min(4, Math.round(pitchRatio)));
      const len = Math.ceil(sr * (Sound.CHARGE_LOOP_LEN + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(2, len, sr);
      this.buildChargeBedGraph(offline, offline.destination, tier);
      return offline.startRendering();
    }
    // bassteroidDrone is a pure-WebAudio seamless loop (no Tone, no reverb
    // bus): one committed mp3 per (kind, size) pair, keyed by
    // pitchRatio = kindIndex*2 + sizeIndex (0..7).
    if (name === "bassteroidDrone") {
      const index = Math.max(0, Math.min(7, Math.round(pitchRatio)));
      const kindIndex = Math.floor(index / 2);
      const sizeIndex = index % 2;
      const kind = Sound.BASS_DRONE_KINDS[kindIndex];
      const size = Sound.BASS_DRONE_SIZES[sizeIndex];
      const len = Math.ceil(sr * (Sound.BASS_DRONE_LOOP_LEN[kind] + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(1, len, sr);
      this.buildBassteroidDroneGraph(offline, offline.destination, kind, size);
      return offline.startRendering();
    }
    // alienDrone is a pure-WebAudio seamless loop (no Tone, no reverb bus):
    // one committed mp3 per size, keyed by pitchRatio = size index
    // (0=big, 1=medium, 2=small).
    if (name === "alienDrone") {
      const index = Math.max(0, Math.min(Sound.ALIEN_DRONE_SIZES.length - 1, Math.round(pitchRatio)));
      const size = Sound.ALIEN_DRONE_SIZES[index];
      const len = Math.ceil(sr * (Sound.ALIEN_DRONE_LOOP_LEN + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(1, len, sr);
      this.buildAlienDroneGraph(offline, offline.destination, size);
      return offline.startRendering();
    }
    // firstDotHum is a pure-WebAudio seamless loop (no Tone, no reverb bus):
    // one committed mp3 per hum instance (the drone TONE only — filter,
    // pulseGain and mainGain stay live), keyed by pitchRatio = hum index
    // (0..8, see FIRST_DOT_HUM_PITCH).
    if (name === "firstDotHum") {
      const index = Math.max(0, Math.min(Sound.FIRST_DOT_HUM_PITCH.length - 1, Math.round(pitchRatio)));
      const len = Math.ceil(sr * (Sound.FIRST_DOT_HUM_LOOP_LEN + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(1, len, sr);
      this.buildFirstDotHumGraph(offline, offline.destination, index);
      return offline.startRendering();
    }
    // warbleDrone is a pure-WebAudio seamless loop (no Tone, no reverb bus):
    // one committed mp3 per morph endpoint, keyed by pitchRatio = phaseState
    // (0=phased-in, 1=phased-out). setWarbleDronePhase crossfades live
    // between the two loops for the continuous ghost01 in between.
    if (name === "warbleDrone") {
      const phaseState = Math.max(0, Math.min(1, Math.round(pitchRatio))) as 0 | 1;
      const len = Math.ceil(sr * (Sound.WARBLE_DRONE_LOOP_LEN[phaseState] + 2 * Sound.LOOP_BAKE_PAD));
      const offline = new OACearly(1, len, sr);
      this.buildWarbleDroneGraph(offline, offline.destination, phaseState);
      return offline.startRendering();
    }
    // Every pure-WebAudio one-shot (no Tone, no reverb bus) renders through
    // one path: look the graph builder up in the registry, run it at time
    // origin 0 into the render's destination, done. Nothing of the master
    // chain goes into the file — the buffer plays back through this.master,
    // the same compressor + limiter the live fallback of this very graph
    // runs through, so the two legs are the same signal by construction.
    // Baking the dynamics in instead made the file a snapshot of one voice
    // compressed alone, which is a mix, and a mix cannot be pre-rendered.
    // The two sampled-guitar alien voices can't render until their WAV is
    // decoded — wait for it rather than baking silence.
    if ((name === "alienFireBig" || name === "alienFireMedium") && !this.guitarSampleJazz) {
      await this.loadGuitarSample();
    }
    const oneShot = this.oneShotGraph(name, pitchRatio);
    if (oneShot) {
      const len = Math.ceil(sr * (Sound.ONE_SHOT_BAKE_LEN[name] ?? 1.5));
      // Mono unless the graph contains a genuinely stereo node. A 1-channel
      // render downmixes such a node to 0.5·(L+R), which for the decorrelated
      // noise in a reverb IR costs ~3 dB of wet level and all of the width —
      // the live path plays it into a stereo destination and keeps both.
      const channels = Sound.STEREO_BAKES.has(name) ? 2 : 1;
      const offline = new OACearly(channels, len, sr);
      oneShot(offline, offline.destination);
      return offline.startRendering();
    }

    const Tone = await loadTone();
    // Total duration to render. Longer than the dry note so the reverb tail
    // (1.5s decay in the bus) lands inside the buffer.
    const durations: Partial<Record<SoundName, number>> = {
      fireBeat: 1.0,
      bgBeat: 1.2,
      bassKick: 1.2,
      bassBoom: 1.4,
      bassPluck: 1.2,
      bassSnap: 0.9,
      chime: 2.0,
      // drainChime: long hum decay + reverb tail; higher harmonics just
      // carry trailing silence, which VBR mp3 compresses to almost nothing.
      drainChime: 7.0,
      powerup: 1.6,
      waveClear: 2.4,
      // cometNote: longest decay (downbeat "1n" + 3.4s release) is ~4.4s + reverb tail.
      cometNote: 5.0,
    };
    const dur = durations[name] ?? 1.5;
    const length = Math.ceil(sr * dur);
    const OAC = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!OAC) return null;
    const offline = new OAC(2, length, sr);

    // Mirror the live tone-engine fx bus into the offline context. This is
    // a stripped-down copy of ensureToneEngine — same chain (compressor +
    // limiter + chorus + reverb) so the baked tail matches the live mix.
    Tone.setContext(offline as unknown as BaseAudioContext as never);
    const toneMaster = new Tone.Gain(0.7);
    const compressor = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.01, release: 0.18, knee: 12 });
    const limiter = new Tone.Limiter(-1);
    toneMaster.connect(compressor);
    compressor.connect(limiter);
    limiter.toDestination();
    const reverbSend = new Tone.Gain(0.5);
    const chorus = new Tone.Chorus({ frequency: 0.6, delayTime: 3.5, depth: 0.6, type: "sine", spread: 180, wet: 0.5 }).start();
    const reverb = new Tone.Reverb({ decay: 1.5, preDelay: 0.02, wet: 1 });
    reverbSend.connect(chorus);
    chorus.connect(reverb);
    reverb.connect(toneMaster);
    // Pre-generate the reverb IR — required before rendering.
    await reverb.generate();

    const wire = <T extends Tone.ToneAudioNode>(node: T, dry: number, wet: number): T => {
      const d = new Tone.Gain(dry); const w = new Tone.Gain(wet);
      node.connect(d); node.connect(w);
      d.connect(toneMaster); w.connect(reverbSend);
      return node;
    };

    // Per-sound recipe: build synth, trigger at offline time 0.
    switch (name) {
      case "fireBeat": {
        const body = wire(new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 3, oscillator: { type: "sine" }, envelope: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.25 }, volume: -8 }), 1, 0.18);
        const pluck = wire(new Tone.PluckSynth({ attackNoise: 0.9, dampening: 3200, resonance: 0.7, volume: -16 }), 1, 0.25);
        body.triggerAttackRelease("C3", "16n", 0, 0.9);
        pluck.triggerAttack("G4", 0.001);
        break;
      }
      case "bgBeat": {
        // The composite key is `actualPitch * 100 + intensityBucket`, with a
        // +1000 offset added when this is a doubletime "light eighth" variant
        // (see playBgBeatLight). Decode:
        const isLight = pitchRatio >= 500;
        const baseKey = isLight ? pitchRatio - 1000 : pitchRatio;
        const intensity = baseKey - Math.floor(baseKey);
        const actualPitch = Math.floor(baseKey) / 100;
        const kick = wire(new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 8, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.6, sustain: 0, release: 0.6 }, volume: 3 }), 1, 0.1);
        const isOffbeat = actualPitch !== 1;
        const offbeatMul = isOffbeat ? 0.35 + intensity * 0.45 : 1;
        const lightMul = isLight ? 0.42 : 1;
        const levelMul = (0.35 + 0.65 * intensity) * offbeatMul * lightMul;
        const velocity = (0.25 + intensity * 0.75) * levelMul;
        // Light eighths are pitched a semitone up so they sit between the
        // main quarter-note pitches: A0 → A#0, B0 → C1.
        const note = isLight
          ? (actualPitch === 1 ? "A#0" : "C1")
          : (actualPitch === 1 ? "A0" : "B0");
        kick.triggerAttackRelease(note, "8n", 0, velocity);
        // The deep kick's energy lands well after sample 0 (all of it in
        // sub-bass, where the ear localizes onsets poorly), so the pulse reads
        // as slightly late vs the beat it's scheduled on. A short bandpassed
        // noise transient at t=0 gives the ear a crisp onset to lock to while
        // the kick keeps the weight — same trick fireBeat uses with its pluck.
        // Scaled by levelMul so soft beats get a soft tick, not a fixed click.
        // Set bgBeat.tickPeak to 0 in /sounds/config.json to A/B the tickless pulse.
        const tickPeak = cfgN("bgBeat", "tickPeak", 0.12);
        if (tickPeak > 0 && !isLight) {
          const tickHz = cfgN("bgBeat", "tickHz", 1800);
          const tickQ = cfgN("bgBeat", "tickQ", 1.4);
          const tick = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.0005, decay: 0.006, sustain: 0, release: 0.01 } });
          const tickFilter = new Tone.Filter({ type: "bandpass", frequency: tickHz, Q: tickQ });
          const tickGain = new Tone.Gain(tickPeak * levelMul);
          tick.connect(tickFilter);
          tickFilter.connect(tickGain);
          tickGain.connect(toneMaster);
          tickGain.connect(reverbSend);
          tick.triggerAttackRelease(0.006, 0);
        }
        break;
      }
      case "bassKick": {
        // Tuned 808-style kick on C2: a long pitch sweep gives the body a
        // round "dunk", and a tight bandpassed-noise click at t=0 gives the
        // attack a hard transient — so it punches rather than reading as the
        // soft sub-thump of bgBeat/fireBeat. A sub-octave sine adds weight
        // under the body without muddying the click.
        const kick = wire(new Tone.MembraneSynth({ pitchDecay: 0.09, octaves: 6, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.34 }, volume: -3 }), 1, 0.16);
        kick.triggerAttackRelease(65.4 * pitchRatio, "16n", 0, 1.0);
        const kickSub = new Tone.Oscillator({ type: "sine", frequency: 32.7 * pitchRatio }).start(0);
        const kickSubEnv = new Tone.Gain(0);
        kickSub.connect(kickSubEnv);
        kickSubEnv.connect(toneMaster);
        kickSubEnv.gain.setValueAtTime(0.0001, 0);
        kickSubEnv.gain.linearRampToValueAtTime(0.32, 0.004);
        kickSubEnv.gain.exponentialRampToValueAtTime(0.0001, 0.18);
        kickSub.stop(0.2);
        const click = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.0004, decay: 0.012, sustain: 0, release: 0.02 } });
        const clickFilter = new Tone.Filter({ type: "bandpass", frequency: 2600, Q: 1.1 });
        const clickGain = new Tone.Gain(0.22);
        click.connect(clickFilter); clickFilter.connect(clickGain);
        clickGain.connect(toneMaster); clickGain.connect(reverbSend);
        click.triggerAttackRelease(0.012, 0);
        break;
      }
      case "bassBoom": {
        // Cavernous detonation on F2: the sine body sweeps slowly downward
        // for a falling "whoomph", an F1 sub layer fattens the floor, and a
        // bandpassed-noise "stone clack" gives a gritty attack — so it reads
        // as a heavy impact, clearly distinct from the tight punch of the
        // kick and the soft thump of the basic beat.
        const boom = wire(new Tone.MembraneSynth({ pitchDecay: 0.16, octaves: 7, oscillator: { type: "sine" }, envelope: { attack: 0.003, decay: 0.55, sustain: 0, release: 0.5 }, volume: -3 }), 1, 0.22);
        boom.triggerAttackRelease(87.3 * pitchRatio, "8n", 0, 0.95);
        const boomSub = new Tone.Oscillator({ type: "sine", frequency: 43.65 * pitchRatio }).start(0);
        const boomSubEnv = new Tone.Gain(0);
        boomSub.connect(boomSubEnv);
        boomSubEnv.connect(toneMaster);
        boomSubEnv.gain.setValueAtTime(0.0001, 0);
        boomSubEnv.gain.linearRampToValueAtTime(0.45, 0.006);
        boomSubEnv.gain.exponentialRampToValueAtTime(0.0001, 0.4);
        boomSub.stop(0.44);
        const clack = new Tone.NoiseSynth({ noise: { type: "brown" }, envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.06 } });
        const clackFilter = new Tone.Filter({ type: "bandpass", frequency: 320, Q: 0.9 });
        const clackGain = new Tone.Gain(0.4);
        clack.connect(clackFilter); clackFilter.connect(clackGain);
        clackGain.connect(toneMaster); clackGain.connect(reverbSend);
        clack.triggerAttackRelease(0.05, 0);
        break;
      }
      case "bassPluck": {
        // Rubber-band twang on G2: a resonant lowpass that snaps wide open
        // then clamps shut gives a vocal "bwong", and a quick downward pitch
        // bend on the resonant peak reads as a string being plucked and
        // released. The higher filter Q and wider sweep push it well past a
        // plain saw blip so it stays a distinct voice, not a beat.
        const pluck = wire(new Tone.MonoSynth({ oscillator: { type: "sawtooth" }, filter: { Q: 9, type: "lowpass", rolloff: -24 }, envelope: { attack: 0.004, decay: 0.22, sustain: 0, release: 0.28 }, filterEnvelope: { attack: 0.004, decay: 0.22, sustain: 0.08, release: 0.32, baseFrequency: 70, octaves: 4.2 }, volume: -7 }), 1, 0.18);
        pluck.triggerAttackRelease(98 * pitchRatio, "8n", 0, 0.9);
        break;
      }
      case "bassSnap": {
        const snap = wire(new Tone.MetalSynth({ envelope: { attack: 0.001, decay: 0.12, release: 0.15 }, harmonicity: 5.1, modulationIndex: 16, resonance: 1700, octaves: 0.7, volume: -16 }), 1, 0.25);
        snap.triggerAttackRelease("C3", "16n", 0, 0.7);
        break;
      }
      case "chime": {
        const chime = wire(new Tone.PolySynth(Tone.FMSynth, { harmonicity: 3.5, modulationIndex: 8, oscillator: { type: "sine" }, envelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.9 }, modulationEnvelope: { attack: 0.005, decay: 0.3, sustain: 0, release: 0.6 }, volume: -12 }), 0.6, 0.7);
        chime.triggerAttackRelease(["C6", "G6"], "8n", 0, 0.65);
        break;
      }
      case "drainChime": {
        // pitchRatio selects the harmonic over A3 — one true-pitch baked
        // variant per harmonic, so each chime keeps its full natural tail.
        const h = Math.max(1, Math.round(pitchRatio));
        const f0 = 220 * h;
        // higher chimes ring shorter and softer
        const tailScale = Math.pow(h, -0.3);
        const loudScale = Math.pow(h, -0.25);
        // Glassy hum: a detuned unison pair (fixed-Hz offset so the beat
        //   stays slow at every harmonic) over pure integer partials — no
        //   clang ratios, nothing below the root, so the tail hums clean.
        const partials = [
          { freq: f0 - 0.7, peak: 0.085, decay: 5.0 },
          { freq: f0 + 0.7, peak: 0.085, decay: 5.0 },
          { freq: f0 * 2, peak: 0.05, decay: 3.6 },
          { freq: f0 * 3, peak: 0.026, decay: 2.4 },
          { freq: f0 * 4, peak: 0.013, decay: 1.6 },
        ];
        for (const { freq, peak, decay } of partials) {
          const osc = new Tone.Oscillator({ type: "sine", frequency: freq }).start(0);
          const env = new Tone.Gain(0);
          const wet = new Tone.Gain(0.55);
          osc.connect(env);
          env.connect(toneMaster);
          env.connect(wet);
          wet.connect(reverbSend);
          const tail = decay * tailScale;
          env.gain.setValueAtTime(0.0001, 0);
          env.gain.linearRampToValueAtTime(peak * loudScale, 0.03);
          env.gain.exponentialRampToValueAtTime(0.0001, tail);
          osc.stop(tail + 0.1);
        }
        // Faint glass tap so the onset lands on the grid without reading
        //   as struck metal — the hum is the voice, not the strike.
        const tap = wire(new Tone.FMSynth({ harmonicity: 1, modulationIndex: 2.5, oscillator: { type: "sine" }, envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.08 }, modulationEnvelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.04 }, volume: -26 }), 0.7, 0.6);
        tap.triggerAttackRelease(f0, "32n", 0, 0.4);
        break;
      }
      case "powerup": {
        const synth = wire(new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.45 }, volume: -10 }), 0.5, 0.7);
        const notes = ["C5", "E5", "G5", "C6"];
        for (let i = 0; i < notes.length; i++) synth.triggerAttackRelease(notes[i], "16n", i * 0.06, 0.7);
        break;
      }
      case "waveClear": {
        const synth = wire(new Tone.PolySynth(Tone.Synth, { oscillator: { type: "sine" }, envelope: { attack: 0.02, decay: 0.3, sustain: 0.2, release: 0.7 }, volume: -10 }), 0.5, 0.7);
        const notes = ["E4", "G#4", "B4", "Eb5"];
        for (let i = 0; i < notes.length; i++) synth.triggerAttackRelease(notes[i], "4n", i * 0.06, 0.7);
        break;
      }
      case "cometNote": {
        // pitchRatio encodes the melody index (0..7, skipping the rest at 5).
        // Mirror the live cometMelodySynth recipe + per-idx velocity/duration
        // shaping from playCometNote so the baked clip is bit-identical.
        const idx = Math.round(pitchRatio);
        const freq = Sound.COMET_MELODY[idx];
        if (freq === null || freq === undefined) {
          Tone.setContext(this.ctx as unknown as BaseAudioContext as never);
          return null;
        }
        const isPhraseDownbeat = idx === 0 || idx === 4;
        const isLift = idx === 3;
        const isGrace = idx === 7;
        const velocity = isPhraseDownbeat ? 0.7 : isLift ? 0.64 : isGrace ? 0.3 : 0.5;
        const duration = isPhraseDownbeat || isLift ? "1n" : isGrace ? "4n" : "2n";
        const synth = new Tone.PolySynth(Tone.FMSynth, {
          harmonicity: 2.41,
          modulationIndex: 11,
          oscillator: { type: "sine" },
          modulation: { type: "sawtooth" },
          envelope: { attack: 0.05, decay: 0.6, sustain: 0.35, release: 3.4 },
          modulationEnvelope: { attack: 0.04, decay: 0.5, sustain: 0.1, release: 2.0 },
          volume: -12,
        });
        const dryG = new Tone.Gain(0.35);
        const wetG = new Tone.Gain(0.9);
        synth.connect(dryG); synth.connect(wetG);
        dryG.connect(toneMaster); wetG.connect(reverbSend);
        synth.triggerAttackRelease(freq, duration, 0, velocity);
        break;
      }
      default:
        // Restore live context before bailing.
        Tone.setContext(this.ctx as unknown as BaseAudioContext as never);
        return null;
    }

    try {
      const rendered = await offline.startRendering();
      return rendered;
    } finally {
      // Always swap Tone back to the live AudioContext, even if rendering throws.
      Tone.setContext(this.ctx as unknown as BaseAudioContext as never);
    }
  }

  // Resume (and, on first call, create) the AudioContext. MUST be invoked from
  //   inside a user gesture. ctx.resume() returns a promise and the context is
  //   NOT reliably "running" the instant it resolves — on some browsers the
  //   first gesture leaves it stuck in "suspended" until a second nudge, which
  //   is why sound "sometimes doesn't work until you reload". We await the
  //   resume and retry a few times until the state actually flips to "running",
  //   so callers that await this (the start gate) never schedule into a dead
  //   context. Fire-and-forget callers still benefit from the retry.
  async resume(): Promise<void> {
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx) return;
    const isRunning = () => (ctx.state as string) === "running";
    for (let attempt = 0; attempt < 5 && !isRunning(); attempt++) {
      try {
        await ctx.resume();
      } catch {
        // resume() can reject if called outside a gesture or mid-teardown;
        //   the loop's state re-check decides whether another try is worth it.
      }
      if (isRunning()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Audio-clock "now" in seconds. The latency calibrator reads this the instant a
  //   key is pressed and compares it to the scheduled click times — the difference
  //   is the player's timing offset, which includes output (speaker/Bluetooth)
  //   latency. ensureContext so the very first read (inside the Begin gesture)
  //   creates + unlocks the context.
  currentAudioTime(): number {
    this.ensureContext();
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // Audio-clock "now" ONLY while the context is actively running; null when there's no context
  // yet or it's suspended (before the first user gesture / tab blur). Deliberately does NOT call
  // ensureContext so reading it can't create a context before the unlock gesture. The main loop
  // anchors the sim clock to this so beatTime — and the on-beat hum/bass scheduling that rides it
  // — can't slowly drift away from the looping music, which runs on this same hardware clock.
  runningAudioTime(): number | null {
    return this.ctx && this.ctx.state === "running" ? this.ctx.currentTime : null;
  }

  // Fill the master-bus FFT into the reused buffer and hand it back, or null
  // when there's no running context. Bytes are 0..255 per frequency bin
  // (bin 0 ≈ DC/sub-bass, last bin ≈ Nyquist/22kHz). The visualizer owns the
  // bin→bar mapping; here we just read once per frame, no allocation.
  readSpectrum(): Uint8Array<ArrayBuffer> | null {
    if (!this.masterAnalyser || !this.analyserBins) return null;
    if (!this.ctx || this.ctx.state !== "running") return null;
    this.masterAnalyser.getByteFrequencyData(this.analyserBins);
    return this.analyserBins;
  }

  // Master-bus time-domain waveform into the reused buffer, or null when there's
  // no running context. Bytes are 0..255 centered on 128 (silence). One read per
  // frame, no allocation — feeds the oscilloscope visualizer modes.
  readWaveform(): Uint8Array<ArrayBuffer> | null {
    if (!this.masterAnalyser || !this.analyserWave) return null;
    if (!this.ctx || this.ctx.state !== "running") return null;
    this.masterAnalyser.getByteTimeDomainData(this.analyserWave);
    return this.analyserWave;
  }

  // Authoritative beat-time derived from the music's actual playback position
  // on the audio hardware clock. Returns null when no halo music is active,
  // when the buffer hasn't actually started (measure-align delay), or when
  // playbackRate isn't 1 (slow-mo ramps have their own audible easing — we
  // don't try to second-guess them here).
  audioBeatTimeFromMusic(): number | null {
    if (!this.haloMusic || !this.ctx) return null;
    if (this.haloMusic.currentPlaybackRate !== 1) return null;
    const elapsed = this.ctx.currentTime - this.haloMusic.startedAtAudioTime;
    if (elapsed < 0) return null;
    return this.haloMusic.startedAtBeatTime + elapsed;
  }

  // Convert a beat-time delta (seconds of beatTime ahead of "now") into an
  // absolute audio-clock start time. beatTime advances in music-seconds, which
  // run at `playbackRate` of wall-clock under slow-mo, so a beatDelta maps to
  // beatDelta / playbackRate audio-seconds. Returns null when the audio clock
  // isn't running yet (pre-unlock / suspended) — caller falls back to immediate.
  audioTimeForBeatDelta(beatDelta: number, playbackRate: number): number | null {
    const now = this.runningAudioTime();
    if (now === null) return null;
    const rate = playbackRate > 0 ? playbackRate : 1;
    return now + beatDelta / rate;
  }

  // Slow-mo: gameplay clock advances at SLOW_MO_FACTOR, so we match the
  // music playbackRate to keep them locked (pitch-shifts the stems down,
  // which reads as "world slowing into molasses").
  setHaloMusicPlaybackRate(rate: number, rampSec: number = 0): void {
    this.currentMusicPlaybackRate = rate;
    if (!this.haloMusic || !this.ctx) return;
    const now = this.ctx.currentTime;
    const srcs: AudioBufferSourceNode[] = [
      this.haloMusic.ambientSrc,
      this.haloMusic.melodicSrc,
    ];
    if (this.haloMusic.layer3Src) srcs.push(this.haloMusic.layer3Src);
    for (const src of srcs) {
      src.playbackRate.cancelScheduledValues(now);
      src.playbackRate.setValueAtTime(src.playbackRate.value, now);
      if (rampSec > 0) {
        src.playbackRate.linearRampToValueAtTime(rate, now + rampSec);
      } else {
        src.playbackRate.setValueAtTime(rate, now);
      }
    }
    this.haloMusic.currentPlaybackRate = rate;
  }

  // The calibrator's metronome is the game's own bgBeat pulse, so the screen
  //   feels like the run is already easing in rather than a separate UI bleep.
  //   A clearly-audible intensity (vs the near-silent 0.08 of wave 1) is baked
  //   into the buffer at this bucket.
  private static readonly CALIBRATION_BEAT_INTENSITY = 0.6;

  // Schedule the baked bgBeat at a precise audio-clock time, alternating
  //   downbeat / offbeat pitch like the in-game groove. Returns false if the
  //   buffer is still baking — the calibrator holds the intro until it's ready
  //   so the first beats are steady, not clustered. Routed through the
  //   basePulse channel so the calibration metronome tracks the same slider
  //   the player uses in-game.
  scheduleCalibrationBeat(atTime: number, offbeat: boolean): boolean {
    this.ensureContext();
    if (!this.ctx || !this.chBasePulseBaked) return false;
    const pitchRatio = offbeat ? 1.122 : 1;
    const bucket = Math.round(Sound.CALIBRATION_BEAT_INTENSITY * 10) / 10;
    const pitchKey = pitchRatio * 100 + bucket;
    const buf = this.bakedBuffers.get(this.bakedKey("bgBeat", pitchKey));
    if (!buf) { this.queueBake("bgBeat", pitchKey); return false; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.chBasePulseBaked);
    src.start(Math.max(atTime, this.ctx.currentTime));
    return true;
  }

  // Confirmation pluck the calibrator fires on each tap. Same musical shape
  //   as playFire but with an *instant* attack on every component — no 3–4ms
  //   exponential ramp on the body/partial — so the perceived onset coincides
  //   with the keypress and the player can hear the click sync against the beat.
  playCalibrationTap() {
    // No `enabled` gate on purpose: the beat calibrator has to click even
    // when the player has muted the game's sound effects.
    if (this.playBaked("calibrationTap", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildCalibrationTapGraph(this.ctx, this.master, this.voiceTime("calibrationTap"));
  }

  private buildCalibrationTapGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const bodyHz = cfgN("fire", "bodyHz", 392);
    const bodyPeak = cfgN("fire", "bodyPeak", 0.16);
    const bodyDecay = cfgN("fire", "bodyDecay", 0.11);
    const partialHz = cfgN("fire", "partialHz", 784);
    const partialPeak = cfgN("fire", "partialPeak", 0.07);
    const partialDecay = cfgN("fire", "partialDecay", 0.05);
    const tickHz = cfgN("fire", "tickHz", 1600);
    const tickQ = cfgN("fire", "tickQ", 1.2);
    const tickPeak = cfgN("fire", "tickPeak", 0.04);
    const tickDecay = cfgN("fire", "tickDecay", 0.02);

    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = "sine";
    body.frequency.value = bodyHz;
    bodyGain.gain.setValueAtTime(bodyPeak, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + bodyDecay);
    body.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(t);
    body.stop(t + bodyDecay + 0.02);

    const partial = ctx.createOscillator();
    const partialGain = ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = partialHz;
    partialGain.gain.setValueAtTime(partialPeak, t);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t + partialDecay);
    partial.connect(partialGain);
    partialGain.connect(dest);
    partial.start(t);
    partial.stop(t + partialDecay + 0.02);

    const tickBuf = this.noiseBuffer(ctx, Math.max(tickDecay, 0.005));
    if (!tickBuf) return;
    const tick = ctx.createBufferSource();
    tick.buffer = tickBuf;
    const tickFilter = ctx.createBiquadFilter();
    tickFilter.type = "bandpass";
    tickFilter.frequency.value = tickHz;
    tickFilter.Q.value = tickQ;
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(tickPeak, t);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t + tickDecay);
    tick.connect(tickFilter);
    tickFilter.connect(tickGain);
    tickGain.connect(dest);
    tick.start(t);
    tick.stop(t + tickDecay + 0.005);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on && this.thrustNode) this.stopThrust();
    if (!on && this.reverseThrustNode) this.stopReverseThrust();
    if (!on && this.sideThrustNode) this.stopSideThrust();
    if (!on) this.stopAllAlienDrones();
    if (!on) this.stopFirstDotHum();
    if (!on) this.stopFirstDotOctaveHum();
    if (!on) this.stopFirstDotLockHum();
    if (!on) this.stopFirstDotHarmonyHum();
    if (!on) this.stopFirstDotSubHum();
    if (!on) this.stopFirstDotShimmerHum();
    if (!on) this.stopFirstDotNinthHum();
    if (!on) this.stopFirstDotSixthHum();
    if (!on) this.stopFirstDotHaloHum();
    if (!on) this.stopStreakSound();
    if (!on) this.stopAllBassteroidDrones();
    if (!on) this.stopAllCometShimmers();
    if (!on) this.stopHaloAmbient();
    if (!on) this.stopHaloMusic();
  }

  // Replay scrubbing fast-steps the sim through many recorded frames in one
  // render tick to reach a seek target. beginSeekMute gates all sound during
  // that catch-up (so it doesn't fire a burst of replayed audio); endSeekMute
  // restores whatever the enabled state was before. Returns the prior state so
  // the caller can hand it straight back.
  beginSeekMute(): boolean {
    const prior = this.enabled;
    this.setEnabled(false);
    return prior;
  }

  endSeekMute(prior: boolean) {
    this.setEnabled(prior);
  }

  // ── Export capture ─────────────────────────────────────────────────────
  // Third state alongside enabled/disabled: voices compute and schedule
  //   normally, but this.ctx is a CaptureAudioContext (audioCapture.ts) whose
  //   nodes live on an OfflineAudioContext and whose currentTime is the export
  //   clock. The snapshot below holds the live graph for restore. Null when
  //   not capturing.
  private exportRestore: {
    ctx: AudioContext | null;
    master: GainNode | null;
    bakedOut: GainNode | null;
    liveSum: GainNode | null;
    bakedSum: GainNode | null;
    masterAnalyser: AnalyserNode | null;
    analyserBins: Uint8Array<ArrayBuffer> | null;
    analyserWave: Uint8Array<ArrayBuffer> | null;
    chBasePulseLive: GainNode | null;
    chBasePulseBaked: GainNode | null;
    chSfxLive: GainNode | null;
    chSfxBaked: GainNode | null;
    chMusicLive: GainNode | null;
    chMusicBaked: GainNode | null;
    chVocalsLive: GainNode | null;
    chVocalsBaked: GainNode | null;
    enabled: boolean;
    volume: number;
    pauseFadeFactor: number;
  } | null = null;

  get exportCapturing(): boolean {
    return this.exportRestore !== null;
  }

  // Voice fields whose teardown is deferred to a wall-clock setTimeout (hum
  //   releases, streak fades) can still be mid-release when the context swaps;
  //   any later update would "resume" a node that belongs to the other
  //   context, wedging its gain automation. Force-finalize them now: cancel
  //   the pending cleanup, stop the sources shortly after the release tail,
  //   and null the owning fields so the next update builds fresh voices on
  //   the current context.
  private abandonReleasingVoices() {
    const t = this.ctx ? this.ctx.currentTime : 0;
    const stopAt = t + 0.9;
    const hums = [
      this.firstDotHum, this.firstDotOctaveHum, this.firstDotLockHum,
      this.firstDotHarmonyHum, this.firstDotSubHum, this.firstDotShimmerHum,
      this.firstDotNinthHum, this.firstDotSixthHum, this.firstDotHaloHum,
    ];
    for (const node of hums) {
      if (!node) continue;
      if (node.releaseCleanupTimer !== null) clearTimeout(node.releaseCleanupTimer);
      try { node.src.stop(stopAt); } catch {}
    }
    this.firstDotHum = null;
    this.firstDotOctaveHum = null;
    this.firstDotLockHum = null;
    this.firstDotHarmonyHum = null;
    this.firstDotSubHum = null;
    this.firstDotShimmerHum = null;
    this.firstDotNinthHum = null;
    this.firstDotSixthHum = null;
    this.firstDotHaloHum = null;
    if (this.streakShimmer) {
      const node = this.streakShimmer;
      if (node.timer !== null) clearInterval(node.timer);
      if (node.releaseCleanupTimer !== null) clearTimeout(node.releaseCleanupTimer);
      try { node.out.gain.setTargetAtTime(0.0001, t, 0.1); } catch {}
      this.streakShimmer = null;
    }
    if (this.streakLoop) {
      const node = this.streakLoop;
      if (node.releaseCleanupTimer !== null) clearTimeout(node.releaseCleanupTimer);
      for (const src of node.srcs) { try { src.stop(stopAt); } catch {} }
      this.streakLoop = null;
    }
    this.streakSet = null;
  }

  // Silence every persistent voice on the current context and clear the
  //   fields that hold their nodes, so no reference crosses a context swap.
  //   The synchronous stop* paths already null their fields; the timer-based
  //   ones are force-finalized above.
  private stopVoicesForContextSwap() {
    const wasEnabled = this.enabled;
    this.setEnabled(false);
    this.stopHaloFullMusic();
    this.stopLaserCharge();
    this.abandonReleasingVoices();
    // Burst starts are clock readings; the next context's clock starts over.
    this.bakedBursts.clear();
    this.enabled = wasEnabled;
  }

  // Swap the engine onto the capture context. Rebuilds the full mix graph
  //   (compressor + limiter + channel legs at the player's per-channel
  //   volumes) on the offline destination, with the overall volume pinned to
  //   the level the mix is tuned at regardless of the live slider/mute — the
  //   master gain sits ahead of the compressor and limiter, so any other level
  //   renders a differently-squashed mix than the one the game plays.
  beginExportCapture(captureCtx: AudioContext) {
    if (this.exportRestore || !this.ctx) return;
    this.stopVoicesForContextSwap();
    this.exportRestore = {
      ctx: this.ctx,
      master: this.master,
      bakedOut: this.bakedOut,
      liveSum: this.liveSum,
      bakedSum: this.bakedSum,
      masterAnalyser: this.masterAnalyser,
      analyserBins: this.analyserBins,
      analyserWave: this.analyserWave,
      chBasePulseLive: this.chBasePulseLive,
      chBasePulseBaked: this.chBasePulseBaked,
      chSfxLive: this.chSfxLive,
      chSfxBaked: this.chSfxBaked,
      chMusicLive: this.chMusicLive,
      chMusicBaked: this.chMusicBaked,
      chVocalsLive: this.chVocalsLive,
      chVocalsBaked: this.chVocalsBaked,
      enabled: this.enabled,
      volume: this.volume,
      pauseFadeFactor: this.pauseFadeFactor,
    };
    this.ctx = captureCtx;
    this.volume = Sound.DEFAULT_VOLUME;
    this.pauseFadeFactor = 1;
    this.buildMixGraph();
    this.enabled = true;
  }

  // Release everything still sounding INTO the offline graph (so the render
  //   carries clean tails), then restore the live graph exactly as saved.
  endExportCapture() {
    const saved = this.exportRestore;
    if (!saved) return;
    this.stopVoicesForContextSwap();
    this.exportRestore = null;
    this.ctx = saved.ctx;
    this.master = saved.master;
    this.bakedOut = saved.bakedOut;
    this.liveSum = saved.liveSum;
    this.bakedSum = saved.bakedSum;
    this.masterAnalyser = saved.masterAnalyser;
    this.analyserBins = saved.analyserBins;
    this.analyserWave = saved.analyserWave;
    this.chBasePulseLive = saved.chBasePulseLive;
    this.chBasePulseBaked = saved.chBasePulseBaked;
    this.chSfxLive = saved.chSfxLive;
    this.chSfxBaked = saved.chSfxBaked;
    this.chMusicLive = saved.chMusicLive;
    this.chMusicBaked = saved.chMusicBaked;
    this.chVocalsLive = saved.chVocalsLive;
    this.chVocalsBaked = saved.chVocalsBaked;
    this.volume = saved.volume;
    this.pauseFadeFactor = saved.pauseFadeFactor;
    this.enabled = saved.enabled;
  }

  // Fetch + decode every lazily-loaded voice the sim could reach — halo music
  //   (standard/haunting/boss pools), full-halo songs, Pilot's Log milestones,
  //   and the big-alien guitar sample — and await all of it. Live play spreads
  //   these loads over real wall-clock minutes (preloadHaloMusicSequential's
  //   setTimeout gaps, background fetches players may not even wait out) so a
  //   cache miss just costs one voice a frame of latency. The exporter instead
  //   steps frames as fast as the CPU allows: a miss mid-sweep means the fetch
  //   resolves against a clock.now that has already raced far past the moment
  //   the voice needed to start, so it starts late/misscheduled (an audible
  //   glitch) while the awaited decode work stalls frame production (a visible
  //   slowdown). Called once before the export's frame-stepping loop begins so
  //   every voice the recording touches is already cached.
  async prewarmForExport(): Promise<void> {
    this.ensureContext();
    await this.bakedCacheReady();
    await this.loadAllAssets();
    const haloVariations = new Set<HaloMusicVariation>([
      ...HALO_MUSIC_POOL, ...HAUNTING_MUSIC_POOL, BOSS_MUSIC_VARIATION,
    ]);
    const loads: Promise<unknown>[] = [];
    for (const variation of haloVariations) {
      if (variation === "none") continue;
      loads.push(this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "ambient"), true));
      loads.push(this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "melodic"), true));
      loads.push(this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "layer3"), true));
    }
    for (const song of Object.keys(FULL_HALO_SONGS) as FullHaloSongId[]) {
      for (let i = 1; i <= 6; i++) loads.push(this.loadHaloMusicBuffer(this.haloFullMusicUrl(song, i), true));
    }
    loads.push(this.loadHaloMusicBuffer(Sound.STREAK_LOOP_BASE_URL, true));
    loads.push(this.loadHaloMusicBuffer(Sound.STREAK_LOOP_RISE_URL, true));
    for (const milestone of [6, 12]) {
      for (const url of pilotLogUrlsForIndex(milestone)) loads.push(this.loadPilotLogBuffer(url, true));
    }
    loads.push(this.loadGuitarSample());
    void loadMusicConfig();
    void loadHaloFullConfig();
    await Promise.allSettled(loads);
  }

  // Scales the global summing buses (liveSum for live voices, bakedSum for
  // pre-baked buffers) by the volume multiplier. Per-channel mixers sit
  // upstream, so this slider rides every channel uniformly. v = 0 disables
  // playback so per-voice early-outs gate any in-flight starts; v > 0 re-enables.
  setVolume(v: number) {
    // Export capture pins its own mix; a live slider move mid-export would
    //   write into the offline graph and be lost on restore anyway.
    if (this.exportRestore) return;
    this.volume = Math.max(0, Math.min(2, v));
    if (this.liveSum)  this.liveSum.gain.value  = Sound.MASTER_BASE_GAIN * this.volume * this.pauseFadeFactor;
    if (this.bakedSum) this.bakedSum.gain.value = Sound.BAKED_BASE_GAIN  * this.volume * this.pauseFadeFactor;
    this.setEnabled(this.volume > 0);
  }

  // Live-update a single channel's volume. Both legs (live + baked) are
  // ramped together so a swap mid-frame stays smooth — and to dodge the
  // "exponentialRampToValueAtTime can't hit 0" foot-gun, we use a short
  // linear ramp instead.
  setChannelVolume(channel: AudioChannel, v: number) {
    if (this.exportRestore) return;
    const value = Math.max(0, Math.min(1, v));
    const live = this.channelLeg(channel, "live");
    const baked = this.channelLeg(channel, "baked");
    if (!this.ctx || !live || !baked) return;
    const t = this.ctx.currentTime;
    const ramp = 0.03;
    for (const node of [live, baked]) {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(node.gain.value, t);
      node.gain.linearRampToValueAtTime(value, t + ramp);
    }
  }

  // Ramp the liveSum + bakedSum buses to `target` (0..1) over `duration` seconds.
  // Used to fade audio out on pause and back in on resume without disturbing
  // the player's volume slider. cancelScheduledValues clears any in-flight
  // ramp so back-to-back pause/resume taps don't fight each other.
  fadeForPause(target: number, duration: number) {
    if (this.exportRestore) return;
    this.pauseFadeFactor = Math.max(0, Math.min(1, target));
    if (!this.ctx || !this.liveSum || !this.bakedSum) return;
    const t = this.ctx.currentTime;
    const liveTarget = Sound.MASTER_BASE_GAIN * this.volume * this.pauseFadeFactor;
    const bakedTarget = Sound.BAKED_BASE_GAIN * this.volume * this.pauseFadeFactor;
    for (const node of [this.liveSum, this.bakedSum]) {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(node.gain.value, t);
    }
    this.liveSum.gain.linearRampToValueAtTime(liveTarget, t + duration);
    this.bakedSum.gain.linearRampToValueAtTime(bakedTarget, t + duration);
  }

  // Carrier frequencies — A minor pentatonic-ish so multiple drones layer
  // without dissonance: big=A2 (110), medium=E3 (165), small=A3 (220).
  private static readonly ALIEN_DRONE_SIZES: Array<"big" | "medium" | "small"> = ["big", "medium", "small"];
  private static readonly ALIEN_DRONE_BASE_FREQ: Record<"big" | "medium" | "small", number> = {
    big: 110, medium: 165, small: 220,
  };
  // Lowpass cutoff per size — keeps the sines from sounding sterile and
  // gives the bigger sizes a darker tone.
  private static readonly ALIEN_DRONE_FILTER_FREQ: Record<"big" | "medium" | "small", number> = {
    big: 380, medium: 560, small: 820,
  };
  // Headroom scale rendered into each loop's PCM — the detuned pair beats
  // to twice a single sine, so the raw graph exceeds full scale and
  // encodeWav's 16-bit clamp would hard-clip it into a buzz. Playback
  // divides this back out (startAlienDrone) so loudness is unchanged.
  private static readonly ALIEN_DRONE_BAKE_TRIM = 0.3;
  // Per-size base loudness. Big saucers are quieter on a per-voice basis
  // because the sub frequency takes up more sonic real estate; small
  // saucers can be a touch louder without crowding.
  private static readonly ALIEN_DRONE_PEAK: Record<"big" | "medium" | "small", number> = {
    big: 0.11, medium: 0.09, small: 0.08,
  };
  // Seamless-loop length (s), shared by all three sizes. A whole number of
  // seconds so the integer-Hz carriers (110/165/220) land exactly on their
  // starting phase at the seam; every other rate in the graph (detuned
  // partner, vibrato, pulse LFO) is snapped to whole cycles per loop by
  // snapToLoop inside buildAlienDroneGraph.
  private static readonly ALIEN_DRONE_LOOP_LEN = 7.0;
  private static readonly ALIEN_DRONE_VIBRATO_RATE: Record<"big" | "medium" | "small", number> = {
    big: 1.82, medium: 2.38, small: 3.22,
  };

  // Encode size into the single pitchRatio slot bakedKey offers.
  private static alienDroneIndex(size: "big" | "medium" | "small"): number {
    return Sound.ALIEN_DRONE_SIZES.indexOf(size);
  }

  // Renders one seamless alien-drone loop for `size` into `ctx`. Exact
  // original synthesis graph (two detuned sines through a vibrato LFO into
  // a lowpass into a pulsing amplitude LFO), minus the live per-frame state
  // (there was none — spatial pan is the only thing that was ever live, and
  // that lives outside this graph). Nothing here reads live state, so it
  // renders identically every time.
  private buildAlienDroneGraph(ctx: BaseAudioContext, dest: AudioNode, size: "big" | "medium" | "small") {
    const len = Sound.ALIEN_DRONE_LOOP_LEN;
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const baseFreq = Sound.ALIEN_DRONE_BASE_FREQ[size];
    // Detune just enough for the slow-beating "wobbly sine" theremin feel.
    const detuneRatio = 1.006;

    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.type = "sine";
    oscB.type = "sine";
    oscA.frequency.value = Sound.snapToLoop(baseFreq, len);
    oscB.frequency.value = Sound.snapToLoop(baseFreq * detuneRatio, len);

    // Vibrato LFO — slow pitch bend that gives the drone its theremin-y
    // hand-wobble quality. Routed to both oscillator frequencies.
    const vibratoLfo = ctx.createOscillator();
    vibratoLfo.type = "sine";
    vibratoLfo.frequency.value = Sound.snapToLoop(Sound.ALIEN_DRONE_VIBRATO_RATE[size], len);
    const vibratoDepth = ctx.createGain();
    vibratoDepth.gain.value = baseFreq * 0.012;
    vibratoLfo.connect(vibratoDepth);
    vibratoDepth.connect(oscA.frequency);
    vibratoDepth.connect(oscB.frequency);

    // Pulse LFO — slow amplitude swell so the drone reads as "pulsing
    // softly" rather than a flat sustain. Maps to (0..1) on the pulse gain.
    const pulseLfo = ctx.createOscillator();
    pulseLfo.type = "sine";
    pulseLfo.frequency.value = Sound.snapToLoop(0.7, len);
    const pulseGain = ctx.createGain();
    // Pulse depth ≈ 0.5 → audible swell without going silent at trough.
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.5;
    pulseLfo.connect(pulseDepth);
    pulseDepth.connect(pulseGain.gain);
    pulseGain.gain.value = 0.5; // bias so depth swings 0..1

    // Lowpass with mid-Q for a softer voice-like character.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 3;
    filter.frequency.value = Sound.ALIEN_DRONE_FILTER_FREQ[size];

    const trim = ctx.createGain();
    trim.gain.value = Sound.ALIEN_DRONE_BAKE_TRIM;
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(pulseGain);
    pulseGain.connect(trim);
    trim.connect(dest);

    oscA.start(0);
    oscB.start(0);
    pulseLfo.start(0);
    vibratoLfo.start(0);
    oscA.stop(renderLen);
    oscB.stop(renderLen);
    pulseLfo.stop(renderLen);
    vibratoLfo.stop(renderLen);
  }

  // Warm all 3 committed alien-drone loops (big/medium/small).
  private prerenderAlienDrones() {
    for (let i = 0; i < Sound.ALIEN_DRONE_SIZES.length; i++) {
      this.demandBake("alienDrone", i);
    }
  }

  // Start a continuous theremin-ish drone for an alien. The `key` is the
  // Alien instance (or any unique object) used to look up the drone when
  // it's time to stop it. Carrier frequency depends on size — bigger
  // saucers sit deeper in the mix so multiple aliens read as a chord
  // rather than a single wall of sound.
  startAlienDrone(key: object, size: "big" | "medium" | "small", pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.alienDrones.has(key)) return;
    const index = Sound.alienDroneIndex(size);
    const buf = this.bakedBuffers.get(this.bakedKey("alienDrone", index));
    if (!buf) {
      // Bake hasn't landed yet (or failed) — kick it for next time and bail.
      this.prerenderAlienDrones();
      return;
    }
    const t = this.ctx.currentTime;
    const spatial = pos ? this.makeSpatial(pos, this.master) : null;
    const sink: AudioNode = spatial ? spatial.panner : this.master;

    const { src, startOffset } = this.makeBakedLoopSource(buf, Sound.ALIEN_DRONE_LOOP_LEN);

    const peak = Sound.ALIEN_DRONE_PEAK[size] / Sound.ALIEN_DRONE_BAKE_TRIM;
    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(peak, t + 0.6);

    src.connect(mainGain);
    mainGain.connect(sink);
    src.start(t, startOffset);

    this.alienDrones.set(key, { src, mainGain, spatial: spatial ?? undefined });
  }

  updateAlienDrone(key: object, pos: Pos) {
    const node = this.alienDrones.get(key);
    if (!node || !node.spatial) return;
    this.updateSpatial(node.spatial, pos);
  }

  stopAlienDrone(key: object) {
    if (!this.ctx) return;
    const node = this.alienDrones.get(key);
    if (!node) return;
    const t = this.ctx.currentTime;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    node.src.stop(t + 0.22);
    this.alienDrones.delete(key);
  }

  stopAllAlienDrones() {
    for (const key of Array.from(this.alienDrones.keys())) this.stopAlienDrone(key);
  }

  // Base pitch for the warble drone — G3, a fifth above C, consonant with
  // the C-rooted bass bed. Shared by both baked endpoint states.
  private static readonly WARBLE_DRONE_BASE_FREQ = 196;
  // Seamless-loop length (s) per endpoint state, index 0=phased-in,
  // 1=phased-out. Both vibrato rates (4Hz phased-in, 11Hz phased-out)
  // complete whole cycles in 4.0s; the carriers and their detuned partners
  // are snapped to whole cycles per loop by snapToLoop inside
  // buildWarbleDroneGraph, so each endpoint tiles without a click. Both
  // endpoints share the length so the live crossfade pair stays phase-locked.
  private static readonly WARBLE_DRONE_LOOP_LEN: [number, number] = [4.0, 4.0];
  private static readonly WARBLE_DRONE_VIBRATO_RATE: [number, number] = [4, 4 + 7];
  // Headroom scale rendered into each loop's PCM — the detuned pair beats
  // to twice a single sine, so the raw graph exceeds full scale and
  // encodeWav's 16-bit clamp would hard-clip it into a buzz. Playback
  // divides this back out (startWarbleDrone) so loudness is unchanged.
  private static readonly WARBLE_DRONE_BAKE_TRIM = 0.3;

  // Renders one endpoint of the warble drone's morph into `ctx`: phaseState
  // 0 = fully phased in (smooth hum), 1 = fully phased out (deep, wide, fast
  // warble). Exact original synthesis graph (two near-unison sines through a
  // vibrato LFO into a lowpass) evaluated at ghost01 = phaseState, since
  // that's the only two states ever baked. Nothing here reads live state, so
  // it renders identically every time.
  private buildWarbleDroneGraph(ctx: BaseAudioContext, dest: AudioNode, phaseState: 0 | 1) {
    const len = Sound.WARBLE_DRONE_LOOP_LEN[phaseState];
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const g = phaseState; // 0 or 1 — the two morph endpoints
    const baseFreq = Sound.WARBLE_DRONE_BASE_FREQ;
    const freq = baseFreq * (1 - 0.12 * g); // dip ~a tone as it ghosts out

    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.type = "sine";
    oscB.type = "sine";
    oscA.frequency.value = Sound.snapToLoop(freq, len);
    oscB.frequency.value = Sound.snapToLoop(freq * 1.004, len);

    const vibratoLfo = ctx.createOscillator();
    vibratoLfo.type = "sine";
    vibratoLfo.frequency.value = Sound.snapToLoop(Sound.WARBLE_DRONE_VIBRATO_RATE[phaseState], len);
    const vibratoDepth = ctx.createGain();
    vibratoDepth.gain.value = baseFreq * (0.004 + 0.05 * g);
    vibratoLfo.connect(vibratoDepth);
    vibratoDepth.connect(oscA.frequency);
    vibratoDepth.connect(oscB.frequency);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.value = 700 + 700 * g;

    const trim = ctx.createGain();
    trim.gain.value = Sound.WARBLE_DRONE_BAKE_TRIM;
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(trim);
    trim.connect(dest);

    oscA.start(0);
    oscB.start(0);
    vibratoLfo.start(0);
    oscA.stop(renderLen);
    oscB.stop(renderLen);
    vibratoLfo.stop(renderLen);
  }

  // Warm both committed warble-drone endpoint loops (phased-in, phased-out).
  private prerenderWarbleDrones() {
    this.demandBake("warbleDrone", 0);
    this.demandBake("warbleDrone", 1);
  }

  // Open a warble's sustained voice: two baked endpoint loops (phased-in,
  // phased-out — see buildWarbleDroneGraph) summed through their own
  // crossfade gains into a shared mainGain. setWarbleDronePhase crossfades
  // between them each frame to ride the rock's continuous ghost amount.
  // Held until stopWarbleDrone.
  startWarbleDrone(key: object, pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.warbleDrones.has(key)) return;
    const bufIn = this.bakedBuffers.get(this.bakedKey("warbleDrone", 0));
    const bufOut = this.bakedBuffers.get(this.bakedKey("warbleDrone", 1));
    if (!bufIn || !bufOut) {
      // Bake hasn't landed yet (or failed) — kick it for next time and bail.
      this.prerenderWarbleDrones();
      return;
    }
    const t = this.ctx.currentTime;
    const spatial = pos ? this.makeSpatial(pos, this.master) : null;
    const sink: AudioNode = spatial ? spatial.panner : this.master;

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.06 / Sound.WARBLE_DRONE_BAKE_TRIM, t + 0.6);
    mainGain.connect(sink);

    const bufs = [bufIn, bufOut];
    const sources: AudioBufferSourceNode[] = [];
    const phaseGains: GainNode[] = [];
    for (let i = 0; i < 2; i++) {
      const { src, startOffset } = this.makeBakedLoopSource(bufs[i], Sound.WARBLE_DRONE_LOOP_LEN[i as 0 | 1]);
      const gain = this.ctx.createGain();
      // Only the phased-in loop audible at the start; phased-out crossfades in.
      gain.gain.setValueAtTime(i === 0 ? 1 : 0.0001, t);
      src.connect(gain);
      gain.connect(mainGain);
      src.start(t, startOffset);
      sources.push(src);
      phaseGains.push(gain);
    }

    this.warbleDrones.set(key, { sources, phaseGains, mainGain, spatial: spatial ?? undefined });
  }

  // Morph a warble's voice each frame. ghost01: 0 = fully phased in (smooth
  // hum), 1 = fully phased out (deep, wide, fast warble). Linearly crossfades
  // the two baked endpoint loops — this family only has two anchor states
  // spanning the whole range, so a direct 2-point crossfade is the correct
  // interpolation (unlike chargeBed's snap-to-nearest-of-5-tiers).
  setWarbleDronePhase(key: object, ghost01: number) {
    const node = this.warbleDrones.get(key);
    if (!node || !this.ctx) return;
    const g = Math.max(0, Math.min(1, ghost01));
    const t = this.ctx.currentTime;
    const ramp = 0.12;
    const [phaseInGain, phaseOutGain] = node.phaseGains;
    phaseInGain.gain.cancelScheduledValues(t);
    phaseInGain.gain.setValueAtTime(phaseInGain.gain.value, t);
    phaseInGain.gain.linearRampToValueAtTime(1 - g, t + ramp);
    phaseOutGain.gain.cancelScheduledValues(t);
    phaseOutGain.gain.setValueAtTime(phaseOutGain.gain.value, t);
    phaseOutGain.gain.linearRampToValueAtTime(g, t + ramp);
  }

  updateWarbleDrone(key: object, pos: Pos) {
    const node = this.warbleDrones.get(key);
    if (!node || !node.spatial) return;
    this.updateSpatial(node.spatial, pos);
  }

  stopWarbleDrone(key: object) {
    if (!this.ctx) return;
    const node = this.warbleDrones.get(key);
    if (!node) return;
    const t = this.ctx.currentTime;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    for (const src of node.sources) src.stop(t + 0.22);
    this.warbleDrones.delete(key);
  }

  stopAllWarbleDrones() {
    for (const key of Array.from(this.warbleDrones.keys())) this.stopWarbleDrone(key);
  }

  // C4 hum that sustains while the reticule hovers the first-beat dot.
  // Caller passes intensity01 every frame: 0 = silent, 1 = soft cap. The
  // first call lazily spins up the voice; subsequent calls just ride the
  // gain to a new target. Capped well below typical voices so it reads as
  // a background indicator, not music.
  private static readonly FIRST_DOT_HUM_PEAK_GAIN = 0.07;
  // softens onset of any new target value so per-frame jitter doesn't buzz.
  private static readonly FIRST_DOT_HUM_GAIN_TC = 0.08;
  // beat pulse shape: percussive-style sharp attack landing on the beat, exponential decay
  // back into the steady tone. Narrow swing (0.78 → 1.0) keeps the hum reading as one
  // continuous voice; the attack supplies the rhythmic accent, not the depth of modulation.
  private static readonly FIRST_DOT_HUM_PULSE_PEAK = 1.0;
  private static readonly FIRST_DOT_HUM_PULSE_TROUGH = 0.78;
  // 12ms attack — fast enough to read as a transient, slow enough that it doesn't click.
  private static readonly FIRST_DOT_HUM_PULSE_ATTACK_SEC = 0.012;
  // decay TC as a fraction of the beat: ~15% means 63% settled in ~75ms at default 0.5s grid,
  // mostly back to trough by next beat. Long natural tail blends into the hum.
  private static readonly FIRST_DOT_HUM_PULSE_DECAY_TC_FRAC = 0.15;
  // filter sweep adds a touch of "ah" vowel on the beat, settling back to "mm" — colour, not gain.
  private static readonly FIRST_DOT_HUM_FILTER_TROUGH_HZ = 700;
  private static readonly FIRST_DOT_HUM_FILTER_PEAK_HZ = 950;

  // Fixed (baseFreq, vibratoRate, vibratoDepthRatio) per hum instance, indexed 0..8 in field
  // declaration order — see the FirstDotHumNode doc comment. Read verbatim off each hum's original
  // createHumVoice call site; do not derive these from anything else.
  private static readonly FIRST_DOT_HUM_PITCH: ReadonlyArray<{ baseFreq: number; vibratoRate: number; vibratoDepthRatio: number }> = [
    { baseFreq: 261.63, vibratoRate: 4.2, vibratoDepthRatio: 0.004 },   // 0: firstDotHum (C4)
    { baseFreq: 523.25, vibratoRate: 4.6, vibratoDepthRatio: 0.003 },   // 1: firstDotOctaveHum (C5)
    { baseFreq: 392.00, vibratoRate: 4.4, vibratoDepthRatio: 0.0035 },  // 2: firstDotLockHum (G4)
    { baseFreq: 329.63, vibratoRate: 4.5, vibratoDepthRatio: 0.0035 },  // 3: firstDotHarmonyHum (E4)
    { baseFreq: 130.81, vibratoRate: 4.1, vibratoDepthRatio: 0.0035 },  // 4: firstDotSubHum (C3)
    { baseFreq: 783.99, vibratoRate: 4.8, vibratoDepthRatio: 0.003 },   // 5: firstDotShimmerHum (G5)
    { baseFreq: 587.33, vibratoRate: 4.6, vibratoDepthRatio: 0.003 },   // 6: firstDotNinthHum (D5)
    { baseFreq: 659.25, vibratoRate: 4.5, vibratoDepthRatio: 0.0033 },  // 7: firstDotSixthHum (E5)
    { baseFreq: 65.41, vibratoRate: 4.9, vibratoDepthRatio: 0.0028 },   // 8: firstDotHaloHum (C2)
  ];

  // Loop length (s), shared by all hum instances. Every rate in the graph (both detuned sines
  // and the vibrato LFO) is snapped to a whole number of cycles per loop by snapToLoop inside
  // buildFirstDotHumGraph, so the seam is exact. Long enough that the slow detune-beat cycle
  // (the chorus "breathing", ~1s at C4 up to ~4s for the C2 halo hum) completes whole cycles
  // INSIDE the loop — the drift-hold stack keeps evolving instead of repeating a clipped swell.
  private static readonly FIRST_DOT_HUM_LOOP_LEN = 8.0;

  // Headroom scale rendered into each loop's PCM — the detuned pair beats
  // to twice a single sine, which would hard-clip in encodeWav's 16-bit
  // clamp. Playback divides this back out (createHumVoice's makeup gain)
  // so the level into the live bandpass matches the original live graph.
  private static readonly FIRST_DOT_HUM_BAKE_TRIM = 0.4;

  // Renders one seamless first-dot-hum drone-tone loop for hum instance `humIndex` into `ctx`:
  // two detuned sines (chorus beating) + a slow vibrato LFO pitch-bending both. This is only the
  // raw tone — the bandpass formant, beat pulse and hover-swell gain all stay live (built fresh in
  // createHumVoice around the looping buffer this produces). Nothing here reads live state, so it
  // renders identically every time — see bakeSound's "firstDotHum" case.
  private buildFirstDotHumGraph(ctx: BaseAudioContext, dest: AudioNode, humIndex: number) {
    const { baseFreq, vibratoRate, vibratoDepthRatio } = Sound.FIRST_DOT_HUM_PITCH[humIndex];
    const len = Sound.FIRST_DOT_HUM_LOOP_LEN;
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const detuneRatio = 1.0035;
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.type = "sine";
    oscB.type = "sine";
    oscA.frequency.value = Sound.snapToLoop(baseFreq, len);
    oscB.frequency.value = Sound.snapToLoop(baseFreq * detuneRatio, len);
    const vibratoLfo = ctx.createOscillator();
    vibratoLfo.type = "sine";
    vibratoLfo.frequency.value = Sound.snapToLoop(vibratoRate, len);
    const vibratoDepth = ctx.createGain();
    vibratoDepth.gain.value = baseFreq * vibratoDepthRatio;
    vibratoLfo.connect(vibratoDepth);
    vibratoDepth.connect(oscA.frequency);
    vibratoDepth.connect(oscB.frequency);
    const trim = ctx.createGain();
    trim.gain.value = Sound.FIRST_DOT_HUM_BAKE_TRIM;
    oscA.connect(trim);
    oscB.connect(trim);
    trim.connect(dest);
    oscA.start(0);
    oscB.start(0);
    vibratoLfo.start(0);
    oscA.stop(renderLen);
    oscB.stop(renderLen);
    vibratoLfo.stop(renderLen);
  }

  // Warm all 9 committed first-dot-hum drone-tone loops.
  private prerenderFirstDotHums() {
    for (let i = 0; i < Sound.FIRST_DOT_HUM_PITCH.length; i++) this.demandBake("firstDotHum", i);
  }

  // shared voice builder for the first-dot hums: looks up the baked drone-tone loop for
  // `humIndex` (bailing + kicking a (re)bake if it isn't ready yet), then builds the live chain
  // around it exactly as before — a bandpass "mm" formant, a pulseGain for the on-beat accent and
  // a mainGain for the hover swell. The node starts effectively silent; the caller ramps mainGain
  // to taste.
  private createHumVoice(humIndex: number, filterStartHz: number): FirstDotHumNode | null {
    if (!this.ctx || !this.master) return null;
    const buf = this.bakedBuffers.get(this.bakedKey("firstDotHum", humIndex));
    if (!buf) {
      // Bake hasn't landed yet (or failed) — kick it for next time and bail.
      this.prerenderFirstDotHums();
      return null;
    }
    const t = this.ctx.currentTime;
    const { src, startOffset } = this.makeBakedLoopSource(buf, Sound.FIRST_DOT_HUM_LOOP_LEN);
    const makeup = this.ctx.createGain();
    makeup.gain.value = 1 / Sound.FIRST_DOT_HUM_BAKE_TRIM;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = filterStartHz;
    filter.Q.value = 1.4;
    const pulseGain = this.ctx.createGain();
    pulseGain.gain.setValueAtTime(Sound.FIRST_DOT_HUM_PULSE_TROUGH, t);
    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    src.connect(makeup);
    makeup.connect(filter);
    filter.connect(pulseGain);
    pulseGain.connect(mainGain);
    mainGain.connect(this.master);
    src.start(t, startOffset);
    return {
      src, filter, pulseGain, mainGain,
      lastScheduledBeatAudioTime: -Infinity, releasing: false, releaseCleanupTimer: null,
    };
  }

  // re-hover during a two-stage release: cancel the scheduled fade-out and resume from whatever
  // gain we'd faded to, so a brief mouse-off doesn't pop the voice back to full volume.
  private resumeHumIfReleasing(node: FirstDotHumNode, t: number) {
    if (!node.releasing) return;
    if (node.releaseCleanupTimer !== null) {
      clearTimeout(node.releaseCleanupTimer);
      node.releaseCleanupTimer = null;
    }
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.releasing = false;
  }

  updateFirstDotHum(intensity01: number, beatPhase01: number = 0, beatGrid: number = 0) {
    if (!this.enabled) return;
    const i = Math.max(0, Math.min(1, intensity01));
    if (i <= 0) { this.stopFirstDotHum(); return; }
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotHum) {
      // index 0: C4 = 261.63 Hz, slow vibrato, bandpass near 700 Hz for the closed-mouth "mm" formant.
      this.firstDotHum = this.createHumVoice(0, Sound.FIRST_DOT_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotHum) return;
    }
    const node = this.firstDotHum;
    this.resumeHumIfReleasing(node, t);
    const target = Sound.FIRST_DOT_HUM_PEAK_GAIN * i;
    node.mainGain.gain.setTargetAtTime(target, t, Sound.FIRST_DOT_HUM_GAIN_TC);
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_HUM_FILTER_PEAK_HZ);
  }

  // schedule one percussive envelope per beat on pulseGain (and a matching filter sweep between
  // the passed bands): fast linear attack that LANDS on the beat onset, then exponential decay
  // back to trough. Caller passes beatPhase01 (0 = on the beat, 1 = right before next); we
  // translate to audio-clock and only re-schedule once per beat so the in-flight decay isn't
  // restarted every frame. Shared by all three first-dot hum voices.
  private scheduleHumBeatPulse(
    node: FirstDotHumNode, audioNow: number, beatPhase01: number, beatGrid: number,
    filterTroughHz: number, filterPeakHz: number,
  ) {
    const secondsUntilNextBeat = (1 - beatPhase01) * beatGrid;
    const nextBeatAudioTime = audioNow + secondsUntilNextBeat;
    // tolerance of half a beat prevents re-schedule across frames within the same beat slot;
    // when phase wraps past 0 the next-beat time jumps forward by ~beatGrid → triggers re-sched.
    if (nextBeatAudioTime <= node.lastScheduledBeatAudioTime + beatGrid * 0.5) return;
    // attack ends exactly on the beat; start it ATTACK_SEC earlier (or clamp to now if we're
    // already inside that window so the ramp still resolves at the onset, just shorter).
    const attackStart = Math.max(audioNow, nextBeatAudioTime - Sound.FIRST_DOT_HUM_PULSE_ATTACK_SEC);
    const decayTC = Math.max(0.01, beatGrid * Sound.FIRST_DOT_HUM_PULSE_DECAY_TC_FRAC);
    const gainParam = node.pulseGain.gain;
    gainParam.cancelScheduledValues(audioNow);
    gainParam.setValueAtTime(gainParam.value, audioNow);
    gainParam.setValueAtTime(gainParam.value, attackStart);
    gainParam.linearRampToValueAtTime(Sound.FIRST_DOT_HUM_PULSE_PEAK, nextBeatAudioTime);
    gainParam.setTargetAtTime(Sound.FIRST_DOT_HUM_PULSE_TROUGH, nextBeatAudioTime, decayTC);
    // same envelope shape on the bandpass — opens the formant on the beat, closes during decay.
    // Adds a touch of "ah" colour to the accent without changing perceived loudness much.
    const freqParam = node.filter.frequency;
    freqParam.cancelScheduledValues(audioNow);
    freqParam.setValueAtTime(freqParam.value, audioNow);
    freqParam.setValueAtTime(freqParam.value, attackStart);
    freqParam.linearRampToValueAtTime(filterPeakHz, nextBeatAudioTime);
    freqParam.setTargetAtTime(filterTroughHz, nextBeatAudioTime, decayTC);
    node.lastScheduledBeatAudioTime = nextBeatAudioTime;
  }

  // two-stage release: fast drop to RELEASE_LOW reads as "you lost it", then a slow tail to 0
  // smooths over flicker so repeatedly grazing the first-dot doesn't feel jarring. Oscillators
  // are torn down via setTimeout (not osc.stop) so a re-hover during the tail can resume cleanly.
  private static readonly FIRST_DOT_HUM_RELEASE_DROP_SEC = 0.12;
  private static readonly FIRST_DOT_HUM_RELEASE_DROP_LEVEL = 0.18;
  private static readonly FIRST_DOT_HUM_RELEASE_TAIL_SEC = 0.6;
  // shared two-stage release: fast drop to RELEASE_LOW reads as "you lost it", then a slow tail
  // to 0 smooths over flicker so repeatedly grazing the first-dot doesn't feel jarring.
  // Oscillators are torn down via setTimeout (not osc.stop) so a re-hover during the tail can
  // resume cleanly. isCurrent() guards against tearing down a node that was already replaced;
  // clear() nulls the owning field once the tail finishes.
  private releaseHumVoice(
    node: FirstDotHumNode, peakGain: number, isCurrent: () => boolean, clear: () => void,
  ) {
    if (!this.ctx || node.releasing) return;
    const t = this.ctx.currentTime;
    const dropEnd = t + Sound.FIRST_DOT_HUM_RELEASE_DROP_SEC;
    const tailEnd = dropEnd + Sound.FIRST_DOT_HUM_RELEASE_TAIL_SEC;
    const dropLevel = peakGain * Sound.FIRST_DOT_HUM_RELEASE_DROP_LEVEL;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(dropLevel, dropEnd);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, tailEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (!isCurrent()) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.02 : 0;
      try { node.src.stop(stopAt); } catch {}
      clear();
    }, Math.ceil((Sound.FIRST_DOT_HUM_RELEASE_DROP_SEC + Sound.FIRST_DOT_HUM_RELEASE_TAIL_SEC) * 1000) + 30);
  }

  stopFirstDotHum() {
    if (!this.firstDotHum) return;
    const node = this.firstDotHum;
    this.releaseHumVoice(node, Sound.FIRST_DOT_HUM_PEAK_GAIN, () => this.firstDotHum === node, () => { this.firstDotHum = null; });
  }

  // Octave-up companion hum (C5) that joins the C4 hover hum the instant the reticule crosses
  // onto the tight target area (the same moment the dashed lock ring begins filling). On/off with
  // the hover — same vowel + bandpass character so it reads as the base voice an octave brighter.
  private static readonly FIRST_DOT_OCTAVE_HUM_PEAK_GAIN = 0.05;
  private static readonly FIRST_DOT_OCTAVE_HUM_GAIN_TC = 0.08;
  private static readonly FIRST_DOT_OCTAVE_HUM_FILTER_TROUGH_HZ = 1100;
  private static readonly FIRST_DOT_OCTAVE_HUM_FILTER_PEAK_HZ = 1500;
  updateFirstDotOctaveHum(beatPhase01: number = 0, beatGrid: number = 0) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotOctaveHum) {
      // index 1: C5 = 523.25 Hz.
      this.firstDotOctaveHum = this.createHumVoice(1, Sound.FIRST_DOT_OCTAVE_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotOctaveHum) return;
    }
    const node = this.firstDotOctaveHum;
    this.resumeHumIfReleasing(node, t);
    node.mainGain.gain.setTargetAtTime(Sound.FIRST_DOT_OCTAVE_HUM_PEAK_GAIN, t, Sound.FIRST_DOT_OCTAVE_HUM_GAIN_TC);
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_OCTAVE_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_OCTAVE_HUM_FILTER_PEAK_HZ);
  }

  stopFirstDotOctaveHum() {
    if (!this.firstDotOctaveHum) return;
    const node = this.firstDotOctaveHum;
    this.releaseHumVoice(node, Sound.FIRST_DOT_OCTAVE_HUM_PEAK_GAIN, () => this.firstDotOctaveHum === node, () => { this.firstDotOctaveHum = null; });
  }

  // Perfect-fifth companion hum (G4) that joins the moment the hover ring finishes filling. Sits a
  // fifth above the C4 root, filling the C4+C5 octave into an open chord. Soft swell-attack
  // (LOCK_ATTACK_SEC) so it eases in under the song's beat rather than punching across it.
  private static readonly FIRST_DOT_LOCK_HUM_PEAK_GAIN = 0.05;
  // slower attack — swells in over the flare instead of punching, so the player's ear stays
  // on the song beat rather than treating the lock as a percussive "fire NOW" hit.
  private static readonly FIRST_DOT_LOCK_HUM_ATTACK_SEC = 0.55;
  // formant band that brightens on the beat, sitting between the base and octave voices.
  private static readonly FIRST_DOT_LOCK_HUM_FILTER_TROUGH_HZ = 900;
  private static readonly FIRST_DOT_LOCK_HUM_FILTER_PEAK_HZ = 1250;
  startFirstDotLockHum() {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.firstDotLockHum) return;
    const t = this.ctx.currentTime;
    // index 2: G4 = 392.00 Hz — a perfect fifth above the C4 root hum.
    this.firstDotLockHum = this.createHumVoice(2, Sound.FIRST_DOT_LOCK_HUM_FILTER_TROUGH_HZ);
    if (!this.firstDotLockHum) return;
    // linear ramp from silence to peak across LOCK_ATTACK_SEC — soft enough that the lock
    // reads as a swell joining the chord rather than a percussive accent on its own clock.
    this.firstDotLockHum.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_LOCK_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_LOCK_HUM_ATTACK_SEC);
  }

  updateFirstDotLockHum(beatPhase01: number, beatGrid: number) {
    if (!this.ctx || !this.firstDotLockHum || beatGrid <= 0) return;
    const node = this.firstDotLockHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_LOCK_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_LOCK_HUM_FILTER_PEAK_HZ);
  }

  // fast release for the lock fifth — when the reticule leaves the target, the G4 must drop
  // to silence inside FAST_RELEASE_SEC so the player doesn't get a lingering harmony pulling
  // their ear off the song's beat. Bypasses the gentle two-stage release used by the other hums.
  private static readonly FIRST_DOT_LOCK_HUM_FAST_RELEASE_SEC = 0.05;
  stopFirstDotLockHum() {
    if (!this.firstDotLockHum || !this.ctx) return;
    const node = this.firstDotLockHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.FIRST_DOT_LOCK_HUM_FAST_RELEASE_SEC;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.firstDotLockHum !== node) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      try { node.src.stop(stopAt); } catch {}
      this.firstDotLockHum = null;
    }, Math.ceil(Sound.FIRST_DOT_LOCK_HUM_FAST_RELEASE_SEC * 1000) + 20);
  }

  // Major-third harmony hum (E4 = 329.63 Hz) layered on top of the C4/C5/G4 stack once the drift
  // shot is fully enabled and the reticule is still inside the tight hover radius. It turns the
  // open C+G+C voicing into a full C-major triad, so achieving and holding a lock reads as the
  // chord "resolving". Tied to the tight hover band — it drops the instant the reticule slips off
  // the small radius (the same gate that disables the drift shot), so it needs the lock fifth's
  // fast release rather than the gentle two-stage tail.
  private static readonly FIRST_DOT_HARMONY_HUM_PEAK_GAIN = 0.042;
  private static readonly FIRST_DOT_HARMONY_HUM_ATTACK_SEC = 0.35;
  private static readonly FIRST_DOT_HARMONY_HUM_FILTER_TROUGH_HZ = 820;
  private static readonly FIRST_DOT_HARMONY_HUM_FILTER_PEAK_HZ = 1150;
  // Called every frame the drift shot is enabled AND the reticule sits in the tight hover radius.
  // Lazily spins up the voice with a soft swell on the first frame, resumes it if a prior exit had
  // it mid-release (a quick slip-off-and-back doesn't re-pop to full volume), then rides the same
  // on-beat formant pulse as the other hums.
  updateFirstDotHarmonyHum(beatPhase01: number, beatGrid: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotHarmonyHum) {
      // index 3: E4 = 329.63 Hz — the major third above the C4 root, completing the triad.
      this.firstDotHarmonyHum = this.createHumVoice(3, Sound.FIRST_DOT_HARMONY_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotHarmonyHum) return;
      this.firstDotHarmonyHum.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_HARMONY_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_HARMONY_HUM_ATTACK_SEC);
    }
    const node = this.firstDotHarmonyHum;
    if (node.releasing) {
      this.resumeHumIfReleasing(node, t);
      node.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_HARMONY_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_HARMONY_HUM_ATTACK_SEC);
    }
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_HARMONY_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_HARMONY_HUM_FILTER_PEAK_HZ);
  }

  // fast release matching the lock fifth — the third must vanish inside FAST_RELEASE_SEC the
  // moment the reticule leaves the tight radius so it doesn't linger past the drift-shot window.
  private static readonly FIRST_DOT_HARMONY_HUM_FAST_RELEASE_SEC = 0.05;
  stopFirstDotHarmonyHum() {
    if (!this.firstDotHarmonyHum || !this.ctx) return;
    const node = this.firstDotHarmonyHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.FIRST_DOT_HARMONY_HUM_FAST_RELEASE_SEC;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.firstDotHarmonyHum !== node) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      try { node.src.stop(stopAt); } catch {}
      this.firstDotHarmonyHum = null;
    }, Math.ceil(Sound.FIRST_DOT_HARMONY_HUM_FAST_RELEASE_SEC * 1000) + 20);
  }

  // Drift-tier-2 sub-octave root hum (C3 = 130.81 Hz): the C-major root dropped a full octave
  // below the base hover hum, layered once the player holds past the tier-2 threshold. Anchors the
  // C4/C5/G4/E4 stack with low-end weight — the "deeper hum" reward for committing to a longer hold.
  // Soft swell-in so it eases under the song, low formant for a chest-resonant "mm". Same lazy
  // spin-up + fast-release shape as the harmony third, so it drops the instant the hover slips off.
  private static readonly FIRST_DOT_SUB_HUM_PEAK_GAIN = 0.038;
  private static readonly FIRST_DOT_SUB_HUM_ATTACK_SEC = 0.45;
  private static readonly FIRST_DOT_SUB_HUM_FILTER_TROUGH_HZ = 300;
  private static readonly FIRST_DOT_SUB_HUM_FILTER_PEAK_HZ = 450;
  updateFirstDotSubHum(beatPhase01: number, beatGrid: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotSubHum) {
      // index 4: C3 = 130.81 Hz.
      this.firstDotSubHum = this.createHumVoice(4, Sound.FIRST_DOT_SUB_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotSubHum) return;
      this.firstDotSubHum.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_SUB_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_SUB_HUM_ATTACK_SEC);
    }
    const node = this.firstDotSubHum;
    if (node.releasing) {
      this.resumeHumIfReleasing(node, t);
      node.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_SUB_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_SUB_HUM_ATTACK_SEC);
    }
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_SUB_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_SUB_HUM_FILTER_PEAK_HZ);
  }

  private static readonly FIRST_DOT_SUB_HUM_FAST_RELEASE_SEC = 0.05;
  stopFirstDotSubHum() {
    if (!this.firstDotSubHum || !this.ctx) return;
    const node = this.firstDotSubHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.FIRST_DOT_SUB_HUM_FAST_RELEASE_SEC;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.firstDotSubHum !== node) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      try { node.src.stop(stopAt); } catch {}
      this.firstDotSubHum = null;
    }, Math.ceil(Sound.FIRST_DOT_SUB_HUM_FAST_RELEASE_SEC * 1000) + 20);
  }

  // Drift-tier-3 bright fifth hum (G5 = 783.99 Hz): the perfect fifth two octaves above the lock
  // G4, layered at the top tier. Deliberately HIGH rather than deeper — the bass field already
  // occupies the low octaves, so a bright fifth gives clean tier separation and reads as the hold
  // "ascending" into mastery. Bright formant, lowest gain of the stack so it sparkles on top.
  private static readonly FIRST_DOT_SHIMMER_HUM_PEAK_GAIN = 0.03;
  private static readonly FIRST_DOT_SHIMMER_HUM_ATTACK_SEC = 0.4;
  private static readonly FIRST_DOT_SHIMMER_HUM_FILTER_TROUGH_HZ = 1500;
  private static readonly FIRST_DOT_SHIMMER_HUM_FILTER_PEAK_HZ = 1900;
  updateFirstDotShimmerHum(beatPhase01: number, beatGrid: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotShimmerHum) {
      // index 5: G5 = 783.99 Hz.
      this.firstDotShimmerHum = this.createHumVoice(5, Sound.FIRST_DOT_SHIMMER_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotShimmerHum) return;
      this.firstDotShimmerHum.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_SHIMMER_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_SHIMMER_HUM_ATTACK_SEC);
    }
    const node = this.firstDotShimmerHum;
    if (node.releasing) {
      this.resumeHumIfReleasing(node, t);
      node.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_SHIMMER_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_SHIMMER_HUM_ATTACK_SEC);
    }
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_SHIMMER_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_SHIMMER_HUM_FILTER_PEAK_HZ);
  }

  private static readonly FIRST_DOT_SHIMMER_HUM_FAST_RELEASE_SEC = 0.05;
  stopFirstDotShimmerHum() {
    if (!this.firstDotShimmerHum || !this.ctx) return;
    const node = this.firstDotShimmerHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.FIRST_DOT_SHIMMER_HUM_FAST_RELEASE_SEC;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.firstDotShimmerHum !== node) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      try { node.src.stop(stopAt); } catch {}
      this.firstDotShimmerHum = null;
    }, Math.ceil(Sound.FIRST_DOT_SHIMMER_HUM_FAST_RELEASE_SEC * 1000) + 20);
  }

  // Drift-tier-4 major-9th hum (D5 = 587.33 Hz): the top-tier capstone. Adds the major 9th over
  // the C-major stack to make a lush Cadd9 — D belongs to both C-major and C-minor, and the add9
  // skips the third, so it sweetens every song (including the C-minor boss track) without ever
  // clashing. Mid-bright formant between the harmony third and the shimmer fifth; gentle swell.
  private static readonly FIRST_DOT_NINTH_HUM_PEAK_GAIN = 0.032;
  private static readonly FIRST_DOT_NINTH_HUM_ATTACK_SEC = 0.5;
  private static readonly FIRST_DOT_NINTH_HUM_FILTER_TROUGH_HZ = 1000;
  private static readonly FIRST_DOT_NINTH_HUM_FILTER_PEAK_HZ = 1400;
  updateFirstDotNinthHum(beatPhase01: number, beatGrid: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotNinthHum) {
      // index 6: D5 = 587.33 Hz.
      this.firstDotNinthHum = this.createHumVoice(6, Sound.FIRST_DOT_NINTH_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotNinthHum) return;
      this.firstDotNinthHum.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_NINTH_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_NINTH_HUM_ATTACK_SEC);
    }
    const node = this.firstDotNinthHum;
    if (node.releasing) {
      this.resumeHumIfReleasing(node, t);
      node.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_NINTH_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_NINTH_HUM_ATTACK_SEC);
    }
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_NINTH_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_NINTH_HUM_FILTER_PEAK_HZ);
  }

  private static readonly FIRST_DOT_NINTH_HUM_FAST_RELEASE_SEC = 0.05;
  stopFirstDotNinthHum() {
    if (!this.firstDotNinthHum || !this.ctx) return;
    const node = this.firstDotNinthHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.FIRST_DOT_NINTH_HUM_FAST_RELEASE_SEC;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.firstDotNinthHum !== node) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      try { node.src.stop(stopAt); } catch {}
      this.firstDotNinthHum = null;
    }, Math.ceil(Sound.FIRST_DOT_NINTH_HUM_FAST_RELEASE_SEC * 1000) + 20);
  }

  // Drift-tier-5 major-third hum (E5 = 659.25 Hz): the major 3rd up high turns the spread into a
  // bright, fully-consonant C-major chord (root/3rd/5th/9th) — a standard triumphant harmony rather
  // than the spicier added-6th it replaced. Higher formant to match the lifted pitch, soft swell.
  private static readonly FIRST_DOT_SIXTH_HUM_PEAK_GAIN = 0.03;
  private static readonly FIRST_DOT_SIXTH_HUM_ATTACK_SEC = 0.55;
  private static readonly FIRST_DOT_SIXTH_HUM_FILTER_TROUGH_HZ = 1100;
  private static readonly FIRST_DOT_SIXTH_HUM_FILTER_PEAK_HZ = 1500;
  updateFirstDotSixthHum(beatPhase01: number, beatGrid: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotSixthHum) {
      // index 7: E5 = 659.25 Hz.
      this.firstDotSixthHum = this.createHumVoice(7, Sound.FIRST_DOT_SIXTH_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotSixthHum) return;
      this.firstDotSixthHum.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_SIXTH_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_SIXTH_HUM_ATTACK_SEC);
    }
    const node = this.firstDotSixthHum;
    if (node.releasing) {
      this.resumeHumIfReleasing(node, t);
      node.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_SIXTH_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_SIXTH_HUM_ATTACK_SEC);
    }
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_SIXTH_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_SIXTH_HUM_FILTER_PEAK_HZ);
  }

  private static readonly FIRST_DOT_SIXTH_HUM_FAST_RELEASE_SEC = 0.05;
  stopFirstDotSixthHum() {
    if (!this.firstDotSixthHum || !this.ctx) return;
    const node = this.firstDotSixthHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.FIRST_DOT_SIXTH_HUM_FAST_RELEASE_SEC;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.firstDotSixthHum !== node) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      try { node.src.stop(stopAt); } catch {}
      this.firstDotSixthHum = null;
    }, Math.ceil(Sound.FIRST_DOT_SIXTH_HUM_FAST_RELEASE_SEC * 1000) + 20);
  }

  // Drift-tier-6 deep-root foundation hum (C2 = 65.41 Hz): the root an octave BELOW the tier-2 sub
  // root, crowning the hold with a deep, chest-felt foundation rather than a bright top. Pure root so
  // it's universally safe; low formant so the fundamental carries, with the stack's highest gain since
  // low frequencies need more amplitude to register at equal loudness.
  private static readonly FIRST_DOT_HALO_HUM_PEAK_GAIN = 0.05;
  private static readonly FIRST_DOT_HALO_HUM_ATTACK_SEC = 0.6;
  private static readonly FIRST_DOT_HALO_HUM_FILTER_TROUGH_HZ = 180;
  private static readonly FIRST_DOT_HALO_HUM_FILTER_PEAK_HZ = 280;
  updateFirstDotHaloHum(beatPhase01: number, beatGrid: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.firstDotHaloHum) {
      // index 8: C2 = 65.41 Hz.
      this.firstDotHaloHum = this.createHumVoice(8, Sound.FIRST_DOT_HALO_HUM_FILTER_TROUGH_HZ);
      if (!this.firstDotHaloHum) return;
      this.firstDotHaloHum.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_HALO_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_HALO_HUM_ATTACK_SEC);
    }
    const node = this.firstDotHaloHum;
    if (node.releasing) {
      this.resumeHumIfReleasing(node, t);
      node.mainGain.gain.linearRampToValueAtTime(Sound.FIRST_DOT_HALO_HUM_PEAK_GAIN, t + Sound.FIRST_DOT_HALO_HUM_ATTACK_SEC);
    }
    if (beatGrid > 0) this.scheduleHumBeatPulse(node, t, beatPhase01, beatGrid, Sound.FIRST_DOT_HALO_HUM_FILTER_TROUGH_HZ, Sound.FIRST_DOT_HALO_HUM_FILTER_PEAK_HZ);
  }

  private static readonly FIRST_DOT_HALO_HUM_FAST_RELEASE_SEC = 0.05;
  stopFirstDotHaloHum() {
    if (!this.firstDotHaloHum || !this.ctx) return;
    const node = this.firstDotHaloHum;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.FIRST_DOT_HALO_HUM_FAST_RELEASE_SEC;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.firstDotHaloHum !== node) return;
      const stopAt = this.ctx ? this.ctx.currentTime + 0.01 : 0;
      try { node.src.stop(stopAt); } catch {}
      this.firstDotHaloHum = null;
    }, Math.ceil(Sound.FIRST_DOT_HALO_HUM_FAST_RELEASE_SEC * 1000) + 20);
  }

  // ── Streak shimmer ────────────────────────────────────────────────────
  // A fast music-box arpeggio that fades in with a rhythm streak (see the
  // StreakShimmerNode type comment). Design constraints from the brief:
  //   MELODIC — real pitched notes drawn from a Cmaj9 arpeggio, not noise.
  //   SUBTLE FADE — level eases with the streak, so gaining/losing streak just
  //     brings the shimmer up/down; there's no hard on/off to jar.
  //   32ND NOTES — the scheduler fires 16ths early on, tightening to 32nds once
  //     the streak is long, so the texture is distinct from the game's other hums.
  //   NOT PERCUSSIVE — each tine has a soft attack and a baked tail that overlaps
  //     the next note, so it glistens as a wash rather than striking like a drum.
  //   SHIMMER — high register + tiny per-note detune + overlapping tails.
  //   MATCHES THE CHORDS — Cmaj9 tones sit consonantly on the C-rooted field;
  //     the maj7 B is the colour that separates it from the old pentatonic.
  //   NO DRONE — nothing sustains; the "body" is purely the overlapping tails.
  //   NO RATTLE — no filtered noise anywhere (that was the old rattle).
  //   PRE-BAKED — every pool pitch is rendered once offline into a buffer;
  //     playback is a cheap AudioBufferSourceNode per note, no live synth.

  // Cmaj9 arpeggio pool (C D E G B per octave), C5..E7. The streak plays a
  //   rising cycle inside a WINDOW of this array: low streak sits in the lower
  //   window, a long streak shifts the window up so the figure climbs the pool
  //   as it grows (only after it reaches 32nds).
  private static readonly STREAK_SHIMMER_POOL = [
    523.25,  // C5
    587.33,  // D5
    659.25,  // E5
    783.99,  // G5
    987.77,  // B5
    1046.50, // C6
    1174.66, // D6
    1318.51, // E6
    1567.98, // G6
    1975.53, // B6
    2093.00, // C7
    2349.32, // D7
    2637.02, // E7
  ];
  // How many adjacent pool pitches the rising cycle spans — one window pass is
  //   one octave of the chord, so each cycle reads as a tiny upward gliss.
  private static readonly STREAK_SHIMMER_WINDOW = 5;
  // Peak level at full intensity — a gentle top sparkle that sits under the hums.
  private static readonly STREAK_SHIMMER_PEAK_GAIN = 0.07;
  private static readonly STREAK_SHIMMER_LEVEL_TC = 0.1;
  // Streak fraction at/above which the grid tightens from 16ths to 32nds, and the
  //   window starts climbing the pool. Below it: 16ths in the base register.
  private static readonly STREAK_SHIMMER_TIGHTEN_AT = 0.35;
  // Note grid in seconds (120 BPM, BEAT_GRID 0.5s → 16th = 0.125s, 32nd = 0.0625s).
  private static readonly STREAK_SHIMMER_SIXTEENTH_SEC = 0.125;
  private static readonly STREAK_SHIMMER_THIRTYSECOND_SEC = 0.0625;
  // Baked tine shape: soft attack (glisten, not strike); the buffer holds the
  //   full natural decay, long enough to overlap the next note as a wash.
  private static readonly STREAK_SHIMMER_ATTACK_SEC = 0.006;
  private static readonly STREAK_SHIMMER_NOTE_SEC = 0.5;
  // Lookahead pump: schedule any bells landing within this horizon each tick.
  private static readonly STREAK_SHIMMER_LOOKAHEAD_SEC = 0.1;
  private static readonly STREAK_SHIMMER_PUMP_MS = 25;
  private static readonly STREAK_SHIMMER_RELEASE_SEC = 0.4;

  // ── Streak sound slot ──────────────────────────────────────────────────
  // The public entry the renderer drives every frame a streak is alive. Every
  //   streak plays the updraft loop stems (the tine arpeggio path is kept but
  //   no longer selected — see StreakSoundSet). beatAlignDelay is the seconds
  //   until the next beat-grid boundary, so the loop set can start its
  //   downbeat in time with the bass clock.
  updateStreakSound(intensity01: number, beatAlignDelay: number = 0) {
    if (!this.enabled) return;
    const i = Math.max(0, Math.min(1, intensity01));
    if (i <= 0) { this.stopStreakSound(); return; }
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (!this.streakSet) {
      // The updraft stems need their fetch+decode to have landed; until then
      //   the streak stays silent (the readiness check kicks the load), and we
      //   retry each frame so the sound joins as soon as the buffers arrive.
      if (!this.streakLoopBuffersReady()) return;
      this.streakSet = "updraft";
    }
    if (this.streakSet === "updraft") this.updateStreakLoop(i, beatAlignDelay);
    else this.updateStreakShimmer(i);
  }

  // Streak over (or sound disabled): fade out whichever set is playing and
  //   forget the roll so the next streak re-rolls.
  stopStreakSound() {
    this.stopStreakShimmer();
    this.stopStreakLoop();
    this.streakSet = null;
  }

  // Drive while a streak is alive. intensity01 (0..1) is the streak's length eased
  //   toward a ceiling by the caller: it sets level, the note grid (16th→32nd), and
  //   how high in the pool the walk sits. The scheduler runs on its own timer.
  private updateStreakShimmer(intensity01: number) {
    if (!this.enabled) return;
    const i = Math.max(0, Math.min(1, intensity01));
    if (i <= 0) { this.stopStreakShimmer(); return; }
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.streakShimmer) {
      this.streakShimmer = this.createStreakShimmer(t);
      if (!this.streakShimmer) return;
    }
    const node = this.streakShimmer;
    this.resumeStreakShimmerIfReleasing(node, t);
    node.intensity = i;
    node.out.gain.setTargetAtTime(Sound.STREAK_SHIMMER_PEAK_GAIN * i, t, Sound.STREAK_SHIMMER_LEVEL_TC);
  }

  // Build the shimmer bus (just an out gain into master) and start the lookahead
  //   pump that schedules baked plucks. Notes themselves are one-shot buffer
  //   playbacks in scheduleStreakShimmerNote, so nothing sustains.
  private createStreakShimmer(t: number): StreakShimmerNode | null {
    if (!this.ctx || !this.master) return null;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, t); // first update's setTargetAtTime swells it in
    out.connect(this.master);
    const node: StreakShimmerNode = {
      out,
      intensity: 0,
      nextNoteTime: t + 0.05,
      walkIndex: -1, // below the pool so the first note snaps to the window base
      timer: null,
      releasing: false,
      releaseCleanupTimer: null,
    };
    node.timer = setInterval(() => this.pumpStreakShimmer(node), Sound.STREAK_SHIMMER_PUMP_MS);
    return node;
  }

  // Lookahead scheduler: emit every pluck whose onset falls within the horizon,
  //   advancing the grid (16th vs 32nd) from the current intensity.
  private pumpStreakShimmer(node: StreakShimmerNode) {
    if (!this.enabled || !this.ctx || node.releasing) return;
    const now = this.ctx.currentTime;
    const horizon = now + Sound.STREAK_SHIMMER_LOOKAHEAD_SEC;
    // don't let a backgrounded tab pile up a burst of overdue notes.
    if (node.nextNoteTime < now - 0.2) node.nextNoteTime = now;
    let guard = 0;
    while (node.nextNoteTime < horizon && guard++ < 16) {
      const i = node.intensity;
      const tight = i >= Sound.STREAK_SHIMMER_TIGHTEN_AT;
      const grid = tight ? Sound.STREAK_SHIMMER_THIRTYSECOND_SEC : Sound.STREAK_SHIMMER_SIXTEENTH_SEC;
      this.scheduleStreakShimmerNote(node, node.nextNoteTime, i, tight);
      node.nextNoteTime += grid;
    }
  }

  // One baked music-box pluck at time `at`. Picks the next pitch as a rising
  //   cycle inside a window that climbs the pool once the streak is long, then
  //   plays that pitch's cached buffer — no live synth (see the prerender below).
  private scheduleStreakShimmerNote(node: StreakShimmerNode, at: number, intensity: number, tight: boolean) {
    if (!this.ctx) return;
    const pool = Sound.STREAK_SHIMMER_POOL;
    const win = Sound.STREAK_SHIMMER_WINDOW;
    // Window base climbs the pool only once we've tightened to 32nds, and only
    //   with the streak past that point — so pitch rises "only then", per the brief.
    const climb = tight ? (intensity - Sound.STREAK_SHIMMER_TIGHTEN_AT) / (1 - Sound.STREAK_SHIMMER_TIGHTEN_AT) : 0;
    const maxBase = pool.length - win;
    const base = Math.round(Math.max(0, Math.min(maxBase, climb * maxBase)));
    // rising cycle: step up through the window, wrapping back to its base — the
    //   same one-octave figure over and over, lifting registers as it climbs.
    node.walkIndex = node.walkIndex < base || node.walkIndex >= base + win - 1 ? base : node.walkIndex + 1;
    const buf = this.bakedBuffers.get(this.bakedKey("streakShimmer", node.walkIndex));
    if (!buf) {
      // Render hasn't landed yet (or failed) — kick it and skip this note.
      this.prerenderStreakShimmerNotes();
      return;
    }
    // Louder notes toward the top of the pool so the shimmer sparkles as it climbs,
    //   but always faint — the out gain (intensity) is the real level control.
    const vel = 0.5 + 0.5 * (node.walkIndex / (pool.length - 1));
    // Tiny per-note detune → chorus shimmer; derived from onset time, no RNG.
    const wob = ((at * 71.3) % 1) * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.setValueAtTime(1 + wob * 0.004, at);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vel, at);
    src.connect(g);
    g.connect(node.out);
    src.start(at);
  }

  // Warm the committed streak-shimmer tine one-shots (one mp3 per pool pitch
  //   index, keyed by pitchRatio = index). Each goes through queueBake: fetch
  //   the committed mp3, and only in dev fall back to a
  //   buildStreakShimmerNoteGraph offline render that gets dumped to disk.
  //   Fire-and-forget; queueBake de-dupes in-flight/cached.
  private prerenderStreakShimmerNotes() {
    for (let i = 0; i < Sound.STREAK_SHIMMER_POOL.length; i++) this.demandBake("streakShimmer", i);
  }

  // Music-box tine voice: a sine fundamental with a slow decay plus two
  //   fast-decaying INHARMONIC partials — the metallic "ting" that makes it a
  //   tine rather than a flute. Soft attack so it glistens instead of clicking.
  //   Partials that would land near/above Nyquist for the top pitches are dropped.
  private buildStreakShimmerNoteGraph(ctx: BaseAudioContext, dest: AudioNode, freq: number) {
    const partials = [
      { mult: 1, lvl: 0.6, decayTc: 0.14 },
      { mult: 3.97, lvl: 0.16, decayTc: 0.045 },
      { mult: 9.28, lvl: 0.05, decayTc: 0.02 },
    ];
    for (const p of partials) {
      const f = freq * p.mult;
      if (f > 16000) continue;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f, 0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.linearRampToValueAtTime(p.lvl, Sound.STREAK_SHIMMER_ATTACK_SEC);
      g.gain.setTargetAtTime(0.0001, Sound.STREAK_SHIMMER_ATTACK_SEC, p.decayTc);
      osc.connect(g);
      g.connect(dest);
      osc.start(0);
      osc.stop(Sound.STREAK_SHIMMER_NOTE_SEC);
    }
  }

  private resumeStreakShimmerIfReleasing(node: StreakShimmerNode, t: number) {
    if (!node.releasing) return;
    if (node.releaseCleanupTimer !== null) {
      clearTimeout(node.releaseCleanupTimer);
      node.releaseCleanupTimer = null;
    }
    if (node.timer === null) node.timer = setInterval(() => this.pumpStreakShimmer(node), Sound.STREAK_SHIMMER_PUMP_MS);
    node.nextNoteTime = t + 0.05;
    node.out.gain.cancelScheduledValues(t);
    node.out.gain.setValueAtTime(node.out.gain.value, t);
    node.releasing = false;
  }

  // Streak ended: stop scheduling new bells and fade the bus out over a soft tail
  //   (a hard cut would click), letting the in-flight notes ring, then tear down.
  private stopStreakShimmer() {
    if (!this.streakShimmer || !this.ctx) return;
    const node = this.streakShimmer;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    if (node.timer !== null) { clearInterval(node.timer); node.timer = null; }
    const releaseEnd = t + Sound.STREAK_SHIMMER_RELEASE_SEC;
    node.out.gain.cancelScheduledValues(t);
    node.out.gain.setValueAtTime(node.out.gain.value, t);
    node.out.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.streakShimmer !== node) return;
      try { node.out.disconnect(); } catch {}
      this.streakShimmer = null;
    }, Math.ceil(Sound.STREAK_SHIMMER_RELEASE_SEC * 1000) + 30);
  }

  // ── Streak updraft loop ──────────────────────────────────────────────────
  // The looping-stem streak set (see StreakLoopNode). Two pre-rendered
  //   ElevenLabs 16-second loops, C-major over the field's C pedal, both
  //   highpassed out of the bass family's home register:
  //     base — a glassy breathing shimmer pad with a soft eighth-note pulse
  //     rise — an ever-climbing 16th-note crystal arpeggio, almost all of its
  //            energy above 2 kHz — the thing that escalates with the streak
  //   Pipeline + audit live in scripts/music-gen/process_updraft.py.
  private static readonly STREAK_LOOP_BASE_URL = "/sounds/streak/updraft-el-base.mp3";
  private static readonly STREAK_LOOP_RISE_URL = "/sounds/streak/updraft-el-rise.mp3";
  // Per-layer peak gains, calibrated by the in-game-mix audit so the bass
  //   field stays dominant below 500 Hz even with both layers at full level.
  private static readonly STREAK_LOOP_BASE_GAIN = 0.30;
  private static readonly STREAK_LOOP_RISE_GAIN = 0.35;
  private static readonly STREAK_LOOP_RELEASE_SEC = 0.6;

  // Warm the updraft stems so the first streak's roll can pick them without
  //   losing the race to fetch+decode. Shares the URL-keyed music buffer cache.
  preloadStreakMusic(): void {
    this.ensureContext();
    void this.loadHaloMusicBuffer(Sound.STREAK_LOOP_BASE_URL);
    void this.loadHaloMusicBuffer(Sound.STREAK_LOOP_RISE_URL);
  }

  private streakLoopBuffersReady(): boolean {
    const ready = this.haloMusicBuffers.has(Sound.STREAK_LOOP_BASE_URL) &&
      this.haloMusicBuffers.has(Sound.STREAK_LOOP_RISE_URL);
    if (!ready) this.preloadStreakMusic();
    return ready;
  }

  // Per-frame drive while an "updraft" streak is alive. The base pad tracks
  //   the streak level; the rise layer stays silent until the same threshold
  //   where the tine set tightens to 32nds, then swells toward full — losing
  //   the streak mid-climb lets the whole thing exhale back out.
  private updateStreakLoop(i: number, beatAlignDelay: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (!this.streakLoop) {
      this.streakLoop = this.createStreakLoop(t, beatAlignDelay);
      if (!this.streakLoop) return;
    }
    const node = this.streakLoop;
    this.resumeStreakLoopIfReleasing(node, t);
    const rise = Math.max(0, (i - Sound.STREAK_SHIMMER_TIGHTEN_AT) / (1 - Sound.STREAK_SHIMMER_TIGHTEN_AT));
    node.baseGain.gain.setTargetAtTime(Sound.STREAK_LOOP_BASE_GAIN * i, t, Sound.STREAK_SHIMMER_LEVEL_TC);
    node.riseGain.gain.setTargetAtTime(Sound.STREAK_LOOP_RISE_GAIN * rise, t, Sound.STREAK_SHIMMER_LEVEL_TC);
  }

  // Both sources start at the same beat-aligned instant and loop forever —
  //   the stems share their downbeat at sample 0, so they stay phase-locked
  //   for the streak's life (same strategy as the halo music layers).
  private createStreakLoop(t: number, beatAlignDelay: number): StreakLoopNode | null {
    if (!this.ctx || !this.master) return null;
    const baseBuf = this.haloMusicBuffers.get(Sound.STREAK_LOOP_BASE_URL);
    const riseBuf = this.haloMusicBuffers.get(Sound.STREAK_LOOP_RISE_URL);
    if (!baseBuf || !riseBuf) return null;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(1, t);
    out.connect(this.master);
    const startAt = t + Math.max(0, beatAlignDelay);
    const srcs: AudioBufferSourceNode[] = [];
    const layer = (buf: AudioBuffer) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.0001, t); // first update's setTargetAtTime swells it in
      src.connect(g);
      g.connect(out);
      src.start(startAt);
      srcs.push(src);
      return g;
    };
    return {
      out,
      baseGain: layer(baseBuf),
      riseGain: layer(riseBuf),
      srcs,
      releasing: false,
      releaseCleanupTimer: null,
    };
  }

  private resumeStreakLoopIfReleasing(node: StreakLoopNode, t: number) {
    if (!node.releasing) return;
    if (node.releaseCleanupTimer !== null) {
      clearTimeout(node.releaseCleanupTimer);
      node.releaseCleanupTimer = null;
    }
    node.out.gain.cancelScheduledValues(t);
    node.out.gain.setValueAtTime(node.out.gain.value, t);
    node.out.gain.linearRampToValueAtTime(1, t + 0.05);
    node.releasing = false;
  }

  // Streak ended: fade the whole bus out, then stop the loops and tear down.
  private stopStreakLoop() {
    if (!this.streakLoop || !this.ctx) return;
    const node = this.streakLoop;
    if (node.releasing) return;
    const t = this.ctx.currentTime;
    const releaseEnd = t + Sound.STREAK_LOOP_RELEASE_SEC;
    node.out.gain.cancelScheduledValues(t);
    node.out.gain.setValueAtTime(node.out.gain.value, t);
    node.out.gain.linearRampToValueAtTime(0.0001, releaseEnd);
    node.releasing = true;
    node.releaseCleanupTimer = setTimeout(() => {
      if (this.streakLoop !== node) return;
      for (const src of node.srcs) { try { src.stop(); } catch {} }
      try { node.out.disconnect(); } catch {}
      this.streakLoop = null;
    }, Math.ceil(Sound.STREAK_LOOP_RELEASE_SEC * 1000) + 30);
  }

  // Ambient drone played for the lifetime of a broken-open bassteroid. There
  // are 8 voices (4 kinds × 2 sizes), all sitting in a C-major bed so any
  // combination layers without dissonance. Voices are deliberately soft and
  // beatless — they're a *bed* underneath the rhythmic bass hits, not part
  // of the rhythm itself.
  //
  // Pitch map (medium voices sit a fifth below their small counterpart so a
  // medium and its eventual small children form a stacked fifth chord while
  // the field is shattering):
  //   bassA medium = C3 (130.81), small = G4 (392.00)
  //   bassB medium = G3 (196.00), small = D5 (587.33)
  //   bassC medium = E3 (164.81), small = B4 (493.88)
  //   bassD medium = A3 (220.00), small = E5 (659.25)
  //
  // Per-kind timbre (chosen to evoke each kind's percussive voice without
  // repeating it):
  //   bassA = warm filtered sine pad (soft hum)
  //   bassB = detuned sine pair with vibrato (breathy choir)
  //   bassC = sine + sine-fifth (open chorale)
  //   bassD = sine + bandpassed noise (wind-through-metal)
  //
  // The tonal content (oscillators, LFOs, noise) is entirely static per
  // (kind, size) — nothing here is ever live-modulated — so it's rendered
  // once into a seamless baked loop by buildBassteroidDroneGraph and played
  // back as a buffer source. Only the fade-in/out envelope on mainGain and
  // the spatial pan stay live.
  private static readonly BASS_DRONE_MEDIUM_FREQ: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
    bassA: 130.81, bassB: 196.00, bassC: 164.81, bassD: 220.00,
  };
  private static readonly BASS_DRONE_SMALL_FREQ: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
    bassA: 392.00, bassB: 587.33, bassC: 493.88, bassD: 659.25,
  };
  private static readonly BASS_DRONE_KINDS: Array<"bassA" | "bassB" | "bassC" | "bassD"> = ["bassA", "bassB", "bassC", "bassD"];
  private static readonly BASS_DRONE_SIZES: Array<"medium" | "small"> = ["medium", "small"];

  // Seamless-loop length (s) per kind. Every rate baked into a loop — the
  // pulse/vibrato LFOs below AND the audio-rate oscillators (snapped by
  // snapToLoop in buildBassteroidDroneGraph) — completes a whole number of
  // cycles per loop, or the buffer clicks at the seam when it repeats.
  // Original pulse-LFO rates (0.07-0.17Hz) are retuned by <3% to the nearest
  // rate that divides evenly into a clean loop length; inaudible for a slow
  // amplitude swell. bassB additionally carries a 0.6Hz vibrato LFO, which
  // is already a whole number of cycles (9) in 15s.
  //   bassA: 11.0s @ 1/11 Hz  (~0.0909Hz, was 0.09Hz)  — 1 pulse cycle
  //   bassB: 15.0s @ 2/15 Hz (~0.1333Hz, was 0.13Hz) — 2 pulse cycles, 9 vibrato cycles
  //   bassC: 14.0s @ 1/14 Hz  (~0.0714Hz, was 0.07Hz)  — 1 pulse cycle
  //   bassD: 6.0s  @ 1/6 Hz   (~0.1667Hz, was 0.17Hz)  — 1 pulse cycle
  private static readonly BASS_DRONE_LOOP_LEN: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
    bassA: 11.0, bassB: 15.0, bassC: 14.0, bassD: 6.0,
  };
  private static readonly BASS_DRONE_PULSE_RATE: Record<"bassA" | "bassB" | "bassC" | "bassD", number> = {
    bassA: 1 / 11, bassB: 2 / 15, bassC: 1 / 14, bassD: 1 / 6,
  };

  // Headroom scale rendered into each loop's PCM. The raw graph exceeds
  // full scale (bassB's detuned pair beats to twice a single sine, and the
  // lowpass adds resonant gain on top), and encodeWav's 16-bit clamp would
  // hard-clip that into a periodic buzz — the live graph never clipped
  // because mainGain scaled it down while still in float. Playback divides
  // this back out (startBassteroidDrone) so loudness is unchanged.
  private static readonly BASS_DRONE_BAKE_TRIM = 0.25;

  // Encode (kind, size) into the single pitchRatio slot bakedKey offers:
  // kindIndex (0..3 for bassA..bassD) * 2 + sizeIndex (0=medium, 1=small).
  private static bassDroneIndex(kind: "bassA" | "bassB" | "bassC" | "bassD", size: "medium" | "small"): number {
    const kindIndex = Sound.BASS_DRONE_KINDS.indexOf(kind);
    const sizeIndex = size === "medium" ? 0 : 1;
    return kindIndex * 2 + sizeIndex;
  }

  // Renders one seamless bassteroid-drone loop for (kind, size) into `ctx`.
  // Exact original synthesis graph, minus the live per-frame state (there
  // was none to begin with — spatial pan is the only thing that was ever
  // live, and that lives outside this graph). Nothing here reads live
  // state, so it renders identically every time.
  private buildBassteroidDroneGraph(ctx: BaseAudioContext, dest: AudioNode, kind: "bassA" | "bassB" | "bassC" | "bassD", size: "medium" | "small") {
    const len = Sound.BASS_DRONE_LOOP_LEN[kind];
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const baseFreq = size === "medium" ? Sound.BASS_DRONE_MEDIUM_FREQ[kind] : Sound.BASS_DRONE_SMALL_FREQ[kind];

    // Lowpass kept conservative so even the brighter D voice never bites.
    // The cutoff sits one octave above the fundamental for mediums and a
    // little tighter (×1.6) for smalls to keep the high voices from getting
    // shrill when several are present.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.2;
    filter.frequency.value = size === "medium" ? baseFreq * 2.2 : baseFreq * 1.6;

    // Slow amplitude swell — each kind gets a different LFO rate so two
    // pieces of different kinds don't beat in lockstep. Rates are all in the
    // 0.07–0.18 Hz range (5–14 second period) so the bed reads as gently
    // breathing rather than pulsing.
    const pulseLfo = ctx.createOscillator();
    pulseLfo.type = "sine";
    pulseLfo.frequency.value = Sound.BASS_DRONE_PULSE_RATE[kind];
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.35;
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0.65;
    pulseLfo.connect(pulseDepth);
    pulseDepth.connect(pulseGain.gain);

    const trim = ctx.createGain();
    trim.gain.value = Sound.BASS_DRONE_BAKE_TRIM;
    filter.connect(pulseGain);
    pulseGain.connect(trim);
    trim.connect(dest);

    if (kind === "bassA") {
      // Warm filtered sine pad — single sine, soft.
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = Sound.snapToLoop(baseFreq, len);
      osc.connect(filter);
      osc.start(0);
      osc.stop(renderLen);
    } else if (kind === "bassB") {
      // Detuned sine pair with slow vibrato → breathy choir character.
      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      oscA.type = "sine";
      oscB.type = "sine";
      oscA.frequency.value = Sound.snapToLoop(baseFreq, len);
      oscB.frequency.value = Sound.snapToLoop(baseFreq * 1.008, len);
      const vib = ctx.createOscillator();
      vib.type = "sine";
      vib.frequency.value = Sound.snapToLoop(0.6, len);
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = baseFreq * 0.004;
      vib.connect(vibDepth);
      vibDepth.connect(oscA.frequency);
      vibDepth.connect(oscB.frequency);
      oscA.connect(filter);
      oscB.connect(filter);
      oscA.start(0);
      oscB.start(0);
      vib.start(0);
      oscA.stop(renderLen);
      oscB.stop(renderLen);
      vib.stop(renderLen);
    } else if (kind === "bassC") {
      // Open chorale — root + perfect fifth above. Both sines so the
      // interval reads as harmonic colour rather than a separate voice.
      const root = ctx.createOscillator();
      const fifth = ctx.createOscillator();
      root.type = "sine";
      fifth.type = "sine";
      root.frequency.value = Sound.snapToLoop(baseFreq, len);
      fifth.frequency.value = Sound.snapToLoop(baseFreq * 1.5, len);
      const fifthGain = ctx.createGain();
      fifthGain.gain.value = 0.45; // fifth quieter than root so it just tints
      root.connect(filter);
      fifth.connect(fifthGain);
      fifthGain.connect(filter);
      root.start(0);
      fifth.start(0);
      root.stop(renderLen);
      fifth.stop(renderLen);
    } else {
      // bassD — sine + narrow bandpassed noise for a wind-through-metal hush.
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = Sound.snapToLoop(baseFreq, len);
      osc.connect(filter);
      osc.start(0);
      osc.stop(renderLen);

      // Local noise buffer built directly against the offline ctx — can't
      // use this.makeNoiseBuffer here, it's tied to the live ctx + a shared
      // cache (see buildChargeBedGraph's noiseFor for the same pattern).
      // Exactly one loop long and looped, so the noise layer repeats with
      // the loop period and the seam splices identical noise.
      const n = Math.max(1, Math.round(ctx.sampleRate * len));
      const noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;

      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      noise.loop = true;
      const nBp = ctx.createBiquadFilter();
      nBp.type = "bandpass";
      nBp.Q.value = 8;
      nBp.frequency.value = baseFreq * 2;
      const nGain = ctx.createGain();
      nGain.gain.value = 0.18; // breath, not hiss
      noise.connect(nBp);
      nBp.connect(nGain);
      nGain.connect(filter);
      noise.start(0);
      noise.stop(renderLen);
    }

    pulseLfo.start(0);
    pulseLfo.stop(renderLen);
  }

  // Warm all 8 committed bassteroid-drone loops (4 kinds × 2 sizes).
  private prerenderBassteroidDrones() {
    for (let i = 0; i < Sound.BASS_DRONE_KINDS.length * Sound.BASS_DRONE_SIZES.length; i++) {
      this.demandBake("bassteroidDrone", i);
    }
  }

  startBassteroidDrone(key: object, kind: "bassA" | "bassB" | "bassC" | "bassD", size: "medium" | "small", pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.bassDrones.has(key)) return;
    const index = Sound.bassDroneIndex(kind, size);
    const buf = this.bakedBuffers.get(this.bakedKey("bassteroidDrone", index));
    if (!buf) {
      // Bake hasn't landed yet (or failed) — kick it for next time and bail.
      this.prerenderBassteroidDrones();
      return;
    }
    const t = this.ctx.currentTime;
    const spatial = pos ? this.makeSpatial(pos, this.master) : null;
    const sink: AudioNode = spatial ? spatial.panner : this.master;

    // Per-size base loudness. Several drones will commonly stack (a single
    // medium that splits gives 2 smalls, two mediums give 4 smalls, etc.),
    // so each voice is intentionally quiet. Mediums get a touch more body
    // than smalls so the lower octave still anchors the mix when present.
    // Dividing the bake trim back out restores the live graph's level.
    const peakBase = (size === "medium" ? 0.035 : 0.022) / Sound.BASS_DRONE_BAKE_TRIM;

    const { src, startOffset } = this.makeBakedLoopSource(buf, Sound.BASS_DRONE_LOOP_LEN[kind]);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    // ~1.4s fade-in so the drone arrives as the piece settles, not as a pop.
    mainGain.gain.exponentialRampToValueAtTime(peakBase, t + 1.4);

    src.connect(mainGain);
    mainGain.connect(sink);
    src.start(t, startOffset);

    this.bassDrones.set(key, { src, mainGain, spatial: spatial ?? undefined });
  }

  updateBassteroidDrone(key: object, pos: Pos) {
    const node = this.bassDrones.get(key);
    if (!node || !node.spatial) return;
    this.updateSpatial(node.spatial, pos);
  }

  stopBassteroidDrone(key: object) {
    if (!this.ctx) return;
    const node = this.bassDrones.get(key);
    if (!node) return;
    const t = this.ctx.currentTime;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    const stopAt = t + 0.4;
    node.src.stop(stopAt);
    this.bassDrones.delete(key);
  }

  stopAllBassteroidDrones() {
    for (const key of Array.from(this.bassDrones.keys())) this.stopBassteroidDrone(key);
  }

  // Comet melody: a slow C-aeolian phrase that layers on top of the halo
  // ambient pad (C–G + Eb-in-comet-mode = C minor triad). Pitches are drawn
  // from C minor pentatonic (C / Eb / F / G / Bb) so every note is consonant
  // with both the pad's C–G–Eb foundation and the halo melody's mode-safe
  // C/D/F/G line. The looming quality comes from the timbre + lower octave
  // and one ornamental Db (b2) grace step per phrase, not from a permanent
  // tritone cluster — the b2 visits and resolves rather than sustaining and
  // muddying the pad.
  //
  // Step rate: one note every 2 BEAT_GRID ticks (1.0 s), matching the halo
  // melody's pulse so the two lines hocket cleanly. The phrase is 8 steps ×
  // 1.0 s = 8 s = 4 bass measures. Indices 0 and 4 are the phrase downbeats
  // (sustained); 3 is the one octave-lift; 5 is a deliberate rest so the
  // halo melody's bright C5 step has the floor; 7 is the b2 grace tension.
  //
  // Shape: G3 → Eb3 (downward yield) → F3 → ↑G4 (lift, octave answer) →
  //        Eb3 → rest → Bb3 → Db3-grace (the one ornamental tension that
  //        immediately bows back toward C the next phrase).
  private static readonly COMET_MELODY: (number | null)[] = [
    196.00,  // G3   — downbeat: pad's fifth, anchors the new entry
    155.56,  // Eb3  — the b3 colour from the pad's third voice an octave down
    174.61,  // F3   — neighbour-tone, sets up the lift
    392.00,  // G4   — octave lift, one bright reach per phrase
    155.56,  // Eb3  — settles back to the b3
    null,    // rest — gives the halo melody's C5/G3 step the floor
    233.08,  // Bb3  — pentatonic colour pitch, dark but consonant
    138.59,  // Db3  — single low grace note: phrygian b2 flavour, low enough
             //        and short enough that it tints rather than collides
  ];

  // Fire one note of the comet melody. `step` is the global step index since
  // the comet appeared; we modulo into the melody table so the phrase loops
  // smoothly for as long as the comet is on screen. Velocity ducks on the
  // ornamental Db grace step so the b2 tension passes by rather than lands;
  // downbeats and the octave lift get longer durations so the pad-blend is
  // felt, while interior steps stay short to leave space for the halo line.
  playCometNote(step: number) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx) return;
    const melody = Sound.COMET_MELODY;
    const idx = ((step % melody.length) + melody.length) % melody.length;
    if (melody[idx] === null) return;
    // pitchRatio encodes the melody index — see warmBakedCache / bakeSound.
    this.playBaked("cometNote", idx);
  }

  // Ominous voice held under the comet's entire lifetime. Begins with a
  // big "shhwwwoorrr" — a wide noise band sweeping from high down to mid —
  // plus a short-lived dissonant cluster (Db2 + F#2 over the C2 root) that
  // makes the arrival feel like something *wrong* is approaching. After
  // ~3 s the tension voices fade out entirely, leaving a stable low C-minor
  // triad (C2 + Eb2 + G2) that matches the halo ambient pad's C–G–Eb voicing
  // an octave down. The bed therefore layers with the halo pad rather than
  // muddying it: same chord, deeper register, slow tremolo for life.
  // Also briefly ducks the halo pad during the entrance so the arrival
  // reads as a dramatic event that the music bows to, then everyone
  // re-balances together.
  startCometShimmer(key: object, pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;

    // The comet voice is built on the legacy WebAudio path for both engines —
    // the bandpass-swept noise + saw-cluster drone is easier to express here
    // than in Tone, and in tone-engine mode the legacy bus already routes
    // through the same compressor/limiter chain, so polish is shared.
    if (this.cometShimmers.has(key)) return;
    const t = this.ctx.currentTime;
    const spatial = pos ? this.makeSpatial(pos, this.master) : null;
    const sink: AudioNode = spatial ? spatial.panner : this.master;

    // ── Master comet voice gain ──────────────────────────────────────────
    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    // Big swell up over the FADE_IN window so the entrance lands hard.
    // Fade-in window matches Comet.FADE_IN (1.6s) so the audio swell tracks
    // the visual bloom landing.
    const audioFadeIn = 1.6;
    mainGain.gain.exponentialRampToValueAtTime(0.32, t + audioFadeIn);
    // Then ease back to a sustained but quieter drone level so the melody
    // notes have headroom to cut through.
    mainGain.gain.exponentialRampToValueAtTime(0.085, t + audioFadeIn + 2.0);
    mainGain.connect(sink);

    const oscs: OscillatorNode[] = [];
    const lfos: OscillatorNode[] = [];

    // ── "Shhwwwoorrr" entrance: bandpass-swept noise ────────────────────
    // 6 seconds of looped pink-ish noise routed through a bandpass that
    // sweeps from ~5kHz down to ~600Hz over the first ~3 seconds — gives
    // the classic "approaching from a distance" wind/whoosh, then tails
    // off into the drone bed.
    const noiseBuf = this.makeNoiseBuffer(8);
    if (noiseBuf) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      noise.loop = true;

      const noiseBp = this.ctx.createBiquadFilter();
      noiseBp.type = "bandpass";
      noiseBp.Q.value = 2.4;
      noiseBp.frequency.setValueAtTime(5200, t);
      noiseBp.frequency.exponentialRampToValueAtTime(1200, t + 1.6);
      noiseBp.frequency.exponentialRampToValueAtTime(620, t + 3.2);
      // A slow LFO on the bandpass after the sweep gives the drone its
      // restless, breathing quality — the wind never settles.
      const sweepLfo = this.ctx.createOscillator();
      sweepLfo.type = "sine";
      sweepLfo.frequency.value = 0.09;
      const sweepDepth = this.ctx.createGain();
      sweepDepth.gain.value = 220;
      sweepLfo.connect(sweepDepth);
      sweepDepth.connect(noiseBp.frequency);
      sweepLfo.start(t + 3.2);

      const noiseGain = this.ctx.createGain();
      // The whoosh is loud at entry, then drops to a thin hiss under the
      // drone. Time these to the master swell.
      noiseGain.gain.setValueAtTime(0.0001, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.85, t + 0.45);
      noiseGain.gain.exponentialRampToValueAtTime(0.55, t + 2.0);
      noiseGain.gain.exponentialRampToValueAtTime(0.12, t + 4.5);

      noise.connect(noiseBp);
      noiseBp.connect(noiseGain);
      noiseGain.connect(mainGain);
      noise.start(t);

      // Track the noise source under oscs so stopCometShimmer cleans it up.
      // (OscillatorNode and AudioBufferSourceNode both have .stop, and the
      // cleanup loop only calls .stop — close enough that we can store as
      // OscillatorNode for the type without runtime fallout.)
      oscs.push(noise as unknown as OscillatorNode);
      lfos.push(sweepLfo);
    }

    // ── Sustained drone bed (life of the comet) ────────────────────────
    // Low C-minor triad — C2 (65.4) + Eb2 (77.8) + G2 (98.0). Same chord the
    // halo ambient pad outlines in comet mode (C3 + Eb4 + G3), an octave
    // down, so the comet bed reinforces the pad's harmonic root instead of
    // fighting it. Each voice is two slightly detuned sawtooths through a
    // dark lowpass, so the triad reads as a thick rumble rather than three
    // distinct pitches.
    const sustainFreqs = [65.41, 77.78, 98.00]; // C2, Eb2, G2
    const sustainLevels = [0.55, 0.30, 0.34];
    const tremRates = [0.07, 0.11, 0.13];

    const droneFilter = this.ctx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.Q.value = 1.4;
    // Filter opens during the entry then settles dark — gives the bed a slow
    // unwrapping quality that matches the visual bloom.
    droneFilter.frequency.setValueAtTime(400, t);
    droneFilter.frequency.exponentialRampToValueAtTime(1100, t + 2.5);
    droneFilter.frequency.exponentialRampToValueAtTime(620, t + 6.0);
    droneFilter.connect(mainGain);

    for (let i = 0; i < sustainFreqs.length; i++) {
      const f = sustainFreqs[i];
      const oscA = this.ctx.createOscillator();
      const oscB = this.ctx.createOscillator();
      oscA.type = "sawtooth";
      oscB.type = "sawtooth";
      oscA.frequency.value = f;
      oscB.frequency.value = f * 1.011;

      const trem = this.ctx.createOscillator();
      trem.type = "sine";
      trem.frequency.value = tremRates[i];
      const tremDepth = this.ctx.createGain();
      tremDepth.gain.value = 0.4;
      const voiceGain = this.ctx.createGain();
      voiceGain.gain.value = sustainLevels[i];
      trem.connect(tremDepth);
      tremDepth.connect(voiceGain.gain);

      oscA.connect(voiceGain);
      oscB.connect(voiceGain);
      voiceGain.connect(droneFilter);

      oscA.start(t);
      oscB.start(t);
      trem.start(t);

      oscs.push(oscA, oscB);
      lfos.push(trem);
    }

    // ── Transient tension cluster (entrance only) ───────────────────────
    // Db2 (b2, "wrong note") and F#2 (tritone, "diabolus") swell in with
    // the whoosh and fade out fully by ~3.5s. The brief collision makes the
    // arrival feel ominous, but the cluster doesn't sustain — once the
    // melody starts singing, the bed is the pure C-minor triad above.
    const tensionFreqs = [69.30, 92.50]; // Db2, F#2
    const tensionPeaks = [0.16, 0.20];
    for (let i = 0; i < tensionFreqs.length; i++) {
      const f = tensionFreqs[i];
      const oscA = this.ctx.createOscillator();
      const oscB = this.ctx.createOscillator();
      oscA.type = "sawtooth";
      oscB.type = "sawtooth";
      oscA.frequency.value = f;
      oscB.frequency.value = f * 1.011;

      const voiceGain = this.ctx.createGain();
      voiceGain.gain.setValueAtTime(0.0001, t);
      voiceGain.gain.exponentialRampToValueAtTime(tensionPeaks[i], t + 0.7);
      // Hold briefly, then fade out to silence by t+3.5s — by the time the
      // first melody note plays (typically t+~1–2s on the next downbeat),
      // these tension voices are already on their way out.
      voiceGain.gain.exponentialRampToValueAtTime(tensionPeaks[i] * 0.6, t + 1.6);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);

      oscA.connect(voiceGain);
      oscB.connect(voiceGain);
      voiceGain.connect(droneFilter);

      oscA.start(t);
      oscB.start(t);
      // Stop the voices after they're inaudible so we don't keep silent
      // oscillators alive for the comet's entire lifetime.
      oscA.stop(t + 3.6);
      oscB.stop(t + 3.6);
      // Not pushed into oscs[] because they self-terminate before
      // stopCometShimmer runs — adding them would re-call .stop() on a
      // node that's already ended, which is harmless but noisy in DevTools.
    }

    // ── Brief duck on the halo ambient pad during the entrance ──────────
    // If the player has the halo up (combo ≥ 4) when the comet arrives,
    // bow the pad ~6 dB for the duration of the whoosh, then restore.
    // Makes the comet's entry feel like the music yielding to a new
    // presence — small dramatic gesture, paid back as everything balances.
    if (this.haloAmbient) {
      const hG = this.haloAmbient.mainGain.gain;
      const current = hG.value;
      hG.cancelScheduledValues(t);
      hG.setValueAtTime(current, t);
      hG.exponentialRampToValueAtTime(Math.max(current * 0.45, 0.0001), t + 0.5);
      // Hold the duck through the whoosh peak, then unduck over ~2.5s so the
      // pad re-emerges naturally as the comet bed settles.
      hG.setValueAtTime(Math.max(current * 0.45, 0.0001), t + 1.8);
      hG.exponentialRampToValueAtTime(Math.max(current, 0.0001), t + 4.3);
    }

    this.cometShimmers.set(key, { oscs, lfos, mainGain, spatial: spatial ?? undefined });
  }

  updateCometShimmer(key: object, pos: Pos) {
    const node = this.cometShimmers.get(key);
    if (!node || !node.spatial) return;
    this.updateSpatial(node.spatial, pos);
  }

  stopCometShimmer(key: object) {
    if (!this.ctx) return;
    const node = this.cometShimmers.get(key);
    if (!node) return;
    const t = this.ctx.currentTime;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.0 /* COMET_FADE_OUT */);
    const stopAt = t + 2.0 /* COMET_FADE_OUT */ + 0.1;
    for (const o of node.oscs) o.stop(stopAt);
    for (const l of node.lfos) l.stop(stopAt);
    this.cometShimmers.delete(key);
  }

  // Big explosive-into-quiet death sound for an on-beat player-destroyed comet.
  // Plays on top of (and louder than) the comet's own drone, which continues
  // its normal ~2s fade-out via stopCometShimmer. Pre-baked — see
  // buildCometDestroyedGraph for the actual synthesis.
  playCometDestroyed() {
    this.playBaked("cometDestroyed", 1);
  }

  // The comet-hit graph, built into `ctx` ending at `dest`, with time origin 0.
  // Shared by the offline bake (see bakeSound's cometDestroyed case) — the live
  // playCometDestroyed just plays the resulting baked buffer. Self-contained
  // (generates its own noise) so it renders identically in an OfflineAudioContext.
  // Begins with a sharp white-noise crack + low sub-thump (the explosion impact)
  // and resolves into a long noise + sub drone that fades out over 15 seconds —
  // the wreckage echoing through the void.
  private buildCometDestroyedGraph(ctx: BaseAudioContext, dest: AudioNode) {
    const TAIL = 15.0;
    const noiseFor = (dur: number): AudioBuffer => {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    };

    // ── Initial crack: short broadband noise burst with a fast HP→LP
    // sweep so it reads as "explosion now, then debris".
    const crack = ctx.createBufferSource();
    crack.buffer = noiseFor(0.4);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = "lowpass";
    crackFilter.Q.value = 0.9;
    crackFilter.frequency.setValueAtTime(8000, 0);
    crackFilter.frequency.exponentialRampToValueAtTime(1400, 0.18);
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.85, 0);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, 0.35);
    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(dest);
    crack.start(0);
    crack.stop(0.4);

    // ── Sub-bass thump: pitched sine sweep from ~120Hz down to ~30Hz.
    // The chest-thump under the crack — gives the explosion physical weight.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(140, 0);
    sub.frequency.exponentialRampToValueAtTime(30, 0.9);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, 0);
    subGain.gain.exponentialRampToValueAtTime(0.55, 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0001, 1.4);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(0);
    sub.stop(1.5);

    // ── Long tail: looped pink noise through a slow-closing bandpass.
    // After the initial crack settles, the noise band drops from ~1200Hz
    // down to ~80Hz over the 15-second tail, so the "wreckage" gets
    // duller (more felt than heard) as it fades.
    const tail = ctx.createBufferSource();
    tail.buffer = noiseFor(4);
    tail.loop = true;
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = "bandpass";
    tailFilter.Q.value = 1.6;
    tailFilter.frequency.setValueAtTime(2400, 0);
    tailFilter.frequency.exponentialRampToValueAtTime(1200, 0.6);
    tailFilter.frequency.exponentialRampToValueAtTime(80, TAIL);
    const tailGain = ctx.createGain();
    // Big at the impact, then a long exponential fade to silence at
    // exactly TAIL seconds. The shape uses two segments so the first
    // ~2s of tail are still meaty before the long quiet fade takes over.
    tailGain.gain.setValueAtTime(0.0001, 0);
    tailGain.gain.exponentialRampToValueAtTime(0.45, 0.05);
    tailGain.gain.exponentialRampToValueAtTime(0.18, 2.0);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, TAIL);
    tail.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(dest);
    tail.start(0);
    tail.stop(TAIL + 0.2);

    // ── Sub-drone under the tail: low sawtooth that hums for the full
    // 15s. Gives the fade a tangible low-end presence so the player can
    // still feel the comet's ghost long after the visual is gone.
    const droneRoot = ctx.createOscillator();
    const droneOct = ctx.createOscillator();
    droneRoot.type = "sawtooth";
    droneOct.type = "sawtooth";
    droneRoot.frequency.value = 49.0; // G1 — sits below the bassteroid bed
    droneOct.frequency.value = 49.0 * 1.013; // wide detune for slow beating
    const droneLp = ctx.createBiquadFilter();
    droneLp.type = "lowpass";
    droneLp.Q.value = 0.8;
    droneLp.frequency.setValueAtTime(600, 0);
    droneLp.frequency.exponentialRampToValueAtTime(120, TAIL);
    const droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, 0);
    droneGain.gain.exponentialRampToValueAtTime(0.22, 0.4);
    droneGain.gain.exponentialRampToValueAtTime(0.0001, TAIL);
    droneRoot.connect(droneLp);
    droneOct.connect(droneLp);
    droneLp.connect(droneGain);
    droneGain.connect(dest);
    droneRoot.start(0);
    droneOct.start(0);
    droneRoot.stop(TAIL + 0.2);
    droneOct.stop(TAIL + 0.2);
  }

  // Sadder sibling of playCometDestroyed for off-rhythm comet kills. Pre-baked
  // — see buildCometDestroyedSadGraph for the synthesis.
  playCometDestroyedSad() {
    this.playBaked("cometDestroyedSad", 1);
  }

  // The off-beat comet-hit graph, built into `ctx` ending at `dest`, time
  // origin 0. Shared by the offline bake (see bakeSound's cometDestroyedSad
  // case). Same overall shape as buildCometDestroyedGraph (crack → sub thump →
  // noise tail → low drone) but smaller, duller, and with a descending pitched
  // sigh layered on top. The drone sits a minor-6th lower (Eb1 vs G1) for a
  // darker root, the tail collapses in ~6s instead of 15s, and the sub thump
  // ends on a falling minor-third sine sigh — the "aww" of wasting the moment.
  private buildCometDestroyedSadGraph(ctx: BaseAudioContext, dest: AudioNode) {
    const TAIL = 6.0;
    const noiseFor = (dur: number): AudioBuffer => {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    };

    // Softer crack — duller, quicker decay so it reads as a fizzle.
    const crack = ctx.createBufferSource();
    crack.buffer = noiseFor(0.3);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = "lowpass";
    crackFilter.Q.value = 0.9;
    crackFilter.frequency.setValueAtTime(4500, 0);
    crackFilter.frequency.exponentialRampToValueAtTime(900, 0.18);
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.55, 0);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, 0.28);
    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(dest);
    crack.start(0);
    crack.stop(0.32);

    // Sub thump — softer than the celebratory variant and lower start pitch.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(110, 0);
    sub.frequency.exponentialRampToValueAtTime(28, 1.0);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, 0);
    subGain.gain.exponentialRampToValueAtTime(0.38, 0.015);
    subGain.gain.exponentialRampToValueAtTime(0.0001, 1.3);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(0);
    sub.stop(1.4);

    // Descending sigh — soft sine falling a minor third (G4 → E4 → C4-ish),
    // the audible "aww" that tells the player they missed the rhythm window.
    const sigh = ctx.createOscillator();
    sigh.type = "sine";
    sigh.frequency.setValueAtTime(392, 0.05); // G4
    sigh.frequency.exponentialRampToValueAtTime(311, 0.55); // Eb4
    sigh.frequency.exponentialRampToValueAtTime(220, 1.5); // A3 — settles below
    const sighGain = ctx.createGain();
    sighGain.gain.setValueAtTime(0.0001, 0.05);
    sighGain.gain.exponentialRampToValueAtTime(0.12, 0.15);
    sighGain.gain.exponentialRampToValueAtTime(0.0001, 1.8);
    sigh.connect(sighGain);
    sighGain.connect(dest);
    sigh.start(0.05);
    sigh.stop(1.85);

    // Short noise tail — bandpass collapses quickly so the wreckage clears
    // in ~6s instead of lingering for 15. The comet didn't get to sing.
    const tail = ctx.createBufferSource();
    tail.buffer = noiseFor(3);
    tail.loop = true;
    const tailFilter = ctx.createBiquadFilter();
    tailFilter.type = "bandpass";
    tailFilter.Q.value = 1.8;
    tailFilter.frequency.setValueAtTime(1400, 0);
    tailFilter.frequency.exponentialRampToValueAtTime(500, 0.6);
    tailFilter.frequency.exponentialRampToValueAtTime(60, TAIL);
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.0001, 0);
    tailGain.gain.exponentialRampToValueAtTime(0.22, 0.05);
    tailGain.gain.exponentialRampToValueAtTime(0.08, 1.2);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, TAIL);
    tail.connect(tailFilter);
    tailFilter.connect(tailGain);
    tailGain.connect(dest);
    tail.start(0);
    tail.stop(TAIL + 0.2);

    // Low drone — tuned to Eb1 (~38.9Hz), a minor-6th below the celebratory
    // G1, so the harmonic root reads as "minor key" instead of open root.
    const droneRoot = ctx.createOscillator();
    const droneOct = ctx.createOscillator();
    droneRoot.type = "sawtooth";
    droneOct.type = "sawtooth";
    droneRoot.frequency.value = 38.9; // Eb1
    droneOct.frequency.value = 38.9 * 1.011;
    const droneLp = ctx.createBiquadFilter();
    droneLp.type = "lowpass";
    droneLp.Q.value = 0.8;
    droneLp.frequency.setValueAtTime(500, 0);
    droneLp.frequency.exponentialRampToValueAtTime(100, TAIL);
    const droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, 0);
    droneGain.gain.exponentialRampToValueAtTime(0.16, 0.4);
    droneGain.gain.exponentialRampToValueAtTime(0.0001, TAIL);
    droneRoot.connect(droneLp);
    droneOct.connect(droneLp);
    droneLp.connect(droneGain);
    droneGain.connect(dest);
    droneRoot.start(0);
    droneOct.start(0);
    droneRoot.stop(TAIL + 0.2);
    droneOct.stop(TAIL + 0.2);
  }

  // The bonus-life graph, built into `ctx` ending at `dest`, time origin 0.
  // Shared by the offline bake (see bakeSound's bonusLife case). This is
  // buildCometDestroyedGraph transposed into GRACE: same crack → sub → long
  // tail → low drone architecture (so it inherits the comet-hit's huge,
  // resonating, echoing-through-the-void character), but
  //   • the crack is much softer and shorter — a gentle strike, not an explosion;
  //   • the wreckage noise-band is replaced by a C-MAJOR chord of detuned
  //     "choir" voices that enter one by one from the root upward — an
  //     audible bloom UP — and ring for the full tail;
  //   • the sub and low drone land on a MAJOR root (C) instead of the comet's
  //     ambiguous G1, so the whole thing sits consonant and radiant.
  private buildBonusLifeGraph(ctx: BaseAudioContext, dest: AudioNode) {
    const TAIL = 15.0;
    const noiseFor = (dur: number): AudioBuffer => {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    };

    // ── Soft strike: a gentle filtered-noise chiff instead of the comet's hard
    // crack. Much quieter, darker, and quicker to clear — it gives the swell an
    // onset to lock to without reading as an explosion. ("less crack.")
    const chiff = ctx.createBufferSource();
    chiff.buffer = noiseFor(0.3);
    const chiffFilter = ctx.createBiquadFilter();
    chiffFilter.type = "lowpass";
    chiffFilter.Q.value = 0.7;
    chiffFilter.frequency.setValueAtTime(3200, 0);
    chiffFilter.frequency.exponentialRampToValueAtTime(900, 0.16);
    const chiffGain = ctx.createGain();
    chiffGain.gain.setValueAtTime(0.14, 0);
    chiffGain.gain.exponentialRampToValueAtTime(0.0001, 0.3);
    chiff.connect(chiffFilter);
    chiffFilter.connect(chiffGain);
    chiffGain.connect(dest);
    chiff.start(0);
    chiff.stop(0.34);

    // ── Glass ping: a soft celesta-like strike at the flash instant — the
    // choir blooms in slowly, so this gives the milestone a clear, pitched
    // anchor right at t=0. Voiced on the halo's note an octave-pair up, so
    // the ping pre-echoes the light that later arrives sustained.
    const PING = [
      { hz: 1046.5, peak: 0.2, decay: 0.8 }, // C6
      { hz: 2093.0, peak: 0.06, decay: 0.35 }, // C7
    ];
    for (const p of PING) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = p.hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(p.peak, 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, p.decay);
      osc.connect(g);
      g.connect(dest);
      osc.start(0);
      osc.stop(p.decay + 0.05);
    }

    // ── Sub swell: a sine that RISES an octave onto the C root (C1 → C2).
    // The attack is a swell rather than a thump so the low end blooms with
    // the choir instead of front-loading the whole sound at the strike.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(32.7, 0); // C1
    sub.frequency.exponentialRampToValueAtTime(65.41, 0.5); // → C2
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, 0);
    subGain.gain.exponentialRampToValueAtTime(0.42, 0.22);
    subGain.gain.exponentialRampToValueAtTime(0.0001, 2.6);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(0);
    sub.stop(2.7);

    // ── Choir: the resonating angelic body. An open C-major voicing (C4 G4
    // C5 E5 G5 — no low third, so it reads luminous rather than thick) of
    // triangle voices entering one by one from the root upward, each with its
    // own soft attack: the chord audibly blooms UP like a strummed harp.
    // Each voice is a trio — a center oscillator plus a pair split by a fixed
    // beat RATE (not fixed cents, which made the top voices flutter): every
    // voice shimmers at the same slow ensemble speed, and the center tone
    // keeps the shimmer from ever dipping to a null. A shared lowpass opens
    // brighter through the bloom (the "aah" forming), then slowly closes as
    // the tail rings out — and the tail's ring is shallow for most of its
    // length so the echo genuinely lasts, dropping to silence only at the end.
    const CHORD_HZ = [261.63, 392.00, 523.25, 659.25, 783.99]; // C4 G4 C5 E5 G5
    // Lower voices are louder so the chord is rooted, not top-heavy.
    const voicePeak = [0.17, 0.14, 0.12, 0.10, 0.09];
    const choirLp = ctx.createBiquadFilter();
    choirLp.type = "lowpass";
    choirLp.Q.value = 0.6;
    choirLp.frequency.setValueAtTime(700, 0);
    choirLp.frequency.exponentialRampToValueAtTime(3000, 3.5);
    choirLp.frequency.exponentialRampToValueAtTime(850, TAIL);
    const choirGain = ctx.createGain();
    choirGain.gain.setValueAtTime(0.0001, 0);
    choirGain.gain.exponentialRampToValueAtTime(0.55, 0.9);
    choirGain.gain.setValueAtTime(0.55, 1.6);
    choirGain.gain.exponentialRampToValueAtTime(0.18, 6.0);
    choirGain.gain.exponentialRampToValueAtTime(0.0045, 13.5);
    choirGain.gain.exponentialRampToValueAtTime(0.0001, TAIL);
    choirLp.connect(choirGain);
    choirGain.connect(dest);
    for (let i = 0; i < CHORD_HZ.length; i++) {
      const at = i * 0.12;
      const beatHz = 1.5 + i * 0.15;
      const vGain = ctx.createGain();
      vGain.gain.setValueAtTime(0.0001, at);
      vGain.gain.exponentialRampToValueAtTime(voicePeak[i], at + 0.4);
      vGain.connect(choirLp);
      for (const offset of [-beatHz / 2, 0, beatHz / 2]) {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = CHORD_HZ[i] + offset;
        osc.connect(vGain);
        osc.start(at);
        osc.stop(TAIL + 0.2);
      }
    }

    // ── Halo: a pair of pure sines two octaves up (C6 + G6) that swell in
    // slowly AFTER the chord has formed and hover above it — the radiant
    // "light arriving" layer the triangle chord can't reach on its own.
    const HALO_HZ = [1046.5, 1567.98]; // C6 G6
    const haloPeak = [0.05, 0.024];
    for (let i = 0; i < HALO_HZ.length; i++) {
      const hGain = ctx.createGain();
      hGain.gain.setValueAtTime(0.0001, 0.6);
      hGain.gain.exponentialRampToValueAtTime(haloPeak[i], 2.4);
      hGain.gain.exponentialRampToValueAtTime(0.0001, 12.0);
      hGain.connect(dest);
      for (const offset of [-0.6, 0.6]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = HALO_HZ[i] + offset;
        osc.connect(hGain);
        osc.start(0.6);
        osc.stop(12.1);
      }
    }

    // ── Air: a quiet band of breath-noise above the chord — the "voices in a
    // big space" sheen. Swells with the halo and clears well before the tail
    // ends so the ring-out is pure tone.
    const air = ctx.createBufferSource();
    air.buffer = noiseFor(9.0);
    const airBp = ctx.createBiquadFilter();
    airBp.type = "bandpass";
    airBp.frequency.value = 2600;
    airBp.Q.value = 1.1;
    const airGain = ctx.createGain();
    airGain.gain.setValueAtTime(0.0001, 0);
    airGain.gain.exponentialRampToValueAtTime(0.05, 1.8);
    airGain.gain.exponentialRampToValueAtTime(0.0001, 9.0);
    air.connect(airBp);
    airBp.connect(airGain);
    airGain.connect(dest);
    air.start(0);
    air.stop(9.1);

    // ── Low drone under the choir: a sawtooth pair on the C root an octave
    // above the comet-kill's floor (C2 — the sub's landing note), slow-beating
    // and humming the whole tail. High enough to sound on small speakers and
    // stay out of the rumble zone, low enough to ground the chord.
    const droneRoot = ctx.createOscillator();
    const droneOct = ctx.createOscillator();
    droneRoot.type = "sawtooth";
    droneOct.type = "sawtooth";
    droneRoot.frequency.value = 65.41; // C2
    droneOct.frequency.value = 65.41 * 1.006;
    const droneLp = ctx.createBiquadFilter();
    droneLp.type = "lowpass";
    droneLp.Q.value = 0.8;
    droneLp.frequency.setValueAtTime(420, 0);
    droneLp.frequency.exponentialRampToValueAtTime(100, TAIL);
    const droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, 0);
    droneGain.gain.exponentialRampToValueAtTime(0.13, 0.6);
    droneGain.gain.exponentialRampToValueAtTime(0.008, 13.5);
    droneGain.gain.exponentialRampToValueAtTime(0.0001, TAIL);
    droneRoot.connect(droneLp);
    droneOct.connect(droneLp);
    droneLp.connect(droneGain);
    droneGain.connect(dest);
    droneRoot.start(0);
    droneOct.start(0);
    droneRoot.stop(TAIL + 0.2);
    droneOct.stop(TAIL + 0.2);
  }

  // One-shot entrance for a meteor shower — bigger and more aggressive than the
  // lone comet's slow "shhwwwoorrr". The flock arrives fast, so the cue is a
  // hard descending shriek (a stack of detuned saws screaming downward) over a
  // chest-punch sub boom and a bright broadband streak that whips across the
  // stereo field. It announces "many fast bodies, NOW" rather than "a distant
  // visitor approaches", and clears in ~2.5s so it doesn't muddy the bass bed.
  playMeteorShower() {
    if (!this.enabled) return;
    this.ensureContext();
    if (this.playBaked("meteorShower", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildMeteorShowerGraph(this.ctx, this.master, this.voiceTime("meteorShower"));
  }

  private buildMeteorShowerGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    // ── Descending shriek: three detuned saws screaming from ~1.8kHz down to
    // ~180Hz over 0.7s through a resonant lowpass that tracks them, so the
    // sweep reads as a single fat falling tone with teeth.
    const shriekLp = ctx.createBiquadFilter();
    shriekLp.type = "lowpass";
    shriekLp.Q.value = 6;
    shriekLp.frequency.setValueAtTime(2400, t);
    shriekLp.frequency.exponentialRampToValueAtTime(260, t + 0.7);
    const shriekGain = ctx.createGain();
    shriekGain.gain.setValueAtTime(0.0001, t);
    shriekGain.gain.exponentialRampToValueAtTime(0.3, t + 0.04);
    shriekGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    shriekLp.connect(shriekGain);
    shriekGain.connect(dest);
    for (const detune of [0.99, 1.0, 1.013]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(1800 * detune, t);
      osc.frequency.exponentialRampToValueAtTime(180 * detune, t + 0.7);
      osc.connect(shriekLp);
      osc.start(t);
      osc.stop(t + 1.0);
    }

    // ── Sub boom: chest-punch sine sweeping down — the weight under the flock.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(160, t);
    sub.frequency.exponentialRampToValueAtTime(34, t + 1.1);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + 1.7);

    // ── Bright streak: broadband noise through a bandpass sweeping high→mid,
    // the air-tearing hiss of many bodies entering at once. Short and sharp.
    const streakBuf = this.noiseBuffer(ctx, 2.5);
    if (streakBuf) {
      const streak = ctx.createBufferSource();
      streak.buffer = streakBuf;
      const streakBp = ctx.createBiquadFilter();
      streakBp.type = "bandpass";
      streakBp.Q.value = 1.2;
      streakBp.frequency.setValueAtTime(6000, t);
      streakBp.frequency.exponentialRampToValueAtTime(700, t + 1.3);
      const streakGain = ctx.createGain();
      streakGain.gain.setValueAtTime(0.0001, t);
      streakGain.gain.exponentialRampToValueAtTime(0.4, t + 0.05);
      streakGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      streak.connect(streakBp);
      streakBp.connect(streakGain);
      streakGain.connect(dest);
      streak.start(t);
      streak.stop(t + 2.5);
    }
  }

  // The gem swarm's entrance — the sparkling-treasure cousin of the meteor
  // shower's falling shriek. Where the shower descends and snarls, this one
  // *rises and glitters*: a quick ascending C-major-pentatonic arpeggio of
  // glassy bell tones, each one blooming with a bright sine harmonic and a
  // little detuned shimmer partner, capped by a high sparkle wash. The
  // pentatonic on C stays consonant with the C-rooted bass field so the
  // flourish lands as "ooh, gold" rather than a clash.
  playGemSwarm() {
    if (!this.enabled) return;
    this.ensureContext();
    if (this.playBaked("gemSwarm", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildGemSwarmGraph(this.ctx, this.master, this.voiceTime("gemSwarm"));
  }

  private buildGemSwarmGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    // C-major pentatonic climbing C5 → E5 → G5 → A5 → C6 → D6, the last two
    // notes ringing into the octave so the gesture feels like it lifts off.
    const notes = [523.25, 659.25, 783.99, 880.0, 1046.5, 1174.66];
    const step = 0.075;
    notes.forEach((freq, i) => {
      const nt = t + i * step;
      // Slight upward velocity arc — later (higher) notes a touch brighter,
      // so the run sparkles harder as it climbs.
      const vel = 0.16 + 0.03 * i;

      // Glassy body: a triangle for the fundamental plus a quiet sine two
      // octaves up for the "struck crystal" ping. Each rings ~0.5s with a
      // fast attack and a long bell-like tail.
      const ring = 0.55;
      for (const [type, mult, lvl] of [["triangle", 1, vel], ["sine", 2, vel * 0.5], ["sine", 4.01, vel * 0.18]] as const) {
        const osc = ctx.createOscillator();
        osc.type = type;
        // Tiny detune on the partners gives a shimmering chorus beat.
        osc.frequency.setValueAtTime(freq * mult * (mult === 1 ? 1 : 1.004), nt);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, nt);
        g.gain.exponentialRampToValueAtTime(lvl, nt + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, nt + ring);
        osc.connect(g);
        g.connect(dest);
        osc.start(nt);
        osc.stop(nt + ring + 0.05);
      }
    });

    // High sparkle wash: filtered noise through a high bandpass, gated with a
    // shimmering tremolo so it reads as a fine spray of glints behind the
    // arpeggio rather than a flat hiss. Rises in with the run, fades after.
    const dur = notes.length * step + 0.6;
    const sparkleBuf = this.noiseBuffer(ctx, 1.3);
    if (sparkleBuf) {
      const sparkle = ctx.createBufferSource();
      sparkle.buffer = sparkleBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 2.5;
      bp.frequency.setValueAtTime(4000, t);
      bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      // Tremolo to break the wash into glints.
      const trem = ctx.createOscillator();
      trem.type = "sine";
      trem.frequency.setValueAtTime(18, t);
      const tremGain = ctx.createGain();
      tremGain.gain.value = 0.6;
      trem.connect(tremGain);
      tremGain.connect(sg.gain);
      trem.start(t);
      trem.stop(t + dur + 0.2);
      sparkle.connect(bp);
      bp.connect(sg);
      sg.connect(dest);
      sparkle.start(t);
      sparkle.stop(t + dur + 0.2);
    }
  }

  stopAllCometShimmers() {
    for (const key of Array.from(this.cometShimmers.keys())) this.stopCometShimmer(key);
  }

  // Yellow-halo ambient pad. A soft, C-rooted bed that hangs under the bass
  // field whenever the player is holding a halo. The voicing is a stable
  // open-fifth (C+G) with a single colour-third floating over it — the open
  // fifth is at home in *both* the bassteroids' C-major bed AND the comet's
  // C-rooted phrygian/diminished cluster, and the colour third slides
  // between E (bright over major bass) and Eb (neutral over the comet) via
  // setHaloAmbientCometMode.
  //
  // Over that bed sits a quiet looping melody — a 1-second-per-step "keep
  // going" motif played on a soft triangle. The line is built only from
  // C/D/F/G (the four pitches that are mode-invariant across all six modes
  // the game visits), so it stays in tune on a Lydian wave 3 and on a
  // Phrygian wave 30 alike, and never collides with the comet's b2/tritone.
  // The shape — G → F → G → C5 → G → F → D → (rest) — climbs to the octave
  // once per phrase then settles back, like a quiet determined breath:
  // forward, settle, forward, settle. Slow attack/release per note keeps
  // each step blooming rather than punching, so the pad still reads as
  // ambient at white-bullet tier doubletime.
  startHaloAmbient(tier: 1 | 2 = 1) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.haloAmbient) {
      this.setHaloAmbientTier(tier);
      return;
    }
    const t = this.ctx.currentTime;

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    // ~2s fade-in — the pad arrives as a halo emerging, not as a click.
    // Peak level chosen to sit just under the bass drones: with the per-voice
    // gains below, the loudest moment of the root voice is ~0.04 amplitude,
    // comparable to one bassteroid drone (0.022–0.035 peak).
    mainGain.gain.exponentialRampToValueAtTime(0.09, t + 2.0);

    // Lowpass keeps the pad soft and "behind" the bass drones (which have
    // their own brighter top end). Cutoff sits above the highest voice so
    // we shape rather than mute it.
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.9;
    filter.frequency.value = 1600;
    filter.connect(mainGain);

    // Slow tremolo — the pad breathes at ~0.06 Hz (16s period). Slower than
    // any bass drone's pulseLfo (0.07–0.18 Hz) so the layers don't beat in
    // lockstep and the pad reads as the slowest moving voice in the mix.
    const tremLfo = this.ctx.createOscillator();
    tremLfo.type = "sine";
    tremLfo.frequency.value = 0.06;
    const tremDepth = this.ctx.createGain();
    tremDepth.gain.value = 0.28;
    const tremGain = this.ctx.createGain();
    tremGain.gain.value = 0.72;
    tremLfo.connect(tremDepth);
    tremDepth.connect(tremGain.gain);
    tremGain.connect(filter);
    tremLfo.start(t);

    const oscs: OscillatorNode[] = [];
    const lfos: OscillatorNode[] = [tremLfo];

    // C3 fundamental (130.81). Same pitch as bassA medium so they reinforce
    // when bassA is present and form a clean root when it's not.
    const root = this.ctx.createOscillator();
    root.type = "sine";
    root.frequency.value = 130.81;
    const rootGain = this.ctx.createGain();
    rootGain.gain.value = 0.55;
    root.connect(rootGain);
    rootGain.connect(tremGain);
    root.start(t);
    oscs.push(root);

    // G3 fifth (196.00). Same pitch as bassB medium. The C+G open fifth is
    // the harmonic invariant — it's in every mode that begins on C and
    // doesn't fight the comet's b2 (Db) or tritone (F#) the way an E or A
    // would. A second slightly-detuned oscillator gives a gentle phasing
    // shimmer without using a chorus that would cost CPU.
    const fifth = this.ctx.createOscillator();
    const fifthDetuned = this.ctx.createOscillator();
    fifth.type = "sine";
    fifthDetuned.type = "sine";
    fifth.frequency.value = 196.00;
    fifthDetuned.frequency.value = 196.00 * 1.006;
    const fifthGain = this.ctx.createGain();
    fifthGain.gain.value = 0.40;
    fifth.connect(fifthGain);
    fifthDetuned.connect(fifthGain);
    fifthGain.connect(tremGain);
    fifth.start(t);
    fifthDetuned.start(t);
    oscs.push(fifth, fifthDetuned);

    // Third voice — defaults to E4 (329.63), glides down to Eb4 (311.13)
    // when a comet is present. E4 turns the open fifth into a C-major triad
    // (CEG up an octave), which is rich and bright over the bass major bed.
    // Eb4 turns it into a C-minor triad which is *consonant with the comet's
    // dissonant cluster* — Eb is the b3 in C-phrygian. Either way the bottom
    // C+G stays put, so the pad never breaks character; only the colour
    // shifts.
    const thirdOsc = this.ctx.createOscillator();
    thirdOsc.type = "sine";
    thirdOsc.frequency.value = this.haloAmbientCometMode ? 311.13 : 329.63;
    const thirdGain = this.ctx.createGain();
    thirdGain.gain.value = 0.28;
    thirdOsc.connect(thirdGain);
    thirdGain.connect(tremGain);
    thirdOsc.start(t);
    oscs.push(thirdOsc);

    // Tier-2 (white bullet) gain — an octave-up colour layer that swells in
    // when combo crosses 12. Wired here so the upgrade is a single gain ramp
    // rather than starting a new oscillator stack mid-game.
    const tier2Gain = this.ctx.createGain();
    tier2Gain.gain.value = 0.0001;

    // Octave-up top: C4 + G4. Brighter sparkle for the white-bullet tier.
    const topC = this.ctx.createOscillator();
    const topG = this.ctx.createOscillator();
    topC.type = "sine";
    topG.type = "sine";
    topC.frequency.value = 261.63;
    topG.frequency.value = 392.00;
    const topGain = this.ctx.createGain();
    topGain.gain.value = 0.18;
    topC.connect(topGain);
    topG.connect(topGain);
    topGain.connect(tier2Gain);
    tier2Gain.connect(tremGain);
    topC.start(t);
    topG.start(t);
    oscs.push(topC, topG);

    // ── Melody voice ──────────────────────────────────────────────────────
    // One triangle oscillator runs continuously; per-step we cancel the
    // previous envelope, retune the frequency, and schedule a fresh
    // attack/sustain/release. Triangle has a warmer, slightly hollow voice
    // than sine — it carries the line above the sine bed without the bite
    // of a saw, so the motif reads as introspective rather than declarative.
    const melodyOsc = this.ctx.createOscillator();
    melodyOsc.type = "triangle";
    // A gentle lowpass softens the triangle's high partials so the line sits
    // *behind* the bass field's brightness instead of cutting through it.
    const melodyFilter = this.ctx.createBiquadFilter();
    melodyFilter.type = "lowpass";
    melodyFilter.Q.value = 0.7;
    melodyFilter.frequency.value = 1100;
    const melodyGain = this.ctx.createGain();
    melodyGain.gain.setValueAtTime(0.0001, t);
    melodyOsc.connect(melodyFilter);
    melodyFilter.connect(melodyGain);
    // Routed through tremGain so the melody breathes with the same slow
    // 16-second swell as the rest of the pad.
    melodyGain.connect(tremGain);
    // Start at the first phrase pitch (G3) — first step's frequency
    // schedule below will override anyway, but giving it a sane initial
    // value avoids any glitch on the very first attack.
    melodyOsc.frequency.value = 196.00;
    melodyOsc.start(t);
    oscs.push(melodyOsc);

    // Determined 8-step motif. One step every PAD_STEP_S seconds (1.0s, so
    // two BEAT_GRID ticks — slow enough to feel like a held thought, fast
    // enough that the line clearly *is* a line rather than a chord). Rests
    // are null. Pitches are restricted to {C, D, F, G} in two octaves so
    // the figure is mode-safe across the whole game.
    //
    //  step  pitch   feel
    //  0     G3      "forward" — open fifth, settled but moving
    //  1     F3      "step back" — a half-yield, acknowledges the dark
    //  2     G3      "forward again" — same step, more resolved
    //  3     C5      "lift" — the one bright reach per phrase
    //  4     G3      "settle" — back to the foundation
    //  5     F3      "breathe down"
    //  6     D3      "lowest reach" — pulls under the root before resolving
    //  7     null    rest — silence is the resolution; loop restarts at G
    const MELODY_HZ: (number | null)[] = [
      196.00,  // G3
      174.61,  // F3
      196.00,  // G3
      523.25,  // C5
      196.00,  // G3
      174.61,  // F3
      146.83,  // D3
      null,
    ];
    const PAD_STEP_S = 1.0;
    // Peak gain per note. Sits well below rootGain (0.55) and fifthGain
    // (0.40) so the line stays subordinate to the bed it floats over —
    // it's a hummed melody, not a lead. The C5 lift step gets a touch less
    // gain so the upper octave doesn't pop forward in the mix.
    const noteGainFor = (hz: number) => (hz >= 400 ? 0.16 : 0.22);

    let step = 0;
    const triggerStep = () => {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const hz = MELODY_HZ[step % MELODY_HZ.length];
      step++;
      melodyGain.gain.cancelScheduledValues(now);
      // Always start from the current value so we don't click if a previous
      // envelope hasn't finished its release.
      melodyGain.gain.setValueAtTime(melodyGain.gain.value, now);
      if (hz === null) {
        // Quiet release — let the previous note tail off into the rest.
        melodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        return;
      }
      // Slight portamento between notes (60ms) so each pitch glides into
      // place — the line sounds like a held human voice rather than a
      // chord-stab sequencer.
      melodyOsc.frequency.cancelScheduledValues(now);
      melodyOsc.frequency.setValueAtTime(melodyOsc.frequency.value, now);
      melodyOsc.frequency.exponentialRampToValueAtTime(hz, now + 0.06);
      // ADSR-ish per note: 0.25s bloom in, hold ~0.45s, 0.30s release.
      // Total ~1.0s = one step, so notes overlap minimally at the edges.
      const peak = noteGainFor(hz);
      melodyGain.gain.exponentialRampToValueAtTime(peak, now + 0.25);
      melodyGain.gain.setValueAtTime(peak, now + 0.70);
      melodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.00);
    };
    // Fire the first step immediately so the pad arrives with a sung-into
    // entrance rather than a second of silent build.
    triggerStep();
    const melodyInterval = setInterval(triggerStep, PAD_STEP_S * 1000);

    mainGain.connect(this.master);

    this.haloAmbient = { oscs, lfos, mainGain, thirdOsc, tier2Gain, melodyOsc, melodyGain, melodyInterval };
    this.haloAmbientTier = 1;
    if (tier === 2) this.setHaloAmbientTier(2);
  }

  setHaloAmbientTier(tier: 1 | 2) {
    if (!this.ctx || !this.haloAmbient) return;
    if (this.haloAmbientTier === tier) return;
    const t = this.ctx.currentTime;
    const target = tier === 2 ? 1.0 : 0.0001;
    this.haloAmbient.tier2Gain.gain.cancelScheduledValues(t);
    this.haloAmbient.tier2Gain.gain.setValueAtTime(this.haloAmbient.tier2Gain.gain.value, t);
    // Fade up over ~0.5s for a smooth tier promotion, demote a bit slower
    // so a single mistimed shot doesn't strip the sparkle abruptly.
    this.haloAmbient.tier2Gain.gain.exponentialRampToValueAtTime(target, t + (tier === 2 ? 0.5 : 0.9));
    this.haloAmbientTier = tier;
  }

  // ── Pre-rendered halo music ────────────────────────────────────────────
  // Loads a music variation (ambient + melodic stems) and schedules them as
  // looping buffer sources. The ambient stem fades in immediately; the
  // melodic stem starts ducked and only fades up when
  // setHaloMusicMelodicLayer(true) is called (combo ≥ 6). Both stems share
  // length and downbeat so they stay phase-locked for the lifetime of the
  // music.
  //
  // Round 1 used 8-second loops at -6 dBFS peak with gain 0.55 — the audit
  // showed those were ~7× hotter than the legacy synth pad and fighting the
  // bass in the 200–500 Hz lo-mid. Round 2 uses 32-second loops at -12 dBFS
  // peak with per-variation gain targets calibrated against the in-game-mix
  // audit (`scripts/music-gen/ingame_mix.py`): EL stems pass with gain 0.25,
  // self-built stems with 0.30, leaving the bass dominant by ≥7 dB in every
  // band.
  //
  // Routed via this.master (not bakedOut) so the music sits inside the same
  // reverb/compressor bus as live voices. The pre-rendered stems are already
  // loop-faded so the master bus's reverb tail at the seam won't click.
  private haloMusicUrl(variation: HaloMusicVariation, layer: "ambient" | "melodic" | "layer3"): string {
    return `/sounds/halo-music/${variation}-${layer}.mp3`;
  }

  // Per-variation peak gain consulted by both haloAmbientGain and
  // haloMelodicGain unless a per-layer override is saved in
  // public/sounds/music-config.json (loaded by musicConfig.ts and edited via
  // the /music page). Calibrated against the in-game-mix audit
  // (`scripts/music-gen/ingame_mix.py`) so the bass kit stays dominant by
  // ≥7 dB in every band. EL stems are spectrally darker so they need a
  // touch less gain to match perceived loudness with the self-built stems.
  private haloMusicGain(variation: HaloMusicVariation): number {
    switch (variation) {
      case "cinematic-el": return 0.25;
      case "musicbox-sb": return 0.30;
      // synthwave-el is an EL-generated analog synth pad with 42% energy in 60-200
      // and 44% in 200-500. At gain 0.22 the melodic layer's lo-mid sits
      // +6.8 dB above the ≥4 dB pass threshold. Going higher risks the
      // analog pad fighting the bass field.
      case "synthwave-el": return 0.22;
      // vaporwave-el is a bright EL dawn/vaporwave variation. Ambient = glassy
      // string-choir pad in the mid-upper register; melodic = sparse felt-bell
      // sustains. Both layers were generated to live above the bass band
      // (ambient lo-mid 46%, melodic mid 60%) so the bass field stays clean.
      // Full 3-layer stack at 0.25/0.28/0.32 leaves lo-mid +5.8 dB, bass
      // +26 dB margin in the audit. peakGain controls ambient+melodic; the
      // pair value is 0.27 (midpoint between the two stem gains, since
      // setHaloMusicMelodicLayer ramps the melodic gain to peakGain).
      case "vaporwave-el": return 0.27;
      // outerwilds-el is the Outer-Wilds folk variation. Ambient = distant dark
      // drone pad (HPF'd at 200 Hz to keep the bass kit clear); melodic =
      // fingerpicked acoustic guitar in G mixolydian (G-rooted over the
      // bass field's C — a V-over-I suspension, never resolving, which
      // suits the haunting vibe). The ambient stem is leaner than melodic,
      // so peakGain returns the midpoint of the ambient (0.22) and melodic
      // (0.25) stem gains used in the audit. Full 3-layer stack leaves
      // lo-mid +4.5 dB, bass +20 dB headroom against the bass field.
      case "outerwilds-el": return 0.235;
      // vigil-sb is the level-10 boss track — the climax of the halo music.
      // Ambient = warm minor C-pedal pad + accelerating C2 heartbeat (doubles to
      // eighths in the final phrase); melodic = insistent rising felt-piano
      // minor-pentatonic arpeggio. Final processed mp3s at 0.30/0.30/0.32 against
      // the bass field: ambient sub +15.4, bass +15.5, lo_mid +16.9 dB; melodic
      // lo_mid +10.8 dB margin. Same fallback-base (0.30) shared by ambient+melodic.
      case "vigil-sb": return 0.30;
      // knell-sb is the funeral death-knell track (earmarked for the level-20
      // boss). Ambient = C-minor pad + C1 lub-dub heartbeat; melodic = driving
      // staccato string-ensemble ostinato (GM 48) + tremolo swells (GM 44).
      // Full 3-layer stack at 0.30/0.32/0.32 against the bass field: sub
      // +11.7, bass +20.9, lo_mid +7.7 dB margin.
      case "knell-sb": return 0.30;
      // cathedral-hymn-el: bowed stone-cathedral string pad (ambient) + distant
      // felt-piano single tones (melodic). Comfortable headroom at 0.27 —
      // bass +22 dB, lo_mid +8.5 dB in the audit.
      case "cathedral-hymn-el": return 0.27;
      // lost-transmission-el: dusty AM-radio analog pad (ambient) + frail
      // musical-saw lead (melodic). Mid-heavy stems; gain held at 0.22 so the
      // lo-mid stays clean (bass +19 dB, lo_mid +3.4 dB at audit).
      case "lost-transmission-el": return 0.22;
      // underwater-requiem-el: submerged orchestral string pad (ambient) +
      // glass-harmonica lead (melodic). Balanced; gain 0.25 leaves bass +29 dB,
      // lo_mid +11 dB margin.
      case "underwater-requiem-el": return 0.25;
      // spectral-toll-sb (haunting, waves 12–20): deep C/G drone (ambient, EL) +
      // mournful solo cello (melodic, EL). Both lean low — the drone is sub/bass
      // heavy by design — but the bass kit still wins: at 0.27 the ambient leaves
      // sub +16, bass +20 dB and the cello lo_mid +9.8 dB.
      case "spectral-toll-sb": return 0.27;
      default:      return 0.30;
    }
  }

  // Layer-3 playback gain (combo ≥ 12). Calibrated per variation against the
  // in-game-mix audit so the bass kit stays dominant by ≥6 dB in lo-mid and
  // ≥10 dB in bass. Each variation's layer 3 is a single new musical element
  // chosen to thematically fit its existing ambient + melodic stems (lonely
  // violin / glockenspiel / synth-bass arp / chime counter-melody — see
  // build_layer3.py for the per-variation design).
  private haloMusicLayer3Gain(variation: HaloMusicVariation): number {
    switch (variation) {
      case "cinematic-el": return 0.22;   // solo violin, three single-pitch bow strokes (A4, C5, G4)
      case "musicbox-sb": return 0.40;   // warm felt-glockenspiel arpeggio
      // synthwave-el layer 3 is a plucked detuned-saw motif (C5-C6) whose
      // dotted-eighth ping-pong delay cascades through the upper register the
      // ambient + melodic stems leave empty. No energy below 500 Hz, so the
      // full 3-layer stack at gain 0.38 still leaves lo-mid +6.2 dB.
      case "synthwave-el": return 0.38;
      // vaporwave-el layer3 is a bright crystal-glockenspiel arpeggio in the upper
      // register. Audit at gain 0.32 (in the full 3-layer mix above) leaves
      // lo-mid +5.8 dB and mid +5.9 dB margin against the bass field.
      case "vaporwave-el": return 0.32;
      // outerwilds-el layer3 is a haunting plucked-acoustic-guitar countermelody,
      // D-centered in the upper register (D5/E5/A5 dominant) — sits above the
      // layer-2 fingerpicking instead of doubling it. HPF'd at 500 Hz so the
      // guitar's lo-mid body clears the bass kit. Full 3-layer stack at gain
      // 0.30 leaves lo-mid +4.9 dB.
      case "outerwilds-el": return 0.30;
      // vigil-sb layer 3 = glassy celesta (GM 9) countermelody on tense scale
      // tones (Eb/Bb/Db — anxious-beautiful sparkle) + a felt-piano (GM 0)
      // low-octave C2/C3 toll on phrase downbeats for weight, kept in the piano
      // family rather than a bell so the boss still sounds like the halo world.
      // Final mp3 at gain 0.32 leaves bass +33.8 dB, lo_mid +15.5 dB margin.
      case "vigil-sb": return 0.32;
      // knell-sb layer 3 = ghost choir (GM 52) on a Dies-irae-shaded descending
      // motif + tubular bell (GM 14) tolling each phrase downbeat. 62% of its
      // energy lives in 500-2k, well clear of the bass family. Audit at gain
      // 0.32 leaves bass +60.8 dB, lo_mid +16.1 dB margin.
      case "knell-sb": return 0.32;
      // cathedral-hymn-el layer 3 = low monastic male chant on "ooo/aaa" vowels.
      // Bass-register voice; kept quiet (0.30) so the chant reads as a distant
      // presence under the pad rather than a foreground vocal line.
      case "cathedral-hymn-el": return 0.30;
      // lost-transmission-el layer 3 = whispered breaths + faint radio crackle.
      // Already very quiet at source (-23 dBFS peak); 0.28 keeps it subliminal.
      case "lost-transmission-el": return 0.28;
      // underwater-requiem-el layer 3 = upper-register celesta countermelody,
      // HPF'd at 500 Hz. Sits high above bass kit; 0.32 leaves +22 dB lo_mid.
      case "underwater-requiem-el": return 0.32;
      // spectral-toll-sb layer 3 = sparse procedural glass bells (G5-E6) with
      // dotted-quarter ping-pong echo, essentially zero energy below 500 Hz
      // (lo_mid 1.4%). At 0.45 the full 3-layer stack still leaves lo_mid
      // +8.7 dB against the bass field.
      case "spectral-toll-sb": return 0.45;
      default:      return 0.40;
    }
  }

  // Effective peak gains, config-aware. The /music page persists per-layer
  // overrides to public/sounds/music-config.json, which Sound bootstrap loads
  // via loadMusicConfig(); when an entry is present we use it verbatim,
  // otherwise we fall through to the audit-calibrated values above. Ambient
  // and melodic share the base fallback (haloMusicGain) absent overrides —
  // the config layer is what lets the player split them.
  private haloAmbientGain(variation: HaloMusicVariation): number {
    return musicGain(variation, "ambient", this.haloMusicGain(variation));
  }
  private haloMelodicGain(variation: HaloMusicVariation): number {
    return musicGain(variation, "melodic", this.haloMusicGain(variation));
  }
  private haloLayer3Gain(variation: HaloMusicVariation): number {
    return musicGain(variation, "layer3", this.haloMusicLayer3Gain(variation));
  }

  // Live-update an active halo-music layer's peak gain to a new value. Called
  // from Game.ts in response to `halo-music-pref:changed` so adjusting a
  // slider on /music affects the currently-playing stem without waiting for
  // the next combo cycle. No-ops if the variation doesn't match or the layer
  // is currently ducked (in which case the next time it's brought back the
  // override-aware accessors above will pick up the saved value).
  applyHaloLayerGain(variation: HaloMusicVariation, layer: MusicLayer, value: number): void {
    if (!this.ctx || !this.haloMusic) return;
    if (this.haloMusic.variation !== variation) return;
    const t = this.ctx.currentTime;
    if (layer === "ambient") {
      this.haloMusic.ambientGain.gain.cancelScheduledValues(t);
      this.haloMusic.ambientGain.gain.setTargetAtTime(Math.max(0.0001, value), t, 0.05);
    } else if (layer === "melodic" && this.haloMusic.melodicActive) {
      this.haloMusic.melodicGain.gain.cancelScheduledValues(t);
      this.haloMusic.melodicGain.gain.setTargetAtTime(Math.max(0.0001, value), t, 0.05);
    } else if (layer === "layer3" && this.haloMusic.layer3Gain && this.haloMusic.layer3Active) {
      this.haloMusic.layer3Gain.gain.cancelScheduledValues(t);
      this.haloMusic.layer3Gain.gain.setTargetAtTime(Math.max(0.0001, value), t, 0.05);
    }
  }

  private loadHaloMusicBuffer(url: string, immediate = false): Promise<AudioBuffer | null> {
    const cached = this.haloMusicBuffers.get(url);
    if (cached) return Promise.resolve(cached);
    const inflight = this.haloMusicLoading.get(url);
    if (inflight) return inflight;
    if (!this.ctx) return Promise.resolve(null);
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => (ab ? this.decodeAsset(ab, immediate) : null))
      .then((buf) => {
        if (buf) this.haloMusicBuffers.set(url, buf);
        this.haloMusicLoading.delete(url);
        return buf;
      })
      .catch(() => {
        this.haloMusicLoading.delete(url);
        return null;
      });
    this.haloMusicLoading.set(url, p);
    return p;
  }

  // Warm both stems for a variation so the first 4x trigger plays without
  // fetch+decode latency. Safe to call multiple times — cached entries are
  // deduped.
  preloadHaloMusic(variation: HaloMusicVariation): void {
    if (variation === "none") return;
    this.ensureContext();
    // Idempotent — pulls /sounds/music-config.json once so haloAmbientGain
    // and friends see the tuned values when the music actually starts.
    void loadMusicConfig();
    void this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "ambient"));
    void this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "melodic"));
    void this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "layer3"));
  }

  // Warm a list of variations one-at-a-time with a real time gap between
  // stems. Serializing alone isn't enough: chaining decode → idle → decode
  // keeps a core busy continuously for the first several seconds of play
  // (requestIdleCallback fires within ~a frame), which audibly skips bgBeat
  // pulses right when the bare pulse is all the player hears. These tracks
  // aren't needed until waves 11–12 (minutes away), so each stem can afford
  // to wait: 15 stems × 6 s ≈ 90 s, each decode an isolated background blip
  // the audio scheduler rides through. The eager pool stays on
  // preloadHaloMusic.
  private static readonly DEFERRED_MUSIC_INITIAL_DELAY_MS = 8000;
  private static readonly DEFERRED_MUSIC_STEM_GAP_MS = 6000;
  preloadHaloMusicSequential(variations: readonly HaloMusicVariation[]): void {
    if (variations.length === 0) return;
    this.ensureContext();
    void loadMusicConfig();
    const queue: { variation: HaloMusicVariation; layer: "ambient" | "melodic" | "layer3" }[] = [];
    for (const variation of variations) {
      if (variation === "none") continue;
      queue.push({ variation, layer: "ambient" });
      queue.push({ variation, layer: "melodic" });
      queue.push({ variation, layer: "layer3" });
    }
    const idle = (cb: () => void) => {
      const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number };
      if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb);
      else setTimeout(cb, 250);
    };
    const drain = () => {
      const next = queue.shift();
      if (!next) return;
      this.loadHaloMusicBuffer(this.haloMusicUrl(next.variation, next.layer))
        .finally(() => setTimeout(() => idle(drain), Sound.DEFERRED_MUSIC_STEM_GAP_MS));
    };
    setTimeout(() => idle(drain), Sound.DEFERRED_MUSIC_INITIAL_DELAY_MS);
  }

  // Start (or hot-restart) the pre-rendered halo music for a variation. If a
  // node is already playing for the same variation, we just toggle the
  // melodic layer; otherwise we tear down the old one and load the new.
  // melodicActive: should the melodic layer be audible from the start?
  // (Used when combo jumps straight to ≥ 6 without stopping at 4.)
  //
  // measureAlignDelay: optional seconds to delay the buffer .start() so the
  // music's downbeat lands on a bass-measure boundary. Computed by the
  // caller from game.beatTime modulo BASS_MEASURE_LENGTH. If negative or
  // not provided, start immediately. Phase-correct alignment matters more
  // for 32-second loops with internal chord changes than for the round-1
  // 8-second loops, where any seam landed within one bar of the bass clock
  // anyway.
  async startHaloMusic(variation: HaloMusicVariation, melodicActive: boolean,
                       measureAlignDelay: number = 0,
                       currentBeatTime: number = 0,
                       layer3Active: boolean = false): Promise<void> {
    if (variation === "none") return;
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    // Same variation already running — just sync the layered tiers.
    if (this.haloMusic && this.haloMusic.variation === variation) {
      this.setHaloMusicMelodicLayer(melodicActive);
      this.setHaloMusicLayer3(layer3Active);
      return;
    }
    // Different variation playing — fade out the old node before swapping.
    if (this.haloMusic) this.stopHaloMusic();

    // immediate: these play the moment they resolve, so they must not wait
    // for an idle slot behind the background queue.
    const [ambientBuf, melodicBuf, layer3Buf] = await Promise.all([
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "ambient"), true),
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "melodic"), true),
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "layer3"), true),
    ]);
    if (!this.ctx || !this.master) return;
    if (!ambientBuf || !melodicBuf) return;
    if (this.haloMusic) return;  // raced with another start

    const t = this.ctx.currentTime;
    const startAt = t + Math.max(0, measureAlignDelay);
    // Maps the music's first sample-frame to the beatTime the caller is
    // about to advance into during the same align window.
    const startedAtBeatTime = currentBeatTime + (startAt - t);
    const ambientSrc = this.ctx.createBufferSource();
    const melodicSrc = this.ctx.createBufferSource();
    ambientSrc.buffer = ambientBuf;
    melodicSrc.buffer = melodicBuf;
    ambientSrc.loop = true;
    melodicSrc.loop = true;

    // Per-variation peak gain, override-aware. Ambient and melodic each pull
    // their own value so the /music page sliders can split them; without
    // overrides they collapse to haloMusicGain (the audit-calibrated base).
    // Layer 3 has its own gain since it lives outside the bass-melodic
    // register and tolerates an independent mix.
    const ambientPeak = this.haloAmbientGain(variation);
    const melodicPeak = this.haloMelodicGain(variation);

    // Fade-in starts at the *aligned* start time, not now, so the music
    // doesn't bleed in during the wait-for-downbeat window.
    const ambientGain = this.ctx.createGain();
    ambientGain.gain.setValueAtTime(0.0001, startAt);
    ambientGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, ambientPeak), startAt + 1.5);

    const melodicGain = this.ctx.createGain();
    melodicGain.gain.setValueAtTime(0.0001, startAt);
    if (melodicActive) {
      melodicGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, melodicPeak), startAt + 0.5);
    }

    const mainGain = this.ctx.createGain();
    mainGain.gain.value = 1.0;

    ambientSrc.connect(ambientGain);
    melodicSrc.connect(melodicGain);
    ambientGain.connect(mainGain);
    melodicGain.connect(mainGain);
    if (this.chMusicLive) mainGain.connect(this.chMusicLive);

    // Layer 3 is optional — only wire it up if the stem actually loaded.
    let layer3Src: AudioBufferSourceNode | null = null;
    let layer3Gain: GainNode | null = null;
    if (layer3Buf) {
      const layer3Peak = this.haloLayer3Gain(variation);
      layer3Src = this.ctx.createBufferSource();
      layer3Src.buffer = layer3Buf;
      layer3Src.loop = true;
      layer3Gain = this.ctx.createGain();
      layer3Gain.gain.setValueAtTime(0.0001, startAt);
      if (layer3Active) {
        layer3Gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, layer3Peak), startAt + 0.5);
      }
      layer3Src.connect(layer3Gain);
      layer3Gain.connect(mainGain);
    }

    // Seed the slow-mo rate so music that starts mid-slomo opens slowed, not
    // at 1× (set*PlaybackRate only touches already-playing sources).
    const rate0 = this.currentMusicPlaybackRate;
    ambientSrc.playbackRate.value = rate0;
    melodicSrc.playbackRate.value = rate0;
    if (layer3Src) layer3Src.playbackRate.value = rate0;

    // All sources start at exactly the same audio time so they remain
    // phase-locked for the lifetime of the music — switching the melodic
    // or layer-3 tier is then just a gain ramp, no fresh .start() that
    // would risk loop-phase drift between the stems.
    ambientSrc.start(startAt);
    melodicSrc.start(startAt);
    if (layer3Src) layer3Src.start(startAt);

    this.haloMusic = {
      ambientSrc, melodicSrc, layer3Src,
      ambientGain, melodicGain, layer3Gain, mainGain,
      variation, melodicActive,
      layer3Active: layer3Active && layer3Src !== null,
      climaxActive: false,
      startedAtAudioTime: startAt,
      startedAtBeatTime,
      currentPlaybackRate: rate0,
    };
  }

  // 24x climax crossfade. Builds a fresh HaloMusicNode for `variation` and
  // swaps it in over a symmetric ~2s crossfade — the outgoing track fades to
  // silence on its mainGain while the new track fades up on its per-layer
  // gains. Both tracks play simultaneously through the crossfade window, then
  // the outgoing buffer sources are stopped.
  //
  // The new track starts at full layer stack (ambient + melodic + layer3 all
  // active) because the climax tier is gated at combo ≥ 24, which is above
  // every existing layer threshold.
  //
  // Aligned to the next bass-measure boundary so the new track's downbeat
  // lands on the bass clock, same as startHaloMusic.
  async crossfadeHaloMusic(variation: HaloMusicVariation,
                           measureAlignDelay: number = 0,
                           currentBeatTime: number = 0): Promise<void> {
    if (variation === "none") return;
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (!this.haloMusic) return;
    if (this.haloMusic.variation === variation) return;

    const outgoing = this.haloMusic;
    // Reserve the climax slot synchronously so a re-entrant call (or a
    // rapid combo bounce) doesn't kick off a second crossfade while the
    // buffers for this one are still loading.
    outgoing.climaxActive = true;

    // immediate: these play the moment they resolve, so they must not wait
    // for an idle slot behind the background queue.
    const [ambientBuf, melodicBuf, layer3Buf] = await Promise.all([
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "ambient"), true),
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "melodic"), true),
      this.loadHaloMusicBuffer(this.haloMusicUrl(variation, "layer3"), true),
    ]);
    if (!this.ctx || !this.master) return;
    if (!ambientBuf || !melodicBuf) return;
    // Outgoing was torn down (combo broke) while we awaited the decode —
    // bail without starting the new track so we don't strand it.
    if (this.haloMusic !== outgoing) return;

    const CROSSFADE_SEC = 2.0;
    const t = this.ctx.currentTime;
    const startAt = t + Math.max(0, measureAlignDelay);
    const startedAtBeatTime = currentBeatTime + (startAt - t);
    const ambientSrc = this.ctx.createBufferSource();
    const melodicSrc = this.ctx.createBufferSource();
    ambientSrc.buffer = ambientBuf;
    melodicSrc.buffer = melodicBuf;
    ambientSrc.loop = true;
    melodicSrc.loop = true;

    const ambientPeak = this.haloAmbientGain(variation);
    const melodicPeak = this.haloMelodicGain(variation);

    const ambientGain = this.ctx.createGain();
    ambientGain.gain.setValueAtTime(0.0001, startAt);
    ambientGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, ambientPeak), startAt + CROSSFADE_SEC);

    const melodicGain = this.ctx.createGain();
    melodicGain.gain.setValueAtTime(0.0001, startAt);
    melodicGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, melodicPeak), startAt + CROSSFADE_SEC);

    const mainGain = this.ctx.createGain();
    mainGain.gain.value = 1.0;

    ambientSrc.connect(ambientGain);
    melodicSrc.connect(melodicGain);
    ambientGain.connect(mainGain);
    melodicGain.connect(mainGain);
    if (this.chMusicLive) mainGain.connect(this.chMusicLive);

    let layer3Src: AudioBufferSourceNode | null = null;
    let layer3Gain: GainNode | null = null;
    if (layer3Buf) {
      const layer3Peak = this.haloLayer3Gain(variation);
      layer3Src = this.ctx.createBufferSource();
      layer3Src.buffer = layer3Buf;
      layer3Src.loop = true;
      layer3Gain = this.ctx.createGain();
      layer3Gain.gain.setValueAtTime(0.0001, startAt);
      layer3Gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, layer3Peak), startAt + CROSSFADE_SEC);
      layer3Src.connect(layer3Gain);
      layer3Gain.connect(mainGain);
    }

    const rate0 = this.currentMusicPlaybackRate;
    ambientSrc.playbackRate.value = rate0;
    melodicSrc.playbackRate.value = rate0;
    if (layer3Src) layer3Src.playbackRate.value = rate0;

    ambientSrc.start(startAt);
    melodicSrc.start(startAt);
    if (layer3Src) layer3Src.start(startAt);

    // Fade the outgoing track out over the same window, then stop its sources.
    outgoing.mainGain.gain.cancelScheduledValues(t);
    outgoing.mainGain.gain.setValueAtTime(outgoing.mainGain.gain.value, t);
    outgoing.mainGain.gain.setValueAtTime(outgoing.mainGain.gain.value, startAt);
    outgoing.mainGain.gain.exponentialRampToValueAtTime(0.0001, startAt + CROSSFADE_SEC);
    const outgoingStopAt = startAt + CROSSFADE_SEC + 0.1;
    outgoing.ambientSrc.stop(outgoingStopAt);
    outgoing.melodicSrc.stop(outgoingStopAt);
    if (outgoing.layer3Src) outgoing.layer3Src.stop(outgoingStopAt);

    this.haloMusic = {
      ambientSrc, melodicSrc, layer3Src,
      ambientGain, melodicGain, layer3Gain, mainGain,
      variation, melodicActive: true,
      layer3Active: layer3Src !== null,
      climaxActive: true,
      startedAtAudioTime: startAt,
      startedAtBeatTime,
      currentPlaybackRate: rate0,
    };
  }

  // Fade the melodic layer in (true) or out (false). 0.5s fade-in matches the
  // legacy setHaloAmbientTier curve; 0.9s fade-out is slightly slower so a
  // single mistimed shot doesn't strip the melody abruptly.
  setHaloMusicMelodicLayer(active: boolean): void {
    if (!this.ctx || !this.haloMusic) return;
    if (this.haloMusic.melodicActive === active) return;
    const t = this.ctx.currentTime;
    const peakGain = this.haloMelodicGain(this.haloMusic.variation);
    const target = active ? Math.max(0.0001, peakGain) : 0.0001;
    const ramp = active ? 0.5 : 0.9;
    this.haloMusic.melodicGain.gain.cancelScheduledValues(t);
    this.haloMusic.melodicGain.gain.setValueAtTime(this.haloMusic.melodicGain.gain.value, t);
    this.haloMusic.melodicGain.gain.exponentialRampToValueAtTime(target, t + ramp);
    this.haloMusic.melodicActive = active;
  }

  // Fade layer 3 in (true) or out (false). Slightly slower fade-in than
  // melodic (0.7s vs 0.5s) so the 12x reward blooms in rather than snapping.
  // 1.1s fade-out cushions a combo break so the layer rings down instead of
  // cutting.
  setHaloMusicLayer3(active: boolean): void {
    if (!this.ctx || !this.haloMusic) return;
    if (!this.haloMusic.layer3Gain) return;
    if (this.haloMusic.layer3Active === active) return;
    const t = this.ctx.currentTime;
    const peakGain = this.haloLayer3Gain(this.haloMusic.variation);
    const target = active ? Math.max(0.0001, peakGain) : 0.0001;
    const ramp = active ? 0.7 : 1.1;
    this.haloMusic.layer3Gain.gain.cancelScheduledValues(t);
    this.haloMusic.layer3Gain.gain.setValueAtTime(this.haloMusic.layer3Gain.gain.value, t);
    this.haloMusic.layer3Gain.gain.exponentialRampToValueAtTime(target, t + ramp);
    this.haloMusic.layer3Active = active;
  }

  // Long fade-out + teardown. ~1.2s matches stopHaloAmbient so swapping
  // between the legacy pad and the pre-rendered music feels consistent on
  // combo break.
  stopHaloMusic(): void {
    if (!this.ctx || !this.haloMusic) return;
    const t = this.ctx.currentTime;
    const node = this.haloMusic;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    const stopAt = t + 1.3;
    node.ambientSrc.stop(stopAt);
    node.melodicSrc.stop(stopAt);
    if (node.layer3Src) node.layer3Src.stop(stopAt);
    this.haloMusic = null;
  }

  // === Full-length halo music (the parallel "different system" for L1–9) ===

  private haloFullMusicUrl(song: FullHaloSongId, layer: number): string {
    return `/sounds/halo-music-full/${song}-l${layer}.mp3`;
  }

  // Per-layer peak gain for the six full-song tiers (l1→l6). The build script
  // already peak-normalizes each stem to ~-12 dBFS, so these are light
  // perceptual trims rather than the big per-variation calibration the loop
  // pool needs. The palette is section-built (see haloFullMusicConfig.ts
  // layerOrder): atmosphere bed, then a no-guitar pulse, then guitar, bass,
  // drums-high, and a shimmer climax — each new tier reads as an arrival.
  private haloFullMusicLayerGain(_song: FullHaloSongId, layerIdx: number): number {
    const gains = [0.26, 0.28, 0.26, 0.30, 0.30, 0.26];
    return gains[layerIdx] ?? 0.26;
  }

  // Eagerly fetch + decode all six layer stems for a full song so the first 4x
  // doesn't pay fetch latency. Idempotent (loadHaloMusicBuffer caches).
  preloadHaloFullMusic(song: FullHaloSongId): void {
    // Pull the per-song beat-sync offset once so the first start reads the
    // drag-tuned value (mirrors preloadHaloMusic pulling loadMusicConfig).
    void loadHaloFullConfig();
    for (let i = 1; i <= 6; i++) {
      void this.loadHaloMusicBuffer(this.haloFullMusicUrl(song, i));
    }
  }

  // Start a full-length song. Six layer sources start phase-locked at the
  // measure-aligned downbeat; each layer's gain is faded up only once its
  // combo tier (FULL_HALO_TIER_THRESHOLDS) is already met at start. Non-looping
  // — onTrackEnd fires when the track finishes so the caller can roll to the
  // next song. measureAlignDelay/currentBeatTime mirror startHaloMusic.
  async startHaloFullMusic(song: FullHaloSongId, combo: number,
                           measureAlignDelay: number = 0,
                           currentBeatTime: number = 0,
                           onTrackEnd: (() => void) | null = null,
                           loopForTuning: boolean = false): Promise<void> {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    // Same song already running — just sync the tiers.
    if (this.haloFullMusic && this.haloFullMusic.song === song) {
      this.setHaloFullMusicTier(combo);
      return;
    }
    if (this.haloFullMusic) this.stopHaloFullMusic();
    // A full song and a loop track never play together.
    if (this.haloMusic) this.stopHaloMusic();

    const bufs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => this.loadHaloMusicBuffer(this.haloFullMusicUrl(song, i + 1), true)),
    );
    if (!this.ctx || !this.master) return;
    if (this.haloFullMusic) return;  // raced with another start
    if (bufs.some((b) => !b)) return;  // a layer failed to load — bail cleanly

    const t = this.ctx.currentTime;
    const startAt = t + Math.max(0, measureAlignDelay);
    const startedAtBeatTime = currentBeatTime + (startAt - t);
    const activeTier = this.fullTierForCombo(combo);

    // Per-LAYER beat-sync offsets (seconds), drag-tuned on the /music page and
    // persisted to halo-full-config.json. The song's musical downbeat sits this
    // far into each stem; reading from there lands it on the bass-field
    // downbeat. Each is wrapped into [0, duration) so a negative or >duration
    // value cycles cleanly. Layers normally share one value (fullHaloLayerOffset
    // falls back to the song offset) but a single stem can be nudged
    // independently (cmd-drag). The game path (loopForTuning=false) reads from
    // the offset to the natural end; the tuning view loops so the dropped head
    // plays at the tail (the end→beginning cycling the editor wants).
    const wrap = (raw: number, d: number) => (d > 0 ? ((raw % d) + d) % d : 0);
    const layerOffsets = bufs.map((b, i) => wrap(fullHaloLayerOffset(song, i), b!.duration));
    const offset = layerOffsets[0];

    const mainGain = this.ctx.createGain();
    mainGain.gain.value = 1.0;
    if (this.chMusicLive) mainGain.connect(this.chMusicLive);

    const layerSrcs: AudioBufferSourceNode[] = [];
    const layerGains: GainNode[] = [];
    const muteGains: GainNode[] = [];
    for (let i = 0; i < 6; i++) {
      const src = this.ctx.createBufferSource();
      src.buffer = bufs[i];
      if (loopForTuning) {
        src.loop = true;
        src.loopStart = 0;
        src.loopEnd = bufs[i]!.duration;
      } else {
        src.loop = false;
      }
      const g = this.ctx.createGain();
      const peak = this.haloFullMusicLayerGain(song, i);
      g.gain.setValueAtTime(0.0001, startAt);
      // Fade this layer up immediately if its tier is already met at start.
      if (i <= activeTier) {
        g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), startAt + 1.5);
      }
      // Mute gain sits between the tier gain and main; 1.0 unless the editor
      // mutes this layer (see setHaloFullMusicLayerMute).
      const m = this.ctx.createGain();
      m.gain.value = 1.0;
      src.connect(g);
      g.connect(m);
      m.connect(mainGain);
      layerSrcs.push(src);
      layerGains.push(g);
      muteGains.push(m);
    }

    // Seed the slow-mo rate so a song that starts mid-slomo opens slowed.
    // The start offset is in buffer-time (rate-independent), so setting rate
    // before .start() only affects playback speed, not where the head lands.
    const rate0 = this.currentMusicPlaybackRate;
    for (const src of layerSrcs) src.playbackRate.value = rate0;
    for (let i = 0; i < layerSrcs.length; i++) layerSrcs[i].start(startAt, layerOffsets[i]);

    const node: HaloFullMusicNode = {
      layerSrcs, layerGains, muteGains, mainGain, song,
      activeTier,
      startedAtAudioTime: startAt,
      startedAtBeatTime,
      currentPlaybackRate: rate0,
      onTrackEnd,
      offset,
      layerOffsets,
      loopForTuning,
    };
    // The l1 source spans the whole track, so its onended marks the song's
    // natural end. Guarded by the node still being current and onTrackEnd not
    // already consumed (a stop()-triggered onended must be a no-op).
    layerSrcs[0].onended = () => {
      if (this.haloFullMusic !== node) return;
      const cb = node.onTrackEnd;
      node.onTrackEnd = null;
      if (cb) cb();
    };
    this.haloFullMusic = node;
  }

  private fullTierForCombo(combo: number): number {
    let tier = -1;
    for (let i = 0; i < FULL_HALO_TIER_THRESHOLDS.length; i++) {
      if (combo >= FULL_HALO_TIER_THRESHOLDS[i]) tier = i;
    }
    return tier;
  }

  // Fade the six layers to match the current combo tier. Layers at or below the
  // active tier ramp up to their peak; layers above it ramp down to silence.
  // Idempotent: only re-ramps when the active tier actually changes.
  setHaloFullMusicTier(combo: number): void {
    if (!this.ctx || !this.haloFullMusic) return;
    const node = this.haloFullMusic;
    const tier = this.fullTierForCombo(combo);
    if (tier === node.activeTier) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < node.layerGains.length; i++) {
      const on = i <= tier;
      const peak = this.haloFullMusicLayerGain(node.song, i);
      const target = on ? Math.max(0.0001, peak) : 0.0001;
      // Higher tiers bloom in a touch slower; fade-outs cushion a combo dip.
      const ramp = on ? 0.6 : 1.0;
      const g = node.layerGains[i];
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.exponentialRampToValueAtTime(target, t + ramp);
    }
    node.activeTier = tier;
  }

  // Slow-mo: match the music playbackRate to the gameplay clock, same as
  // setHaloMusicPlaybackRate but across all six full-song layers.
  setHaloFullMusicPlaybackRate(rate: number, rampSec: number = 0): void {
    this.currentMusicPlaybackRate = rate;
    if (!this.haloFullMusic || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (const src of this.haloFullMusic.layerSrcs) {
      src.playbackRate.cancelScheduledValues(now);
      src.playbackRate.setValueAtTime(src.playbackRate.value, now);
      if (rampSec > 0) src.playbackRate.linearRampToValueAtTime(rate, now + rampSec);
      else src.playbackRate.setValueAtTime(rate, now);
    }
    this.haloFullMusic.currentPlaybackRate = rate;
  }

  // Re-seat a fresh looping source for one layer at a given base offset, picking
  // up at the elapsed position so it stays phase-coherent with the layers we
  // leave running. A BufferSource's read-head can't be moved in place, so we
  // stop the old source and start a new one (no fade — the editor wants an
  // immediate jump). Shared by the all-layers and single-layer offset setters.
  private reseatFullLayer(layerIdx: number, baseOffset: number, startAt: number): AudioBufferSourceNode | null {
    const node = this.haloFullMusic;
    if (!this.ctx || !node) return null;
    const old = node.layerSrcs[layerIdx];
    const dur = old?.buffer?.duration ?? 0;
    if (!old || dur <= 0) return null;
    const wrapped = ((baseOffset % dur) + dur) % dur;
    // Advance the read-head by however far the song has progressed since the
    // shared start, so this layer lands at the same elapsed point as the others.
    const elapsed = Math.max(0, (startAt - node.startedAtAudioTime) * node.currentPlaybackRate);
    const readAt = ((wrapped + elapsed) % dur + dur) % dur;
    try { old.onended = null; old.stop(startAt); } catch { /* already stopped */ }
    const src = this.ctx.createBufferSource();
    src.buffer = old.buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = dur;
    src.playbackRate.value = node.currentPlaybackRate;
    src.connect(node.layerGains[layerIdx]);
    src.start(startAt, readAt);
    node.layerSrcs[layerIdx] = src;
    node.layerOffsets[layerIdx] = wrapped;
    return src;
  }

  setHaloFullMusicOffset(offsetS: number): void {
    if (!this.ctx || !this.haloFullMusic) return;
    const node = this.haloFullMusic;
    if (!node.loopForTuning) return;
    const dur = node.layerSrcs[0]?.buffer?.duration ?? 0;
    if (dur <= 0) return;
    const offset = ((offsetS % dur) + dur) % dur;
    const now = this.ctx.currentTime;
    const startAt = now + 0.02;  // tiny lead so every layer re-starts in lockstep
    const rate = node.currentPlaybackRate;
    const fresh: AudioBufferSourceNode[] = [];
    for (let i = 0; i < node.layerSrcs.length; i++) {
      const old = node.layerSrcs[i];
      try { old.onended = null; old.stop(startAt); } catch { /* already stopped */ }
      const src = this.ctx.createBufferSource();
      src.buffer = old.buffer;
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = old.buffer ? old.buffer.duration : dur;
      src.playbackRate.value = rate;
      src.connect(node.layerGains[i]);
      src.start(startAt, offset);
      fresh.push(src);
      node.layerOffsets[i] = offset;
    }
    node.layerSrcs = fresh;
    node.offset = offset;
    node.startedAtAudioTime = startAt;
  }

  // /music Beat Sync editor — re-seat ONE layer at a new base offset (cmd-drag),
  // leaving the other five running so you hear that stem slide alone. Keeps the
  // shared startedAtAudioTime so the untouched layers stay phase-locked. No-ops
  // on a non-tuning (in-game) node.
  setHaloFullMusicLayerOffset(layerIdx: number, offsetS: number): void {
    if (!this.ctx || !this.haloFullMusic) return;
    const node = this.haloFullMusic;
    if (!node.loopForTuning) return;
    if (layerIdx < 0 || layerIdx >= node.layerSrcs.length) return;
    const startAt = this.ctx.currentTime + 0.02;
    this.reseatFullLayer(layerIdx, offsetS, startAt);
  }

  // /music Beat Sync editor — mute/unmute one layer independent of its combo
  // tier. Rides the dedicated mute gain so a tier ramp can't undo it. Short
  // ramp so toggling doesn't click. No-ops on a non-tuning (in-game) node.
  setHaloFullMusicLayerMute(layerIdx: number, muted: boolean): void {
    if (!this.ctx || !this.haloFullMusic) return;
    const node = this.haloFullMusic;
    if (!node.loopForTuning) return;
    const m = node.muteGains[layerIdx];
    if (!m) return;
    const t = this.ctx.currentTime;
    m.gain.cancelScheduledValues(t);
    m.gain.setValueAtTime(m.gain.value, t);
    m.gain.linearRampToValueAtTime(muted ? 0 : 1, t + 0.03);
  }

  // /music Beat Sync editor — current read position WITHIN the full song's
  // buffer (seconds, [0, duration)), derived from the audio clock so the editor
  // playhead is sample-accurate rather than frame-estimated. Accounts for the
  // start offset, the measure-align lead-in (negative elapsed before startAt
  // clamps to the offset), and the playbackRate. Returns null when nothing is
  // playing. Wraps, matching the looping tuning sources.
  fullMusicPlayheadSec(): number | null {
    if (!this.ctx || !this.haloFullMusic) return null;
    const node = this.haloFullMusic;
    const dur = node.layerSrcs[0]?.buffer?.duration ?? 0;
    if (dur <= 0) return null;
    const elapsed = (this.ctx.currentTime - node.startedAtAudioTime) * node.currentPlaybackRate;
    const pos = node.offset + Math.max(0, elapsed);
    return ((pos % dur) + dur) % dur;
  }

  // Long fade-out + teardown, matching stopHaloMusic's ~1.2s curve. Clears
  // onTrackEnd first so the scheduled stop()'s onended can't fire the
  // song-switch after a combo break.
  stopHaloFullMusic(): void {
    if (!this.ctx || !this.haloFullMusic) return;
    const t = this.ctx.currentTime;
    const node = this.haloFullMusic;
    node.onTrackEnd = null;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    const stopAt = t + 1.3;
    for (const src of node.layerSrcs) src.stop(stopAt);
    this.haloFullMusic = null;
  }

  // Comet-on-screen toggle. Slides the third voice between E4 (no comet) and
  // Eb4 (comet present) over ~0.8s — slow enough to read as a mood shift,
  // fast enough that the player connects it to the comet's appearance.
  setHaloAmbientCometMode(active: boolean) {
    if (this.haloAmbientCometMode === active) return;
    this.haloAmbientCometMode = active;
    if (!this.ctx || !this.haloAmbient) return;
    const t = this.ctx.currentTime;
    const targetHz = active ? 311.13 : 329.63;
    this.haloAmbient.thirdOsc.frequency.cancelScheduledValues(t);
    this.haloAmbient.thirdOsc.frequency.setValueAtTime(this.haloAmbient.thirdOsc.frequency.value, t);
    this.haloAmbient.thirdOsc.frequency.exponentialRampToValueAtTime(targetHz, t + 0.8);
  }

  stopHaloAmbient() {
    if (!this.ctx || !this.haloAmbient) return;
    const t = this.ctx.currentTime;
    const node = this.haloAmbient;
    node.mainGain.gain.cancelScheduledValues(t);
    node.mainGain.gain.setValueAtTime(node.mainGain.gain.value, t);
    // ~1.2s fade-out — long enough that the loss of halo feels musical, not
    // a hard mute. Bass drones stay, so the bed under the pad keeps playing.
    node.mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    const stopAt = t + 1.3;
    for (const o of node.oscs) o.stop(stopAt);
    for (const l of node.lfos) l.stop(stopAt);
    if (node.melodyInterval !== null) clearInterval(node.melodyInterval);
    this.haloAmbient = null;
    this.haloAmbientTier = 0;
  }

  // Pilot's Log vocal loader. Files live at /sounds/vocals/... — pre-rendered
  // ElevenLabs takes with bandpass + bitcrush + hiss applied so they already
  // sound like a scratchy astronaut radio. Decoded once per URL and cached;
  // subsequent plays are buffer-source cheap.
  private loadPilotLogBuffer(url: string, immediate = false): Promise<AudioBuffer | null> {
    const existing = this.pilotLogLoading.get(url);
    if (existing) return existing;
    if (this.pilotLogBuffers.has(url)) return Promise.resolve(this.pilotLogBuffers.get(url)!);
    if (!this.ctx) return Promise.resolve(null);
    const p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      // Preloads (a milestone ahead of the line) pace; playPilotLog passes
      // immediate because it has already reserved its downbeat slot.
      .then((ab) => (ab ? this.decodeAsset(ab, immediate) : null))
      .then((buf) => {
        if (buf) this.pilotLogBuffers.set(url, buf);
        this.pilotLogLoading.delete(url);
        return buf;
      })
      .catch(() => {
        this.pilotLogLoading.delete(url);
        return null;
      });
    this.pilotLogLoading.set(url, p);
    return p;
  }

  // Warm the buffer cache so the first playPilotLog doesn't pay fetch+decode
  // latency. `milestone` is the combo threshold (6, 12, ...). For pooled
  // milestones this warms every take so whichever one gets randomly picked at
  // fire time is already decoded.
  preloadPilotLog(milestone: number): void {
    this.ensureContext();
    for (const url of pilotLogUrlsForIndex(milestone)) void this.loadPilotLogBuffer(url);
  }

  // Fire a Pilot's Log vocal cue for the given combo milestone. Picks one
  // file at random from the milestone's pool (so repeat plays don't sound
  // canned), then routes through bakedOut so master comp/reverb doesn't smear
  // the spoken word. `delaySec` lets the caller align to a downbeat.
  async playPilotLog(milestone: number, delaySec = 0, gain = 1.0): Promise<number> {
    if (!this.enabled) return 0;
    // Vocals channel volume gates loudness — at 0 the channel gain mutes the
    // buffer source automatically, so no extra "vocals disabled" check needed.
    this.ensureContext();
    if (!this.ctx || !this.chVocalsBaked) return 0;
    const urls = pilotLogUrlsForIndex(milestone);
    if (urls.length === 0) return 0;
    // Cosmetic draw (see game/rng.ts) — which take plays doesn't affect
    //   sim state, but it must still be deterministic so a replay/export
    //   re-sim picks the exact take the original run played.
    const url = urls[Math.floor(cosmeticRng() * urls.length)];
    const targetStartTime = this.ctx.currentTime + Math.max(0, delaySec);
    const buf = await this.loadPilotLogBuffer(url, true);
    if (!buf || !this.ctx || !this.chVocalsBaked) return 0;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.chVocalsBaked);
    src.start(Math.max(this.ctx.currentTime, targetStartTime));
    return buf.duration;
  }

  // Lighter sibling of playBgBeat — used for the in-between eighths when the
  // background pulse doubles at white-bullet tier. Same voice as the main
  // beat (so it locks in tonally) at ~40% velocity so the new eighths read as
  // grace-note in-betweens, not as a thicker downbeat. Pitch is shifted up a
  // semitone (C#2 / D#2) so the bake cache stores it under a distinct key
  // from the main beat without re-baking on every dispatch.
  // Baked-only — matches playBgBeat's policy (see comment there for why the
  // live Tone fallback was removed). Light eighths only fire at combo ≥ 12,
  // which is many seconds into a run, so the bake cache is always warm by
  // the time this is reachable.
  playBgBeatLight(pitchRatio = 1) {
    if (!this.enabled) return;
    if (!this.ctx || !this.master) return;
    if (this.bgBeatIntensity <= 0) return;
    const intensity = Math.max(0, Math.min(1, this.bgBeatIntensity));
    const intensityBucket = Math.round(intensity * 10) / 10;
    // Light variant tagged in the bake key by a +1000 sentinel offset. Stays
    // unambiguous against the main beat's `pitchRatio * 100 + bucket`
    // encoding (max ~113) so the decode in bakeSound can identify "light" by
    // simply checking key > 500.
    const bgBeatPitchKey = pitchRatio * 100 + intensityBucket + 1000;
    this.playBaked("bgBeat", bgBeatPitchKey);
  }

  // Lookahead-scheduled pulse entry points. The bass clock computes the
  // absolute audio-clock time of each upcoming eighth-note slot and calls
  // these for slots inside the lookahead window; src.start(when) then lands
  // the buffer sample-accurately even if the deciding frame ran long. `when`
  // is an AudioContext.currentTime value (seconds). These mirror the
  // immediate playBgBeat / playBgBeatLight paths but stash the start time.
  playBgBeatAt(pitchRatio: number, when: number) {
    if (!this.enabled) return;
    this.ensureContext();
    this.scheduledWhenForCall = when;
    this.playBgBeat(pitchRatio);
    this.scheduledWhenForCall = null;
  }

  playBgBeatLightAt(pitchRatio: number, when: number) {
    this.scheduledWhenForCall = when;
    this.playBgBeatLight(pitchRatio);
    this.scheduledWhenForCall = null;
  }

  // Generic lookahead-scheduled one-shot: start any play()-dispatched voice
  // at an absolute audio-clock time (from audioTimeForBeatDelta). Baked
  // buffers honor it in playBaked; live-synth grid voices read voiceTime().
  playAt(name: SoundName, pitchRatio: number, when: number, pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    this.scheduledWhenForCall = when;
    try {
      this.play(name, pitchRatio, pos);
    } finally {
      this.scheduledWhenForCall = null;
    }
  }

  // Cached per requested duration. The samples are pure random noise — there's
  // no perceptible difference between "fresh noise every spawn" and a single
  // shared buffer, but allocating + filling a 6s buffer (264k samples) on every
  // bassteroid spawn was a noticeable main-thread stutter on slower devices.
  private noiseBufferCache: Map<number, AudioBuffer> = new Map();
  private makeNoiseBuffer(duration: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const cached = this.noiseBufferCache.get(duration);
    if (cached) return cached;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBufferCache.set(duration, buf);
    return buf;
  }

  // Noise source for a graph builder, which may be running live or inside an
  // OfflineAudioContext. Live renders keep hitting the shared per-duration
  // cache (same allocation behaviour as before); an offline bake gets its own
  // fresh draw, since the live cache's buffers belong to the live context.
  // Either way the content is white noise with the same distribution, so the
  // bake is statistically — not sample-for-sample — the live sound.
  private noiseBuffer(ctx: BaseAudioContext, duration: number): AudioBuffer | null {
    if (ctx === this.ctx) return this.makeNoiseBuffer(duration);
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  play(name: SoundName, pitchRatio = 1, pos?: Pos) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;

    // Universal volume + pitch knobs (from sounds/config.json). Volume is
    // applied by routing all voices of this call through a per-call gain
    // node sitting between master and the rest of the chain; we swap
    // this.master temporarily, run the play method (which connects its
    // voices into "master" — actually our voice gain), then restore. The
    // voice gain stays connected to the real master so its nodes outlive
    // the swap.
    //
    // Positional audio piggybacks on the same swap: when pos is provided we
    // insert a StereoPanner + distance-gain pair upstream of the (possibly
    // volume-adjusted) voice gain. The cached bakedOut path is spliced
    // separately inside playBaked.
    const u = cfgU(name);
    const effectivePitch = pitchRatio * u.pitch;
    const realMaster = this.master;
    // Build the chain bottom-up: sink = (volume gain → realMaster) if volume
    // differs, else realMaster. Then if positional, splice panner+distGain
    // upstream of sink. Finally we always swap this.master to a per-call
    // pass-through gain whose output feeds the chain — that way every
    // per-sound helper still calls `connect(this.master)` (a GainNode) and
    // we don't need to widen master's type.
    let sink: AudioNode = realMaster;
    if (u.volume !== 1) {
      const volGain = this.ctx.createGain();
      volGain.gain.value = u.volume;
      volGain.connect(sink);
      sink = volGain;
    }
    if (pos) {
      const spatial = this.makeSpatial(pos, sink);
      if (spatial) sink = spatial.panner;
    }
    let voiceMaster: GainNode | null = null;
    if (sink !== realMaster) {
      voiceMaster = this.ctx.createGain();
      voiceMaster.connect(sink);
      this.master = voiceMaster;
    }
    // Stash so playBaked can pick the same splice up without re-threading
    // pos through every per-sound helper.
    this.spatialPosForCall = pos ?? null;

    switch (name) {
      case "fire": this.playFire(); break;
      case "fireBeat": this.playFireBeat(); break;
      case "fireBomb": this.playFireBomb(); break;
      case "fireBombBeat": this.playFireBombBeat(); break;
      case "explosionLarge": this.playExplosion("explosionLarge"); break;
      case "explosionMedium": this.playExplosion("explosionMedium"); break;
      case "explosionSmall": this.playExplosion("explosionSmall"); break;
      case "asteroidBoomBeat": this.playAsteroidBoomBeat(); break;
      case "thrust": this.startThrust(); break;
      case "reverseThrust": this.startReverseThrust(); break;
      case "sideThrust": this.startSideThrust(); break;
      case "death": this.playDeath(); break;
      case "waveClear": this.playWaveClear(); break;
      case "bassKick": this.playBassKick(effectivePitch); break;
      case "bassPluck": this.playBassPluck(effectivePitch); break;
      case "bassBoom": this.playBassBoom(effectivePitch); break;
      case "bassSnap": this.playBassSnap(effectivePitch); break;
      case "bassHit": this.playBassHit(); break;
      case "bassEcho": this.playBassEcho(); break;
      case "chime": this.playChime(effectivePitch); break;
      case "bell": this.playBell(effectivePitch); break;
      case "warble": this.playWarble(); break;
      case "comboTick": this.playComboTick(); break;
      case "comboSparkle": this.playComboSparkle(); break;
      case "tink": this.playTink(); break;
      case "crystalShatterLarge": this.playCrystalShatter("large", effectivePitch); break;
      case "crystalShatterSmall": this.playCrystalShatter("small", effectivePitch); break;
      case "scoreBlip": this.playScoreBlip(effectivePitch); break;
      case "summaryDownbeat": this.playSummaryDownbeat(Math.round(pitchRatio)); break;
      case "summaryDownbeatDucked": this.playSummaryDownbeat(Math.round(pitchRatio), true); break;
      case "drainChime": this.playDrainChime(Math.round(pitchRatio)); break;
      case "powerup": this.playPowerup(); break;
      case "bonusLife": this.playBonusLife(); break;
      case "shieldPop": this.playShieldPop(); break;
      case "pulsarHum": this.playPulsarHum(); break;
      case "bgBeat": this.playBgBeat(effectivePitch); break;
      case "shockwaveCharge": this.playShockwaveCharge(); break;
      case "shockwaveBoom": this.playShockwaveBoom(); break;
      case "alienFireBig": this.playAlienFireBig(); break;
      case "alienFireMedium": this.playAlienFireMedium(); break;
      case "alienFireSmall": this.playAlienFireSmall(); break;
      case "alienHit": this.playAlienHit(); break;
      case "alienExplode": this.playAlienExplode(); break;
      case "cometNote": this.playCometNote(Math.round(effectivePitch)); break;
      case "cometDestroyed": this.playCometDestroyed(); break;
      case "cometDestroyedSad": this.playCometDestroyedSad(); break;
      case "meteorShower": this.playMeteorShower(); break;
      case "gemSwarm": this.playGemSwarm(); break;
      case "canisterAppear": this.playCanisterAppear(); break;
      case "canisterDestroyed": this.playCanisterDestroyed(); break;
      case "comboLost": this.playComboLost(); break;
      case "comboLostFire": this.playComboLostFire(); break;
      case "wraithScream": this.playWraithScream(); break;
      case "wraithHit": this.playWraithHit(); break;
      case "wraithLunge": this.playWraithLunge(); break;
      case "wraithDeath": this.playWraithDeath(); break;
      case "bossPulse": this.playBossPulse(); break;
      case "bossHit": this.playBossHit(); break;
      case "bossEyeOpenStinger": this.playBossEyeOpenStinger(); break;
    }

    this.master = realMaster;
    this.spatialPosForCall = null;
  }

  // Three alien-fire voices, harmonically related so they layer cleanly with
  // the bassteroid bed (C major / I-iii-V flavour). All three open with a
  // brief portamento-style pitch bend so each shot reads as "musical noise"
  // rather than a sterile bleep, and each leans on a different timbre so the
  // player can tell which size fired from sound alone.
  //
  // big    : Sampled electric guitar power chord (root/5th/octave) from a
  //          FreePats CC0 SF2, cycled through an E-minor riff. Pitch-shifted
  //          via playbackRate per shot. Falls back to silence if the WAV
  //          asset is missing — see loadGuitarSample.
  // medium : Same sampled electric guitar as big, voiced one octave up
  //          (C2/E2 riff) so the two sizes still read as distinct.
  // small  : G5 (784 Hz) — sharp triangle pluck with a fast vibrato, sits
  //          on top of the mix as a melodic ostinato when several smalls
  //          are firing in succession.

  private playAlienFireBig() {
    // The riff position only advances on a shot that actually sounds — a shot
    // fired before the WAV decodes must not eat a note, or the first audible
    // shot of a session lands somewhere else in the cycle than it should.
    const step = this.bigAlienFireStep;
    const variant = Sound.alienFireVariant(step);
    const advance = () => { this.bigAlienFireStep = (step + 1) % Sound.ALIEN_FIRE_CYCLE; };
    if (this.playBaked("alienFireBig", variant)) { advance(); return; }
    if (!this.ctx || !this.master) return;
    if (!this.guitarSampleJazz || !this.guitarSampleGretsch) {
      this.loadGuitarSample();
      return;
    }
    advance();
    this.buildAlienFireBigGraph(this.ctx, this.master, this.voiceTime("alienFireBig"), variant);
  }

  private buildAlienFireBigGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, variant: number) {
    const buf = variant < 2 ? this.guitarSampleJazz : this.guitarSampleGretsch;
    if (!buf) return;

    // Both candidate WAVs are recorded at A3 (220 Hz).
    const SAMPLE_RECORDED_HZ = 220.0;

    // Riff cycle: C1 E1 C1 E1 … — sits in C major against the bassteroid
    // bed. One note per shot; the variant's low bit picks which.
    const rootHz = variant % 2 === 0 ? 32.70 : 41.20;

    // Single plucked note per shot. The riff across consecutive shots
    // carries the musicality — no chord stack. Flat gain so the WAV's
    // own attack transient and exponential decay read as the note shape.
    // The buffer's playback duration depends on playbackRate because
    // pitch-shifting down stretches the file — so the stop time must
    // be computed from the actual stretched length, not the WAV's
    // intrinsic 1.8 s, or the source gets cut mid-decay and clicks.
    const rate = rootHz / SAMPLE_RECORDED_HZ;
    // Cap at 2.0 s — one bass-downbeat slot — so a shot overlaps at most
    // the wave it fires on plus the next, never further.
    const playbackDur = Math.min((buf.duration / rate) * 0.35, 2.0);

    // Highpass at 90 Hz kills the sub-rumble that the heavy pitch-shift
    // (~0.15x rate) introduces; peaking scoop at 280 Hz pulls the
    // low-mid mud out so the note reads as a pluck instead of a boom.
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 90;
    hp.Q.value = 0.7;

    const scoop = ctx.createBiquadFilter();
    scoop.type = "peaking";
    scoop.frequency.value = 280;
    scoop.Q.value = 1.0;
    scoop.gain.value = -8;

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0.80, t);
    voiceGain.gain.setValueAtTime(0.80, t + Math.max(0, playbackDur - 0.080));
    voiceGain.gain.linearRampToValueAtTime(0.0001, t + playbackDur);

    hp.connect(scoop);
    scoop.connect(voiceGain);
    voiceGain.connect(dest);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(hp);
    src.start(t);
    src.stop(t + playbackDur + 0.01);
  }

  private playAlienFireMedium() {
    const step = this.mediumAlienFireStep;
    const variant = Sound.alienFireVariant(step);
    const advance = () => { this.mediumAlienFireStep = (step + 1) % Sound.ALIEN_FIRE_CYCLE; };
    if (this.playBaked("alienFireMedium", variant)) { advance(); return; }
    if (!this.ctx || !this.master) return;
    if (!this.guitarSampleJazz || !this.guitarSampleGretsch) {
      this.loadGuitarSample();
      return;
    }
    advance();
    this.buildAlienFireMediumGraph(this.ctx, this.master, this.voiceTime("alienFireMedium"), variant);
  }

  private buildAlienFireMediumGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, variant: number) {
    const buf = variant < 2 ? this.guitarSampleJazz : this.guitarSampleGretsch;
    if (!buf) return;
    // Same sampled-guitar voice as the big alien, one octave up so the
    // two sizes still read as distinct. Cycle: C2 E2 C2 E2…
    const SAMPLE_RECORDED_HZ = 220.0;
    const rootHz = variant % 2 === 0 ? 65.41 : 82.41;
    const rate = rootHz / SAMPLE_RECORDED_HZ;
    const playbackDur = buf.duration / rate;
    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0.55, t);
    voiceGain.gain.setValueAtTime(0.55, t + playbackDur - 0.020);
    voiceGain.gain.linearRampToValueAtTime(0.0001, t + playbackDur);
    voiceGain.connect(dest);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(voiceGain);
    src.start(t);
  }

  private playAlienFireSmall() {
    if (this.playBaked("alienFireSmall", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildAlienFireSmallGraph(this.ctx, this.master, this.voiceTime("alienFireSmall"));
  }

  private buildAlienFireSmallGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const f0 = 784; // G5
    // Triangle carrier with a fast vibrato — sits in the upper mid, doesn't
    // mask anything else even when fired every half-beat.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(f0 * 0.95, t);
    osc.frequency.exponentialRampToValueAtTime(f0, t + 0.025);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 16;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 18;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.13, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.18);
    lfo.stop(t + 0.18);

    // Tiny upward partial — fifth above — gives each shot a 8-bit chip
    // character.
    const p2 = ctx.createOscillator();
    p2.type = "sine";
    p2.frequency.value = f0 * 1.5;
    const p2Gain = ctx.createGain();
    p2Gain.gain.setValueAtTime(0.0001, t);
    p2Gain.gain.exponentialRampToValueAtTime(0.05, t + 0.004);
    p2Gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    p2.connect(p2Gain);
    p2Gain.connect(dest);
    p2.start(t);
    p2.stop(t + 0.1);
  }

  // Non-killing alien hit — short metallic spank that says "I dinged it"
  // without being as heavy as bassHit. Bandpassed noise + a high triangle
  // ping.
  private playAlienHit() {
    if (this.playBaked("alienHit", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildAlienHitGraph(this.ctx, this.master, this.voiceTime("alienHit"));
  }

  private buildAlienHitGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const noiseBuf = this.noiseBuffer(ctx, 0.08);
    if (!noiseBuf) return;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(1200, t + 0.08);
    filter.Q.value = 1.4;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.22, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(dest);
    noise.start(t);
    noise.stop(t + 0.1);

    const ping = ctx.createOscillator();
    ping.type = "triangle";
    ping.frequency.setValueAtTime(1320, t);
    ping.frequency.exponentialRampToValueAtTime(660, t + 0.1);
    const pingGain = ctx.createGain();
    pingGain.gain.setValueAtTime(0.0001, t);
    pingGain.gain.exponentialRampToValueAtTime(0.16, t + 0.004);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    ping.connect(pingGain);
    pingGain.connect(dest);
    ping.start(t);
    ping.stop(t + 0.15);
  }

  // Alien destruction — a small requiem: a brief breath of hit-noise, a
  // mournful Eb temple-bell (b3 of C, the minor colour the halo lives in),
  // a sine sigh falling G4→Eb4→C4→Bb3 with the lowpass closing down like a
  // voice trailing off, and a faint C2 sub that swells in late and lingers
  // as the absence. No explosion thud — the kill should land as loss.
  private playAlienExplode() {
    if (this.playBaked("alienExplode", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildAlienExplodeGraph(this.ctx, this.master, this.voiceTime("alienExplode"));
  }

  private buildAlienExplodeGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    // Gasp — bandpassed noise puff, short and high so it reads as a breath
    // catching rather than a body bursting.
    const gaspBuf = this.noiseBuffer(ctx, 0.18);
    if (gaspBuf) {
      const gasp = ctx.createBufferSource();
      gasp.buffer = gaspBuf;
      const gFilter = ctx.createBiquadFilter();
      gFilter.type = "bandpass";
      gFilter.frequency.setValueAtTime(1800, t);
      gFilter.frequency.exponentialRampToValueAtTime(700, t + 0.18);
      gFilter.Q.value = 2.2;
      const gGain = ctx.createGain();
      gGain.gain.setValueAtTime(0.0001, t);
      gGain.gain.exponentialRampToValueAtTime(0.12, t + 0.012);
      gGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      gasp.connect(gFilter);
      gFilter.connect(gGain);
      gGain.connect(dest);
      gasp.start(t);
      gasp.stop(t + 0.22);
    }

    // Eb temple bell with inharmonic partials. Same DNA as playBell — ratios
    // 2.76 / 5.4 / 8.93 give the tolled-bell timbre — but tuned to Eb4 and
    // given a much longer decay so the note hangs and mourns.
    const bellFund = 311.13; // Eb4 — b3 of C minor, the mode's grief pitch
    const bellRatios = [1, 2.76, 5.4, 8.93];
    const bellPeak = 0.18;
    const bellDecay = 2.6;
    for (let i = 0; i < bellRatios.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = bellFund * bellRatios[i];
      const peak = bellPeak / (i + 1.4);
      const decay = Math.max(0.4, bellDecay - i * 0.35);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }

    // The sigh — sine glissando G4 → Eb4 → C4 → Bb3 over ~0.9s, a voice
    // settling downward through the C-minor scale and out. Lowpass closes
    // as it falls so the timbre darkens with the pitch.
    const sigh = ctx.createOscillator();
    sigh.type = "sine";
    sigh.frequency.setValueAtTime(392.00, t + 0.04);        // G4
    sigh.frequency.exponentialRampToValueAtTime(311.13, t + 0.32); // Eb4
    sigh.frequency.exponentialRampToValueAtTime(261.63, t + 0.62); // C4
    sigh.frequency.exponentialRampToValueAtTime(233.08, t + 0.95); // Bb3
    const sighFilter = ctx.createBiquadFilter();
    sighFilter.type = "lowpass";
    sighFilter.Q.value = 0.9;
    sighFilter.frequency.setValueAtTime(1800, t);
    sighFilter.frequency.exponentialRampToValueAtTime(420, t + 1.0);
    const sighGain = ctx.createGain();
    sighGain.gain.setValueAtTime(0.0001, t);
    sighGain.gain.exponentialRampToValueAtTime(0.14, t + 0.08);
    sighGain.gain.setTargetAtTime(0.08, t + 0.4, 0.25);
    sighGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
    sigh.connect(sighFilter);
    sighFilter.connect(sighGain);
    sighGain.connect(dest);
    sigh.start(t + 0.04);
    sigh.stop(t + 1.1);

    // The absence — a C2 sub that fades in late, after the sigh is gone,
    // and lingers as the chest-pressure of "something is missing now".
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 65.41; // C2
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    subGain.gain.exponentialRampToValueAtTime(0.18, t + 1.1);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + 2.7);
  }

  // Long tension-building windup played while the pulsar vibrates and spins
  // itself up. Length matches Pulsar.SHOCK_VIBRATE_DURATION so it
  // tops out exactly as the flash fires. Layers a deep sub that holds low
  // then climbs into the drop, a near-DC sine for chest pressure, an
  // accelerating "spin-up whine" whose frequency tracks the pulsar's
  // quadratic angular acceleration on screen, and a snare-roll noise wash
  // that ducks to silence right before the apex.
  private playShockwaveCharge() {
    if (this.playBaked("shockwaveCharge", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildShockwaveChargeGraph(this.ctx, this.master, this.voiceTime("shockwaveCharge"));
  }

  private buildShockwaveChargeGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const duration = 12.0;

    // Sub carrier — held low for the first 60% of the windup then sweeps up
    // sharply so the tension peak lands right before the drop.
    const sub = ctx.createOscillator();
    sub.type = "sawtooth";
    sub.frequency.setValueAtTime(28, t);
    sub.frequency.exponentialRampToValueAtTime(36, t + duration * 0.6);
    sub.frequency.exponentialRampToValueAtTime(190, t + duration);
    const subFilter = ctx.createBiquadFilter();
    subFilter.type = "lowpass";
    subFilter.Q.value = 8;
    subFilter.frequency.setValueAtTime(120, t);
    subFilter.frequency.exponentialRampToValueAtTime(900, t + duration);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.42, t + duration);
    sub.connect(subFilter);
    subFilter.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + duration + 0.05);

    // Near-DC reinforcement — gives the long windup real chest pressure even
    // before the sub carrier starts climbing.
    const subSine = ctx.createOscillator();
    subSine.type = "sine";
    subSine.frequency.setValueAtTime(22, t);
    subSine.frequency.exponentialRampToValueAtTime(90, t + duration);
    const subSineGain = ctx.createGain();
    subSineGain.gain.setValueAtTime(0.0001, t);
    subSineGain.gain.exponentialRampToValueAtTime(0.55, t + duration);
    subSine.connect(subSineGain);
    subSineGain.connect(dest);
    subSine.start(t);
    subSine.stop(t + duration + 0.05);

    // Spin-up whine. Frequency rises quadratically in t (matches the
    // quadratic angular acceleration on the visual side) so the player hears
    // the pulsar speeding up. We sample the curve at 24 control points so
    // it sweeps smoothly without us having to schedule one ramp per frame.
    const whine = ctx.createOscillator();
    whine.type = "sawtooth";
    const startHz = 120;
    const endHz = 1800;
    const samples = 24;
    whine.frequency.setValueAtTime(startHz, t);
    for (let i = 1; i <= samples; i++) {
      const ti = i / samples;
      const f = startHz + (endHz - startHz) * ti * ti;
      whine.frequency.linearRampToValueAtTime(f, t + ti * duration);
    }
    const whineFilter = ctx.createBiquadFilter();
    whineFilter.type = "bandpass";
    whineFilter.Q.value = 3;
    whineFilter.frequency.setValueAtTime(startHz, t);
    whineFilter.frequency.exponentialRampToValueAtTime(endHz, t + duration);
    const whineGain = ctx.createGain();
    whineGain.gain.setValueAtTime(0.0001, t);
    // Stays quiet for the first second so the windup builds, then climbs
    // hard. Capped well below the sub so the spin-up colours the sound
    // rather than dominating it.
    whineGain.gain.exponentialRampToValueAtTime(0.04, t + duration * 0.4);
    whineGain.gain.exponentialRampToValueAtTime(0.22, t + duration);
    whine.connect(whineFilter);
    whineFilter.connect(whineGain);
    whineGain.connect(dest);
    whine.start(t);
    whine.stop(t + duration + 0.05);

    // Tail-end "snare roll" noise wash — accelerates the same way the visual
    // jitter does, so the last second feels like the universe is about to
    // tear. Bandpass swept upward; gain ramps in late and ducks just before
    // the drop to leave silence at the apex.
    const noiseBuf = this.noiseBuffer(ctx, duration);
    if (noiseBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.frequency.setValueAtTime(400, t);
      nFilter.frequency.exponentialRampToValueAtTime(3500, t + duration);
      nFilter.Q.value = 1.2;
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + duration * 0.5);
      nGain.gain.exponentialRampToValueAtTime(0.18, t + duration * 0.95);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(dest);
      noise.start(t);
      noise.stop(t + duration + 0.05);
    }
  }

  // Bass drop — the payoff for the long windup. Deep sub fundamental that
  // punches in at t=0, fat saw body pitching down, square sub-octave growl
  // for grit, and a wide noise wash for the wavefront. Designed to feel
  // like the floor dropping out under the player.
  private playShockwaveBoom() {
    if (this.playBaked("shockwaveBoom", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildShockwaveBoomGraph(this.ctx, this.master, this.voiceTime("shockwaveBoom"));
  }

  private buildShockwaveBoomGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    // Sub thud — louder, lower, and with a long decay so the floor stays
    // gone for a beat.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(95, t);
    sub.frequency.exponentialRampToValueAtTime(12, t + 1.0);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(1.0, t + 0.012);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + 3.3);

    // Body — fat sawtooth pitch-down with hard front transient.
    const body = ctx.createOscillator();
    body.type = "sawtooth";
    body.frequency.setValueAtTime(150, t);
    body.frequency.exponentialRampToValueAtTime(22, t + 1.2);
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = "lowpass";
    bodyFilter.Q.value = 4;
    bodyFilter.frequency.setValueAtTime(900, t);
    bodyFilter.frequency.exponentialRampToValueAtTime(90, t + 2.5);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.85, t + 0.02);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 3.0);
    body.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(t);
    body.stop(t + 3.1);

    // Square sub-octave growl — adds the gritty edge classic bass drops have
    // without taking the low end out of pure-sine territory.
    const growl = ctx.createOscillator();
    growl.type = "square";
    growl.frequency.setValueAtTime(58, t);
    growl.frequency.exponentialRampToValueAtTime(20, t + 1.4);
    const growlFilter = ctx.createBiquadFilter();
    growlFilter.type = "lowpass";
    growlFilter.Q.value = 2;
    growlFilter.frequency.setValueAtTime(220, t);
    growlFilter.frequency.exponentialRampToValueAtTime(70, t + 2.0);
    const growlGain = ctx.createGain();
    growlGain.gain.setValueAtTime(0.0001, t);
    growlGain.gain.exponentialRampToValueAtTime(0.32, t + 0.03);
    growlGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    growl.connect(growlFilter);
    growlFilter.connect(growlGain);
    growlGain.connect(dest);
    growl.start(t);
    growl.stop(t + 2.5);

    // Wide noise wash — the wavefront passing over you.
    const noiseBuf = this.noiseBuffer(ctx, 2.5);
    if (noiseBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.frequency.setValueAtTime(1600, t);
      nFilter.frequency.exponentialRampToValueAtTime(60, t + 1.8);
      nFilter.Q.value = 1.0;
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.exponentialRampToValueAtTime(0.48, t + 0.025);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(dest);
      noise.start(t);
      noise.stop(t + 2.5);
    }
  }

  // ~20-second deep "brrrmmm" drone played on wave clear. Two slightly
  // detuned sawtooths at ~50–58 Hz pushed through a slow-sweeping lowpass,
  // plus a sub sine for the chest-thump and a quiet noise wash for breath.
  // The whole bus envelopes up fast and decays quickly so the tremolo swells
  // read as in-time pulses rather than a long sustained hum.
  private playPulsarHum() {
    if (this.playBaked("pulsarHum", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildPulsarHumGraph(this.ctx, this.master, this.voiceTime("pulsarHum"));
  }

  private buildPulsarHumGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const duration = 20;

    // Decay quickly so the bass hum doesn't drown out subsequent beats —
    // most of the audible body lives in the first ~3 seconds.
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(0.32, t + 0.3);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
    bus.connect(dest);

    // Tremolo locked to 2× the beat rate (BEAT_GRID = 0.5s → 2 Hz beat, so
    // 4 Hz tremolo). Depth bumped up so each pulse reads distinctly.
    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 1.0;
    tremoloGain.connect(bus);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 4;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.55;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);
    lfo.start(t);
    lfo.stop(t + duration + 0.2);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(520, t + 1.5);
    filter.frequency.exponentialRampToValueAtTime(120, t + duration);
    filter.connect(tremoloGain);

    const saw1 = ctx.createOscillator();
    saw1.type = "sawtooth";
    saw1.frequency.value = 51;
    const saw2 = ctx.createOscillator();
    saw2.type = "sawtooth";
    saw2.frequency.value = 57.3;
    saw1.connect(filter);
    saw2.connect(filter);
    saw1.start(t);
    saw2.start(t);
    saw1.stop(t + duration + 0.2);
    saw2.stop(t + duration + 0.2);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 36;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.6;
    sub.connect(subGain);
    subGain.connect(bus);
    sub.start(t);
    sub.stop(t + duration + 0.2);

    const noiseBuf = this.noiseBuffer(ctx, duration + 0.5);
    if (noiseBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const nFilter = ctx.createBiquadFilter();
      nFilter.type = "bandpass";
      nFilter.frequency.value = 240;
      nFilter.Q.value = 1.5;
      const nGain = ctx.createGain();
      nGain.gain.value = 0.08;
      noise.connect(nFilter);
      nFilter.connect(nGain);
      nGain.connect(bus);
      noise.start(t);
      noise.stop(t + duration + 0.2);
    }
  }

  // Background "pulsar approach" beat — a deep sub-bass thud that fires on
  // every BEAT_GRID tick from Game. Volume scales with bgBeatIntensity (set
  // per wave, 0 at wave 1 → 1 at wave 30) so it interpolates from fainter-
  // than-any-other-sound up to an ominous rumble as the pulsar gets close.
  // pitchRatio carries the on/off-beat flag from the caller: 1.0 on downbeats,
  // slightly above 1 on offbeats so the pattern reads as a heartbeat rhythm
  // rather than a flat metronome.
  //
  // Baked-only: the live Tone fallback was removed because its scheduler
  // lookahead (~100ms) made the first few beats land late before the bake
  // cache warmed up, then "snap" onto the grid mid-run — the perceptual
  // effect was the early beats sounding clustered/faster than they should
  // be. Dropping the fallback means the first beat or two during cache
  // warmup may go silent — far less disorienting than late thuds, and
  // warmBakedCache now queues the early-wave downbeat buckets first so the
  // silent window is short. Intensity/offbeat amplitude is encoded into the
  // baked buffer at bake time (see the bgBeat case in bakeSound).
  private playBgBeat(pitchRatio = 1) {
    if (!this.ctx || !this.master) return;
    if (this.bgBeatIntensity <= 0) return;
    const intensity = Math.max(0, Math.min(1, this.bgBeatIntensity));
    const intensityBucket = Math.round(intensity * 10) / 10;
    const bgBeatPitchKey = pitchRatio * 100 + intensityBucket;
    this.playBaked("bgBeat", bgBeatPitchKey);
  }

  // Plucked-string "pew" for non-rhythm shots — quieter and shorter than
  // the on-beat version (playFireBeat) so untimed fire feels like the weak
  // mode and the rhythm shot is the obvious power tier. Same musical-pluck
  // shape (G4 fundamental, octave partial, soft tick) at reduced gain.
  private playFire() {
    if (this.playBaked("fire", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildFireGraph(this.ctx, this.master, this.voiceTime("fire"));
  }

  private buildFireGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const bodyHz = cfgN("fire", "bodyHz", 392);
    const bodyPeak = cfgN("fire", "bodyPeak", 0.16);
    const bodyDecay = cfgN("fire", "bodyDecay", 0.11);
    const partialHz = cfgN("fire", "partialHz", 784);
    const partialPeak = cfgN("fire", "partialPeak", 0.07);
    const partialDecay = cfgN("fire", "partialDecay", 0.05);
    const tickHz = cfgN("fire", "tickHz", 1600);
    const tickQ = cfgN("fire", "tickQ", 1.2);
    const tickPeak = cfgN("fire", "tickPeak", 0.04);
    const tickDecay = cfgN("fire", "tickDecay", 0.02);

    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = "sine";
    body.frequency.value = bodyHz;
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + bodyDecay);
    body.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(t);
    body.stop(t + bodyDecay + 0.02);

    const partial = ctx.createOscillator();
    const partialGain = ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = partialHz;
    partialGain.gain.setValueAtTime(0.0001, t);
    partialGain.gain.exponentialRampToValueAtTime(partialPeak, t + 0.003);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t + partialDecay);
    partial.connect(partialGain);
    partialGain.connect(dest);
    partial.start(t);
    partial.stop(t + partialDecay + 0.02);

    const tickBuf = this.noiseBuffer(ctx, Math.max(tickDecay, 0.005));
    if (!tickBuf) return;
    const tick = ctx.createBufferSource();
    tick.buffer = tickBuf;
    const tickFilter = ctx.createBiquadFilter();
    tickFilter.type = "bandpass";
    tickFilter.frequency.value = tickHz;
    tickFilter.Q.value = tickQ;
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(tickPeak, t);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t + tickDecay);
    tick.connect(tickFilter);
    tickFilter.connect(tickGain);
    tickGain.connect(dest);
    tick.start(t);
    tick.stop(t + tickDecay + 0.005);
  }

  // Deeper "thump" pluck for rhythm shots — same musical-pluck shape as
  // playFire but tuned an octave-and-a-half lower (C3 carrier instead of
  // G4) with a sub-octave reinforcement at C2 and a perfect-fifth partial
  // at G3 for body. Wood-thump bandpassed tick around 600 Hz instead of
  // the 1.6 kHz "thumb pad" — gives the attack a heavier wooden character
  // rather than a tight zing. Louder + longer tail than playFire so the
  // player can feel the weight of a timed shot.
  private playFireBeat() {
    // Baked-only — see bakedCacheReadyPromise. The live Tone fallback was
    // removed because some browsers stub Web Audio in ways that crash Tone's
    // destination init; silent-miss is preferable to a frozen game.
    this.playBaked("fireBeat", 1);
  }

  // Bomb-upgrade muzzle voice, off the grid. Same pluck shape as playFire —
  // sine body, octave partial, bandpassed tick — transposed two octaves down
  // to G2/G3 with the tick dropped from a 1.6 kHz zing to a 520 Hz wooden
  // knock. Two octaves keeps it the same pitch class as the G4 normal shot, so
  // a mixed volley harmonizes instead of clashing; the longer decays are what
  // sell the heavier shell.
  private playFireBomb() {
    if (this.playBaked("fireBomb", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildFireBombGraph(this.ctx, this.master, this.voiceTime("fireBomb"));
  }

  private buildFireBombGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    this.buildPluckGraph(ctx, dest, t, {
      bodyHz: cfgN("fireBomb", "bodyHz", 98),
      bodyPeak: cfgN("fireBomb", "bodyPeak", 0.26),
      bodyDecay: cfgN("fireBomb", "bodyDecay", 0.2),
      partialHz: cfgN("fireBomb", "partialHz", 196),
      partialPeak: cfgN("fireBomb", "partialPeak", 0.1),
      partialDecay: cfgN("fireBomb", "partialDecay", 0.1),
      tickHz: cfgN("fireBomb", "tickHz", 520),
      tickQ: cfgN("fireBomb", "tickQ", 1.4),
      tickPeak: cfgN("fireBomb", "tickPeak", 0.06),
      tickDecay: cfgN("fireBomb", "tickDecay", 0.04),
    });
  }

  // Bomb-upgrade muzzle voice, on the grid. Sits an octave under playFireBeat's
  // C3 body (C2 with a G2 fifth on top), so it stacks with the bass bed rather
  // than fighting it, and the body pitch-drops a fourth over its decay to read
  // as a mortar cough rather than a pluck. Louder and longer-tailed than the
  // off-beat bomb shot for the same reason fireBeat outweighs fire.
  private playFireBombBeat() {
    if (this.playBaked("fireBombBeat", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildFireBombBeatGraph(this.ctx, this.master, this.voiceTime("fireBombBeat"));
  }

  private buildFireBombBeatGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const bodyHz = cfgN("fireBombBeat", "bodyHz", 65.41);
    const bodyEndHz = cfgN("fireBombBeat", "bodyEndHz", 49);
    const bodyPeak = cfgN("fireBombBeat", "bodyPeak", 0.5);
    const bodyDecay = cfgN("fireBombBeat", "bodyDecay", 0.42);
    const fifthHz = cfgN("fireBombBeat", "fifthHz", 98);
    const fifthPeak = cfgN("fireBombBeat", "fifthPeak", 0.2);
    const fifthDecay = cfgN("fireBombBeat", "fifthDecay", 0.22);

    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(bodyHz, t);
    body.frequency.exponentialRampToValueAtTime(bodyEndHz, t + bodyDecay);
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + bodyDecay);
    body.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(t);
    body.stop(t + bodyDecay + 0.02);

    this.buildPluckGraph(ctx, dest, t, {
      bodyHz: fifthHz,
      bodyPeak: fifthPeak,
      bodyDecay: fifthDecay,
      partialHz: fifthHz * 2,
      partialPeak: fifthPeak * 0.35,
      partialDecay: fifthDecay * 0.5,
      tickHz: cfgN("fireBombBeat", "tickHz", 320),
      tickQ: cfgN("fireBombBeat", "tickQ", 1.1),
      tickPeak: cfgN("fireBombBeat", "tickPeak", 0.12),
      tickDecay: cfgN("fireBombBeat", "tickDecay", 0.06),
    });
  }

  // The playFire pluck — sine body, octave partial, bandpassed noise tick —
  // as one reusable graph so the bomb voices restate only their tuning.
  private buildPluckGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, p: {
    bodyHz: number; bodyPeak: number; bodyDecay: number;
    partialHz: number; partialPeak: number; partialDecay: number;
    tickHz: number; tickQ: number; tickPeak: number; tickDecay: number;
  }) {
    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = "sine";
    body.frequency.value = p.bodyHz;
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(p.bodyPeak, t + 0.005);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + p.bodyDecay);
    body.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(t);
    body.stop(t + p.bodyDecay + 0.02);

    const partial = ctx.createOscillator();
    const partialGain = ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = p.partialHz;
    partialGain.gain.setValueAtTime(0.0001, t);
    partialGain.gain.exponentialRampToValueAtTime(p.partialPeak, t + 0.004);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t + p.partialDecay);
    partial.connect(partialGain);
    partialGain.connect(dest);
    partial.start(t);
    partial.stop(t + p.partialDecay + 0.02);

    const tickBuf = this.noiseBuffer(ctx, Math.max(p.tickDecay, 0.005));
    if (!tickBuf) return;
    const tick = ctx.createBufferSource();
    tick.buffer = tickBuf;
    const tickFilter = ctx.createBiquadFilter();
    tickFilter.type = "bandpass";
    tickFilter.frequency.value = p.tickHz;
    tickFilter.Q.value = p.tickQ;
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(p.tickPeak, t);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t + p.tickDecay);
    tick.connect(tickFilter);
    tickFilter.connect(tickGain);
    tickGain.connect(dest);
    tick.start(t);
    tick.stop(t + p.tickDecay + 0.005);
  }

  private playExplosion(name: ExplosionName) {
    if (this.playBaked(name, 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildExplosionGraph(this.ctx, this.master, this.voiceTime(name), name);
  }

  private buildExplosionGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, name: ExplosionName) {
    const d = Sound.EXPLOSION_DEFAULTS[name];
    const volume = cfgN(name, "volume", d.volume);
    const lowpassStart = cfgN(name, "lowpassStart", d.lowpassStart);
    const duration = cfgN(name, "duration", d.duration);
    const noiseBuf = this.noiseBuffer(ctx, duration);
    if (!noiseBuf) return;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(lowpassStart * 4, t);
    filter.frequency.exponentialRampToValueAtTime(lowpassStart * 0.4, t + duration);
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    source.start(t);
    source.stop(t + duration);

    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(lowpassStart * 0.6, t);
    sub.frequency.exponentialRampToValueAtTime(40, t + duration * 0.8);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(volume * 0.45, t + 0.02);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + duration);
  }

  // Big odaiko boom for on-beat plain-asteroid kills. Fully hand-built,
  // routed direct-to-master to bypass the Tone bus (chorus + reverb on
  // sub-bass content phase-cancels and saps perceived weight — exactly the
  // "tinny" character we kept hearing). Four layers, all peaking at t=0 so
  // the perceived hit lands exactly when the explosion's noise burst does:
  //
  //   1. Boom body at 90→55 Hz — sine sweep in the *audible* boom band.
  //      This is where humans actually hear "boom"; everything below 60 Hz
  //      is felt, not heard. Loud (peak 1.6) and short attack (1.5 ms) so
  //      the peak lands within one frame of the explosion.
  //   2. Sub anchor at 50→32 Hz — the chest-thump layer. Big speakers feel
  //      it; small speakers can't reproduce it, hence the boom band above.
  //   3. Transient click — a 6 ms filtered noise burst at the very front,
  //      gives the hit an unambiguous attack edge that aligns the perceived
  //      onset with the explosion's noise crack.
  //   4. Wood-shell tail — bandpassed brown noise centred at 180 Hz,
  //      tapering over 600 ms. Adds the resonating-drum-shell texture
  //      without competing with the noise of the explosion crash.
  //
  // All four start at exactly ctx.currentTime — no pre-delay, no pitch
  // ramp that lags the perceived peak. Peak alignment with the explosion's
  // 10 ms attack is the key fix from the previous iteration.
  private boomConvolverIR: AudioBuffer | null = null;
  // Decaying-noise IR for the boom's convolution reverb. Cached for the live
  // context; an offline bake builds its own (a buffer belongs to the context
  // that created it).
  private boomReverbIR(ctx: BaseAudioContext): AudioBuffer | null {
    const live = ctx === this.ctx;
    if (live && this.boomConvolverIR) return this.boomConvolverIR;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 1.3);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        const env = Math.pow(1 - x, 3.0);
        const lowBias = 0.6 + 0.4 * Math.sin(i * 0.0009 + ch);
        data[i] = (Math.random() * 2 - 1) * env * lowBias;
      }
    }
    if (live) this.boomConvolverIR = buf;
    return buf;
  }

  private boomSaturator(ctx: BaseAudioContext, amount: number): WaveShaperNode | null {
    const ws = ctx.createWaveShaper();
    const n = 1024;
    const curve = new Float32Array(n);
    const k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    ws.curve = curve;
    ws.oversample = "4x";
    return ws;
  }

  private playAsteroidBoomBeat() {
    // Per-hit pitch wobble (±3%) so a burst of on-beat kills doesn't read as
    // one sample retriggering. The baked buffer is rendered flat (jitter 1)
    // and gets the same wobble applied as a playbackRate at play time.
    const jitter = 1 + (Math.random() - 0.5) * 0.06;
    if (this.playBaked("asteroidBoomBeat", 1, jitter)) return;
    if (!this.ctx || !this.master) return;
    this.buildAsteroidBoomBeatGraph(this.ctx, this.master, this.voiceTime("asteroidBoomBeat"), jitter);
  }

  private buildAsteroidBoomBeatGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, jitter: number) {
    const tail = 1.0;


    const convolver = ctx.createConvolver();
    const ir = this.boomReverbIR(ctx);
    if (ir) convolver.buffer = ir;
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.32;
    convolver.connect(wetGain);
    wetGain.connect(dest);

    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 130;
    lowShelf.gain.value = 3.5;
    lowShelf.connect(dest);
    lowShelf.connect(convolver);

    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(110 * jitter, t);
    body.frequency.exponentialRampToValueAtTime(65 * jitter, t + 0.18);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(1.3, t + 0.002);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + tail);
    const bodySat = this.boomSaturator(ctx, 2.0);
    body.connect(bodyGain);
    if (bodySat) {
      bodyGain.connect(bodySat);
      bodySat.connect(lowShelf);
    } else {
      bodyGain.connect(lowShelf);
    }
    body.start(t);
    body.stop(t + tail);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(60 * jitter, t);
    sub.frequency.exponentialRampToValueAtTime(38 * jitter, t + 0.35);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(1.4, t + 0.003);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + tail + 0.15);
    sub.connect(subGain);
    subGain.connect(lowShelf);
    sub.start(t);
    sub.stop(t + tail + 0.15);

    const thumpBuf = this.noiseBuffer(ctx, 0.14);
    if (thumpBuf) {
      const thump = ctx.createBufferSource();
      thump.buffer = thumpBuf;
      const thumpFilter = ctx.createBiquadFilter();
      thumpFilter.type = "bandpass";
      thumpFilter.Q.value = 1.0;
      thumpFilter.frequency.setValueAtTime(230, t);
      thumpFilter.frequency.exponentialRampToValueAtTime(150, t + 0.14);
      const thumpGain = ctx.createGain();
      thumpGain.gain.setValueAtTime(0.0001, t);
      thumpGain.gain.exponentialRampToValueAtTime(0.75, t + 0.003);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      thump.connect(thumpFilter);
      thumpFilter.connect(thumpGain);
      thumpGain.connect(lowShelf);
      thump.start(t);
      thump.stop(t + 0.15);
    }

    const clickBuf = this.noiseBuffer(ctx, 0.018);
    if (clickBuf) {
      const click = ctx.createBufferSource();
      click.buffer = clickBuf;
      const clickFilter = ctx.createBiquadFilter();
      clickFilter.type = "bandpass";
      clickFilter.Q.value = 0.9;
      clickFilter.frequency.value = 340;
      const clickGain = ctx.createGain();
      clickGain.gain.setValueAtTime(0.0001, t);
      clickGain.gain.exponentialRampToValueAtTime(0.65, t + 0.001);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
      click.connect(clickFilter);
      clickFilter.connect(clickGain);
      clickGain.connect(dest);
      clickGain.connect(convolver);
      click.start(t);
      click.stop(t + 0.018);
    }

    const shellBuf = this.noiseBuffer(ctx, 0.65);
    if (shellBuf) {
      const shell = ctx.createBufferSource();
      shell.buffer = shellBuf;
      const shellFilter = ctx.createBiquadFilter();
      shellFilter.type = "bandpass";
      shellFilter.Q.value = 1.8;
      shellFilter.frequency.setValueAtTime(260, t);
      shellFilter.frequency.exponentialRampToValueAtTime(120, t + 0.6);
      const shellGain = ctx.createGain();
      shellGain.gain.setValueAtTime(0.0001, t);
      shellGain.gain.exponentialRampToValueAtTime(0.55, t + 0.005);
      shellGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      shell.connect(shellFilter);
      shellFilter.connect(shellGain);
      shellGain.connect(lowShelf);
      shell.start(t);
      shell.stop(t + 0.65);
    }
  }

  // Length (s) of the rendered thrust loop. Every rate in the graph — the
  // 5Hz tremolo LFO and all three oscillators (snapped by snapToLoop) —
  // completes a whole number of cycles per loop, so the buffer tiles with
  // no discontinuity at the seam.
  private static THRUST_LOOP_LEN = 4.0;

  // Headroom scale rendered into the thrust/reverse/side loops' PCM — the
  // three summed oscillators exceed full scale when they align, and
  // encodeWav's 16-bit clamp would hard-clip that into a rasp. Playback
  // divides this back out (the startX functions) so loudness is unchanged.
  private static readonly THRUST_BAKE_TRIM = 0.2;

  // Builds the forward-thrust drone graph into `ctx`, summed into `dest`, all
  // scheduled relative to offline time 0. Nothing here reads live state, so
  // it renders identically every time — see bakeSound's "thrust" case.
  private buildThrustGraph(ctx: BaseAudioContext, dest: AudioNode) {
    const len = Sound.THRUST_LOOP_LEN;
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const tri1 = ctx.createOscillator();
    tri1.type = "triangle";
    tri1.frequency.value = Sound.snapToLoop(110.0, len);
    const tri2 = ctx.createOscillator();
    tri2.type = "triangle";
    tri2.frequency.value = Sound.snapToLoop(110.7, len);
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = Sound.snapToLoop(55.0, len);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1200;
    filter.Q.value = 0.7;

    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 1.0;

    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = Sound.snapToLoop(5, len);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.08;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);

    const trim = ctx.createGain();
    trim.gain.value = Sound.THRUST_BAKE_TRIM;
    tri1.connect(filter);
    tri2.connect(filter);
    sub.connect(filter);
    filter.connect(tremoloGain);
    tremoloGain.connect(trim);
    trim.connect(dest);

    tri1.start(0);
    tri2.start(0);
    sub.start(0);
    lfo.start(0);
    tri1.stop(renderLen);
    tri2.stop(renderLen);
    sub.stop(renderLen);
    lfo.stop(renderLen);
  }

  // Warm the committed thrust loop (single buffer, pitchRatio unused). Goes
  // through queueBake: fetch the committed mp3, and only in dev fall back to
  // a buildThrustGraph offline render that gets dumped to disk.
  private prerenderThrust() {
    this.demandBake("thrust", 1);
  }

  private startThrust() {
    if (!this.ctx || !this.master) return;
    if (this.thrustNode) return;
    const buf = this.bakedBuffers.get(this.bakedKey("thrust", 1));
    if (!buf) {
      // Bake hasn't landed yet (or failed) — kick it for next time and bail.
      this.prerenderThrust();
      return;
    }
    const t = this.ctx.currentTime;

    const { src, startOffset } = this.makeBakedLoopSource(buf, Sound.THRUST_LOOP_LEN);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.16 / Sound.THRUST_BAKE_TRIM, t + 0.08);

    src.connect(mainGain);
    mainGain.connect(this.master);
    src.start(t, startOffset);

    this.thrustNode = { src, mainGain };
  }

  stopThrust() {
    if (!this.ctx || !this.thrustNode) return;
    const t = this.ctx.currentTime;
    const { src, mainGain } = this.thrustNode;
    mainGain.gain.cancelScheduledValues(t);
    mainGain.gain.setValueAtTime(mainGain.gain.value, t);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    src.stop(t + 0.1);
    this.thrustNode = null;
  }

  // Seamless-loop length (s) for the pre-baked charge-bed tiers. Every tonal
  // and LFO frequency baked into the loop is an integer Hz, so each completes a
  // whole number of cycles in exactly this many seconds and the buffer meets
  // itself cleanly at the loop point. Keep frequencies integer if you edit them.
  // 2s gives room for a full 8-step arpeggio phrase per loop. Frequencies are
  // still integer Hz (whole periods in 2s), and the pulse/arp grid divides 2s
  // evenly, so the loop stays seamless.
  private static CHARGE_LOOP_LEN = 2.0;

  // Renders one seamless charge-bed loop for tier `tier` (0..4) into `ctx`.
  // Bakes a musical bed at that tier's intensity: a C-major chord pad pulsed by
  // a rhythmic tremolo (faster, more on-the-beat with charge), a plucked
  // arpeggio walking the C-E-G-C triad (more steps as charge climbs), plus the
  // textural layers — a bandpassed crackle and the rolling-thunder rumble
  // (lowpassed noise churned by a slow LFO, with a sub sine under it). The
  // pulse grid divides the loop evenly and all frequencies are integers, so the
  // loop is seamless. Nothing reads live state, so it renders identically.
  private buildChargeBedGraph(ctx: BaseAudioContext, dest: AudioNode, tier: number) {
    const len = Sound.CHARGE_LOOP_LEN;
    // Scheduled envelopes (chord pulses, arp plucks) must keep repeating
    // with period `len` through the whole padded render so the interior
    // loop window tiles — see LOOP_BAKE_PAD.
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const topBoost = tier >= 4 ? 1.35 : 1;

    // Pulse rhythm: number of even beats across the loop. Quickens with charge
    // (2 → 8 over the loop), so holding feels like a tightening groove. Always
    // an integer count → the tremolo's period tiles the loop exactly.
    const pulses = [2, 3, 4, 6, 8][tier];
    const beat = len / pulses;

    // Chord stack — integer-Hz approximations of C3/G3/C4/E4 so each loops
    // cleanly. Voice i is audible once tier >= i; tier 4 swells all four. Each
    // voice is amplitude-pulsed by a per-beat envelope so the pad has a groove
    // instead of sitting as a flat drone.
    const voices: Array<{ hz: number; type: OscillatorType; peak: number }> = [
      { hz: 131, type: "triangle", peak: 0.12 }, // C3 root (tier 0)
      { hz: 196, type: "sine",     peak: 0.09 }, // G3 fifth (tier 1)
      { hz: 262, type: "triangle", peak: 0.08 }, // C4 octave (tier 2)
      { hz: 330, type: "sine",     peak: 0.06 }, // E4 third (tier 3)
    ];
    for (let i = 0; i < voices.length; i++) {
      if (i > tier) continue;
      const v = voices[i];
      const osc = ctx.createOscillator();
      osc.type = v.type;
      osc.frequency.value = v.hz;
      const gain = ctx.createGain();
      const peak = v.peak * topBoost;
      // Floor keeps the pad present between hits; the swell on each beat gives
      // the groove. Sharper (deeper-dipping) pulse as charge climbs.
      const floor = peak * (0.55 - tier * 0.06);
      for (let b = 0; b * beat < renderLen; b++) {
        const t0 = b * beat;
        gain.gain.setValueAtTime(floor, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + beat * 0.18);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, floor), t0 + beat * 0.92);
      }
      osc.connect(gain);
      gain.connect(dest);
      osc.start(0);
      osc.stop(renderLen);
    }

    // Plucked arpeggio — a bright triangle voice stepping up the C-major triad
    // across the loop. Adds melodic movement over the pad. Step count grows with
    // charge so higher tiers ripple faster. Each note gets a quick pluck
    // envelope; the rising line resets every loop so it tiles seamlessly.
    if (tier >= 1) {
      const arpNotes = [262, 330, 392, 523, 392, 330]; // C4 E4 G4 C5 G4 E4
      const steps = [0, 4, 6, 8, 10, 12][tier]; // notes per loop, climbs w/ charge
      if (steps > 0) {
        const stepDur = len / steps;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        const freqParam = osc.frequency;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, 0);
        const peak = 0.05 + tier * 0.012;
        // (s % steps) first so the note pattern restarts each loop copy —
        // indexing arpNotes by a raw running s would drift once s > steps.
        for (let s = 0; s * stepDur < renderLen; s++) {
          const t0 = s * stepDur;
          freqParam.setValueAtTime(arpNotes[(s % steps) % arpNotes.length], t0);
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.linearRampToValueAtTime(peak, t0 + stepDur * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + stepDur * 0.88);
        }
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 2200;
        osc.connect(lp);
        lp.connect(gain);
        gain.connect(dest);
        osc.start(0);
        osc.stop(renderLen);
      }
    }

    const noiseFor = (dur: number): AudioBuffer => {
      const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    };

    // Crackling electric layer — bandpassed looping noise. Louder/brighter
    // with charge. The noise buffer is exactly one loop long, so the layer
    // repeats with the loop period and the seam splices identical noise.
    {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseFor(len);
      noise.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 4;
      bp.frequency.value = 900 + tier * 800;
      const gain = ctx.createGain();
      gain.gain.value = 0.015 + tier * 0.04;
      noise.connect(bp);
      bp.connect(gain);
      gain.connect(dest);
      noise.start(0);
      noise.stop(renderLen);
    }

    // Rolling-thunder rumble — lowpassed noise whose cutoff is churned by a slow
    // LFO (integer Hz, whole periods per loop) so it surges and recedes like
    // thunder. The roll quickens and deepens, and the band opens, with charge.
    {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseFor(len);
      noise.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 1.2;
      lp.frequency.value = 150 + tier * 130;
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = pulses; // locks the surge to the pulse grid → seamless
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 40 + tier * 35;
      lfo.connect(lfoDepth);
      lfoDepth.connect(lp.frequency);
      const gain = ctx.createGain();
      gain.gain.value = 0.03 + tier * 0.06;
      noise.connect(lp);
      lp.connect(gain);
      gain.connect(dest);
      noise.start(0);
      noise.stop(renderLen);
      lfo.start(0);
      lfo.stop(renderLen);
    }

    // Deep sub sine — the body of the building storm. Silent at tier 0, swells
    // per tier. 44 Hz is integer so it loops cleanly.
    if (tier >= 1) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 44; // ~F1, under the chord stack
      const gain = ctx.createGain();
      gain.gain.value = 0.05 + tier * 0.05;
      osc.connect(gain);
      gain.connect(dest);
      osc.start(0);
      osc.stop(renderLen);
    }
  }

  // Warm the committed charge-bed loops (one mp3 per tier 0..4, keyed by
  // pitchRatio = tier). Each goes through queueBake: fetch the committed mp3,
  // and only in dev fall back to a buildChargeBedGraph offline render that gets
  // dumped to disk. Fire-and-forget; queueBake de-dupes in-flight/cached.
  private prerenderChargeBeds() {
    for (let tier = 0; tier <= 4; tier++) this.demandBake("chargeBed", tier);
  }

  // Hold-to-charge bed. Plays all five baked tier loops at once, each through
  // its own crossfade gain; only the active tier is audible. Holding
  // (setLaserChargeTier) crossfades between tiers as dots land, so the bed
  // intensifies seamlessly without any live synthesis. Idempotent; paired with
  // stopLaserCharge by the caller.
  startLaserCharge() {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (this.laserChargeNode) return;
    // If the bakes haven't landed yet, kick them and bail — the upgrade hold is
    // rare at context start, so silent-missing the very first hold is fine.
    this.prerenderChargeBeds();
    const tierBufs: AudioBuffer[] = [];
    for (let tier = 0; tier <= 4; tier++) {
      const buf = this.bakedBuffers.get(this.bakedKey("chargeBed", tier));
      if (!buf) return;
      tierBufs.push(buf);
    }
    const t = this.ctx.currentTime;

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.5, t + 0.08);
    mainGain.connect(this.master);

    const sources: AudioBufferSourceNode[] = [];
    const tierGains: GainNode[] = [];
    for (let tier = 0; tier <= 4; tier++) {
      // All five tiers share the loop window, so the beds stay phase-locked
      // for the crossfades no matter how long the hold lasts.
      const { src, startOffset } = this.makeBakedLoopSource(tierBufs[tier], Sound.CHARGE_LOOP_LEN);
      const gain = this.ctx.createGain();
      // Only tier 0 audible at the start of a hold; others crossfade in.
      gain.gain.setValueAtTime(tier === 0 ? 1 : 0.0001, t);
      src.connect(gain);
      gain.connect(mainGain);
      src.start(t, startOffset);
      sources.push(src);
      tierGains.push(gain);
    }

    this.laserChargeNode = { sources, tierGains, mainGain };
  }

  // Crossfade the bed to charge tier `dots` (0..4): the active tier's loop fades
  // to full, all others to silence. Short ramps so each new dot intensifies
  // audibly without clicking — the per-tier loudness/voicing differences are
  // already baked into each loop.
  setLaserChargeTier(dots: number) {
    if (!this.ctx || !this.laserChargeNode) return;
    const t = this.voiceTime("laserChargeTier");
    const tier = Math.max(0, Math.min(4, Math.floor(dots)));
    const { tierGains } = this.laserChargeNode;
    for (let i = 0; i < tierGains.length; i++) {
      const target = i === tier ? 1 : 0.0001;
      const g = tierGains[i].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(target, t + 0.12);
    }
  }

  // Lookahead-scheduled variants: dispatch the per-dot accent / tier crossfade at
  //   an absolute audio-clock `when` (from audioTimeForBeatDelta) so the accent
  //   lands sample-accurately on its beat slot instead of a frame late.
  playLaserChargeAt(dotIndex: number, when: number) {
    this.scheduledWhenForCall = when;
    try { this.playLaserCharge(dotIndex); }
    finally { this.scheduledWhenForCall = null; }
  }

  setLaserChargeTierAt(dots: number, when: number) {
    this.scheduledWhenForCall = when;
    try { this.setLaserChargeTier(dots); }
    finally { this.scheduledWhenForCall = null; }
  }

  // Tear down the charge bed. Safe to call repeatedly and when never started.
  stopLaserCharge() {
    if (!this.ctx || !this.laserChargeNode) return;
    const t = this.ctx.currentTime;
    const { sources, mainGain } = this.laserChargeNode;
    mainGain.gain.cancelScheduledValues(t);
    mainGain.gain.setValueAtTime(mainGain.gain.value, t);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    for (const src of sources) src.stop(t + 0.1);
    this.laserChargeNode = null;
  }

  // Length (s) of the rendered reverse-thrust loop. 5.0s = exactly 21 cycles
  // of the 4.2Hz tremolo LFO; the oscillators are snapped to whole cycles
  // per loop too (snapToLoop), so the buffer tiles with no seam discontinuity.
  private static REVERSE_THRUST_LOOP_LEN = 5.0;

  // Deeper sibling of buildThrustGraph — same architecture, lower oscillator
  // frequencies and a darker filter cutoff so the retro-jets read as a
  // heavier, lower-pitched rumble than the forward thrusters. Nothing here
  // reads live state, so it renders identically every time.
  private buildReverseThrustGraph(ctx: BaseAudioContext, dest: AudioNode) {
    const len = Sound.REVERSE_THRUST_LOOP_LEN;
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const tri1 = ctx.createOscillator();
    tri1.type = "triangle";
    tri1.frequency.value = Sound.snapToLoop(72.0, len);
    const tri2 = ctx.createOscillator();
    tri2.type = "triangle";
    tri2.frequency.value = Sound.snapToLoop(72.5, len);
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = Sound.snapToLoop(36.0, len);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 800;
    filter.Q.value = 0.7;

    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 1.0;

    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = Sound.snapToLoop(4.2, len);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.08;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);

    const trim = ctx.createGain();
    trim.gain.value = Sound.THRUST_BAKE_TRIM;
    tri1.connect(filter);
    tri2.connect(filter);
    sub.connect(filter);
    filter.connect(tremoloGain);
    tremoloGain.connect(trim);
    trim.connect(dest);

    tri1.start(0);
    tri2.start(0);
    sub.start(0);
    lfo.start(0);
    tri1.stop(renderLen);
    tri2.stop(renderLen);
    sub.stop(renderLen);
    lfo.stop(renderLen);
  }

  // Warm the committed reverse-thrust loop (single buffer, pitchRatio unused).
  private prerenderReverseThrust() {
    this.demandBake("reverseThrust", 1);
  }

  private startReverseThrust() {
    if (!this.ctx || !this.master) return;
    if (this.reverseThrustNode) return;
    const buf = this.bakedBuffers.get(this.bakedKey("reverseThrust", 1));
    if (!buf) {
      this.prerenderReverseThrust();
      return;
    }
    const t = this.ctx.currentTime;

    const { src, startOffset } = this.makeBakedLoopSource(buf, Sound.REVERSE_THRUST_LOOP_LEN);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.16 / Sound.THRUST_BAKE_TRIM, t + 0.08);

    src.connect(mainGain);
    mainGain.connect(this.master);
    src.start(t, startOffset);

    this.reverseThrustNode = { src, mainGain };
  }

  stopReverseThrust() {
    if (!this.ctx || !this.reverseThrustNode) return;
    const t = this.ctx.currentTime;
    const { src, mainGain } = this.reverseThrustNode;
    mainGain.gain.cancelScheduledValues(t);
    mainGain.gain.setValueAtTime(mainGain.gain.value, t);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    src.stop(t + 0.1);
    this.reverseThrustNode = null;
  }

  // Length (s) of the rendered side-thrust loop. Every rate in the graph —
  // the 6.5Hz tremolo LFO and all three oscillators (snapped by snapToLoop)
  // — completes a whole number of cycles per loop, so the buffer tiles with
  // no seam discontinuity.
  private static SIDE_THRUST_LOOP_LEN = 4.0;

  // Side engines — third engine voice. Architecture mirrors thrust/retro, but
  // pitch sits between the two (90Hz/45Hz here vs 110/55 forward and 72/36 retro)
  // and the filter cutoff opens slightly brighter so the side jet reads as
  // a tighter, more agile burst than either main thruster. Nothing here reads
  // live state, so it renders identically every time.
  private buildSideThrustGraph(ctx: BaseAudioContext, dest: AudioNode) {
    const len = Sound.SIDE_THRUST_LOOP_LEN;
    const renderLen = len + 2 * Sound.LOOP_BAKE_PAD;
    const tri1 = ctx.createOscillator();
    tri1.type = "triangle";
    tri1.frequency.value = Sound.snapToLoop(90.0, len);
    const tri2 = ctx.createOscillator();
    tri2.type = "triangle";
    tri2.frequency.value = Sound.snapToLoop(90.7, len);
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = Sound.snapToLoop(45.0, len);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1500;
    filter.Q.value = 0.7;

    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 1.0;

    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = Sound.snapToLoop(6.5, len);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.1;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremoloGain.gain);

    const trim = ctx.createGain();
    trim.gain.value = Sound.THRUST_BAKE_TRIM;
    tri1.connect(filter);
    tri2.connect(filter);
    sub.connect(filter);
    filter.connect(tremoloGain);
    tremoloGain.connect(trim);
    trim.connect(dest);

    tri1.start(0);
    tri2.start(0);
    sub.start(0);
    lfo.start(0);
    tri1.stop(renderLen);
    tri2.stop(renderLen);
    sub.stop(renderLen);
    lfo.stop(renderLen);
  }

  // Warm the committed side-thrust loop (single buffer, pitchRatio unused).
  private prerenderSideThrust() {
    this.demandBake("sideThrust", 1);
  }

  private startSideThrust() {
    if (!this.ctx || !this.master) return;
    if (this.sideThrustNode) return;
    const buf = this.bakedBuffers.get(this.bakedKey("sideThrust", 1));
    if (!buf) {
      this.prerenderSideThrust();
      return;
    }
    const t = this.ctx.currentTime;

    const { src, startOffset } = this.makeBakedLoopSource(buf, Sound.SIDE_THRUST_LOOP_LEN);

    const mainGain = this.ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, t);
    mainGain.gain.exponentialRampToValueAtTime(0.14 / Sound.THRUST_BAKE_TRIM, t + 0.06);

    src.connect(mainGain);
    mainGain.connect(this.master);
    src.start(t, startOffset);

    this.sideThrustNode = { src, mainGain };
  }

  stopSideThrust() {
    if (!this.ctx || !this.sideThrustNode) return;
    const t = this.ctx.currentTime;
    const { src, mainGain } = this.sideThrustNode;
    mainGain.gain.cancelScheduledValues(t);
    mainGain.gain.setValueAtTime(mainGain.gain.value, t);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.stop(t + 0.09);
    this.sideThrustNode = null;
  }

  // Player-ship death: deep, dramatic, satisfying. Layered as:
  //   (1) sub-bass impact thump — chest-punch sine sweep ~85Hz → 26Hz
  //   (2) broadband noise crack with LP sweep ~3kHz → 110Hz (debris)
  //   (3) detuned saw pair sweeping 330Hz → 30Hz through a resonant LP
  //       (the "dying engine" scream — replaces the old single sawtooth)
  //   (4) sub-octave sine doubling under the saws for weight
  //   (5) bandpass noise rumble tail fading to silence ~1.6s in
  // Total body ~1.5s; fits inside the 1.8s `dyingTimer` in Game.respawn.
  private playDeath() {
    if (this.playBaked("death", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildDeathGraph(this.ctx, this.master, this.voiceTime("death"));
  }

  private buildDeathGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    const subStartHz = cfgN("death", "subStartHz", 85);
    const subEndHz = cfgN("death", "subEndHz", 26);
    const subPeak = cfgN("death", "subPeak", 0.65);
    const subDecay = cfgN("death", "subDecay", 1.2);
    const crackVol = cfgN("death", "crackVol", 0.55);
    const crackDur = cfgN("death", "crackDur", 1.4);
    const screamStartHz = cfgN("death", "screamStartHz", 330);
    const screamEndHz = cfgN("death", "screamEndHz", 30);
    const screamPeak = cfgN("death", "screamPeak", 0.22);
    const screamDur = cfgN("death", "screamDur", 1.1);
    const tailVol = cfgN("death", "tailVol", 0.18);
    const tailDur = cfgN("death", "tailDur", 1.6);

    // (1) Sub-bass impact thump
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(subStartHz, t);
    sub.frequency.exponentialRampToValueAtTime(subEndHz, t + subDecay * 0.75);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subPeak, t + 0.01);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + subDecay);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + subDecay + 0.05);

    // (2) Broadband noise crack with LP sweep
    const crackBuf = this.noiseBuffer(ctx, crackDur);
    if (crackBuf) {
      const crack = ctx.createBufferSource();
      crack.buffer = crackBuf;
      const crackFilter = ctx.createBiquadFilter();
      crackFilter.type = "lowpass";
      crackFilter.Q.value = 1.1;
      crackFilter.frequency.setValueAtTime(3000, t);
      crackFilter.frequency.exponentialRampToValueAtTime(110, t + crackDur);
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0.0001, t);
      crackGain.gain.exponentialRampToValueAtTime(crackVol, t + 0.015);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, t + crackDur);
      crack.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(dest);
      crack.start(t);
      crack.stop(t + crackDur + 0.05);
    }

    // (3) Detuned saw pair — the dying engine scream
    const screamFilter = ctx.createBiquadFilter();
    screamFilter.type = "lowpass";
    screamFilter.Q.value = 4.5;
    screamFilter.frequency.setValueAtTime(1800, t);
    screamFilter.frequency.exponentialRampToValueAtTime(180, t + screamDur);
    const screamGain = ctx.createGain();
    screamGain.gain.setValueAtTime(0.0001, t);
    screamGain.gain.exponentialRampToValueAtTime(screamPeak, t + 0.03);
    screamGain.gain.exponentialRampToValueAtTime(0.0001, t + screamDur);
    screamFilter.connect(screamGain);
    screamGain.connect(dest);
    for (const detune of [-7, 6]) {
      const saw = ctx.createOscillator();
      saw.type = "sawtooth";
      saw.detune.value = detune;
      saw.frequency.setValueAtTime(screamStartHz, t);
      saw.frequency.exponentialRampToValueAtTime(screamEndHz, t + screamDur * 0.85);
      saw.connect(screamFilter);
      saw.start(t);
      saw.stop(t + screamDur + 0.05);
    }

    // (4) Sub-octave sine doubling for weight
    const octave = ctx.createOscillator();
    const octaveGain = ctx.createGain();
    octave.type = "sine";
    octave.frequency.setValueAtTime(screamStartHz * 0.5, t);
    octave.frequency.exponentialRampToValueAtTime(screamEndHz * 0.5, t + screamDur * 0.85);
    octaveGain.gain.setValueAtTime(0.0001, t);
    octaveGain.gain.exponentialRampToValueAtTime(screamPeak * 0.55, t + 0.03);
    octaveGain.gain.exponentialRampToValueAtTime(0.0001, t + screamDur);
    octave.connect(octaveGain);
    octaveGain.connect(dest);
    octave.start(t);
    octave.stop(t + screamDur + 0.05);

    // (5) Bandpass noise rumble tail — wreckage echo
    const tailBuf = this.noiseBuffer(ctx, tailDur);
    if (tailBuf) {
      const tail = ctx.createBufferSource();
      tail.buffer = tailBuf;
      const tailFilter = ctx.createBiquadFilter();
      tailFilter.type = "bandpass";
      tailFilter.Q.value = 1.4;
      tailFilter.frequency.setValueAtTime(400, t);
      tailFilter.frequency.exponentialRampToValueAtTime(70, t + tailDur);
      const tailGain = ctx.createGain();
      tailGain.gain.setValueAtTime(0.0001, t);
      tailGain.gain.exponentialRampToValueAtTime(tailVol, t + 0.1);
      tailGain.gain.exponentialRampToValueAtTime(0.0001, t + tailDur);
      tail.connect(tailFilter);
      tailFilter.connect(tailGain);
      tailGain.connect(dest);
      tail.start(t);
      tail.stop(t + tailDur + 0.05);
    }
  }

  private playWaveClear() {
    this.playBaked("waveClear", 1);
  }

  // Tuned 808 kick on C2: deep pitch-swept body + sub-octave weight + a hard
  // bandpassed-noise click, so it punches instead of reading as a soft thump.
  // `pitchRatio` scales the tonal sweep so split-children of a bassteroid
  // can sound a fourth/octave below the parent (see Game.bassPitchRatio).
  private playBassKick(pitchRatio = 1) {
    this.playBaked("bassKick", pitchRatio);
  }

  // Sub-bass "boom" on F2 (the IV of C major). Sine body with a brief
  // pitch sweep for thump, an F1 sub layer for body, and a short bandpassed
  // noise clack for attack. Heftier than the pluck, darker than the kick,
  // and stays inside the C-F-G chord pocket so layering with kick/pluck
  // reads as a I/IV/V bassline rather than a dissonant pile.
  private playBassBoom(pitchRatio = 1) {
    this.playBaked("bassBoom", pitchRatio);
  }

  // Percussive "snap" — a snare-leaning hybrid that gives beat 4 a sharp
  // accent without piling another sub onto the bottom. Bandpassed noise
  // body + a short tonal triangle at C3 that pitches down for a snare-like
  // body. Sits an octave above the kick/pluck/boom region so the four-voice
  // pattern reads as kick-pluck-boom-snap rather than a wall of low end.
  private playBassSnap(pitchRatio = 1) {
    this.playBaked("bassSnap", pitchRatio);
  }

  // Rubber-band twang at G2: a high-Q lowpass snaps open then clamps shut
  // for a vocal "bwong" — distinct timbre from the kick so the two layer
  // rather than mask each other.
  private playBassPluck(pitchRatio = 1) {
    this.playBaked("bassPluck", pitchRatio);
  }

  // Crunch played when a bassteroid is shot. Deep, gravelly, sub-200 Hz —
  // a sawtooth sweep crashing into the bass register paired with a heavily
  // low-passed noise transient that sounds like cracking stone, not a tink.
  private playBassHit() {
    if (this.playBaked("bassHit", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildBassHitGraph(this.ctx, this.master, this.voiceTime("bassHit"));
  }

  private buildBassHitGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    // Body: detuned sawtooth pair sweeping from low-mid into the sub-bass
    // floor. Two oscs a tiny semitone-fraction apart fatten the sound and
    // give the slight beating that reads as "gravelly".
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.type = "sawtooth";
    oscB.type = "sawtooth";
    oscA.frequency.setValueAtTime(180, t);
    oscA.frequency.exponentialRampToValueAtTime(48, t + 0.22);
    oscB.frequency.setValueAtTime(186, t);
    oscB.frequency.exponentialRampToValueAtTime(50, t + 0.22);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.28);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.42, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    oscA.start(t);
    oscB.start(t);
    oscA.stop(t + 0.42);
    oscB.stop(t + 0.42);

    // Crunch transient: noise pushed through a tight LOW band so it reads
    // as crumbling rock rather than a metallic tink. Centre frequency drops
    // through the hit so the texture goes from "crack" to "rumble".
    const noiseBuf = this.noiseBuffer(ctx, 0.22);
    if (!noiseBuf) return;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const nFilter = ctx.createBiquadFilter();
    nFilter.type = "lowpass";
    nFilter.Q.value = 1.4;
    nFilter.frequency.setValueAtTime(700, t);
    nFilter.frequency.exponentialRampToValueAtTime(140, t + 0.2);
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.0001, t);
    nGain.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    noise.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(dest);
    noise.start(t);
    noise.stop(t + 0.24);
  }

  // Deep echoing tail that plays on every bassteroid hit, regardless of
  // size. Implemented as four discrete sine thuds at decaying volume and an
  // increasingly dark lowpass — that gives a clearly perceived "echo from a
  // cave" character without dragging a Web Audio delay-feedback loop along
  // (which would leak nodes if the page is held open for a long session).
  // Stays sub-100 Hz so it sits below the kick/pluck without masking them.
  private playBassEcho() {
    if (this.playBaked("bassEcho", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildBassEchoGraph(this.ctx, this.master, this.voiceTime("bassEcho"));
  }

  private buildBassEchoGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const echoCount = 4;
    const echoSpacing = 0.22;
    const echoIndices = Array.from({ length: echoCount }, (_, i) => i);
    for (const i of echoIndices) {
      const start = t + i * echoSpacing;
      const decay = Math.pow(0.55, i);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(82.4, start); // E2
      osc.frequency.exponentialRampToValueAtTime(45, start + 0.22);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 600 * Math.pow(0.7, i);
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      const peak = 0.34 * decay;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      osc.start(start);
      osc.stop(start + 0.32);
    }
  }

  // High shimmery bell — three sine partials at near-bell ratios. Baked at
  // C6+G6 (pitchRatio 1.0); callers can pass a ratio to playbackRate-shift
  // the buffer (e.g. 0.5 = C5+G5) without forcing a new bake.
  private playChime(pitchRatio = 1) {
    if (pitchRatio === 1) {
      this.playBaked("chime", 1);
      return;
    }
    if (!this.ctx || !this.bakedOut) return;
    const buf = this.bakedBuffers.get(this.bakedKey("chime", 1));
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitchRatio;
    const pos = this.spatialPosForCall;
    if (pos) {
      const spatial = this.makeSpatial(pos, this.bakedOut);
      if (spatial) src.connect(spatial.panner);
      else src.connect(this.bakedOut);
    } else {
      src.connect(this.bakedOut);
    }
    src.start(this.voiceTime("chime"));
  }

  // Resonant hum-chime over the wave-summary drain. pitch selects a
  // harmonic over A3; each harmonic is baked as its own true-pitch variant
  // so every chime keeps its full tail (no playbackRate chipmunking).
  private playDrainChime(harmonic = 1) {
    this.playBaked("drainChime", Math.max(1, Math.round(harmonic)));
  }

  // Lower bell with inharmonic partials — feels like a temple bell rather
  // than a wind-chime.
  private playBell(pitchRatio = 1) {
    if (this.playBaked("bell", pitchRatio)) return;
    if (!this.ctx || !this.master) return;
    this.buildBellGraph(this.ctx, this.master, this.voiceTime("bell"), pitchRatio);
  }

  private buildBellGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, pitchRatio: number) {
    const fundamentalFreq = cfgN("bell", "fundamentalHz", 220) * pitchRatio;
    // when pitched (i.e. wave-summary use at C4), scale peak down so the
    //   tolling bell sits under the drain melody instead of overpowering it.
    const peakScale = pitchRatio === 1 ? 1 : 0.55;
    const peakBase = cfgN("bell", "peak", 0.22) * peakScale;
    const decayBase = cfgN("bell", "decay", 1.4);
    const partialRatios = [
      1,
      cfgN("bell", "partial1Ratio", 2.76),
      cfgN("bell", "partial2Ratio", 5.4),
      cfgN("bell", "partial3Ratio", 8.93),
    ];
    for (let i = 0; i < partialRatios.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = fundamentalFreq * partialRatios[i];
      const peak = peakBase / (i + 1.2);
      const decay = Math.max(0.15, decayBase - i * 0.22);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
  }

  // Tiny percussive tick that confirms an on-beat shot. High-passed noise
  // burst, very short and quiet so it sits underneath the existing fire sound
  // rather than masking it.
  private playComboTick() {
    if (this.playBaked("comboTick", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildComboTickGraph(this.ctx, this.master, this.voiceTime("comboTick"));
  }

  private buildComboTickGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const noiseBuf = this.noiseBuffer(ctx, 0.04);
    if (!noiseBuf) return;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 4200;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    noise.start(t);
    noise.stop(t + 0.05);
  }

  // Warm "you got the beat" cue — a soft mid-range fifth that sits under the
  // explosion thud instead of slicing through it. Dropped an octave from the
  // original sparkle so repeated on-beat kills don't fatigue the ear; the
  // sharper original lives on as the dedicated "tink" asteroid sound.
  private playComboSparkle(durationScale: number = 1) {
    if (this.playBaked("comboSparkle", durationScale)) return;
    if (!this.ctx || !this.master) return;
    this.buildComboSparkleGraph(this.ctx, this.master, this.voiceTime("comboSparkle"), durationScale);
  }

  private buildComboSparkleGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, durationScale: number) {
    const partialFrequencies = [880, 1318.5]; // A5, E6 (perfect fifth)
    const decay = 0.22 * durationScale;
    const stop = 0.24 * durationScale;
    for (let i = 0; i < partialFrequencies.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], t);
      const peak = 0.07 / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + stop);
    }
  }

  playComboSparkleShort() { this.playComboSparkle(0.5); }

  // Drift-shot hit fanfare — fires when an on-beat shot lands while the first-dot hover ring
  // is locked (i.e. the same condition that queues the +1 Drift Shot and the 4x damage). A
  // bright, celebratory layer that sits *on top of* the normal comboSparkle + chime so the
  // player hears the regular on-beat reward AND a distinct extra "ding" for the drift-shot.
  //   Five layers:
  //   1) Fast rising arpeggio (C5–E5–G5–C6) on a soft triangle — reads as "achievement unlocked".
  //   2) A small bell strike at C6 with two inharmonic partials — adds shimmer and pitch focus.
  //   3) A high noise sparkle burst — the "magic dust" topping.
  //   4) A deep sub-boom (tier-scaled) — the explosive low-end weight.
  //   5) A harmonic bloom (tier-scaled) — a chord swell that RESOLVES the drift-hum stack.
  // No spatial panning: like comboChime, this is a melodic reward and should sit centered.
  // tier 1..6 = drift tier landed (callers always pass ≥1; default 1). The bright
  // zing/bell/sparkle is the same at every tier, but each tier adds another voice
  // of the held C-major chord (layer 5) and more sub-boom weight (layer 4) and
  // lifts the overall gain — so a higher tier doesn't just sparkle brighter, it
  // lands as a fuller, more harmonically-resolved detonation.
  playDriftShotHit(tier = 1) {
    if (!this.enabled) return;
    this.ensureContext();
    const clamped = Math.max(1, Math.min(6, Math.round(tier)));
    if (this.playBaked("driftShotHit", clamped)) return;
    if (!this.ctx || !this.master) return;
    this.buildDriftShotHitGraph(this.ctx, this.master, this.voiceTime("driftShotHit"), clamped);
  }

  private buildDriftShotHitGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, tier: number) {
    // 0..1 climb across the tier ladder — drives the sub-boom depth/gain so the
    // weight arrives gradually and peaks at the final tier rather than popping on.
    const tierClimb = Math.max(0, Math.min(1, (tier - 1) / 5));
    // overall lift: the whole hit gets louder as the tier climbs (1.0 → ~1.5×).
    const tierGain = 1 + 0.5 * tierClimb;
    // 1) Rising arpeggio — C major triad climbing into an octave. Steps land
    //    fast (every 25ms) so the whole flourish fits inside ~150ms — a "zing" rather than a tune.
    const arpFreqs = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    const stepSec = 0.025;
    for (let i = 0; i < arpFreqs.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = arpFreqs[i];
      const start = t + i * stepSec;
      const peak = 0.10 * tierGain;
      const release = 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + release);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(start);
      osc.stop(start + release + 0.02);
    }
    // 2) Bell-tone landing on the top note — two inharmonic partials so it has shimmer.
    const bellFundamental = 1046.50; // C6
    const bellPartials = [1, 2.76]; // shared ratio family with playBell
    const bellStart = t + (arpFreqs.length - 1) * stepSec;
    for (let i = 0; i < bellPartials.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = bellFundamental * bellPartials[i];
      const peak = 0.09 * tierGain / (i + 1.2);
      const decay = 0.5 - i * 0.12;
      gain.gain.setValueAtTime(0.0001, bellStart);
      gain.gain.exponentialRampToValueAtTime(peak, bellStart + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, bellStart + decay);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(bellStart);
      osc.stop(bellStart + decay + 0.05);
    }
    // 3) High-passed noise sparkle — fairy-dust top end that lifts the whole hit.
    const noiseBuf = this.noiseBuffer(ctx, 0.18);
    if (noiseBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const filter = ctx.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 6000;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12 * tierGain, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      noise.start(t);
      noise.stop(t + 0.20);
    }
    // 4) Deep sub-boom — a pitch-collapsing C2→C1 sine thump that grounds the
    //    sparkle with real low-end weight. Silent at tier 1 and swells in with
    //    the tier climb so the FINAL tier lands like a detonation under the zing.
    //    A short body sine an octave up (C2) gives it a punchy attack the pure
    //    sub can't carry on small speakers.
    if (tierClimb > 0) {
      const boomGain = ctx.createGain();
      // shaped swell: barely there at low tiers, dominant at the top (^1.6 curve).
      const boomPeak = 0.55 * Math.pow(tierClimb, 1.6) * tierGain;
      // slight pre-delay so the boom lands just after the bright transient — the
      // ear hears "crack THEN weight", which reads as bigger than a simultaneous hit.
      const boomStart = t + 0.012;
      const boomDecay = 0.34 + 0.30 * tierClimb; // longer tail at the top tier
      boomGain.gain.setValueAtTime(0.0001, boomStart);
      boomGain.gain.exponentialRampToValueAtTime(boomPeak, boomStart + 0.012);
      boomGain.gain.exponentialRampToValueAtTime(0.0001, boomStart + boomDecay);
      // gentle lowpass keeps it round (no fizzy harmonics) and protects tweeters.
      const boomLp = ctx.createBiquadFilter();
      boomLp.type = "lowpass";
      boomLp.frequency.value = 220;
      boomLp.Q.value = 0.7;
      boomLp.connect(boomGain);
      boomGain.connect(dest);
      // sub: C2 (65.4 Hz) collapsing toward C1 (32.7 Hz) for that "drop" feel.
      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(65.41, boomStart);
      sub.frequency.exponentialRampToValueAtTime(32.70, boomStart + boomDecay * 0.7);
      sub.connect(boomLp);
      sub.start(boomStart);
      sub.stop(boomStart + boomDecay + 0.05);
      // body: C2 octave-up sine for attack punch, quieter and shorter than the sub.
      const body = ctx.createGain();
      body.gain.setValueAtTime(0.0001, boomStart);
      body.gain.exponentialRampToValueAtTime(boomPeak * 0.45, boomStart + 0.008);
      body.gain.exponentialRampToValueAtTime(0.0001, boomStart + boomDecay * 0.5);
      body.connect(dest);
      const bodyOsc = ctx.createOscillator();
      bodyOsc.type = "sine";
      bodyOsc.frequency.setValueAtTime(130.81, boomStart);
      bodyOsc.frequency.exponentialRampToValueAtTime(65.41, boomStart + boomDecay * 0.5);
      bodyOsc.connect(body);
      bodyOsc.start(boomStart);
      bodyOsc.stop(boomStart + boomDecay * 0.5 + 0.05);
    }
    // 5) Harmonic bloom — a chord swell that RESOLVES the drift-hum stack the
    //    player has been holding. Each tier unlocks one more voice of the same
    //    C-major spread the hover hums build (see the drift-tier hum ladder in
    //    Sound: C4/G4/E4/C5 base → +C3 → +G5 → +D5 (add9) → +E5 → +C2), so the
    //    hit doesn't just get louder — it crowns the exact chord that was
    //    sustaining, blooming fuller the longer you held. Soft sine voices
    //    through a shared gentle lowpass so it reads as warm and beautiful
    //    layered under the bright zing, never as a second percussive stab.
    const BLOOM_VOICES = [
      261.63, // C4  — the hover-hum root; present at every tier
      392.00, // G4  — perfect fifth (tier ≥ 2)
      523.25, // C5  — octave (tier ≥ 3)
      587.33, // D5  — major 9th → Cadd9 (tier ≥ 4)
      659.25, // E5  — major 3rd up high (tier ≥ 5)
      130.81, // C3  — sub-octave root anchoring the spread (tier ≥ 6)
    ];
    const bloomCount = Math.max(1, Math.min(BLOOM_VOICES.length, tier));
    const bloomBus = ctx.createGain();
    // Whole bloom swells with the tier so a tier-1 hit is a faint single note
    // and the top tier is a full, radiant chord.
    bloomBus.gain.value = 0.5 + 0.5 * tierClimb;
    const bloomLp = ctx.createBiquadFilter();
    bloomLp.type = "lowpass";
    bloomLp.frequency.value = 3200;
    bloomLp.Q.value = 0.5;
    bloomLp.connect(bloomBus);
    bloomBus.connect(dest);
    // Land the bloom on the same beat as the bell so it reads as one resolved
    // event; a touch of attack so it swells in rather than clicking.
    const bloomStart = bellStart;
    const bloomAttack = 0.03;
    const bloomSustain = 0.5;
    const bloomRelease = 1.1;
    for (let i = 0; i < bloomCount; i++) {
      // higher voices a little quieter so the chord stays grounded, not shrill.
      const peak = (0.07 / (1 + i * 0.35)) * tierGain;
      // two sines detuned ±5 cents = soft analog chorus, matching the hum voices.
      for (const detune of [-3, 3]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = BLOOM_VOICES[i];
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, bloomStart);
        g.gain.exponentialRampToValueAtTime(peak * 0.5, bloomStart + bloomAttack);
        g.gain.exponentialRampToValueAtTime(peak * 0.22, bloomStart + bloomAttack + bloomSustain);
        g.gain.exponentialRampToValueAtTime(0.0001, bloomStart + bloomAttack + bloomSustain + bloomRelease);
        osc.connect(g);
        g.connect(bloomLp);
        osc.start(bloomStart);
        osc.stop(bloomStart + bloomAttack + bloomSustain + bloomRelease + 0.05);
      }
    }
  }

  // Length (s) of the rendered thunderclap buffer for a given charge tier.
  // Must comfortably contain the longest layer (the last rolling echo at the
  // top tier) plus its decay so nothing gets clipped off the tail.
  private laserShotBufferLen(tier: number): number {
    const chg = tier / 4;
    // Longest tail: the final echo. Mirror the echo schedule below — the last
    // roll starts latest and is the longest.
    const echoes = 2 + Math.round(tier * 1.5);
    const lastDelay = (echoes - 1) * (0.13 + chg * 0.05);
    const lastLen = (0.7 + chg * 1.1) * (1 + (echoes - 1) * 0.12);
    const chordLen = 0.9 + chg * 1.7;
    // Horn swell blooms late and rings out past the chord — mirror its schedule.
    const hornTail = (0.06 + chg * 0.05) + chordLen * (0.9 + chg * 0.4);
    return Math.max(lastDelay + lastLen, chordLen, hornTail) + 0.2;
  }

  // Builds the THUNDERCLAP synth graph for one charge tier into `ctx`, summed
  // into `dest`, all scheduled relative to offline time 0. Shared by the
  // pre-render pass (rendered into an OfflineAudioContext per tier and cached);
  // nothing here reads live state, so it renders identically every time.
  //
  // The shot is both MELODIC and THUNDEROUS: a saturated, pitch-collapsing
  // C-major chord (the "voice of god" tone, in key with the C-rooted bass
  // field) booms out over a deep sub detonation, a bright crack on the leading
  // edge, and a stack of staggered lowpassed rolls that read as thunder rolling
  // off into the distance. Charge is the whole point — every layer deepens,
  // lengthens, and the chord gains voices (the major third + upper octave) so a
  // 0-dot tap is a sharp tonal clap and a 4-dot release is a sustained,
  // triumphant roll of thunder. Peak gain is left near full here; per-shot
  // trim/jitter happen at play time so a single buffer covers all damage values.
  private buildLaserShotGraph(ctx: BaseAudioContext, dest: AudioNode, tier: number) {
    const chg = tier / 4; // 0..1 charge ramp — the master expressiveness knob
    const noiseFor = (dur: number): AudioBuffer => {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return buf;
    };

    // Soft saturation curve — adds harmonics + glue so the chord/sub read as
    // POWERFUL rather than clean. Mild tanh-ish shaper; charge pushes harder.
    const drive = 2.2 + chg * 2.5;
    const shaper = ctx.createWaveShaper();
    {
      const n = 1024;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
      }
      shaper.curve = curve;
      shaper.oversample = "2x";
    }
    // Everything tonal (chord + sub) routes through the saturator, then a gentle
    // lowpass to tame fizz the shaper adds up top, then into dest.
    const satOut = ctx.createBiquadFilter();
    satOut.type = "lowpass";
    satOut.frequency.value = 3200 + chg * 1800;
    satOut.Q.value = 0.5;
    shaper.connect(satOut);
    satOut.connect(dest);

    // --- Melodic chord: a low C-major voicing that swoops downward (the thunder
    // pitch-bend) as it booms. Lower voices always present; the major third and
    // bright upper octave fade in with charge so a full charge is a fuller, more
    // resolved chord. All slightly detuned for width/power.
    const chordLen = 0.9 + chg * 1.7;
    // C1, C2, G2, C3, E3, G3, C4 — a deep C-major "voice of god" voicing now
    // rooted an octave lower (C1 fundamental) so the boom has a true sub floor,
    // brightening up top. In key with the C-rooted bass field, so the shot lands
    // as a musical chord-hit rather than just noise.
    const voices: Array<{ hz: number; type: OscillatorType; peak: number; bend: number }> = [
      { hz: 32.70,  type: "sine",     peak: 0.30 + chg * 0.14,     bend: 0.88 }, // C1 (sub fundamental)
      { hz: 65.41,  type: "sawtooth", peak: 0.28,                  bend: 0.84 }, // C2
      { hz: 98.00,  type: "sawtooth", peak: 0.20,                  bend: 0.86 }, // G2
      { hz: 130.81, type: "triangle", peak: 0.22,                  bend: 0.88 }, // C3
      { hz: 164.81, type: "triangle", peak: 0.11 + chg * 0.12,     bend: 0.90 }, // E3 (major 3rd — grows w/ charge)
      { hz: 196.00, type: "triangle", peak: 0.07 + chg * 0.08,     bend: 0.90 }, // G3
      { hz: 261.63, type: "sine",     peak: chg * 0.12,            bend: 0.92 }, // C4 (top sparkle — charge only)
    ];
    for (const vc of voices) {
      if (vc.peak <= 0.0001) continue;
      // Two detuned oscillators per voice for a thick, "stacked" power-chord feel.
      for (const det of [-6, 6]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = vc.type;
        // Start a touch sharp and sag down — the swoop. Deeper bend at higher charge.
        const endHz = vc.hz * (vc.bend - chg * 0.06);
        osc.frequency.setValueAtTime(vc.hz * 1.06, 0);
        osc.frequency.exponentialRampToValueAtTime(endHz, chordLen * 0.8);
        osc.detune.value = det;
        gain.gain.setValueAtTime(0.0001, 0);
        gain.gain.exponentialRampToValueAtTime(vc.peak * 0.5, 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, chordLen);
        osc.connect(gain);
        gain.connect(shaper);
        osc.start(0);
        osc.stop(chordLen + 0.05);
      }
    }

    // --- Sub detonation: a sine whose pitch collapses into infrasonic territory
    // — the gut-punch under the clap. Deeper, louder, and longer with charge.
    // Routes through the saturator too so it stays glued to the chord. The end
    // pitch lands near C1 (32.7Hz) so even the sub resolves in key.
    const subStart = 130 - chg * 40;
    const subEnd = 32.7 - chg * 4;
    const subLen = 0.55 + chg * 0.9;
    {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(subStart, 0);
      osc.frequency.exponentialRampToValueAtTime(subEnd, subLen * 0.7);
      gain.gain.setValueAtTime(0.0001, 0);
      gain.gain.exponentialRampToValueAtTime(0.72 + chg * 0.34, 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, subLen);
      osc.connect(gain);
      gain.connect(shaper);
      osc.start(0);
      osc.stop(subLen + 0.05);
    }

    // --- Triumphant horn swell: a G2→C3 sine-pair that BLOOMS a beat late and
    // resolves the dominant up to the tonic — the "voice of god" answering the
    // clap. Quiet at a tap, swelling to a clear cinematic resolve at full charge,
    // so a maxed shot ends on a satisfying musical note rather than just decay.
    {
      const swellLen = chordLen * (0.9 + chg * 0.4);
      const swellDelay = 0.06 + chg * 0.05;
      const swellPeak = 0.05 + chg * 0.16;
      for (const det of [-4, 5]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        // G2 → C3: dominant resolving up to the tonic.
        osc.frequency.setValueAtTime(98.0, swellDelay);
        osc.frequency.exponentialRampToValueAtTime(130.81, swellDelay + swellLen * 0.55);
        osc.detune.value = det;
        gain.gain.setValueAtTime(0.0001, swellDelay);
        // Slow swell-in (not a transient) so it reads as a sustained horn, not a pluck.
        gain.gain.exponentialRampToValueAtTime(swellPeak, swellDelay + swellLen * 0.4);
        gain.gain.exponentialRampToValueAtTime(0.0001, swellDelay + swellLen);
        osc.connect(gain);
        gain.connect(shaper);
        osc.start(swellDelay);
        osc.stop(swellDelay + swellLen + 0.05);
      }
    }

    // --- Thunder crack: the bright transient that gives the clap its "snap".
    // Bandpassed noise slammed in at t=0; the band drops with charge so a full
    // charge cracks lower and heavier while a tap cracks tight and high.
    {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseFor(0.14);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(2600 - chg * 900, 0);
      bp.frequency.exponentialRampToValueAtTime(800 - chg * 300, 0.1);
      bp.Q.value = 0.6;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 450;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.6 + chg * 0.25, 0);
      gain.gain.exponentialRampToValueAtTime(0.0001, 0.1 + chg * 0.06);
      noise.connect(bp);
      bp.connect(hp);
      hp.connect(gain);
      gain.connect(dest);
      noise.start(0);
      noise.stop(0.18);
    }

    // --- Air/ozone hiss: a thin highpassed crackle on the very front, selling
    // the "ionised air" sizzle of a discharge.
    {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseFor(0.08);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 5000 + chg * 1500;
      hp.Q.value = 0.5;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.16 + chg * 0.06, 0);
      gain.gain.exponentialRampToValueAtTime(0.0001, 0.06);
      noise.connect(hp);
      hp.connect(gain);
      gain.connect(dest);
      noise.start(0);
      noise.stop(0.1);
    }

    // --- Rolling thunder: a STACK of staggered lowpassed noise rolls, each
    // later, lower, and longer than the last, so the energy tumbles away into
    // the low end like real thunder rolling across the sky. Two rolls at a tap,
    // up to six at full charge — this is what makes a big shot genuinely
    // thunderous rather than a single hit.
    const echoes = 2 + Math.round(tier * 1.5);
    for (let e = 0; e < echoes; e++) {
      const delay = e * (0.13 + chg * 0.05);
      const rollLen = (0.7 + chg * 1.1) * (1 + e * 0.12);
      const noise = ctx.createBufferSource();
      noise.buffer = noiseFor(rollLen + 0.1);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      // Each successive roll opens lower — energy sinking into the sub.
      const cutStart = (560 + chg * 240) * Math.pow(0.78, e);
      lp.frequency.setValueAtTime(cutStart, delay);
      lp.frequency.exponentialRampToValueAtTime(55, delay + rollLen);
      lp.Q.value = 1.0;
      const gain = ctx.createGain();
      // First roll is the loudest body; later rolls taper as they recede.
      const peak = (0.34 + chg * 0.22) * Math.pow(0.72, e);
      gain.gain.setValueAtTime(0.0001, delay);
      gain.gain.exponentialRampToValueAtTime(peak, delay + 0.05 + e * 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, delay + rollLen);
      noise.connect(lp);
      lp.connect(gain);
      gain.connect(dest);
      noise.start(delay);
      noise.stop(delay + rollLen + 0.08);
    }
  }

  // Warm the committed laser-shot thunderclap one-shots (one mp3 per tier
  // 0..4, keyed by pitchRatio = tier). Each goes through queueBake: fetch the
  // committed mp3, and only in dev fall back to a buildLaserShotGraph offline
  // render that gets dumped to disk. Fire-and-forget; queueBake de-dupes
  // in-flight/cached.
  private prerenderLaserShots() {
    for (let tier = 0; tier <= 4; tier++) this.demandBake("laserShot", tier);
  }

  // Laser-shot weapon (the "lasershot" upgrade). A pre-baked THUNDERCLAP —
  // see buildLaserShotGraph for the synth and prerenderLaserShots for the
  // bake. This path just plays the cached per-tier buffer with a per-shot
  // playbackRate wobble (so a burst never sounds machine-stamped) and a small
  // `damage` gain trim so the top tiers can't clip. `dots` (0..4) selects the
  // tier; bigger charge = deeper, longer, more thunderous.
  playLaserShot(damage: number = 2, dots: number = 0) {
    if (!this.enabled) return;
    this.ensureContext();
    const sink = this.bakedSink("laserShot");
    if (!this.ctx || !sink) return;
    const tier = Math.max(0, Math.min(4, Math.floor(dots)));
    const buf = this.bakedBuffers.get(this.bakedKey("laserShot", tier));
    if (!buf) {
      // Bake hasn't landed yet (or failed) — kick it for next time and bail.
      this.prerenderLaserShots();
      return;
    }
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // ±~0.35 semitone wobble per shot, derived from play time (no shared
    // Math.random determinism concerns on the live path).
    const wob = ((t * 53.7) % 1) * 2 - 1;
    src.playbackRate.value = Math.pow(2, (wob * 0.35) / 12);
    const gain = ctx.createGain();
    // The render sums many hot layers (saturated chord + sub + crack + rolls),
    // so trim the playback so it sits in the mix without slamming the bus.
    // `damage` rides a small bump on top so a 32-damage shot lands a touch hotter.
    gain.gain.value = Math.min(0.72, 0.6 + damage * 0.004);
    src.connect(gain);
    gain.connect(sink);
    src.start(t);
  }

  // Per-dot charge tick — fires when a new charge dot appears in front of the
  // ship during a hold. Walks up a C major chord that RESOLVES UP AN OCTAVE on
  // the 4th dot (C3 → E3 → G3 → C4) so a full charge lands on the tonic and
  // feels "topped off". Each dot has a sub layer + body + filtered noise sparkle
  // for weight, plus a rising capacitor whine (below) that climbs with the dot
  // so the build feels tense and audibly "winding up".
  playLaserCharge(dotIndex: number) {
    if (!this.enabled) return;
    this.ensureContext();
    const clamped = Math.max(1, Math.min(4, Math.round(dotIndex)));
    if (this.playBaked("laserCharge", clamped)) return;
    if (!this.ctx || !this.master) return;
    this.buildLaserChargeGraph(this.ctx, this.master, this.voiceTime("laserCharge"), clamped);
  }

  private buildLaserChargeGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, dotIndex: number) {
    // voiceTime honors a scheduled start (playLaserChargeAt) so the accent lands
    //   on its beat slot; falls back to now for the immediate path.
    // C-major resolving climb: root, third, fifth, octave. The 4th dot lands on
    // C4 (the octave) so a maxed charge resolves rather than dangling on the 5th.
    const triad = [130.81, 164.81, 196.00, 261.63]; // C3, E3, G3, C4
    const idx = Math.max(0, Math.min(triad.length - 1, dotIndex - 1));
    const hz = triad[idx];
    const tail = 0.32 + idx * 0.04;
    // Each successive dot gets louder + brighter so the build is felt.
    const tierBoost = 0.9 + idx * 0.22;

    // Rising capacitor whine — a quick upward sine sweep on each dot that starts
    // higher every tier, so the stack of ticks reads as a winding-up generator.
    // Short, bright, sits above the chord; sells "energy gathering" between dots.
    {
      const whine = ctx.createOscillator();
      const whineGain = ctx.createGain();
      whine.type = "sine";
      const wStart = hz * 2;
      const wEnd = hz * (3 + idx * 0.5);
      whine.frequency.setValueAtTime(wStart, t);
      whine.frequency.exponentialRampToValueAtTime(wEnd, t + tail * 0.8);
      whineGain.gain.setValueAtTime(0.0001, t);
      whineGain.gain.exponentialRampToValueAtTime(0.04 * tierBoost, t + 0.02);
      whineGain.gain.exponentialRampToValueAtTime(0.0001, t + tail * 0.9);
      whine.connect(whineGain);
      whineGain.connect(dest);
      whine.start(t);
      whine.stop(t + tail + 0.04);
    }

    // Sub layer — sine at the root octave below for the felt depth.
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(hz * 0.5, t);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.16 * tierBoost, t + 0.005);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + tail);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + tail + 0.04);

    // Body — triangle on the dot's chord note with a small upward chirp so the
    // tick feels like energy being deposited rather than a static pluck.
    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(hz * 0.92, t);
    body.frequency.exponentialRampToValueAtTime(hz, t + 0.05);
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.14 * tierBoost, t + 0.005);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + tail);
    body.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(t);
    body.stop(t + tail + 0.04);

    // Octave-up partial — sine on the octave above gives definition.
    const partial = ctx.createOscillator();
    const partialGain = ctx.createGain();
    partial.type = "sine";
    partial.frequency.value = hz * 2;
    partialGain.gain.setValueAtTime(0.0001, t);
    partialGain.gain.exponentialRampToValueAtTime(0.07 * tierBoost, t + 0.004);
    partialGain.gain.exponentialRampToValueAtTime(0.0001, t + tail * 0.65);
    partial.connect(partialGain);
    partialGain.connect(dest);
    partial.start(t);
    partial.stop(t + tail * 0.65 + 0.04);

    // Fifth above for chord-fill at higher tiers — dot 2/3 get a richer harmonic
    // stack so the build sounds tonally fuller, not just louder.
    if (idx >= 1) {
      const fifth = ctx.createOscillator();
      const fifthGain = ctx.createGain();
      fifth.type = "sine";
      fifth.frequency.value = hz * 1.5;
      fifthGain.gain.setValueAtTime(0.0001, t);
      fifthGain.gain.exponentialRampToValueAtTime(0.05 * tierBoost, t + 0.004);
      fifthGain.gain.exponentialRampToValueAtTime(0.0001, t + tail * 0.7);
      fifth.connect(fifthGain);
      fifthGain.connect(dest);
      fifth.start(t);
      fifth.stop(t + tail * 0.7 + 0.04);
    }

    // Crystalline sparkle — bandpassed noise pip on the front of the tick. Tiny
    // but it makes the dot land with a satisfying "click" instead of a soft hum.
    const sparkleBuf = this.noiseBuffer(ctx, 0.04);
    if (sparkleBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = sparkleBuf;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 2400 + idx * 600;
      filter.Q.value = 4;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.08 * tierBoost, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      noise.start(t);
      noise.stop(t + 0.06);
    }
  }

  // Sad "wrrp" — played when the player tries to start charging the laser
  // off-beat. Short descending detuned triangle pair through a closing lowpass
  // — distinct from playComboLost (which is longer and reads as "you lost
  // something") so it sits as "nope, try again on the beat".
  playLaserChargeFail() {
    if (!this.enabled) return;
    this.ensureContext();
    if (this.playBaked("laserChargeFail", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildLaserChargeFailGraph(this.ctx, this.master, this.voiceTime("laserChargeFail"));
  }

  private buildLaserChargeFailGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const tail = 0.18;
    // Two detuned triangle voices descending a fifth — A3 → D3-ish. The detune
    // gives the buzz that reads as "wrong" vs. a clean tone.
    const voices: Array<{ start: number; end: number; detune: number; level: number }> = [
      { start: 220.0, end: 130.81, detune: 0,  level: 0.18 },
      { start: 220.0, end: 130.81, detune: 18, level: 0.13 },
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(v.start, t);
      osc.frequency.exponentialRampToValueAtTime(v.end, t + tail);
      osc.detune.value = v.detune;
      // Lowpass closes alongside the slide for the muffled "deflated" quality.
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1600, t);
      filter.frequency.exponentialRampToValueAtTime(420, t + tail);
      filter.Q.value = 1;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(v.level, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + tail + 0.04);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + tail + 0.08);
    }
  }

  // Escalating melody chime — one rounded synth note per successive on-beat
  // kill. All variants open with the same three universal anchor notes on a
  // C pedal (C2 → G2 → D3 — root, fifth, ninth), then branch into a scale
  // that matches the currently-playing halo music's modal colour:
  //   musicbox-sb / cinematic-el → C minor / dorian-leaning (haunting Eb, Bb)
  //   synthwave-el                 → C major pentatonic (open, hopeful)
  //   no music (default)    → C dorian without 3rd (mode-neutral)
  // Voice: soft sine pad — slow attack, long round decay, gentle detune for
  // analog-synth warmth. No spatial panning: a melody should sit centered in
  // the mix instead of jumping with each kill.
  // Universal opening: root, fifth, ninth on the C pedal. Deep enough that
  // the climb has 13 more steps to ascend before getting strained.
  private static readonly COMBO_CHIME_ANCHORS: readonly number[] = [
    65.41,   // C2
    98.00,   // G2
    146.83,  // D3
  ];
  // Scale tail (notes 3..15) per variation. Each is 13 ascending pitches
  // chosen so the final note of the cycle lands somewhere bright but not
  // piercing (<= ~880 Hz / A5) — well under the music's upper-layer centroid
  // so the chime doesn't fight the music's high band.
  private static readonly COMBO_CHIME_TAIL_MINOR_DORIAN: readonly number[] = [
    // Eb, F, G, Bb, C, Eb, F, G, Bb, C, Eb, F, G — C minor pentatonic + F.
    // Haunting: the Eb tracks the minor-third pad voicing.
    155.56, 174.61, 196.00, 233.08, 261.63,
    311.13, 349.23, 392.00, 466.16, 523.25,
    622.25, 698.46, 783.99,
  ];
  private static readonly COMBO_CHIME_TAIL_MAJOR: readonly number[] = [
    // E, G, A, C, D, E, G, A, C, D, E, G, A — C major pentatonic.
    // Hopeful: pure C-major triadic colour.
    164.81, 196.00, 220.00, 261.63, 293.66,
    329.63, 392.00, 440.00, 523.25, 587.33,
    659.25, 783.99, 880.00,
  ];
  private static readonly COMBO_CHIME_TAIL_NO_3RD: readonly number[] = [
    // F, G, A, C, D, F, G, A, C, D, F, G, A — C dorian/mixolydian crossover
    // with the major/minor 3rd avoided entirely. Mode-safe default when no
    // halo music is playing.
    174.61, 196.00, 220.00, 261.63, 293.66,
    349.23, 392.00, 440.00, 523.25, 587.33,
    698.46, 783.99, 880.00,
  ];
  // Every fundamental any (variation, combo) pair can land on. The three
  // tails overlap heavily — 42 (variation, step) combinations collapse to
  // this many distinct notes, which is what the bake enumerates. Keyed by
  // the pitch itself (not a step index) so re-ordering or extending a tail
  // reuses the notes it already has instead of invalidating every file.
  static readonly COMBO_CHIME_PITCHES: readonly number[] = Array.from(new Set([
    ...Sound.COMBO_CHIME_ANCHORS,
    ...Sound.COMBO_CHIME_TAIL_MINOR_DORIAN,
    ...Sound.COMBO_CHIME_TAIL_MAJOR,
    ...Sound.COMBO_CHIME_TAIL_NO_3RD,
  ])).sort((a, b) => a - b);

  // Which fundamental this combo value rings, given the halo music's modal
  // colour. Pure function of (variation, comboValue) — the bake key.
  private comboChimeFundamental(comboValue: number): number {
    const v = this.haloMusic?.variation;
    const tail = v === "synthwave-el"
      ? Sound.COMBO_CHIME_TAIL_MAJOR
      : (v === "musicbox-sb" || v === "cinematic-el")
        ? Sound.COMBO_CHIME_TAIL_MINOR_DORIAN
        : Sound.COMBO_CHIME_TAIL_NO_3RD;
    const scale = [...Sound.COMBO_CHIME_ANCHORS, ...tail];
    return scale[(comboValue - 2) % scale.length];
  }

  playComboChime(comboValue: number, _pos?: Pos, durationScale: number = 1) {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.ctx || !this.master) return;
    if (comboValue < 2) return;
    const fundamental = this.comboChimeFundamental(comboValue);
    // Only the full-length note is baked — the killed-parade replay shortens
    // it (durationScale 0.5), and a stretched buffer would shorten the attack
    // and detune the note, so that variant stays live.
    if (durationScale === 1 && this.playBaked("comboChime", fundamental)) return;
    this.buildComboChimeGraph(this.ctx, this.master, this.voiceTime("comboChime"), fundamental, durationScale);
  }

  private buildComboChimeGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, fundamental: number, durationScale: number) {
    // Three detuned sines per note — fundamental + ±7-cent detune pair gives
    // a soft analog-synth chorus without any extra hardware. Lowpass tracks
    // fundamental so high notes don't shrill; low notes keep body.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.6;
    // Cap the cutoff so deep notes still pass; never below 1.2 kHz so the
    // very lowest C2 has some upper-partial air, never above 3.2 kHz so the
    // top A5 stays soft.
    filter.frequency.value = Math.min(3200, Math.max(1200, fundamental * 3.0));

    // Volume scaled to ~2/3 of the previous bell version (fundamental 0.34
    // → 0.22 — split across three detuned voices so combined peak ~0.22).
    const peak = 0.22;
    const attack = 0.08;
    const sustain = 2.0 * durationScale;
    const release = 3.0 * durationScale;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + attack);
    env.gain.exponentialRampToValueAtTime(peak * 0.45, t + attack + sustain);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + sustain + release);
    env.connect(filter);
    filter.connect(dest);

    const detuneCents = [0, -7, +7];
    const voices: OscillatorNode[] = [];
    for (const cents of detuneCents) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = fundamental;
      osc.detune.value = cents;
      const vGain = ctx.createGain();
      vGain.gain.value = cents === 0 ? 0.5 : 0.32;
      osc.connect(vGain);
      vGain.connect(env);
      osc.start(t);
      voices.push(osc);
    }
    // Subtle octave-up shimmer at low fundamentals so the deepest notes still
    // read as a defined pitch instead of a rumble. Fades fast so it doesn't
    // colour the higher notes.
    if (fundamental < 200) {
      const shimmer = ctx.createOscillator();
      shimmer.type = "sine";
      shimmer.frequency.value = fundamental * 2;
      const sGain = ctx.createGain();
      sGain.gain.value = 0.18;
      shimmer.connect(sGain);
      sGain.connect(env);
      shimmer.start(t);
      voices.push(shimmer);
    }
    const stopAt = t + attack + sustain + release + 0.04;
    for (const v of voices) v.stop(stopAt);
  }

  // Bright glassy "tink" — high stacked sine fifth with a fast attack. Used
  // by the rare crystal asteroid kind. Designed to be ear-catching exactly
  // because it's uncommon; if it ever plays often, soften it back down.
  private playTink() {
    if (this.playBaked("tink", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildTinkGraph(this.ctx, this.master, this.voiceTime("tink"));
  }

  private buildTinkGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const peakBase = cfgN("tink", "peak", 0.18);
    const decay = cfgN("tink", "decay", 0.4);
    const partialFrequencies = [
      cfgN("tink", "partial1Hz", 1760),
      cfgN("tink", "partial2Hz", 2637),
    ];
    for (let i = 0; i < partialFrequencies.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], t);
      const peak = peakBase / (i + 1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + decay + 0.02);
    }
  }

  // Solid-crystal asteroid shatter. Tuning-fork-on-glass voice: a pure
  // harmonic sine stack rings out with a soft mallet onset, no fracture
  // crack, no inharmonic beating. Three layers:
  //   1. Mallet onset — a brief soft "tup" from a lowpassed noise pop, the
  //      sensation of the fork's tine touching the glass rim. Quiet enough
  //      to disappear into the ring rather than reading as a transient.
  //   2. Fork ring — a pure harmonic series (1x, 2x, 3x, 4x) on sine waves
  //      with a slow swell and very long exponential decay, like a struck
  //      tuning fork held against a wine glass. Integer ratios fuse into a
  //      single pitch instead of beating.
  //   3. Sub-octave body — a quieter low sine that gives the ring weight on
  //      large asteroids without muddying small chunks.
  // size === "large" gets a lower fundamental and a longer tail so a big
  // asteroid resonates longer than a fragment.
  private playCrystalShatter(size: "large" | "small", ringPitchRatio = 1) {
    const name = size === "large" ? "crystalShatterLarge" : "crystalShatterSmall";
    if (this.playBaked(name, ringPitchRatio)) return;
    if (!this.ctx || !this.master) return;
    this.buildCrystalShatterGraph(this.ctx, this.master, this.voiceTime(name), size, ringPitchRatio);
  }

  private buildCrystalShatterGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, size: "large" | "small", ringPitchRatio: number) {
    // ringPitchRatio === 0 sentinel: on-beat kill — snap the fundamental to
    // the fireBeat pluck note dropped an octave (G3 = 196 Hz for large, G4
    // for small) so the fork rings in key with the rhythm shot but sits in
    // a warmer register than the pluck itself.
    const G3 = 196;
    const baseHz = size === "large" ? 330 : 495;
    const snapToG = ringPitchRatio === 0;
    const fundamental = snapToG
      ? (size === "large" ? G3 : G3 * 2)
      : baseHz * ringPitchRatio;
    const isLarge = size === "large";
    const ringDur = isLarge ? 3.6 : 2.4;
    const ringPeak = isLarge ? 0.16 : 0.12;
    // Soft mallet onset — the fork meeting the glass. Lowpassed noise pop,
    // very brief, sits well below the partials so it's felt more than heard.
    const tapDur = 0.05;
    const tapBuf = this.noiseBuffer(ctx, tapDur);
    if (tapBuf) {
      const src = ctx.createBufferSource();
      src.buffer = tapBuf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = isLarge ? 900 : 1400;
      const g = ctx.createGain();
      const tapPeak = isLarge ? 0.08 : 0.06;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(tapPeak, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + tapDur);
      src.connect(lp);
      lp.connect(g);
      g.connect(dest);
      src.start(t);
      src.stop(t + tapDur);
    }
    // Tuning-fork harmonic series. Integer ratios (1, 2, 3, 4) lock into one
    // pure pitch instead of beating like glass shards. Higher partials decay
    // faster — that's how a real fork sustains, the fundamental rings on
    // after the upper harmonics fade. Slow 40 ms swell on the fundamental
    // avoids any percussive sting.
    const partials: Array<{ ratio: number; gain: number; decayMul: number; attack: number }> = [
      { ratio: 1.0, gain: 1.00, decayMul: 1.00, attack: 0.040 }, // fundamental
      { ratio: 2.0, gain: 0.42, decayMul: 0.70, attack: 0.020 }, // octave
      { ratio: 3.0, gain: 0.18, decayMul: 0.45, attack: 0.012 }, // octave + fifth
      { ratio: 4.0, gain: 0.08, decayMul: 0.30, attack: 0.008 }, // two octaves
    ];
    for (const { ratio, gain: gMul, decayMul, attack } of partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(fundamental * ratio, t);
      const peak = ringPeak * gMul;
      const tail = ringDur * decayMul;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + tail);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + tail + 0.02);
    }
    // Sub-octave body — adds weight to large rings without muddying small
    // frags. Slower attack so it blooms underneath the fundamental.
    const subPeak = ringPeak * (isLarge ? 0.55 : 0.30);
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = "sine";
    subOsc.frequency.setValueAtTime(fundamental * 0.5, t);
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(subPeak, t + 0.08);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + ringDur);
    subOsc.connect(subGain);
    subGain.connect(dest);
    subOsc.start(t);
    subOsc.stop(t + ringDur + 0.02);
  }

  // Haunting bell voice for the wave-summary drain. Fires four-per-beat.
  // Root drops an octave from the old marimba (E5 → E4) so the line sits in
  // a deeper, more melancholic register. Sub-octave partial gives body, two
  // slightly detuned fundamentals produce a slow beat-frequency wobble that
  // reads as "uneasy", and a soft triangle high partial replaces the bright
  // inharmonic sparkle so the tone is round rather than glassy. Longer tail
  // (~0.32s) lets adjacent notes overlap into a continuous haunted line.
  private playScoreBlip(pitchRatio = 1) {
    if (this.playBaked("scoreBlip", pitchRatio)) return;
    if (!this.ctx || !this.master) return;
    this.buildScoreBlipGraph(this.ctx, this.master, this.voiceTime("scoreBlip"), pitchRatio);
  }

  private buildScoreBlipGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, pitchRatio: number) {
    // Dropped an octave (E4 → E3) so the drain line sits in a baritone /
    //   cello register instead of music-box height. Upper-harmonic peaks
    //   pulled down so the bright triangle partial doesn't reintroduce the
    //   chipperness we just removed by lowering the root.
    const root = 165 * pitchRatio;
    const layers: Array<{ freq: number; peak: number; decay: number; type: OscillatorType }> = [
      { freq: root * 0.5,    peak: 0.060, decay: 0.45, type: "sine" },
      { freq: root,          peak: 0.080, decay: 0.36, type: "sine" },
      { freq: root * 1.003,  peak: 0.070, decay: 0.36, type: "sine" }, // detune wobble
      { freq: root * 2,      peak: 0.012, decay: 0.16, type: "sine" },
      { freq: root * 3,      peak: 0.003, decay: 0.08, type: "triangle" },
    ];
    for (const { freq, peak, decay, type } of layers) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + decay + 0.02);
    }
  }

  // Downbeat anchor for the wave-summary drain — fires once per beat (every
  // 4th tick). Kick body grounds the time, a sustained minor-key chord
  // voicing layered on top carries the harmony. The chord rotates through
  // i — VI — III — VII (A minor → F → C → G) across the four downbeats of
  // each phrase so every 4-beat segment lands on different harmonic ground.
  // The drain melody's downbeat notes are chord tones of these voicings, so
  // the two voices interlock instead of fighting.
  private playSummaryDownbeat(chordIndex = 0, duckPad = false) {
    const name = duckPad ? "summaryDownbeatDucked" : "summaryDownbeat";
    const chord = ((chordIndex % 4) + 4) % 4;
    if (this.playBaked(name, chord)) return;
    if (!this.ctx || !this.master) return;
    this.buildSummaryDownbeatGraph(this.ctx, this.master, this.voiceTime(name), chord, duckPad);
  }

  private buildSummaryDownbeatGraph(ctx: BaseAudioContext, dest: AudioNode, t: number, chordIndex: number, duckPad: boolean) {
    // Body: sine at A1 (~55 Hz) with a tiny initial pitch snap for "thump".
    //   Dropped a major third lower than before so it sits under the deeper
    //   scoreBlip without crowding the melody register.
    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(110, t);
    body.frequency.exponentialRampToValueAtTime(55, t + 0.014);
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.40, t + 0.003);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    body.connect(bodyGain);
    bodyGain.connect(dest);
    body.start(t);
    body.stop(t + 0.24);
    // Click: short bandpassed noise so the transient locks the beat in time.
    //   Centered lower (900 Hz vs the old 1800) so it reads as a soft mallet
    //   rather than a crisp tick — fits the haunting palette.
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, 512, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 1.4;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.05, t + 0.001);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    noise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(dest);
    noise.start(t);
    noise.stop(t + 0.04);

    // Sustained chord voicing — root + minor/major triad + open fifth in the
    //   bell register, each chord's frequencies expressed as Hz triads.
    //   i: A minor (A3 E4 C5), VI: F major (F3 C4 A4), III: C major (C4 G4 E5),
    //   VII: G major (G3 D4 B4). The voicings stay within ~half an octave of
    //   each other so the rotation reads as motion, not jumps.
    const voicings: Array<[number, number, number]> = [
      [220.0, 329.6, 523.3], // i  — A minor
      [174.6, 261.6, 440.0], // VI — F major
      [261.6, 392.0, 659.3], // III — C major
      [196.0, 293.7, 493.9], // VII — G major
    ];
    const chord = voicings[chordIndex % voicings.length];
    // On deep-bell downbeats the pad steps back so the bell tail owns the
    //   low end; the kick and click above stay at full strength.
    const padScale = duckPad ? 0.55 : 1;
    // Chord notes use a slow attack (60ms) and long sustain (~1.4s) so each
    //   downbeat blooms under the four marimba-blip ticks that follow it,
    //   then fades just in time for the next downbeat's chord to take over.
    for (let i = 0; i < chord.length; i++) {
      const freq = chord[i];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const peak = (0.085 / (1 + i * 0.35)) * padScale; // root loudest, top quietest
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 1.45);
    }
  }

  // Ascending sine arpeggio with a sparkle overlay — the "you got something
  // good" jingle that plays when the ship flies over a canister.
  private playPowerup() {
    this.playBaked("powerup", 1);
  }

  // Earning a free life — the comet-hit's long resonating tail transposed into
  // grace: a soft strike + rising sub into a swelling C-major choir that rings
  // and echoes out over 15 seconds (see buildBonusLifeGraph). Pre-baked.
  private playBonusLife() {
    this.playBaked("bonusLife", 1);
  }

  // Canister-appear: gentle ascending wind-chime sparkle. Three soft sine
  // partials of a Cmaj9 voicing arrive in rising sequence, slower and quieter
  // than playPowerup so the player reads "something nice just appeared" rather
  // than "pickup confirmed". Bandpass-filtered white-noise wash underneath
  // gives the air-suspended pod a breath of presence.
  private playCanisterAppear() {
    if (this.playBaked("canisterAppear", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildCanisterAppearGraph(this.ctx, this.master, this.voiceTime("canisterAppear"));
  }

  private buildCanisterAppearGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    // Cmaj9 partials: C6, E6, G6, D7 — open, airy, unambiguously friendly.
    const partialFrequencies = [1046.5, 1318.5, 1568.0, 2349.3];
    for (let i = 0; i < partialFrequencies.length; i++) {
      const start = t + i * 0.085;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(partialFrequencies[i], start);
      const peak = 0.085 / (1 + i * 0.25);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(start);
      osc.stop(start + 0.95);
    }
    // Soft airy halo — bandpassed noise behind the partials.
    const noiseBuf = this.noiseBuffer(ctx, 0.6);
    if (noiseBuf) {
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(2400, t);
      filter.frequency.exponentialRampToValueAtTime(5000, t + 0.5);
      filter.Q.value = 1.4;
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.exponentialRampToValueAtTime(0.04, t + 0.08);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(dest);
      noise.start(t);
      noise.stop(t + 0.6);
    }
  }

  // Canister-destroyed: a soft sighing minor descent. Two sine voices fall a
  // minor third (E5 → C5 / G5 → Eb5) over ~0.7s with a slow vibrato; sits
  // *underneath* the explosionSmall the Game also plays, reading as the
  // pod's "regret" rather than another blast. Heavily attenuated so it
  // colors the explosion instead of competing with it.
  private playCanisterDestroyed() {
    if (this.playBaked("canisterDestroyed", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildCanisterDestroyedGraph(this.ctx, this.master, this.voiceTime("canisterDestroyed"));
  }

  private buildCanisterDestroyedGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    // Voice pairs: [startHz, endHz]. The fall from a major triad partial
    // into a minor one is what gives this its "aw, no" quality.
    const voices: Array<[number, number]> = [
      [659.25, 523.25], // E5 → C5
      [783.99, 622.25], // G5 → Eb5
      [329.63, 261.63], // E4 → C4 (sub-octave, fuller body)
    ];
    for (let i = 0; i < voices.length; i++) {
      const [fStart, fEnd] = voices[i];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(fStart, t + 0.04);
      osc.frequency.exponentialRampToValueAtTime(fEnd, t + 0.7);
      // Slow vibrato — gives the descent a vocal, almost weeping quality.
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 5.5;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = fStart * 0.012;
      lfo.connect(lfoDepth);
      lfoDepth.connect(osc.frequency);
      const peak = 0.11 / (1 + i * 0.4);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + 1.15);
      lfo.stop(t + 1.15);
    }
  }

  // The four wraith voices are pre-recorded, ElevenLabs-generated one-shots
  // (subtly-haunting airy/choral textures) committed to public/sounds/baked/
  // and played back through the baked path. They replaced the old hand-built
  // choir synth; each mp3 was pitch-inspected and snapped toward a consonant
  // C-root tone (see scripts/sfx-gen/). No bakeSound recipe — the mp3 IS the
  // source of truth, so a missing file silent-misses rather than resynthesizing.
  //   scream — release cry as the prison shatters (Eb5 cold choir)
  //   hit    — the unique per-bullet flinch (unpitched breathy recoil)
  //   lunge  — airy inhaled whoosh sweeping toward the ship
  //   death  — the soul let go, resolving on the C root
  private playWraithScream() { this.playBaked("wraithScream", 1); }
  private playWraithHit() { this.playBaked("wraithHit", 1); }
  private playWraithLunge() { this.playBaked("wraithLunge", 1); }
  private playWraithDeath() { this.playBaked("wraithDeath", 1); }

  // Deep, slow chest-thump played on each boss flash beat. A sine sub at
  // ~45Hz with a short body of detuned-saw growl, lowpassed hard. Reads as
  // a heartbeat through the floor — the boss thinking. Short (~0.45s) so a
  // burst of pulses on a busy slot doesn't smear into one continuous hum.
  private playBossPulse() {
    if (this.playBaked("bossPulse", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildBossPulseGraph(this.ctx, this.master, this.voiceTime("bossPulse"));
  }

  private buildBossPulseGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    // Sub sine — the lowest layer, pitches down slightly across the tail.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(58, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.42);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.85, t + 0.012);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + 0.58);
    // Body — detuned-saw growl through a closing lowpass. Provides the
    // gritty edge so the pulse reads as "machine breathing" instead of just
    // a kick drum.
    for (const detune of [-8, 8]) {
      const body = ctx.createOscillator();
      body.type = "sawtooth";
      body.frequency.setValueAtTime(82, t);
      body.frequency.exponentialRampToValueAtTime(46, t + 0.45);
      body.detune.value = detune;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(420, t);
      lp.frequency.exponentialRampToValueAtTime(110, t + 0.42);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      body.connect(lp);
      lp.connect(g);
      g.connect(dest);
      body.start(t);
      body.stop(t + 0.52);
    }
    // Hot front transient — a tiny noise burst at the front shaped by a
    // bandpass. Adds the percussive "clap" so the start of the pulse is
    // crisp instead of muddy.
    const noiseBuf = this.noiseBuffer(ctx, 0.18);
    if (noiseBuf) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(1800, t);
      bp.frequency.exponentialRampToValueAtTime(220, t + 0.12);
      bp.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      n.connect(bp);
      bp.connect(g);
      g.connect(dest);
      n.start(t);
      n.stop(t + 0.16);
    }
  }

  // Boss impact — a heavy, satisfying hit when a big on-beat/charged shot
  // slams into the armored planetoid. Three layers sell the weight: a deep
  // sub thud for the body of the impact, a metallic inharmonic clang (two
  // detuned partials a tritone-ish apart ringing out) for the armor plating,
  // and a short bright noise crack for the point of contact. Tuned to land as
  // a meaty "CHONK" distinct from the boss's own bossPulse voice.
  private playBossHit() {
    if (this.playBaked("bossHit", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildBossHitGraph(this.ctx, this.master, this.voiceTime("bossHit"));
  }

  private buildBossHitGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    // Sub thud — fast attack, quick pitch-drop, the mass of the impact.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(150, t);
    sub.frequency.exponentialRampToValueAtTime(46, t + 0.16);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.exponentialRampToValueAtTime(0.95, t + 0.006);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    sub.connect(subGain);
    subGain.connect(dest);
    sub.start(t);
    sub.stop(t + 0.36);

    // Metallic clang — two inharmonic partials ringing through a bandpass so
    // the armor plate reads as struck metal, not a tuned note. Longer decay
    // than the sub so the hit has a tail.
    for (const partial of [196, 271]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(partial * 2.3, t);
      o.frequency.exponentialRampToValueAtTime(partial, t + 0.06);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = partial * 1.6;
      bp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(bp);
      bp.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + 0.42);
    }

    // Contact crack — a short bright noise transient for the point of impact.
    const noiseBuf = this.noiseBuffer(ctx, 0.12);
    if (noiseBuf) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      n.connect(hp);
      hp.connect(g);
      g.connect(dest);
      n.start(t);
      n.stop(t + 0.1);
    }
  }

  // Boss-eye-open dramatic stinger. Plays the instant the dormant→live
  // phase transition fires. Three detuned saws stacked on a tritone (Eb4 +
  // A4 — the devil's interval against the music's C-minor pedal) sliding
  // down through a closing lowpass into a noise crash. Reads as "everything
  // just went wrong" — explicitly dissonant against the brooding-but-tonal
  // vigil-sb boss pedal so the player feels the harmony break. About 1.2s
  // total: 0.3s of held tritone bite + 0.7s pitch-down dive + 0.2s noise
  // tail. Tuned loud (peak ~0.65) so it cuts through whatever halo music
  // happens to be playing.
  private playBossEyeOpenStinger() {
    if (this.playBaked("bossEyeOpenStinger", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildBossEyeOpenStingerGraph(this.ctx, this.master, this.voiceTime("bossEyeOpenStinger"));
  }

  private buildBossEyeOpenStingerGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {

    // Tritone bite — three detuned saws on each note for a thick cluster.
    // Eb4 = 311.13 Hz, A4 = 440.0 Hz (the augmented fourth = devil's interval).
    // Each pitch is voiced as 3 detuned saws so the cluster reads as a
    // brass-section snarl rather than a single oscillator beep.
    const noteHz = [311.13, 440.0];
    for (const baseHz of noteHz) {
      for (const detune of [-12, 0, 12]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(baseHz, t);
        // Pitch-down dive over 0.7s — slides each note down a major sixth.
        o.frequency.exponentialRampToValueAtTime(baseHz * 0.6, t + 0.7);
        o.detune.value = detune;
        // Closing lowpass — bright at the front (the bite), darker as it
        // dives so the dissonance becomes a low menacing growl.
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 6;
        lp.frequency.setValueAtTime(2400, t);
        lp.frequency.exponentialRampToValueAtTime(380, t + 0.85);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
        g.gain.linearRampToValueAtTime(0.18, t + 0.30);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        o.connect(lp);
        lp.connect(g);
        g.connect(dest);
        o.start(t);
        o.stop(t + 1.15);
      }
    }

    // Sub-bass C1 thump under the cluster — pushes the dissonance down into
    // the chest. Pure sine so it doesn't fight the saw growl above it.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(32.7, t);
    sub.frequency.exponentialRampToValueAtTime(22, t + 0.9);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, t);
    subG.gain.exponentialRampToValueAtTime(0.85, t + 0.012);
    subG.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    sub.connect(subG);
    subG.connect(dest);
    sub.start(t);
    sub.stop(t + 1.05);

    // Noise crash tail at the start — sells the impact of the eye opening.
    const noiseBuf = this.noiseBuffer(ctx, 0.5);
    if (noiseBuf) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(3000, t);
      bp.frequency.exponentialRampToValueAtTime(280, t + 0.45);
      bp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      n.connect(bp);
      bp.connect(g);
      g.connect(dest);
      n.start(t);
      n.stop(t + 0.5);
    }
  }

  // Combo-lost "wrrr" — a short downward pitch-bend on two detuned triangles
  // through a closing lowpass. Reads as a deflating/slowing motor, the
  // tonal opposite of the cyan→gold combo halo lighting up. Kept short
  // (~0.4s) so it doesn't step on the shot or hit that triggered the loss.
  private playComboLost() {
    if (this.playBaked("comboLost", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildComboLostGraph(this.ctx, this.master, this.voiceTime("comboLost"));
  }

  private buildComboLostGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    // Two slightly detuned triangle voices — the small detune is what
    // gives the tail its buzzy "wrrr" character instead of a clean sigh.
    const voices: Array<{ start: number; end: number; detune: number; level: number }> = [
      { start: 392.0, end: 130.8, detune: 0, level: 0.16 },   // G4 → C3
      { start: 392.0, end: 130.8, detune: 12, level: 0.12 },  // detuned twin
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(v.start, t);
      osc.frequency.exponentialRampToValueAtTime(v.end, t + 0.34);
      osc.detune.value = v.detune;
      // Lowpass closes alongside the pitch drop — kills the brightness so
      // the tail genuinely fades into the floor instead of buzzing on.
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 1.2;
      filter.frequency.setValueAtTime(1800, t);
      filter.frequency.exponentialRampToValueAtTime(380, t + 0.34);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(v.level, t + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.45);
    }
  }

  // Off-beat *fire* loss — same wrrr family as playComboLost (the hit-loss),
  // but tuned to read as a mistimed *press* rather than a deflating motor:
  // higher, faster, with a sharper sawtooth attack and a wider sour detune so
  // the dissonance bites up front. Shorter tail keeps it from stepping on the
  // shot. The two losses share a family so the player groups them as "rhythm
  // broke", yet are distinguishable so they learn which half they got wrong.
  private playComboLostFire() {
    if (this.playBaked("comboLostFire", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildComboLostFireGraph(this.ctx, this.master, this.voiceTime("comboLostFire"));
  }

  private buildComboLostFireGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const voices: Array<{ start: number; end: number; detune: number; level: number }> = [
      { start: 523.3, end: 196.0, detune: 0, level: 0.14 },   // C5 → G3
      { start: 523.3, end: 196.0, detune: -22, level: 0.11 }, // sour twin, wider detune
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(v.start, t);
      osc.frequency.exponentialRampToValueAtTime(v.end, t + 0.22);
      osc.detune.value = v.detune;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 1.4;
      filter.frequency.setValueAtTime(2600, t);
      filter.frequency.exponentialRampToValueAtTime(520, t + 0.22);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(v.level, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.33);
    }
  }

  // Soft glassy "ting" with a quick noise wash — the shield absorbing a hit.
  private playShieldPop() {
    if (this.playBaked("shieldPop", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildShieldPopGraph(this.ctx, this.master, this.voiceTime("shieldPop"));
  }

  private buildShieldPopGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.3);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    osc.stop(t + 0.38);

    const noiseBuf = this.noiseBuffer(ctx, 0.18);
    if (!noiseBuf) return;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 3000;
    filter.Q.value = 2;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.16, t);
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(dest);
    noise.start(t);
    noise.stop(t + 0.2);
  }

  // Sine carrier with a fast vibrato — a vocal "ooo" warble.
  private playWarble() {
    if (this.playBaked("warble", 1)) return;
    if (!this.ctx || !this.master) return;
    this.buildWarbleGraph(this.ctx, this.master, this.voiceTime("warble"));
  }

  private buildWarbleGraph(ctx: BaseAudioContext, dest: AudioNode, t: number) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 587.33; // D5
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 8;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 25;
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.62);
    lfo.stop(t + 0.62);
  }
}
