'use strict';

const { FORWARD, turnLeft, turnRight, getAgentPose } = require('../agent/pose');
const { isSolid } = require('../../public/blocks');

// Tools the LLM (and MCP clients) drive the robot with. Most are shortcuts that bundle several
// game commands and report what actually happened, since the game's own replies say "success"
// even when the agent bumped into a wall. `run_command` is the raw escape hatch.

const DIRECTIONS = ['forward', 'back', 'left', 'right', 'up', 'down'];
const COMPASS = { south: 0, west: 1, north: 2, east: 3 };
const MAX_MOVE = 64;
const MAX_BLOCKS_QUERY = 64;
const MAX_WAIT_S = 60;
const MAX_SCAN_RADIUS = 15;
// Blocks that are everywhere: counted in scan summaries, but not listed one by one.
const LIST_LIMIT_PER_TYPE = 5;
const COMMON_THRESHOLD = 20;

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** World offset of a direction relative to a facing. */
function offsetOf(direction, facing) {
  switch (direction) {
    case 'forward': return FORWARD[facing];
    case 'back': return FORWARD[facing].map((v) => -v);
    case 'right': return FORWARD[turnRight(facing)];
    case 'left': return FORWARD[turnLeft(facing)];
    case 'up': return [0, 1, 0];
    case 'down': return [0, -1, 0];
    default: throw new Error(`unknown direction "${direction}"`);
  }
}

function compassName(facing) {
  return ['south', 'west', 'north', 'east'][facing];
}

function poseText(p) {
  return `${p.x} ${p.y} ${p.z}, facing ${compassName(p.facing)}`;
}

/** Relative directions as compass directions from a facing, e.g. "forward = east (X+)". */
function orientationText(facing) {
  return DIRECTIONS.slice(0, 4).map((d) => {
    const [dx, , dz] = offsetOf(d, facing);
    const axis = dx ? `X${dx > 0 ? '+' : '-'}` : `Z${dz > 0 ? '+' : '-'}`;
    const name = { 'X+': 'east', 'X-': 'west', 'Z+': 'south', 'Z-': 'north' }[axis];
    return `${d} = ${name} (${axis})`;
  }).join(', ');
}

const dirParam = (description) => ({ type: 'string', enum: DIRECTIONS, description });

/**
 * @param {object} deps
 * @param {import('../minecraft/bridge').MinecraftBridge} deps.bridge
 * @param {import('../agent/world').WorldKnowledge} deps.world
 * @param {import('../agent/navigator').Navigator} deps.navigator
 * @param {import('../settings').Settings} deps.settings
 * @param {(radius: number, opts?: object) => Promise<object|null>} deps.scan
 * @param {(text: string, extra?: object) => void} deps.log
 * @param {() => object|null} deps.sight   the latest Sight (for status)
 */
