// Pure gameplay state and rules for STEAL. No DOM, no canvas: render.ts owns
// what the player sees, input.ts owns how input reaches here. This file only
// owns what is true, so a spec test can import `step` and assert a rule
// directly against state, without touching a browser.
//
// Core loop: FIGHT -> STEAL -> COUNTER -> BUILD -> ADAPT. Every non-boss
// enemy belongs to a power family (enemies.ts's ENEMY_FAMILY) and can only
// be finished off by a dash --- ordinary damage floors at 1hp, so stealing a
// power always requires actually landing the dash, and dash itself never
// out-damages using what you stole.
//
// Iteration 5: every power changes what an attack *does* (teleport, throw-
// and-return, summon a second attacker, set a trap, stand in a zone, replay
// an action) instead of a stat it modifies. Combination behaviour lives here
// as real mechanical branches, keyed off which family is main vs secondary
// (powers.ts's activeFusions/secondaryFamilies) --- never a flat multiplier.

import {
  createEnemy, createRun, ENEMY_FAMILY, stepEnemyAI,
  type EncounterSpec, type EnemyKind, type EnemyState,
} from "./enemies.ts";
import {
  activeFusions, alreadyHas, BASIC_ARC, BASIC_DAMAGE, BASIC_RANGE,
  BLACKHOLE_COLLAPSE_DAMAGE, BLACKHOLE_COOLDOWN, BLACKHOLE_MAX_RANGE, BLACKHOLE_PULL_DURATION,
  BLACKHOLE_PULL_STRENGTH, BLACKHOLE_RADIUS, BLACKHOLE_RECOLLAPSE_DELAY, BLACKHOLE_RESIDUAL_DURATION,
  BLACKHOLE_RESIDUAL_STRENGTH_MULT, BLACKHOLE_TRAVEL_SPEED,
  BLINK_ARC, BLINK_ARRIVAL_GAP, BLINK_DISTANCE, BLINK_RANGE, BLINK_STRIKE_DAMAGE, BLINK_STRIKE_RANGE,
  BOOMERANG_CATCH_RADIUS, BOOMERANG_DAMAGE, BOOMERANG_HIT_COOLDOWN, BOOMERANG_MAX_LIFETIME,
  BOOMERANG_RANGE, BOOMERANG_SPEED,
  CLONE_AGGRO_RANGE, CLONE_ATTACK_INTERVAL, CLONE_DAMAGE, CLONE_LIFETIME, CLONE_MOVE_SPEED, CLONE_RANGE,
  cooldownFor, decisionOptions, ECHO_DAMAGE_RATIO, ECHO_DELAY, emptyBuild,
  ORBIT_BLADE_COUNT, ORBIT_BLADE_HIT_RADIUS, ORBIT_DAMAGE, ORBIT_FLING_DURATION, ORBIT_HIT_COOLDOWN,
  ORBIT_PULSE_DAMAGE, ORBIT_PULSE_RADIUS, ORBIT_RADIUS, ORBIT_ROTATION_SPEED, ORBIT_TRAIL_DURATION,
  ORBIT_TRAIL_INTERVAL, ORBIT_TRAIL_RADIUS, ORBIT_TRAIL_TICK_DAMAGE, ORBIT_WIDEN_MULT,
  MAX_INFUSIONS, secondaryFamilies, type Build, type PowerFamily,
} from "./powers.ts";
import { makeRng, type Rng } from "./rng.ts";

export type { EnemyKind, EnemyState } from "./enemies.ts";
export type { Build, FusionId, PowerFamily } from "./powers.ts";

export interface Vec2 { x: number; y: number; }

export type ProjectileOwner = "enemy" | "player";
export type BoomerangPhase = "out" | "return";
export type PendingEchoKind = "melee" | "boomerangThrow" | "directHit" | "boltReplay";

export interface Projectile {
  id: number; pos: Vec2; vel: Vec2; owner: ProjectileOwner; damage: number;
  boomerang?: boolean; phase?: BoomerangPhase; traveled?: number; boomerangLifeLeft?: number;
  hitCooldowns?: Record<number, number>; bendToward?: number | null; flungGuard?: boolean;
}

export interface Hazard {
  pos: Vec2; radius: number; timeLeft: number; tickTimer: number; tickDamage: number;
}

export interface CloneState {
  id: number; owner: ProjectileOwner; pos: Vec2; facing: Vec2;
  attackTimer: number; lifeTimeLeft: number;
  usesBoomerang: boolean; hasOrbit: boolean; mirrorDelay: boolean;
  orbitAngle: number; orbitHitTimer: number;
}

export interface BlackHoleState {
  id: number; owner: ProjectileOwner; pos: Vec2; vel: Vec2; traveled: number; arrived: boolean;
  pullTimeLeft: number; collapsed: boolean;
  wantsRecollapse: boolean; recollapseTimeLeft: number | null;
  residualEligible: boolean; residualTimeLeft: number;
}

export interface PendingEcho {
  timer: number; kind: PendingEchoKind; pos: Vec2; direction: Vec2; damage: number;
  range?: number; arc?: number; targetId?: number; vel?: Vec2; owner?: ProjectileOwner;
}

export interface PlayerState {
  pos: Vec2; facing: Vec2; health: number; dashCooldown: number; dashTimeLeft: number; invulnerable: number;
  build: Build; attackCooldown: number; timeSinceHit: number;
  orbitAngle: number; orbitFlingTimeLeft: number; orbitTrailTimer: number;
}

export type Phase = "combat" | "decision" | "cleared" | "dead";

export interface Decision { family: PowerFamily; elite: boolean; replace: Build; infuse: Build; }
export interface Arena { width: number; height: number; }
export interface StolenCore { family: PowerFamily; pos: Vec2; }

export interface GameState {
  player: PlayerState; enemies: EnemyState[]; projectiles: Projectile[]; hazards: Hazard[];
  clones: CloneState[]; blackHoles: BlackHoleState[]; pendingEchoes: PendingEcho[];
  arena: Arena; phase: Phase; encounterIndex: number; encounters: EncounterSpec[]; decision: Decision | null;
  stolenCore: StolenCore | null; bossStoleAt70: boolean; bossStoleAt35: boolean; nextId: number;
  events: GameEvents;
}

export interface GameEvents {
  dashKill: Vec2 | null; dashInterrupt: Vec2 | null; evolved: boolean;
  bossExposed: boolean; playerHit: boolean; powerAcquired: PowerFamily | null;
  coreStolen: boolean; coreReclaimed: boolean;
}

export interface Input {
  up: boolean; down: boolean; left: boolean; right: boolean; dashPressed: boolean; attackPressed: boolean;
  attackTarget: Vec2; decisionClick: Vec2 | null;
}

