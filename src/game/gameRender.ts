import type { Game } from "../Game";
import type { Vec } from "../vec";
import { BEAT_GRID } from "./rhythmConstants";
import { currentBeatPulse, currentBeatFlash, comboGrid } from "./rhythmGate";
import { renderTrails } from "./trailsRender";
import { renderPopups } from "./popups";
import { renderBassLightnings } from "./bassLightning";
import { renderDriftBursts } from "./driftBurst";
import { renderStreakOrbs, streakWindowClosed } from "./streakBurst";
import { primaryReticulePosition } from "../ship/reticule/reticuleRender";
import { renderWormholes } from "./wormhole";
import { computeConeFrame, toroidalDelta } from "../ship/reticule/coneGeometry";
import { pickCenterMostTargetForFocus, ReticuleTarget, setReticuleWrapAnchor } from "../ship/reticule/trajectoryPreview";
import { renderShipTrajectoryPreview } from "../ship/shipTrajectoryPreview";
import { renderLasers, renderLaserChargeDots, renderLaserAmbientFlash } from "./laserShot";
import { renderLaserReticule } from "../ship/reticule/laserReticule";
import { renderBossBeams } from "./bossBeam";
import { renderSepulchreCues } from "./sepulchre";
import { renderSlowMoTimerBar } from "./slowMoTimerBar";
import { renderBonusLifeFlash } from "./bonusLife";
import { updateSpectrumVisualizer, paintSpectrumVisualizer } from "./spectrumVisualizer";
import { cosmeticRng } from "./rng";
import { traceCitadelHolePath } from "../Asteroid";
import { paintInkClouds, isPointInAnyInkPatch } from "./inkCloud";
import { aimHintRender } from "./aimHint";

// Overdrive ramp above the tier-3 white threshold. The combo halo saturates to
// white at rhythm 12; this 0→1 factor keeps climbing from there to 24 so the
// bassteroid halos and the bass lightning can crank brighter/whiter past the
// point the tier system tops out.
const SUPER_RHYTHM_FLOOR = 12;
const SUPER_RHYTHM_CEIL = 24;
const superRhythm = (game: Game): number =>
  Math.max(0, Math.min(1, (game.beatCombo - SUPER_RHYTHM_FLOOR) / (SUPER_RHYTHM_CEIL - SUPER_RHYTHM_FLOOR)));

// shake is purely cosmetic; isolate its math so render() reads top-down.
// Uses the cosmetic RNG stream — render runs every animation frame live but NOT
//   during the muted replay re-sim sweep, so drawing the gameplay stream here
//   shifts its draw count and desyncs replays (rngState drifts ~first hit).
const applyScreenShake = (game: Game): { shakeX: number; shakeY: number } => {
  if (game.shake <= 0) return { shakeX: 0, shakeY: 0 };
  game.shakeSeed += 1;
  return {
    shakeX: (cosmeticRng() - 0.5) * game.shake * 10,
    shakeY: (cosmeticRng() - 0.5) * game.shake * 10,
  };
};

// deep-space backdrop has to repaint every frame or shake/clearRect leaves trails.
const paintBackdrop = (game: Game) => {
  const { ctx, w, h } = game;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, w, h);
};

// The starfield is the deepest layer — it must sit behind every other object and
// effect. The pulsar used to ride here too, but it's a world-positioned landmark
// (it wraps with the torus in scroll mode), so it now lives in the world layer.
// The starfield reads the pulsar's camera view so its parallax + roll stay locked
// to the pulsar's dolly — the whole background reads as one coherent camera move.
// scrollX/scrollY shift the whole field 1:1 with the world (scroll mode), so the
// stars feel anchored to the torus the ship moves across, not pinned to the glass.
const paintBackground = (game: Game, scrollX = 0, scrollY = 0) => {
  game.starfield.render(game.ctx, game.time, game.pulsar.cameraView(), scrollX, scrollY);
};

