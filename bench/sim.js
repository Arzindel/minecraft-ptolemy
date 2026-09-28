'use strict';
// A simulated Minecraft for benchmarks: hilly terrain with trees (and whatever else a scenario
// adds), and a fake game that answers the commands Ptolemy sends the way Bedrock does: an agent
// that flies and can't enter solid blocks, testforblock, querytarget, list...
const REPO = require('path').join(__dirname, '..');
const { Navigator } = require(REPO + '/src/agent/navigator');
const { WorldMap } = require(REPO + '/src/world/map');
const { scanAroundAgent } = require(REPO + '/src/agent/scan');
const { FORWARD } = require(REPO + '/src/agent/pose');
const { isSolid } = require(REPO + '/public/blocks');
const { Vision } = require(REPO + '/src/agent/vision');

function hash(x, z, s = 0) { let h = (x * 374761393 + z * 668265263 + s * 982451653) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

/**
 * Terrain rising from `from` [x, height] to `to`, with bumps and trees. `river`: { x0, x1, bed, level }
 * cuts a river across (ground at `bed`, water up to `level`) between x0 and x1.
 */
function makeTerrain({ seed = 1, from = [-118, 93], to = [-58, 106], trees = 0.03, bumps = 3, walls = [], river = null } = {}) {
  const inRiver = (x) => river && x >= river.x0 && x <= river.x1;
  const height = (x, z) => {
    if (inRiver(x)) return river.bed + (hash(x, z, seed) < 0.3 ? 1 : 0);
    const t = Math.max(0, Math.min(1, (x - from[0]) / (to[0] - from[0])));
    const base = from[1] + (to[1] - from[1]) * t;
    const n = Math.sin(x / 7 + seed) * bumps / 2 + Math.cos(z / 5 + seed * 2) * bumps / 2 + (hash(x >> 2, z >> 2, seed) - 0.5) * 2;
    return Math.round(base + n);
  };
  const edits = new Map();
  const treeAt = new Map();
  const addTree = (x, z) => {
    const g = height(x, z);
    for (let y = g + 1; y <= g + 5; y++) edits.set(`${x},${y},${z}`, 'Oak Log');
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 3; dy <= 6; dy++) {
      const k = `${x + dx},${g + dy},${z + dz}`;
      if (edits.get(k) === 'Oak Log') continue;
      if (dy >= 5 && (Math.abs(dx) === 2 || Math.abs(dz) === 2)) continue;
      edits.set(k, 'Oak Leaves');
    }
  };
  for (let x = from[0] - 40; x <= to[0] + 40; x++) for (let z = 20; z <= 140; z++) {
    if (!inRiver(x) && hash(x, z, seed + 7) < trees && hash(x >> 3, z >> 3, 99) < 0.7) addTree(x, z);
  }
  for (const w of walls) edits.set(w.join(','), 'Stone');
  const block = (x, y, z) => {
    const e = edits.get(`${x},${y},${z}`);
    if (e) return e;
    const h = height(x, z);
    if (y > h && inRiver(x) && y <= river.level) return 'Water';
    if (y > h) return 'Air';
    if (y === h) return 'Grass Block';
    return y > h - 3 ? 'Dirt' : 'Stone';
  };
  return { height, edits, block, addTree };
}

