// Enemy archetypes: pure AI. Each stepper reads positions and a dt and
// returns a velocity plus anything it spawned this frame --- game.ts owns
// mutation, arena clamping and collision.
//
// Every enemy kind (but the boss) belongs to one power family and must
// visibly demonstrate that family in how it fights, before the player can
// ever steal it: phantom teleports and strikes from a new spot each time
// (BLINK), thrower's weapon is live on both the outbound and return leg
// (BOOMERANG), duplicate splits into a second attacker (CLONE), anchor
// drags the player out of position with a pull field before its own hit
// lands (BLACKHOLE), sentinel's circling blades make its own melee range
// dangerous even when it isn't swinging (ORBIT), reverberant's attack fires
// a second time, a beat later, from where it first fired (ECHO).

import type { Vec2 } from "./game.ts";
import { ALL_FAMILIES, HEADLINE_PAIRS, type PowerFamily } from "./powers.ts";
import { type Rng, pickIndex } from "./rng.ts";

export type EnemyKind = "phantom" | "thrower" | "duplicate" | "anchor" | "sentinel" | "reverberant" | "husk" | "boss";

export const ENEMY_FAMILY: Record<EnemyKind, PowerFamily | null> = {
  phantom: "blink",
  thrower: "boomerang",
  duplicate: "clone",
  anchor: "blackhole",
  sentinel: "orbit",
  reverberant: "echo",
  husk: null,
  boss: null,
};

export interface EnemyState {
  id: number;
  kind: EnemyKind;
  pos: Vec2;
  hp: number;
  maxHp: number;
  alive: boolean;
  facing: Vec2;
  phase: number; // 0 seek/idle, 1 telegraph, 2 acting, 3 recover (boss: also cycles through sub-attacks)
  timer: number; // countdown driving whatever `phase` means for this kind
  telegraphDuration: number; // for renderer: how long the current telegraph is, to normalise a 0..1 ratio
  invulnerable: boolean; // blocks player attack damage (not dash)
  dashResistant: boolean; // blocks dash-kill outright (only the boss, outside its exposed window)
  exposed: boolean; // in BREAK: standing still, dash-killable, glowing
  armIntroBreak: boolean; // this enemy's own attack cycle (not player damage) will open BREAK once it completes
  introAttackFired: boolean; // set once an armIntroBreak enemy has been seen telegraphing, so BREAK waits for its full cycle
  elite: boolean; // bigger, tougher variant; grants a mutated version of its family on steal
  orbitAngle: number; // sentinel's passive ring; also phantom's deterministic teleport-angle accumulator,
  // and the boss's rotation while it holds a stolen Orbit or its stolen-power action cooldown driver
  orbitCooldown: number; // per-target re-hit gap against any orbit-blade emitter, ticked in game.ts
  stolenTimer: number; // boss only: cooldown gate for its stolen-power overlay action
}

export interface SpawnedProjectile {
  pos: Vec2;
  vel: Vec2;
  damage: number;
}

export interface SlamHit {
  radius: number;
  damage: number;
}

