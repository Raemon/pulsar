// Self-contained instructions demo animations. Two looping canvas demos that
// teach: (a) basic move-and-shoot, (b) the rhythm + trajectory-reticule
// alignment idea. Visuals mimic the in-game style (cyan ship, hue-tinted
// asteroids, dashed reticule, dotted trajectory) without depending on the
// game engine — so the demos never touch live game state and can run
// independently while the instructions panel is open.

const TAU = Math.PI * 2;
const SHIP_HUE = 195;
const RETICULE_HSL = "220, 100%, 100%";

type Vec = { x: number; y: number };
const fromAngle = (a: number, m = 1): Vec => ({ x: Math.cos(a) * m, y: Math.sin(a) * m });
const wrap = (a: Vec, w: number, h: number): Vec => ({
  x: ((a.x % w) + w) % w,
  y: ((a.y % h) + h) % h,
});

type Asteroid = {
  pos: Vec; vel: Vec; radius: number; hue: number;
  rotation: number; rotSpeed: number;
  // pre-rolled lumpy outline samples (relative to radius=1)
  outline: number[];
  // pre-rolled lumpy nuclei (interior glow dots)
  nuclei: { angle: number; dist: number; size: number; phase: number }[];
  // bullet flash when hit
  flash: number;
  alive: boolean;
};

type Bullet = { pos: Vec; vel: Vec; life: number };
type Particle = { pos: Vec; vel: Vec; life: number; maxLife: number; hue: number };

const buildOutline = (samples: number): number[] => {
  // Same Fourier-sum recipe as the real asteroid silhouette: small, layered
  // harmonics give a lumpy-but-coherent shape.
  const harmonics = [
    { amp: 0.16 / Math.SQRT2, freq: 2, phase: Math.random() * TAU },
    { amp: 0.14 / Math.sqrt(3), freq: 3, phase: Math.random() * TAU },
    { amp: 0.12 / Math.sqrt(5), freq: 5, phase: Math.random() * TAU },
    { amp: 0.10 / Math.sqrt(7), freq: 7, phase: Math.random() * TAU },
  ];
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * TAU;
    let r = 1;
    for (const h of harmonics) r += h.amp * Math.cos(a * h.freq + h.phase);
    out.push(r);
  }
  return out;
};

const ASTEROID_HUES = [185, 200, 220, 250, 280, 310, 330];
let huePaletteCursor = 0;
const nextHue = (): number => {
  huePaletteCursor = (huePaletteCursor + 1) % ASTEROID_HUES.length;
  return ASTEROID_HUES[huePaletteCursor];
};

const makeAsteroid = (pos: Vec, vel: Vec, radius: number, hue?: number): Asteroid => {
  const nucCount = radius > 25 ? 4 : radius > 15 ? 3 : 2;
  const nuclei = [];
  for (let i = 0; i < nucCount; i++) {
    nuclei.push({
      angle: (i / nucCount) * TAU + (Math.random() - 0.5) * 0.6,
      dist: (0.18 + Math.random() * 0.35) * radius,
      size: (2 + Math.random() * 2) * (radius > 25 ? 1.2 : 1),
      phase: Math.random() * TAU,
    });
  }
  return {
    pos, vel, radius,
    hue: hue ?? nextHue(),
    rotation: Math.random() * TAU,
    rotSpeed: (Math.random() - 0.5) * 0.9,
    outline: buildOutline(48),
    nuclei,
    flash: 0,
    alive: true,
  };
};

