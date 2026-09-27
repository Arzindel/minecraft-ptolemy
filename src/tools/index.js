'use strict';

const { FORWARD, turnLeft, turnRight, getAgentPose } = require('../agent/pose');
const { isSolid } = require('../../public/blocks');
const { Frame } = require('../agent/frame');
const players = require('../agent/players');
const entities = require('../agent/entities');

// Tools the LLM (and MCP clients) drive the robot with. Most are shortcuts that bundle several
// game commands and report what actually happened, since the game's own replies say "success"
// even when the agent bumped into a wall. `run_command` is the raw escape hatch.

const DIRECTIONS = ['forward', 'back', 'left', 'right', 'up', 'down'];
const COMPASS = { south: 0, west: 1, north: 2, east: 3 };
const MAX_MOVE = 64;
const MAX_BLOCKS_QUERY = 64;
const MAX_WAIT_S = 60;
const MAX_SCAN_RADIUS = 15;
const LIST_ENTITIES = 30;
// Blocks that are everywhere: counted in scan summaries, but not listed one by one.
const LIST_LIMIT_PER_TYPE = 5;
const COMMON_THRESHOLD = 20;

const NO_FLIGHT = 'Not allowed: flying and teleporting need the player\'s explicit permission in this request, and they didn\'t '
  + 'ask for it. Walk instead (go_to without fly, or move); if you can\'t get there on foot, say so.';

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
  return `x=${p.x} y=${p.y} z=${p.z}, facing ${compassName(p.facing)}`;
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

const DIRECTION_HELP = 'One of the six blocks touching the robot.';
const dirParam = (description) => ({ type: 'string', enum: DIRECTIONS, description: `${description} ${DIRECTION_HELP}` });
// A position is either relative (counts of blocks from the robot, by direction) or world (x, y, z).
// The two never share names, so the model can't mix them up.
const count = (dir) => ({ type: 'integer', minimum: 0, description: `Relative position: blocks ${dir} from the robot.` });
const POSITION_PROPS = {
  forward: count('forward (ahead)'), back: count('back (behind)'), left: count('to the left'), right: count('to the right'),
  up: count('up'), down: count('down'),
  x: { type: 'integer', description: 'World position x. Give x, y and z together, only for world coordinates.' },
  y: { type: 'integer', description: 'World position y (height).' },
  z: { type: 'integer', description: 'World position z.' },
};
const POSITION = {
  type: 'object',
  description: 'A position: EITHER relative (forward/back/left/right/up/down block counts from the robot) OR world (x, y, z).',
  properties: POSITION_PROPS,
};

/**
 * @param {object} deps
 * @param {import('../minecraft/bridge').MinecraftBridge} deps.bridge
 * @param {import('../agent/world').WorldKnowledge} deps.world
 * @param {import('../agent/navigator').Navigator} deps.navigator
 * @param {import('../settings').Settings} deps.settings
 * @param {(radius: number, opts?: object) => Promise<object|null>} deps.scan
 * @param {(radius: number, opts?: object) => Promise<{pose, entities}|null>} deps.lookForEntities   also shows them in the Nanny Cam
 * @param {(text: string, extra?: object) => void} deps.log
 * @param {() => object|null} deps.sight   the latest Sight (for status)
 * @param {import('../world/manager').WorldManager} deps.worlds   world detection and memory
 * @param {(text: string) => void} deps.notify   show a message in the WebUI
 * @param {() => void} [deps.activity]   called after every tool call (resets the wondering countdown)
 * @param {(mode: string) => void} [deps.setWonder]   switch wondering off / on / always
 */