export interface AIResult {
  velocity: Vec2;
  facing?: Vec2;
  teleportTo?: Vec2; // phantom: an instant reposition, applied before velocity-based movement
  bolt?: SpawnedProjectile;
  echoBolt?: SpawnedProjectile; // schedules a delayed exact repeat of this same bolt
  boomerang?: SpawnedProjectile; // thrower: a real out-and-back weapon, not a one-way bolt
  spawnClone?: boolean; // duplicate: splits into a second, independently-acting attacker
  spawnBlackHole?: { direction: Vec2 }; // anchor: throws a real pull-then-collapse field
  slam?: SlamHit;
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len > 0 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

function toward(from: Vec2, to: Vec2): Vec2 {
  return normalize({ x: to.x - from.x, y: to.y - from.y });
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const BASE_MAX_HP: Record<EnemyKind, number> = {
  phantom: 40,
  thrower: 48,
  duplicate: 56,
  anchor: 64,
  sentinel: 70,
  reverberant: 44,
  husk: 20,
  boss: 170,
};
const ELITE_HP_MULT = 1.9;

const START_TIMER: Record<EnemyKind, number> = {
  phantom: 1.0,
  thrower: 1.0,
  duplicate: 1.2,
  anchor: 1.3,
  sentinel: 0.8,
  reverberant: 1.0,
  husk: 0,
  boss: 0,
};

export function createEnemy(id: number, kind: EnemyKind, pos: Vec2, elite = false, introBreak = false): EnemyState {
  const maxHp = elite ? Math.round(BASE_MAX_HP[kind] * ELITE_HP_MULT) : BASE_MAX_HP[kind];
  return {
    id,
    kind,
    pos,
    hp: maxHp,
    maxHp,
    alive: true,
    facing: { x: 0, y: 1 },
    phase: 0,
    timer: START_TIMER[kind],
    telegraphDuration: 0,
    invulnerable: false,
    dashResistant: kind === "boss",
    exposed: false,
    armIntroBreak: introBreak,
    introAttackFired: false,
    elite,
    orbitAngle: 0,
    orbitCooldown: 0,
    stolenTimer: 1.0,
  };
}

// --- Phantom (BLINK): teleports aggressively, strikes from the new spot -----

const PHANTOM_TELEPORT_INTERVAL = 1.8;
const PHANTOM_TELEPORT_DIST = 150;
const PHANTOM_TELEGRAPH = 0.35;
const PHANTOM_SLAM_RECOVER = 0.9;
const PHANTOM_DRIFT_SPEED = 70;
const PHANTOM_ANGLE_STEP = 2.399963; // golden-angle-ish, deterministic but well-spread across teleports

function stepPhantom(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  if (e.phase === 1) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 2;
      e.timer = 0.2;
      return { velocity: { x: 0, y: 0 }, facing: e.facing, slam: { radius: 48, damage: 16 } };
    }
    return { velocity: { x: 0, y: 0 }, facing: e.facing };
  }

  if (e.phase === 2) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 3;
      e.timer = PHANTOM_SLAM_RECOVER;
    }
    return { velocity: { x: 0, y: 0 }, facing: e.facing };
  }

  if (e.phase === 3) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 0;
      e.timer = PHANTOM_TELEPORT_INTERVAL;
    }
    return { velocity: { x: 0, y: 0 }, facing: toward(e.pos, playerPos) };
  }

  e.timer -= dt;
  if (e.timer <= 0) {
    const angle = e.orbitAngle;
    e.orbitAngle = (e.orbitAngle + PHANTOM_ANGLE_STEP) % (Math.PI * 2);
    const dest = {
      x: playerPos.x + Math.cos(angle) * PHANTOM_TELEPORT_DIST,
      y: playerPos.y + Math.sin(angle) * PHANTOM_TELEPORT_DIST,
    };
    e.phase = 1;
    e.timer = PHANTOM_TELEGRAPH;
    e.telegraphDuration = PHANTOM_TELEGRAPH;
    return { velocity: { x: 0, y: 0 }, facing: toward(dest, playerPos), teleportTo: dest };
  }
  const facing = toward(e.pos, playerPos);
  return { velocity: { x: facing.x * PHANTOM_DRIFT_SPEED, y: facing.y * PHANTOM_DRIFT_SPEED }, facing };
}

// --- Thrower (BOOMERANG): the weapon is live on the way out and the way back

const THROWER_KEEP_NEAR = 200;
const THROWER_KEEP_FAR = 380;
const THROWER_SPEED = 130;
const THROWER_TELEGRAPH = 0.5;
const THROWER_INTERVAL = 2.0;
const THROWER_BOLT_SPEED = 300;
const THROWER_DAMAGE = 14;

