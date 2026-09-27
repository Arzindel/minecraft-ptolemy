'use strict';

const { FORWARD, turnLeft, turnRight } = require('./pose');

// Defaults; the live values come from the Configuration tab (src/settings.js).
// Flying: every move costs 1. Walking: entering a cell costs by what holds the robot up there, as
// if it walked and climbed; a cell takes the cost of its best support. Water is like air: the robot
// is heavy and walks along the bottom, so a lakebed step costs a ground step. (A water surcharge would
// also make every re-plan slide onto riverbed nobody has checked yet.) Stepping into a cell nobody
// has seen costs `unknownPenalty` more,
// so known routes win when they're about as short, but unknown cells are still allowed
// (optimistic planning: the walker rescans before entering them).
const DEFAULT_COSTS = { ground: 1, wall: 5, groundEdge: 3, wallDiagonal: 8, groundCorner: 10,
  ceiling: 15, ceilingEdge: 20, ceilingCorner: 20, airborne: 40 };
// Support category of a solid neighbour at offset (dx, dy, dz), by how much it touches the cell.
function supportFrom(dx, dy, dz) {
  const sideways = Math.abs(dx) + Math.abs(dz);
  if (dy < 0) return ['ground', 'groundEdge', 'groundCorner'][sideways];
  if (dy > 0) return ['ceiling', 'ceilingEdge', 'ceilingCorner'][sideways];
  return sideways === 1 ? 'wall' : 'wallDiagonal';
}
// Searches tried in turn, each with a budget of expanded states. The distance estimate assumes every
// step costs the cheapest price, but climbing, hugging walls and turning cost more, so an exact
// search (weight 1) can run out of budget trying every detour that might be cheaper. Each next
// search trusts the estimate `weight` times more: a route at most that many times dearer than the
// best, found much faster. Only a very greedy one (weight 8) wanders.
// Measured on 60-block trips: exact takes 1-3 s, weight 2 finds the same route in 0.05-0.2 s.
const SEARCHES = [
  { weight: 1, expansions: 10000 },
  { weight: 2, expansions: 100000 },
  { weight: 3, expansions: 200000 },
  { weight: 8, expansions: 400000 },
];
const SEARCH_MARGIN = 48;
const TIE_BREAK = 1.001;
// A step that costs this much more than planned contradicts the plan (e.g. wall support, 5, gone:
// airborne, 40).
const STEP_CONTRADICTION = 10;
// How far (in columns) a surface trip borrows the measured ground height for columns not surveyed.
const GUESS_REACH = 16;
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 319;

const FLOOD_LIMIT = 50000;

/**
 * How much entering each cell costs, as the planner sees it (see planPath's options). `box` is the
 * area whose columns get ground guesses precomputed ({ x0, z0, x1, z1 }). Returns { state, unseen,
 * supportCost, enter }: enter(x, y, z) is the cost of stepping into a cell (Infinity if solid).
 */
