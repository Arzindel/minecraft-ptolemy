'use strict';

// Pathfinding benchmark: the robot walks to a player ~60 blocks away in simulated worlds, with each
// way of finding its way (#pathfindwalk method=...), and this prints how often it got there and what
// it cost. Run it before and after changing the pathfinder, the walker or Vision:
//   npm run bench                          everything
//   node bench/pathfinding.js river house  scenarios whose name contains one of these words
//   METHODS=surface node bench/pathfinding.js   only some methods

const { makeTerrain, setup } = require('./sim');
const { isSolid } = require('../public/blocks');

const SEEDS = [1, 2, 3, 4, 5, 6];
const METHODS = (process.env.METHODS || 'rescan,surface,lookahead').split(',');
const FLY_METHODS = (process.env.FLY_METHODS || 'rescan,lookahead,corridor').split(',');
const PLAYER = { x: -58, z: 81 };
// Walking scenarios compare METHODS; flying ones ("airborne" steps are fine there) FLY_METHODS.
const START = { x: -118, z: 76 };

/** A wall across the way at x = -90: `half` blocks either side of z = 76, `top` blocks above ground. */
function wall(seed, half, top) {
  const probe = makeTerrain({ seed });
  const cells = [];
  for (let z = 76 - half; z <= 76 + half; z++) {
    const g = probe.height(-90, z);
    for (let y = g - 3; y <= g + top; y++) cells.push([-90, y, z]);
  }
  return cells;
}

const SCENARIOS = {
  'open ground': (seed) => ({ terrain: makeTerrain({ seed, trees: 0 }) }),
  'uphill +13': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.02, from: [-118, 93], to: [-58, 106] }) }),
  'dense forest': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.06 }) }),
  'big hills': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.03, from: [-118, 80], to: [-58, 110] }) }),
  'from a tree top': (seed) => {
    const terrain = makeTerrain({ seed, trees: 0.02 });
    terrain.addTree(-118, 72);
    return { terrain, start: { x: -118, y: terrain.height(-118, 72) + 5, z: 74 } };
  },
  'wall 41 wide': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.02, walls: wall(seed, 20, 15) }) }),
  'wall 71 wide (2 tries)': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.02, walls: wall(seed, 35, 30) }), tries: 2 }),
  'wall appears mid-walk': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.04 }), dropWall: true }),
  'river on the way': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.03, river: { x0: -96, x1: -84, bed: 86, level: 93 } }) }),
  'flying over a forest': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.06 }), fly: true }),
  'flying over big hills': (seed) => ({ terrain: makeTerrain({ seed, trees: 0.03, from: [-118, 80], to: [-58, 110] }), fly: true }),
  'cave tunnel': (seed) => {
    const terrain = makeTerrain({ seed, trees: 0.02 });
    const y = 80;
    tunnel(terrain, y, [[-118, 76], [-88, 76], [-88, 90], [-70, 90], [-70, 81], [-58, 81]]);
    return { terrain, start: { x: -118, y, z: 76 }, player: { x: PLAYER.x, y, z: PLAYER.z } };
  },
  'player in a house': (seed) => {
    const terrain = makeTerrain({ seed, trees: 0.02 });
    return { terrain, player: house(terrain, PLAYER.x, PLAYER.z) };
  },
};

/** A tunnel 1 wide and 2 tall at height y, through the corners [x, z] given in order. */
function tunnel(terrain, y, corners) {
  for (let i = 1; i < corners.length; i++) {
    const [x0, z0] = corners[i - 1];
    const [x1, z1] = corners[i];
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
        terrain.edits.set(`${x},${y},${z}`, 'Air');
        terrain.edits.set(`${x},${y + 1},${z}`, 'Air');
      }
    }
  }
}

