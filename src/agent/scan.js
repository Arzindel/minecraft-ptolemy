'use strict';

// Facing is derived from the agent's y-rot, snapped to the nearest 90°.
// forward/right are unit vectors on the XZ plane; right is the agent's own right-hand side.
const FACINGS = {
  0: { name: 'Z+ (south)', forward: [0, 0, 1], right: [-1, 0, 0] },
  90: { name: 'X- (west)', forward: [-1, 0, 0], right: [0, 0, -1] },
  180: { name: 'Z- (north)', forward: [0, 0, -1], right: [1, 0, 0] },
  270: { name: 'X+ (east)', forward: [1, 0, 0], right: [0, 0, 1] },
};

/**
 * Cells to scan, in the agent's own frame (right, up, forward).
 * With `radius` (e.g. 2) it's a cube reaching that many blocks out from the agent in every
 * direction (so 5x5x5 for radius 2), matching the Nanny Cam's Zoom. Otherwise it's
 * the default field of view: everything within 1 block (diagonals included, and its own cell),
 * widened by 1 block to each side and extended 2 blocks forward.
 */
function localCells(radius) {
  const cells = [];
  if (radius) {
    const r = radius;
    for (let up = -r; up <= r; up++) {
      for (let forward = -r; forward <= r; forward++) {
        for (let right = -r; right <= r; right++) cells.push({ right, up, forward });
      }
    }
    return cells;
  }
  for (let up = -1; up <= 1; up++) {
    for (let forward = -1; forward <= 3; forward++) {
      const reach = forward <= 1 ? 2 : 1; // sides are only widened within the cube
      for (let right = -reach; right <= reach; right++) cells.push({ right, up, forward });
    }
  }
  return cells;
}

function facingFromRotation(yRot) {
  const snapped = (((Math.round(yRot / 90) * 90) % 360) + 360) % 360;
  return FACINGS[snapped];
}

/**
 * `testforblock x y z air` either matches (air) or, on failure, names the block that is
 * actually there: "The block at X,Y,Z is Oak Log (expected: Air)."
 */
function blockFromTestResponse(res) {
  const body = res.body || {};
  if (body.matches === true) return { block: 'Air' };
  if (typeof body.blockName === 'string') return { block: body.blockName };
  const match = /\bis (.+?)\s*\(expected/i.exec(res.statusMessage || '');
  if (match) return { block: match[1] };
  return { block: '?', raw: res.statusMessage };
}

/**
 * Scan the blocks around the agent. Returns the agent's pose and one entry per cell,
 * with both world coordinates and coordinates relative to the agent.
 */
async function scanAroundAgent(bridge, { radius } = {}) {
  const started = Date.now();
  const pose = await bridge.sendCommand('agent getposition', { quiet: true });
  if (!pose.ok || !pose.body || !pose.body.position) {
    throw new Error(`agent getposition failed: ${pose.statusMessage}`);
  }

  const { x: ax, y: ay, z: az } = pose.body.position;
  const yRot = pose.body['y-rot'] ?? 0;
  const facing = facingFromRotation(yRot);
  const [fx, , fz] = facing.forward;
  const [rx, , rz] = facing.right;

  const cells = await Promise.all(localCells(radius).map(async (cell) => {
    const x = ax + cell.right * rx + cell.forward * fx;
    const y = ay + cell.up;
    const z = az + cell.right * rz + cell.forward * fz;
    const res = await bridge.sendCommand(`testforblock ${x} ${y} ${z} air`, { quiet: true });
    return { x, y, z, ...cell, ...blockFromTestResponse(res) };
  }));

  return {
    agent: { position: { x: ax, y: ay, z: az }, yRot, facing: facing.name },
    cells,
    tookMs: Date.now() - started,
  };
}

const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Render a scan as three top-down layers, oriented from the agent's point of view:
 * forward is up the page, its left and right are left and right. [ ] marks the agent's cell.
 */
function formatScan(scan) {
  const legend = new Map([['Air', '·']]);
  const symbol = (block) => {
    if (block === '?') return '?';
    if (!legend.has(block)) legend.set(block, SYMBOLS[legend.size - 1] || '#');
    return legend.get(block);
  };

  const byKey = new Map(scan.cells.map((c) => [`${c.right},${c.up},${c.forward}`, c]));
  const { x, y, z } = scan.agent.position;
  const lines = [
    `Scan at ${x} ${y} ${z}, facing ${scan.agent.facing} (y-rot ${scan.agent.yRot}): `
      + `${scan.cells.length} blocks in ${(scan.tookMs / 1000).toFixed(2)}s`,
  ];

  const range = (key) => [Math.min(...scan.cells.map((c) => c[key])), Math.max(...scan.cells.map((c) => c[key]))];
  const [minRight, maxRight] = range('right');
  const [minUp, maxUp] = range('up');
  const [minForward, maxForward] = range('forward');

  for (let up = maxUp; up >= minUp; up--) {
    const label = up > 0 ? `${up} above` : up < 0 ? `${-up} below` : 'level';
    lines.push('', `  ${label} (y ${y + up})`);
    for (let forward = maxForward; forward >= minForward; forward--) {
      let row = '';
      for (let right = minRight; right <= maxRight; right++) {
        const cell = byKey.get(`${right},${up},${forward}`);
        const s = cell ? symbol(cell.block) : ' ';
        row += right === 0 && forward === 0 && up === 0 ? `[${s}]` : ` ${s} `;
      }
      lines.push(`    ${row}`);
    }
  }

  lines.push('', `  ${[...legend].map(([block, s]) => `${s} ${block}`).join('   ')}`);
  const unknown = scan.cells.filter((c) => c.raw);
  if (unknown.length) {
    lines.push(`  ? ${unknown.length} block(s) couldn't be identified, e.g. "${unknown[0].raw}"`);
  }
  return lines.join('\n');
}

module.exports = { scanAroundAgent, formatScan, localCells, facingFromRotation };