function stepThrower(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  const facing = toward(e.pos, playerPos);
  const d = distance(e.pos, playerPos);

  if (e.phase === 1) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 0;
      e.timer = THROWER_INTERVAL;
      return {
        velocity: { x: 0, y: 0 },
        facing,
        boomerang: {
          pos: { ...e.pos },
          vel: { x: facing.x * THROWER_BOLT_SPEED, y: facing.y * THROWER_BOLT_SPEED },
          damage: THROWER_DAMAGE,
        },
      };
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  e.timer -= dt;
  if (e.timer <= 0) {
    e.phase = 1;
    e.timer = THROWER_TELEGRAPH;
    e.telegraphDuration = THROWER_TELEGRAPH;
    return { velocity: { x: 0, y: 0 }, facing };
  }

  if (d < THROWER_KEEP_NEAR) return { velocity: { x: -facing.x * THROWER_SPEED, y: -facing.y * THROWER_SPEED }, facing };
  if (d > THROWER_KEEP_FAR) return { velocity: { x: facing.x * THROWER_SPEED, y: facing.y * THROWER_SPEED }, facing };
  return { velocity: { x: 0, y: 0 }, facing };
}

// --- Duplicate (CLONE): splits into a second, independently-acting attacker -

const DUPLICATE_CHASE_SPEED = 150;
const DUPLICATE_RANGE = 200;
const DUPLICATE_TELEGRAPH = 0.5;
const DUPLICATE_RECOVER = 2.4;
const DUPLICATE_COOLDOWN = 3.0;

function stepDuplicate(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  const facing = toward(e.pos, playerPos);
  const d = distance(e.pos, playerPos);

  if (e.phase === 1) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 2;
      e.timer = DUPLICATE_RECOVER;
      return { velocity: { x: 0, y: 0 }, facing, spawnClone: true };
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  if (e.phase === 2) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 0;
      e.timer = DUPLICATE_COOLDOWN;
    }
    return { velocity: { x: facing.x * DUPLICATE_CHASE_SPEED * 0.4, y: facing.y * DUPLICATE_CHASE_SPEED * 0.4 }, facing };
  }

  e.timer = Math.max(0, e.timer - dt);
  if (d <= DUPLICATE_RANGE && e.timer <= 0) {
    e.phase = 1;
    e.timer = DUPLICATE_TELEGRAPH;
    e.telegraphDuration = DUPLICATE_TELEGRAPH;
    return { velocity: { x: 0, y: 0 }, facing };
  }
  return { velocity: { x: facing.x * DUPLICATE_CHASE_SPEED, y: facing.y * DUPLICATE_CHASE_SPEED }, facing };
}

// --- Anchor (BLACKHOLE): a real pull field drags the player before it hits --

const ANCHOR_KEEP_NEAR = 180;
const ANCHOR_KEEP_FAR = 340;
const ANCHOR_SPEED = 90;
const ANCHOR_TELEGRAPH = 0.6;
const ANCHOR_FOLLOWUP = 0.9; // gap between throwing the pull field and its own melee
const ANCHOR_RECOVER = 1.0;
const ANCHOR_COOLDOWN = 2.6;
const ANCHOR_SLAM_RADIUS = 60;
const ANCHOR_SLAM_DAMAGE = 18;

function stepAnchor(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  const facing = toward(e.pos, playerPos);
  const d = distance(e.pos, playerPos);

  if (e.phase === 1) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 2;
      e.timer = ANCHOR_FOLLOWUP;
      return { velocity: { x: 0, y: 0 }, facing, spawnBlackHole: { direction: facing } };
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  if (e.phase === 2) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 3;
      e.timer = ANCHOR_RECOVER;
      return { velocity: { x: 0, y: 0 }, facing, slam: { radius: ANCHOR_SLAM_RADIUS, damage: ANCHOR_SLAM_DAMAGE } };
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  if (e.phase === 3) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 0;
      e.timer = ANCHOR_COOLDOWN;
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  e.timer -= dt;
  if (e.timer <= 0) {
    e.phase = 1;
    e.timer = ANCHOR_TELEGRAPH;
    e.telegraphDuration = ANCHOR_TELEGRAPH;
    return { velocity: { x: 0, y: 0 }, facing };
  }
  if (d < ANCHOR_KEEP_NEAR) return { velocity: { x: -facing.x * ANCHOR_SPEED, y: -facing.y * ANCHOR_SPEED }, facing };
  if (d > ANCHOR_KEEP_FAR) return { velocity: { x: facing.x * ANCHOR_SPEED, y: facing.y * ANCHOR_SPEED }, facing };
  return { velocity: { x: 0, y: 0 }, facing };
}