class FakeBridge {
  constructor(terrain, agent, player) {
    this.t = terrain; this.agent = agent; this.p = player; this.connected = true; this.player = 'Arzindel'; this.commands = 0; this.moves = 0;
    this.log = [];
  }
  async sendCommand(cmd) {
    this.commands++;
    const ok = (statusMessage, body = {}) => ({ ok: true, statusCode: 0, statusMessage, body: { statusCode: 0, statusMessage, ...body } });
    let m;
    const a = this.agent;
    if (cmd === 'agent getposition') return ok('', { position: { x: a.x, y: a.y, z: a.z }, 'y-rot': [0, 90, 180, -90][a.facing] });
    if ((m = /^agent move (\w+)$/.exec(cmd))) {
      this.moves++;
      const d = m[1];
      const f = FORWARD[a.facing];
      const off = { forward: f, back: f.map((v) => -v), up: [0, 1, 0], down: [0, -1, 0],
        right: FORWARD[(a.facing + 1) % 4], left: FORWARD[(a.facing + 3) % 4] }[d];
      const n = [a.x + off[0], a.y + off[1], a.z + off[2]];
      if (!isSolid(this.t.block(...n))) { a.x = n[0]; a.y = n[1]; a.z = n[2]; this.log.push(n); } else this.bumps = (this.bumps || 0) + 1;
      if (this.onMove) this.onMove(this);
      return ok('Agent moved');
    }
    if ((m = /^agent turn (left|right)$/.exec(cmd))) { a.facing = (a.facing + (m[1] === 'right' ? 1 : 3)) % 4; return ok('Agent turned'); }
    if ((m = /^agent tp (-?\d+) (-?\d+) (-?\d+)$/.exec(cmd))) { a.x = +m[1]; a.y = +m[2]; a.z = +m[3]; return ok('Agent teleported'); }
    // The agent's hands: destroy clears a cell (not bedrock), place fills an empty one from an inventory
    // slot filled with setitem (named the way testforblock names blocks: "oak_planks" → "Oak Planks").
    const cellAt = (d) => {
      const f = FORWARD[a.facing];
      const off = { forward: f, back: f.map((v) => -v), up: [0, 1, 0], down: [0, -1, 0],
        right: FORWARD[(a.facing + 1) % 4], left: FORWARD[(a.facing + 3) % 4] }[d];
      return off && [a.x + off[0], a.y + off[1], a.z + off[2]];
    };
    this.inventory = this.inventory || new Map();
    if ((m = /^agent destroy (\w+)$/.exec(cmd))) {
      const c = cellAt(m[1]);
      if (c && this.t.block(...c) !== 'Bedrock') this.t.edits.set(c.join(','), 'Air');
      return ok('Agent destroyed a block');
    }
    if ((m = /^agent place (\d+) (\w+)$/.exec(cmd))) {
      const c = cellAt(m[2]);
      const item = this.inventory.get(+m[1]);
      if (!c || !item || isSolid(this.t.block(...c))) return { ok: false, statusCode: -1, statusMessage: 'Agent failed to place', body: {} };
      this.t.edits.set(c.join(','), item.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
      return ok('Agent placed a block');
    }
    if ((m = /^agent setitem (\d+) ([\w:]+) (\d+) (\d+)$/.exec(cmd))) {
      this.inventory.set(+m[1], m[2].replace(/^minecraft:/, ''));
      return ok('Agent set item');
    }
    if ((m = /^agent drop (\d+) (\d+) (\w+)$/.exec(cmd))) return ok('Agent dropped items');
    if ((m = /^testforblock (-?\d+) (-?\d+) (-?\d+) ([a-z_:]+)$/.exec(cmd)) && m[4] !== 'air') {
      const b = this.t.block(+m[1], +m[2], +m[3]);
      if (b.toLowerCase().replace(/ /g, '_') === m[4].replace(/^minecraft:/, '')) return ok('Successfully found the block', { matches: true });
      return { ok: false, statusCode: -1, statusMessage: `The block at ${m[1]},${m[2]},${m[3]} is ${b} (expected: ${m[4]}).`, body: { matches: false } };
    }
    if ((m = /^testforblock (-?\d+) (-?\d+) (-?\d+) air$/.exec(cmd))) {
      const b = this.t.block(+m[1], +m[2], +m[3]);
      if (b === 'Air') return ok('The block at ... is Air', { matches: true });
      return { ok: false, statusCode: -1, statusMessage: `The block at ${m[1]},${m[2]},${m[3]} is ${b} (expected: Air).`, body: { matches: false } };
    }
    if (/^querytarget @e/.test(cmd)) return ok('', { details: JSON.stringify((this.entities || []).map((e) => ({ uniqueId: e.id, position: e.pos, yRot: 0 }))) });
    if (/^testfor @e/.test(cmd)) return ok(`Found ${(this.entities || []).map((e) => e.name).join(', ')}`, { victim: (this.entities || []).map((e) => e.name) });
    if (/^querytarget/.test(cmd)) return ok('', { details: JSON.stringify([{ position: { x: this.p.x + 0.5, y: this.p.y + 1.62, z: this.p.z + 0.5 }, yRot: 0 }]) });
    if (cmd === 'list') return ok('There are 1/10 players online:\nArzindel', { players: 'Arzindel' });
    if ((m = /^gettopsolidblock (-?\d+) (-?\d+) (-?\d+)$/.exec(cmd))) {
      // As measured in Bedrock: the first block strictly below y that isn't air, leaves or water
      // (logs count); an error in unloaded chunks (here: more than 200 blocks from the player).
      const [x, y, z] = [+m[1], +m[2], +m[3]];
      const fail = { ok: false, statusCode: -2147352576, statusMessage: 'No solid blocks under specified position',
        body: { statusCode: -2147352576, statusMessage: 'No solid blocks under specified position' } };
      if (Math.abs(x - this.p.x) > 200 || Math.abs(z - this.p.z) > 200) return fail;
      for (let yy = Math.min(y - 1, 319); yy >= -64; yy--) {
        const b = this.t.block(x, yy, z);
        if (b === 'Air' || b === 'Water' || /Leaves$/.test(b)) continue;
        return ok('', { blockName: b.toLowerCase().replace(/ /g, '_'), position: { x, y: yy, z } });
      }
      return fail;
    }
    if (/^tp /.test(cmd)) { this.log.push(['PLAYER TELEPORTED', cmd]); return ok('Teleported'); }
    return ok(`(fake) ${cmd}`);
  }
}

const DEFAULTS = {
  'path.scanRadius': 7, 'path.retries': 3, 'path.turnCost': 1, 'path.unknownPenalty': 0.5, 'path.finalMultiplier': 10,
  'path.surveyWidth': 3, 'path.nearSide': 10, 'path.nearDiagonal': 15, 'path.nearFar': 20, 'path.nearHeight': 10, 'path.safe': false,
  'scan.radius': 4, 'vision.radius': 1, 'vision.entityRadius': 9, 'vision.idleSeconds': 2, 'llm.coordinates': 'relative', 'tools.allowRaw': true, 'tools.allowDestructive': true,
};
const COSTS = { ground: 1, wall: 5, groundEdge: 3, wallDiagonal: 8, groundCorner: 10, ceiling: 15, ceilingEdge: 20, ceilingCorner: 20, airborne: 40 };
function fakeSettings(over = {}) {
  const v = { ...DEFAULTS, ...over };
  return { get: (k) => v[k], costs: () => ({ ...COSTS }), update: (p) => Object.assign(v, p) };
}

function setup({ terrain, agent, player, settings = {}, quiet = true, vision = false }) {
  const bridge = new FakeBridge(terrain, agent, player);
  const world = new WorldMap();
  const lines = [];
  const s = fakeSettings(settings);
  let navigator;
  const scan = async (radius) => {
    const res = await scanAroundAgent(bridge, { radius });
    world.setSight(res);
    return res;
  };
  const eyes = vision ? new Vision({ bridge, world, settings: s }) : null;
  navigator = new Navigator({ bridge, world, settings: s, scan, vision: eyes, log: (t) => { lines.push(t); if (!quiet) console.log('  nav:', t.split('\n')[0]); }, broadcast: () => {} });
  return { bridge, world, navigator, lines, settings: s, scan };
}

module.exports = { makeTerrain, FakeBridge, setup, fakeSettings, hash };
