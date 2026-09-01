import { describe, expect, it } from "vitest";
import { createInitialState, step, type GameState, type Input } from "../game.ts";
import { ENEMY_FAMILY } from "../enemies.ts";
import { activeFusions, fusionFor, type Build } from "../powers.ts";

// STEAL's core rule, iteration 4: dash is a finisher, not a killer. Ordinary
// damage can never take an enemy below 1hp; only a dash landing on an enemy
// already at that floor executes it and hands over its power. This trio of
// tests covers that rule end to end: it can't be bypassed with raw damage,
// dashing a healthy enemy only interrupts it, and dashing a floored enemy
// actually steals --- plus a pure unit test for fusion pairing, since that's
// the one piece of iteration 4 that's a clean deterministic rule.

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

describe("floor rule: only a finishing dash executes an enemy", () => {
  it("never lets ordinary attack damage take a fresh enemy below 1hp", () => {
    let state = createInitialState(800, 600);
    const enemy = { ...state.enemies[0], pos: { x: state.player.pos.x, y: state.player.pos.y - 40 } };
    state = { ...state, enemies: [enemy] };

    // Land far more basic-attack damage than the enemy's max hp.
    for (let i = 0; i < 8; i++) {
      state = { ...state, player: { ...state.player, attackCooldown: 0, facing: { x: 0, y: -1 } } };
      state = step(state, { ...IDLE, attackPressed: true, attackTarget: enemy.pos }, 1 / 60);
    }

    expect(state.enemies[0].hp).toBeGreaterThanOrEqual(1);
    expect(state.enemies[0].alive).toBe(true);
  });

  it("interrupts, rather than kills, a dash into a still-healthy enemy", () => {
    let state = createInitialState(800, 600);
    const enemy = { ...state.enemies[0], pos: { x: state.player.pos.x, y: state.player.pos.y - 40 } };
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
      player: { ...state.player, pos: playerPos, facing: { x: 0, y: -1 }, attackCooldown: 0 },
      enemies: [
        { ...state.enemies[0], kind: "boss", pos: bossPos, hp: 5, maxHp: 170, exposed: false, dashResistant: true, alive: true },
      ],
    };

    state = step(state, { ...IDLE, attackPressed: true, attackTarget: bossPos }, 1 / 60);

    expect(state.enemies[0].hp).toBeGreaterThanOrEqual(1);
    expect(state.enemies[0].alive).toBe(true);
  });
});

describe("execute-and-steal", () => {
  it("dashing into an enemy already at the 1hp floor kills it and grants its family", () => {
    let state = createInitialState(800, 600);
    const enemy = { ...state.enemies[0], hp: 1, pos: { x: state.player.pos.x, y: state.player.pos.y - 40 } };
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