function createToolbox({ bridge, world, navigator, settings, scan, log, sight }) {
  const tools = [];
  const add = (tool) => tools.push(tool);

  async function blockAt(x, y, z) {
    const res = await bridge.sendCommand(`testforblock ${x} ${y} ${z} air`, { quiet: true });
    if (res.body && res.body.matches === true) return 'Air';
    const m = /\bis (.+?)\s*\(expected/i.exec(res.statusMessage || '');
    if (m) return m[1];
    return `unknown (${res.statusMessage})`;
  }

  async function playerPosition() {
    const res = await bridge.sendCommand('querytarget @s', { quiet: true });
    try {
      const p = JSON.parse(res.body.details)[0];
      return { x: Math.floor(p.position.x), y: Math.floor(p.position.y), z: Math.floor(p.position.z), yRot: p.yRot };
    } catch {
      return null;
    }
  }

  /** Run `agent <verb> <direction>` and report what changed in that cell. */
  async function actOnCell(verb, direction, extra = '') {
    const pose = await getAgentPose(bridge);
    const [dx, dy, dz] = offsetOf(direction, pose.facing);
    const [x, y, z] = [pose.x + dx, pose.y + dy, pose.z + dz];
    const before = await blockAt(x, y, z);
    const res = await bridge.sendCommand(`agent ${verb} ${extra}${direction}`.replace(/\s+/g, ' '));
    const after = await blockAt(x, y, z);
    world.setBlock(x, y, z, after);
    const where = `${direction} of the robot (${x} ${y} ${z})`;
    const game = `The game said: "${res.statusMessage}".`;
    if (before === after) return `Nothing changed ${where}: it is still ${after}. ${game}`;
    return `The block ${where} went from ${before} to ${after}. ${game}`;
  }

  // --- Looking around ---------------------------------------------------------

  add({
    name: 'get_status',
    description: 'Where the robot and the player are, which way the robot faces, and what is directly around the robot. Cheap: call it whenever you are unsure.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const lines = [];
      lines.push(`Minecraft: connected as ${bridge.player || 'unknown player'}.`);
      const pose = await getAgentPose(bridge);
      lines.push(`Robot: at ${poseText(pose)}. Relative directions: ${orientationText(pose.facing)}.`);
      const around = await Promise.all(DIRECTIONS.map(async (d) => {
        const [dx, dy, dz] = offsetOf(d, pose.facing);
        return `${d}: ${await blockAt(pose.x + dx, pose.y + dy, pose.z + dz)}`;
      }));
      lines.push(`Next to the robot: ${around.join(', ')}.`);
      const player = await playerPosition();
      if (player) {
        const dist = Math.hypot(player.x - pose.x, player.y - pose.y, player.z - pose.z);
        lines.push(`Player ${bridge.player || ''}: at ${player.x} ${player.y} ${player.z} (roughly; this may be eye height), `
          + `${dist.toFixed(1)} blocks from the robot.`);
      }
      const s = sight();
      if (s) {
        lines.push(`Last scan: ${s.scanned} blocks around ${s.agent.position.x} ${s.agent.position.y} ${s.agent.position.z}, `
          + `${Math.round((Date.now() - s.time) / 1000)}s ago.`);
      }
      if (navigator.busy) lines.push('The robot is busy walking a path right now.');
      return lines.join('\n');
    },
  });

  add({
    name: 'scan',
    description: 'Look at every block in a cube around the robot (radius 3 = 7x7x7, about 0.3s; radius 8 = 17x17x17, about 5s). '
      + 'Returns what is next to the robot, the ground below it, counts of each block type, and the coordinates of the rarer blocks. '
      + 'Also updates the robot\'s map for go_to.',
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'integer', minimum: 1, maximum: MAX_SCAN_RADIUS, description: 'Blocks in each direction (default: the configured scan radius).' },
      },
    },
    async run({ radius }) {
      const r = clampInt(radius ?? settings.get('scan.radius'), 1, MAX_SCAN_RADIUS);
      const result = await scan(r, { quiet: true });
      if (!result) throw new Error('the scan failed (see the console)');
      return summarizeScan(result);
    },
  });

  add({
    name: 'get_blocks',
    description: `Which block is at each of up to ${MAX_BLOCKS_QUERY} exact coordinates (works anywhere loaded, not only near the robot).`,
    parameters: {
      type: 'object',
      properties: {
        positions: {
          type: 'array',
          maxItems: MAX_BLOCKS_QUERY,
          items: {
            type: 'object',
            properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } },
            required: ['x', 'y', 'z'],
          },
        },
      },
      required: ['positions'],
    },
    async run({ positions }) {
      if (!Array.isArray(positions) || !positions.length) throw new Error('positions must be a non-empty list of {x, y, z}');
      const list = positions.slice(0, MAX_BLOCKS_QUERY).map((p) => [p.x, p.y, p.z].map((v) => Math.round(Number(v))));
      if (list.some((p) => p.some((v) => !Number.isFinite(v)))) throw new Error('every position needs numeric x, y and z');
      const blocks = await Promise.all(list.map((p) => blockAt(...p)));
      return list.map((p, i) => `${p.join(' ')}: ${blocks[i]}`).join('\n');
    },
  });

  // --- Moving -----------------------------------------------------------------

  add({
    name: 'move',
    description: 'Move the robot a few blocks in a straight line, relative to where it faces (left/right move sideways without turning). '
      + 'Stops early if something solid is in the way and says what. For longer trips use go_to.',
    parameters: {
      type: 'object',
      properties: {
        direction: dirParam('Relative to the robot\'s facing.'),
        blocks: { type: 'integer', minimum: 1, maximum: MAX_MOVE, description: 'How far (default 1).' },
      },
      required: ['direction'],
    },
    async run({ direction, blocks }) {
      checkDirection(direction);
      const n = clampInt(blocks ?? 1, 1, MAX_MOVE);
      const start = await getAgentPose(bridge);
      const [dx, dy, dz] = offsetOf(direction, start.facing);
      const steps = Array.from({ length: n }, (_, i) => {
        const expect = { x: start.x + dx * (i + 1), y: start.y + dy * (i + 1), z: start.z + dz * (i + 1), facing: start.facing };
        return { action: direction, command: `agent move ${direction}`, expect, enters: [expect.x, expect.y, expect.z] };
      });
      const result = await navigator.runSteps(steps);
      if (result.ok) return `Moved ${n} ${direction}. The robot is at ${poseText(result.pose)}.`;
      if (result.stopped) return `Stopped by the user after ${countMoved(start, result.pose)} blocks, at ${poseText(result.pose)}.`;
      if (!result.step) return `Couldn't move: ${result.reason}.`;
      const moved = countMoved(start, result.pose);
      const blocker = await blockAt(...result.step.enters);
      if (isSolid(blocker)) world.markBlocked(...result.step.enters);
      return `Moved ${moved} of ${n} blocks ${direction}, then was blocked by ${blocker} at ${result.step.enters.join(' ')}. `
        + `The robot is at ${poseText(result.pose)}.`;
    },
  });

  add({
    name: 'turn',
    description: 'Turn the robot left, right or around, or to face a compass direction (north = Z-, south = Z+, east = X+, west = X-).',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string', enum: ['left', 'right', 'around', 'north', 'south', 'east', 'west'] } },
      required: ['to'],
    },
    async run({ to }) {
      const start = await getAgentPose(bridge);
      let turns;
      if (to === 'left') turns = ['left'];
      else if (to === 'right') turns = ['right'];
      else if (to === 'around') turns = ['right', 'right'];
      else if (to in COMPASS) {
        const diff = (COMPASS[to] - start.facing + 4) % 4;
        turns = [[], ['right'], ['right', 'right'], ['left']][diff];
      } else throw new Error(`"to" must be left, right, around, north, south, east or west`);
      if (!turns.length) return `Already facing ${to}. ${orientationText(start.facing)}.`;
      let facing = start.facing;
      const steps = turns.map((t) => {
        facing = t === 'right' ? turnRight(facing) : turnLeft(facing);
        return { action: `turn ${t}`, command: `agent turn ${t}`, expect: { x: start.x, y: start.y, z: start.z, facing }, enters: null };
      });
      const result = await navigator.runSteps(steps);
      if (!result.ok) return `Turn failed: ${result.reason || 'stopped'}.`;
      return `Now facing ${compassName(result.pose.facing)}. ${orientationText(result.pose.facing)}.`;
    },
  });

  add({
    name: 'go_to',
    description: 'Travel to coordinates (or to the player), planning a route around obstacles, scanning unknown ground on the way and '
      + 'checking every step. If the target is a solid block, the robot stops next to it. Takes a while for long trips.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        target: { type: 'string', enum: ['coordinates', 'player'], description: '"player" goes next to the player and ignores x/y/z. Default "coordinates".' },
        fly: { type: 'boolean', description: 'Take the straightest route through the air instead of staying close to the ground (default false).' },
      },
    },
    async run({ x, y, z, target, fly }) {
      let args;
      if (target === 'player') args = ['@p'];
      else {
        if (![x, y, z].every((v) => Number.isFinite(Number(v)))) throw new Error('give x, y and z, or target "player"');
        args = [x, y, z].map((v) => String(Math.round(Number(v))));
      }
      const lines = await captureNavigatorLog(() => navigator.pathfindwalk(args, { fly: Boolean(fly) }));
      const pose = await getAgentPose(bridge);
      return `${lines.join('\n')}\nThe robot is now at ${poseText(pose)}.`;
    },
  });

  add({
    name: 'teleport_to_player',
    description: 'Instantly teleport the robot to the player (agent tp). Quick way to fetch it when it is far away or stuck.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const res = await bridge.sendCommand('agent tp');
      const pose = await getAgentPose(bridge);
      navigator.agentMoved(pose);
      return `The game said: "${res.statusMessage}". The robot is at ${poseText(pose)}.`;
    },
  });

  // --- Acting on blocks -------------------------------------------------------

  add({
    name: 'destroy',
    description: 'Break the block next to the robot in a direction (the drop may land in the robot\'s inventory or on the ground).',
    destructive: true,
    parameters: { type: 'object', properties: { direction: dirParam('Which neighbouring block.') }, required: ['direction'] },
    async run({ direction }) {
      checkDirection(direction);
      return actOnCell('destroy', direction);
    },
  });

  add({
    name: 'place',
    description: 'Place a block from one of the robot\'s inventory slots (1-27) into the empty cell next to it.',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: 27 },
        direction: dirParam('Where to place it.'),
      },
      required: ['slot', 'direction'],
    },
    async run({ slot, direction }) {
      checkDirection(direction);
      return actOnCell('place', direction, `${clampInt(slot, 1, 27)} `);
    },
  });

  add({
    name: 'attack',
    description: 'Attack whatever mob or player is next to the robot in a direction.',
    destructive: true,
    parameters: { type: 'object', properties: { direction: dirParam('Which way to attack.') }, required: ['direction'] },
    async run({ direction }) {
      checkDirection(direction);
      const res = await bridge.sendCommand(`agent attack ${direction}`);
      return `The game said: "${res.statusMessage}".`;
    },
  });

  add({
    name: 'collect',
    description: 'Pick up dropped items near the robot into its inventory.',
    parameters: { type: 'object', properties: { item: { type: 'string', description: 'Item id, or "all" (default).' } } },
    async run({ item }) {
      const res = await bridge.sendCommand(`agent collect ${safeWord(item || 'all')}`);
      return `The game said: "${res.statusMessage}".`;
    },
  });

  add({
    name: 'drop',
    description: 'Drop items from one of the robot\'s inventory slots (1-27) in a direction.',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: 27 },
        quantity: { type: 'integer', minimum: 1, maximum: 64 },
        direction: dirParam('Which way to drop.'),
      },
      required: ['slot', 'direction'],
    },
    async run({ slot, quantity, direction }) {
      checkDirection(direction);
      const res = await bridge.sendCommand(`agent drop ${clampInt(slot, 1, 27)} ${clampInt(quantity ?? 64, 1, 64)} ${direction}`);
      return `The game said: "${res.statusMessage}".`;
    },
  });

  // --- Talking, waiting, raw --------------------------------------------------

  add({
    name: 'say',
    description: 'Say something in the Minecraft chat, visible to everyone (keep it short).',
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    async run({ message }) {
      const res = await sayInChat(bridge, settings, String(message || ''));
      return res.ok ? 'Said it.' : `Couldn't say it: ${res.statusMessage}`;
    },
  });

  add({
    name: 'wait',
    description: `Wait up to ${MAX_WAIT_S} seconds, e.g. for the player to get somewhere.`,
    parameters: { type: 'object', properties: { seconds: { type: 'number', minimum: 1, maximum: MAX_WAIT_S } }, required: ['seconds'] },
    async run({ seconds }, { signal } = {}) {
      const s = Math.min(MAX_WAIT_S, Math.max(0, Number(seconds) || 1));
      await sleep(s * 1000, signal);
      return `Waited ${s}s.`;
    },
  });

  add({
    name: 'run_command',
    description: 'Run any Minecraft Bedrock command (without the slash) as the player and get the game\'s raw reply, '
      + 'e.g. "agent till forward", "time set day", "give @s torch 16". Use the other tools when they fit.',
    raw: true,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async run({ command }) {
      const line = String(command || '').trim().replace(/^\/+/, '');
      if (!line) throw new Error('empty command');
      if (line.startsWith('#')) throw new Error('#console commands are for people; use the tools instead');
      const res = await bridge.sendCommand(line);
      const { statusCode, statusMessage, ...data } = res.body || {};
      return `${res.ok ? 'OK' : `Failed (${res.statusCode})`}: ${res.statusMessage}`
        + (Object.keys(data).length ? `\n${JSON.stringify(data)}` : '');
    },
  });

  async function captureNavigatorLog(fn) {
    const lines = [];
    const original = navigator.log;
    navigator.log = (text, extra) => {
      lines.push(text.split('\n')[0]);
      original(text, extra);
    };
    try {
      await fn();
    } finally {
      navigator.log = original;
    }
    return lines;
  }

  /** The tools currently enabled by the settings. */
  function list() {
    return tools.filter((t) => (!t.raw || settings.get('tools.allowRaw'))
      && (!t.destructive || settings.get('tools.allowDestructive')));
  }

  /**
   * Run a tool by name. Never throws: errors come back as { ok: false, text } so the model can
   * read them and try something else.
   */
  async function call(name, args, { signal, origin = 'LLM' } = {}) {
    const tool = list().find((t) => t.name === name);
    if (!tool) {
      const known = tools.some((t) => t.name === name);
      return { ok: false, text: known ? `The tool "${name}" is turned off in the Configuration tab.` : `There is no tool called "${name}".` };
    }
    log(`${origin} → ${name} ${JSON.stringify(args || {})}`);
    if (!bridge.connected) return { ok: false, text: 'Minecraft is not connected, so the robot can\'t do anything right now.' };
    try {
      const text = await tool.run(args || {}, { signal });
      return { ok: true, text: String(text) };
    } catch (err) {
      return { ok: false, text: `Error: ${err.message}` };
    }
  }

  /** Stop whatever the robot is walking (for the Stop button). */
  function stopRobot() {
    navigator.stop({ quiet: true });
  }

  return { list, call, tools, stopRobot };
}