export const PLAYER_RADIUS = 16;
export const ENEMY_RADIUS: Record<EnemyKind, number> = {
  phantom: 18, thrower: 20, duplicate: 22, anchor: 28, sentinel: 26, reverberant: 18, boss: 42,
};
export const PROJECTILE_RADIUS = 6;
export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_SPEED = 260;
export const DASH_SPEED = 1400;
export const DASH_DURATION = 0.11;
export const DASH_COOLDOWN = 0.48;
export const HIT_INVULNERABILITY = 0.5;
export const STOLEN_CORE_RADIUS = 18;
const MAX_STEP = 1 / 20;
const HAZARD_TICK_INTERVAL = 0.15;
const BOSS_STOLEN_ACTION_INTERVAL = 2.8;
const BOSS_STOLEN_ANGLE_STEP = 2.399963;
const BOSS_STOLEN_BOLT_SPEED = 300;
const BOSS_STOLEN_BOLT_DAMAGE = 12;

function length(v: Vec2): number { return Math.hypot(v.x, v.y); }
function normalize(v: Vec2): Vec2 { const len = length(v); return len > 0 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 }; }
function distance(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }

function damageEnemy(enemy: EnemyState, amount: number): void {
  enemy.hp -= amount;
  if (!enemy.exposed && enemy.hp <= 0) enemy.hp = 1;
}

function clampToArena(pos: Vec2, radius: number, width: number, height: number): Vec2 {
  return { x: Math.min(Math.max(pos.x, radius), width - radius), y: Math.min(Math.max(pos.y, radius), height - radius) };
}

function pullToward(pos: Vec2, target: Vec2, strength: number, dt: number, radius: number, arena: Arena): Vec2 {
  const dir = normalize({ x: target.x - pos.x, y: target.y - pos.y });
  const moved = { x: pos.x + dir.x * strength * dt, y: pos.y + dir.y * strength * dt };
  return clampToArena(moved, radius, arena.width, arena.height);
}

// One-shot nudge (Blink+Black Hole's landing tug) --- distinct from
// pullToward's continuous per-frame pull used by an active Black Hole field.
function pullEnemyToward(draft: GameState, enemy: EnemyState, target: Vec2, strengthMult: number): void {
  const dir = normalize({ x: target.x - enemy.pos.x, y: target.y - enemy.pos.y });
  const dist = BLACKHOLE_PULL_STRENGTH * 0.12 * strengthMult;
  enemy.pos = clampToArena({ x: enemy.pos.x + dir.x * dist, y: enemy.pos.y + dir.y * dist }, ENEMY_RADIUS[enemy.kind], draft.arena.width, draft.arena.height);
}

function moveDirection(input: Input): Vec2 {
  const x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const y = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  return normalize({ x, y });
}

function noEvents(): GameEvents {
  return { dashKill: null, dashInterrupt: null, evolved: false, bossExposed: false, playerHit: false, powerAcquired: null, coreStolen: false, coreReclaimed: false };
}

function anyEvent(e: GameEvents): boolean {
  return !!(e.dashKill || e.dashInterrupt || e.evolved || e.bossExposed || e.playerHit || e.powerAcquired || e.coreStolen || e.coreReclaimed);
}

function spawnEncounter(encounters: EncounterSpec[], index: number, arena: Arena, nextId: number): { enemies: EnemyState[]; nextId: number } {
  const spec = encounters[index];
  const enemies = spec.spawns.map((s) => createEnemy(nextId++, s.kind, { x: arena.width * s.xf, y: arena.height * s.yf }, s.elite ?? false));
  return { enemies, nextId };
}

export function createInitialState(width: number, height: number, seed: number = Date.now()): GameState {
  const arena = { width, height };
  const { encounters } = createRun(makeRng(seed) as Rng);
  const { enemies, nextId } = spawnEncounter(encounters, 0, arena, 1);
  return {
    player: {
      pos: { x: width / 2, y: height * 0.78 }, facing: { x: 0, y: -1 }, health: PLAYER_MAX_HEALTH,
      dashCooldown: 0, dashTimeLeft: 0, invulnerable: 0, build: emptyBuild(), attackCooldown: 0,
      timeSinceHit: 0, orbitAngle: 0, orbitFlingTimeLeft: 0, orbitTrailTimer: 0,
    },
    enemies, projectiles: [], hazards: [], clones: [], blackHoles: [], pendingEchoes: [],
    arena, phase: "combat", encounterIndex: 0, encounters,
    decision: null, stolenCore: null, bossStoleAt70: false, bossStoleAt35: false, nextId, events: noEvents(),
  };
}

export function resizeArena(state: GameState, width: number, height: number): GameState {
  return { ...state, arena: { width, height }, player: { ...state.player, pos: clampToArena(state.player.pos, PLAYER_RADIUS, width, height) } };
}

export function step(state: GameState, input: Input, dt: number): GameState {
  if (state.phase === "dead" || state.phase === "cleared") {
    return anyEvent(state.events) ? { ...state, events: noEvents() } : state;
  }
  const clamped = Math.min(dt, MAX_STEP);
  if (state.phase === "decision") return resolveDecision(state, input);
  const draft: GameState = {
    ...state, player: { ...state.player },
    enemies: state.enemies.map((e) => ({ ...e, pos: { ...e.pos }, facing: { ...e.facing } })),
    projectiles: state.projectiles.map((p) => ({ ...p, pos: { ...p.pos }, vel: { ...p.vel }, hitCooldowns: p.hitCooldowns ? { ...p.hitCooldowns } : undefined })),
    hazards: state.hazards.map((h) => ({ ...h, pos: { ...h.pos } })),
    clones: state.clones.map((c) => ({ ...c, pos: { ...c.pos }, facing: { ...c.facing } })),
    blackHoles: state.blackHoles.map((b) => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } })),
    pendingEchoes: state.pendingEchoes.map((pe) => ({ ...pe, pos: { ...pe.pos }, direction: { ...pe.direction } })),
    events: noEvents(),
  };
  stepPlayer(draft, input, clamped);
  stepOrbitEmitters(draft, clamped);
  stepEnemies(draft, clamped);
  stepClones(draft, clamped);
  stepBlackHoles(draft, clamped);
  stepPendingEchoes(draft, clamped);
  stepHazards(draft, clamped);
  stepProjectiles(draft, clamped);
  resolveDash(draft);
  resolveHits(draft);
  resolveDeaths(draft);
  resolveEncounterProgress(draft);
  if (draft.player.health <= 0) draft.phase = "dead";
  return draft;
}

function resolveDecision(state: GameState, input: Input): GameState {
  const idle: GameState = { ...state, events: noEvents() };
  if (!input.decisionClick || !state.decision) return idle;
  const rects = decisionCardRects(state.arena);
  const { x, y } = input.decisionClick;
  const hitLeft = x >= rects.left.x && x <= rects.left.x + rects.width && y >= rects.left.y && y <= rects.left.y + rects.height;
  const hitRight = x >= rects.right.x && x <= rects.right.x + rects.width && y >= rects.right.y && y <= rects.right.y + rects.height;
  if (!hitLeft && !hitRight) return idle;
  const decision = state.decision;
  const build = hitLeft ? decision.replace : decision.infuse;
  const events = noEvents();
  if (hitLeft) events.powerAcquired = decision.family;
  else events.evolved = true;
  return { ...state, player: { ...state.player, build, attackCooldown: 0 }, decision: null, phase: "combat", events };
}