function costModel(world, box, { hug = false, costs = DEFAULT_COSTS, unknownPenalty = 0.5, underground = true } = {}) {
  // With `underground: false` (a trip over the surface, after a ground survey), unseen cells are
  // guessed from the ground measured in their column, or in the nearest column measured within
  // GUESS_REACH: below the ground they count as solid (ground has no holes to walk into from the
  // side), above it they are 'guess', free and priced by what would hold the robot up there, like
  // seen cells. Without this, unseen cells priced as flat ground at any height were cheaper than the
  // real, bumpy ground next to them: the planner tunnelled through riverbanks and floated along
  // just outside the surveyed strip.
  // Nearest measured ground for every column of the search box, by a flood fill from the columns a
  // survey measured, up to GUESS_REACH columns away (NONE beyond).
  const NONE = -9999;
  const GX = box.x1 - box.x0 + 1;
  const NZ = box.z1 - box.z0 + 1;
  let groundGrid = null;
  const groundNear = (x, z) => {
    if (!groundGrid) groundGrid = nearestGround();
    const ix = x - box.x0;
    const iz = z - box.z0;
    if (ix < 0 || iz < 0 || ix >= GX || iz >= NZ) return world.groundY(x, z);
    const g = groundGrid[ix * NZ + iz];
    return g === NONE ? null : g;
  };
  function nearestGround() {
    const grid = new Int32Array(GX * NZ).fill(NONE);
    let frontier = [];
    world.forEachGround(box.x0, box.z0, box.x0 + GX - 1, box.z0 + NZ - 1, (x, z, y) => {
      const i = (x - box.x0) * NZ + (z - box.z0);
      grid[i] = y;
      frontier.push(i);
    });
    for (let d = 1; d <= GUESS_REACH && frontier.length; d++) {
      const next = [];
      for (const i of frontier) {
        const ix = (i - (i % NZ)) / NZ;
        const iz = i % NZ;
        for (const [jx, jz] of [[ix + 1, iz], [ix - 1, iz], [ix, iz + 1], [ix, iz - 1]]) {
          if (jx < 0 || jz < 0 || jx >= GX || jz >= NZ) continue;
          const j = jx * NZ + jz;
          if (grid[j] !== NONE) continue;
          grid[j] = grid[i];
          next.push(j);
        }
      }
      frontier = next;
    }
    return grid;
  }
  const state = underground || !world.forEachGround ? (x, y, z) => world.state(x, y, z) : (x, y, z) => {
    const s = world.state(x, y, z);
    if (s !== 'unknown') return s;
    const g = groundNear(x, z);
    if (g === null) return s;
    return y <= g ? 'solid' : 'guess';
  };
  const unseen = (st) => st === 'unknown' || st === 'guess';
  // Cost of entering a cell when walking: its best support, counting only blocks known to be solid.
  // An unseen cell costs a plain ground step (plus unknownPenalty, added by the search): nothing is
  // known about the terrain there, so the planner assumes it can be walked, whatever its height.
  // Guessing the terrain instead (e.g. "flat, as far as it was seen") made every unseen cell off that
  // guess cost the airborne price, so a target a few blocks higher or lower than the ground at the
  // edge of Sight looked like a long flight and the search ran out of budget before finding any
  // route. The walker rescans before entering unseen cells and re-plans with what's actually there,
  // so a cliff or a hill past the edge of Sight is found and handled as soon as the robot gets near.
  const supportCache = new Map();
  const supportCost = (x, y, z) => {
    const k = ((x + 2 ** 21) * 2 ** 22 + (z + 2 ** 21)) * 512 + (y + 64);
    if (supportCache.has(k)) return supportCache.get(k);
    let best = costs.airborne;
    if (state(x, y, z) === 'unknown') {
      best = costs.ground;
    } else {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if ((dx || dy || dz) && state(x + dx, y + dy, z + dz) === 'solid') {
              best = Math.min(best, costs[supportFrom(dx, dy, dz)]);
            }
          }
        }
      }
    }
    supportCache.set(k, best);
    return best;
  };

  const enter = (x, y, z) => {
    const here = state(x, y, z);
    if (here === 'solid') return Infinity;
    return (hug ? supportCost(x, y, z) : 1) + (unseen(here) ? unknownPenalty : 0);
  };
  return { state, unseen, supportCost, enter };
}

/**
 * What each of a plan's `steps` costs with what is known now (Infinity for a step into a solid
 * cell). Compared with what they cost when planned, it says whether new information changed the
 * picture: see contradicts().
 */
function pathCosts(world, steps, { turnCost = 1, ...options } = {}) {
  const cells = steps.filter((s) => s.enters).map((s) => s.enters);
  if (!cells.length) return steps.map(() => turnCost);
  const pad = GUESS_REACH + 2;
  const box = {
    x0: Math.min(...cells.map((c) => c[0])) - pad, x1: Math.max(...cells.map((c) => c[0])) + pad,
    z0: Math.min(...cells.map((c) => c[2])) - pad, z1: Math.max(...cells.map((c) => c[2])) + pad,
  };
  const model = costModel(world, box, options);
  return steps.map((s) => (s.enters ? model.enter(...s.enters) : turnCost));
}

/**
 * Does what is known now contradict a plan? Yes if a cell it goes into is solid, if a step got
 * much dearer than planned (the wall or ground it leaned on isn't there: it would be flying), or if
 * the whole walk did. New information that only confirms the plan (or makes it cheaper) doesn't:
 * then the plan stands, and nothing is planned again.
 */
