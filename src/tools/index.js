'use strict';

const { FORWARD, turnLeft, turnRight, getAgentPose } = require('../agent/pose');
const { isSolid } = require('../../public/blocks');
const { Frame } = require('../agent/frame');
const players = require('../agent/players');
const { CLEAR } = require('../world/map');
const { checkCells, unknownAround, surveyColumns } = require('../agent/survey');
const { placeholderHelp } = require('../agent/clock');
const entities = require('../agent/entities');
const inv = require('../agent/inventory');

// Tools the LLM (and MCP clients) drive the robot with. Most are shortcuts that bundle several
// game commands and report what actually happened, since the game's own replies say "success"
// even when the agent bumped into a wall. `run_command` is the raw escape hatch.

const DIRECTIONS = ['forward', 'back', 'left', 'right', 'up', 'down'];
const COMPASS = { south: 0, west: 1, north: 2, east: 3 };
const MAX_MOVE = 64;
const MAX_BLOCKS_QUERY = 64;
const MAX_WAIT_S = 60;
const MAX_SCAN_RADIUS = 15;
// survey: gettopsolidblock on every column of a square (one command each: 17x17 = 289 at the default).
const DEFAULT_SURVEY_RADIUS = 8;
const MAX_SURVEY_RADIUS = 24;
// The scan tool looks at everything up to this radius again; further out, only what isn't on the map.
const FRESH_SCAN_RADIUS = 4;
const LIST_ENTITIES = 30;
// After destroy/place, how long to keep checking whether the block changed.
const ACT_POLLS = 6;
const ACT_POLL_MS = 150;
// Blocks that are everywhere: counted in scan summaries, but not listed one by one.
const LIST_LIMIT_PER_TYPE = 5;
const COMMON_THRESHOLD = 20; // at least; a big scan counts as rare anything under 1 in 200 of its blocks
// Scans this big or bigger (radius) get a top-down height grid of the whole area.
const GRID_MIN_RADIUS = 2;
const TRUNK = /\b(Log|Wood|Stem|Hyphae)$/;

// Flying and teleporting are two different things, each allowed only when the request asks for it:
// flying is go_to with fly (the robot moves block by block through the air), teleporting is an
// instant jump (teleport_to_player, agent tp). Permission for one is never permission for the other.
const NO_FLY = 'Not allowed: flying needs the player\'s explicit permission in this request, and they didn\'t ask for it. '
  + 'Walk instead (go_to without fly, or move); if you can\'t get there on foot, say so.';
const NO_TELEPORT = 'Not allowed: teleporting needs the player\'s explicit permission in this request, and they didn\'t ask '
  + 'for it. Being allowed to fly is NOT permission to teleport. Walk (or fly, if that was allowed) and say so if you can\'t '
  + 'get there.';

// Commands that do something to players: move them, hurt or kill them, change their effects, game
// mode, abilities, inventory or experience. Ptolemy drives its robot; it is not a cheat tool, so
// these are refused whoever asks (the model or an MCP client), whatever the settings. Commands run
// as the connected player, so "tp @s" moves that player, not the robot. `agent ...` commands (the
// robot's own, e.g. agent tp) are fine.
const PLAYER_COMMANDS = new Set(['tp', 'teleport', 'spreadplayers', 'ride', 'kill', 'damage', 'effect', 'gamemode',
  'ability', 'clear', 'give', 'replaceitem', 'xp', 'enchant', 'spawnpoint', 'clearspawnpoint', 'camera', 'inputpermission']);
const NO_PLAYER_COMMAND = (cmd) => `Refused: "${cmd}" acts on players, and you may never move, hurt or change a player (their `
  + 'position, health, effects, game mode or inventory), even if asked. Commands run as the player, so @s and @p are the '
  + 'player, never you. To move yourself, use your own tools (move, go_to, or teleport_to_player / "agent tp x y z" when '
  + 'teleporting was asked for).';

/** The first player-affecting command in a command line (including after "run" in an execute chain), or null. */
function playerCommandIn(line) {
  const heads = [line, ...line.split(/\brun\s+/i).slice(1)];
  for (const head of heads) {
    const word = head.trim().replace(/^\/+/, '').split(/\s+/)[0].toLowerCase().replace(/^minecraft:/, '');
    if (PLAYER_COMMANDS.has(word)) return word;
  }
  return null;
}

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

const DIRECTION_HELP = 'Which of the six cells touching the robot, as seen from the robot: forward = the cell in front of it, '
  + 'back = behind it, left / right = beside it, up = the cell right above it, down = the cell right under it. "down" never '
  + 'means "put it down": a block placed in front of the robot is direction forward.';
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
 * @param {import('../world/map').WorldMap} deps.world
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
 * @param {import('../agent/clock').Clock} [deps.clock]   the game's time and weather
 * @param {(text: string) => Promise<string>} [deps.placeholders]   fills in {time_now} and friends
 * @param {import('../agent/inventory').Inventory} [deps.inventory]   held inventory slots
 */