export interface DecisionCardRects {
  left: Vec2 & { width: number; height: number }; right: Vec2 & { width: number; height: number };
  width: number; height: number;
}

export function decisionCardRects(arena: Arena): DecisionCardRects {
  const width = Math.min(180, arena.width * 0.22);
  const height = width;
  const gap = width * 0.6;
  const cy = arena.height / 2 - height / 2;
  const leftX = arena.width / 2 - gap / 2 - width;
  const rightX = arena.width / 2 + gap / 2;
  return { left: { x: leftX, y: cy, width, height }, right: { x: rightX, y: cy, width, height }, width, height };
}

function stepPlayer(draft: GameState, input: Input, dt: number): void {
  const player = draft.player;
  player.dashCooldown = Math.max(0, player.dashCooldown - dt);
  player.attackCooldown = Math.max(0, player.attackCooldown - dt);
  player.invulnerable = Math.max(0, player.invulnerable - dt);
  player.timeSinceHit += dt;

  const moveDir = moveDirection(input);
  if (moveDir.x !== 0 || moveDir.y !== 0) player.facing = moveDir;

  if (input.dashPressed && player.dashCooldown === 0 && player.dashTimeLeft === 0) {
    player.dashTimeLeft = DASH_DURATION;
    player.dashCooldown = DASH_COOLDOWN;
    player.invulnerable = Math.max(player.invulnerable, DASH_DURATION);
  }

  let velocity: Vec2;
  if (player.dashTimeLeft > 0) {
    velocity = { x: player.facing.x * DASH_SPEED, y: player.facing.y * DASH_SPEED };
    player.dashTimeLeft = Math.max(0, player.dashTimeLeft - dt);
  } else {
    velocity = { x: moveDir.x * PLAYER_SPEED, y: moveDir.y * PLAYER_SPEED };
  }
  player.pos = clampToArena({ x: player.pos.x + velocity.x * dt, y: player.pos.y + velocity.y * dt }, PLAYER_RADIUS, draft.arena.width, draft.arena.height);

  if (input.attackPressed && player.attackCooldown === 0) {
    performAttack(draft, input.attackTarget);
    player.attackCooldown = cooldownFor(player.build);
  }
}

// Generic area check: arc >= full circle degenerates to a plain radius test,
// so this covers both aimed cones (basic strike, Echo replay) and radial
// bursts (Blink's landing strike, Orbit's pulse) with one function.
function coneHit(draft: GameState, origin: Vec2, direction: Vec2, range: number, arc: number, onHit: (enemy: EnemyState) => void): void {
  const baseAngle = Math.atan2(direction.y, direction.x);
  for (const enemy of draft.enemies) {
    if (!enemy.alive || enemy.invulnerable) continue;
    const toEnemy = { x: enemy.pos.x - origin.x, y: enemy.pos.y - origin.y };
    const dist = length(toEnemy);
    if (dist > range + ENEMY_RADIUS[enemy.kind]) continue;
    if (arc >= Math.PI * 2) { onHit(enemy); continue; }
    const angleTo = Math.atan2(toEnemy.y, toEnemy.x);
    let delta = Math.abs(angleTo - baseAngle);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    if (delta <= arc / 2) onHit(enemy);
  }
}

function findBlinkTarget(draft: GameState, direction: Vec2): EnemyState | null {
  const baseAngle = Math.atan2(direction.y, direction.x);
  let best: EnemyState | null = null;
  let bestDist = Infinity;
  for (const enemy of draft.enemies) {
    if (!enemy.alive || enemy.invulnerable) continue;
    const toEnemy = { x: enemy.pos.x - draft.player.pos.x, y: enemy.pos.y - draft.player.pos.y };
    const dist = length(toEnemy);
    if (dist > BLINK_RANGE + ENEMY_RADIUS[enemy.kind]) continue;
    const angleTo = Math.atan2(toEnemy.y, toEnemy.x);
    let delta = Math.abs(angleTo - baseAngle);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    if (delta > BLINK_ARC / 2) continue;
    if (dist < bestDist) { bestDist = dist; best = enemy; }
  }
  return best;
}

function spawnBoomerang(
  draft: GameState, pos: Vec2, direction: Vec2, damage: number, owner: ProjectileOwner,
  opts: { bendToward?: number | null; flungGuard?: boolean } = {},
): void {
  draft.projectiles.push({
    id: draft.nextId++, pos: { ...pos },
    vel: { x: direction.x * BOOMERANG_SPEED, y: direction.y * BOOMERANG_SPEED },
    owner, damage, boomerang: true, phase: "out", traveled: 0, boomerangLifeLeft: BOOMERANG_MAX_LIFETIME,
    hitCooldowns: {}, bendToward: opts.bendToward ?? null, flungGuard: opts.flungGuard ?? false,
  });
}

function spawnClone(
  draft: GameState, pos: Vec2, owner: ProjectileOwner,
  opts: { usesBoomerang: boolean; hasOrbit: boolean; mirrorDelay: boolean },
): CloneState {
  const clone: CloneState = {
    id: draft.nextId++, owner, pos: { ...pos }, facing: { x: 0, y: 1 },
    attackTimer: CLONE_ATTACK_INTERVAL * 0.5, lifeTimeLeft: CLONE_LIFETIME,
    usesBoomerang: opts.usesBoomerang, hasOrbit: opts.hasOrbit, mirrorDelay: opts.mirrorDelay,
    orbitAngle: 0, orbitHitTimer: 0,
  };
  draft.clones.push(clone);
  return clone;
}

function spawnBlackHole(
  draft: GameState, pos: Vec2, direction: Vec2,
  opts: { instant: boolean; elite: boolean; recollapse: boolean; owner?: ProjectileOwner },
): BlackHoleState {
  const bh: BlackHoleState = {
    id: draft.nextId++, owner: opts.owner ?? "player", pos: { ...pos },
    vel: opts.instant ? { x: 0, y: 0 } : { x: direction.x * BLACKHOLE_TRAVEL_SPEED, y: direction.y * BLACKHOLE_TRAVEL_SPEED },
    traveled: 0, arrived: opts.instant, pullTimeLeft: opts.instant ? BLACKHOLE_PULL_DURATION : 0,
    collapsed: false, wantsRecollapse: opts.recollapse, recollapseTimeLeft: null,
    residualEligible: opts.elite, residualTimeLeft: 0,
  };
  draft.blackHoles.push(bh);
  return bh;
}

function spawnHazard(draft: GameState, pos: Vec2, radius: number, duration: number, tickDamage: number): void {
  draft.hazards.push({ pos, radius, timeLeft: duration, tickTimer: 0, tickDamage });
}