function contradicts(world, plan, options) {
  const now = pathCosts(world, plan.steps, options);
  let before = 0;
  let after = 0;
  for (let i = 0; i < now.length; i++) {
    if (now[i] === Infinity) return 'something solid is in the way';
    if (now[i] > plan.steps[i].cost + STEP_CONTRADICTION) return 'a step lost what would hold the robot up there';
    before += plan.steps[i].cost;
    after += now[i];
  }
  return after > before * 1.25 + 2 ? 'the way turned out much harder than planned' : null;
}

/**
 * Plan a route for the agent (a 1x1x1 flyer) from `start` ({x, y, z, facing}) to a goal.
 *
 * The goal is { x, y, z } (end exactly there) or { x, y, z, cells } (end on any of those cells,
 * e.g. the cells around a player or around a solid block). With `goal.arrival` (a Map of
 * "x,y,z" -> cost), ending on a cell costs that much extra, plus `finalMultiplier` times what
 * standing there costs (its walking support cost: ground 1, wall 5, midair 40...), so the route
 * prefers to end close to the target, standing on solid ground.
 *
 * The agent always faces where it travels: horizontal moves are `move forward`, preceded by
 * turns. Vertical moves don't need turning.
 *
 * Returns { steps, cells, unknownSteps } or { error }.
 */
