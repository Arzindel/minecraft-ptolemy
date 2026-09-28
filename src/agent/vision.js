'use strict';

const { EventEmitter } = require('events');
const { getAgentPose } = require('./pose');
const { nearbyEntities, parseTargets } = require('./entities');

// Vision: the robot's real-time look around. A small cube of blocks (radius 1 = 3x3x3 = 27 cells)
// and where the entities nearby are, sent in the same flight as a position check the robot does
// anyway (after every step of a walk), so it costs no extra waiting: Bedrock answers the whole
// flight in about one round trip. Everything seen goes into the map.
//
// While walking, the cube isn't centered on the robot but on the path, `radius` cells ahead, so
// the robot sits on its inner edge and sees what it's about to walk into.
//
// Knowing *what* an entity is takes a few round trips (see entities.js), but an entity keeps its
// uniqueId, so each look only asks where everything is, and new ids are identified in the
// background, once.

const IDLE_TICK_MS = 250;
const MAX_IDENTITIES = 1000;
const IDENTIFY_EVERY_MS = 1000;

class Vision extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../minecraft/bridge').MinecraftBridge} deps.bridge
   * @param {import('../world/map').WorldMap} deps.world
   * @param {import('../settings').Settings} deps.settings
   * @param {() => boolean} [deps.busy]   true while something else looks as it goes (a walk)
   * @param {() => boolean} [deps.enabled]   false while there's no agent: looking asks where it is, which would create one
   */
  constructor({ bridge, world, settings, busy = () => false, enabled = () => true }) {
    super();
    Object.assign(this, { bridge, world, settings, busy, enabled });
    this.last = null; // { center, radius, robot, time } of the latest look
    this.robot = null; // the robot's latest known pose
    this.identities = new Map(); // entity uniqueId -> { name, type, hostile, player, item } | { hidden: true }
    this.looking = false;
    this._identifying = false;
    this._lastIdentify = 0;
    this._timer = null;
    this._soon = false;
  }

  get radius() {
    return this.settings.get('vision.radius');
  }

  /**
   * Look at the cube around `center` and at the entities around `robot`, all in one flight. Send
   * it alongside other commands (e.g. the position check after a step) to add no waiting.
   * Resolves to { changed, entities } (entities null when not looked for), after the map is updated.
   */
  async look(center, robot = center) {
    const r = this.radius;
    const send = (cmd) => this.bridge.sendCommand(cmd, { quiet: true });
    const cells = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) cells.push([center.x + dx, center.y + dy, center.z + dz]);
      }
    }
    const entityRadius = this.settings.get('vision.entityRadius');
    const mid = { x: robot.x + 0.5, y: robot.y + 0.5, z: robot.z + 0.5 };
    this.looking = true;
    try {
      const [replies, targets] = await Promise.all([
        Promise.all(cells.map(([x, y, z]) => send(`testforblock ${x} ${y} ${z} air`))),
        entityRadius > 0 ? send(`querytarget @e[x=${mid.x},y=${mid.y},z=${mid.z},r=${entityRadius}]`) : null,
      ]);
      const seen = [];
      replies.forEach((res, i) => {
        const block = blockOf(res);
        if (block) seen.push([...cells[i], block]);
      });
      const changed = this.world.setBlocks(seen);
      const entities = targets ? this._entities(parseTargets(targets), robot, entityRadius) : null;
      this.last = { center: { x: center.x, y: center.y, z: center.z }, radius: r, robot: pick(robot), time: Date.now() };
      this.emit('look', { ...this.last, changed, entities, entityRadius });
      return { changed, entities };
    } finally {
      this.looking = false;
    }
  }

  /** Look again as soon as nothing else is (e.g. right after a tool call). */
  soon() {
    this._soon = true;
  }

  /** Keep looking around every `vision.idleSeconds` while nothing else is. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick().catch(() => {}), IDLE_TICK_MS);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    if (!this.bridge.connected || this.looking || this.busy() || !this.enabled()) return;
    const idle = this.settings.get('vision.idleSeconds') * 1000;
    const due = this._soon || (idle > 0 && (!this.last || Date.now() - this.last.time >= idle));
    if (!due) return;
    this._soon = false;
    // Centered on where the robot was last seen, in the same flight as checking where it is now:
    // what's seen is right either way (world coordinates), and the next look is centered again.
    if (!this.robot) {
      this.looking = true;
      try {
        this.robot = await getAgentPose(this.bridge);
        this.emit('moved', this.robot); // first sight of the robot: where it is
      } catch {
        this.last = { ...(this.last || {}), time: Date.now() }; // no robot (yet): try again later
        return;
      } finally {
        this.looking = false;
      }
    }
    const [pose] = await Promise.all([getAgentPose(this.bridge).catch(() => null), this.look(this.robot)]);
    if (pose && !samePlace(pose, this.robot)) this.emit('moved', pose);
    if (pose) this.robot = pose;
  }

  /** The robot is here now (so the next idle look is centered on it). */
  robotAt(pose) {
    this.robot = pose;
  }

  /** Entities with what's known about them; unknown ids are identified in the background. */
  _entities(targets, robot, radius) {
    if (!targets) return null;
    const unknown = targets.filter((t) => !this.identities.has(t.id));
    if (unknown.length) this._identify(robot, radius);
    return targets.filter((t) => !(this.identities.get(t.id) || {}).hidden).map((t) => {
      const who = this.identities.get(t.id) || { name: 'Unidentified entity', type: null, hostile: false, player: false, item: false };
      return { id: t.id, ...who, x: Math.floor(t.x), y: Math.floor(t.y), z: Math.floor(t.z), exact: { x: t.x, y: t.y, z: t.z } };
    });
  }

  _identify(robot, radius) {
    if (this._identifying || Date.now() - this._lastIdentify < IDENTIFY_EVERY_MS) return;
    this._identifying = true;
    this._lastIdentify = Date.now();
    const center = { x: robot.x, y: robot.y, z: robot.z };
    nearbyEntities(this.bridge, center, radius).then(({ entities, raw }) => {
      const named = new Set(entities.map((e) => e.id));
      for (const e of entities) {
        this.identities.set(e.id, { name: e.name, type: e.type, hostile: e.hostile, player: e.player, item: e.item });
      }
      // Found by querytarget but left out on purpose (the robot itself, experience orbs): hidden.
      for (const t of parseTargets({ ok: true, body: raw.querytarget }) || []) {
        if (!named.has(t.id)) this.identities.set(t.id, { hidden: true });
      }
      while (this.identities.size > MAX_IDENTITIES) this.identities.delete(this.identities.keys().next().value);
    }).catch(() => {}).finally(() => { this._identifying = false; });
  }
}

/** The block a `testforblock x y z air` reply names, or null if it couldn't tell. */
function blockOf(res) {
  const body = res.body || {};
  if (body.matches === true) return 'Air';
  const m = /\bis (.+?)\s*\(expected/i.exec(res.statusMessage || '');
  return m ? m[1] : null;
}

function pick({ x, y, z }) {
  return { x, y, z };
}

function samePlace(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.facing === b.facing;
}

/**
 * Where Vision looks while walking `steps` (as planned, each with the cell it `enters`), after step
 * `index`: `radius` cells further along the path, so the robot is on the cube's inner edge; closer
 * if the path ends sooner. `robot` when nothing is left to enter.
 */
function aheadOnPath(steps, index, radius, robot) {
  let last = null;
  let count = 0;
  for (let i = index + 1; i < steps.length; i++) {
    if (!steps[i].enters) continue;
    last = steps[i].enters;
    if (++count === radius) break;
  }
  return last ? { x: last[0], y: last[1], z: last[2] } : robot;
}

module.exports = { Vision, aheadOnPath, blockOf };