/** A 7x7 plank house with its door on the far side (east), around (cx, cz); returns where to stand inside. */
function house(terrain, cx, cz) {
  const g = terrain.height(cx, cz);
  const top = g + 4;
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = cx + dx;
      const z = cz + dz;
      const wall = Math.abs(dx) === 3 || Math.abs(dz) === 3;
      const door = dx === 3 && dz === 0;
      for (let y = Math.min(g, terrain.height(x, z)) + 1; y <= top; y++) {
        const inside = !wall || (door && y <= g + 2);
        terrain.edits.set(`${x},${y},${z}`, inside ? (y <= g ? 'Oak Planks' : 'Air') : 'Oak Planks');
      }
      terrain.edits.set(`${x},${top + 1},${z}`, 'Oak Planks');
    }
  }
  return { x: cx, y: g + 1, z: cz };
}

/** How many of the robot's steps had nothing solid around them (flying rather than walking). */
function airborne(terrain, cells) {
  let n = 0;
  for (const [x, y, z] of cells) {
    let supported = false;
    for (let dx = -1; dx <= 1 && !supported; dx++) {
      for (let dy = -1; dy <= 1 && !supported; dy++) {
        for (let dz = -1; dz <= 1 && !supported; dz++) {
          if ((dx || dy || dz) && isSolid(terrain.block(x + dx, y + dy, z + dz))) supported = true;
        }
      }
    }
    if (!supported) n++;
  }
  return n;
}

async function run(name, make, { vision = true, method = 'auto' }) {
  const totals = { arrived: 0, moves: 0, airborne: 0, bumps: 0, commands: 0, ms: 0 };
  for (const seed of SEEDS) {
    const { terrain, start, tries = 1, dropWall = false, player = null, fly = false } = make(seed);
    const agent = start ? { ...start, facing: 0 } : { x: START.x, y: terrain.height(START.x, START.z) + 1, z: START.z, facing: 0 };
    const py = player ? player.y : terrain.height(PLAYER.x, PLAYER.z) + 1;
    const env = setup({ terrain, agent, player: { x: PLAYER.x, y: py, z: PLAYER.z }, vision });
    if (dropWall) {
      // A player builds a wall across the robot's way after its 20th step: 5 wide, 4 tall, 3 ahead.
      let placed = false;
      env.bridge.onMove = (b) => {
        if (placed || b.moves < 20) return;
        placed = true;
        const a = b.agent;
        const f = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]][a.facing];
        for (let s = -2; s <= 2; s++) {
          for (let dy = -1; dy <= 2; dy++) {
            terrain.edits.set(`${a.x + f[0] * 3 + (f[2] ? s : 0)},${a.y + dy},${a.z + f[2] * 3 + (f[0] ? s : 0)}`, 'Cobblestone');
          }
        }
      };
    }
    const t0 = Date.now();
    for (let i = 0; i < tries; i++) {
      await env.navigator.pathfindwalk(['@p'], { method, fly });
      if (Math.hypot(agent.x - PLAYER.x, agent.y - py, agent.z - PLAYER.z) <= 3.5) break;
    }
    totals.ms += Date.now() - t0;
    if (Math.hypot(agent.x - PLAYER.x, agent.y - py, agent.z - PLAYER.z) <= 3.5) totals.arrived++;
    totals.moves += env.bridge.moves;
    totals.airborne += airborne(terrain, env.bridge.log.filter((c) => typeof c[0] === 'number'));
    totals.bumps += env.bridge.bumps || 0;
    totals.commands += env.bridge.commands;
  }
  return totals;
}

(async () => {
  const wanted = process.argv.slice(2);
  const names = Object.keys(SCENARIOS).filter((n) => !wanted.length || wanted.some((w) => n.includes(w)));
  const rows = [];
  for (const name of names) {
    const flying = SCENARIOS[name](SEEDS[0]).fly;
    for (const method of flying ? FLY_METHODS : METHODS) {
      const t = await run(name, SCENARIOS[name], { method });
      process.stderr.write(`  ${name}, ${method}: ${t.arrived}/${SEEDS.length}\n`);
      rows.push([name, method, `${t.arrived}/${SEEDS.length}`, t.moves, t.airborne, t.bumps, t.commands, `${(t.ms / 1000).toFixed(1)}s`]);
    }
  }
  const head = ['scenario', 'method', 'arrived', 'moves', 'airborne', 'bumped', 'commands', 'cpu time'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(r)));
})();
