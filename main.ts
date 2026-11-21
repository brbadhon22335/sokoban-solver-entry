// Room-by-room push-optimal Sokoban solver.
//
// The levels this competition draws are a hallway one square wide with one to four
// rooms off it, each room a 6 by 6 slot holding 3 or 4 boxes and as many goals, joined
// to the hallway by a single door. A box pushed out of a room into the hallway can
// never come back, so every box stays in its room and the level's push-optimal count
// is the sum of its rooms' optima. This solver therefore:
//
//   1. cuts the level into rooms (the hallway's dead squares, which no box can be
//      pushed from onto a goal, split the board into its rooms),
//   2. solves each room push-optimally on its own, with the other rooms' boxes
//      standing as walls, and
//   3. stitches the rooms' move strings together, walking the player between rooms
//      through the hallway.
//
// Each room is solved by A* over pushes (not moves): a state is the boxes' squares
// plus the player's reachable region (named by its lowest square, which identifies
// the region, since regions are disjoint connected components of the open floor).
// The estimate is the sum, over boxes, of the fewest pushes that box needs to reach
// a goal ignoring the other boxes -- an admissible, consistent heuristic, so the
// first solved state A* pops is push-optimal. Two deadlocks are pruned, neither of
// which can prune a solvable state: a box on a dead square (one from which no push,
// ignoring the other boxes, reaches a goal) and a frozen 2 by 2 block of walls and
// boxes holding a box off its goal.
//
// Everything is budgeted by work, never by the clock: the search caps are counts of
// states, the tie-breaking is fixed, and there is no randomness, so the two graded
// runs of this program produce the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: [dx, dy, walk letter, push letter]. This order is the tie-break order
// for walks and for the order pushes are tried.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work caps, in states kept. A room the generator draws is solvable within 250,000
// states, and A* with the estimate below expands a subset of a plain breadth-first
// search's states, so a room's optimal search fits this cap.
const MAX_STATES_PER_ROOM = 250000;
const MAX_STATES_WHOLE = 200000;
// The fallback search's weight: a weighted A* that finds a (possibly non-optimal)
// solution fast when the optimal search gives up.
const FALLBACK_WEIGHT = 4;

/** A level: width, height, walls (1 is a wall), goals, boxes (sorted), player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For every square, the fewest pushes that move a box from it onto a goal, ignoring
 * the other boxes (-1 where no push sequence reaches a goal: a dead square).
 * A push moves a box from y to x = y + d only when the player can stand at y - d,
 * so walking backwards from the goals: from a square x at distance n, the square
 * y = x - d is at distance n + 1 when y and y - d are both open floor.
 */
function pushDistances(w, wall, goals) {
  const size = wall.length;
  const dist = new Int32Array(size).fill(-1);
  const queue = [];
  for (const g of goals) {
    dist[g] = 0;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (y < 0 || y >= size || wall[y]) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size || wall[behind]) continue;
      if (dist[y] >= 0) continue;
      dist[y] = dist[x] + 1;
      queue.push(y);
    }
  }
  return dist;
}

/**
 * The lowest square of the region the player reaches from `from` around walls and
 * the boxes in `occupied`, flood-filling with `stamp` in `seen` (so the caller can
 * test whether a square lies in this region by `seen[square] === stamp`).
 */
