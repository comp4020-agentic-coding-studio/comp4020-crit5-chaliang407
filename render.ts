// Canvas rendering only. Reads GameState + VfxState, mutates neither ---
// game.ts stays a deterministic function of (state, input, dt), and vfx.ts
// stays the single owner of cosmetic-only state. This file only composes.

import {
  DASH_COOLDOWN,
  decisionCardRects,
  ENEMY_RADIUS,
  PLAYER_MAX_HEALTH,
  PROJECTILE_RADIUS,
  STOLEN_CORE_RADIUS,
  type GameState,
} from "./game.ts";
import { cooldownFor, type PowerFamily } from "./powers.ts";
import { drawEnemy, drawPlayer, FAMILY_COLOR, type EnemyPose, type PlayerPose } from "./art.ts";
import { currentShakeOffset, drawParticles, type VfxState } from "./vfx.ts";

const ENEMY_PROJECTILE_COLOR = "#ff7043";
const PLAYER_PROJECTILE_COLOR = "#80deea";
const NEUTRAL_GLYPH_COLOR = "rgba(255,255,255,0.7)";
const CORNER_MARK = 26;

function colorOf(family: PowerFamily): string {
  return `rgb(${FAMILY_COLOR[family].join(",")})`;
}

function pseudoRandom(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

const SPECKLE = Array.from({ length: 130 }, (_, i) => ({
  fx: pseudoRandom(i * 2.13 + 1),
  fy: pseudoRandom(i * 7.91 + 1),
  r: 0.6 + pseudoRandom(i * 3.7 + 1) * 1.6,
  a: 0.02 + pseudoRandom(i * 5.2 + 1) * 0.05,
}));

const DUST = Array.from({ length: 20 }, (_, i) => ({
  fx: pseudoRandom(i * 1.7 + 5),
  fy: pseudoRandom(i * 4.3 + 5),
  speed: 0.01 + pseudoRandom(i * 9.1 + 5) * 0.02,
  size: 1 + pseudoRandom(i * 2.9 + 5) * 1.6,
  alpha: 0.05 + pseudoRandom(i * 6.6 + 5) * 0.07,
}));

export function createRenderer(canvas: HTMLCanvasElement) {
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) throw new Error("2D canvas context unavailable");
  const ctx: CanvasRenderingContext2D = maybeCtx;

  let clock = 0;
  let prevHealth = PLAYER_MAX_HEALTH;
  let hitFlash = 0;
  let prevEncounterIndex: number | null = null;
  let transitionFlash = 0;

  function render(state: GameState, vfx: VfxState, dt: number): void {
    clock += dt;
    const { width, height } = state.arena;

    if (state.player.health < prevHealth) hitFlash = 0.22;
    prevHealth = state.player.health;
    hitFlash = Math.max(0, hitFlash - dt);

    if (prevEncounterIndex === null) {
      prevEncounterIndex = state.encounterIndex;
    } else if (state.encounterIndex !== prevEncounterIndex) {
      prevEncounterIndex = state.encounterIndex;
      transitionFlash = 0.6;
    }
    transitionFlash = Math.max(0, transitionFlash - dt);

    const shake = currentShakeOffset(vfx);

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(shake.x, shake.y);

    drawFloor(ctx, width, height, clock);
    drawVignette(ctx, width, height);
    drawArenaFrame(ctx, width, height);
    drawCornerProps(ctx, width, height);
    drawAmbientDust(ctx, width, height, clock);

    drawTrail(ctx, vfx, state);
    drawHazards(ctx, state, clock);
    for (const enemy of state.enemies) {
      if (!enemy.alive) continue;
      drawEnemy(ctx, enemyPose(enemy, clock, state.stolenCore?.family ?? null));
    }
    drawProjectiles(ctx, state);
    drawStolenCore(ctx, state, clock);
    drawParticles(ctx, vfx);
    if (state.phase !== "dead") {
      drawPlayerGroundRing(ctx, state, clock);
      drawPlayer(ctx, playerPose(state, 0, clock));
    }
    if (state.phase !== "dead" && state.phase !== "cleared") drawPowerPrompt(ctx, vfx, state);

    if (transitionFlash > 0) drawTransitionFlash(ctx, width, height, transitionFlash);

    if (hitFlash > 0) {
      ctx.fillStyle = `rgba(255, 30, 30, ${hitFlash * 0.45})`;
      ctx.fillRect(-40, -40, width + 80, height + 80);
    }
    ctx.restore();

    drawHealthBar(ctx, state.player.health, width);
    drawBossBar(ctx, state, width);
    drawAbilityBar(ctx, state, width, height);

    if (state.phase === "decision" && state.decision) {
      drawDecision(ctx, state);
    }
    if (state.phase === "dead") {
      drawPlayer(ctx, playerPose(state, 1, clock));
      drawEndOverlay(ctx, width, height, clock, false);
    }
    if (state.phase === "cleared") {
      drawEndOverlay(ctx, width, height, clock, true);
    }
  }

  return { render };
}

