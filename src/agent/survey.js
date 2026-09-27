'use strict';

const { blockOf } = require('./vision');

// Looking at the world before walking through it, cheaply.
//
// surveySurface (Method 2): the ground along the way, measured with `gettopsolidblock x y z`, which
// answers with the first block strictly below y that isn't air, leaves or water (logs do count), or
// an error in chunks that aren't loaded. One command per column, all at once, gives a strip of
// ground from the robot to the target. What it looked straight through is marked "clear" on the
// map: probably free, but it could be leaves or water, which it can't see.
//
// checkCells: testforblock on exactly the cells a planned path goes through, so leaves hiding in a
// "clear" column (or anything unseen) are found before the robot walks into them.

const WOOD = /(_log|_wood|_stem|_hyphae|^mushroom_stem)$/;

/** "grass_block" → "Grass Block", the way testforblock names blocks. */
function displayName(id) {
  return String(id).replace(/^minecraft:/, '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The block gettopsolidblock found: { y, id } or null (unloaded chunk, or nothing below). */
function topOf(res) {
  const body = res.body || {};
  if (!res.ok || !body.position || typeof body.blockName !== 'string') return null;
  return { y: body.position.y, id: body.blockName.replace(/^minecraft:/, '') };
}

/**
 * Columns (x, z) within `width` blocks of the straight line (in map view) from `a` to `b`, plus
 * those within `endRadius` of either end.
 */
function corridorColumns(a, b, width, endRadius) {
  const out = new Map();
  const add = (x, z) => out.set(`${x},${z}`, [x, z]);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const pad = Math.max(width, endRadius);
  for (let x = Math.min(a.x, b.x) - pad; x <= Math.max(a.x, b.x) + pad; x++) {
    for (let z = Math.min(a.z, b.z) - pad; z <= Math.max(a.z, b.z) + pad; z++) {
      const t = len2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
      const near = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)) <= width;
      const end = Math.max(Math.abs(x - a.x), Math.abs(z - a.z)) <= endRadius
        || Math.max(Math.abs(x - b.x), Math.abs(z - b.z)) <= endRadius;
      if (near || end) add(x, z);
    }
  }
  return [...out.values()];
}

/**
 * Method 2: measure the ground from `from` to `to` with gettopsolidblock and put it on the map.
 * Resolves to { columns, unloaded, commands, ground: Map "x,z" -> y of the ground block }.
 */
async function surveySurface(bridge, world, from, to, { width = 3, endRadius = 3, headroom = 24 } = {}) {
  const send = (cmd) => bridge.sendCommand(cmd, { quiet: true });
  const columns = corridorColumns(from, to, width, endRadius);
  const top = Math.min(320, Math.max(from.y, to.y) + headroom);
  let commands = 0;
  const ask = (list, yOf) => {
    commands += list.length;
    return Promise.all(list.map(async (c) => ({ c, found: topOf(await send(`gettopsolidblock ${c.x} ${yOf(c)} ${c.z}`)) })));
  };

  // 1. Every column from `top` down. 2. A column solid right under `top` is a hill reaching higher:
  // ask again from the top of the world. 3. A log may be a branch with open space under it: ask
  // again from just below it.
  let answers = await ask(columns.map(([x, z]) => ({ x, z, from: top })), (c) => c.from);
  const higher = answers.filter((a) => a.found && a.found.y === top - 1).map((a) => ({ ...a.c, from: 320 }));
  if (higher.length) {
    const again = new Map((await ask(higher, (c) => c.from)).map((a) => [`${a.c.x},${a.c.z}`, a]));
    answers = answers.map((a) => again.get(`${a.c.x},${a.c.z}`) || a);
  }
  const wood = answers.filter((a) => a.found && WOOD.test(a.found.id));
  const under = new Map((await ask(wood.map((a) => ({ ...a.c, from: a.found.y })), (c) => c.from))
    .map((a) => [`${a.c.x},${a.c.z}`, a.found]));

  const blocks = [];
  const clear = [];
  const ground = new Map();
  let unloaded = 0;
  for (const { c, found } of answers) {
    if (!found) {
      unloaded++;
      continue;
    }
    blocks.push([c.x, found.y, c.z, displayName(found.id)]);
    for (let y = found.y + 1; y < Math.min(c.from, found.y + 1 + headroom); y++) clear.push([c.x, y, c.z]);
    let groundY = found.y;
    const below = under.get(`${c.x},${c.z}`);
    if (below) {
      blocks.push([c.x, below.y, c.z, displayName(below.id)]);
      for (let y = below.y + 1; y < found.y; y++) clear.push([c.x, y, c.z]); // under a branch (none for a trunk)
      groundY = below.y;
    }
    ground.set(`${c.x},${c.z}`, groundY);
    world.setGround(c.x, c.z, groundY);
  }
  world.setBlocks(blocks);
  world.setClear(clear);
  return { columns: columns.length, unloaded, commands, ground };
}

/**
 * testforblock each cell (all at once; the bridge queues what doesn't fit in one flight) and put
 * what's there on the map. Resolves to how many were checked.
 */
async function checkCells(bridge, world, cells) {
  const unique = [...new Map(cells.map((c) => [c.join(','), c])).values()];
  const replies = await Promise.all(unique.map(([x, y, z]) => bridge.sendCommand(`testforblock ${x} ${y} ${z} air`, { quiet: true })));
  const seen = [];
  replies.forEach((res, i) => {
    const block = blockOf(res);
    if (block) seen.push([...unique[i], block]);
  });
  world.setBlocks(seen);
  return unique.length;
}

/**
 * Method 1: the cells of five tubes of `radius` between `a` and `b`: straight up/down from each to
 * the other's height, the two level lines that close that rectangle, and the diagonal. Covers the
 * straight flight and the ways around it above or below, and works underground too.
 */
function corridorCells(a, b, radius = 2) {
  const aUp = { x: a.x, y: b.y, z: a.z };
  const bUp = { x: b.x, y: a.y, z: b.z };
  const lines = [[a, aUp], [b, bUp], [aUp, b], [bUp, a], [a, b]];
  const cells = new Map();
  const r2 = radius * radius;
  for (const [p, q] of lines) {
    const len = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    const n = Math.max(1, Math.ceil(len * 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const cx = p.x + (q.x - p.x) * t;
      const cy = p.y + (q.y - p.y) * t;
      const cz = p.z + (q.z - p.z) * t;
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
          for (let z = Math.floor(cz - radius); z <= Math.ceil(cz + radius); z++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r2) cells.set(`${x},${y},${z}`, [x, y, z]);
          }
        }
      }
    }
  }
  return [...cells.values()];
}

/** The cells of a cube around `center` whose block hasn't been seen (unknown, or only "clear"). */
function unknownAround(world, center, radius) {
  const cells = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const c = [center.x + dx, center.y + dy, center.z + dz];
        if (!world.verified(...c)) cells.push(c);
      }
    }
  }
  return cells;
}

module.exports = { surveySurface, checkCells, unknownAround, corridorColumns, corridorCells, displayName };