// --- Sentinel (ORBIT): circling blades make its own melee range dangerous --

const SENTINEL_SPEED = 100;
const SENTINEL_HOLD_RANGE = 90;
export const SENTINEL_ORBIT_ROTATION_SPEED = 3.4; // radians/sec, own constant so enemies.ts stays powers-agnostic at runtime

function stepSentinel(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  const facing = toward(e.pos, playerPos);
  e.orbitAngle = (e.orbitAngle + SENTINEL_ORBIT_ROTATION_SPEED * dt) % (Math.PI * 2);
  const d = distance(e.pos, playerPos);
  if (d > SENTINEL_HOLD_RANGE) return { velocity: { x: facing.x * SENTINEL_SPEED, y: facing.y * SENTINEL_SPEED }, facing };
  return { velocity: { x: 0, y: 0 }, facing };
}

// --- Reverberant (ECHO): the same attack fires again, a beat later ---------

const REVERBERANT_NEAR = 200;
const REVERBERANT_FAR = 380;
const REVERBERANT_SPEED = 150;
const REVERBERANT_TELEGRAPH = 0.5;
const REVERBERANT_INTERVAL = 2.2;
const REVERBERANT_BOLT_SPEED = 300;
const REVERBERANT_DAMAGE = 12;

function stepReverberant(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  const facing = toward(e.pos, playerPos);
  const d = distance(e.pos, playerPos);

  if (e.phase === 1) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 0;
      e.timer = REVERBERANT_INTERVAL;
      const bolt = {
        pos: { ...e.pos },
        vel: { x: facing.x * REVERBERANT_BOLT_SPEED, y: facing.y * REVERBERANT_BOLT_SPEED },
        damage: REVERBERANT_DAMAGE,
      };
      return { velocity: { x: 0, y: 0 }, facing, bolt, echoBolt: bolt };
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  e.timer -= dt;
  if (e.timer <= 0) {
    e.phase = 1;
    e.timer = REVERBERANT_TELEGRAPH;
    e.telegraphDuration = REVERBERANT_TELEGRAPH;
    return { velocity: { x: 0, y: 0 }, facing };
  }
  if (d < REVERBERANT_NEAR) return { velocity: { x: -facing.x * REVERBERANT_SPEED, y: -facing.y * REVERBERANT_SPEED }, facing };
  if (d > REVERBERANT_FAR) return { velocity: { x: facing.x * REVERBERANT_SPEED, y: facing.y * REVERBERANT_SPEED }, facing };
  return { velocity: { x: 0, y: 0 }, facing };
}

// --- Husk (fodder): no power family --- lighter and faster to kill than any
// carrier, so it reads as disposable trash rather than a build decision. ----

const HUSK_CHASE_SPEED = 180;
const HUSK_MELEE_RANGE = 46;
const HUSK_TELEGRAPH = 0.3;
const HUSK_SLAM_RADIUS = 34;
const HUSK_SLAM_DAMAGE = 8;
const HUSK_RECOVER = 0.6;

function stepHusk(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  const facing = toward(e.pos, playerPos);
  const d = distance(e.pos, playerPos);

  if (e.phase === 1) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = 2;
      e.timer = HUSK_RECOVER;
      return { velocity: { x: 0, y: 0 }, facing, slam: { radius: HUSK_SLAM_RADIUS, damage: HUSK_SLAM_DAMAGE } };
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  if (e.phase === 2) {
    e.timer -= dt;
    if (e.timer <= 0) e.phase = 0;
    return { velocity: { x: 0, y: 0 }, facing };
  }

  if (d <= HUSK_MELEE_RANGE) {
    e.phase = 1;
    e.timer = HUSK_TELEGRAPH;
    e.telegraphDuration = HUSK_TELEGRAPH;
    return { velocity: { x: 0, y: 0 }, facing };
  }
  return { velocity: { x: facing.x * HUSK_CHASE_SPEED, y: facing.y * HUSK_CHASE_SPEED }, facing };
}

