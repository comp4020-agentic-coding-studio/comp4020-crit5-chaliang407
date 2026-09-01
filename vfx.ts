// Cosmetic-only particle/trail/shake system. Reads GameState + GameEvents,
// never writes to them --- game.ts stays the single source of truth for
// rules, this file only decides how those rules *look*.

import type { GameState, Vec2 } from "./game.ts";
import type { PowerFamily } from "./powers.ts";

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
}

export interface TrailFrame {
  pos: Vec2;
  facing: Vec2;
  life: number;
}

export interface PowerPrompt {
  power: PowerFamily;
  life: number;
  maxLife: number;
}

export interface VfxState {
  particles: Particle[];
  trail: TrailFrame[];
  shakeTime: number;
  shakeMag: number;
  hitStopTime: number;
  flashes: { pos: Vec2; radius: number; life: number; maxLife: number; color: string }[];
  powerPrompt: PowerPrompt | null;
}

export function createVfx(): VfxState {
  return { particles: [], trail: [], shakeTime: 0, shakeMag: 0, hitStopTime: 0, flashes: [], powerPrompt: null };
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function spawnBurst(vfx: VfxState, pos: Vec2, color: string, count: number, speed: number): void {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(speed * 0.4, speed);
    vfx.particles.push({
      pos: { x: pos.x, y: pos.y },
      vel: { x: Math.cos(a) * s, y: Math.sin(a) * s },
      life: rand(0.25, 0.5),
      maxLife: 0.5,
      size: rand(2, 4),
      color,
      gravity: 0,
    });
  }
}

export function spawnStealSpectacle(vfx: VfxState, from: Vec2, to: Vec2, color: string): void {
  // The stolen power travels from the kill site into the player, so the eye
  // reads "absorbed", not just "something died over there".
  const duration = 0.32;
  const ringR = 40;
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const start = { x: from.x + Math.cos(a) * ringR, y: from.y + Math.sin(a) * ringR };
    vfx.particles.push({
      pos: start,
      vel: { x: (to.x - start.x) / duration, y: (to.y - start.y) / duration },
      life: duration,
      maxLife: duration,
      size: rand(2.5, 4.5),
      color,
      gravity: 0,
    });
  }
  vfx.flashes.push({ pos: { ...from }, radius: 10, life: 0.3, maxLife: 0.3, color });
}

export function spawnImpactFlash(vfx: VfxState, pos: Vec2, color: string, radius = 22): void {
  vfx.flashes.push({ pos: { ...pos }, radius, life: 0.18, maxLife: 0.18, color });
}

export function triggerShake(vfx: VfxState, magnitude: number, duration: number): void {
  vfx.shakeMag = Math.max(vfx.shakeMag, magnitude);
  vfx.shakeTime = Math.max(vfx.shakeTime, duration);
}

export function triggerHitStop(vfx: VfxState, duration: number): void {
  vfx.hitStopTime = Math.max(vfx.hitStopTime, duration);
}

export function pushTrail(vfx: VfxState, pos: Vec2, facing: Vec2): void {
  vfx.trail.push({ pos: { ...pos }, facing: { ...facing }, life: 0.18 });
  if (vfx.trail.length > 6) vfx.trail.shift();
}

export function consumeHitStop(vfx: VfxState, dt: number): number {
  if (vfx.hitStopTime <= 0) return dt;
  const slow = Math.min(1, vfx.hitStopTime / 0.08);
  vfx.hitStopTime = Math.max(0, vfx.hitStopTime - dt);
  return dt * (1 - slow * 0.85);
}

export function currentShakeOffset(vfx: VfxState): Vec2 {
  if (vfx.shakeTime <= 0) return { x: 0, y: 0 };
  const t = vfx.shakeTime;
  return { x: rand(-1, 1) * vfx.shakeMag * t, y: rand(-1, 1) * vfx.shakeMag * t };
}

export function updateVfx(vfx: VfxState, dt: number): void {
  for (const p of vfx.particles) {
    p.life -= dt;
    p.vel.y += p.gravity * dt;
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.vel.x *= 0.92;
    p.vel.y *= 0.92;
  }
  vfx.particles = vfx.particles.filter((p) => p.life > 0);

  for (const f of vfx.flashes) f.life -= dt;
  vfx.flashes = vfx.flashes.filter((f) => f.life > 0);

  for (const t of vfx.trail) t.life -= dt;
  vfx.trail = vfx.trail.filter((t) => t.life > 0);

  vfx.shakeTime = Math.max(0, vfx.shakeTime - dt);

  if (vfx.powerPrompt) {
    vfx.powerPrompt.life -= dt;
    if (vfx.powerPrompt.life <= 0) vfx.powerPrompt = null;
  }
}

// Translate one-shot game events into concrete effects. Call once per frame
// with the state produced by the latest step() call, while its events are
// still fresh.
export function reactToEvents(vfx: VfxState, state: GameState): void {
  const events = state.events;
  if (events.dashKill) {
    spawnBurst(vfx, events.dashKill, "#ff8a3d", 14, 220); // destruction: debris flying outward
    spawnStealSpectacle(vfx, events.dashKill, state.player.pos, "#ffe9a8"); // theft: power pulled in
    triggerShake(vfx, 6, 0.14);
    triggerHitStop(vfx, 0.07);
  }
  if (events.dashInterrupt) {
    // a healthy enemy shrugged the dash off --- a small spark, not a kill
    spawnImpactFlash(vfx, events.dashInterrupt, "#dfe9ff", 16);
    spawnBurst(vfx, events.dashInterrupt, "#dfe9ff", 6, 120);
  }
  if (events.evolved) {
    spawnBurst(vfx, state.player.pos, "#fff2c2", 20, 180);
    triggerShake(vfx, 4, 0.2);
    triggerHitStop(vfx, 0.05);
  }
  if (events.playerHit) {
    triggerShake(vfx, 5, 0.16);
  }
  if (events.coreStolen) {
    spawnStealSpectacle(vfx, state.player.pos, state.stolenCore?.pos ?? state.player.pos, "#ff9bd6");
    triggerShake(vfx, 5, 0.18);
  }
  if (events.coreReclaimed) {
    spawnBurst(vfx, state.player.pos, "#ffe9a8", 16, 180);
    triggerShake(vfx, 4, 0.16);
  }
  if (events.powerAcquired) {
    vfx.powerPrompt = { power: events.powerAcquired, life: 2.4, maxLife: 2.4 };
  }
}

export function drawParticles(ctx: CanvasRenderingContext2D, vfx: VfxState): void {
  for (const f of vfx.flashes) {
    const t = f.life / f.maxLife;
    ctx.beginPath();
    ctx.fillStyle = f.color;
    ctx.globalAlpha = t * 0.8;
    ctx.arc(f.pos.x, f.pos.y, f.radius * (1.4 - t * 0.4), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  for (const p of vfx.particles) {
    const t = Math.max(0, p.life / p.maxLife);
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.globalAlpha = t;
    ctx.arc(p.pos.x, p.pos.y, p.size * t, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}