// --- Arena / environment -----------------------------------------------------

function drawFloor(ctx: CanvasRenderingContext2D, width: number, height: number, clock: number): void {
  const grad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.55,
    Math.min(width, height) * 0.08,
    width * 0.5,
    height * 0.55,
    Math.max(width, height) * 0.8,
  );
  grad.addColorStop(0, "#141720");
  grad.addColorStop(1, "#080910");
  ctx.fillStyle = grad;
  ctx.fillRect(-40, -40, width + 80, height + 80);

  for (const s of SPECKLE) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(255,255,255,${s.a})`;
    ctx.arc(width * s.fx, height * s.fy, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.028)";
  ctx.lineWidth = 1;
  const spacing = 72;
  const shift = (clock * 4) % spacing;
  for (let x = -spacing; x < width + spacing; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x + shift, 0);
    ctx.lineTo(x + shift, height);
    ctx.stroke();
  }
  for (let y = -spacing; y < height + spacing; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y + shift * 0.4);
    ctx.lineTo(width, y + shift * 0.4);
    ctx.stroke();
  }
}

function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const grad = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.28,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(-40, -40, width + 80, height + 80);
}

function drawArenaFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, width - 12, height - 12);

  ctx.strokeStyle = "rgba(255,255,255,0.32)";
  ctx.lineWidth = 3;
  const marks: [number, number, number, number][] = [
    [10, 10, 1, 1],
    [width - 10, 10, -1, 1],
    [10, height - 10, 1, -1],
    [width - 10, height - 10, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of marks) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + CORNER_MARK * sy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + CORNER_MARK * sx, cy);
    ctx.stroke();
  }
}

function drawCornerProps(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const spots: [number, number, number, number][] = [
    [26, 26, 1, 1],
    [width - 26, 26, -1, 1],
    [26, height - 26, 1, -1],
    [width - 26, height - 26, -1, -1],
  ];
  ctx.fillStyle = "rgba(20,22,30,0.55)";
  for (const [cx, cy, sx, sy] of spots) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + 34 * sx, cy + 6 * sy);
    ctx.lineTo(cx + 22 * sx, cy + 30 * sy);
    ctx.lineTo(cx + 4 * sx, cy + 20 * sy);
    ctx.closePath();
    ctx.fill();
  }
}

function drawAmbientDust(ctx: CanvasRenderingContext2D, width: number, height: number, clock: number): void {
  for (const d of DUST) {
    const x = width * ((d.fx + clock * d.speed) % 1);
    const y = height * d.fy + Math.sin(clock * 0.6 + d.fx * 10) * 8;
    ctx.beginPath();
    ctx.fillStyle = `rgba(255,255,255,${d.alpha})`;
    ctx.arc(x, y, d.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTransitionFlash(ctx: CanvasRenderingContext2D, width: number, height: number, remaining: number): void {
  const total = 0.6;
  const t = 1 - remaining / total;
  const alpha = 1 - t;

  ctx.fillStyle = `rgba(255,255,255,${alpha * 0.05})`;
  ctx.fillRect(-40, -40, width + 80, height + 80);

  const r = t * Math.max(width, height) * 0.75;
  ctx.beginPath();
  ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.4})`;
  ctx.lineWidth = 3;
  ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPlayerGroundRing(ctx: CanvasRenderingContext2D, state: GameState, clock: number): void {
  const color = state.player.build.main ? colorOf(state.player.build.main) : NEUTRAL_GLYPH_COLOR;
  const pulse = 0.5 + 0.5 * Math.sin(clock * 3);
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.16 + 0.1 * pulse;
  ctx.lineWidth = 2;
  ctx.arc(state.player.pos.x, state.player.pos.y + 10, 20, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// --- World entities -----------------------------------------------------------

function drawTrail(ctx: CanvasRenderingContext2D, vfx: VfxState, state: GameState): void {
  const n = vfx.trail.length;
  for (let i = 0; i < n; i++) {
    const t = vfx.trail[i];
    const alpha = Math.max(0, t.life / 0.18) * 0.35;
    drawPlayer(ctx, {
      pos: t.pos,
      facing: t.facing,
      moving: false,
      dashing: true,
      invulnerable: false,
      build: state.player.build,
      orbitAngle: state.player.orbitAngle,
      orbitActive: false,
      hitFlash: 0,
      deathProgress: 0,
      clock: 0,
      alpha,
    });
  }
}

// Fire pools and Singularity Cinder zones --- functionally necessary to
// render since the player must be able to see and avoid/exploit them, kept
// deliberately minimal (a single translucent disc) rather than new HUD work.
function drawHazards(ctx: CanvasRenderingContext2D, state: GameState, clock: number): void {
  for (const hz of state.hazards) {
    const t = Math.max(0, hz.timeLeft) / 2.2;
    const pulse = 0.6 + 0.4 * Math.sin(clock * 8);
    ctx.beginPath();
    ctx.fillStyle = `rgba(255,120,50,${0.18 + 0.12 * pulse * t})`;
    ctx.arc(hz.pos.x, hz.pos.y, hz.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255,170,90,${0.35 * t})`;
    ctx.lineWidth = 2;
    ctx.arc(hz.pos.x, hz.pos.y, hz.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// The boss's stolen core --- a drifting orb the player must dash into to
// reclaim a lifted power. Also deliberately minimal but necessary: without
// it the boss's central mechanic would be invisible.
function drawStolenCore(ctx: CanvasRenderingContext2D, state: GameState, clock: number): void {
  const core = state.stolenCore;
  if (!core) return;
  const bob = Math.sin(clock * 3) * 4;
  const pos = { x: core.pos.x, y: core.pos.y + bob };
  const color = FAMILY_COLOR[core.family];

  ctx.beginPath();
  ctx.fillStyle = `rgba(${color.join(",")},0.9)`;
  ctx.arc(pos.x, pos.y, STOLEN_CORE_RADIUS * 0.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = `rgba(255,255,255,${0.4 + 0.35 * Math.sin(clock * 10)})`;
  ctx.lineWidth = 2;
  ctx.arc(pos.x, pos.y, STOLEN_CORE_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
}

function playerPose(state: GameState, deathProgress: number, clock: number): PlayerPose {
  const p = state.player;
  const moving = p.dashTimeLeft <= 0;
  return {
    pos: p.pos,
    facing: p.facing,
    moving,
    dashing: p.dashTimeLeft > 0,
    invulnerable: p.invulnerable > 0,
    build: p.build,
    orbitAngle: p.orbitAngle,
    orbitActive: p.build.main === "orbit" || p.orbitFlingTimeLeft > 0,
    hitFlash: p.invulnerable > 0 && deathProgress === 0 ? 0.4 : 0,
    deathProgress,
    clock,
  };
}

function enemyPose(enemy: GameState["enemies"][number], clock: number, stolenFamily: PowerFamily | null): EnemyPose {
  const telegraphing = enemy.phase % 10 === 1;
  const ratio = telegraphing && enemy.telegraphDuration > 0 ? 1 - Math.max(0, enemy.timer) / enemy.telegraphDuration : 0;
  return {
    kind: enemy.kind,
    pos: enemy.pos,
    facing: enemy.facing,
    radius: ENEMY_RADIUS[enemy.kind],
    telegraphRatio: Math.min(1, Math.max(0, ratio)),
    invulnerable: enemy.invulnerable,
    exposed: enemy.exposed,
    elite: enemy.elite,
    clock,
    orbitAngle: enemy.orbitAngle,
    stolenFamily: enemy.kind === "boss" ? stolenFamily : null,
  };
}

function drawProjectiles(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const p of state.projectiles) {
    const color = p.owner === "enemy" ? ENEMY_PROJECTILE_COLOR : p.boomerang ? colorOf("boomerang") : PLAYER_PROJECTILE_COLOR;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(p.pos.x, p.pos.y, PROJECTILE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    if (p.owner === "player") {
      ctx.beginPath();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.arc(p.pos.x, p.pos.y, PROJECTILE_RADIUS * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// --- Contextual acquired-power prompt -----------------------------------------

function drawPowerPrompt(ctx: CanvasRenderingContext2D, vfx: VfxState, state: GameState): void {
  const prompt = vfx.powerPrompt;
  if (!prompt) return;

  const t = prompt.life / prompt.maxLife;
  const fadeIn = Math.min(1, (prompt.maxLife - prompt.life) / 0.25);
  const fadeOut = Math.min(1, prompt.life / 0.5);
  const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
  if (alpha <= 0) return;

  const drift = (1 - t) * 16;
  const x = state.player.pos.x;
  const y = state.player.pos.y - 40 - drift;
  const key = "LMB";
  const glyphColor = colorOf(prompt.power);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);

  const pillW = 78;
  const pillH = 26;
  roundedRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, 13);
  ctx.fillStyle = "rgba(8,9,13,0.85)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const glyphX = -pillW / 2 + 15;
  drawFamilyGlyph(ctx, glyphX, 0, prompt.power, 6, glyphColor);

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(key, 14, 0.5);

  ctx.restore();
}

// --- HUD: health / boss bars ---------------------------------------------------

function drawHealthBar(ctx: CanvasRenderingContext2D, health: number, width: number): void {
  const barWidth = Math.min(240, width * 0.32);
  const barHeight = 14;
  const x = 22;
  const y = 22;
  const ratio = Math.max(0, health / PLAYER_MAX_HEALTH);

  roundedRect(ctx, x - 4, y - 4, barWidth + 8, barHeight + 8, 10);
  ctx.fillStyle = "rgba(8,9,12,0.5)";
  ctx.fill();

  roundedRect(ctx, x, y, barWidth, barHeight, 7);
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fill();

  ctx.save();
  roundedRect(ctx, x, y, barWidth, barHeight, 7);
  ctx.clip();
  ctx.fillStyle = ratio > 0.5 ? "#66bb6a" : ratio > 0.25 ? "#ffca28" : "#ef5350";
  ctx.fillRect(x, y, barWidth * ratio, barHeight);
  ctx.restore();

  roundedRect(ctx, x, y, barWidth, barHeight, 7);
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(x + barWidth * f, y + 2);
    ctx.lineTo(x + barWidth * f, y + barHeight - 2);
    ctx.stroke();
  }
}

function drawBossBar(ctx: CanvasRenderingContext2D, state: GameState, width: number): void {
  const boss = state.enemies.find((e) => e.kind === "boss" && e.alive);
  if (!boss) return;
  const barWidth = Math.min(420, width * 0.5);
  const x = width / 2 - barWidth / 2;
  const y = 20;
  const barHeight = 10;
  const ratio = Math.max(0, boss.hp / boss.maxHp);

  roundedRect(ctx, x - 4, y - 4, barWidth + 8, barHeight + 8, 8);
  ctx.fillStyle = "rgba(8,9,12,0.5)";
  ctx.fill();

  roundedRect(ctx, x, y, barWidth, barHeight, 5);
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fill();

  ctx.save();
  roundedRect(ctx, x, y, barWidth, barHeight, 5);
  ctx.clip();
  ctx.fillStyle = boss.exposed ? "#ffd76a" : state.stolenCore ? "#ff9bd6" : "#c25a8a";
  ctx.fillRect(x, y, barWidth * ratio, barHeight);
  ctx.restore();

  roundedRect(ctx, x, y, barWidth, barHeight, 5);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (boss.exposed) {
    ctx.strokeStyle = `rgba(255,235,150,${0.5 + 0.5 * Math.sin(performance.now() / 120)})`;
    ctx.lineWidth = 2;
    roundedRect(ctx, x - 2, y - 2, barWidth + 4, barHeight + 4, 6);
    ctx.stroke();
  }
}

// --- HUD: ability action bar ----------------------------------------------------

interface AbilitySlot {
  kind: "attack" | "dash";
  key?: string;
  cooldownRatio?: number;
}

function drawAbilityBar(ctx: CanvasRenderingContext2D, state: GameState, width: number, height: number): void {
  const p = state.player;

  const slots: AbilitySlot[] = [
    { kind: "attack", key: "LMB", cooldownRatio: p.attackCooldown / cooldownFor(p.build) },
    { kind: "dash", key: "SPACE", cooldownRatio: p.dashCooldown / DASH_COOLDOWN },
  ];

  const size = 46;
  const gap = 10;
  const totalWidth = slots.length * size + (slots.length - 1) * gap;
  let x = width / 2 - totalWidth / 2;
  const y = height - size - 26;

  for (const slot of slots) {
    drawSlotFrame(ctx, x, y, size);
    const cx = x + size / 2;
    const cy = y + size / 2;

    if (slot.kind === "attack") {
      if (p.build.main) drawFamilyGlyph(ctx, cx, cy, p.build.main, 9, colorOf(p.build.main));
      else {
        ctx.beginPath();
        ctx.fillStyle = NEUTRAL_GLYPH_COLOR;
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.build.mutatedMain) {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(255,220,100,0.85)";
        ctx.lineWidth = 2;
        ctx.arc(cx, cy, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
      drawCooldownWipe(ctx, cx, cy, size / 2 - 3, slot.cooldownRatio ?? 0);
      drawInfusionPips(ctx, x, y, size, p.build.infusions);
    } else if (slot.kind === "dash") {
      drawDashGlyph(ctx, cx, cy);
      drawCooldownWipe(ctx, cx, cy, size / 2 - 3, slot.cooldownRatio ?? 0);
    }

    if (slot.key) drawKeyTag(ctx, cx, y + size + 3, slot.key);

    x += size + gap;
  }
}

function drawInfusionPips(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, infusions: PowerFamily[]): void {
  const r = 5;
  for (let i = 0; i < infusions.length; i++) {
    const px = x + size - r - 2;
    const py = y + r + 2 + i * (r * 2 + 3);
    ctx.beginPath();
    ctx.fillStyle = colorOf(infusions[i]);
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawSlotFrame(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  roundedRect(ctx, x, y, size, size, 10);
  ctx.fillStyle = "rgba(10,12,17,0.6)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// One glyph shape per family, shared between the ability bar, the power
// prompt, and the decision cards, so the same silhouette always means the
// same power.
function drawFamilyGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  family: PowerFamily,
  r: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  ctx.beginPath();
  if (family === "blink") {
    ctx.moveTo(-r * 0.6, -r);
    ctx.lineTo(r * 0.3, -r * 0.15);
    ctx.lineTo(-r * 0.2, r * 0.1);
    ctx.lineTo(r * 0.6, r);
  } else if (family === "boomerang") {
    ctx.moveTo(-r * 0.7, r * 0.6);
    ctx.quadraticCurveTo(-r * 0.7, -r * 0.8, r * 0.7, -r * 0.5);
    ctx.quadraticCurveTo(-r * 0.1, -r * 0.25, -r * 0.7, r * 0.6);
  } else if (family === "clone") {
    ctx.arc(-r * 0.25, 0, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.globalAlpha = 0.55;
    ctx.arc(r * 0.35, 0, r * 0.6, 0, Math.PI * 2);
  } else if (family === "blackhole") {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "rgba(10,4,16,0.9)";
    ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
  } else if (family === "orbit") {
    ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  } else {
    ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.arc(0, 0, r * 0.75, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.fill();
  ctx.restore();
}

function drawDashGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const off of [-5, 3]) {
    ctx.beginPath();
    ctx.moveTo(cx + off - 4, cy - 7);
    ctx.lineTo(cx + off + 4, cy);
    ctx.lineTo(cx + off - 4, cy + 7);
    ctx.stroke();
  }
}

function drawCooldownWipe(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, ratio: number): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped <= 0) return;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(6,7,10,0.72)";
  ctx.fill();
}

function drawKeyTag(ctx: CanvasRenderingContext2D, cx: number, y: number, text: string): void {
  ctx.font = "bold 9px system-ui, sans-serif";
  const padX = 6;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 14;
  roundedRect(ctx, cx - w / 2, y, w, h, 6);
  ctx.fillStyle = "rgba(6,7,10,0.75)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, y + h / 2 + 0.5);
}

// --- Decision / end overlays -----------------------------------------------------

function drawDecision(ctx: CanvasRenderingContext2D, state: GameState): void {
  const decision = state.decision;
  if (!decision) return;
  const rects = decisionCardRects(state.arena);
  const { width, height } = state.arena;

  const vg = ctx.createRadialGradient(width / 2, height / 2, 60, width / 2, height / 2, Math.max(width, height) * 0.7);
  vg.addColorStop(0, "rgba(6,7,10,0.72)");
  vg.addColorStop(1, "rgba(6,7,10,0.86)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, width, height);

  drawCard(ctx, rects.left, decision.family, "REPLACE", null);
  drawCard(ctx, rects.right, decision.family, "COMBINE", state.player.build.main);
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  offeredFamily: PowerFamily,
  label: string,
  currentMain: PowerFamily | null,
): void {
  const { x, y, width, height } = rect;
  const cx = x + width / 2;
  const cy = y + height / 2;

  ctx.beginPath();
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2;
  roundedRect(ctx, x, y, width, height, 14);
  ctx.fill();
  ctx.stroke();

  if (currentMain === null) {
    // REPLACE: the offered family becomes the whole build.
    drawFamilyGlyph(ctx, cx, cy, offeredFamily, width * 0.28, colorOf(offeredFamily));
  } else {
    // COMBINE: current main stays centre-stage, the offered family attaches
    // as a smaller accent, matching how it will actually sit in the build.
    drawFamilyGlyph(ctx, cx, cy, currentMain, width * 0.22, colorOf(currentMain));
    drawFamilyGlyph(ctx, cx + width * 0.24, cy + width * 0.2, offeredFamily, width * 0.13, colorOf(offeredFamily));
  }

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, y + height + 18);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawEndOverlay(ctx: CanvasRenderingContext2D, width: number, height: number, clock: number, won: boolean): void {
  const vg = ctx.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, Math.max(width, height) * 0.75);
  if (won) {
    vg.addColorStop(0, "rgba(30,24,6,0.35)");
    vg.addColorStop(1, "rgba(10,8,2,0.72)");
  } else {
    vg.addColorStop(0, "rgba(20,20,20,0.4)");
    vg.addColorStop(1, "rgba(0,0,0,0.75)");
  }
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, width, height);

  const scale = 1 + Math.sin(clock * 4) * 0.08;
  const radius = 42 * scale;
  const color = won ? "#ffd76a" : "#f5f5f5";

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;

  if (won) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + clock * 0.6;
      const r1 = radius * 0.55;
      const r2 = radius * (1 + 0.15 * Math.sin(clock * 5 + i));
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, radius, -Math.PI * 0.15, Math.PI * 1.55);
    ctx.stroke();
    const angle = Math.PI * 1.55;
    const tipX = Math.cos(angle) * radius;
    const tipY = Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 14, tipY - 6);
    ctx.lineTo(tipX - 4, tipY + 14);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.35 + 0.25 * Math.sin(clock * 3);
  ctx.fillText("click to continue", width / 2, height / 2 + radius + 34);
  ctx.globalAlpha = 1;
}