// --- Boss: cycles ranged / charge / guard, exposes a window once below half HP

const BOSS_EXPOSE_HP_RATIO = 0.5;
const BOSS_EXPOSE_DURATION = 2.4;
const BOSS_SPEED = 130;
const BOSS_BOLT_SPEED = 300;

// sub-phase 0: ranged fan, 1: telegraph+charge, 2: telegraph+guard slam
const BOSS_SUBPHASES = 3;

function stepBoss(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  const facing = toward(e.pos, playerPos);
  e.dashResistant = !e.exposed;
  if (e.exposed) e.invulnerable = false;

  if (e.exposed) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.exposed = false;
      e.phase = 0;
      e.timer = 0.6;
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  // phase encodes sub-attack * 10 + step (0 seek, 1 telegraph, 2 act, 3 recover)
  const sub = Math.floor(e.phase / 10);
  const step = e.phase % 10;

  if (step === 0) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = sub * 10 + 1;
      e.timer = 0.5;
      e.telegraphDuration = 0.5;
      return { velocity: { x: 0, y: 0 }, facing };
    }
    const d = distance(e.pos, playerPos);
    const vel = d > 260 ? { x: facing.x * BOSS_SPEED, y: facing.y * BOSS_SPEED } : { x: 0, y: 0 };
    return { velocity: vel, facing };
  }

  if (step === 1) {
    e.timer -= dt;
    if (e.timer <= 0) {
      e.phase = sub * 10 + 2;
      e.timer = sub === 0 ? 0.05 : sub === 1 ? 0.32 : 1.2;
      e.facing = facing;
      if (sub === 2) {
        e.invulnerable = true;
        return { velocity: { x: 0, y: 0 }, facing, slam: { radius: 60, damage: 20 } };
      }
    }
    return { velocity: { x: 0, y: 0 }, facing };
  }

  if (step === 2) {
    e.timer -= dt;
    const acting = e.timer > 0;
    if (!acting) {
      e.phase = sub * 10 + 3;
      e.timer = 0.7;
      e.invulnerable = false;
      return { velocity: { x: 0, y: 0 }, facing: e.facing };
    }
    if (sub === 0) {
      return {
        velocity: { x: 0, y: 0 },
        facing: e.facing,
        bolt: {
          pos: { ...e.pos },
          vel: { x: e.facing.x * BOSS_BOLT_SPEED, y: e.facing.y * BOSS_BOLT_SPEED },
          damage: 14,
        },
      };
    }
    if (sub === 1) {
      return {
        velocity: { x: e.facing.x * 640, y: e.facing.y * 640 },
        facing: e.facing,
        slam: { radius: 16, damage: 18 },
      };
    }
    return { velocity: { x: 0, y: 0 }, facing: e.facing };
  }

  // step === 3: recover
  e.timer -= dt;
  if (e.timer <= 0) {
    const nextSub = (sub + 1) % BOSS_SUBPHASES;
    if (nextSub === 0 && e.hp <= e.maxHp * BOSS_EXPOSE_HP_RATIO) {
      e.exposed = true;
      e.timer = BOSS_EXPOSE_DURATION;
      e.dashResistant = false;
      return { velocity: { x: 0, y: 0 }, facing: e.facing };
    }
    e.phase = nextSub * 10;
    e.timer = 1;
  }
  return { velocity: { x: 0, y: 0 }, facing: e.facing };
}

export function stepEnemyAI(e: EnemyState, playerPos: Vec2, dt: number): AIResult {
  switch (e.kind) {
    case "phantom":
      return stepPhantom(e, playerPos, dt);
    case "thrower":
      return stepThrower(e, playerPos, dt);
    case "duplicate":
      return stepDuplicate(e, playerPos, dt);
    case "anchor":
      return stepAnchor(e, playerPos, dt);
    case "sentinel":
      return stepSentinel(e, playerPos, dt);
    case "reverberant":
      return stepReverberant(e, playerPos, dt);
    case "husk":
      return stepHusk(e, playerPos, dt);
    case "boss":
      return stepBoss(e, playerPos, dt);
  }
}

