// Catalogue of stolen powers: pure data and small pure decision functions.
// No game state lives here --- game.ts owns the player's build and applies
// these; art.ts/render.ts read the same fusion/family data to decide how
// things look, so simulation and presentation never disagree.
//
// Iteration 5 replaces the elemental/status-effect catalog entirely: every
// power here changes what pressing the attack button *does* (teleport,
// throw-and-return, summon a second attacker, set a trap, stand in a zone,
// replay an action) rather than a stat it modifies. There is no
// rock-paper-scissors matchup chart between these six.

export type PowerFamily = "blink" | "boomerang" | "clone" | "blackhole" | "orbit" | "echo";

export const ALL_FAMILIES: PowerFamily[] = ["blink", "boomerang", "clone", "blackhole", "orbit", "echo"];

export const MAX_INFUSIONS = 2;

export interface Build {
  main: PowerFamily | null;
  infusions: PowerFamily[]; // "secondary" powers, acquisition order, length <= MAX_INFUSIONS
  mutatedMain: boolean; // true when `main` was granted by an elite kill
}

export function emptyBuild(): Build {
  return { main: null, infusions: [], mutatedMain: false };
}

export const FAMILY_LABEL: Record<PowerFamily, string> = {
  blink: "Blink",
  boomerang: "Boomerang",
  clone: "Clone",
  blackhole: "Black Hole",
  orbit: "Orbit",
  echo: "Echo",
};

// --- Shared melee-cone constants: not a standalone attack of their own -----
// (the player starts with no attack --- the first is always stolen). Echo
// reuses these directly as its own melee-cone shape, and Clone's per-hit
// stats (CLONE_DAMAGE/CLONE_RANGE, below) alias them too.

export const BASIC_DAMAGE = 8;
export const BASIC_RANGE = 60;
export const BASIC_ARC = Math.PI / 2.6;
export const BASIC_COOLDOWN = 0.42;

// --- Blink: teleport-strike ---------------------------------------------------

export const BLINK_RANGE = 220; // max distance to a valid teleport target
export const BLINK_ARC = Math.PI / 2; // cone, centred on aim, searched for a target
export const BLINK_DISTANCE = 160; // pure-reposition distance when no target is in range
export const BLINK_STRIKE_DAMAGE = 15;
export const BLINK_STRIKE_RANGE = 52; // hit radius around the arrival point
export const BLINK_COOLDOWN = 0.6;
export const BLINK_ARRIVAL_GAP = 34; // stop just short of the target, not on top of it

// --- Boomerang: out-and-back thrown weapon -----------------------------------

export const BOOMERANG_DAMAGE = 12;
export const BOOMERANG_SPEED = 520;
export const BOOMERANG_RANGE = 260; // outbound distance before the return leg begins
export const BOOMERANG_COOLDOWN = 0.6;
export const BOOMERANG_CATCH_RADIUS = 30;
export const BOOMERANG_HIT_COOLDOWN = 0.18; // re-hit gap for the same target within one leg
export const BOOMERANG_MAX_LIFETIME = 3.2; // safety net so a missed catch can't loop forever

// --- Clone: a temporary second attacker --------------------------------------

export const CLONE_LIFETIME = 3.5;
export const CLONE_ATTACK_INTERVAL = 0.6;
export const CLONE_DAMAGE = BASIC_DAMAGE;
export const CLONE_RANGE = BASIC_RANGE;
export const CLONE_AGGRO_RANGE = 260; // how far a clone will reach to find a target
export const CLONE_COOLDOWN = 3.0;
export const CLONE_MOVE_SPEED = 170;

// --- Black Hole: delayed area-collapse trap ----------------------------------

export const BLACKHOLE_TRAVEL_SPEED = 340;
export const BLACKHOLE_MAX_RANGE = 260;
export const BLACKHOLE_PULL_DURATION = 0.7;
export const BLACKHOLE_PULL_STRENGTH = 380;
export const BLACKHOLE_RADIUS = 130;
export const BLACKHOLE_COLLAPSE_DAMAGE = 26;
export const BLACKHOLE_COOLDOWN = 1.4;
export const BLACKHOLE_RECOLLAPSE_DELAY = 0.55; // gap between Recollapse's two collapses
export const BLACKHOLE_RESIDUAL_DURATION = 1.5; // elite: lingering weak pull after the collapse
export const BLACKHOLE_RESIDUAL_STRENGTH_MULT = 0.35;

// --- Orbit: a continuous melee-range zone -------------------------------------

export const ORBIT_BLADE_COUNT = 2;
export const ORBIT_RADIUS = 55;
export const ORBIT_ROTATION_SPEED = 4.2; // radians/sec
export const ORBIT_BLADE_HIT_RADIUS = 12;
export const ORBIT_DAMAGE = 5;
export const ORBIT_HIT_COOLDOWN = 0.4; // per-target re-hit gap
export const ORBIT_PULSE_RADIUS = 96; // LMB burst when orbit is main
export const ORBIT_PULSE_DAMAGE = 14;
export const ORBIT_PULSE_COOLDOWN = 0.8;
export const ORBIT_WIDEN_MULT = 1.6; // secondary: widens while a Black Hole is active
export const ORBIT_TRAIL_INTERVAL = 0.16; // elite: how often a blade drops a trail hazard
export const ORBIT_TRAIL_RADIUS = 16;
export const ORBIT_TRAIL_DURATION = 0.3;
export const ORBIT_TRAIL_TICK_DAMAGE = 3;
export const ORBIT_FLING_DURATION = 3.0; // Flung Guard: temporary ring after a caught boomerang