/** A scan, told the way a model can use it. */
function summarizeScan(scan) {
  const { x: ax, y: ay, z: az } = scan.agent.position;
  const facing = ((Math.round(scan.agent.yRot / 90) % 4) + 4) % 4;
  const at = new Map(scan.cells.map((c) => [`${c.x},${c.y},${c.z}`, c.block]));
  const lines = [`Scanned ${scan.cells.length} blocks around the robot at ${ax} ${ay} ${az}, facing ${compassName(facing)} `
    + `(${orientationText(facing)}).`];

  lines.push(`Next to the robot: ${DIRECTIONS.map((d) => {
    const [dx, dy, dz] = offsetOf(d, facing);
    return `${d}: ${at.get(`${ax + dx},${ay + dy},${az + dz}`) || '?'}`;
  }).join(', ')}.`);

  let ground = null;
  for (let y = ay - 1; at.has(`${ax},${y},${az}`); y--) {
    if (isSolid(at.get(`${ax},${y},${az}`))) {
      ground = { y, block: at.get(`${ax},${y},${az}`) };
      break;
    }
  }
  lines.push(ground ? `Ground below: ${ground.block} at y ${ground.y} (${ay - ground.y - 1} blocks of space under the robot).`
    : 'No ground found below the robot within the scan.');

  const byType = new Map();
  for (const c of scan.cells) {
    if (c.block === 'Air') continue;
    if (!byType.has(c.block)) byType.set(c.block, []);
    byType.get(c.block).push(c);
  }
  const dist = (c) => Math.abs(c.x - ax) + Math.abs(c.y - ay) + Math.abs(c.z - az);
  const types = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
  const air = scan.cells.length - types.reduce((n, [, cells]) => n + cells.length, 0);
  lines.push(`Counts: Air ${air}, ${types.map(([name, cells]) => `${name} ${cells.length}`).join(', ') || 'nothing else'}.`);

  const rare = types.filter(([, cells]) => cells.length <= COMMON_THRESHOLD);
  if (rare.length) {
    lines.push('Where the less common blocks are (nearest first):');
    for (const [name, cells] of rare.reverse()) {
      const nearest = [...cells].sort((a, b) => dist(a) - dist(b)).slice(0, LIST_LIMIT_PER_TYPE);
      lines.push(`  ${name}: ${nearest.map((c) => `${c.x} ${c.y} ${c.z}`).join('; ')}${cells.length > nearest.length ? ` (+${cells.length - nearest.length} more)` : ''}`);
    }
  }

  // Terrain height: the top solid block of a few columns, so the model can tell hills from flat ground.
  const b = scan.cells.reduce((acc, c) => ({ minY: Math.min(acc.minY, c.y), maxY: Math.max(acc.maxY, c.y) }), { minY: Infinity, maxY: -Infinity });
  const tops = [];
  for (const d of ['forward', 'back', 'left', 'right']) {
    const [dx, , dz] = offsetOf(d, facing);
    const r = Math.round((b.maxY - b.minY) / 2);
    for (const k of [Math.ceil(r / 2), r]) {
      const cx = ax + dx * k;
      const cz = az + dz * k;
      let top = null;
      for (let y = b.maxY; y >= b.minY; y--) {
        const block = at.get(`${cx},${y},${cz}`);
        if (block && isSolid(block)) { top = y; break; }
      }
      tops.push(`${d} ${k}: ${top === null ? 'no ground' : `ground at y ${top}`}`);
    }
  }
  lines.push(`Ground height around: ${tops.join(', ')}.`);
  const unknown = scan.cells.filter((c) => c.block === '?').length;
  if (unknown) lines.push(`${unknown} blocks couldn't be identified.`);
  return lines.join('\n');
}

function countMoved(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function checkDirection(direction) {
  if (!DIRECTIONS.includes(direction)) throw new Error(`direction must be one of ${DIRECTIONS.join(', ')}`);
}

function safeWord(s) {
  const w = String(s).trim();
  if (!/^[\w:.-]+$/.test(w)) throw new Error(`"${w}" isn't a valid item id`);
  return w;
}

/** A chat line from the robot, via tellraw so it shows its own name instead of the player's. */
function sayInChat(bridge, settings, text) {
  const name = settings.get('chat.name') || 'ptolemy';
  const display = name.charAt(0).toUpperCase() + name.slice(1);
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/§/g, '').trim().slice(0, 400);
  const json = JSON.stringify({ rawtext: [{ text: `§b<${display}>§r ${clean}` }] });
  return bridge.sendCommand(`tellraw @a ${json}`, { quiet: true });
}

module.exports = { createToolbox, sayInChat, summarizeScan };
