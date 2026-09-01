// Procedural character rigs, drawn with Canvas paths only --- no image
// assets. Every shape is authored in local space assuming the figure faces
// "up" (negative Y) and is rotated/translated into place by the caller.

import type { EnemyKind, Vec2 } from "./game.ts";
import { activeFusions, type Build, type PowerFamily } from "./powers.ts";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bch = Math.round(lerp(a[2], b[2], t));
  return `rgb(${r}, ${g}, ${bch})`;
}

function drawShadow(ctx: CanvasRenderingContext2D, radiusX: number, radiusY: number): void {
  ctx.beginPath();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.ellipse(0, radiusY * 0.3, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.fill();
}

// One colour per family, reused for both the enemy that demonstrates it and
// the player once it's stolen, so identity carries across the steal.
export const FAMILY_COLOR: Record<PowerFamily, [number, number, number]> = {
  blink: [150, 80, 190],
  boomerang: [230, 150, 60],
  clone: [64, 200, 224],
  blackhole: [120, 90, 200],
  orbit: [175, 230, 255],
  echo: [230, 90, 130],
};

// --- Player -----------------------------------------------------------------

export interface PlayerPose {
  pos: Vec2;
  facing: Vec2;
  moving: boolean;
  dashing: boolean;
  invulnerable: boolean;
  build: Build;
  orbitAngle: number;
  orbitActive: boolean;
  hitFlash: number;
  deathProgress: number; // 0 alive, 1 fully collapsed/faded
  clock: number;
  alpha?: number;
}

const NEUTRAL: [number, number, number] = [79, 165, 210];

export function drawPlayer(ctx: CanvasRenderingContext2D, pose: PlayerPose): void {
  const gait = pose.moving && !pose.dashing ? Math.sin(pose.clock * 12) : 0;
  const bob = pose.dashing ? 0 : Math.sin(pose.clock * 4) * 1.5;
  const stretch = pose.dashing ? 1.4 : 1;
  const squeeze = pose.dashing ? 0.82 : 1;
  const angle = Math.atan2(pose.facing.y, pose.facing.x) + Math.PI / 2;

  const bodyColor = pose.build.main ? FAMILY_COLOR[pose.build.main] : NEUTRAL;
  const fill = pose.hitFlash > 0 ? lerpColor(bodyColor, [255, 255, 255], pose.hitFlash) : lerpColor(bodyColor, bodyColor, 0);
  const fusions = activeFusions(pose.build);

  ctx.save();
  ctx.globalAlpha = (pose.alpha ?? 1) * (pose.invulnerable ? 0.55 + 0.45 * Math.sin(pose.clock * 40) : 1);
  ctx.translate(pose.pos.x, pose.pos.y + bob);
  ctx.rotate(angle + pose.deathProgress * (Math.PI / 2));

  drawShadow(ctx, 15, 6);
  ctx.scale(squeeze, stretch);

  // legs
  ctx.strokeStyle = "rgba(20,24,30,0.9)";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-5, 4);
  ctx.lineTo(-5 - gait * 3, 15);
  ctx.moveTo(5, 4);
  ctx.lineTo(5 + gait * 3, 15);
  ctx.stroke();

  // cloak body
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.quadraticCurveTo(-13, -10, -11, 6);
  ctx.quadraticCurveTo(-9, 13, 0, 15);
  ctx.quadraticCurveTo(9, 13, 11, 6);
  ctx.quadraticCurveTo(13, -10, 0, -18);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = "rgba(10,14,20,0.6)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // arms
  ctx.strokeStyle = fill;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-10, -6);
  ctx.lineTo(-16 - gait * 2, 2);
  ctx.moveTo(10, -6);
  ctx.lineTo(16 + gait * 2, 2);
  ctx.stroke();

  // hood + head
  ctx.beginPath();
  ctx.fillStyle = "rgba(20,24,30,0.92)";
  ctx.arc(0, -20, 8.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = fill;
  ctx.arc(0, -19, 4.5, Math.PI * 0.15, Math.PI * 0.85);
  ctx.fill();

  // fusion accent: a second, differently-coloured ring when an infusion has
  // fused with the main power into genuinely different behaviour.
  if (fusions.length > 0) {
    const infusionColor = pose.build.infusions[0] ? FAMILY_COLOR[pose.build.infusions[0]] : bodyColor;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(${infusionColor.join(",")},${0.5 + 0.4 * Math.sin(pose.clock * 6)})`;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 3]);
    ctx.arc(0, -3, 25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // equipped weapon glyph, one per family, brighter/larger when mutated
  drawWeaponGlyph(ctx, pose, gait);

  ctx.restore();

  // orbit ring: drawn outside the rotated/scaled local space so the blades
  // circle the player in world space, not spin with facing.
  if (pose.orbitActive) {
    ctx.save();
    ctx.globalAlpha = pose.alpha ?? 1;
    const orbitColor = FAMILY_COLOR.orbit;
    for (let i = 0; i < 2; i++) {
      const a = pose.orbitAngle + i * Math.PI;
      const bx = pose.pos.x + Math.cos(a) * 55;
      const by = pose.pos.y + bob + Math.sin(a) * 55;
      ctx.beginPath();
      ctx.fillStyle = `rgb(${orbitColor.join(",")})`;
      ctx.arc(bx, by, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.strokeStyle = `rgba(${orbitColor.join(",")},0.25)`;
    ctx.lineWidth = 1.5;
    ctx.arc(pose.pos.x, pose.pos.y + bob, 55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawWeaponGlyph(ctx: CanvasRenderingContext2D, pose: PlayerPose, gait: number): void {
  const main = pose.build.main;
  if (!main) return;
  const scale = pose.build.mutatedMain ? 1.4 : 1;
  const glow = pose.build.mutatedMain ? 1 : 0.85;
  const hand = { x: 17 + gait * 2, y: 2 };

  if (main === "blink") {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(200,150,230,${glow})`;
    ctx.lineWidth = 2.5;
    ctx.moveTo(hand.x - 5 * scale, hand.y - 6 * scale);
    ctx.lineTo(hand.x + 2 * scale, hand.y);
    ctx.lineTo(hand.x - 5 * scale, hand.y + 6 * scale);
    ctx.moveTo(hand.x, hand.y - 8 * scale);
    ctx.lineTo(hand.x + 6 * scale, hand.y);
    ctx.lineTo(hand.x, hand.y + 8 * scale);
    ctx.stroke();
    return;
  }
  if (main === "boomerang") {
    ctx.beginPath();
    ctx.fillStyle = `rgba(255,190,110,${glow})`;
    ctx.moveTo(hand.x - 6 * scale, hand.y + 5 * scale);
    ctx.quadraticCurveTo(hand.x - 6 * scale, hand.y - 7 * scale, hand.x + 6 * scale, hand.y - 4 * scale);
    ctx.quadraticCurveTo(hand.x - 1 * scale, hand.y - 2 * scale, hand.x - 6 * scale, hand.y + 5 * scale);
    ctx.fill();
    return;
  }
  if (main === "clone") {
    ctx.globalAlpha *= 0.9;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(140,235,255,${glow})`;
    ctx.lineWidth = 2;
    ctx.arc(hand.x - 2 * scale, hand.y, 5 * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = `rgba(140,235,255,${glow * 0.6})`;
    ctx.arc(hand.x + 3 * scale, hand.y - 1, 5 * scale, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (main === "blackhole") {
    ctx.beginPath();
    ctx.fillStyle = "rgba(15,8,25,0.95)";
    ctx.arc(hand.x, hand.y, 5 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = `rgba(150,110,220,${glow})`;
    ctx.lineWidth = 2;
    ctx.arc(hand.x, hand.y, 7.5 * scale, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (main === "orbit") {
    ctx.beginPath();
    ctx.fillStyle = `rgba(200,240,255,${glow})`;
    ctx.arc(hand.x, hand.y, 3 * scale, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // echo
  ctx.beginPath();
  ctx.strokeStyle = `rgba(255,140,180,${glow})`;
  ctx.lineWidth = 2;
  ctx.arc(hand.x, hand.y, 4 * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.strokeStyle = `rgba(255,140,180,${glow * 0.5})`;
  ctx.arc(hand.x, hand.y, 7.5 * scale, 0, Math.PI * 2);
  ctx.stroke();
}

// --- Enemies ------------------------------------------------------------------

export interface EnemyPose {
  kind: EnemyKind;
  pos: Vec2;
  facing: Vec2;
  radius: number;
  telegraphRatio: number; // 0 = not telegraphing, ->1 as the attack approaches
  invulnerable: boolean;
  exposed: boolean;
  elite: boolean;
  clock: number;
  orbitAngle?: number;
  stolenFamily?: PowerFamily | null;
}

const PHANTOM_COLOR: [number, number, number] = FAMILY_COLOR.blink;
const THROWER_COLOR: [number, number, number] = FAMILY_COLOR.boomerang;
const DUPLICATE_COLOR: [number, number, number] = FAMILY_COLOR.clone;
const ANCHOR_COLOR: [number, number, number] = FAMILY_COLOR.blackhole;
const SENTINEL_COLOR: [number, number, number] = FAMILY_COLOR.orbit;
const REVERBERANT_COLOR: [number, number, number] = FAMILY_COLOR.echo;
const BOSS_COLOR: [number, number, number] = [120, 40, 90];
const FLASH: [number, number, number] = [255, 255, 255];
const ELITE_TRIM: [number, number, number] = [255, 220, 90];

function telegraphFill(base: [number, number, number], ratio: number, clock: number): string {
  if (ratio <= 0) return `rgb(${base.join(",")})`;
  const pulse = 0.5 + 0.5 * Math.sin(clock * 20);
  return lerpColor(base, FLASH, ratio * pulse);
}

export function drawEnemy(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const angle = Math.atan2(pose.facing.y, pose.facing.x) + Math.PI / 2;
  ctx.save();
  ctx.translate(pose.pos.x, pose.pos.y);
  ctx.rotate(angle);
  drawShadow(ctx, pose.radius * 0.7, pose.radius * 0.3);

  if (pose.kind === "phantom") drawPhantom(ctx, pose);
  else if (pose.kind === "thrower") drawThrower(ctx, pose);
  else if (pose.kind === "duplicate") drawDuplicate(ctx, pose);
  else if (pose.kind === "anchor") drawAnchor(ctx, pose);
  else if (pose.kind === "sentinel") drawSentinel(ctx, pose);
  else if (pose.kind === "reverberant") drawReverberant(ctx, pose);
  else drawBoss(ctx, pose);

  if (pose.elite) {
    ctx.beginPath();
    ctx.strokeStyle = `rgba(${ELITE_TRIM.join(",")},${0.6 + 0.4 * Math.sin(pose.clock * 10)})`;
    ctx.lineWidth = 2.5;
    ctx.arc(0, 0, pose.radius * 1.25, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPhantom(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const r = pose.radius;
  const fill = telegraphFill(PHANTOM_COLOR, pose.telegraphRatio, pose.clock);
  const drift = Math.sin(pose.clock * 5) * 2;
  ctx.beginPath();
  ctx.ellipse(drift, 0, r * 0.55, r, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${PHANTOM_COLOR.join(",")},0.25)`;
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = fill;
  ctx.arc(0, -r * 0.1, r * 0.55, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = "rgba(15,5,25,0.85)";
  ctx.arc(-r * 0.18, -r * 0.2, r * 0.12, 0, Math.PI * 2);
  ctx.arc(r * 0.18, -r * 0.2, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
}

function drawThrower(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const r = pose.radius;
  const fill = telegraphFill(THROWER_COLOR, pose.telegraphRatio, pose.clock);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.55, r * 0.9);
  ctx.lineTo(-r * 0.55, r * 0.9);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = pose.telegraphRatio > 0 ? "#fff3d8" : `rgba(${THROWER_COLOR.join(",")},0.9)`;
  ctx.moveTo(r * 0.6, -r * 0.5);
  ctx.quadraticCurveTo(r * 1.3, -r * 0.5, r * 1.2, -r * 1.1);
  ctx.quadraticCurveTo(r * 0.85, -r * 0.75, r * 0.6, -r * 0.5);
  ctx.fill();
}

function drawDuplicate(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const r = pose.radius;
  const fill = telegraphFill(DUPLICATE_COLOR, pose.telegraphRatio, pose.clock);
  const split = Math.sin(pose.clock * 6) * 3;
  ctx.beginPath();
  ctx.fillStyle = `rgba(${DUPLICATE_COLOR.join(",")},0.35)`;
  ctx.arc(-r * 0.35 - split, r * 0.1, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = `rgba(${DUPLICATE_COLOR.join(",")},0.35)`;
  ctx.arc(r * 0.35 + split, r * 0.1, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = fill;
  ctx.arc(0, -r * 0.05, r * 0.65, 0, Math.PI * 2);
  ctx.fill();
}

function drawAnchor(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const r = pose.radius;
  const fill = telegraphFill(ANCHOR_COLOR, pose.telegraphRatio, pose.clock);
  ctx.beginPath();
  ctx.fillStyle = fill;
  ctx.rect(-r * 0.7, -r * 0.9, r * 1.4, r * 1.8);
  ctx.fill();

  const pulse = 0.4 + 0.3 * Math.sin(pose.clock * 3);
  ctx.beginPath();
  ctx.strokeStyle = `rgba(20,10,35,${0.5 + pulse * 0.4})`;
  ctx.lineWidth = 2.5;
  ctx.arc(0, -r * 0.1, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = "rgba(10,4,20,0.9)";
  ctx.arc(0, -r * 0.1, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

function drawSentinel(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const r = pose.radius;
  const fill = telegraphFill(SENTINEL_COLOR, pose.telegraphRatio, pose.clock);
  ctx.beginPath();
  ctx.fillStyle = fill;
  ctx.ellipse(0, 2, r * 0.6, r * 0.75, 0, 0, Math.PI * 2);
  ctx.fill();

  const angle = pose.orbitAngle ?? pose.clock * 3;
  for (let i = 0; i < 2; i++) {
    const a = angle + i * Math.PI;
    const bx = Math.cos(a) * r * 1.4;
    const by = Math.sin(a) * r * 1.4;
    ctx.beginPath();
    ctx.fillStyle = "rgba(220,245,255,0.9)";
    ctx.arc(bx, by, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.strokeStyle = "rgba(220,245,255,0.2)";
  ctx.lineWidth = 1.5;
  ctx.arc(0, 0, r * 1.4, 0, Math.PI * 2);
  ctx.stroke();
}

function drawReverberant(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const r = pose.radius;
  const fill = telegraphFill(REVERBERANT_COLOR, pose.telegraphRatio, pose.clock);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : r * 0.55;
    const x = Math.sin(a) * rad;
    const y = -Math.cos(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  const echoT = (Math.sin(pose.clock * 4) + 1) / 2;
  ctx.beginPath();
  ctx.strokeStyle = `rgba(${REVERBERANT_COLOR.join(",")},${0.4 * (1 - echoT)})`;
  ctx.lineWidth = 1.5;
  ctx.arc(0, 0, r * (1 + echoT * 0.6), 0, Math.PI * 2);
  ctx.stroke();
}

function drawBoss(ctx: CanvasRenderingContext2D, pose: EnemyPose): void {
  const r = pose.radius;
  const fill = pose.exposed
    ? lerpColor(BOSS_COLOR, [255, 220, 120], 0.6 + 0.4 * Math.sin(pose.clock * 10))
    : telegraphFill(BOSS_COLOR, pose.telegraphRatio, pose.clock);

  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.8, -r * 0.1);
  ctx.lineTo(r * 0.55, r);
  ctx.lineTo(-r * 0.55, r);
  ctx.lineTo(-r * 0.8, -r * 0.1);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 2;
  ctx.stroke();

  const coreGlow = pose.exposed ? 0.9 + 0.1 * Math.sin(pose.clock * 16) : pose.invulnerable ? 0.6 : 0.25;
  ctx.beginPath();
  ctx.fillStyle = pose.exposed ? `rgba(255,235,150,${coreGlow})` : `rgba(255,120,190,${coreGlow})`;
  ctx.arc(0, -r * 0.1, r * 0.28, 0, Math.PI * 2);
  ctx.fill();

  if (pose.stolenFamily) {
    const stolenColor = FAMILY_COLOR[pose.stolenFamily];
    ctx.beginPath();
    ctx.strokeStyle = `rgba(${stolenColor.join(",")},${0.55 + 0.35 * Math.sin(pose.clock * 8)})`;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.arc(0, -r * 0.1, r * 1.15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