function regionLow(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const down = p + w;
    const left = p - 1;
    const right = p + 1;
    if (!wall[up] && !occupied[up] && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    if (!wall[down] && !occupied[down] && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    if (!wall[left] && !occupied[left] && seen[left] !== stamp) {
      seen[left] = stamp;
      stack[n++] = left;
    }
    if (!wall[right] && !occupied[right] && seen[right] !== stamp) {
      seen[right] = stamp;
      stack[n++] = right;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 by 2 block: four squares
 * of walls and boxes, one of them a box off its goal. A box in such a block can
 * never be pushed again, so the state is dead.
 */
function frozenBlock(w, wall, occupied, goal, t) {
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower letters. */
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (lower letters) from `from`. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The push-optimal solution of `level` (or a weighted, possibly non-optimal one
 * when `weight` is above 1), searching at most `maxStates` states: {pushes, moves}
 * with moves in LURD (a lower letter a step, an upper one a push), or null when the
 * search gives up. With weight 1 the estimate is admissible and consistent, so the
 * first solved state popped is push-optimal.
 */
function solvePush(level, maxStates, weight) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = pushDistances(w, wall, goals);
  const boxes0 = level.boxes.slice().sort((a, b) => a - b);
  if (boxes0.some((b) => dist[b] < 0)) return null;
  const solved = (bs) => bs.every((b) => goal[b]);
  if (solved(boxes0)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states in the order found: their boxes, the player's square, pushes and
  // estimate so far, parent, and the push that made them from their parent.
  const sBoxes = [boxes0];
  const sPlayer = [level.player];
  const sG = [0];
  const sH = [boxes0.reduce((a, b) => a + dist[b], 0)];
  const sKey = [];
  const parent = [-1];
  const pushFrom = [-1];
  const pushTo = [-1];
  const pushDir = [-1];
  const keyOf = (bs, low) => `${low}|${bs.join(',')}`;

  for (const b of boxes0) occupied[b] = 1;
  const low0 = regionLow(w, wall, occupied, level.player, seen, ++stamp, stack);
  for (const b of boxes0) occupied[b] = 0;
  sKey.push(keyOf(boxes0, low0));
  const best = new Map([[sKey[0], 0]]);

  // The open list: a binary heap on f = g + weight * h, ties to the deeper state
  // (larger g), then to the earlier state, so the order is fixed.
  const heap = [[sH[0] * weight, 0, 0]];
  const less = (a, b) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const tmp = heap[i];
      heap[i] = heap[p];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const tmp = heap[i];
        heap[i] = heap[c];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  while (heap.length > 0 && found < 0) {
    const [, g, s] = heapPop();
    if (best.get(sKey[s]) < g) continue; // a better path to this state exists
    const boxes = sBoxes[s];
    for (const b of boxes) occupied[b] = 1;
    regionLow(w, wall, occupied, sPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        if (seen[b - d] !== here) continue; // the player cannot reach the push square
        if (wall[t] || occupied[t] || dist[t] < 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let next = null;
        let key = '';
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          low = regionLow(w, wall, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const g2 = g + 1;
        const known = best.get(key);
        if (known !== undefined && known <= g2) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g2);
        const h2 = sH[s] - dist[b] + dist[t];
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(g2);
        sH.push(h2);
        sKey.push(key);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        pushDir.push(k);
        if (solved(next)) {
          found = sBoxes.length - 1;
          break;
        }
        heapPush([g2 + weight * h2, g2, sBoxes.length - 1]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice().sort((a, b) => a - b);
  for (const s of path) {
    const nextBoxes = sBoxes[s];
    const from = pushFrom[s];
    const to = pushTo[s];
    const k = pushDir[s];
    const d = DIRS[k][1] * w + DIRS[k][0];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[k][3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box
 * there reaches no goal) out of the floor, and each part left that holds a box is a
 * room, its squares, boxes and goals. Null when some part holds more or fewer boxes
 * than goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const dist = pushDistances(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && dist[i] < 0) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k][1] * w + DIRS[k][0];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the
 * other rooms' boxes standing as walls (on their goals once their room is done),
 * the player walking on from where the last room left it. A box never leaves its
 * room, so the rooms' optima add up to the level's: {pushes, moves}, or null when
 * a room's search gives up.
 */
function solveByRooms(level) {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done = new Set();
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (let rj = 0; rj < rooms.length; rj++) {
      if (rj === ri) continue;
      const other = rooms[rj];
      const at = done.has(rj) ? other.goals : other.boxes;
      for (const b of at) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = solvePush(sub, MAX_STATES_PER_ROOM, 1);
    if (solved === null) solved = solvePush(sub, MAX_STATES_PER_ROOM, FALLBACK_WEIGHT);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done.add(ri);
  }
  return { pushes, moves };
}

/** The moves for one level: room by room, or over the whole level as a fallback. */
function solveLevel(text) {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePush(level, MAX_STATES_WHOLE, 1) ?? solvePush(level, MAX_STATES_WHOLE, FALLBACK_WEIGHT);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