// --- Run generation -----------------------------------------------------------
//
// STEAL must not show every power in one run --- that's the replayability
// mechanism. At run start (only) we roll one of the ten headline pairs (so
// that combination is always reachable this run) plus one extra power from
// the remaining four. Only enemy kinds belonging to those 2-3 powers spawn;
// the other three enemies, their power, and every combination touching them
// simply never appear this run.

export const FAMILY_ENEMY: Record<PowerFamily, EnemyKind> = {
  blink: "phantom",
  boomerang: "thrower",
  clone: "duplicate",
  blackhole: "anchor",
  orbit: "sentinel",
  echo: "reverberant",
};

export interface EncounterSpawn {
  kind: EnemyKind;
  xf: number;
  yf: number;
  elite?: boolean;
  introBreak?: boolean; // this spawn's own attack cycle opens BREAK, not player damage --- the opener only
}

export interface EncounterSpec {
  spawns: EncounterSpawn[];
}

export interface RunPlan {
  palette: PowerFamily[]; // the 3 powers this run exposes
  encounters: EncounterSpec[];
}

export function createRun(rng: Rng): RunPlan {
  const [a, b] = HEADLINE_PAIRS[pickIndex(rng, HEADLINE_PAIRS)];
  const remaining = ALL_FAMILIES.filter((f) => f !== a && f !== b);
  const extra = remaining[pickIndex(rng, remaining)];
  const palette = [a, b, extra];

  const kindA = FAMILY_ENEMY[a];
  const kindB = FAMILY_ENEMY[b];
  const kindC = FAMILY_ENEMY[extra];
  const eliteKind = rng() < 0.5 ? kindA : kindB;
  // The opener has to be able to demonstrate and complete its own attack on a
  // timer, with no player damage involved --- sentinel never telegraphs at
  // all, so it can never be the scripted intro carrier (see stepEnemies's
  // armIntroBreak handling in game.ts).
  const introKind = kindA === "sentinel" ? kindB : kindA;

  const encounters: EncounterSpec[] = [
    // Opening: a single power-carrier demonstrates its own attack, unprompted
    // --- the player has no attack yet, only movement and dash. Its own cycle
    // opens BREAK; dashing through it grants the player's first attack.
    { spawns: [{ kind: introKind, xf: 0.5, yf: 0.22, introBreak: true }] },
    // Encounter 2: both halves of the headline pair, together --- which one
    // you dash-finish first decides which power you're playing with for the
    // rest of this fight, so the kill-order choice is live from here on.
    // A pair of husks give the player's new stolen attack something disposable
    // to use it on between the two real decisions.
    {
      spawns: [
        { kind: kindB, xf: 0.3, yf: 0.25 },
        { kind: kindA, xf: 0.72, yf: 0.2 },
        { kind: "husk", xf: 0.15, yf: 0.55 },
        { kind: "husk", xf: 0.85, yf: 0.55 },
      ],
    },
    // Encounter 3: a mixed composition using the run's third power to make
    // the fight strategically interesting, not just numerically bigger. One
    // husk for pacing --- kept light so it doesn't dilute the three-carrier fight.
    {
      spawns: [
        { kind: kindC, xf: 0.5, yf: 0.18 },
        { kind: kindA, xf: 0.22, yf: 0.3 },
        { kind: kindB, xf: 0.78, yf: 0.3 },
        { kind: "husk", xf: 0.5, yf: 0.55 },
      ],
    },
    // Elite: a rare, enhanced version of one half of the headline pair, plus
    // one husk for pacing.
    {
      spawns: [
        { kind: eliteKind, xf: 0.5, yf: 0.2, elite: true },
        { kind: "husk", xf: 0.5, yf: 0.55 },
      ],
    },
    // Final: the boss, palette-independent since it reacts to whatever the
    // player actually built rather than to a fixed power. Already fully
    // choreographed via the stolen-core mechanic --- no husks.
    { spawns: [{ kind: "boss", xf: 0.5, yf: 0.2 }] },
  ];

  return { palette, encounters };
}
