# Crit 5 Reflection

## What was the breakthrough that moved the work forward?

The breakthrough was realising that adding more systems did not automatically make the game more interesting. My early direction had a clear steal mechanic, but playing it repeatedly showed that the interaction could become mechanical rather than exciting. I initially responded with more enemies, powers, combinations and roguelike structure, but complexity alone did not solve the problem.

The important change was to stop thinking about powers mainly as upgrades and start thinking about them as actions. I replaced conventional status-style effects with Blink, Boomerang, Clone, Black Hole, Orbit and Echo. That gave me a better question for judging each ability: does acquiring this change what the player actually does?

## What did this work change about who I want to be as a software developer?

This project made me less willing to treat a working implementation as evidence that a design works. Automated tests could confirm game rules and protect the large power rewrite, but they could not tell me whether stealing felt satisfying or whether a player could understand an execution.

My final playtesting exposed exactly that difference. The execution rule worked as implemented, yet I still found it confusing and unsatisfying. I want to become more comfortable recognising that as a design failure rather than defending technically correct code. I also want to test the central interaction earlier, before investing heavily in systems around it.