// --- Blink: teleport-strike ------------------------------------------------

function performBlink(draft: GameState, direction: Vec2): void {
  const player = draft.player;
  const build = player.build;
  const secondaryList = secondaryFamilies(build);
  const fusions = activeFusions(build);
  const prevPos = { ...player.pos };
  const target = findBlinkTarget(draft, direction);

  let destination: Vec2;
  if (target) {
    const toTarget = normalize({ x: target.pos.x - player.pos.x, y: target.pos.y - player.pos.y });
    const gap = ENEMY_RADIUS[target.kind] + BLINK_ARRIVAL_GAP;
    destination = { x: target.pos.x - toTarget.x * gap, y: target.pos.y - toTarget.y * gap };
  } else {
    destination = { x: player.pos.x + direction.x * BLINK_DISTANCE, y: player.pos.y + direction.y * BLINK_DISTANCE };
  }
  player.pos = clampToArena(destination, PLAYER_RADIUS, draft.arena.width, draft.arena.height);

  const damage = build.mutatedMain ? BLINK_STRIKE_DAMAGE * 1.5 : BLINK_STRIKE_DAMAGE;
  if (target) {
    coneHit(draft, player.pos, direction, BLINK_STRIKE_RANGE, Math.PI * 2, (enemy) => damageEnemy(enemy, damage));
  }

  if (fusions.includes("doppelStrike")) {
    spawnClone(draft, prevPos, "player", { usesBoomerang: false, hasOrbit: false, mirrorDelay: false });
  }
  if (fusions.includes("afterimage")) {
    draft.pendingEchoes.push({
      timer: ECHO_DELAY, kind: "melee", pos: prevPos, direction,
      damage: damage * ECHO_DAMAGE_RATIO, range: BLINK_STRIKE_RANGE, arc: Math.PI * 2,
    });
  }
  if (fusions.includes("relayThrow")) {
    const back = normalize({ x: prevPos.x - player.pos.x, y: prevPos.y - player.pos.y });
    spawnBoomerang(draft, player.pos, back, BOOMERANG_DAMAGE, "player");
  }
  if (fusions.includes("piercingGuard")) {
    coneHit(draft, player.pos, direction, ORBIT_RADIUS * ORBIT_WIDEN_MULT, Math.PI * 2, (enemy) => damageEnemy(enemy, ORBIT_PULSE_DAMAGE));
    player.orbitFlingTimeLeft = ORBIT_FLING_DURATION;
  }
  if (secondaryList.includes("blackhole")) {
    for (const enemy of draft.enemies) {
      if (!enemy.alive || enemy.invulnerable) continue;
      if (distance(enemy.pos, player.pos) > BLINK_STRIKE_RANGE * 1.8) continue;
      pullEnemyToward(draft, enemy, player.pos, 1);
    }
  }
}

// --- Boomerang: out-and-back thrown weapon ---------------------------------

function performBoomerang(draft: GameState, direction: Vec2): void {
  const player = draft.player;
  const build = player.build;
  const fusions = activeFusions(build);
  const damage = build.mutatedMain ? BOOMERANG_DAMAGE * 1.4 : BOOMERANG_DAMAGE;

  let bendToward: number | null = null;
  if (fusions.includes("gravityThrow")) {
    const bh = spawnBlackHole(draft, player.pos, direction, { instant: false, elite: false, recollapse: false });
    bendToward = bh.id;
  }
  const flungGuard = fusions.includes("flungGuard");
  spawnBoomerang(draft, player.pos, direction, damage, "player", { bendToward, flungGuard });
}

// --- Clone: a temporary second attacker ------------------------------------

function performClone(draft: GameState, direction: Vec2): void {
  const player = draft.player;
  const build = player.build;
  const secondaryList = secondaryFamilies(build);
  const fusions = activeFusions(build);

  spawnClone(draft, player.pos, "player", {
    usesBoomerang: secondaryList.includes("boomerang"),
    hasOrbit: secondaryList.includes("orbit"),
    mirrorDelay: fusions.includes("mirrorDelay"),
  });

  if (fusions.includes("twinWells")) {
    spawnBlackHole(draft, player.pos, direction, { instant: true, elite: build.mutatedMain, recollapse: false });
  }
}

// --- Black Hole: delayed area-collapse trap --------------------------------

function performBlackHole(draft: GameState, direction: Vec2): void {
  const build = draft.player.build;
  const fusions = activeFusions(build);
  spawnBlackHole(draft, draft.player.pos, direction, {
    instant: false, elite: build.mutatedMain, recollapse: fusions.includes("recollapse"),
  });
}

// --- Orbit: a continuous melee-range zone ----------------------------------

function performOrbitPulse(draft: GameState, direction: Vec2): void {
  const player = draft.player;
  const build = player.build;
  const secondaryList = secondaryFamilies(build);
  const damage = build.mutatedMain ? ORBIT_PULSE_DAMAGE * 1.5 : ORBIT_PULSE_DAMAGE;
  coneHit(draft, player.pos, direction, ORBIT_PULSE_RADIUS, Math.PI * 2, (enemy) => damageEnemy(enemy, damage));
  if (secondaryList.includes("blackhole")) {
    spawnBlackHole(draft, player.pos, direction, { instant: true, elite: false, recollapse: false });
  }
}

// --- Echo: a delayed repeat of your own last attack ------------------------

function performEchoStrike(draft: GameState, direction: Vec2): void {
  const player = draft.player;
  const build = player.build;
  const secondaryList = secondaryFamilies(build);
  const damage = build.mutatedMain ? BASIC_DAMAGE * 1.5 : BASIC_DAMAGE;

  if (secondaryList.includes("boomerang")) {
    spawnBoomerang(draft, player.pos, direction, damage, "player");
    draft.pendingEchoes.push({
      timer: ECHO_DELAY, kind: "boomerangThrow", pos: { ...player.pos }, direction,
      damage: damage * ECHO_DAMAGE_RATIO,
    });
    return;
  }

  coneHit(draft, player.pos, direction, BASIC_RANGE, BASIC_ARC, (enemy) => damageEnemy(enemy, damage));
  draft.pendingEchoes.push({
    timer: ECHO_DELAY, kind: "melee", pos: { ...player.pos }, direction,
    damage: damage * ECHO_DAMAGE_RATIO, range: BASIC_RANGE, arc: BASIC_ARC,
  });
}

function performAttack(draft: GameState, aimAt: Vec2): void {
  const player = draft.player;
  const build = player.build;
  const aim = normalize({ x: aimAt.x - player.pos.x, y: aimAt.y - player.pos.y });
  const direction = aim.x === 0 && aim.y === 0 ? player.facing : aim;

  switch (build.main) {
    case "blink":
      performBlink(draft, direction);
      return;
    case "boomerang":
      performBoomerang(draft, direction);
      return;
    case "clone":
      performClone(draft, direction);
      return;
    case "blackhole":
      performBlackHole(draft, direction);
      return;
    case "orbit":
      performOrbitPulse(draft, direction);
      return;
    case "echo":
      performEchoStrike(draft, direction);
      return;
    default:
      coneHit(draft, player.pos, direction, BASIC_RANGE, BASIC_ARC, (enemy) => damageEnemy(enemy, BASIC_DAMAGE));
  }
}