function planPath(world, start, goal, {
  hug = false, costs = DEFAULT_COSTS, turnCost = 1, unknownPenalty = 0.5, finalMultiplier = 10, underground = true,
  searches = SEARCHES,
} = {}) {
  // Keep the search inside a box around the start and the goal, with room for detours (the map may
  // know the whole world the robot has seen, far more than a search should wander through).
  const lo = [Math.min(start.x, goal.x), Math.min(start.y, goal.y), Math.min(start.z, goal.z)];
  const hi = [Math.max(start.x, goal.x), Math.max(start.y, goal.y), Math.max(start.z, goal.z)];
  const margin = Math.max(SEARCH_MARGIN, Math.ceil(Math.max(hi[0] - lo[0], hi[2] - lo[2]) / 2));
  // Numeric indices for cells (and cell + facing states): much faster map keys than strings. The
  // index box is the search box padded by 2, so neighbours of cells in the search box fit too.
  const bx = lo[0] - margin - 2;
  const by = Math.max(WORLD_MIN_Y, lo[1] - margin) - 2;
  const bz = lo[2] - margin - 2;
  const NY = Math.min(WORLD_MAX_Y, hi[1] + margin) + 2 - by + 1;
  const NZ = hi[2] + margin + 2 - bz + 1;
  const cellIndex = (x, y, z) => ((x - bx) * NY + (y - by)) * NZ + (z - bz);
  const inBox = (x, y, z) => x >= lo[0] - margin && x <= hi[0] + margin
    && z >= lo[2] - margin && z <= hi[2] + margin
    && y >= Math.max(WORLD_MIN_Y, lo[1] - margin) && y <= Math.min(WORLD_MAX_Y, hi[1] + margin);

  const GX = hi[0] + margin + 2 - bx + 1; // columns along x in the index box
  const model = costModel(world, { x0: bx, z0: bz, x1: bx + GX - 1, z1: bz + NZ - 1 },
    { hug, costs, unknownPenalty, underground });
  const { state, unseen, supportCost } = model;
  // Cheapest possible move, so the distance estimate never overestimates (keeps A* optimal).
  const cheapest = hug ? Math.min(...Object.values(costs)) : 1;
  const goalCells = goal.cells || [[goal.x, goal.y, goal.z]];
  const goalKeys = new Set(goalCells.map((c) => c.join(',')));
  const isGoal = (x, y, z) => goalKeys.has(`${x},${y},${z}`);
  const slack = Math.max(...goalCells.map(([x, y, z]) => Math.abs(x - goal.x) + Math.abs(y - goal.y) + Math.abs(z - goal.z)));
  const heuristic = (x, y, z) => cheapest * Math.max(0,
    Math.abs(x - goal.x) + Math.abs(y - goal.y) + Math.abs(z - goal.z) - slack);

  const open = goalCells.filter(([x, y, z]) => state(x, y, z) !== 'solid');
  if (!open.length) {
    return { error: goal.cells ? 'every cell next to the target is solid' : `${goal.x} ${goal.y} ${goal.z} is a solid block` };
  }
  const arrival = goal.arrival || null;
  if (!arrival && isGoal(start.x, start.y, start.z)) return { steps: [], cells: [[start.x, start.y, start.z]], unknownSteps: 0 };
  const isStart = (x, y, z) => x === start.x && y === start.y && z === start.z;
  if (isSealed(world, open, isStart)) {
    return { error: 'the target is sealed in: every way to it is blocked by known solid blocks' };
  }
  if (isSealed(world, [[start.x, start.y, start.z]], isGoal)) {
    return { enclosed: true, error: 'the robot is boxed in: every way out of where it is is blocked by known solid blocks, '
      + 'so it can\'t get anywhere without breaking one' };
  }

  // Extra cost of ending on a goal cell (0 without arrival costs).
  const endCost = (x, y, z) => (arrival ? (arrival.get(`${x},${y},${z}`) || 0) + finalMultiplier * supportCost(x, y, z) : 0);

  const stateKey = (x, y, z, f) => cellIndex(x, y, z) * 4 + f;
  const decode = (k) => {
    const facing = k % 4;
    let c = (k - facing) / 4;
    const z = (c % NZ) + bz;
    c = (c - (c % NZ)) / NZ;
    const y = (c % NY) + by;
    const x = (c - (c % NY)) / NY + bx;
    return { x, y, z, facing };
  };
  const ACTIONS = ['forward', 'up', 'down', 'turn right', 'turn left'];
  let result = { gaveUp: true };
  let stage = -1;
  while (result.gaveUp && ++stage < searches.length) {
    result = search(searches[stage].weight, searches[stage].expansions);
    if (process.env.PTOLEMY_DEBUG_SEARCH) console.log(`  search weight ${searches[stage].weight}: ${result.gaveUp ? 'gave up' : `done in ${result.expansions} expansions`}`);
  }
  const approximate = stage > 0 && searches[stage] ? searches[stage].weight : false;
  if (result.gaveUp) return { error: 'search gave up (the area is too large or too maze-like)' };
  const { reached, cameFrom, bestCost } = result;
  if (reached === null || reached === undefined) {
    return { error: 'the target cannot be reached' };
  }

  // A* over (cell, facing) states. The heap holds state keys (a finish option as -(key + 1)); where
  // each state came from is packed as fromKey * 8 + action.
  function search(weight, maxExpansions) {
    const startKey = stateKey(start.x, start.y, start.z, start.facing);
    const cameFrom = new Map([[startKey, -1]]);
    const bestCost = new Map([[startKey, 0]]);
    const queue = new MinHeap();
    queue.push(weight * heuristic(start.x, start.y, start.z), startKey);

    let expansions = 0;
    while (queue.size) {
      const k = queue.pop();
      // Ending here was the cheapest option left: done.
      if (k < 0) return { reached: -k - 1, cameFrom, bestCost, expansions };
      const node = decode(k);
      const cost0 = bestCost.get(k);
      if (isGoal(node.x, node.y, node.z)) {
        // Without arrival costs the first goal cell reached is the answer. With them, stopping here
        // becomes one more option in the queue, priced with its arrival cost; the search goes on in
        // case a better place to stop is still ahead.
        if (!arrival) return { reached: k, cameFrom, bestCost, expansions };
        queue.push(cost0 + endCost(node.x, node.y, node.z), -k - 1);
      }
      if (++expansions > maxExpansions) return { gaveUp: true };

      const [fx, , fz] = FORWARD[node.facing];
      for (let a = 0; a < 5; a++) {
        let { x, y, z, facing } = node;
        let cost = cost0;
        if (a >= 3) {
          facing = a === 3 ? turnRight(facing) : turnLeft(facing);
          cost += turnCost;
        } else {
          if (a === 0) { x += fx; z += fz; } else y += a === 1 ? 1 : -1;
          if (!inBox(x, y, z)) continue;
          const here = state(x, y, z);
          if (here === 'solid') continue;
          cost += hug ? supportCost(x, y, z) : 1;
          if (unseen(here)) cost += unknownPenalty;
        }
        const nk = stateKey(x, y, z, facing);
        const known = bestCost.get(nk);
        if (known !== undefined && known <= cost) continue;
        bestCost.set(nk, cost);
        cameFrom.set(nk, k * 8 + a);
        // Ties (common: many routes cost the same) go to the state closer to the goal.
        queue.push(cost + weight * heuristic(x, y, z) * TIE_BREAK, nk);
      }
    }
    return { reached: null, cameFrom };
  }

  // Walk back from the goal, then turn the chain into commands with the pose expected after each.
  const chain = [];
  for (let k = reached; cameFrom.get(k) !== -1; ) {
    const link = cameFrom.get(k);
    const from = (link - (link % 8)) / 8;
    chain.push({ action: ACTIONS[link % 8], expect: decode(k), cost: bestCost.get(k) - bestCost.get(from) });
    k = from;
  }
  chain.reverse();

  const steps = chain.map(({ action, expect, cost }) => ({
    action,
    cost, // what this step cost when planned, to tell later whether new information changed it
    command: action.startsWith('turn') ? `agent ${action}` : `agent move ${action}`,
    expect,
    enters: action.startsWith('turn') ? null : [expect.x, expect.y, expect.z],
    unknown: !action.startsWith('turn') && world.state(expect.x, expect.y, expect.z) === 'unknown',
  }));
  const cells = [[start.x, start.y, start.z], ...steps.filter((s) => s.enters).map((s) => s.enters)];
  return { steps, cells, unknownSteps: steps.filter((s) => s.unknown).length, approximate, cost: bestCost.get(reached) };
}