const drawAsteroid = (ctx: CanvasRenderingContext2D, a: Asteroid, t: number) => {
  ctx.save();
  ctx.translate(a.pos.x, a.pos.y);
  ctx.rotate(a.rotation);
  ctx.globalCompositeOperation = "lighter";
  // halo
  const haloR = a.radius * 2.0;
  const halo = ctx.createRadialGradient(0, 0, a.radius * 0.7, 0, 0, haloR);
  halo.addColorStop(0, `hsla(${a.hue}, 100%, 60%, 0.12)`);
  halo.addColorStop(0.5, `hsla(${a.hue + 10}, 100%, 55%, 0.05)`);
  halo.addColorStop(1, `hsla(${a.hue}, 100%, 60%, 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, haloR, 0, TAU);
  ctx.fill();
  // body outline
  ctx.beginPath();
  for (let i = 0; i < a.outline.length; i++) {
    const ang = (i / a.outline.length) * TAU;
    const r = a.outline[i] * a.radius;
    const x = Math.cos(ang) * r;
    const y = Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const interior = ctx.createRadialGradient(0, 0, 0, 0, 0, a.radius);
  interior.addColorStop(0, `hsla(${a.hue}, 70%, 32%, 0.40)`);
  interior.addColorStop(0.7, `hsla(${a.hue - 10}, 60%, 20%, 0.28)`);
  interior.addColorStop(1, `hsla(${a.hue}, 50%, 10%, 0.06)`);
  ctx.fillStyle = interior;
  ctx.fill();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = `hsla(${a.hue + 10}, 100%, 78%, 0.75)`;
  ctx.stroke();
  // nuclei
  for (const n of a.nuclei) {
    const nx = Math.cos(n.angle) * n.dist;
    const ny = Math.sin(n.angle) * n.dist;
    const pulse = 0.6 + 0.4 * Math.sin(t * 2 + n.phase);
    const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, n.size * 4);
    g.addColorStop(0, `hsla(${a.hue + 20}, 100%, 92%, ${0.85 * pulse})`);
    g.addColorStop(0.4, `hsla(${a.hue}, 100%, 65%, ${0.40 * pulse})`);
    g.addColorStop(1, `hsla(${a.hue}, 100%, 60%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(nx, ny, n.size * 4, 0, TAU);
    ctx.fill();
  }
  // hit flash
  if (a.flash > 0) {
    ctx.fillStyle = `hsla(${a.hue + 30}, 100%, 95%, ${a.flash * 0.3})`;
    ctx.beginPath();
    ctx.arc(0, 0, a.radius * 1.15, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};

type Ship = {
  pos: Vec;
  heading: number;
  thrustOn: boolean;
  vel: Vec;
  invuln: number;
};

const drawShip = (ctx: CanvasRenderingContext2D, s: Ship, beatPulse: number) => {
  const r = 14;
  const verts: Vec[] = [
    fromAngle(s.heading, r * 1.4),
    fromAngle(s.heading + Math.PI * 0.78, r * 1.0),
    fromAngle(s.heading - Math.PI * 0.78, r * 1.0),
  ];
  ctx.save();
  ctx.translate(s.pos.x, s.pos.y);
  ctx.globalCompositeOperation = "lighter";
  const scale = 1 + 0.08 * beatPulse;
  ctx.scale(scale, scale);
  // hull — matches the in-game beat flash: whitening outline, flooding fill,
  // and an additive bloom, so the demo ship punches on the beat the same way.
  const bloomR = r * 3.4;
  const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, bloomR);
  bloom.addColorStop(0, `hsla(${SHIP_HUE}, 60%, 95%, ${(0.5 * beatPulse).toFixed(3)})`);
  bloom.addColorStop(0.45, `hsla(${SHIP_HUE}, 90%, 70%, ${(0.18 * beatPulse).toFixed(3)})`);
  bloom.addColorStop(1, `hsla(${SHIP_HUE}, 100%, 60%, 0)`);
  ctx.strokeStyle = `hsla(${SHIP_HUE}, ${100 - 55 * beatPulse}%, ${75 + 22 * beatPulse}%, ${Math.min(1, 0.7 + 0.65 * beatPulse)})`;
  ctx.lineWidth = 1.5 + 2.2 * beatPulse;
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (const u of verts.slice(1)) ctx.lineTo(u.x, u.y);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = `hsla(${SHIP_HUE}, ${100 - 55 * beatPulse}%, ${60 + 30 * beatPulse}%, ${0.12 + 0.5 * beatPulse})`;
  ctx.fill();
  ctx.fillStyle = bloom;
  ctx.beginPath();
  ctx.arc(0, 0, bloomR, 0, TAU);
  ctx.fill();
  // thrust flame
  if (s.thrustOn) {
    const back = fromAngle(s.heading + Math.PI, r * 1.8 + Math.random() * 4);
    const g = ctx.createRadialGradient(back.x, back.y, 0, back.x, back.y, 16);
    g.addColorStop(0, "hsla(200, 100%, 80%, 0.9)");
    g.addColorStop(0.5, "hsla(200, 100%, 60%, 0.3)");
    g.addColorStop(1, "hsla(200, 100%, 60%, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(back.x, back.y, 16, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
};

const drawBullet = (ctx: CanvasRenderingContext2D, b: Bullet) => {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(b.pos.x, b.pos.y, 0, b.pos.x, b.pos.y, 6);
  g.addColorStop(0, "hsla(50, 100%, 92%, 1)");
  g.addColorStop(0.4, "hsla(45, 100%, 70%, 0.5)");
  g.addColorStop(1, "hsla(45, 100%, 60%, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(b.pos.x, b.pos.y, 6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "hsla(50, 100%, 95%, 1)";
  ctx.beginPath();
  ctx.arc(b.pos.x, b.pos.y, 1.6, 0, TAU);
  ctx.fill();
  ctx.restore();
};

const drawParticle = (ctx: CanvasRenderingContext2D, p: Particle) => {
  const t = p.life / p.maxLife;
  if (t <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = `hsla(${p.hue}, 100%, 75%, ${t * 0.8})`;
  ctx.beginPath();
  ctx.arc(p.pos.x, p.pos.y, 1.5 * t + 0.5, 0, TAU);
  ctx.fill();
  ctx.restore();
};

const explode = (parts: Particle[], pos: Vec, hue: number, count: number) => {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const s = 30 + Math.random() * 90;
    parts.push({
      pos: { x: pos.x, y: pos.y },
      vel: { x: Math.cos(a) * s, y: Math.sin(a) * s },
      life: 0.6 + Math.random() * 0.4,
      maxLife: 1.0,
      hue,
    });
  }
};

const splitAsteroid = (a: Asteroid, impactDir: Vec): Asteroid[] => {
  if (a.radius < 14) return [];
  const baseAngle = Math.atan2(impactDir.y, impactDir.x);
  const speed = Math.hypot(a.vel.x, a.vel.y) * 1.3 + 30;
  const children: Asteroid[] = [];
  for (let i = 0; i < 2; i++) {
    const off = (i === 0 ? -1 : 1) * (0.9 + Math.random() * 0.3);
    const ang = baseAngle + off;
    const childRadius = a.radius * 0.55;
    const child = makeAsteroid(
      { x: a.pos.x, y: a.pos.y },
      fromAngle(ang, speed),
      childRadius,
      a.hue,
    );
    children.push(child);
  }
  return children;
};

// ------------------------------------------------------------------
// Demo A: Fly & Fire
// A ship loops through "thrust toward asteroid, line up, fire, split,
// fly through, repeat". Pure scripted choreography — no physics surprises.
// ------------------------------------------------------------------

type BasicsState = {
  ship: Ship;
  asteroids: Asteroid[];
  bullets: Bullet[];
  particles: Particle[];
  t: number;
  // Seconds spent with no asteroids alive — used to hold a brief "cleared"
  // moment before respawning the demo.
  clearedHold: number;
  fireCooldown: number;
};

const initBasics = (w: number, h: number): BasicsState => ({
  ship: { pos: { x: w * 0.3, y: h * 0.6 }, heading: -0.4, thrustOn: false, vel: { x: 0, y: 0 }, invuln: 0 },
  asteroids: [
    makeAsteroid({ x: w * 0.75, y: h * 0.35 }, { x: -22, y: 8 }, 28, 220),
    makeAsteroid({ x: w * 0.92, y: h * 0.78 }, { x: -18, y: -10 }, 22, 280),
  ],
  bullets: [],
  particles: [],
  t: 0,
  clearedHold: 0,
  fireCooldown: 0,
});

const updateBasics = (s: BasicsState, dt: number, w: number, h: number) => {
  s.t += dt;
  s.fireCooldown = Math.max(0, s.fireCooldown - dt);

  // Aim toward the first alive asteroid.
  const target = s.asteroids.find(a => a.alive);
  if (target) {
    const dx = target.pos.x - s.ship.pos.x;
    const dy = target.pos.y - s.ship.pos.y;
    const desired = Math.atan2(dy, dx);
    // ease heading toward desired
    let diff = desired - s.ship.heading;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    s.ship.heading += Math.max(-3 * dt, Math.min(3 * dt, diff));
    // light thrust forward toward target if far away
    const dist = Math.hypot(dx, dy);
    s.ship.thrustOn = dist > 140 && Math.abs(diff) < 0.4;
    if (s.ship.thrustOn) {
      s.ship.vel.x += Math.cos(s.ship.heading) * 90 * dt;
      s.ship.vel.y += Math.sin(s.ship.heading) * 90 * dt;
    }
    // light damping so the demo doesn't drift off-screen
    s.ship.vel.x *= 0.985;
    s.ship.vel.y *= 0.985;
    // fire if aim is close and cooldown expired
    if (Math.abs(diff) < 0.18 && s.fireCooldown <= 0 && dist < 260) {
      s.bullets.push({
        pos: { x: s.ship.pos.x, y: s.ship.pos.y },
        vel: fromAngle(s.ship.heading, 360),
        life: 1.0,
      });
      s.fireCooldown = 0.55;
    }
  } else {
    s.ship.thrustOn = false;
  }

  // Ship motion
  s.ship.pos.x += s.ship.vel.x * dt;
  s.ship.pos.y += s.ship.vel.y * dt;
  s.ship.pos = wrap(s.ship.pos, w, h);

  // Bullets
  for (const b of s.bullets) {
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.life -= dt;
  }
  s.bullets = s.bullets.filter(b => b.life > 0);

  // Asteroids
  for (const a of s.asteroids) {
    if (!a.alive) continue;
    a.pos.x += a.vel.x * dt;
    a.pos.y += a.vel.y * dt;
    a.pos = wrap(a.pos, w, h);
    a.rotation += a.rotSpeed * dt;
    if (a.flash > 0) a.flash = Math.max(0, a.flash - dt * 3);
  }

  // Bullet-asteroid collisions
  const newAsteroids: Asteroid[] = [];
  for (const b of s.bullets) {
    if (b.life <= 0) continue;
    for (const a of s.asteroids) {
      if (!a.alive) continue;
      const dd = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      if (dd < a.radius * 0.9) {
        a.alive = false;
        b.life = 0;
        explode(s.particles, a.pos, a.hue, 20);
        const impactDir = { x: b.vel.x, y: b.vel.y };
        for (const child of splitAsteroid(a, impactDir)) newAsteroids.push(child);
        break;
      }
    }
  }
  s.asteroids = [...s.asteroids.filter(a => a.alive), ...newAsteroids];

  // Particles
  for (const p of s.particles) {
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.vel.x *= 0.96;
    p.vel.y *= 0.96;
    p.life -= dt;
  }
  s.particles = s.particles.filter(p => p.life > 0);

  // Loop the demo: when everything is destroyed, briefly hold, then reset.
  if (s.asteroids.length === 0) {
    s.clearedHold += dt;
    if (s.clearedHold > 1.2) {
      const fresh = initBasics(w, h);
      Object.assign(s, fresh);
    }
  } else {
    s.clearedHold = 0;
  }
};

const renderBasics = (ctx: CanvasRenderingContext2D, s: BasicsState, w: number, h: number) => {
  // Faded background fill (so trails persist a touch)
  ctx.fillStyle = "rgba(0, 4, 14, 1)";
  ctx.fillRect(0, 0, w, h);
  // tiny starfield
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 30; i++) {
    const x = ((i * 73 + 13) % w);
    const y = ((i * 41 + 7) % h);
    const a = 0.18 + 0.15 * Math.sin(s.t * 0.8 + i);
    ctx.fillStyle = `hsla(200, 30%, 90%, ${a})`;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.restore();
  for (const a of s.asteroids) drawAsteroid(ctx, a, s.t);
  for (const b of s.bullets) drawBullet(ctx, b);
  for (const p of s.particles) drawParticle(ctx, p);
  drawShip(ctx, s.ship, 0);
};

// ------------------------------------------------------------------
// Demo B: Rhythm + Reticule
// An asteroid drifts past with a dotted trajectory line; the ship rotates
// to line its reticule up over the next-beat dot, then fires on the beat
// and destroys it. A small BEAT pip pulses to show the tempo.
// ------------------------------------------------------------------

const BEAT_GRID = 0.7; // seconds per beat in this demo
const RHYTHM_BULLET_SPEED = 220;

type RhythmState = {
  ship: Ship;
  asteroid: Asteroid | null;
  bullets: Bullet[];
  particles: Particle[];
  t: number;
  beatTime: number;
  phase: "approach" | "destroyed";
  phaseElapsed: number;
  // when we last fired — used so we draw a quick muzzle hint
  lastFireAt: number;
};

// Asteroid drifts horizontally across the canvas at a known speed.
// Slow speed makes the trajectory dots clearly readable.
const RHYTHM_ASTEROID_VX = -32;
// Asteroid + ship geometry are hand-tuned so the ship's natural reticule
// distance (RHYTHM_BULLET_SPEED * BEAT_GRID) lands on top of the asteroid's
// first beat-dot when the ship is correctly aimed — gives a clean visual
// "lock".
const RHYTHM_ASTEROID_SPAWN_X = 340;
const RHYTHM_ASTEROID_SPAWN_Y = 75;
const RHYTHM_ASTEROID_RADIUS = 18;
const RHYTHM_SHIP_X = 169;
const RHYTHM_SHIP_Y = 165;

const spawnRhythmAsteroid = (): Asteroid =>
  makeAsteroid(
    { x: RHYTHM_ASTEROID_SPAWN_X, y: RHYTHM_ASTEROID_SPAWN_Y },
    { x: RHYTHM_ASTEROID_VX, y: 0 },
    RHYTHM_ASTEROID_RADIUS, 260,
  );

const initRhythm = (_w: number, _h: number): RhythmState => ({
  // Ship + asteroid geometry is hand-tuned so the reticule reach
  // (RHYTHM_BULLET_SPEED * BEAT_GRID) lands on the asteroid's first beat-dot.
  ship: { pos: { x: RHYTHM_SHIP_X, y: RHYTHM_SHIP_Y }, heading: -0.5, thrustOn: false, vel: { x: 0, y: 0 }, invuln: 0 },
  asteroid: spawnRhythmAsteroid(),
  bullets: [],
  particles: [],
  t: 0,
  beatTime: 0,
  phase: "approach",
  phaseElapsed: 0,
  lastFireAt: -10,
});

const updateRhythm = (s: RhythmState, dt: number, _w: number, _h: number) => {
  s.t += dt;
  s.beatTime += dt;
  s.phaseElapsed += dt;

  const beatPhase = (s.beatTime % BEAT_GRID) / BEAT_GRID;
  const onBeatNow = beatPhase < 0.07 || beatPhase > 0.93;

  if (s.asteroid && s.asteroid.alive) {
    s.asteroid.pos.x += s.asteroid.vel.x * dt;
    s.asteroid.pos.y += s.asteroid.vel.y * dt;
    s.asteroid.rotation += s.asteroid.rotSpeed * dt;
    if (s.asteroid.flash > 0) s.asteroid.flash = Math.max(0, s.asteroid.flash - dt * 3);
  }

  // Aim the ship so its reticule sits on the asteroid's first trajectory
  // dot (the point the asteroid will reach on the next beat). Slow tracking
  // so the player can see the alignment happen.
  if (s.asteroid && s.asteroid.alive) {
    const aspeed = Math.hypot(s.asteroid.vel.x, s.asteroid.vel.y);
    const aUx = aspeed > 0 ? s.asteroid.vel.x / aspeed : 0;
    const aUy = aspeed > 0 ? s.asteroid.vel.y / aspeed : 0;
    // First beat dot = asteroid leading-edge + one beat of motion.
    const lead = {
      x: s.asteroid.pos.x + aUx * (s.asteroid.radius + 6) + s.asteroid.vel.x * BEAT_GRID,
      y: s.asteroid.pos.y + aUy * (s.asteroid.radius + 6) + s.asteroid.vel.y * BEAT_GRID,
    };
    const dx = lead.x - s.ship.pos.x;
    const dy = lead.y - s.ship.pos.y;
    const desired = Math.atan2(dy, dx);
    let diff = desired - s.ship.heading;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    // Slow heading tracking — feels like a deliberate rotate.
    s.ship.heading += Math.max(-1.6 * dt, Math.min(1.6 * dt, diff));

    // Fire on a beat once aim is close enough and we haven't fired recently.
    if (onBeatNow && Math.abs(diff) < 0.08 && s.t - s.lastFireAt > BEAT_GRID * 1.2) {
      s.bullets.push({
        pos: { x: s.ship.pos.x, y: s.ship.pos.y },
        vel: fromAngle(s.ship.heading, RHYTHM_BULLET_SPEED),
        life: 1.4,
      });
      s.lastFireAt = s.t;
    }
  }

  // Bullets
  for (const b of s.bullets) {
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.life -= dt;
  }
  s.bullets = s.bullets.filter(b => b.life > 0);

  // Collisions
  if (s.asteroid && s.asteroid.alive) {
    for (const b of s.bullets) {
      if (b.life <= 0) continue;
      const dd = Math.hypot(s.asteroid.pos.x - b.pos.x, s.asteroid.pos.y - b.pos.y);
      if (dd < s.asteroid.radius * 0.9) {
        s.asteroid.alive = false;
        b.life = 0;
        explode(s.particles, s.asteroid.pos, s.asteroid.hue, 28);
        s.phase = "destroyed";
        s.phaseElapsed = 0;
      }
    }
  }

  // Particles
  for (const p of s.particles) {
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.vel.x *= 0.95;
    p.vel.y *= 0.95;
    p.life -= dt;
  }
  s.particles = s.particles.filter(p => p.life > 0);

  // Reset: asteroid offscreen or destroyed for a beat → spawn a fresh one
  const asteroidOffscreen = s.asteroid && (s.asteroid.pos.x < -40);
  const destroyedHoldDone = s.phase === "destroyed" && s.phaseElapsed > 1.6;
  if (asteroidOffscreen || destroyedHoldDone) {
    s.asteroid = spawnRhythmAsteroid();
    // Snap the ship's heading back to its starting orientation so each cycle
    // tells the same story (initial rotation → align → fire) rather than
    // having the ship pre-aimed at the new asteroid.
    s.ship.heading = -0.5;
    s.phase = "approach";
    s.phaseElapsed = 0;
    // Reset the beat clock so the next "first beat after lock" lands at a
    // predictable moment, keeping the demo cadence consistent.
    s.beatTime = 0;
    s.lastFireAt = -10;
  }
};

const drawBeatPip = (ctx: CanvasRenderingContext2D, w: number, _h: number, beatTime: number) => {
  const phase = (beatTime % BEAT_GRID) / BEAT_GRID;
  const decay = (1 - phase) * (1 - phase);
  const pulse = 0.35 + 0.65 * decay;
  const cx = w - 26;
  const cy = 26;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18);
  g.addColorStop(0, `hsla(195, 100%, 88%, ${pulse * 0.9})`);
  g.addColorStop(0.5, `hsla(195, 100%, 70%, ${pulse * 0.5})`);
  g.addColorStop(1, "hsla(195, 100%, 60%, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `hsla(195, 100%, 92%, ${pulse})`;
  ctx.beginPath();
  ctx.arc(cx, cy, 3 + pulse * 1.5, 0, TAU);
  ctx.fill();
  ctx.font = "9px system-ui, sans-serif";
  ctx.fillStyle = `hsla(195, 60%, 80%, 0.6)`;
  ctx.textAlign = "center";
  ctx.fillText("BEAT", cx, cy + 32);
  ctx.restore();
};

// Trajectory dots — sample the asteroid's predicted positions at each
// upcoming beat, render as dotted line + first-beat-dot lock indicator.
const drawTrajectoryAndReticule = (
  ctx: CanvasRenderingContext2D, s: RhythmState, beatTime: number,
) => {
  const a = s.asteroid;
  if (!a || !a.alive) return;
  const beatPhase = (beatTime % BEAT_GRID) / BEAT_GRID;
  const beatPulseBoost = 1 + 1.4 * (1 - beatPhase) * (1 - beatPhase);
  const speed = Math.hypot(a.vel.x, a.vel.y);
  if (speed < 1) return;
  const ux = a.vel.x / speed;
  const uy = a.vel.y / speed;
  const startX = a.pos.x + ux * (a.radius + 6);
  const startY = a.pos.y + uy * (a.radius + 6);
  const dotStep = speed * BEAT_GRID;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // beat dots along the trajectory
  for (let k = 1; k <= 4; k++) {
    const px = startX + ux * dotStep * k;
    const py = startY + uy * dotStep * k;
    if (k === 1) {
      // First beat dot — bigger and brighter, with dashed halo
      const alpha = Math.min(1, 0.55 * beatPulseBoost);
      ctx.fillStyle = `hsla(${RETICULE_HSL}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `hsla(${RETICULE_HSL}, ${0.25 * beatPulseBoost})`;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = `hsla(${RETICULE_HSL}, 0.32)`;
      ctx.beginPath();
      ctx.arc(px, py, 1.2, 0, TAU);
      ctx.fill();
    }
  }

  // Reticule disc — at one-beat distance ahead of the ship along its heading.
  const reticuleR = RHYTHM_BULLET_SPEED * BEAT_GRID;
  const rx = s.ship.pos.x + Math.cos(s.ship.heading) * reticuleR;
  const ry = s.ship.pos.y + Math.sin(s.ship.heading) * reticuleR;

  // Detect overlap with the first beat dot, so the disc brightens.
  const firstDotX = startX + ux * dotStep;
  const firstDotY = startY + uy * dotStep;
  const overlapDist = Math.hypot(firstDotX - rx, firstDotY - ry);
  const overlaps = overlapDist < 12;

  const baseAlpha = 0.28 * (1 + (1 - beatPhase) * 1.4);
  const overlapBoost = overlaps ? 3 : 1;
  const discAlpha = Math.min(1, baseAlpha * overlapBoost);
  ctx.strokeStyle = `hsla(${RETICULE_HSL}, ${discAlpha})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(rx, ry, 4.5, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rx, ry, 11, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
};

const renderRhythm = (ctx: CanvasRenderingContext2D, s: RhythmState, w: number, h: number) => {
  ctx.fillStyle = "rgba(0, 4, 14, 1)";
  ctx.fillRect(0, 0, w, h);
  // starfield
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 30; i++) {
    const x = ((i * 73 + 13) % w);
    const y = ((i * 41 + 7) % h);
    const a = 0.18 + 0.15 * Math.sin(s.t * 0.8 + i);
    ctx.fillStyle = `hsla(200, 30%, 90%, ${a})`;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.restore();

  if (s.asteroid) drawAsteroid(ctx, s.asteroid, s.t);
  for (const b of s.bullets) drawBullet(ctx, b);
  for (const p of s.particles) drawParticle(ctx, p);

  const beatPhase = (s.beatTime % BEAT_GRID) / BEAT_GRID;
  const beatPulse = (1 - beatPhase) * (1 - beatPhase);
  drawShip(ctx, s.ship, beatPulse);

  drawTrajectoryAndReticule(ctx, s, s.beatTime);
  drawBeatPip(ctx, w, h, s.beatTime);
};

// ------------------------------------------------------------------
// Lifecycle: start when panel opens, stop when it closes.
// ------------------------------------------------------------------

type DemoRunner = {
  start: () => void;
  stop: () => void;
};

// Renders into a fixed `designW × designH` coordinate space, then scales to
// fit the canvas's actual CSS size. Keeps the hand-tuned geometry valid even
// when the canvas shrinks on narrow viewports.
const makeDemo = <S>(
  canvas: HTMLCanvasElement,
  designW: number, designH: number,
  init: (w: number, h: number) => S,
  update: (s: S, dt: number, w: number, h: number) => void,
  render: (ctx: CanvasRenderingContext2D, s: S, w: number, h: number) => void,
): DemoRunner => {
  let state: S | null = null;
  let rafId: number | null = null;
  let lastTime = 0;
  let dpr = 1;

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  };

  const loop = (now: number) => {
    if (!state) return;
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    update(state, dt, designW, designH);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const cssW = canvas.clientWidth || (canvas.width / dpr);
      const cssH = canvas.clientHeight || (canvas.height / dpr);
      const scale = Math.min(cssW / designW, cssH / designH);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      render(ctx, state, designW, designH);
    }
    rafId = requestAnimationFrame(loop);
  };

  return {
    start: () => {
      if (rafId !== null) return;
      resize();
      state = init(designW, designH);
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    },
    stop: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      state = null;
    },
  };
};

export const installInstructionsDemos = () => {
  const basicsCanvas = document.getElementById("instructions-demo-basics") as HTMLCanvasElement | null;
  const rhythmCanvas = document.getElementById("instructions-demo-rhythm") as HTMLCanvasElement | null;
  if (!basicsCanvas || !rhythmCanvas) return;

  const basics = makeDemo(basicsCanvas, 360, 200, initBasics, updateBasics, renderBasics);
  const rhythm = makeDemo(rhythmCanvas, 360, 220, initRhythm, updateRhythm, renderRhythm);

  window.addEventListener("instructions-open", () => {
    basics.start();
    rhythm.start();
  });
  window.addEventListener("instructions-close", () => {
    basics.stop();
    rhythm.stop();
  });
};