// --- Continuous per-frame systems ------------------------------------------

function stepOrbitEmitters(draft: GameState, dt: number): void {
  const player = draft.player;
  player.orbitFlingTimeLeft = Math.max(0, player.orbitFlingTimeLeft - dt);
  const build = player.build;
  const secondaryList = secondaryFamilies(build);
  const active = build.main === "orbit" || player.orbitFlingTimeLeft > 0;
  if (!active) return;

  const widened = build.main === "orbit" && secondaryList.includes("blackhole") && draft.blackHoles.some((b) => b.owner === "player" && !b.collapsed);
  const rotSpeed = widened ? ORBIT_ROTATION_SPEED / ORBIT_WIDEN_MULT : ORBIT_ROTATION_SPEED;
  const radius = widened ? ORBIT_RADIUS * ORBIT_WIDEN_MULT : ORBIT_RADIUS;
  player.orbitAngle = (player.orbitAngle + rotSpeed * dt) % (Math.PI * 2);

  const echoTick = build.main === "orbit" && secondaryList.includes("echo");
  const bladePositions: Vec2[] = [];
  for (let i = 0; i < ORBIT_BLADE_COUNT; i++) {
    const angle = player.orbitAngle + (i * Math.PI * 2) / ORBIT_BLADE_COUNT;
    bladePositions.push({ x: player.pos.x + Math.cos(angle) * radius, y: player.pos.y + Math.sin(angle) * radius });
  }
  for (const enemy of draft.enemies) {
    if (!enemy.alive || enemy.invulnerable || enemy.orbitCooldown > 0) continue;
    for (const bladePos of bladePositions) {
      if (distance(enemy.pos, bladePos) > ORBIT_BLADE_HIT_RADIUS + ENEMY_RADIUS[enemy.kind]) continue;
      damageEnemy(enemy, ORBIT_DAMAGE);
      enemy.orbitCooldown = ORBIT_HIT_COOLDOWN;
      if (echoTick) {
        draft.pendingEchoes.push({
          timer: ECHO_DELAY, kind: "directHit", pos: { ...enemy.pos }, direction: { x: 0, y: 0 },
          damage: ORBIT_DAMAGE * ECHO_DAMAGE_RATIO, targetId: enemy.id,
        });
      }
      break;
    }
  }

  if (build.mutatedMain && build.main === "orbit") {
    player.orbitTrailTimer -= dt;
    if (player.orbitTrailTimer <= 0) {
      player.orbitTrailTimer = ORBIT_TRAIL_INTERVAL;
      for (const bladePos of bladePositions) {
        spawnHazard(draft, bladePos, ORBIT_TRAIL_RADIUS, ORBIT_TRAIL_DURATION, ORBIT_TRAIL_TICK_DAMAGE);
      }
    }
  }
}

function stepClones(draft: GameState, dt: number): void {
  for (const clone of draft.clones) {
    clone.lifeTimeLeft -= dt;
    clone.attackTimer -= dt;
    clone.orbitHitTimer -= dt;

    if (clone.owner === "player") {
      let target: EnemyState | null = null;
      let bestDist = Infinity;
      for (const enemy of draft.enemies) {
        if (!enemy.alive || enemy.invulnerable) continue;
        const d = distance(clone.pos, enemy.pos);
        if (d <= CLONE_AGGRO_RANGE && d < bestDist) { target = enemy; bestDist = d; }
      }
      if (target) {
        clone.facing = normalize({ x: target.pos.x - clone.pos.x, y: target.pos.y - clone.pos.y });
        if (bestDist > CLONE_RANGE * 0.8) {
          clone.pos = clampToArena(
            { x: clone.pos.x + clone.facing.x * CLONE_MOVE_SPEED * dt, y: clone.pos.y + clone.facing.y * CLONE_MOVE_SPEED * dt },
            18, draft.arena.width, draft.arena.height,
          );
        }
        if (clone.attackTimer <= 0 && bestDist <= CLONE_RANGE) {
          clone.attackTimer = CLONE_ATTACK_INTERVAL;
          if (clone.usesBoomerang) {
            spawnBoomerang(draft, clone.pos, clone.facing, CLONE_DAMAGE * 0.8, "player");
          } else {
            damageEnemy(target, CLONE_DAMAGE);
            if (clone.mirrorDelay) {
              draft.pendingEchoes.push({
                timer: ECHO_DELAY, kind: "directHit", pos: { ...target.pos }, direction: clone.facing,
                damage: CLONE_DAMAGE * ECHO_DAMAGE_RATIO, targetId: target.id,
              });
            }
          }
        }
      }
      if (clone.hasOrbit && clone.orbitHitTimer <= 0) {
        clone.orbitAngle = (clone.orbitAngle + ORBIT_ROTATION_SPEED * dt) % (Math.PI * 2);
        let hit = false;
        for (const enemy of draft.enemies) {
          if (!enemy.alive || enemy.invulnerable) continue;
          if (distance(enemy.pos, clone.pos) <= ORBIT_RADIUS * 0.6 + ENEMY_RADIUS[enemy.kind]) {
            damageEnemy(enemy, ORBIT_DAMAGE);
            hit = true;
          }
        }
        if (hit) clone.orbitHitTimer = ORBIT_HIT_COOLDOWN;
      }
    } else {
      const d = distance(clone.pos, draft.player.pos);
      clone.facing = normalize({ x: draft.player.pos.x - clone.pos.x, y: draft.player.pos.y - clone.pos.y });
      if (d > CLONE_RANGE * 0.8) {
        clone.pos = clampToArena(
          { x: clone.pos.x + clone.facing.x * CLONE_MOVE_SPEED * dt, y: clone.pos.y + clone.facing.y * CLONE_MOVE_SPEED * dt },
          18, draft.arena.width, draft.arena.height,
        );
      }
      if (clone.attackTimer <= 0 && d <= CLONE_RANGE) {
        clone.attackTimer = CLONE_ATTACK_INTERVAL;
        applyDamageToPlayer(draft, CLONE_DAMAGE);
      }
    }
  }
  draft.clones = draft.clones.filter((c) => c.lifeTimeLeft > 0);
}

