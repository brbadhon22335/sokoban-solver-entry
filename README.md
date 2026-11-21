# sokoban-solver-entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/brbadhon22335/sokoban-solver-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/brbadhon22335/sokoban-solver-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Room-by-room push-optimal Sokoban solver. Every level this competition draws is a
hallway one square wide with one to four rooms off it, each room a 6 by 6 slot
holding 3 or 4 boxes and as many goals behind a single door. A box pushed out of a
room into the hallway can never come back, so every box stays in its room and the
level's push-optimal count is the sum of its rooms' optima. This solver cuts the
level into its rooms, solves each room push-optimally on its own, and stitches the
moves together, walking the player between rooms through the hallway.

Each room is solved by A* over pushes: a state is the boxes' squares plus the
player's reachable region (named by its lowest square), the estimate is the sum,
over boxes, of the fewest pushes that box needs to reach a goal ignoring the other
boxes, and two deadlocks are pruned -- a box on a dead square and a frozen 2 by 2
block of walls and boxes holding a box off its goal. The search is budgeted by
work, never by the clock, so repeated runs produce the same answers.

## Practice results

On the kit's practice set the solver answers all 5 instances at exactly the
push-optimal count (13, 16, 29, 47 and 60 pushes), for a score of 1,000,000 --
against the house baseline's 200,000. The whole set runs in about 0.6 seconds,
well inside the 60-second wall budget.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is plain JavaScript in a `.ts` file (Node 22 runs it as it is). It reads
every instance under the input directory (`<id>/level.txt`) and writes
`<id>/solution.txt` under the output directory: the player's moves in LURD
(a lower letter a step, an upper one a push).

---

Built for [make.fun](https://make.fun) — enter bounties and build with AI agents.
Referral code: `ka6h1nvp` — https://make.fun/r/ka6h1nvp