function createToolbox({ bridge, world, navigator, settings, scan, lookForEntities, log, sight, worlds, notify, activity, setWonder }) {
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

  function areaOf(p) {
    return worlds.current && (worlds.current.describeAreasAt(p.x, p.y, p.z) || worlds.current.describeAreasAt(p.x, p.y - 1, p.z));
  }

  /** Where the player who asked is, in the frame, for results after the robot moved. */
  async function playerLine(frame) {
    const p = await players.playerPosition(bridge, requester);
    if (!p) return '';
    const where = areaOf(p);
    return ` ${p.name || 'The player'}${p.name && p.name === requester && requesterAsked ? ' (who asked you)' : ''} is at `
      + `${frame.fmt(p.x, p.y, p.z)}${where ? ` (in ${where})` : ''}.`;
  }

  /** The online player a tool call means: the named one, else whoever asked, else the connected player. */
  async function whichPlayer(name) {
    if (name) {
      const online = await players.listPlayers(bridge);
      const match = players.matchPlayer(online, name);
      if (!match) throw new Error(`no player called "${name}" is online. Online: ${online.join(', ') || 'nobody'}`);
      return match;
    }
    return requester || bridge.player;
  }

  /** How the robot's pose reads to the model after a move or turn. */
  function afterMove(frame) {
    return frame.relative
      ? `You are now at ${Frame.world(frame.pose.x, frame.pose.y, frame.pose.z)}, facing ${compassName(frame.pose.facing)}; `
        + 'relative positions (forward, left...) are now measured from here.'
      : `The robot is at ${poseText(frame.pose)}.`;
  }

  async function blockAt(x, y, z) {
    const res = await bridge.sendCommand(`testforblock ${x} ${y} ${z} air`, { quiet: true });
    if (res.body && res.body.matches === true) return 'Air';
    const m = /\bis (.+?)\s*\(expected/i.exec(res.statusMessage || '');
    if (m) return m[1];
    return `unknown (${res.statusMessage})`;
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
    const where = `${direction} of the robot (${Frame.world(x, y, z)})`;
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
  async function reach(args) {
    const { direction } = args;
    if (direction !== undefined && direction !== null && direction !== '') {
      checkDirection(direction);
      return { direction, note: '' };
    }
    const pose = await getAgentPose(bridge);
    const frame = await frameNow(pose);
    const target = frame.parse(args);
    if (!target) {
      throw new Error('give a direction (forward, back, left, right, up, down) for a block touching the robot, or the block\'s '
        + 'position: relative (e.g. forward 2, left 1) or world (x, y, z)');
    }
    if (target[0] === pose.x && target[1] === pose.y && target[2] === pose.z) {
      return { error: 'That is where the robot itself is. Give a block next to it, e.g. direction "forward".' };
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

  /** A look for entities, told the way a model can use it. */
  async function entitiesText(radius) {
    const look = await lookForEntities(radius, { quiet: true });
    if (!look) throw new Error('looking for entities failed (see the console)');
    const found = look.entities;
    if (!found.length) return `Entities: none (no mobs, animals, players or items) within ${radius} blocks of the robot.`;
    const frame = await frameNow(look.pose);
    const lines = [`Entities within ${radius} blocks of the robot, nearest first (a snapshot: they move): ${entities.countsText(found)}.`];
    for (const e of found.slice(0, LIST_ENTITIES)) {
      const tags = [
        e.type && !['item', 'player'].includes(e.type) && entities.typeGuess(e.name) !== e.type && `a ${e.type.replace(/_/g, ' ')}`,
        e.hostile && 'hostile',
        e.player && 'player, height may be their head',
        e.item && 'dropped item: collect picks it up from nearby',
      ].filter(Boolean).join(', ');
      const where = areaOf(e);
      lines.push(`- ${e.name}${tags ? ` (${tags})` : ''}: ${frame.fmt(e.x, e.y, e.z)}, ${e.distance.toFixed(1)} blocks away`
        + `${where ? `, in ${where}` : ''}`);
    }
    if (found.length > LIST_ENTITIES) lines.push(`(+${found.length - LIST_ENTITIES} more, further away)`);
    if (found.some((e) => e.name === 'Unidentified entity')) {
      lines.push('Unidentified entities are there, but the game didn\'t say what they are.');
    }
    return lines.join('\n');
  }

  // --- Looking around ---------------------------------------------------------

  add({
    name: 'get_status',
    description: 'Where the robot and every player online are, which way the robot faces, and what is directly around the robot. Cheap: call it whenever you are unsure.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const lines = [];
      lines.push(`Minecraft: connected as ${bridge.player || 'unknown player'}`
        + `${worlds.current ? `, in the world "${worlds.current.name}"` : ''}.`);
      const pose = await getAgentPose(bridge);
      const frame = await frameNow(pose);
      const here = worlds.current && worlds.current.describeAreasAt(pose.x, pose.y, pose.z);
      lines.push(`Robot: at ${frame.here()}${here ? `, in ${here}` : ''}.`
        + ` Its forward is ${compassName(pose.facing)}: ${orientationText(pose.facing)}.`);
      const around = await Promise.all(DIRECTIONS.map(async (d) => {
        const [dx, dy, dz] = offsetOf(d, pose.facing);
        return `${d}: ${await blockAt(pose.x + dx, pose.y + dy, pose.z + dz)}`;
      }));
      lines.push(`Next to the robot: ${around.join(', ')}.`);
      const everyone = await players.allPlayers(bridge);
      for (const player of everyone) {
        const dist = Math.hypot(player.x - pose.x, player.y - pose.y, player.z - pose.z);
        const tags = [player.name === requester && requesterAsked ? 'asked you' : '', player.name === bridge.player ? 'at the Ptolemy PC' : '']
          .filter(Boolean).join(', ');
        lines.push(`Player ${player.name}${tags ? ` (${tags})` : ''}: ${frame.fmt(player.x, player.y, player.z)} `
          + `(roughly; this may be eye height), ${dist.toFixed(1)} blocks from the robot${areaOf(player) ? `, in ${areaOf(player)}` : ''}.`);
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
    description: 'Look around the robot. what "blocks": every block in a cube around it (radius 3 = 7x7x7, about 0.3s; '
      + 'radius 8 = 17x17x17, about 5s; a bigger scan means a longer result, so start small): what is next to the robot, '
      + 'the ground below it, counts of each block type, and the coordinates of the rarer blocks; it also updates the '
      + 'robot\'s map for go_to. what "entities": mobs, animals, players and dropped items (fast, up to '
      + `${entities.MAX_RADIUS} blocks away): what each one is, where, how far, and which are hostile. They move, so call it `
      + 'again before acting on one; to attack one, pass its position to attack. what "both" (the default): the two at once.',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: entities.WHAT, description: 'What to look for (default "both").' },
        radius: {
          type: 'integer', minimum: 1, maximum: entities.MAX_RADIUS,
          description: `Blocks in each direction. Blocks: up to ${MAX_SCAN_RADIUS} (default: the configured scan radius). `
            + `Entities: always at least ${entities.DEFAULT_RADIUS} unless what is "entities" alone.`,
        },
      },
    },
    async run({ what, radius }) {
      const mode = entities.WHAT.includes(what) ? what : 'both';
      const r = clampInt(radius ?? settings.get('scan.radius'), 1, MAX_SCAN_RADIUS);
      const [blocks, seen] = await Promise.all([
        mode !== 'entities' && scan(r, { quiet: true }),
        mode !== 'blocks' && entitiesText(entities.entityRadius(mode === 'entities' ? radius : radius ?? r, mode)),
      ]);
      if (mode !== 'entities' && !blocks) throw new Error('the scan failed (see the console)');
      return [blocks && summarizeScan(blocks, settings.get('llm.coordinates')), seen].filter(Boolean).join('\n');
    },
  });

  add({
    name: 'get_blocks',
    description: `Which block is at up to ${MAX_BLOCKS_QUERY} positions. Each position is relative (e.g. {down: 1} for the block `
      + 'under the robot, {forward: 2, left: 1}) or world ({x, y, z}). Works anywhere loaded, not only near the robot.',
    parameters: {
      type: 'object',
      properties: { positions: { type: 'array', maxItems: MAX_BLOCKS_QUERY, items: POSITION } },
      required: ['positions'],
    },
    async run({ positions }) {
      if (!Array.isArray(positions) || !positions.length) throw new Error('positions must be a non-empty list');
      const frame = await frameNow();
      const list = positions.slice(0, MAX_BLOCKS_QUERY).map((p) => {
        const w = frame.parse(p);
        if (!w) throw new Error('every position needs forward/back/left/right/up/down counts, or x, y and z');
        return w;
      });
      const blocks = await Promise.all(list.map((w) => blockAt(...w)));
      return list.map((w, i) => `${frame.fmt(...w)}: ${blocks[i]}`).join('\n');
    },
  });

  add({
    name: 'locate',
    description: 'Translate one position between the two systems: give it relative (e.g. {forward: 2, down: 1}) or world '
      + '({x: 5, y: 89, z: -3}) and get both, plus the block there and any named area it is in.',
    parameters: POSITION,
    async run(args) {
      const frame = await frameNow();
      const w = frame.parse(args);
      if (!w) throw new Error('give forward/back/left/right/up/down counts, or x, y and z');
      const where = worlds.current && worlds.current.describeAreasAt(...w);
      const rel = new Frame(frame.pose, 'relative');
      return `Relative: ${rel.words(...w)}. World: ${Frame.world(...w)}. Block there: ${await blockAt(...w)}.`
        + `${where ? ` In ${where}.` : ''}`;
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
        target: { type: 'string', enum: ['position', 'player', 'area'], description: '"position" (default): the position given below. "player": to a player (see player). "area": the middle of a named area.' },
        player: { type: 'string', description: 'With target "player": which player, by name. Default: the player who asked you.' },
        ...POSITION_PROPS,
        area: { type: 'string', description: 'Name of the area, with target "area".' },
        precision: { type: 'string', enum: ['near', 'exact'], description: '"near": stop somewhere around the target (beside, diagonal or 2 '
          + 'blocks away, preferably standing on ground). "exact": end exactly on it. Default: near for the player and areas, '
          + 'exact for positions. "Come here" / "come to me" means near; "stand where I am" means exact.' },
        fly: { type: 'boolean', description: 'ONLY if the player explicitly asked you to fly in this request: take the straightest route through the air. Otherwise leave it out.' },
      },
    },
    async run(params) {
      const { target, fly, area, precision } = params;
      const near = precision === 'near' ? true : precision === 'exact' ? false : null;
      let args;
      const start = await frameNow();
      const given = start.parse(params);
      if (target === 'player') args = ['@p', await whichPlayer(params.player)];
      else if (target === 'area' || (area && !given)) {
        const a = memory().findArea(area);
        if (!a) throw new Error(`there's no area called "${area}"`);
        // The middle of the area, at its floor: the pathfinder stops next to it if that's solid.
        args = [Math.floor((a.min[0] + a.max[0]) / 2), a.min[1], Math.floor((a.min[2] + a.max[2]) / 2)].map(String);
      } else {
        if (!given) throw new Error('give a position (forward/back/left/right/up/down counts, or x, y, z), or target "player" or "area"');
        const pose = start.pose;
        const target = given;
        // Pathfinding to a block right beside the robot is a mistake a model makes when it wants to act on it.
        const dist = Math.max(Math.abs(target[0] - pose.x), Math.abs(target[1] - pose.y), Math.abs(target[2] - pose.z));
        if (dist <= 3 && world.state(...target) === 'solid') {
          const dir = directionTo(pose, ...target);
          return dir
            ? `Not moving: that block is right beside you (${dir}). To break it use destroy with direction "${dir}"; `
              + 'to stand elsewhere, use move.'
            : `Not moving: that is a solid block only ${dist} block(s) away. To break or place a block, call destroy/place with `
              + 'its position (they walk beside it on their own); for short moves use move.';
        }
        args = target.map(String);
      }
      const nearDefault = near === null && (target === 'area' || (area && !given)) ? true : near;
      const lines = await captureNavigatorLog(() => navigator.pathfindwalk(args, { fly: Boolean(fly), near: nearDefault }));
      const frame = await frameNow();
      // The pathfinder talks in world coordinates: put them in the model's frame, as seen from where the robot ended up.
      return `${lines.map((l) => frame.convertText(l)).join('\n')}\n${afterMove(frame)}${await playerLine(frame)}`;
    },
  });

  add({
    name: 'teleport_to_player',
    description: 'Instantly teleport the robot to a player (agent tp). ONLY when the player explicitly asked for a teleport in '
      + 'this request. Otherwise walk with go_to, and say so if you can\'t get there.',
    flight: true,
    parameters: { type: 'object', properties: { player: { type: 'string', description: 'Which player, by name. Default: the player who asked you.' } } },
    async run({ player: wanted }) {
      const name = await whichPlayer(wanted);
      let res;
      if (!name || name === bridge.player) {
        res = await bridge.sendCommand('agent tp'); // the agent's owner: the connected player
      } else {
        const p = await players.playerPosition(bridge, name);
        if (!p) throw new Error(`can't find ${name}`);
        res = await bridge.sendCommand(`agent tp ${p.x} ${p.y} ${p.z}`);
      }
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
      + 'moves into the block. Give either a direction (for a block touching the robot) or the block\'s position, relative '
      + '(e.g. forward 1, left 1) or world (x, y, z), at any distance: the robot first walks to a spot beside it. '
      + 'The drop may go into the robot\'s inventory or onto the ground.',
    destructive: true,
    parameters: { type: 'object', properties: { direction: dirParam('Which neighbouring block.'), ...POSITION_PROPS } },
    async run(args) {
      const r = await reach(args);
      if (r.error) throw new Error(r.error);
      return r.note + await actOnCell('destroy', r.direction);
    },
  });

  add({
    name: 'place',
    description: 'Place a block from one of the robot\'s inventory slots (1-27) into an empty cell. The robot stays where it is '
      + 'and fills the cell beside it in the given direction. Give either a direction or the empty cell\'s position (relative '
      + 'or world, any distance: the robot first walks to a spot beside it).',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: 27 },
        direction: dirParam('Which neighbouring cell to fill.'),
        ...POSITION_PROPS,
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
    description: 'Attack whatever mob or player is in the cell beside the robot in a direction (or at a position: the robot '
      + 'walks beside it first). scan with what "entities" says where mobs are.',
    destructive: true,
    parameters: { type: 'object', properties: { direction: dirParam('Which way to attack.'), ...POSITION_PROPS } },
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
    description: 'Remember a named area: a box between two opposite corners, e.g. "house" or "kitchen". Each corner is a '
      + 'position, relative (e.g. {forward: 5, left: 3}) or world ({x, y, z}). An area inside another is understood as part of '
      + 'it. Reusing a name moves that area. Give only corner1 for a single spot (e.g. "chest").',
    offline: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        corner1: POSITION,
        corner2: POSITION,
        note: { type: 'string', description: 'Optional short description.' },
      },
      required: ['name', 'corner1'],
    },
    async run({ name, corner1, corner2, note }) {
      const frame = await frameNow();
      const a1 = frame.parse(corner1);
      if (!a1) throw new Error('corner1 needs forward/back/left/right/up/down counts, or x, y and z');
      const a2 = frame.parse(corner2) || a1;
      const a = memory().setArea(name, a1, a2, note);
      const parent = memory().parentOf(a);
      return `Saved area "${a.name}": world ${Frame.world(...a.min)} to ${Frame.world(...a.max)}`
        + `${parent ? `, inside "${parent.name}"` : ''}. It stays put as you move.`;
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
    description: 'Your long-term memory for this world: save something to keep for good, e.g. "Arzindel likes birch wood", '
      + '"the wood chest is in the storage room", "never break the glass in the kitchen". Use it whenever someone asks you to '
      + 'remember something, or you learn something worth keeping. To change an existing entry, pass replace with its '
      + 'number or some of its text.',
    offline: true,
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'What to remember (no coordinates: name places with add_area instead).' },
        replace: { type: 'string', description: 'Optional: the number or some text of an entry to overwrite with this one.' },
      },
      required: ['note'],
    },
    async run({ note, replace }) {
      if (replace) {
        const old = memory().updateNote(replace, note);
        if (old === null) throw new Error(`there's no memory matching "${replace}"`);
        return `Updated: "${old}" is now "${note}".`;
      }
      memory().addNote(note);
      return `Remembered (entry ${memory().data.notes.length}).`;
    },
  });

  add({
    name: 'forget',
    description: 'Drop an entry from your long-term memory (by its number or some of its text).',
    offline: true,
    parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
    async run({ note }) {
      const removed = memory().remove('notes', note);
      return removed ? `Forgot "${removed.text}".` : 'No such note.';
    },
  });

  // --- Changing itself (so players can do it from the game chat, no WebUI needed) --------

  add({
    name: 'set_name',
    description: 'Change your own name, e.g. when told "your name is now Boris". It becomes the word that calls you in the '
      + 'game chat and the name your chat messages are signed with. Optionally also change the ignore word (a word that '
      + 'means "we\'re talking about you, not to you").',
    offline: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'One word: letters, digits or _.' },
        ignore_word: { type: 'string', description: 'Optional new ignore word, also one word.' },
      },
      required: ['name'],
    },
    async run({ name, ignore_word: ignore }) {
      const clean = String(name || '').trim();
      if (!/^[A-Za-z0-9_]{2,24}$/.test(clean)) throw new Error('the name must be one word of 2-24 letters, digits or _');
      const patch = { 'chat.name': clean };
      if (ignore) {
        if (!/^[A-Za-z0-9_]{2,24}$/.test(String(ignore).trim())) throw new Error('the ignore word must be one word of 2-24 letters, digits or _');
        patch['chat.ignore'] = String(ignore).trim();
      }
      const old = settings.get('chat.name');
      settings.update(patch);
      return `Your name is now ${clean} (was ${old}). Players call you by writing "${clean}" in the chat`
        + `${settings.get('chat.ignore') ? `; messages containing "${settings.get('chat.ignore')}" are ignored` : ''}.`;
    },
  });

  add({
    name: 'set_wondering',
    description: 'Switch wondering (acting on your own when idle): "off", "on" (until someone asks for something) or "always". '
      + 'Optionally set how many idle seconds come before each wander. Use it when a player tells you to go do your own '
      + 'thing, or to stop wandering around.',
    offline: true,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['off', 'on', 'always'] },
        idle_seconds: { type: 'integer', minimum: 5, maximum: 3600 },
      },
      required: ['mode'],
    },
    async run({ mode, idle_seconds: seconds }) {
      if (!['off', 'on', 'always'].includes(mode)) throw new Error('mode must be off, on or always');
      if (seconds !== undefined && seconds !== null) settings.update({ 'wonder.interval': seconds });
      if (setWonder) setWonder(mode);
      else settings.update({ 'wonder.mode': mode });
      return `Wondering is ${mode}${mode === 'off' ? '' : `, after ${settings.get('wonder.interval')}s idle`}.`;
    },
  });

  add({
    name: 'set_world_instructions',
    description: 'Standing rules for how you behave in this world, e.g. "never go into the basement", "build with '
      + 'cobblestone". Add a rule, or replace them all. These are part of your long-term memory for this world.',
    offline: true,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        mode: { type: 'string', enum: ['add', 'replace'], description: 'Default "add": append a new line.' },
      },
      required: ['text'],
    },
    async run({ text, mode }) {
      const m = memory();
      const clean = String(text || '').trim();
      const next = mode === 'replace' ? clean : [m.data.instructions.trim(), clean].filter(Boolean).join('\n');
      m.setInstructions(next);
      return `Instructions for this world are now:\n${m.data.instructions || '(none)'}`;
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
      if (!allowFlight && /^(agent\s+)?(tp|teleport)\b/i.test(line)) throw new Error(NO_FLIGHT);
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

  // Flying and teleporting only when the person explicitly asked for it (see the pilot); MCP clients
  // are trusted with both. Set per call by call(); read by run_command.
  let allowFlight = true;
  // Who this request is for: the chat sender, or the connected player for WebUI requests. Set per call.
  let requester = null;
  let requesterAsked = false;

  // Descriptions can be edited in the WebUI's Commands tab (see src/commands.js).
  let describe = (t) => t.description;
  function setDescriber(fn) {
    describe = fn;
  }

  /** The tools currently enabled by the settings; without `flight`, no teleporting and no flying. */
  function list({ flight = true } = {}) {
    return tools.filter((t) => (!t.raw || settings.get('tools.allowRaw'))
      && (!t.destructive || settings.get('tools.allowDestructive'))
      && (flight || !t.flight))
      .map((t) => {
        const described = { ...t, description: describe(t) };
        if (flight || !t.parameters.properties || !t.parameters.properties.fly) return described;
        const { fly, ...props } = t.parameters.properties;
        return { ...described, parameters: { ...t.parameters, properties: props } };
      });
  }

  /**
   * Run a tool by name. Never throws: errors come back as { ok: false, text } so the model can
   * read them and try something else.
   */
  async function call(name, args, { signal, origin = 'LLM', flight = true, player = null } = {}) {
    if (!flight && (tools.some((t) => t.name === name && t.flight) || (name === 'go_to' && args && args.fly))) {
      log(`${origin} → ${name} refused: flying/teleporting wasn't asked for`);
      return { ok: false, text: NO_FLIGHT };
    }
    allowFlight = flight;
    requester = player || bridge.player;
    requesterAsked = Boolean(player);
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

  return { list, call, tools, stopRobot, setDescriber };
}

/** A scan, told the way a model can use it. */
function summarizeScan(scan, mode = 'world') {
  const { x: ax, y: ay, z: az } = scan.agent.position;
  const facing = ((Math.round(scan.agent.yRot / 90) % 4) + 4) % 4;
  const frame = new Frame({ x: ax, y: ay, z: az, facing }, mode);
  const at = new Map(scan.cells.map((c) => [`${c.x},${c.y},${c.z}`, c.block]));
  const vertical = (dy) => (dy === 0 ? 'level with you' : `${Math.abs(dy)} ${dy > 0 ? 'up' : 'down'}`);
  const lines = [frame.relative
    ? `Scanned ${scan.cells.length} blocks around you (you are at ${Frame.world(ax, ay, az)}, facing ${compassName(facing)}).`
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
  lines.push(ground ? `Ground below: ${ground.block}, ${frame.relative ? vertical(ground.y - ay) : `at y=${ground.y}`} `
      + `(${ay - ground.y - 1} blocks of air between it and the robot).`
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
      tops.push(`${k} ${d}: ${top === null ? 'no ground' : `top block ${frame.relative ? vertical(top - ay) : `at y=${top}`}`}`);
    }
  }
  lines.push(`Highest solid block of nearby columns: ${tops.join(', ')}.`);
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
