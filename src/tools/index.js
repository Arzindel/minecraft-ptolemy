'use strict';

const { FORWARD, turnLeft, turnRight, getAgentPose } = require('../agent/pose');
const { isSolid } = require('../../public/blocks');
const { Frame } = require('../agent/frame');

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

const DIRECTION_HELP = 'Relative to the robot: forward = the block at 0 0 1, back = 0 0 -1, left = 1 0 0, right = -1 0 0, '
  + 'up = 0 1 0, down = 0 -1 0.';
const dirParam = (description) => ({ type: 'string', enum: DIRECTIONS, description: `${description} ${DIRECTION_HELP}` });
const WORLD_PARAM = { type: 'boolean', description: 'true if x y z are world (Minecraft) coordinates instead of relative ones. Default false.' };
// A block given by position, for destroy / place / attack.
const TARGET_PARAMS = {
  x: { type: 'integer', description: 'Instead of direction: the block\'s x (the robot walks next to it first if needed).' },
  y: { type: 'integer' },
  z: { type: 'integer' },
  world: WORLD_PARAM,
};

/**
 * @param {object} deps
 * @param {import('../minecraft/bridge').MinecraftBridge} deps.bridge
 * @param {import('../agent/world').WorldKnowledge} deps.world
 * @param {import('../agent/navigator').Navigator} deps.navigator
 * @param {import('../settings').Settings} deps.settings
 * @param {(radius: number, opts?: object) => Promise<object|null>} deps.scan
 * @param {(text: string, extra?: object) => void} deps.log
 * @param {() => object|null} deps.sight   the latest Sight (for status)
 * @param {import('../world/manager').WorldManager} deps.worlds   world detection and memory
 * @param {(text: string) => void} deps.notify   show a message in the WebUI
 * @param {() => void} [deps.activity]   called after every tool call (resets the wondering countdown)
 */
