'use strict';

const { FORWARD, turnLeft, turnRight } = require('./pose');

// Defaults; the live values come from the Configuration tab (src/settings.js).
// Flying: every move costs 1. Walking: entering a cell costs by what holds the robot up there, as
// if it walked, swam and climbed; a cell takes the cost of its best support, and a cell in water
// always costs the water price. Stepping into a cell nobody has seen costs `unknownPenalty` more,
// so known routes win when they're about as short, but unknown cells are still allowed
// (optimistic planning: the walker rescans before entering them).
const DEFAULT_COSTS = { ground: 1, water: 5, wall: 5, groundEdge: 3, wallDiagonal: 8, groundCorner: 10,
  ceiling: 15, ceilingEdge: 20, ceilingCorner: 20, airborne: 40 };
// Support category of a solid neighbour at offset (dx, dy, dz), by how much it touches the cell.
function supportFrom(dx, dy, dz) {
  const sideways = Math.abs(dx) + Math.abs(dz);
  if (dy < 0) return ['ground', 'groundEdge', 'groundCorner'][sideways];
  if (dy > 0) return ['ceiling', 'ceilingEdge', 'ceilingCorner'][sideways];
  return sideways === 1 ? 'wall' : 'wallDiagonal';
}
// The exact search gets a budget; if it runs out (usually because every route is expensive, e.g. a
// target up in open air, so it keeps trying detours), a greedier search that trusts the distance
// estimate WEIGHT times more finds a good, if not provably cheapest, route quickly.
const EXACT_EXPANSIONS = 120000;
const GREEDY_EXPANSIONS = 400000;
const GREEDY_WEIGHT = 8;
const SEARCH_MARGIN = 32;
const WORLD_MIN_Y = -64;
const WORLD_MAX_Y = 319;

const FLOOD_LIMIT = 50000;

/**
 * Plan a route for the agent (a 1x1x1 flyer) from `start` ({x, y, z, facing}) to a goal.
 *
 * The goal is { x, y, z } (end exactly there) or { x, y, z, cells } (end on any of those cells,
 * e.g. the cells around a player or around a solid block). With `goal.arrival` (a Map of
 * "x,y,z" -> cost), ending on a cell costs that much extra, plus `finalMultiplier` times what
 * standing there costs (its walking support cost: ground 1, water 5, midair 40...), so the route
 * prefers to end close to the target, standing on solid ground.
 *
 * The agent always faces where it travels: horizontal moves are `move forward`, preceded by
 * turns. Vertical moves don't need turning.
 *
 * Returns { steps, cells, unknownSteps } or { error }.
 */