function collapseBlackHole(draft: GameState, bh: BlackHoleState): void {
  bh.collapsed = true;
  if (bh.owner === "player") {
    for (const enemy of draft.enemies) {
      if (!enemy.alive || enemy.invulnerable) continue;
      if (distance(enemy.pos, bh.pos) > BLACKHOLE_RADIUS + ENEMY_RADIUS[enemy.kind]) continue;
      damageEnemy(enemy, BLACKHOLE_COLLAPSE_DAMAGE);
    }
  } else if (distance(draft.player.pos, bh.pos) <= BLACKHOLE_RADIUS + PLAYER_RADIUS) {
    applyDamageToPlayer(draft, BLACKHOLE_COLLAPSE_DAMAGE);
  }
  if (bh.wantsRecollapse && bh.recollapseTimeLeft === null) {
    bh.recollapseTimeLeft = BLACKHOLE_RECOLLAPSE_DELAY;
  } else if (bh.residualEligible) {
    bh.residualTimeLeft = BLACKHOLE_RESIDUAL_DURATION;
  }
}

function stepBlackHoles(draft: GameState, dt: number): void {
  for (const bh of draft.blackHoles) {
    if (!bh.arrived) {
      bh.pos = { x: bh.pos.x + bh.vel.x * dt, y: bh.pos.y + bh.vel.y * dt };
      bh.traveled += length(bh.vel) * dt;
      let hitSomething = false;
      if (bh.owner === "player") {
        for (const enemy of draft.enemies) {
          if (!enemy.alive || enemy.invulnerable) continue;
          if (distance(bh.pos, enemy.pos) <= ENEMY_RADIUS[enemy.kind] + 8) { hitSomething = true; break; }
        }
      } else if (distance(bh.pos, draft.player.pos) <= PLAYER_RADIUS + 8) {
        hitSomething = true;
      }
      if (hitSomething || bh.traveled >= BLACKHOLE_MAX_RANGE) {
        bh.arrived = true;
        bh.pullTimeLeft = BLACKHOLE_PULL_DURATION;
      }
      continue;
    }

    if (bh.pullTimeLeft > 0) {
      bh.pullTimeLeft -= dt;
      if (bh.owner === "player") {
        for (const enemy of draft.enemies) {
          if (!enemy.alive || enemy.invulnerable) continue;
          if (distance(enemy.pos, bh.pos) > BLACKHOLE_RADIUS + ENEMY_RADIUS[enemy.kind]) continue;
          enemy.pos = pullToward(enemy.pos, bh.pos, BLACKHOLE_PULL_STRENGTH, dt, ENEMY_RADIUS[enemy.kind], draft.arena);
        }
      } else if (distance(draft.player.pos, bh.pos) <= BLACKHOLE_RADIUS + PLAYER_RADIUS) {
        draft.player.pos = pullToward(draft.player.pos, bh.pos, BLACKHOLE_PULL_STRENGTH, dt, PLAYER_RADIUS, draft.arena);
      }
      if (bh.pullTimeLeft <= 0) collapseBlackHole(draft, bh);
      continue;
    }

    if (bh.residualTimeLeft > 0) {
      bh.residualTimeLeft -= dt;
      const strength = BLACKHOLE_PULL_STRENGTH * BLACKHOLE_RESIDUAL_STRENGTH_MULT;
      if (bh.owner === "player") {
        for (const enemy of draft.enemies) {
          if (!enemy.alive || enemy.invulnerable) continue;
          if (distance(enemy.pos, bh.pos) > BLACKHOLE_RADIUS + ENEMY_RADIUS[enemy.kind]) continue;
          enemy.pos = pullToward(enemy.pos, bh.pos, strength, dt, ENEMY_RADIUS[enemy.kind], draft.arena);
        }
      } else if (distance(draft.player.pos, bh.pos) <= BLACKHOLE_RADIUS + PLAYER_RADIUS) {
        draft.player.pos = pullToward(draft.player.pos, bh.pos, strength, dt, PLAYER_RADIUS, draft.arena);
      }
    }

    if (bh.wantsRecollapse && bh.recollapseTimeLeft !== null) {
      bh.recollapseTimeLeft -= dt;
      if (bh.recollapseTimeLeft <= 0) {
        bh.wantsRecollapse = false;
        bh.collapsed = false;
        bh.pullTimeLeft = BLACKHOLE_PULL_DURATION;
      }
    }
  }

  draft.blackHoles = draft.blackHoles.filter((bh) => {
    if (!bh.collapsed) return true;
    if (bh.wantsRecollapse) return true;
    return bh.residualTimeLeft > 0;
  });
}

function stepPendingEchoes(draft: GameState, dt: number): void {
  for (const pe of draft.pendingEchoes) pe.timer -= dt;
  const ready = draft.pendingEchoes.filter((pe) => pe.timer <= 0);
  draft.pendingEchoes = draft.pendingEchoes.filter((pe) => pe.timer > 0);
  for (const pe of ready) {
    if (pe.kind === "melee") {
      coneHit(draft, pe.pos, pe.direction, pe.range ?? BASIC_RANGE, pe.arc ?? BASIC_ARC, (enemy) => damageEnemy(enemy, pe.damage));
    } else if (pe.kind === "boomerangThrow") {
      spawnBoomerang(draft, pe.pos, pe.direction, pe.damage, "player");
    } else if (pe.kind === "directHit") {
      const enemy = draft.enemies.find((e) => e.id === pe.targetId && e.alive);
      if (enemy) damageEnemy(enemy, pe.damage);
    } else if (pe.kind === "boltReplay") {
      draft.projectiles.push({ id: draft.nextId++, pos: { ...pe.pos }, vel: pe.vel ?? { x: 0, y: 0 }, owner: pe.owner ?? "enemy", damage: pe.damage });
    }
  }
}

function stepHazards(draft: GameState, dt: number): void {
  for (const hz of draft.hazards) {
    hz.timeLeft -= dt;
    hz.tickTimer -= dt;
    if (hz.tickTimer <= 0) {
      hz.tickTimer = HAZARD_TICK_INTERVAL;
      for (const enemy of draft.enemies) {
        if (!enemy.alive || enemy.invulnerable) continue;
        if (distance(enemy.pos, hz.pos) > hz.radius + ENEMY_RADIUS[enemy.kind]) continue;
        damageEnemy(enemy, hz.tickDamage);
      }
    }
  }
  draft.hazards = draft.hazards.filter((h) => h.timeLeft > 0);
}