function createToolbox({ bridge, world, navigator, settings, scan, log, sight, worlds, notify, activity }) {
  const memory = () => {
    if (!worlds.current) throw new Error('no world is loaded yet (is Minecraft connected?)');
    return worlds.current;
  };
  const tools = [];
  const add = (tool) => tools.push(tool);

  /** The coordinate frame the model works in, at the robot's current pose. */
  async function frameNow(pose) {
    return new Frame(pose || await getAgentPose(bridge), settings.get('llm.coordinates'));
  }

  /** Where the player is, in the frame, for results after the robot moved. */
  async function playerLine(frame) {
    const p = await playerPosition();
    if (!p) return '';
    const where = worlds.current && (worlds.current.describeAreasAt(p.x, p.y, p.z) || worlds.current.describeAreasAt(p.x, p.y - 1, p.z));
    return ` The player is at ${frame.fmt(p.x, p.y, p.z)}${where ? ` (in ${where})` : ''}.`;
  }

  /** How the robot's pose reads to the model after a move or turn. */
  function afterMove(frame) {
    return frame.relative
      ? 'You are at 0 0 0 again: coordinates are now measured from your new position and facing.'
      : `The robot is at ${poseText(frame.pose)}.`;
  }

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
    const frame = await frameNow(pose);
    const where = `${direction} of the robot (${frame.fmt(x, y, z)})`;
    const game = `The game said: "${res.statusMessage}".`;
    if (before === after) return `Nothing changed ${where}: it is still ${after}. ${game}`;
    return `The block ${where} went from ${before} to ${after}. ${game}`;
  }

  /** Which of the six directions leads from the robot's cell to a face-adjacent cell, or null. */
  function directionTo(pose, x, y, z) {
    return DIRECTIONS.find((d) => {
      const [dx, dy, dz] = offsetOf(d, pose.facing);
      return pose.x + dx === x && pose.y + dy === y && pose.z + dz === z;
    }) || null;
  }

  /**
   * destroy / place / attack on a block given either as a direction or as coordinates. With
   * coordinates the robot first walks to a cell beside the block (never into it), then acts in the
   * right direction. Returns { direction, note } or { error }.
   */
  async function reach({ direction, x, y, z, world: isWorld }) {
    if (direction !== undefined && direction !== null && direction !== '') {
      checkDirection(direction);
      return { direction, note: '' };
    }
    if (![x, y, z].every((v) => Number.isFinite(Number(v)))) {
      throw new Error('give a direction (forward, back, left, right, up, down) or the block\'s x y z');
    }
    const pose = await getAgentPose(bridge);
    const frame = await frameNow(pose);
    const target = isWorld ? [x, y, z].map(Number) : frame.to(...[x, y, z].map(Number));
    if (target[0] === pose.x && target[1] === pose.y && target[2] === pose.z) {
      return { error: 'That is the robot\'s own cell (0 0 0). Give the block next to it, e.g. direction "forward" for 0 0 1.' };
    }
    const adjacent = directionTo(pose, ...target);
    if (adjacent) return { direction: adjacent, note: '' };

    // Walk to any free cell sharing a face with the target.
    const cells = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .map(([dx, dy, dz]) => [target[0] + dx, target[1] + dy, target[2] + dz])
      .filter((c) => world.state(...c) !== 'solid');
    if (!cells.length) return { error: 'Every side of that block is solid, so the robot can\'t get next to it.' };
    const lines = await captureNavigatorLog(() => navigator.pathfindwalk(
      { goal: { x: target[0], y: target[1], z: target[2], cells, label: 'next to the target block' } }, {},
    ));
    const after = await getAgentPose(bridge);
    const dir = directionTo(after, ...target);
    const afterFrame = await frameNow(after);
    if (!dir) {
      return { error: `Couldn't get next to that block: ${lines.map((l) => afterFrame.convertText(l)).join(' ')}` };
    }
    return { direction: dir, note: `Walked next to it first (${countMoved(pose, after)} blocks). ${afterMove(afterFrame)} ` };
  }

  // --- Looking around ---------------------------------------------------------

  add({
    name: 'get_status',
    description: 'Where the robot and the player are, which way the robot faces, and what is directly around the robot. Cheap: call it whenever you are unsure.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const lines = [];
      lines.push(`Minecraft: connected as ${bridge.player || 'unknown player'}`
        + `${worlds.current ? `, in the world "${worlds.current.name}"` : ''}.`);
      const pose = await getAgentPose(bridge);
      const frame = await frameNow(pose);
      const where = (p) => (worlds.current && worlds.current.describeAreasAt(p.x, p.y, p.z)) || null;
      lines.push(`Robot: at ${frame.here()}${where(pose) ? `, in ${where(pose)}` : ''}.`
        + (frame.relative ? '' : ` Relative directions: ${orientationText(pose.facing)}.`));
      const around = await Promise.all(DIRECTIONS.map(async (d) => {
        const [dx, dy, dz] = offsetOf(d, pose.facing);
        return `${d}${frame.relative ? ` (${frame.fmt(pose.x + dx, pose.y + dy, pose.z + dz)})` : ''}: ${await blockAt(pose.x + dx, pose.y + dy, pose.z + dz)}`;
      }));
      lines.push(`Next to the robot: ${around.join(', ')}.`);
      const player = await playerPosition();
      if (player) {
        const dist = Math.hypot(player.x - pose.x, player.y - pose.y, player.z - pose.z);
        lines.push(`Player ${bridge.player || ''}: at ${frame.fmt(player.x, player.y, player.z)}`
          + `${frame.relative ? ` (world ${player.x} ${player.y} ${player.z})` : ''} (roughly; this may be eye height), `
          + `${dist.toFixed(1)} blocks from the robot${where(player) ? `, in ${where(player)}` : ''}.`);
      }
      const s = sight();
      if (s) {
        const c = s.agent.position;
        lines.push(`Last scan: ${s.scanned} blocks around ${frame.fmt(c.x, c.y, c.z)}, ${Math.round((Date.now() - s.time) / 1000)}s ago.`);
      }
      if (navigator.busy) lines.push('The robot is busy walking a path right now.');
      return lines.join('\n');
    },
  });

  add({
    name: 'scan',
    description: 'Look at every block in a cube around the robot (radius 3 = 7x7x7, about 0.3s; radius 8 = 17x17x17, about 5s; '
      + 'a bigger scan means a longer result, so start small). '
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
      return summarizeScan(result, settings.get('llm.coordinates'));
    },
  });

  add({
    name: 'get_blocks',
    description: `Which block is at each of up to ${MAX_BLOCKS_QUERY} exact coordinates, e.g. 0 -1 0 for the block under the robot `
      + '(works anywhere loaded, not only near the robot).',
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
        world: WORLD_PARAM,
      },
      required: ['positions'],
    },
    async run({ positions, world: isWorld }) {
      if (!Array.isArray(positions) || !positions.length) throw new Error('positions must be a non-empty list of {x, y, z}');
      const list = positions.slice(0, MAX_BLOCKS_QUERY).map((p) => [p.x, p.y, p.z].map((v) => Math.round(Number(v))));
      if (list.some((p) => p.some((v) => !Number.isFinite(v)))) throw new Error('every position needs numeric x, y and z');
      const frame = await frameNow();
      const blocks = await Promise.all(list.map((p) => blockAt(...(isWorld ? p : frame.to(...p)))));
      return list.map((p, i) => `${p.join(' ')}: ${blocks[i]}`).join('\n');
    },
  });

  // --- Moving -----------------------------------------------------------------

  add({
    name: 'move',
    description: 'Move the robot 1-64 blocks in a straight line: forward/back along where it faces, left/right sideways without '
      + 'turning, up/down vertically. It can\'t enter solid blocks: it stops before one and says what blocked it (use destroy '
      + 'to clear it). Best for short, exact moves within sight; for far or winding trips use go_to.',
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
      if (!result.pose) return `Couldn't move: ${result.reason}.`;
      const frame = await frameNow(result.pose);
      const moved = countMoved(start, result.pose);
      if (result.ok) return `Moved ${n} ${direction}. ${afterMove(frame)}${await playerLine(frame)}`;
      if (result.stopped) return `Stopped by the user after ${moved} blocks. ${afterMove(frame)}`;
      if (!result.step) return `Couldn't move: ${result.reason}.`;
      const blocker = await blockAt(...result.step.enters);
      if (isSolid(blocker)) world.markBlocked(...result.step.enters);
      return `Moved ${moved} of ${n} blocks ${direction}, then was blocked by ${blocker} (now at ${frame.fmt(...result.step.enters)}, `
        + `directly ${direction} of you: "destroy ${direction}" would break it). ${afterMove(frame)}${await playerLine(frame)}`;
    },
  });

  add({
    name: 'turn',
    description: 'Turn the robot left, right or around (or to face a compass direction: north = world Z-, south = Z+, east = X+, west = X-).',
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
      if (!turns.length) return `Already facing ${to}.`;
      let facing = start.facing;
      const steps = turns.map((t) => {
        facing = t === 'right' ? turnRight(facing) : turnLeft(facing);
        return { action: `turn ${t}`, command: `agent turn ${t}`, expect: { x: start.x, y: start.y, z: start.z, facing }, enters: null };
      });
      const result = await navigator.runSteps(steps);
      if (!result.ok) return `Turn failed: ${result.reason || 'stopped'}.`;
      const frame = await frameNow(result.pose);
      if (frame.relative) return `Turned ${to} (now facing ${compassName(result.pose.facing)}). ${afterMove(frame)}${await playerLine(frame)}`;
      return `Now facing ${compassName(result.pose.facing)}. ${orientationText(result.pose.facing)}.`;
    },
  });

  add({
    name: 'go_to',
    description: 'Pathfinding: travel to coordinates, to the player or to a named area, planning a route around obstacles and '
      + 'scanning unknown ground on the way. Meant for longer trips (beyond a few blocks, out of sight, or around walls): it is '
      + 'slow. For a block or two use move; to break or place a block use destroy/place with its x y z instead. '
      + 'If the target is a solid block, the robot stops beside it.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        target: { type: 'string', enum: ['coordinates', 'player', 'area'], description: '"player" goes next to the player, "area" to the middle of a named area; both ignore x/y/z. Default "coordinates".' },
        area: { type: 'string', description: 'Name of the area, with target "area".' },
        world: WORLD_PARAM,
        fly: { type: 'boolean', description: 'Take the straightest route through the air instead of staying close to the ground (default false).' },
      },
    },
    async run({ x, y, z, target, fly, area, world: isWorld }) {
      let args;
      if (target === 'player') args = ['@p'];
      else if (target === 'area' || (area && ![x, y, z].every((v) => Number.isFinite(Number(v))))) {
        const a = memory().findArea(area);
        if (!a) throw new Error(`there's no area called "${area}"`);
        // The middle of the area, at its floor: the pathfinder stops next to it if that's solid.
        args = [Math.floor((a.min[0] + a.max[0]) / 2), a.min[1], Math.floor((a.min[2] + a.max[2]) / 2)].map(String);
      } else {
        if (![x, y, z].every((v) => Number.isFinite(Number(v)))) throw new Error('give x, y and z, or target "player"');
        const frame = await frameNow();
        const pose = frame.pose;
        const goal = [x, y, z].map((v) => Math.round(Number(v)));
        const target = isWorld ? goal : frame.to(...goal);
        // Pathfinding to a block right beside the robot is a mistake a model makes when it wants to act on it.
        const dist = Math.max(Math.abs(target[0] - pose.x), Math.abs(target[1] - pose.y), Math.abs(target[2] - pose.z));
        if (dist <= 3 && world.state(...target) === 'solid') {
          const dir = directionTo(pose, ...target);
          return dir
            ? `Not moving: that block is right beside you (${dir}). To break it use destroy with direction "${dir}"; `
              + 'to stand elsewhere, use move.'
            : `Not moving: that is a solid block only ${dist} block(s) away. To break or place a block, call destroy/place with `
              + 'its x y z (they walk beside it on their own); for short moves use move.';
        }
        args = target.map(String);
      }
      const lines = await captureNavigatorLog(() => navigator.pathfindwalk(args, { fly: Boolean(fly) }));
      const frame = await frameNow();
      // The pathfinder talks in world coordinates: put them in the model's frame, as seen from where the robot ended up.
      return `${lines.map((l) => frame.convertText(l)).join('\n')}\n${afterMove(frame)}${await playerLine(frame)}`;
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
      const frame = await frameNow(pose);
      return `The game said: "${res.statusMessage}". ${afterMove(frame)}${await playerLine(frame)}`;
    },
  });

  // --- Acting on blocks -------------------------------------------------------

  add({
    name: 'destroy',
    description: 'Break one block. The robot stays where it is and breaks the block beside it in the given direction: it never '
      + 'moves into the block. Give either a direction (for a block touching the robot) or the block\'s x y z (any distance: '
      + 'the robot first walks to a spot beside it). The drop may go into the robot\'s inventory or onto the ground.',
    destructive: true,
    parameters: { type: 'object', properties: { direction: dirParam('Which neighbouring block.'), ...TARGET_PARAMS } },
    async run(args) {
      const r = await reach(args);
      if (r.error) throw new Error(r.error);
      return r.note + await actOnCell('destroy', r.direction);
    },
  });

  add({
    name: 'place',
    description: 'Place a block from one of the robot\'s inventory slots (1-27) into an empty cell. The robot stays where it is '
      + 'and fills the cell beside it in the given direction. Give either a direction or the empty cell\'s x y z (any distance: '
      + 'the robot first walks to a spot beside it).',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: 27 },
        direction: dirParam('Which neighbouring cell to fill.'),
        ...TARGET_PARAMS,
      },
      required: ['slot'],
    },
    async run(args) {
      const r = await reach(args);
      if (r.error) throw new Error(r.error);
      return r.note + await actOnCell('place', r.direction, `${clampInt(args.slot, 1, 27)} `);
    },
  });

  add({
    name: 'attack',
    description: 'Attack whatever mob or player is in the cell beside the robot in a direction (or at x y z: the robot walks '
      + 'beside it first).',
    destructive: true,
    parameters: { type: 'object', properties: { direction: dirParam('Which way to attack.'), ...TARGET_PARAMS } },
    async run(args) {
      const r = await reach(args);
      if (r.error) throw new Error(r.error);
      const res = await bridge.sendCommand(`agent attack ${r.direction}`);
      return `${r.note}Attacked ${r.direction}. The game said: "${res.statusMessage}".`;
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
    name: 'send_chat',
    description: 'Send a message to the Minecraft chat, seen by every player (keep it short, no markdown). '
      + 'Use it to tell players something even when the request came from the WebUI.',
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    async run({ message }) {
      const res = await sayInChat(bridge, settings, String(message || ''));
      return res.ok ? 'Sent to the game chat.' : `Couldn't send it: ${res.statusMessage}`;
    },
  });

  add({
    name: 'send_webui',
    description: 'Show a message to the person at the Ptolemy WebUI (highlighted in the Automatic tab), '
      + 'even when the request came from the game chat.',
    offline: true,
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    async run({ message }) {
      const text = String(message || '').trim();
      if (!text) throw new Error('empty message');
      notify(text.slice(0, 2000));
      return 'Shown in the WebUI.';
    },
  });

  // --- Memory (per world) -------------------------------------------------------

  add({
    name: 'get_memory',
    description: 'Everything remembered about this world: named areas, the todo list, what\'s on your mind, notes, recent requests.',
    offline: true,
    parameters: { type: 'object', properties: {} },
    async run() {
      return memory().promptBlock(await frameNow());
    },
  });

  add({
    name: 'add_area',
    description: 'Remember a named area (a box between two opposite corners, in your current coordinates), e.g. "house" or "kitchen". An area inside another '
      + 'is understood as part of it. Reusing a name moves that area. Give one corner for a single spot (e.g. "chest").',
    offline: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x1: { type: 'integer' }, y1: { type: 'integer' }, z1: { type: 'integer' },
        x2: { type: 'integer' }, y2: { type: 'integer' }, z2: { type: 'integer' },
        note: { type: 'string', description: 'Optional short description.' },
      },
      required: ['name', 'x1', 'y1', 'z1'],
    },
    async run({ name, x1, y1, z1, x2, y2, z2, note }) {
      const corner2 = [x2, y2, z2].every((v) => v !== undefined && v !== null) ? [x2, y2, z2] : [x1, y1, z1];
      const frame = await frameNow();
      const num = (c) => c.map((v) => Math.round(Number(v)));
      const a = memory().setArea(name, frame.to(...num([x1, y1, z1])), frame.to(...num(corner2)), note);
      const parent = memory().parentOf(a);
      const box = frame.box(a.min, a.max);
      return `Saved area "${a.name}": ${box.min.join(' ')} to ${box.max.join(' ')}${parent ? `, inside "${parent.name}"` : ''}. `
        + 'It is stored in world terms, so it stays put as you move.';
    },
  });

  add({
    name: 'remove_area',
    description: 'Forget a named area.',
    offline: true,
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run({ name }) {
      return memory().removeArea(name) ? `Forgot "${name}".` : `There's no area called "${name}".`;
    },
  });

  add({
    name: 'todo_write',
    description: 'Replace your todo list for this world with this one. Use it to plan multi-step work and keep it current: '
      + 'mark one item in_progress while you work on it and done when finished. Send the whole list every time.',
    offline: true,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
            required: ['text', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async run({ todos }) {
      memory().setTodos(todos);
      const list = memory().data.todos;
      return list.length ? `Todo list:\n${list.map((t) => `- [${t.status}] ${t.text}`).join('\n')}` : 'The todo list is empty.';
    },
  });

  add({
    name: 'add_thought',
    description: 'Put something on your mind, a passing wish or curiosity ("I want to see the flowers by the river"). '
      + 'You may act on it later, e.g. while wondering. Only the last few thoughts are kept.',
    offline: true,
    parameters: { type: 'object', properties: { thought: { type: 'string' } }, required: ['thought'] },
    async run({ thought }) {
      memory().addThought(thought);
      return `On your mind now: ${memory().data.thoughts.map((t) => `"${t.text}"`).join(', ')}.`;
    },
  });

  add({
    name: 'drop_thought',
    description: 'Let go of a thought (by its text or number), e.g. once you\'ve acted on it.',
    offline: true,
    parameters: { type: 'object', properties: { thought: { type: 'string' } }, required: ['thought'] },
    async run({ thought }) {
      const removed = memory().remove('thoughts', thought);
      return removed ? `Let go of "${removed.text}".` : 'No such thought.';
    },
  });

  add({
    name: 'remember',
    description: 'Save a fact about this world for good, e.g. "the chest with wood is at 10 64 5" or "the player likes birch".',
    offline: true,
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    async run({ note }) {
      memory().addNote(note);
      return 'Noted.';
    },
  });

  add({
    name: 'forget',
    description: 'Delete a saved note (by its text or number).',
    offline: true,
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    async run({ note }) {
      const removed = memory().remove('notes', note);
      return removed ? `Forgot "${removed.text}".` : 'No such note.';
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
    if (!bridge.connected && !tool.offline) return { ok: false, text: 'Minecraft is not connected, so the robot can\'t do anything right now.' };
    try {
      const text = await tool.run(args || {}, { signal });
      return { ok: true, text: String(text) };
    } catch (err) {
      return { ok: false, text: `Error: ${err.message}` };
    } finally {
      if (activity) activity();
    }
  }

  /** Stop whatever the robot is walking (for the Stop button). */
  function stopRobot() {
    navigator.stop({ quiet: true });
  }

  return { list, call, tools, stopRobot };
}

/** A scan, told the way a model can use it. */
function summarizeScan(scan, mode = 'world') {
  const { x: ax, y: ay, z: az } = scan.agent.position;
  const facing = ((Math.round(scan.agent.yRot / 90) % 4) + 4) % 4;
  const frame = new Frame({ x: ax, y: ay, z: az, facing }, mode);
  const at = new Map(scan.cells.map((c) => [`${c.x},${c.y},${c.z}`, c.block]));
  const lines = [frame.relative
    ? `Scanned ${scan.cells.length} blocks around you (you are at 0 0 0; x = left, y = up, z = ahead).`
    : `Scanned ${scan.cells.length} blocks around the robot at ${ax} ${ay} ${az}, facing ${compassName(facing)} `
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
  lines.push(ground ? `Ground below: ${ground.block} at y ${frame.relative ? ground.y - ay : ground.y} (${ay - ground.y - 1} blocks of space under the robot).`
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
      lines.push(`  ${name}: ${nearest.map((c) => frame.fmt(c.x, c.y, c.z)).join('; ')}${cells.length > nearest.length ? ` (+${cells.length - nearest.length} more)` : ''}`);
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
      tops.push(`${d} ${k}: ${top === null ? 'no ground' : `ground at y ${frame.relative ? top - ay : top}`}`);
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

// What the robot said recently, so its own lines coming back as chat events are never requests.
const recentlySaid = [];

/** A chat line from the robot, via tellraw so it shows its own name instead of the player's. */
function sayInChat(bridge, settings, text) {
  const name = (settings.get('chat.name') || 'Ptolemy').trim();
  const display = name.charAt(0).toUpperCase() + name.slice(1);
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/§/g, '').trim().slice(0, 400);
  recentlySaid.push({ text: clean, time: Date.now() });
  if (recentlySaid.length > 20) recentlySaid.shift();
  const json = JSON.stringify({ rawtext: [{ text: `§b<${display}>§r ${clean}` }] });
  return bridge.sendCommand(`tellraw @a ${json}`, { quiet: true });
}

/** Is this chat message one of the robot's own lines echoing back? */
function isOwnChat(message) {
  const text = String(message || '');
  if (/^§b</.test(text)) return true;
  const plain = text.replace(/§./g, '');
  return recentlySaid.some((r) => Date.now() - r.time < 30000 && plain.includes(r.text));
}

module.exports = { createToolbox, sayInChat, isOwnChat, summarizeScan };
