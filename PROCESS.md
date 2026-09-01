# Process overview

I developed STEAL through repeated playable iterations rather than deciding the complete game up front. The main direction came from comparing what worked technically with what was actually understandable and enjoyable when played. The project moved from a simple combat idea toward a short action roguelike built around taking enemy abilities, combining them, and adapting a build during a run.

## What I built

**STEAL** is a small browser action game in which enemies are both threats and sources of abilities. The player fights enemies and steals powers that become part of the current build. The final submitted system uses six action-based powers — Blink, Boomerang, Clone, Black Hole, Orbit and Echo — with mechanical interactions between them, encounter variation, elites and a boss that can steal power back from the player. Rather than using a conventional upgrade-card system, I wanted the enemies themselves to expose the possibilities of a run: seeing what an enemy can do also shows the player what they might be able to take.

## The moments that mattered

### 1. Realising that more systems were not making the game more interesting

The early direction relied heavily on dash combat and then experimented with more conventional powers and build mechanics. Playing those versions exposed a problem that was difficult to see from the implementation alone: the game could contain more mechanics while still feeling repetitive. Dash could dominate combat, enemies were easy to read without being interesting to fight, and acquiring another status-style power did not necessarily change how I wanted to play.

Instead of continuing to add content around that structure, I changed the question I was asking from "how many powers are there?" to "does taking this power change what I actually do?" That became the basis for the major power-system rewrite.

This was judged primarily through repeated play rather than code inspection: the earlier systems functioned, but I still had little desire to start another run.

**Evidence:** [`bbb2367`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-chaliang407/commit/bbb2367)

### 2. Rebuilding stolen powers around actions rather than attributes

The major implementation change was replacing conventional elemental/status-style abilities with six powers based around different actions: Blink, Boomerang, Clone, Black Hole, Orbit and Echo. The aim was for stealing something to change positioning, timing or attack behaviour rather than primarily changing damage numbers.

I also treated combinations as mechanical interactions rather than percentage upgrades. This made the roguelike idea depend on which behaviours the player could combine during a particular run, while keeping enemies as the source of those possibilities.

Because this rewrite touched multiple connected systems, I used the automated checks to catch deterministic regressions while integrating it. The implementation was not accepted simply because the new types compiled; the repository checks had to return green after the game, rendering, enemy and power systems were brought back into agreement.

**Evidence:** [`bbb2367`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-chaliang407/commit/bbb2367)

### 3. Redesigning execution after playing the finished interaction

My most useful late playtest came after the larger power rewrite. The execution/STEAL interaction was still difficult to understand and did not feel satisfying. I repeatedly tried to dash into the first enemy without understanding why it would not die. Inspecting the implementation afterward clarified the problem: enemies were being held at a special execution state, but the player-facing interaction did not communicate that state clearly enough.

Instead of treating this as a visual-polish problem, I changed the execution structure around BREAK and STEAL. The opening now accounts for the player beginning without an attack, and vulnerable power-carrying enemies communicate a distinct BREAK state before a successful dash extracts their power. This makes STEAL a readable opportunity and payoff rather than only a hidden HP condition.

This change came directly from playing the game rather than reading its code. After implementing it, I playtested the new interaction and ran the full repository checks. Typechecking and the production build passed, and all 28 automated tests were green.

**Evidence:** [`6f2ffe1`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-chaliang407/commit/6f2ffe1)

## Before you ship

The final implementation was playtested after the BREAK/STEAL redesign and checked with the repository's automated checks. The final check passed typechecking, the production build, and all 28 tests. `pnpm check:evidence` was also used to verify that the process citations and Crit 5 reflection were present and traceable.