function stepProjectiles(draft: GameState, dt: number): void {
  const margin = PROJECTILE_RADIUS * 4;
  const survivors: Projectile[] = [];

  for (const p of draft.projectiles) {
    if (p.hitCooldowns) {
      for (const key of Object.keys(p.hitCooldowns)) p.hitCooldowns[Number(key)] = Math.max(0, p.hitCooldowns[Number(key)] - dt);
    }

    if (p.boomerang) {
      p.boomerangLifeLeft = (p.boomerangLifeLeft ?? BOOMERANG_MAX_LIFETIME) - dt;
      if (p.boomerangLifeLeft <= 0) continue;

      if (p.phase === "out") {
        p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
        p.traveled = (p.traveled ?? 0) + length(p.vel) * dt;
        if (p.traveled >= BOOMERANG_RANGE) {
          p.phase = "return";
          if (p.owner === "enemy") p.vel = { x: -p.vel.x, y: -p.vel.y };
        }
      } else if (p.owner === "player") {
        if (p.bendToward !== null && p.bendToward !== undefined) {
          const bh = draft.blackHoles.find((b) => b.id === p.bendToward && !b.collapsed);
          if (bh) {
            const towardHole = normalize({ x: bh.pos.x - p.pos.x, y: bh.pos.y - p.pos.y });
            const towardPlayer = normalize({ x: draft.player.pos.x - p.pos.x, y: draft.player.pos.y - p.pos.y });
            const blended = normalize({ x: towardHole.x + towardPlayer.x, y: towardHole.y + towardPlayer.y });
            p.vel = { x: blended.x * BOOMERANG_SPEED, y: blended.y * BOOMERANG_SPEED };
          } else {
            const dir = normalize({ x: draft.player.pos.x - p.pos.x, y: draft.player.pos.y - p.pos.y });
            p.vel = { x: dir.x * BOOMERANG_SPEED, y: dir.y * BOOMERANG_SPEED };
          }
        } else {
          const dir = normalize({ x: draft.player.pos.x - p.pos.x, y: draft.player.pos.y - p.pos.y });
          p.vel = { x: dir.x * BOOMERANG_SPEED, y: dir.y * BOOMERANG_SPEED };
        }
        p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
        if (distance(p.pos, draft.player.pos) <= BOOMERANG_CATCH_RADIUS) {
          if (p.flungGuard) draft.player.orbitFlingTimeLeft = ORBIT_FLING_DURATION;
          continue;
        }
      } else {
        p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
      }
    } else {
      p.pos = { x: p.pos.x + p.vel.x * dt, y: p.pos.y + p.vel.y * dt };
    }

    if (p.pos.x > -margin && p.pos.x < draft.arena.width + margin && p.pos.y > -margin && p.pos.y < draft.arena.height + margin) {
      survivors.push(p);
    }
  }

  draft.projectiles = survivors;
}

function resolveDash(draft: GameState): void {
  const player = draft.player;
  if (player.dashTimeLeft <= 0) return;
  for (const enemy of draft.enemies) {
    if (!enemy.alive) continue;
    if (distance(player.pos, enemy.pos) > PLAYER_RADIUS + ENEMY_RADIUS[enemy.kind]) continue;
    if (enemy.dashResistant) continue;
    if (enemy.kind !== "boss" && enemy.hp > 1) {
      enemy.phase = 0; enemy.timer = Math.max(enemy.timer, 0.2);
      draft.events.dashInterrupt = { ...enemy.pos };
      continue;
    }
    enemy.alive = false;
    draft.events.dashKill = { ...enemy.pos };
    stealPower(draft, enemy);
  }
  if (draft.stolenCore && distance(player.pos, draft.stolenCore.pos) <= PLAYER_RADIUS + STOLEN_CORE_RADIUS) reclaimCore(draft);
}

function stealPower(draft: GameState, enemy: EnemyState): void {
  const family = ENEMY_FAMILY[enemy.kind];
  if (!family) return;
  const player = draft.player;
  if (!player.build.main) { player.build = { main: family, infusions: [], mutatedMain: enemy.elite }; draft.events.powerAcquired = family; return; }
  if (alreadyHas(player.build, family)) {
    if (enemy.elite && player.build.main === family && !player.build.mutatedMain) { player.build = { ...player.build, mutatedMain: true }; draft.events.evolved = true; }
    return;
  }
  const { replace, infuse } = decisionOptions(player.build, family, enemy.elite);
  draft.decision = { family, elite: enemy.elite, replace, infuse };
  draft.phase = "decision";
}

function stealMainFromPlayer(draft: GameState, boss: EnemyState): void {
  const player = draft.player;
  if (!player.build.main) return;
  const family = player.build.main;
  const [promoted, ...rest] = player.build.infusions;
  player.build = { main: promoted ?? null, infusions: rest, mutatedMain: false };
  draft.stolenCore = { family, pos: { x: boss.pos.x, y: boss.pos.y - ENEMY_RADIUS.boss - 26 } };
  boss.stolenTimer = BOSS_STOLEN_ACTION_INTERVAL;
  draft.events.coreStolen = true;
}

function maybeBossSteal(draft: GameState, boss: EnemyState): void {
  if (!draft.bossStoleAt70 && boss.hp <= boss.maxHp * 0.7) { draft.bossStoleAt70 = true; stealMainFromPlayer(draft, boss); }
  else if (!draft.bossStoleAt35 && draft.stolenCore === null && boss.hp <= boss.maxHp * 0.35) { draft.bossStoleAt35 = true; stealMainFromPlayer(draft, boss); }
}

function reclaimCore(draft: GameState): void {
  const core = draft.stolenCore;
  if (!core) return;
  const player = draft.player;
  const build = player.build;
  if (!build.main) { player.build = { ...build, main: core.family }; }
  else if (build.main !== core.family && !build.infusions.includes(core.family)) {
    const infusions = build.infusions.length < MAX_INFUSIONS ? [...build.infusions, core.family] : [...build.infusions.slice(1), core.family];
    player.build = { ...build, infusions };
  }
  draft.stolenCore = null;
  draft.events.coreReclaimed = true;
  const boss = draft.enemies.find((e) => e.kind === "boss" && e.alive);
  if (boss) { boss.exposed = true; boss.dashResistant = false; boss.timer = 1.6; }
}

function applyDamageToPlayer(draft: GameState, amount: number): void {
  const player = draft.player;
  if (player.invulnerable > 0) return;
  player.health = Math.max(0, player.health - amount);
  player.invulnerable = HIT_INVULNERABILITY; player.timeSinceHit = 0; draft.events.playerHit = true;
}

function resolveHits(draft: GameState): void {
  const player = draft.player;
  const survivors: Projectile[] = [];

  for (const p of draft.projectiles) {
    if (p.owner === "enemy") {
      if (distance(p.pos, player.pos) <= PROJECTILE_RADIUS + PLAYER_RADIUS) {
        applyDamageToPlayer(draft, p.damage);
        continue;
      }
      survivors.push(p);
      continue;
    }

    if (p.boomerang) {
      for (const enemy of draft.enemies) {
        if (!enemy.alive || enemy.invulnerable) continue;
        if (distance(p.pos, enemy.pos) > PROJECTILE_RADIUS + ENEMY_RADIUS[enemy.kind]) continue;
        const cd = p.hitCooldowns?.[enemy.id] ?? 0;
        if (cd > 0) continue;
        damageEnemy(enemy, p.damage);
        if (!p.hitCooldowns) p.hitCooldowns = {};
        p.hitCooldowns[enemy.id] = BOOMERANG_HIT_COOLDOWN;
      }
      survivors.push(p);
      continue;
    }

    let consumed = false;
    for (const enemy of draft.enemies) {
      if (!enemy.alive || enemy.invulnerable) continue;
      if (distance(p.pos, enemy.pos) > PROJECTILE_RADIUS + ENEMY_RADIUS[enemy.kind]) continue;
      damageEnemy(enemy, p.damage);
      consumed = true;
      break;
    }
    if (!consumed) survivors.push(p);
  }

  draft.projectiles = survivors;
}