/**
 * Flood outwards from some cells through free cells. If the fill runs out without touching an
 * unknown cell or a cell where `reached` is true, those cells are sealed off (the goal from the
 * robot, or the robot from the goal) and searching for a route is pointless.
 */
function isSealed(world, fromCells, reached) {
  const seen = new Set(fromCells.map((c) => c.join(',')));
  const stack = [...fromCells];
  while (stack.length) {
    const [x, y, z] = stack.pop();
    if (reached(x, y, z)) return false;
    const state = world.state(x, y, z);
    if (state === 'unknown') return false;
    if (seen.size > FLOOD_LIMIT) return false; // big open area: let the search decide
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = [x + dx, y + dy, z + dz];
      const k = n.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      if (world.state(...n) !== 'solid') stack.push(n);
    }
  }
  return true;
}

/** "forward ×3, turn left, up ×2" */
function summarizeSteps(steps) {
  const parts = [];
  for (const { action } of steps) {
    const last = parts[parts.length - 1];
    if (last && last.action === action) last.count++;
    else parts.push({ action, count: 1 });
  }
  return parts.map(({ action, count }) => (count > 1 ? `${action} ×${count}` : action)).join(', ');
}

/** A binary min-heap of numbers by priority, in two parallel arrays (no object per entry). */
class MinHeap {
  constructor() {
    this.prio = [];
    this.vals = [];
  }

  get size() { return this.vals.length; }

  push(priority, value) {
    const { prio, vals } = this;
    let i = vals.length;
    prio.push(priority);
    vals.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent] <= priority) break;
      prio[i] = prio[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    prio[i] = priority;
    vals[i] = value;
  }

  pop() {
    const { prio, vals } = this;
    const top = vals[0];
    const lastP = prio.pop();
    const lastV = vals.pop();
    const n = vals.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && prio[r] < prio[l] ? r : l;
        if (prio[m] >= lastP) break;
        prio[i] = prio[m];
        vals[i] = vals[m];
        i = m;
      }
      prio[i] = lastP;
      vals[i] = lastV;
    }
    return top;
  }
}

/** Goal cells around a block: its 26 neighbours. */
function cellsAround(x, y, z) {
  const cells = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) cells.push([x + dx, y + dy, z + dz]);
    }
  }
  return cells;
}

module.exports = { planPath, pathCosts, contradicts, summarizeSteps, cellsAround, DEFAULT_COSTS, supportFrom };