function createToolbox({
  bridge, world, navigator, settings, scan, lookForEntities, log, sight, worlds, notify, activity, setWonder, clock = null,
  placeholders = async (text) => text, inventory = null,
}) {
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



  /**
   * What stands in a cell (players, mobs, another robot): names, from testfor over the cell and the ones
   * below and above it (a player or tall mob standing below reaches up into it, and a position can be
   * read at eye height). Only asked after a placement failed, so a neighbour now and then is fine. The
   * robot itself is left out.
   */
  async function entitiesIn(x, y, z) {
    const res = await bridge.sendCommand(`testfor @e[x=${x},y=${y - 1},z=${z},dx=0,dy=2,dz=0]`, { quiet: true });
    return entities.parseNames(res).map(entities.displayName).filter((n) => !/\bagent\b/i.test(n));
  }

  /**
   * Run `agent <verb> <direction>` and report what changed in that cell. Throws (an error the model
   * sees as a failed call) when nothing changed, saying why: nothing to break, a block that won't break,
   * a cell that isn't empty, someone standing in the way, or (likely) an empty inventory slot.
   */
  async function actOnCell(verb, direction, extra = '') {
    const pose = await getAgentPose(bridge);
    const [dx, dy, dz] = offsetOf(direction, pose.facing);
    const [x, y, z] = [pose.x + dx, pose.y + dy, pose.z + dz];
    const before = await blockAt(x, y, z);
    const res = await bridge.sendCommand(`agent ${verb} ${extra}${direction}`.replace(/\s+/g, ' '));
    // The agent's arm swing takes a moment: the block often still reads as before right after the reply.
    let after = await blockAt(x, y, z);
    for (let i = 0; res.ok && after === before && i < ACT_POLLS; i++) {
      await sleep(ACT_POLL_MS);
      after = await blockAt(x, y, z);
    }
    world.setBlock(x, y, z, after);
    const where = `${direction} of the robot (${Frame.world(x, y, z)})`;
    const game = `The game said: "${res.statusMessage}".`;
    if (before !== after) return `The block ${where} went from ${before} to ${after}. ${game}`;
    if (verb === 'destroy') {
      if (!isSolid(after)) throw new Error(`nothing to break ${where}: it is ${after}. ${game}`);
      throw new Error(`couldn't break the ${after} ${where}: it is still there (some blocks, like bedrock, can't be broken). ${game}`);
    }
    if (verb === 'place' && isSolid(after)) {
      throw new Error(`couldn't place ${where}: that cell isn't empty, it is ${after}. Use replace to break it and place in one `
        + `go, or pick another cell. ${game}`);
    }
    if (verb === 'place') {
      const inTheWay = await entitiesIn(x, y, z).catch(() => []);
      if (inTheWay.length) {
        throw new Error(`couldn't place ${where}: ${inTheWay.join(', ')} ${inTheWay.length > 1 ? 'are' : 'is'} in the way (a block `
          + `can't go where a player, a mob or a robot stands). Wait for them to move, or pick another cell. ${game}`);
      }
      throw new Error(`nothing was placed ${where}: it is still ${after}, and nothing seems to stand there, so the inventory slot `
        + `is probably empty (hold keeps a slot stocked). ${game}`);
    }
    throw new Error(`nothing changed ${where}: it is still ${after}. ${game}`);
  }

  /** Run fn; if it fails, say what already happened before it (e.g. walking to the block). */
  async function withNote(note, fn) {
    try {
      return note + await fn();
    } catch (err) {
      throw note ? new Error(`${note}Then: ${err.message}`) : err;
    }
  }

  /** The cell beside the robot in a direction: [x, y, z]. */
  async function cellToward(direction) {
    const pose = await getAgentPose(bridge);
    const [dx, dy, dz] = offsetOf(direction, pose.facing);
    return [pose.x + dx, pose.y + dy, pose.z + dz];
  }

  /**
   * Is the block at this cell the block asked for? The name the game gave ("Oak Log") is compared with
   * the id asked for ("oak_log", "minecraft:oak_log"), and if they differ the game is asked with
   * testforblock (which knows old names like "log" and "wood" too). Resolves to { ok, current }.
   */
  async function blockMatches(cell, wanted) {
    const norm = (b) => String(b).trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
    const current = await blockAt(...cell);
    const want = norm(wanted);
    if (!/^[a-z0-9_:]+$/.test(want)) throw new Error(`"${wanted}" isn't a block id (e.g. oak_log, stone)`);
    if (norm(current) === want) return { ok: true, current };
    const res = await bridge.sendCommand(`testforblock ${cell.join(' ')} ${want}`, { quiet: true });
    if (res.body && res.body.matches === true) return { ok: true, current };
    if (!res.ok && !/\bis .+\(expected/i.test(res.statusMessage || '')) {
      throw new Error(`the game doesn't know the block "${wanted}" (${res.statusMessage})`);
    }
    return { ok: false, current };
  }

  /**
   * Break what's in a cell beside the robot (if it's solid: air, water and plants are placed into
   * directly), then place from a slot there. Throws if either step fails, saying what was done.
   */
  async function replaceCell(direction, slot) {
    const cell = await cellToward(direction);
    const before = await blockAt(...cell);
    const broke = isSolid(before) ? `${await actOnCell('destroy', direction)} ` : '';
    return withNote(broke, () => actOnCell('place', direction, `${slot} `));
  }

  /** The horizontal direction (forward, back, left, right) that points most towards a spot. */
  function directionToward(pose, p) {
    const dx = p.x - pose.x;
    const dz = p.z - pose.z;
    return ['forward', 'back', 'left', 'right'].map((d) => {
      const [ox, , oz] = offsetOf(d, pose.facing);
      return { d, score: ox * dx + oz * dz };
    }).sort((a, b) => b.score - a.score)[0].d;
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
   * right direction. With `stepAside` (place, replace), a target that is the robot's own cell is
   * handled by stepping out of it first: up if that's free (then placing down), else to a free side.
   * Returns { direction, note } or { error }.
   */
  async function reach(args, { stepAside = false } = {}) {
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
      if (stepAside) return stepOutOf(pose, target);
      return { error: 'That is the cell the robot is in. The robot can\'t act on its own cell, and it can\'t move into a block: '
        + 'it works on a cell NEXT to it. Give a direction (forward, back, left, right, up, down) or a position touching the robot.' };
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

  /**
   * The robot is standing in the cell it should place into: move one block out of it (up first, then
   * the sides) and target the cell it left. Returns { direction, note } or { error }.
   */
  async function stepOutOf(pose, target) {
    for (const d of ['up', 'left', 'right', 'back', 'forward']) {
      const [dx, dy, dz] = offsetOf(d, pose.facing);
      const cell = [pose.x + dx, pose.y + dy, pose.z + dz];
      if (isSolid(await blockAt(...cell))) continue;
      const expect = { x: cell[0], y: cell[1], z: cell[2], facing: pose.facing };
      const result = await navigator.runSteps([{ action: d, command: `agent move ${d}`, expect, enters: cell }]);
      if (!result.ok) continue;
      const now = await getAgentPose(bridge);
      const dir = directionTo(now, ...target);
      if (dir) {
        return { direction: dir, note: `The robot was standing in that cell, so it moved 1 ${d} first and works on it from there `
          + `(direction ${dir}). ` };
      }
    }
    return { error: 'The robot is standing in that cell and can\'t step out of it (up and every side are blocked), so nothing '
      + 'can be placed there.' };
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

  /**
   * Blocks around the robot, summarized. Up to FRESH_SCAN_RADIUS everything is scanned again (it may
   * have changed); beyond it, only what the map doesn't know yet, and the rest comes from the map.
   */
  async function lookAround(r) {
    const mode = settings.get('llm.coordinates');
    const fresh = await scan(Math.min(r, FRESH_SCAN_RADIUS), { quiet: true });
    if (!fresh) throw new Error('the scan failed (see the console)');
    if (r <= FRESH_SCAN_RADIUS) return summarizeScan(fresh, mode, { grid: true });
    const { x, y, z } = fresh.agent.position;
    const pose = { x, y, z, yRot: fresh.agent.yRot };
    const unseen = unknownAround(world, pose, r);
    if (unseen.length) await checkCells(bridge, world, unseen);
    const size = (2 * r + 1) ** 3;
    return mapSummary(world, pose, r, mode, `Looked at ${fresh.cells.length + unseen.length} of the ${size} blocks around you `
      + `(the nearest ${fresh.cells.length} again, plus everything not on your map yet); the rest is from your map. `
      + `You are at ${Frame.world(x, y, z)}, facing ${compassName(((Math.round(pose.yRot / 90) % 4) + 4) % 4)}. `
      + `Everything below covers the whole scan, ${r} blocks out in every direction.`, { grid: true });
  }

  add({
    name: 'get_status',
    description: 'Where the robot and every player online are, which way the robot faces, and what is directly around the robot. Cheap: call it whenever you are unsure.',
    parameters: { type: 'object', properties: {} },
    async run() {
      const lines = [];
      lines.push(`Minecraft: connected as ${bridge.player || 'unknown player'}`
        + `${worlds.current ? `, in the world "${worlds.current.name}"` : ''}.`);
      if (clock) {
        await clock.refresh().catch(() => null);
        const time = clock.describe();
        if (time) lines.push(`Game time: ${time}.`);
      }
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
    description: 'Look around the robot. The [Now] block already says what your map knows right around you; scan to see '
      + 'further or to be sure. what "blocks": every block in a cube around it (a bigger radius means a longer result, so '
      + 'start small): what is next to the robot, the ground below it, counts of each block type, and the coordinates of the '
      + `rarer blocks. Up to radius ${FRESH_SCAN_RADIUS} everything is looked at again; further out, only what your map `
      + 'doesn\'t know yet (the rest comes from the map), so a big scan of a known place is quick. '
      + 'what "entities": mobs, animals, players and dropped items (fast, up to '
      + `${entities.MAX_RADIUS} blocks away): what each one is, where, how far, and which are hostile. They move, so call it `
      + 'again before acting on one; to attack one, pass its position to attack. what "both" (the default): the two at once. '
      + 'The result covers the whole radius you asked for, including a top-down grid of how high the ground is. To see '
      + 'far down a cliff or up a wall or tree, use survey instead.',
    longResult: true,
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
        mode !== 'entities' && lookAround(r),
        mode !== 'blocks' && entitiesText(entities.entityRadius(mode === 'entities' ? radius : radius ?? r, mode)),
      ]);
      return [blocks, seen].filter(Boolean).join('\n');
    },
  });

  add({
    name: 'survey',
    description: 'A view of the land around the robot from above: the height of the highest solid block of every column '
      + `in a square (up to ${MAX_SURVEY_RADIUS} blocks out, default ${DEFAULT_SURVEY_RADIUS}), however far up or down it is. `
      + 'Use it where a scan\'s cube doesn\'t reach: at the edge of a cliff (how far down it goes), in front of a wall, '
      + 'hill or tall tree (how high it goes), or to see the lay of the land before a trip. One quick command per '
      + 'column (gettopsolidblock): it sees through air, leaves and water, and doesn\'t see caves under the surface.',
    longResult: true,
    parameters: {
      type: 'object',
      properties: {
        radius: { type: 'integer', minimum: 1, maximum: MAX_SURVEY_RADIUS, description: `Columns in each direction (default ${DEFAULT_SURVEY_RADIUS}).` },
      },
    },
    async run({ radius }) {
      const r = clampInt(radius ?? DEFAULT_SURVEY_RADIUS, 1, MAX_SURVEY_RADIUS);
      const pose = await getAgentPose(bridge);
      const columns = [];
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) columns.push([pose.x + dx, pose.z + dz]);
      const found = await surveyColumns(bridge, world, columns, pose.y, { headroom: 24 });
      return summarizeSurvey(found, await frameNow(pose), r);
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
      return `Moved ${moved} of ${n} blocks ${direction}, then was blocked by ${blocker} (the block at ${frame.fmt(...result.step.enters)}, `
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
        fly: { type: 'boolean', description: 'ONLY if the player explicitly asked you to fly in this request: take the '
          + 'straightest route through the air, still moving block by block (this is flying, NOT teleporting). Otherwise leave it out.' },
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
      // One line per rescan or path check on the way is noise for the model: count them instead.
      const noise = (l) => l.startsWith('Entering unknown territory') || l.startsWith('Checking the path')
        || l.startsWith('Re-planning') || l.startsWith('Looking ahead') || l.startsWith('Measuring the ground');
      const rescans = lines.filter((l) => l.startsWith('Entering unknown territory')).length;
      const checks = lines.filter((l) => l.startsWith('Checking the path')).length;
      const aheads = lines.filter((l) => l.startsWith('Looking ahead') && !l.includes('measured the ground')).length;
      const measured = lines.filter((l) => l.startsWith('Measuring the ground') || l.includes('measured the ground')).length;
      const told = lines.filter((l) => !noise(l));
      const looked = [aheads && `looked ahead ${aheads} time(s) where the plan met the unknown`,
        measured && `measured the ground ${measured} more time(s) along a detour or around something in the way`,
        checks && `checked the path ${checks} time(s) before walking it`, rescans && `rescanned ${rescans} time(s) on the way`]
        .filter(Boolean);
      if (looked.length) told.splice(1, 0, `Looked ahead: ${looked.join(', ')}.`);
      let text = `${told.map((l) => frame.convertText(l)).join('\n')}\n${afterMove(frame)}${await playerLine(frame)}`;
      if (lines.some((l) => l.includes('boxed in'))) {
        const around = await Promise.all(DIRECTIONS.map(async (d) => {
          const [dx, dy, dz] = offsetOf(d, frame.pose.facing);
          return `${d}: ${await blockAt(frame.pose.x + dx, frame.pose.y + dy, frame.pose.z + dz)}`;
        }));
        text += `\nTouching the robot: ${around.join(', ')}. Breaking one of these (destroy with that direction) is the only way `
          + 'out on foot; ask first unless the request allows breaking blocks.';
      }
      return text;
    },
  });

  add({
    name: 'teleport_to_player',
    description: 'Instantly teleport the robot to a player (agent tp). ONLY when the player explicitly asked you to teleport in '
      + 'this request: permission to fly is not permission to teleport. Otherwise walk (or fly with go_to if that was '
      + 'allowed), and say so if you can\'t get there. It only ever moves the robot, never a player.',
    teleport: true,
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

  const WHERE = 'The robot always works on a cell NEXT to it, never on the cell it is in, and it can\'t move into a solid '
    + 'block. Give EITHER direction (for a cell touching the robot) OR the cell\'s position, relative (e.g. {forward: 2, '
    + 'left: 1}) or world ({x, y, z}), at any distance: the robot first walks to a free spot beside it, then acts on it.';
  const SLOT = { type: 'integer', minimum: 1, maximum: 27, description: 'Inventory slot (1-27). Your memory says which slots are '
    + 'kept stocked with what; the others are unknown.' };
  const BLOCK = { type: 'string', description: 'The block id it must be, e.g. "oak_log", "stone", "dirt".' };

  add({
    name: 'destroy',
    description: 'Break the one block in a cell touching the robot. The robot stays where it is. '
      + `${WHERE} Examples: the block in front: {direction: "forward"}; the block the robot stands on: {direction: "down"}; `
      + 'a block ahead and to the left: {forward: 1, left: 1}. The drop may go into the robot\'s inventory or onto the ground. '
      + 'Prefer safe_destroy whenever you know what the block is (you usually do): it won\'t break the wrong one. Use destroy '
      + 'only when you can\'t know, or any block will do.',
    destructive: true,
    parameters: { type: 'object', properties: { direction: dirParam('Which cell\'s block to break.'), ...POSITION_PROPS } },
    async run(args) {
      const r = await reach(args);
      if (r.error) throw new Error(r.error);
      return withNote(r.note, () => actOnCell('destroy', r.direction));
    },
  });

  add({
    name: 'safe_destroy',
    description: 'Break a block, but only if it is the one named (e.g. "oak_log"): the preferred way to break blocks. A wrong '
      + 'direction or an out-of-date position then does nothing instead of breaking a wall or a player\'s build. The [Now] '
      + `block says what touches you; scan and get_blocks tell the rest. ${WHERE}`,
    destructive: true,
    parameters: {
      type: 'object',
      properties: { block: BLOCK, direction: dirParam('Which cell\'s block to break.'), ...POSITION_PROPS },
      required: ['block'],
    },
    async run(args) {
      const r = await reach(args);
      if (r.error) throw new Error(r.error);
      const check = await blockMatches(await cellToward(r.direction), args.block);
      if (!check.ok) return `${r.note}Not destroyed: the block ${r.direction} of the robot is ${check.current}, not ${args.block}.`;
      return withNote(r.note, () => actOnCell('destroy', r.direction));
    },
  });

  add({
    name: 'place',
    description: 'Put a block from an inventory slot into an EMPTY cell touching the robot (air, water, grass...). The robot '
      + `stays where it is. ${WHERE} Examples: a block in front of the robot: {slot: 1, direction: "forward"}; a block under `
      + 'the robot (a floor or a bridge under itself): {slot: 1, direction: "down"}; on top of it: "up". '
      + 'To put a block where the robot is right now, it has to get out of the way first: move up 1, then place down (if up '
      + 'is blocked, move to a free side and place back towards that cell). Given the robot\'s own cell as the position, '
      + 'place does that by itself. If the cell holds a block, use replace instead.',
    parameters: {
      type: 'object',
      properties: { slot: SLOT, direction: dirParam('Which cell to fill.'), ...POSITION_PROPS },
      required: ['slot'],
    },
    async run(args) {
      const r = await reach(args, { stepAside: true });
      if (r.error) throw new Error(r.error);
      return withNote(r.note, () => actOnCell('place', r.direction, `${clampInt(args.slot, 1, 27)} `));
    },
  });

  add({
    name: 'replace',
    description: 'Put a block from an inventory slot into a cell touching the robot, whatever is there now: it breaks the '
      + 'block first (if any), then places. It always ends with the new block there, unless the slot is empty (then it only '
      + `breaks) or the old block can't be broken. ${WHERE} Prefer safe_replace whenever you know what's there now; use replace `
      + 'only when you can\'t know, or any block will do.',
    destructive: true,
    parameters: {
      type: 'object',
      properties: { slot: SLOT, direction: dirParam('Which cell.'), ...POSITION_PROPS },
      required: ['slot'],
    },
    async run(args) {
      const r = await reach(args, { stepAside: true });
      if (r.error) throw new Error(r.error);
      return withNote(r.note, () => replaceCell(r.direction, clampInt(args.slot, 1, 27)));
    },
  });

  add({
    name: 'safe_replace',
    description: 'Replace a block, but only if the block there now is the one named (e.g. replace "dirt" with planks from a '
      + `slot); otherwise it does nothing. The preferred way to replace blocks: nothing else gets broken by mistake. ${WHERE}`,
    destructive: true,
    parameters: {
      type: 'object',
      properties: { block: BLOCK, slot: SLOT, direction: dirParam('Which cell.'), ...POSITION_PROPS },
      required: ['block', 'slot'],
    },
    async run(args) {
      const r = await reach(args);
      if (r.error) throw new Error(r.error);
      const check = await blockMatches(await cellToward(r.direction), args.block);
      if (!check.ok) return `${r.note}Not replaced: the block ${r.direction} of the robot is ${check.current}, not ${args.block}.`;
      return withNote(r.note, () => replaceCell(r.direction, clampInt(args.slot, 1, 27)));
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
    description: 'Drop items from one of the robot\'s inventory slots (1-27) onto the ground beside it, e.g. to hand a player '
      + 'something from a held slot. To give an item that isn\'t in a held slot, use give_item.',
    parameters: {
      type: 'object',
      properties: {
        slot: SLOT,
        quantity: { type: 'integer', minimum: 1, maximum: 64, description: 'How many (default 1).' },
        direction: dirParam('Which way to drop (default forward).'),
      },
      required: ['slot'],
    },
    async run({ slot, quantity, direction = 'forward' }) {
      checkDirection(direction);
      const n = clampInt(quantity ?? 1, 1, 64);
      const res = await bridge.sendCommand(`agent drop ${clampInt(slot, 1, 27)} ${n} ${direction}`);
      if (!res.ok) throw new Error(`couldn't drop from slot ${clampInt(slot, 1, 27)} (it may be empty): ${res.statusMessage}`);
      return `Dropped ${n} from slot ${clampInt(slot, 1, 27)} ${direction}. The game said: "${res.statusMessage}".`;
    },
  });

  add({
    name: 'give_item',
    description: 'Give items: they are made in the robot\'s scratch slot (27) and dropped beside it, towards the player who asked '
      + 'if they are within a few blocks (otherwise forward). Go near the player first (go_to target "player"). Any item id '
      + 'works, e.g. "oak_planks", "torch", "bread"; variant picks a variant for old ids (e.g. "wood" with variant 1 = spruce).',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Item id, e.g. "oak_planks".' },
        amount: { type: 'integer', minimum: 1, maximum: 64, description: 'How many (default 1).' },
        variant: { type: 'integer', minimum: 0, description: 'Variant (data value), default 0.' },
        direction: dirParam('Which way to drop them (default: towards the player who asked, if near; else forward).'),
      },
      required: ['item'],
    },
    async run({ item, amount, variant, direction }) {
      const id = inv.itemId(item);
      const n = clampInt(amount ?? 1, 1, 64);
      const data = inv.variantNumber(variant ?? 0);
      let dir = direction;
      if (dir) checkDirection(dir);
      else {
        const pose = await getAgentPose(bridge);
        const p = await players.playerPosition(bridge, requester);
        dir = p && Math.hypot(p.x - pose.x, p.z - pose.z) <= 6 ? directionToward(pose, p) : 'forward';
      }
      const set = await bridge.sendCommand(`agent setitem ${inv.SCRATCH_SLOT} ${id} ${n} ${data}`);
      if (!set.ok) throw new Error(`the game refused the item "${id}": ${set.statusMessage}`);
      const res = await bridge.sendCommand(`agent drop ${inv.SCRATCH_SLOT} ${n} ${dir}`);
      if (!res.ok) throw new Error(`made the ${id} but couldn't drop it: ${res.statusMessage}`);
      return `Dropped ${n} ${id}${data ? ` (variant ${data})` : ''} ${dir} of the robot. The game said: "${res.statusMessage}".`;
    },
  });

  add({
    name: 'hold',
    description: 'Keep one of your inventory slots (1-26) stocked with an item for good: it is refilled every second, so it never '
      + 'runs out, and your memory lists it. Use it before building with place / replace, e.g. hold {slot: 1, item: '
      + '"oak_planks"}. Slot 27 is scratch space and can\'t be held.',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'integer', minimum: 1, maximum: inv.HOLD_SLOTS },
        item: { type: 'string', description: 'Item id, e.g. "oak_planks", "cobblestone", "glass".' },
        variant: { type: 'integer', minimum: 0, description: 'Variant (data value) for old ids, default 0.' },
      },
      required: ['slot', 'item'],
    },
    async run({ slot, item, variant }) {
      if (!inventory) throw new Error('holding items isn\'t available here');
      const h = await inventory.hold(slot, item, variant ?? 0);
      return `Slot ${h.slot} now holds ${h.item}${h.data ? ` (variant ${h.data})` : ''} and is kept stocked.`;
    },
  });

  add({
    name: 'release',
    description: 'Stop keeping a slot (1-26) stocked. The slot can\'t be emptied, so afterwards what\'s in it is simply unknown.',
    offline: true,
    parameters: { type: 'object', properties: { slot: { type: 'integer', minimum: 1, maximum: inv.HOLD_SLOTS } }, required: ['slot'] },
    async run({ slot }) {
      if (!inventory) throw new Error('holding items isn\'t available here');
      const old = inventory.release(slot);
      return old ? `Slot ${old.slot} is no longer kept stocked with ${old.item}; what's in it is unknown now.`
        : `Slot ${slot} wasn't held.`;
    },
  });

  // --- Talking, waiting, raw --------------------------------------------------

  add({
    name: 'send_chat',
    description: 'Send a message to the Minecraft chat, seen by every player (keep it short, no markdown). '
      + 'Use it to tell players something even when the request came from the WebUI, or to talk to another robot (it only '
      + `hears messages containing its name). Placeholders are filled in as it is sent: ${placeholderHelp()}.`,
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    async run({ message }) {
      const text = await placeholders(String(message || ''));
      const res = await sayInChat(bridge, settings, text);
      return res.ok ? `Sent to the game chat: "${text}"` : `Couldn't send it: ${res.statusMessage}`;
    },
  });

  add({
    name: 'send_webui',
    description: 'Show a message to the person at the Ptolemy WebUI (highlighted in the Automatic tab), '
      + `even when the request came from the game chat. Placeholders are filled in as it is sent: ${placeholderHelp()}.`,
    offline: true,
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    async run({ message }) {
      const text = (await placeholders(String(message || ''))).trim();
      if (!text) throw new Error('empty message');
      notify(text.slice(0, 2000));
      return `Shown in the WebUI: "${text.slice(0, 2000)}"`;
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
      + 'You may act on it later, e.g. while wondering. Thoughts fade with time, and only the last few are kept.',
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
      const started = Date.now();
      await sleep(s * 1000, signal);
      const waited = Math.round((Date.now() - started) / 100) / 10;
      return waited < s - 0.5 ? `Waited ${waited}s of ${s}s: interrupted.` : `Waited ${s}s.`;
    },
  });

  add({
    name: 'run_command',
    description: 'Run a Minecraft Bedrock command (without the slash) and get the game\'s raw reply, e.g. "agent till forward", '
      + '"time set day". It runs AS THE PLAYER: @s and @p mean the player, never you (the robot\'s own commands start with '
      + '"agent"). Commands that act on players (tp, teleport, kill, effect, gamemode, give, clear...) are always refused. '
      + 'Use the other tools when they fit.',
    raw: true,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async run({ command }) {
      const line = String(command || '').trim().replace(/^\/+/, '');
      if (!line) throw new Error('empty command');
      if (line.startsWith('#')) throw new Error('#console commands are for people; use the tools instead');
      const forbidden = playerCommandIn(line);
      if (forbidden) {
        log(`Refused a command that acts on players: ${line}`);
        throw new Error(NO_PLAYER_COMMAND(forbidden));
      }
      if (!allowed.teleport && /^agent\s+(tp|teleport)\b/i.test(line)) throw new Error(NO_TELEPORT);
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

  // Flying and teleporting, each only when the person explicitly asked for it (see the pilot); MCP
  // clients are trusted with both. Set per call by call(); read by run_command.
  let allowed = { fly: true, teleport: true };
  // Who this request is for: the chat sender, or the connected player for WebUI requests. Set per call.
  let requester = null;
  let requesterAsked = false;

  // Descriptions can be edited in the WebUI's Commands tab (see src/commands.js).
  let describe = (t) => t.description;
  function setDescriber(fn) {
    describe = fn;
  }

  /** The tools currently enabled by the settings; without `teleport` no teleport tool, without `fly` no fly option. */
  function list({ fly = true, teleport = true } = {}) {
    return tools.filter((t) => (!t.raw || settings.get('tools.allowRaw'))
      && (!t.destructive || settings.get('tools.allowDestructive'))
      && (teleport || !t.teleport))
      .map((t) => {
        const described = { ...t, description: describe(t) };
        if (fly || !t.parameters.properties || !t.parameters.properties.fly) return described;
        const { fly: _, ...props } = t.parameters.properties;
        return { ...described, parameters: { ...t.parameters, properties: props } };
      });
  }

  /**
   * Run a tool by name. Never throws: errors come back as { ok: false, text } so the model can
   * read them and try something else.
   */
  async function call(name, args, { signal, origin = 'LLM', fly = true, teleport = true, player = null } = {}) {
    if (!teleport && tools.some((t) => t.name === name && t.teleport)) {
      log(`${origin} → ${name} refused: teleporting wasn't asked for`);
      return { ok: false, text: NO_TELEPORT };
    }
    if (!fly && name === 'go_to' && args && args.fly) {
      log(`${origin} → go_to refused: flying wasn't asked for`);
      return { ok: false, text: NO_FLY };
    }
    allowed = { fly, teleport };
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

/**
 * A scan, told the way a model can use it. Cells whose block is '?' are unknown (not identified,
 * or not on the map yet). `intro` replaces the first line, `unknownText(n)` the line counting them.
 */
function summarizeScan(scan, mode = 'world', { intro = null, unknownText = (n) => `${n} blocks couldn't be identified.`, grid = false } = {}) {
  const { x: ax, y: ay, z: az } = scan.agent.position;
  const facing = ((Math.round(scan.agent.yRot / 90) % 4) + 4) % 4;
  const frame = new Frame({ x: ax, y: ay, z: az, facing }, mode);
  const at = new Map(scan.cells.map((c) => [`${c.x},${c.y},${c.z}`, c.block]));
  const vertical = (dy) => (dy === 0 ? 'level with you' : `${Math.abs(dy)} ${dy > 0 ? 'up' : 'down'}`);
  const solidAt = (block) => block && block !== '?' && isSolid(block);
  const lines = [intro || (frame.relative
    ? `Scanned ${scan.cells.length} blocks around you (you are at ${Frame.world(ax, ay, az)}, facing ${compassName(facing)}).`
    : `Scanned ${scan.cells.length} blocks around the robot at ${ax} ${ay} ${az}, facing ${compassName(facing)} `
      + `(${orientationText(facing)}).`)];

  lines.push(`Next to the robot: ${DIRECTIONS.map((d) => {
    const [dx, dy, dz] = offsetOf(d, facing);
    return `${d}: ${at.get(`${ax + dx},${ay + dy},${az + dz}`) || '?'}`;
  }).join(', ')}.`);

  let ground = null;
  for (let y = ay - 1; at.has(`${ax},${y},${az}`); y--) {
    if (solidAt(at.get(`${ax},${y},${az}`))) {
      ground = { y, block: at.get(`${ax},${y},${az}`) };
      break;
    }
  }
  lines.push(ground ? `Ground below: ${ground.block}, ${frame.relative ? vertical(ground.y - ay) : `at y=${ground.y}`} `
      + `(${ay - ground.y - 1} blocks of air between it and the robot).`
    : 'No ground found below the robot within the scan.');

  const byType = new Map();
  for (const c of scan.cells) {
    if (c.block === 'Air' || c.block === '?') continue;
    if (!byType.has(c.block)) byType.set(c.block, []);
    byType.get(c.block).push(c);
  }
  const dist = (c) => Math.abs(c.x - ax) + Math.abs(c.y - ay) + Math.abs(c.z - az);
  const types = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
  const unknown = scan.cells.filter((c) => c.block === '?').length;
  const air = scan.cells.length - unknown - types.reduce((n, [, cells]) => n + cells.length, 0);
  lines.push(`Counts: Air ${air}, ${types.map(([name, cells]) => `${name} ${cells.length}`).join(', ') || 'nothing else'}.`);

  // What counts as common grows with the scan, so a big scan still says where the trees and ores are.
  const threshold = Math.max(COMMON_THRESHOLD, Math.round(scan.cells.length / 200));
  const rare = types.filter(([, cells]) => cells.length <= threshold);
  if (rare.length) {
    lines.push('Where the less common blocks are (nearest first):');
    for (const [name, cells] of [...rare].reverse()) {
      const nearest = [...cells].sort((a, b) => dist(a) - dist(b)).slice(0, LIST_LIMIT_PER_TYPE);
      lines.push(`  ${name}: ${nearest.map((c) => frame.fmt(c.x, c.y, c.z)).join('; ')}${cells.length > nearest.length ? ` (+${cells.length - nearest.length} more)` : ''}`);
    }
  }
  const common = types.filter(([, cells]) => cells.length > threshold);
  if (grid && common.length) {
    lines.push('The common blocks (the nearest one, and the heights they fill):');
    for (const [name, cells] of common) {
      const nearest = cells.reduce((a, c) => (dist(c) < dist(a) ? c : a));
      const lo = Math.min(...cells.map((c) => c.y));
      const hi = Math.max(...cells.map((c) => c.y));
      const span = frame.relative
        ? (lo === hi ? vertical(lo - ay) : `from ${vertical(lo - ay)} to ${vertical(hi - ay)}`)
        : (lo === hi ? `y=${lo}` : `y=${lo}..${hi}`);
      lines.push(`  ${name}: nearest ${frame.fmt(nearest.x, nearest.y, nearest.z)}; ${span}`);
    }
  }

  // Terrain height: the top solid block of a few columns, so the model can tell hills from flat ground.
  const b = scan.cells.reduce((acc, c) => ({
    minY: Math.min(acc.minY, c.y), maxY: Math.max(acc.maxY, c.y), minX: Math.min(acc.minX, c.x), maxX: Math.max(acc.maxX, c.x),
  }), { minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity });
  const tops = [];
  for (const d of ['forward', 'back', 'left', 'right']) {
    const [dx, , dz] = offsetOf(d, facing);
    const r = Math.round((b.maxY - b.minY) / 2);
    for (const k of [Math.ceil(r / 2), r]) {
      const cx = ax + dx * k;
      const cz = az + dz * k;
      let top = null;
      let unseen = false;
      for (let y = b.maxY; y >= b.minY; y--) {
        const block = at.get(`${cx},${y},${cz}`);
        if (block === '?') unseen = true;
        if (solidAt(block)) { top = y; break; }
      }
      const none = unseen ? 'not seen' : 'no ground';
      tops.push(`${k} ${d}: ${top === null ? none : `top block ${frame.relative ? vertical(top - ay) : `at y=${top}`}`}`);
    }
  }
  lines.push(`Highest solid block of nearby columns: ${tops.join(', ')}.`);
  const r = Math.round((b.maxX - b.minX) / 2);
  if (grid && r >= GRID_MIN_RADIUS) {
    // The top solid block of every column of the scan (within the scan's own height).
    const topAt = (x, z) => {
      for (let y = b.maxY; y >= b.minY; y--) {
        const block = at.get(`${x},${y},${z}`);
        if (block === undefined || block === '?') return undefined;
        if (solidAt(block)) return y;
      }
      return null;
    };
    lines.push(`Top-down view of the whole scan: ${heightGrid(frame, r, topAt, {
      what: 'the highest solid block of that column within the scan', none: 'nothing solid in the scan',
    })}`);
  }
  if (unknown) lines.push(unknownText(unknown));
  return lines.join('\n');
}

/**
 * A top-down grid of column heights around the robot, `radius` columns out: in the relative frame
 * forward is up and each number is blocks above (+) or below (-) the robot; in world coordinates
 * north is up and each number is the world y. `topAt(x, z)` gives the y, null (nothing) or undefined (unseen).
 */
function heightGrid(frame, radius, topAt, { what, none }) {
  const { pose } = frame;
  const rows = [];
  let head;
  if (frame.relative) {
    const [fx, , fz] = offsetOf('forward', pose.facing);
    const [rx, , rz] = offsetOf('right', pose.facing);
    head = `rows go from ${radius} forward (top) to ${radius} back (bottom), columns from ${radius} left to ${radius} right. `
      + `Each number is ${what}, in blocks above (+) or below (-) you; @ is you, ? not seen, . ${none}.`;
    for (let f = radius; f >= -radius; f--) {
      const row = [];
      for (let r = -radius; r <= radius; r++) {
        const y = f || r ? topAt(pose.x + fx * f + rx * r, pose.z + fz * f + rz * r) : '@';
        row.push(y === '@' ? '@' : y === undefined ? '?' : y === null ? '.' : signed(y - pose.y));
      }
      rows.push(row.map((v) => v.padStart(4)).join(''));
    }
  } else {
    head = `rows go from z=${pose.z - radius} (north, top) to z=${pose.z + radius} (south), columns from x=${pose.x - radius} `
      + `(west) to x=${pose.x + radius} (east). Each number is the world y of ${what}; @ is the robot (at y=${pose.y}), `
      + `? not seen, . ${none}.`;
    for (let z = pose.z - radius; z <= pose.z + radius; z++) {
      const row = [];
      for (let x = pose.x - radius; x <= pose.x + radius; x++) {
        const y = x === pose.x && z === pose.z ? '@' : topAt(x, z);
        row.push(y === '@' ? '@' : y === undefined ? '?' : y === null ? '.' : String(y));
      }
      rows.push(row.map((v) => v.padStart(4)).join(''));
    }
  }
  return `${head}\n${rows.join('\n')}`;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * What the survey tool found: gettopsolidblock on every column of a square around the robot
 * ({ tops, ground, unloaded, commands } from surveyColumns), told the way a model can use it.
 */
function summarizeSurvey(found, frame, radius) {
  const { pose } = frame;
  const key = (x, z) => `${x},${z}`;
  const topAt = (x, z) => {
    const t = found.tops.get(key(x, z));
    return t ? t.y : undefined;
  };
  const vertical = (dy) => (dy === 0 ? 'level with you' : `${Math.abs(dy)} ${dy > 0 ? 'up' : 'down'}`);
  const height = (y) => (frame.relative ? vertical(y - pose.y) : `y=${y}`);
  const size = 2 * radius + 1;
  const lines = [`Surveyed the surface around you with gettopsolidblock: ${size}x${size} columns, ${found.commands} commands`
    + `${found.unloaded ? ` (${found.unloaded} in chunks that aren't loaded: ?)` : ''}. It sees through air, leaves and water, `
    + 'not into caves. You are at ' + `${Frame.world(pose.x, pose.y, pose.z)}, facing ${compassName(pose.facing)}.`];
  lines.push(`Top-down view: ${heightGrid(frame, radius, topAt, { what: 'the highest solid block of that column', none: 'nothing' })}`);

  const own = found.tops.get(key(pose.x, pose.z));
  if (own && own.y > pose.y) {
    lines.push(`Above you: ${own.name}, ${height(own.y)}. You are under a roof, an overhang or underground, so the heights `
      + 'around you may be the top of what is above you, not the floor you are on.');
  } else if (own) {
    const g = found.ground.get(key(pose.x, pose.z));
    lines.push(`Ground under you: ${own.name}, ${height(own.y)} (${pose.y - (g ?? own.y) - 1} blocks of air between it and you).`);
  }

  // Straight lines out from the robot: how the land rises and falls, and where it does so suddenly.
  const steps = [];
  for (const d of ['forward', 'back', 'left', 'right']) {
    const [dx, , dz] = offsetOf(d, pose.facing);
    const heights = [];
    let prev = found.ground.get(key(pose.x, pose.z)) ?? topAt(pose.x, pose.z);
    for (let k = 1; k <= radius; k++) {
      const x = pose.x + dx * k;
      const z = pose.z + dz * k;
      const y = topAt(x, z);
      heights.push(y === undefined ? '?' : frame.relative ? signed(y - pose.y) : String(y));
      // Tree trunks stick up out of the ground: they're listed as trees, not as cliffs.
      const trunk = y !== undefined && TRUNK.test(found.tops.get(key(x, z)).name);
      if (!trunk && y !== undefined && prev !== undefined && prev !== null && Math.abs(y - prev) >= 3) {
        steps.push(`${d}, ${k} out: ${y > prev ? `rises ${y - prev} blocks (a wall or a cliff face)` : `drops ${prev - y} blocks (a cliff edge or a pit)`}, `
          + `${found.tops.get(key(x, z)).name} ${frame.relative ? height(y) : `at ${frame.fmt(x, y, z)}`}`);
      }
      if (y !== undefined && !trunk) prev = y;
    }
    lines.push(`  ${d}: ${heights.join(' ')}`);
  }
  lines.splice(lines.length - 4, 0, `Straight out from you, column by column (${frame.relative ? 'blocks above or below you' : 'world y'}):`);
  if (steps.length) lines.push(`Sudden changes:\n${steps.map((l) => `- ${l}`).join('\n')}`);

  let hi = null;
  let lo = null;
  const trees = [];
  for (const [k, t] of found.tops) {
    const [x, z] = k.split(',').map(Number);
    if (TRUNK.test(t.name)) trees.push({ ...t, x, z });
    if (!hi || t.y > hi.y) hi = { ...t, x, z };
    if (!lo || t.y < lo.y) lo = { ...t, x, z };
  }
  const at = (p) => `${p.name} at ${frame.fmt(p.x, p.y, p.z)}${frame.relative ? '' : ` (${height(p.y)})`}`;
  if (hi) lines.push(`Highest: ${at(hi)}. Lowest: ${at(lo)}.`);
  if (trees.length) {
    const d = (p) => Math.abs(p.x - pose.x) + Math.abs(p.z - pose.z);
    const near = trees.sort((a, b) => d(a) - d(b)).slice(0, LIST_LIMIT_PER_TYPE);
    lines.push(`Tree trunks (top of the trunk; leaves aren't seen): ${near.map(at).join('; ')}`
      + `${trees.length > near.length ? ` (+${trees.length - near.length} more)` : ''}.`);
  }
  return lines.join('\n');
}

/**
 * What the map says about the cube of `radius` around the robot, summarized like a scan (Vision
 * keeps the map fresh close to the robot). Used for the model's awareness.
 */
function mapSummary(world, pose, radius, mode = 'world', intro = null, { grid = false } = {}) {
  const cells = [];
  let known = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const [x, y, z] = [pose.x + dx, pose.y + dy, pose.z + dz];
        const name = world.get(x, y, z);
        const seen = name && name !== CLEAR;
        if (seen) known++;
        cells.push({ x, y, z, block: seen ? name : '?' });
      }
    }
  }
  // Almost nothing known: one line, not a page of question marks.
  if (!intro && known < cells.length / 10) {
    return `Around you: your map knows only ${known} of the ${cells.length} blocks within ${radius} of you so far; scan to see.`;
  }
  return summarizeScan({ agent: { position: { x: pose.x, y: pose.y, z: pose.z }, yRot: pose.yRot ?? [0, 90, 180, -90][pose.facing] }, cells },
    mode, {
      intro: intro || `Around you, from your map (Awareness radius ${radius}: ${known} of ${cells.length} blocks known):`,
      unknownText: (n) => `${n} blocks around you haven't been seen yet (scan to see them).`,
      grid,
    });
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

/** Is this chat message one of this robot's own lines echoing back? (Other robots' lines look the same.) */
function isOwnChat(message) {
  const plain = String(message || '').replace(/§./g, '');
  return recentlySaid.some((r) => Date.now() - r.time < 30000 && r.text && plain.includes(r.text));
}

/**
 * A robot's chat line, the way sayInChat writes them ("§b<Name>§r text"), from this robot or any
 * other player's Ptolemy: { name, text }, or null for anything else.
 */
function robotLine(message) {
  const m = /^§b<([^>§]{1,40})>§r\s?([\s\S]*)$/.exec(String(message || ''));
  return m ? { name: m[1].trim(), text: m[2].replace(/§./g, '').trim() } : null;
}

module.exports = { createToolbox, sayInChat, isOwnChat, robotLine, summarizeScan, summarizeSurvey, mapSummary, heightGrid };