function resolveDeaths(draft: GameState): void {
  for (const enemy of draft.enemies) if (enemy.alive && enemy.hp <= 0) enemy.alive = false;
}

function resolveEncounterProgress(draft: GameState): void {
  if (draft.phase !== "combat") return;
  if (draft.enemies.some((e) => e.alive)) return;
  if (draft.encounterIndex >= draft.encounters.length - 1) { draft.phase = "cleared"; return; }
  const nextIndex = draft.encounterIndex + 1;
  const { enemies, nextId } = spawnEncounter(draft.encounters, nextIndex, draft.arena, draft.nextId);
  draft.encounterIndex = nextIndex; draft.enemies = enemies; draft.nextId = nextId;
}

// --- Enemy AI application: consumes enemies.ts's per-kind AIResult ---------

function stepBossStolenOverlay(draft: GameState, boss: EnemyState, dt: number): void {
  const core = draft.stolenCore;
  if (!core) return;

  if (core.family === "orbit") {
    boss.orbitAngle = (boss.orbitAngle + ORBIT_ROTATION_SPEED * dt) % (Math.PI * 2);
    for (let i = 0; i < ORBIT_BLADE_COUNT; i++) {
      const angle = boss.orbitAngle + (i * Math.PI * 2) / ORBIT_BLADE_COUNT;
      const bladePos = { x: boss.pos.x + Math.cos(angle) * ORBIT_RADIUS * 1.4, y: boss.pos.y + Math.sin(angle) * ORBIT_RADIUS * 1.4 };
      if (distance(draft.player.pos, bladePos) <= ORBIT_BLADE_HIT_RADIUS + PLAYER_RADIUS) applyDamageToPlayer(draft, ORBIT_DAMAGE);
    }
    return;
  }

  boss.stolenTimer -= dt;
  if (boss.stolenTimer > 0) return;
  boss.stolenTimer = BOSS_STOLEN_ACTION_INTERVAL;

  const dir = normalize({ x: draft.player.pos.x - boss.pos.x, y: draft.player.pos.y - boss.pos.y });

  switch (core.family) {
    case "blink": {
      const angle = boss.orbitAngle;
      boss.orbitAngle = (boss.orbitAngle + BOSS_STOLEN_ANGLE_STEP) % (Math.PI * 2);
      const dest = { x: draft.player.pos.x + Math.cos(angle) * 150, y: draft.player.pos.y + Math.sin(angle) * 150 };
      boss.pos = clampToArena(dest, ENEMY_RADIUS.boss, draft.arena.width, draft.arena.height);
      break;
    }
    case "boomerang":
      draft.projectiles.push({
        id: draft.nextId++, pos: { ...boss.pos }, vel: { x: dir.x * BOOMERANG_SPEED * 0.7, y: dir.y * BOOMERANG_SPEED * 0.7 },
        owner: "enemy", damage: BOOMERANG_DAMAGE, boomerang: true, phase: "out", traveled: 0,
        boomerangLifeLeft: BOOMERANG_MAX_LIFETIME, hitCooldowns: {},
      });
      break;
    case "clone":
      spawnClone(draft, boss.pos, "enemy", { usesBoomerang: false, hasOrbit: false, mirrorDelay: false });
      break;
    case "blackhole":
      spawnBlackHole(draft, boss.pos, dir, { instant: false, elite: false, recollapse: false, owner: "enemy" });
      break;
    case "echo": {
      const vel = { x: dir.x * BOSS_STOLEN_BOLT_SPEED, y: dir.y * BOSS_STOLEN_BOLT_SPEED };
      draft.projectiles.push({ id: draft.nextId++, pos: { ...boss.pos }, vel, owner: "enemy", damage: BOSS_STOLEN_BOLT_DAMAGE });
      draft.pendingEchoes.push({
        timer: ECHO_DELAY, kind: "boltReplay", pos: { ...boss.pos }, direction: { x: 0, y: 0 },
        damage: BOSS_STOLEN_BOLT_DAMAGE * ECHO_DAMAGE_RATIO, vel, owner: "enemy",
      });
      break;
    }
  }
}

function stepEnemies(draft: GameState, dt: number): void {
  for (const enemy of draft.enemies) {
    if (!enemy.alive) continue;
    enemy.orbitCooldown = Math.max(0, enemy.orbitCooldown - dt);

    const result = stepEnemyAI(enemy, draft.player.pos, dt);

    if (result.teleportTo) {
      enemy.pos = clampToArena(result.teleportTo, ENEMY_RADIUS[enemy.kind], draft.arena.width, draft.arena.height);
    } else {
      enemy.pos = clampToArena(
        { x: enemy.pos.x + result.velocity.x * dt, y: enemy.pos.y + result.velocity.y * dt },
        ENEMY_RADIUS[enemy.kind], draft.arena.width, draft.arena.height,
      );
    }
    if (result.facing) enemy.facing = result.facing;

    if (result.bolt) {
      draft.projectiles.push({ id: draft.nextId++, pos: result.bolt.pos, vel: result.bolt.vel, owner: "enemy", damage: result.bolt.damage });
    }
    if (result.echoBolt) {
      draft.pendingEchoes.push({
        timer: ECHO_DELAY, kind: "boltReplay", pos: { ...result.echoBolt.pos }, direction: { x: 0, y: 0 },
        damage: result.echoBolt.damage, vel: { ...result.echoBolt.vel }, owner: "enemy",
      });
    }
    if (result.boomerang) {
      draft.projectiles.push({
        id: draft.nextId++, pos: result.boomerang.pos, vel: result.boomerang.vel, owner: "enemy", damage: result.boomerang.damage,
        boomerang: true, phase: "out", traveled: 0, boomerangLifeLeft: BOOMERANG_MAX_LIFETIME, hitCooldowns: {},
      });
    }
    if (result.spawnClone) {
      spawnClone(draft, enemy.pos, "enemy", { usesBoomerang: false, hasOrbit: false, mirrorDelay: false });
    }
    if (result.spawnBlackHole) {
      spawnBlackHole(draft, enemy.pos, result.spawnBlackHole.direction, { instant: false, elite: false, recollapse: false, owner: "enemy" });
    }
    if (result.slam && distance(enemy.pos, draft.player.pos) <= result.slam.radius + PLAYER_RADIUS) {
      applyDamageToPlayer(draft, result.slam.damage);
    }

    if (enemy.exposed) draft.events.bossExposed = true;
    if (enemy.kind === "boss") {
      if (!enemy.exposed) maybeBossSteal(draft, enemy);
      stepBossStolenOverlay(draft, enemy, dt);
    }
  }
}