// ctx.filter = brightness(...) is implemented as a full-canvas pixel pass on most browsers
// and caused noticeable per-frame lag when several focusable bodies were on screen. Replace it
// with a single additive radial-gradient disc painted on top of the focused target — every other
// entity already uses globalCompositeOperation = "lighter", so an extra additive splash reads
// as "this one is glowing brighter" without touching any sprite pipeline.
const FOCUS_GLOW_RADIUS_MULT = 1.35;
const FOCUS_GLOW_ALPHA = 0.22;
const FOCUS_GLOW_MIN_RADIUS = 8;
const paintFocusGlow = (ctx: CanvasRenderingContext2D, t: ReticuleTarget) => {
  const r = Math.max(FOCUS_GLOW_MIN_RADIUS, (t.radius ?? FOCUS_GLOW_MIN_RADIUS) * FOCUS_GLOW_RADIUS_MULT);
  const g = ctx.createRadialGradient(t.pos.x, t.pos.y, 0, t.pos.x, t.pos.y, r);
  g.addColorStop(0, `rgba(255, 255, 255, ${FOCUS_GLOW_ALPHA})`);
  g.addColorStop(0.5, `rgba(255, 255, 255, ${(FOCUS_GLOW_ALPHA * 0.3).toFixed(3)})`);
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(t.pos.x, t.pos.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// On-beat brightening for every wave body. Same additive-disc trick as paintFocusGlow
// (ctx.filter=brightness is a slow full-canvas pass — see that note), so the flash reads as
// "this lit up" on top of the sprite without touching each entity's own draw pipeline.
const BEAT_FLASH_RADIUS_MULT = 1.15;
const BEAT_FLASH_ALPHA = 0.35;
const paintBeatFlash = (
  ctx: CanvasRenderingContext2D, pos: Vec, radius: number, flash: number,
) => {
  const r = Math.max(6, radius) * BEAT_FLASH_RADIUS_MULT;
  const a = BEAT_FLASH_ALPHA * flash;
  const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r);
  g.addColorStop(0, `rgba(255, 255, 255, ${a.toFixed(3)})`);
  g.addColorStop(0.6, `rgba(255, 255, 255, ${(a * 0.4).toFixed(3)})`);
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

// bodies must sit ON their own trails, so trails pass before any per-entity
// render call. Each body draws ONCE — the scroll camera replicates the whole
// layer at the wrap offsets, so a body near the seam is drawn whole by the
// neighbouring copy. The pulsar renders separately via paintPulsarLayer.
// Entering bodies are skipped here (in every loop, incl. beat-flash) — they
// draw once at their unfolded entrance image via paintEntrances instead.
const paintEntityLayers = (game: Game, focusedTarget: ReticuleTarget | null) => {
  const { ctx } = game;
  renderTrails(game, ctx);
  // Departure portals sit behind the comet/alien bodies so a warping-out body
  // dives into the visible mouth and shrinks down the throat in front of it.
  renderWormholes(ctx, game.wormholes, game.time * 0.001);
  for (const c of game.comets) if (!c.entering) c.render(ctx);
  for (const s of game.shards) s.render(ctx);
  // bassteroids wear the ship's 4+/12+ combo halo — share the ship's eased
  // intensity + the live beat pulse so every halo on the field rides one rhythm.
  // `super` (0→1 above rhythm 12) drives the extra-bright overdrive: the tier-3
  // white saturates at 12, so past it the halos brighten and the bass lightning
  // crackles a hotter white on top of the same colour.
  const comboHalo = {
    intensity: game.ship.comboHaloIntensity,
    beatPulse: currentBeatPulse(game),
    super: superRhythm(game),
  };
  // The bier's tethers go down before the bodies do, so the tomb and its
  // bearers sit on top of the lines running between them.
  renderSepulchreCues(ctx, game, game.time);
  for (const a of game.asteroids) if (!a.entering) a.render(ctx, game.time, comboHalo);
  for (const c of game.canisters) c.render(ctx, game.time);
  for (const g of game.gems) if (!g.entering) g.render(ctx, game.time);
  for (const o of game.fuelOrbs) o.render(ctx, game.time);
  for (const al of game.aliens) if (!al.entering) al.render(ctx, game.time);
  for (const ab of game.alienBullets) ab.render(ctx);
  renderBossBeams(ctx, game.bossBeams);
  for (const b of game.bullets) b.render(ctx);
  renderLasers(ctx, game.lasers);
  // every wave body brightens on the beat then tapers over ~100ms (paints over the sprites above).
  const beatFlash = currentBeatFlash(game);
  if (beatFlash > 0) {
    // Intangible bodies skip the beat flash — a dormant boss is masquerading as
    // the near-black background planet, and a phased-out warble/citadel is a
    // faint ghost mid-plane-shift; a bright pulse on either breaks that read.
    // Same set the reticule + rotated pass already exclude.
    for (const a of game.asteroids) {
      if (a.entering || a.isDormantSilhouette() || a.isPhasedOut()) continue;
      if (a.kind === "citadel") {
        // The flash disc is brightest dead-centre — clip the escape hole out
        // so it stays bare space instead of pulsing with the shell.
        ctx.save();
        ctx.beginPath();
        const clipR = a.radius * BEAT_FLASH_RADIUS_MULT + 4;
        ctx.rect(a.pos.x - clipR, a.pos.y - clipR, clipR * 2, clipR * 2);
        traceCitadelHolePath(ctx, a.pos, a.rotation);
        ctx.clip("evenodd");
        paintBeatFlash(ctx, a.pos, a.radius, beatFlash);
        ctx.restore();
      } else {
        paintBeatFlash(ctx, a.pos, a.radius, beatFlash);
      }
    }
    // warping-out aliens skip the beat-flash — a full-size flash disc would
    // detach from the shrinking body diving down the portal throat.
    for (const c of game.comets) if (!c.entering) paintBeatFlash(ctx, c.pos, c.radius, beatFlash);
    for (const al of game.aliens) if (al.warpT === null && !al.entering) paintBeatFlash(ctx, al.pos, al.radius, beatFlash);
    for (const c of game.canisters) paintBeatFlash(ctx, c.pos, c.radius, beatFlash);
    for (const g of game.gems) if (!g.entering) paintBeatFlash(ctx, g.pos, g.radius, beatFlash);
  }
  // An entering focused target isn't drawn in this layer — its glow rides the
  // entrance image in paintEntrances instead, else a body-less glow cloud
  // appears at the folded pos.
  if (focusedTarget && !focusedTarget.entering) paintFocusGlow(ctx, focusedTarget);
  renderBassLightnings(ctx, game.bassLightnings, game.time * 0.001, superRhythm(game));
  renderDriftBursts(ctx, game.driftBursts, game.time * 0.001);
  game.particles.render(ctx);
  // Ink clouds sit above every entity/particle so the blackout genuinely
  // occludes the field, but below popups (small text/icon accents that
  // should stay legible even mid-blackout).
  paintInkClouds(ctx, game);
  // Popups (combo / pickup / score) anchor at the world spot they describe (a hit
  // location, the ship), so they scroll + wrap with the world, not the glass.
  renderPopups(ctx, game.popups);
};

// Entering bodies draw ONCE at their unfolded entrance image (pos + enterOff)
// under the RAW camera offset — not mod-normalized; the enterOff bookkeeping
// (entity folds, ship folds) keeps that product continuous — so they slide in
// from the screen border and canvas clipping masks the offscreen part. Order
// mirrors the world layer: trails → comets → asteroids → gems → aliens.
const paintEntrances = (game: Game, camX: number, camY: number, focusedTarget: ReticuleTarget | null) => {
  const { ctx } = game;
  const entering =
    game.comets.some((c) => c.entering) ||
    game.asteroids.some((a) => a.entering) ||
    game.gems.some((g) => g.entering) ||
    game.aliens.some((al) => al.entering);
  if (!entering) return;
  const atEntrance = (e: { enterOffX?: number; enterOffY?: number }, draw: () => void) => {
    ctx.save();
    ctx.translate(e.enterOffX ?? 0, e.enterOffY ?? 0);
    draw();
    ctx.restore();
  };
  ctx.save();
  ctx.translate(camX, camY);
  const tSec = game.time * 0.001;
  // trails first so each body sits on its own wake, like the world layer.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const a of game.asteroids) if (a.entering && a.trail) atEntrance(a, () => a.trail!.render(ctx, tSec));
  for (const al of game.aliens) if (al.entering) atEntrance(al, () => al.trail.render(ctx, tSec));
  for (const c of game.comets) if (c.entering) atEntrance(c, () => c.glowTrail.render(ctx, tSec));
  ctx.restore();
  for (const c of game.comets) if (c.entering) atEntrance(c, () => c.render(ctx));
  const comboHalo = {
    intensity: game.ship.comboHaloIntensity,
    beatPulse: currentBeatPulse(game),
    super: superRhythm(game),
  };
  for (const a of game.asteroids) if (a.entering) atEntrance(a, () => a.render(ctx, game.time, comboHalo));
  for (const g of game.gems) if (g.entering) atEntrance(g, () => g.render(ctx, game.time));
  for (const al of game.aliens) if (al.entering) atEntrance(al, () => al.render(ctx, game.time));
  // Focus glow for an entering focused target rides its entrance image, on
  // top of the body — mirrors the world layer's ordering.
  if (focusedTarget?.entering) atEntrance(focusedTarget, () => paintFocusGlow(ctx, focusedTarget));
  ctx.restore();
};

// The pulsar's own layer: the planet + shockwave ring + spectrum halo, drawn
// together so they share one parallax depth. The scroll camera replicates this
// at the pulsar-parallax offsets (slower than the 1.0 entity layer) so the
// pulsar reads as a distant body the closer field slides past.
const paintPulsarLayer = (game: Game) => {
  const { ctx } = game;
  game.pulsar.render(ctx);
  game.pulsar.renderShockwaveOverlay(ctx);
  paintSpectrumVisualizer(game);
};

// reticule reads every visible target on the field; gather them once not repeatedly.
// Exported so the ship-rotation snap (gameUpdate) can use the same target set as the reticule.
// Alien bullets are deliberately excluded — they're incoming threats, not things you shoot,
// and painting trajectories for them clutters the field with predictions the player can't act on.
// The dormant boss is excluded too — during its approach it's meant to read as part of the
// background planet, so the reticule must not light it up or treat it as a lockable target.
export const targetsForReticule = (game: Game) => [
  // Skip intangible rocks — a dormant boss and a phased-out warble both pass
  // bullets through, so the reticule shouldn't promise a hit on them.
  // (Entering spawns ARE included: they're live toroidal targets.)
  ...game.asteroids.filter((a) => !a.isDormantSilhouette() && !a.isPhasedOut()),
  // Warping-out aliens are intangible and leaving — don't lock them. Comets are
  // tangible their whole life (they burst apart in place, no warp), so all count.
  ...game.comets,
  ...game.aliens.filter((a) => a.warpT === null),
  ...game.canisters,
  // Moving gems (the fan a burst gold asteroid throws off) are real rhythm
  // targets, so give them trajectory lines + a first-beat dot like any rock.
  // Parked/near-still drops self-skip in the trajectory walk (speed<1).
  ...game.gems.filter((g) => Math.hypot(g.vel.x, g.vel.y) >= 1),
];

// Ship + reticule + trajectory are the screen-pinned foreground: in scroll mode
// the ship is locked dead-center and the reticule/preview are drawn relative to
// it, so this layer is painted ONCE at the camera centre, never wrap-replicated.
// (Popups moved to the world layer — they anchor at world positions, not glass.)
const paintForeground = (game: Game, targets: ReadonlyArray<ReticuleTarget>) => {
  const { ctx } = game;
  // Mid-skip-warp the ship isn't aiming at anything: the reticule, streak
  // orbs, trajectory preview, and laser chrome hide for the whole sequence
  // (the alive gates cover most of it — this also spans the emerge scale-in).
  const warping = game.waveSkip !== null;
  const doubletime = comboGrid(game) < BEAT_GRID;
  // highlight the reticule + first-beat dot while the tutorial wants the player on a
  //   target: the drift/hover gate (3), the fire-and-hit sub-line (4), and build-to-4x (5).
  const tutorialHighlight =
    game.firstWaveHintStage === 3 ||
    (game.firstWaveHintStage === 4 && game.firstWaveHintSubVisible) ||
    game.firstWaveHintStage === 5;
  // perceivedBeatTime: the reticule pulse + first-beat dots cue when to fire, so they
  //   ride the latency-shifted clock and peak on the beat the player hears.
  // superBoosted (combo ≥ 12) doubles bullet range the same way longshot does — pass it
  //   through so the reticule renderer paints the matching 2-beat slot.
  const superBoosted = game.beatCombo >= 12;
  // gold crystals are stationary (or near-stationary) "First Dot" probes — they need a direct
  // proximity pass since the trajectory walk skips speed<1 targets.
  if (!warping) {
    game.ship.renderReticules(ctx, BEAT_GRID, game.w, game.h, targets, game.perceivedBeatTime, doubletime, tutorialHighlight, game.sound, game.beatTime, superBoosted, game.gems, aimHintRender(game));
    // Streak orbs orbit the primary "next-beat" reticule.
    const reticuleCenter = primaryReticulePosition(game.ship, BEAT_GRID, game.w, game.h, doubletime, superBoosted);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    renderStreakOrbs(ctx, game, reticuleCenter);
    ctx.restore();
  }
  // Streak sound: each streak rolls one of two escalating textures — the generative music-box
  // arpeggio (16ths tightening to 32nds, climbing registers) or the looping updraft stems (a
  // breathing pad whose rising-arpeggio layer blooms in). Holds off until streak 3 so a brief
  // run doesn't trigger it, and dies once the extension window closes.
  const streakAlive = game.streakShots >= 3 && !streakWindowClosed(game);
  if (streakAlive) {
    // 0.2 floor so streak 3 is already audible; crosses the escalation threshold (0.35) just past
    //   streak 5 and reaches full at ~streak 15.
    const ramp = 1 - Math.pow(1 - Math.min((game.streakShots - 3) / 12, 1), 1.6);
    // Seconds until the next beat boundary, so the loop set starts its downbeat on the grid.
    const beatAlignDelay = (BEAT_GRID - (game.beatTime % BEAT_GRID)) % BEAT_GRID;
    game.sound.updateStreakSound(0.2 + 0.8 * ramp, beatAlignDelay);
  } else {
    game.sound.stopStreakSound();
  }
  // ship.lastThrustActiveAt is recorded in game.time/1000 units; pass the same clock so
  // the post-thrust fade doesn't get stuck after intro overlays (which advance beatTime
  // without advancing game.time).
  if (!warping) renderShipTrajectoryPreview(ctx, game.ship, BEAT_GRID, game.time / 1000, game.w, game.h);
  // During a skip warp the ship dives into (and later climbs out of) a portal —
  // pass that portal so its far lip crops the hull as it sinks down the throat.
  const cropPortal = game.waveSkip?.cropPortal ?? null;
  // Ink blackout dims the ship rather than swallowing it outright — a soft
  // dark disc UNDER the hull so it still reads as "there, but hard to see",
  // never fully invisible. Ship renders on top of this every frame regardless.
  if (isPointInAnyInkPatch(game, game.ship.pos)) {
    const dimR = game.ship.radius * 2.2;
    const dimGrad = ctx.createRadialGradient(game.ship.pos.x, game.ship.pos.y, 0, game.ship.pos.x, game.ship.pos.y, dimR);
    dimGrad.addColorStop(0, "rgba(2, 3, 6, 0.55)");
    dimGrad.addColorStop(1, "rgba(2, 3, 6, 0)");
    ctx.save();
    ctx.fillStyle = dimGrad;
    ctx.beginPath();
    ctx.arc(game.ship.pos.x, game.ship.pos.y, dimR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  game.ship.render(ctx, game.time, currentBeatPulse(game), cropPortal, game.w, game.h);
  if (!warping) {
    renderLaserReticule(ctx, game, game.beatTime);
    renderLaserChargeDots(ctx, game, game.beatTime);
  }
};

// ── Scroll mode (locked-center): live wrap-replicated paint ───────────────────
// The default camera. The ship is pinned to screen centre and the torus scrolls
// around it. Rather than snapshot-then-tile (which clips anything drawn past the
// 1920x1080 buffer at the seam — every effect would have to opt into a wrap
// twin), we paint the LIVE world directly at each of the <=4 wrap offsets that
// intersect the viewport. Every entity, particle, and effect is captured whole;
// clipping is structurally impossible and no per-effect bookkeeping is needed.
//
// Layering (deepest first):
//   • backdrop + background — painted ONCE, scrolled with per-layer parallax so
//     the starfield stays behind everything and never tiles in front of an effect
//   • pulsar layer (pulsar + shockwave ring + spectrum halo) — replicated at its
//     OWN parallax (slower than entities), so it reads as a distant body
//   • world layer (entities, effects, popups) — replicated at the 1.0 wrap
//     offsets so bodies straddling the seam appear whole on both sides
//   • screen-pinned foreground (ship at centre, reticule, slow-mo bar)
// The pulsar slides slower than gameplay entities — a distant body, not at the
// ship's depth (but nearer than the twinkling star layers at STARFIELD_PARALLAX).
// The nearest foreground accents (ecliptic stars) ride the pulsar's own focal
// transform, orbiting the shared ecliptic alongside the planets.
const PULSAR_PARALLAX = 0.62;

// Advance the render-only continuous camera (Game.camScroll*). The ship's
// gameplay position wraps each frame, so we can't difference it directly — we
// take the step toroidally (a wrap reads as a small move, not a ±w jump) and
// integrate it. Seeded to the exact `w/2 - ship.pos` on the first frame (and
// after a resize/teleport, detected by an out-of-torus jump) so the camera is
// pixel-identical to the old math except that it never snaps.
const updateCamScroll = (game: Game) => {
  const { w, h, ship } = game;
  const seed = () => {
    game.camScrollX = w / 2 - ship.pos.x;
    game.camScrollY = h / 2 - ship.pos.y;
  };
  if (game.lastShipPosX === null || game.lastShipPosY === null) {
    seed();
  } else {
    const [dx, dy] = toroidalDelta(ship.pos.x - game.lastShipPosX, ship.pos.y - game.lastShipPosY, w, h);
    // A step larger than a wrapped frame's worth means a respawn/teleport, not
    // motion — reseed rather than smear a huge slide across the field.
    if (Math.hypot(dx, dy) > Math.min(w, h) * 0.25) seed();
    else {
      game.camScrollX -= dx;
      game.camScrollY -= dy;
    }
  }
  game.lastShipPosX = ship.pos.x;
  game.lastShipPosY = ship.pos.y;
};

const paintScrollScene = (game: Game, shakeX: number, shakeY: number) => {
  const { ctx, w, h } = game;
  // Exact camera offset that maps the ship's world position to screen centre.
  // The world layer (`% w` inside tileCopies) and the foreground translate both
  // need this exact so the pinned ship lands pixel-dead-centre.
  const camX = w / 2 - game.ship.pos.x;
  const camY = h / 2 - game.ship.pos.y;
  // Continuous version for the SUB-1 parallax layers (pulsar + starfield). Those
  // scale the offset by a fraction <1, so the per-frame ±w snap `camX` takes at a
  // seam crossing becomes a `parallax·w` jolt that `% w` can't hide. camScroll
  // integrates the ship's toroidal step instead, so it never snaps; it equals
  // camX modulo w, so the layers land in the same place — just without the jump.
  updateCamScroll(game);
  const parallaxX = game.camScrollX;
  const parallaxY = game.camScrollY;

  // Replicate `paint` at the <=4 wrap copies of a layer scrolled by (sx,sy) that
  // intersect the viewport. The torus is one screen wide/tall, so two copies per
  // axis cover it; skip any copy fully off-screen (ship exactly on a seam).
  const tileCopies = (sx: number, sy: number, paint: () => void) => {
    let ox = sx % w;
    if (ox > 0) ox -= w;
    let oy = sy % h;
    if (oy > 0) oy -= h;
    for (let i = 0; i < 2; i++) {
      const cx = ox + i * w;
      if (cx >= w || cx + w <= 0) continue;
      for (let j = 0; j < 2; j++) {
        const cy = oy + j * h;
        if (cy >= h || cy + h <= 0) continue;
        ctx.save();
        ctx.translate(cx, cy);
        paint();
        ctx.restore();
      }
    }
  };

  ctx.save();
  paintBackdrop(game);
  ctx.translate(shakeX, shakeY);

  // Background once; it applies its own per-layer parallax to the camera offset.
  paintBackground(game, parallaxX, parallaxY);

  const targets = targetsForReticule(game);
  const focusedTarget = pickCenterMostTargetForFocus(
    game.ship.pos, computeConeFrame(game.ship), game.w, game.h, targets,
  );

  // Spectrum band state advances exactly once, before any copy paints it.
  updateSpectrumVisualizer(game);

  // Pulsar layer at its own (slower) parallax, behind the entities.
  tileCopies(parallaxX * PULSAR_PARALLAX, parallaxY * PULSAR_PARALLAX, () => paintPulsarLayer(game));

  // World layer at the 1.0 wrap offsets. Every copy is a live full paint, so a
  // body near the seam is drawn whole by the neighbouring copy.
  tileCopies(camX, camY, () => paintEntityLayers(game, focusedTarget));

  // Entering bodies slide in over the world layer, under the foreground.
  paintEntrances(game, camX, camY, focusedTarget);

  // Screen-pinned foreground: ship is locked dead-centre, so translate the world
  // by the camera offset and the reticule/preview (drawn relative to ship.pos)
  // land centred. These are painted once — no wrap copies. The reticule's dot
  // draw-positions must wrap to the ship's nearest toroidal copy (not fold into
  // [0,w)) so they stay put across a seam under this translate, hence the anchor.
  ctx.save();
  ctx.translate(camX, camY);
  setReticuleWrapAnchor(game.ship.pos);
  paintForeground(game, targets);
  setReticuleWrapAnchor(null);
  ctx.restore();

  // Glass overlays (slow-mo rail, laser wash) sit on the screen, not the world,
  // so they're drawn once in screen space. The spectrum halo already rode the
  // pulsar layer above (it rings the wrapped pulsar).
  renderSlowMoTimerBar(game);
  renderLaserAmbientFlash(ctx, game);
  renderBonusLifeFlash(ctx, game);
  ctx.restore();
};

// one entry point so main.ts doesn't see the layer ordering, and shake wraps the whole scene.
export const renderGame = (game: Game) => {
  const { shakeX, shakeY } = applyScreenShake(game);
  paintScrollScene(game, shakeX, shakeY);
};