function planPath(world, start, goal, {
  hug = false, costs = DEFAULT_COSTS, turnCost = 1, unknownPenalty = 0.5, finalMultiplier = 10,
} = {}) {
  // Cheapest possible move, so the distance estimate never overestimates (keeps A* optimal).
  const cheapest = hug ? Math.min(...Object.values(costs)) : 1;
  const goalCells = goal.cells || [[goal.x, goal.y, goal.z]];
  const goalKeys = new Set(goalCells.map((c) => c.join(',')));
  const isGoal = (x, y, z) => goalKeys.has(`${x},${y},${z}`);
  const slack = Math.max(...goalCells.map(([x, y, z]) => Math.abs(x - goal.x) + Math.abs(y - goal.y) + Math.abs(z - goal.z)));
  const heuristic = (x, y, z) => cheapest * Math.max(0,
    Math.abs(x - goal.x) + Math.abs(y - goal.y) + Math.abs(z - goal.z) - slack);

  const open = goalCells.filter(([x, y, z]) => world.state(x, y, z) !== 'solid');
  if (!open.length) {
    return { error: goal.cells ? 'every cell next to the target is solid' : `${goal.x} ${goal.y} ${goal.z} is a solid block` };
  }
  const arrival = goal.arrival || null;
  if (!arrival && isGoal(start.x, start.y, start.z)) return { steps: [], cells: [[start.x, start.y, start.z]], unknownSteps: 0 };
  if (isSealed(world, open, start)) {
    return { error: 'the target is sealed in: every way to it is blocked by known solid blocks' };
  }

  // Keep the search inside a box around the start, the goal and what's known.
  const known = world.bounds();
  const lo = [Math.min(start.x, goal.x), Math.min(start.y, goal.y), Math.min(start.z, goal.z)];
  const hi = [Math.max(start.x, goal.x), Math.max(start.y, goal.y), Math.max(start.z, goal.z)];
  if (known) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], known.min[i]);
      hi[i] = Math.max(hi[i], known.max[i]);
    }
  }
  const inBox = (x, y, z) => x >= lo[0] - SEARCH_MARGIN && x <= hi[0] + SEARCH_MARGIN
    && z >= lo[2] - SEARCH_MARGIN && z <= hi[2] + SEARCH_MARGIN
    && y >= Math.max(WORLD_MIN_Y, lo[1] - SEARCH_MARGIN) && y <= Math.min(WORLD_MAX_Y, hi[1] + SEARCH_MARGIN);

  // Cost of entering a cell when walking: its best support, counting only blocks known to be solid.
  // An unseen cell is neither air nor wall: the terrain is assumed to carry on as last seen, so it
  // costs a ground step at the walking height of the nearest scanned column and the airborne price
  // above or below it (floating, or probably inside the ground). The walker rescans before entering
  // unseen cells and re-plans with what's actually there, so a cliff just past the edge of Sight is
  // found and climbed down, rather than flown over.
  const supportCache = new Map();
  const supportCost = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (supportCache.has(k)) return supportCache.get(k);
    let best = costs.airborne;
    if (world.state(x, y, z) === 'unknown') {
      const surface = world.surfaceNear(x, z, y);
      if (surface === null || surface === y) best = costs.ground;
    } else if (world.isWater(x, y, z)) {
      best = costs.water;
    } else {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if ((dx || dy || dz) && world.state(x + dx, y + dy, z + dz) === 'solid') {
              best = Math.min(best, costs[supportFrom(dx, dy, dz)]);
            }
          }
        }
      }
    }
    supportCache.set(k, best);
    return best;
  };

  // Extra cost of ending on a goal cell (0 without arrival costs).
  const endCost = (x, y, z) => (arrival ? (arrival.get(`${x},${y},${z}`) || 0) + finalMultiplier * supportCost(x, y, z) : 0);

  const stateKey = (x, y, z, f) => `${x},${y},${z},${f}`;
  let result = search(1, EXACT_EXPANSIONS);
  const approximate = result.gaveUp;
  if (approximate) result = search(GREEDY_WEIGHT, GREEDY_EXPANSIONS);
  if (result.gaveUp) return { error: 'search gave up (the area is too large or too maze-like)' };
  const { reached, cameFrom } = result;
  if (!reached) {
    return { error: 'the target cannot be reached' };
  }

  function search(weight, maxExpansions) {
    const startKey = stateKey(start.x, start.y, start.z, start.facing);
    const cameFrom = new Map([[startKey, null]]);
    const bestCost = new Map([[startKey, 0]]);
    const queue = new MinHeap();
    queue.push(weight * heuristic(start.x, start.y, start.z), { x: start.x, y: start.y, z: start.z, facing: start.facing, cost: 0 });

    let expansions = 0;
    while (queue.size) {
      const node = queue.pop();
      // Ending here was the cheapest option left: done.
      if (node.finish) return { reached: node.at, cameFrom };
      const k = stateKey(node.x, node.y, node.z, node.facing);
      if (node.cost > bestCost.get(k)) continue; // stale heap entry
      if (isGoal(node.x, node.y, node.z)) {
        // Without arrival costs the first goal cell reached is the answer. With them, stopping here
        // becomes one more option in the queue, priced with its arrival cost; the search goes on in
        // case a better place to stop is still ahead.
        if (!arrival) return { reached: node, cameFrom };
        queue.push(node.cost + endCost(node.x, node.y, node.z), { finish: true, at: node });
      }
      if (++expansions > maxExpansions) return { gaveUp: true };

      const [fx, , fz] = FORWARD[node.facing];
      const moves = [
        ['forward', node.x + fx, node.y, node.z + fz, node.facing],
        ['up', node.x, node.y + 1, node.z, node.facing],
        ['down', node.x, node.y - 1, node.z, node.facing],
        ['turn right', node.x, node.y, node.z, turnRight(node.facing)],
        ['turn left', node.x, node.y, node.z, turnLeft(node.facing)],
      ];
      for (const [action, x, y, z, facing] of moves) {
        let cost = node.cost;
        if (action.startsWith('turn')) {
          cost += turnCost;
        } else {
          if (!inBox(x, y, z)) continue;
          const state = world.state(x, y, z);
          if (state === 'solid') continue;
          cost += hug ? supportCost(x, y, z) : 1;
          if (state === 'unknown') cost += unknownPenalty;
        }
        const nk = stateKey(x, y, z, facing);
        if (bestCost.has(nk) && bestCost.get(nk) <= cost) continue;
        bestCost.set(nk, cost);
        cameFrom.set(nk, { from: k, action });
        queue.push(cost + weight * heuristic(x, y, z), { x, y, z, facing, cost });
      }
    }
    return { reached: null, cameFrom };
  }

  // Walk back from the goal, then turn the chain into commands with the pose expected after each.
  const chain = [];
  for (let k = stateKey(reached.x, reached.y, reached.z, reached.facing); cameFrom.get(k); k = cameFrom.get(k).from) {
    const [x, y, z, facing] = k.split(',').map(Number);
    chain.push({ action: cameFrom.get(k).action, expect: { x, y, z, facing } });
  }
  chain.reverse();

  const steps = chain.map(({ action, expect }) => ({
    action,
    command: action.startsWith('turn') ? `agent ${action}` : `agent move ${action}`,
    expect,
    enters: action.startsWith('turn') ? null : [expect.x, expect.y, expect.z],
    unknown: !action.startsWith('turn') && world.state(expect.x, expect.y, expect.z) === 'unknown',
  }));
  const cells = [[start.x, start.y, start.z], ...steps.filter((s) => s.enters).map((s) => s.enters)];
  return { steps, cells, unknownSteps: steps.filter((s) => s.unknown).length, approximate };
}

/**
 * Flood outwards from the goal cells through free cells. If the fill runs out without touching
 * an unknown cell or the start, the goal is sealed off and searching for a route is pointless.
 */
function isSealed(world, goalCells, start) {
  const seen = new Set(goalCells.map((c) => c.join(',')));
  const stack = [...goalCells];
  while (stack.length) {
    const [x, y, z] = stack.pop();
    if (x === start.x && y === start.y && z === start.z) return false;
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

class MinHeap {
  constructor() { this.items = []; }

  get size() { return this.items.length; }

  push(priority, value) {
    const items = this.items;
    items.push({ priority, value });
    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (items[parent].priority <= items[i].priority) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l].priority < items[m].priority) m = l;
        if (r < items.length && items[r].priority < items[m].priority) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top.value;
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

module.exports = { planPath, summarizeSteps, cellsAround, DEFAULT_COSTS, supportFrom };
