import { describe, expect, it } from "vitest";
import { createInitialState, step, type GameState, type Input } from "../game.ts";
import { ENEMY_FAMILY } from "../enemies.ts";
import { activeFusions, fusionFor, type Build } from "../powers.ts";

// STEAL's core rule, iteration 6: the player starts with no attack at all ---
// the first one is always stolen from a scripted opener whose own attack
// cycle (not player damage) opens a BREAK window. From then on, dash is a
// finisher, not a killer, for any power-carrier: ordinary damage can never
// take a carrier below 1hp; only a dash landing on a carrier already in
// BREAK executes it and hands over its power. Fodder (husk) carries no
// family and just dies to ordinary damage like a normal action-game trash
// mob. This suite covers each of those rules end to end, plus a pure unit
// test for fusion pairing.

const IDLE: Input = {
  up: false,
  down: false,
  left: false,
  right: false,
  dashPressed: false,
  attackPressed: false,
  attackTarget: { x: 0, y: 0 },
  decisionClick: null,
};

const ECHO_BUILD: Build = { main: "echo", infusions: [], mutatedMain: false };

function normalize(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

// Walks a dash forward, frame by frame, and reports whether any frame of it
// produced a kill or an interrupt --- resolveDash only runs while
// `dashTimeLeft > 0`, and events are recomputed fresh every step, so a
// single final snapshot could miss whichever frame actually made contact.
function dashOnto(state: GameState): { state: GameState; sawDashKill: boolean; sawDashInterrupt: boolean } {
  const enemy = state.enemies[0];
  const facing = normalize(enemy.pos.x - state.player.pos.x, enemy.pos.y - state.player.pos.y);
  state = { ...state, player: { ...state.player, facing } };

  let sawDashKill = false;
  let sawDashInterrupt = false;
  state = step(state, { ...IDLE, dashPressed: true }, 1 / 60);
  sawDashKill ||= !!state.events.dashKill;
  sawDashInterrupt ||= !!state.events.dashInterrupt;
  for (let i = 0; i < 10 && state.player.dashTimeLeft > 0; i++) {
    state = step(state, IDLE, 1 / 60);
    sawDashKill ||= !!state.events.dashKill;
    sawDashInterrupt ||= !!state.events.dashInterrupt;
  }
  return { state, sawDashKill, sawDashInterrupt };
}

describe("floor rule: only a finishing dash executes a power-carrier", () => {
  it("never lets ordinary attack damage take a fresh carrier below 1hp", () => {
    let state = createInitialState(800, 600);
    const enemy = {
      ...state.enemies[0],
      kind: "phantom" as const,
      hp: 40,
      maxHp: 40,
      pos: { x: state.player.pos.x, y: state.player.pos.y - 40 },
      exposed: false,
      invulnerable: false,
      dashResistant: false,
      armIntroBreak: false,
      introAttackFired: false,
    };
    state = { ...state, player: { ...state.player, build: ECHO_BUILD }, enemies: [enemy] };

    // Land far more attack damage than the enemy's max hp.
    for (let i = 0; i < 8; i++) {
      state = { ...state, player: { ...state.player, attackCooldown: 0, facing: { x: 0, y: -1 } } };
      state = step(state, { ...IDLE, attackPressed: true, attackTarget: enemy.pos }, 1 / 60);
    }

    expect(state.enemies[0].hp).toBeGreaterThanOrEqual(1);
    expect(state.enemies[0].alive).toBe(true);
  });

  it("interrupts, rather than kills, a dash into a still-healthy carrier", () => {
    let state = createInitialState(800, 600);
    const enemy = {
      ...state.enemies[0],
      kind: "phantom" as const,
      hp: 40,
      maxHp: 40,
      pos: { x: state.player.pos.x, y: state.player.pos.y - 40 },
      exposed: false,
      invulnerable: false,
      dashResistant: false,
      armIntroBreak: false,
      introAttackFired: false,
    };
    const enemyId = enemy.id;
    state = { ...state, enemies: [enemy] };

    const { state: after, sawDashKill, sawDashInterrupt } = dashOnto(state);

    expect(after.enemies.find((e) => e.id === enemyId)?.alive).toBe(true);
    expect(sawDashKill).toBe(false);
    expect(sawDashInterrupt).toBe(true);
  });

  it("cannot be reduced below 1hp by non-dash damage while the boss is unexposed", () => {
    let state = createInitialState(800, 600);
    const playerPos = { x: 400, y: 400 };
    const bossPos = { x: 400, y: 350 };
    state = {
      ...state,
      player: { ...state.player, pos: playerPos, facing: { x: 0, y: -1 }, attackCooldown: 0, build: ECHO_BUILD },
      enemies: [
        {
          ...state.enemies[0],
          kind: "boss",
          pos: bossPos,
          hp: 5,
          maxHp: 170,
          exposed: false,
          invulnerable: false,
          dashResistant: true,
          armIntroBreak: false,
          introAttackFired: false,
          alive: true,
        },
      ],
    };

    state = step(state, { ...IDLE, attackPressed: true, attackTarget: bossPos }, 1 / 60);

    expect(state.enemies[0].hp).toBeGreaterThanOrEqual(1);
    expect(state.enemies[0].alive).toBe(true);
  });
});

describe("execute-and-steal", () => {
  it("dashing into a carrier already in BREAK kills it and grants its family", () => {
    let state = createInitialState(800, 600);
    const enemy = {
      ...state.enemies[0],
      kind: "phantom" as const,
      hp: 1,
      pos: { x: state.player.pos.x, y: state.player.pos.y - 40 },
      exposed: true,
      invulnerable: true,
      dashResistant: false,
      armIntroBreak: false,
      introAttackFired: false,
    };
    const enemyId = enemy.id;
    const family = ENEMY_FAMILY[enemy.kind];
    state = { ...state, enemies: [enemy] };

    const { state: after, sawDashKill } = dashOnto(state);

    expect(sawDashKill).toBe(true);
    // Encounter 1 is a single enemy, so killing it advances straight to
    // encounter 2 and replaces the enemies array entirely --- the original
    // enemy's id is gone rather than lingering as `alive: false`.
    expect(after.enemies.some((e) => e.id === enemyId)).toBe(false);
    expect(after.player.build.main).toBe(family);
  });

  it("dashing into the scripted opener's full-HP BREAK still kills it and grants its family", () => {
    // Regression test: resolveDash used to branch on `hp > 1`, but the
    // scripted opener enters BREAK via its own attack cycle without its hp
    // ever moving --- that bug would have hit the interrupt branch here and
    // silently done nothing.
    let state = createInitialState(800, 600);
    const enemy = {
      ...state.enemies[0],
      kind: "thrower" as const,
      hp: 48,
      maxHp: 48,
      pos: { x: state.player.pos.x, y: state.player.pos.y - 40 },
      exposed: true,
      invulnerable: true,
      dashResistant: false,
      armIntroBreak: false,
      introAttackFired: true,
    };
    const enemyId = enemy.id;
    const family = ENEMY_FAMILY[enemy.kind];
    state = { ...state, enemies: [enemy] };

    const { state: after, sawDashKill } = dashOnto(state);

    expect(sawDashKill).toBe(true);
    expect(after.enemies.some((e) => e.id === enemyId)).toBe(false);
    expect(after.player.build.main).toBe(family);
  });
});

describe("scripted opening: BREAK triggered by the enemy's own attack cycle", () => {
  it("opens BREAK once the carrier completes one full telegraph, with zero player damage", () => {
    let state = createInitialState(800, 600);
    const enemy = {
      ...state.enemies[0],
      kind: "thrower" as const,
      pos: { x: state.player.pos.x, y: state.player.pos.y - 250 }, // out of attack/dash range
      exposed: false,
      invulnerable: false,
      dashResistant: false,
      armIntroBreak: true,
      introAttackFired: false,
    };
    const maxHp = enemy.maxHp;
    state = { ...state, enemies: [enemy] };

    let becameExposed = false;
    for (let i = 0; i < 300 && !becameExposed; i++) {
      state = step(state, IDLE, 1 / 60);
      becameExposed = state.enemies[0]?.exposed === true;
    }

    expect(becameExposed).toBe(true);
    // Its hp never moved --- BREAK opened purely from its own attack cycle.
    expect(state.enemies[0].hp).toBe(maxHp);
  });
});

describe("fodder: husks die to ordinary damage, no dash needed", () => {
  it("kills a husk with plain attack damage alone", () => {
    let state = createInitialState(800, 600);
    const enemy = {
      ...state.enemies[0],
      kind: "husk" as const,
      hp: 20,
      maxHp: 20,
      pos: { x: state.player.pos.x, y: state.player.pos.y - 40 },
      exposed: false,
      invulnerable: false,
      dashResistant: false,
      armIntroBreak: false,
      introAttackFired: false,
    };
    const enemyId = enemy.id;
    state = { ...state, player: { ...state.player, build: ECHO_BUILD }, enemies: [enemy] };

    for (let i = 0; i < 8; i++) {
      state = { ...state, player: { ...state.player, attackCooldown: 0, facing: { x: 0, y: -1 } } };
      state = step(state, { ...IDLE, attackPressed: true, attackTarget: enemy.pos }, 1 / 60);
    }

    expect(state.enemies.some((e) => e.id === enemyId && e.alive)).toBe(false);
  });
});

describe("BREAK carriers are invulnerable to incidental damage until stolen", () => {
  it("stays at the 1hp floor and alive after taking an incidental hit while exposed", () => {
    let state = createInitialState(800, 600);
    const enemy = {
      ...state.enemies[0],
      kind: "phantom" as const,
      hp: 1,
      pos: { x: state.player.pos.x, y: state.player.pos.y - 40 },
      exposed: true,
      invulnerable: true,
      dashResistant: false,
      armIntroBreak: false,
      introAttackFired: false,
    };
    state = { ...state, player: { ...state.player, build: ECHO_BUILD, attackCooldown: 0, facing: { x: 0, y: -1 } }, enemies: [enemy] };

    state = step(state, { ...IDLE, attackPressed: true, attackTarget: enemy.pos }, 1 / 60);

    expect(state.enemies[0].hp).toBe(1);
    expect(state.enemies[0].alive).toBe(true);
  });
});

describe("fusion correctness", () => {
  it("pairs blink + clone as Doppel Strike, symmetrically", () => {
    expect(fusionFor("blink", "clone")).toBe("doppelStrike");
    expect(fusionFor("clone", "blink")).toBe("doppelStrike");
  });

  it("activates the fusion once a build actually holds both families", () => {
    const build: Build = { main: "blink", infusions: ["clone"], mutatedMain: false };
    expect(activeFusions(build)).toContain("doppelStrike");
  });

  it("does not treat a secondary (non-headline) pair as a fusion", () => {
    expect(fusionFor("clone", "orbit")).toBeNull();
  });
});