// --- Echo: a delayed repeat of your own last attack ---------------------------

export const ECHO_DELAY = 0.65;
export const ECHO_DAMAGE_RATIO = 0.85; // the replay hits slightly softer than the original
export const ECHO_COOLDOWN = 0.5;

export function cooldownFor(build: Build): number {
  switch (build.main) {
    case "blink":
      return BLINK_COOLDOWN;
    case "boomerang":
      return BOOMERANG_COOLDOWN;
    case "clone":
      return CLONE_COOLDOWN;
    case "blackhole":
      return BLACKHOLE_COOLDOWN;
    case "orbit":
      return ORBIT_PULSE_COOLDOWN;
    case "echo":
      return ECHO_COOLDOWN;
    default:
      return BASIC_COOLDOWN;
  }
}

// --- Combinations --------------------------------------------------------------
//
// All 15 possible pairs among the six powers do something mechanical. Ten
// headline pairs get a fully bespoke behaviour change (never a flat number);
// the remaining five secondary pairs are lighter but still change what the
// main power's action actually does.

export type FusionId =
  | "doppelStrike"
  | "afterimage"
  | "relayThrow"
  | "piercingGuard"
  | "doubleReturn"
  | "flungGuard"
  | "gravityThrow"
  | "mirrorDelay"
  | "twinWells"
  | "recollapse";

export const FUSION_LABEL: Record<FusionId, string> = {
  doppelStrike: "Doppel Strike",
  afterimage: "Afterimage",
  relayThrow: "Relay Throw",
  piercingGuard: "Piercing Guard",
  doubleReturn: "Double Return",
  flungGuard: "Flung Guard",
  gravityThrow: "Gravity Throw",
  mirrorDelay: "Mirror Delay",
  twinWells: "Twin Wells",
  recollapse: "Recollapse",
};

export function pairKey(a: PowerFamily, b: PowerFamily): string {
  return [a, b].sort().join("+");
}

const FUSION_TABLE: Record<string, FusionId> = {
  [pairKey("blink", "clone")]: "doppelStrike",
  [pairKey("blink", "echo")]: "afterimage",
  [pairKey("blink", "boomerang")]: "relayThrow",
  [pairKey("blink", "orbit")]: "piercingGuard",
  [pairKey("boomerang", "echo")]: "doubleReturn",
  [pairKey("boomerang", "orbit")]: "flungGuard",
  [pairKey("boomerang", "blackhole")]: "gravityThrow",
  [pairKey("clone", "echo")]: "mirrorDelay",
  [pairKey("clone", "blackhole")]: "twinWells",
  [pairKey("blackhole", "echo")]: "recollapse",
};

export function fusionFor(a: PowerFamily, b: PowerFamily): FusionId | null {
  if (a === b) return null;
  return FUSION_TABLE[pairKey(a, b)] ?? null;
}

// The 10 headline pairs, exported so run-generation (enemies.ts) can pick
// one at random and guarantee it's reachable, without redeclaring a second
// list that could drift out of sync with FUSION_TABLE above.
export const HEADLINE_PAIRS: [PowerFamily, PowerFamily][] = [
  ["blink", "clone"],
  ["blink", "echo"],
  ["blink", "boomerang"],
  ["blink", "orbit"],
  ["boomerang", "echo"],
  ["boomerang", "orbit"],
  ["boomerang", "blackhole"],
  ["clone", "echo"],
  ["clone", "blackhole"],
  ["blackhole", "echo"],
];

// Every fusion the current build has active --- main pairs against each
// infusion independently, so two secondaries can each contribute their own
// fusion behaviour at once.
export function activeFusions(build: Build): FusionId[] {
  if (!build.main) return [];
  const fusions: FusionId[] = [];
  for (const infusion of build.infusions) {
    const fusion = fusionFor(build.main, infusion);
    if (fusion) fusions.push(fusion);
  }
  return fusions;
}

export function hasFusion(build: Build, fusion: FusionId): boolean {
  return activeFusions(build).includes(fusion);
}

// Secondary powers not part of a named headline fusion with the current main
// still do something --- see the five secondary pairs handled directly in
// game.ts's performAttack --- so no combination is a complete no-op.
export function secondaryFamilies(build: Build): PowerFamily[] {
  if (!build.main) return [];
  const main = build.main;
  return build.infusions.filter((infusion) => !fusionFor(main, infusion));
}

export function hasFamily(build: Build, family: PowerFamily): boolean {
  return build.main === family || build.infusions.includes(family);
}

// --- Build decisions ----------------------------------------------------------

export interface DecisionOptions {
  replace: Build;
  infuse: Build;
}

export function alreadyHas(build: Build, family: PowerFamily): boolean {
  return hasFamily(build, family);
}

// Acquiring a new power always presents a fast two-card choice: REPLACE (the
// new power becomes main, secondaries reset) or COMBINE (it attaches as a
// secondary; a full secondary set drops its oldest entry to make room).
export function decisionOptions(build: Build, family: PowerFamily, elite: boolean): DecisionOptions {
  const replace: Build = { main: family, infusions: [], mutatedMain: elite };
  const infusions =
    build.infusions.length < MAX_INFUSIONS ? [...build.infusions, family] : [...build.infusions.slice(1), family];
  const infuse: Build = { main: build.main, infusions, mutatedMain: build.mutatedMain };
  return { replace, infuse };
}
