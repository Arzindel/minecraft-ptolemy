'use strict';

const { planPath, summarizeSteps, cellsAround } = require('./pathfind');
const { getAgentPose, samePose, describePose } = require('./pose');
const { playerPosition } = require('./players');

const SAFE_WAIT_MS = 2000;
const SAFE_POLL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 10) / 10;

/**
 * #pathfind / #pathwalk / #pathfindwalk and their #fly* versions: plan routes over what the robot
 * knows and walk them one step at a time, checking after every step that the agent ended up where
 * the plan said. The plain versions keep the robot next to blocks, as if it walked and climbed;
 * the fly versions take the shortest route through the air.
 */
class Navigator {
  /**
   * @param {object} deps
   * @param {import('../minecraft/bridge').MinecraftBridge} deps.bridge
   * @param {import('./world').WorldKnowledge} deps.world
   * @param {(radius: number, opts?: {quiet?: boolean}) => Promise<object|null>} deps.scan  refreshes Sight
   * @param {(text: string, extra?: object) => void} deps.log
   * @param {(message: object) => void} deps.broadcast
   */
  constructor({ bridge, world, settings, scan, log, broadcast }) {
    Object.assign(this, { bridge, world, settings, scan, log, broadcast });
    // One stored path per kind ({ start, goal, steps, cells, unknownSteps }). A stored path is only
    // valid while the agent is at its start, so it's dropped as soon as the agent moves, unless
    // that path is the one being walked.
    this.paths = { walk: null, fly: null };
    this.walking = null; // the kind being walked right now
    this.busy = false;
    this.stopRequested = false;
  }

  // --- Console entry points -------------------------------------------------

  async pathfind(args, { fly = false, near = null } = {}) {
    const kind = kindOf(fly);
    await this._exclusive(async () => {
      const start = await getAgentPose(this.bridge);
      this.agentMoved(start);
      const goal = await this._resolveGoal(args, start, { near });
      const plan = planPath(this.world, start, goal, this._planOptions(fly));
      if (plan.error) {
        this._setPath(kind, null);
        this.log(`No path to ${describeGoal(goal)}: ${plan.error}.`);
        return;
      }
      this._setPath(kind, { start, goal, ...plan });
      this.log(this._describePlan(plan, goal, fly), { commandLine: 'Path', body: this.paths[kind] });
    });
  }

  async pathwalk({ fly = false } = {}) {
    const kind = kindOf(fly);
    const find = fly ? '#flypathfind' : '#pathfind';
    await this._exclusive(async () => {
      const path = this.paths[kind];
      if (!path) {
        this.log(`There is no ${fly ? 'flight ' : ''}path to walk. Run ${find} first.`);
        return;
      }
      const pose = await getAgentPose(this.bridge);
      if (!samePose(pose, path.start)) {
        this.agentMoved(pose);
        this.log(`The agent moved since the path was planned (it's at ${describePose(pose)}, the path started at `
          + `${describePose(path.start)}), so the path was dropped. Run ${find} again.`);
        return;
      }
      this.walking = kind;
      const result = await this._walk(path.steps);
      this.walking = null;
      this._finishPath(kind);
      if (result.ok) this.log(`Arrived at ${describePose(result.pose)}.`);
      else if (result.stopped) this.log(`Stopped by #pathstop at ${describePose(result.pose)}.`);
      else this.log(`Walk interrupted at step ${result.index + 1}/${path.steps.length}: ${result.reason}.`);
    });
  }

  /**
   * The agent is at `pose`: drop every stored path it isn't at the start of anymore,
   * except the one being walked.
   */
  agentMoved(pose) {
    for (const kind of Object.keys(this.paths)) {
      const path = this.paths[kind];
      if (!path || kind === this.walking || samePose(pose, path.start)) continue;
      this._setPath(kind, null);
      this.log(`The stored ${kind === 'fly' ? 'flight path' : 'path'} was dropped because the agent moved.`);
    }
  }

  async pathfindwalk(args, {
    scanRadius = this.settings.get('path.scanRadius'), retries = this.settings.get('path.retries'), fly = false, near = null,
  } = {}) {
    const kind = kindOf(fly);
    await this._exclusive(async () => {
      this.walking = kind;
      try {
        await this._pathfindwalk(kind, args, { scanRadius, retries, fly, near });
      } finally {
        this.walking = null;
        this._finishPath(kind);
      }
    });
  }

  async _pathfindwalk(kind, args, { scanRadius: radius, retries, fly, near }) {
    await this.scan(radius, { quiet: true });
    let pose = await getAgentPose(this.bridge);
    let goal = await this._resolveGoal(args, pose, { near });

    // Rescans on the way into unknown territory are budgeted by distance, so a robot trying
    // to get into a closed box gives up instead of looping forever.
    const distance = Math.hypot(goal.x - pose.x, goal.y - pose.y, goal.z - pose.z);
    const maxRescans = Math.max(1, Math.ceil((1.5 * distance) / radius));
    let rescans = 0;
    let failures = 0;
    this.log(`Heading to ${describeGoal(goal)}, ${round(distance)} blocks away `
      + `(up to ${retries} retries and ${maxRescans} rescans of radius ${radius}).`);

    for (;;) {
      // A target that turned out to be solid once seen means "go next to it".
      if (!goal.cells && this.world.state(goal.x, goal.y, goal.z) === 'solid') {
        goal = { ...goal, cells: cellsAround(goal.x, goal.y, goal.z) };
      }
      const plan = planPath(this.world, pose, goal, this._planOptions(fly));
      if (plan.error) {
        this._setPath(kind, null);
        this.log(`Stopped: no path to ${describeGoal(goal)} from ${describePose(pose)}: ${plan.error}.`);
        return;
      }
      this._setPath(kind, { start: pose, goal, ...plan });
      if (!plan.steps.length) {
        this.log(`Arrived at ${describePose(pose)}.`);
        return;
      }

      // Walk until the plan is about to enter an unknown cell, then look before going on.
      const firstUnknown = plan.steps.findIndex((s) => s.unknown);
      const known = firstUnknown === -1 ? plan.steps : plan.steps.slice(0, firstUnknown);
      const result = await this._walk(known);
      pose = result.pose;

      if (result.stopped) {
        this.log(`Stopped by #pathstop at ${describePose(pose)}.`);
        return;
      }
      if (!result.ok) {
        failures++;
        this.log(`Step failed (${failures}/${retries} retries used): ${result.reason}.`);
        if (failures > retries) {
          this.log(`Giving up after ${failures} failed steps, at ${describePose(pose)}.`);
          return;
        }
        // Something is in the way that we didn't know about: remember it, look again, re-plan.
        if (result.step.enters) this.world.markBlocked(...result.step.enters);
        await this.scan(radius, { quiet: true });
        pose = await getAgentPose(this.bridge);
        continue;
      }
      if (firstUnknown === -1) {
        this.log(`Arrived at ${describePose(pose)}.`);
        return;
      }

      rescans++;
      if (rescans > maxRescans) {
        this.log(`Giving up: ${maxRescans} rescans used without reaching ${describeGoal(goal)}, `
          + `at ${describePose(pose)}. The target may be enclosed.`);
        return;
      }
      this.log(`Entering unknown territory at ${describePose(pose)}; rescanning (${rescans}/${maxRescans}).`);
      await this.scan(radius, { quiet: true });
    }
  }

  /**
   * Execute a few hand-made steps ({ command, expect, enters }) with the same checks as a path walk.
   * For the LLM tools; resolves to the walk result, or { ok: false, reason } if the robot is busy.
   */
  async runSteps(steps) {
    if (!this.bridge.connected) return { ok: false, reason: 'Minecraft is not connected' };
    if (this.busy) return { ok: false, reason: 'the robot is already walking a path' };
    this.busy = true;
    this.stopRequested = false;
    try {
      return await this._walk(steps);
    } catch (err) {
      return { ok: false, reason: err.message };
    } finally {
      this.busy = false;
    }
  }

  stop({ quiet = false } = {}) {
    if (!this.busy) {
      if (quiet) return;
      this.log('Nothing is running.');
      return;
    }
    this.stopRequested = true;
    this.log('Stopping after the current step...');
  }

  get safe() {
    return this.settings.get('path.safe');
  }

  setSafe(on) {
    this.settings.update({ 'path.safe': on });
    this.log(`Path safe mode is ${on ? 'on' : 'off'}: `
      + (on ? `after each step, wait up to ${SAFE_WAIT_MS / 1000}s for the agent to arrive.`
        : 'each step is checked once, as soon as the game acknowledges it.'));
  }

  // --- Internals ------------------------------------------------------------

  _planOptions(fly) {
    return {
      hug: !fly,
      costs: this.settings.costs(),
      turnCost: this.settings.get('path.turnCost'),
      unknownPenalty: this.settings.get('path.unknownPenalty'),
      finalMultiplier: this.settings.get('path.finalMultiplier'),
    };
  }

  /**
   * "Somewhere around" (x, y, z): any free cell up to 2 blocks away horizontally and 1 up or down,
   * but never straight above or below it. Each has an arrival cost (beside < diagonal < 2 away, plus
   * per block of height), and the planner adds finalMultiplier x the cost of standing there, so the
   * robot prefers to end on solid ground over hanging in the air right next to the target.
   */
  _nearGoal(x, y, z, label) {
    const get = (k) => this.settings.get(k);
    const cells = [];
    const arrival = new Map();
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (!dx && !dz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const c = [x + dx, y + dy, z + dz];
          if (this.world.state(...c) === 'solid') continue;
          const ring = Math.max(Math.abs(dx), Math.abs(dz));
          const flat = ring === 2 ? get('path.nearFar') : Math.abs(dx) + Math.abs(dz) === 1 ? get('path.nearSide') : get('path.nearDiagonal');
          cells.push(c);
          arrival.set(c.join(','), flat + get('path.nearHeight') * Math.abs(dy));
        }
      }
    }
    return { x, y, z, cells, arrival, label: label || `near ${x} ${y} ${z}` };
  }

  /** The cell a player's feet are in, when querytarget reports a height closer to their eyes. */
  _feet(x, y, z) {
    if (this.world.state(x, y - 1, z) !== 'solid' && this.world.state(x, y - 2, z) === 'solid') return y - 1;
    return y;
  }

  async _exclusive(fn) {
    if (!this.bridge.connected) {
      this.log('Minecraft is not connected.');
      return;
    }
    if (this.busy) {
      this.log('A path command is already running (#pathstop to stop it).');
      return;
    }
    this.busy = true;
    this.stopRequested = false;
    try {
      await fn();
    } catch (err) {
      this.log(`Path command failed: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Execute steps in order. Stops at the first step whose resulting pose isn't the expected one. */
  async _walk(steps) {
    let pose = null;
    for (let i = 0; i < steps.length; i++) {
      if (this.stopRequested) return { ok: false, stopped: true, index: i, pose: pose || await getAgentPose(this.bridge) };
      const step = steps[i];
      const res = await this.bridge.sendCommand(step.command, { quiet: true });
      if (!res.ok) {
        return { ok: false, index: i, step, pose: await getAgentPose(this.bridge), reason: `${step.command}: ${res.statusMessage}` };
      }

      const deadline = Date.now() + (this.safe ? SAFE_WAIT_MS : 0);
      for (;;) {
        pose = await getAgentPose(this.bridge);
        if (samePose(pose, step.expect) || Date.now() >= deadline) break;
        await sleep(SAFE_POLL_MS);
      }
      this.broadcast({ type: 'agent', position: { x: pose.x, y: pose.y, z: pose.z }, yRot: pose.yRot });
      this.agentMoved(pose);
      if (!samePose(pose, step.expect)) {
        return {
          ok: false, index: i, step, pose,
          reason: `after "${step.command}" the agent is at ${describePose(pose)}, expected ${describePose(step.expect)}`,
        };
      }
    }
    return { ok: true, pose: pose || await getAgentPose(this.bridge) };
  }

  /**
   * "x y z" (each may be ~ or ~n, relative to the agent) or "@p" / "me" for the connected player,
   * in which case the agent ends next to them rather than inside them.
   */
  async _resolveGoal(args, pose, { near = null } = {}) {
    // A ready-made goal ({ x, y, z, cells, label }), e.g. "any cell beside this block" from the tools.
    if (args && !Array.isArray(args) && args.goal) return args.goal;
    // "@p" is the connected player; "@p <name>" any player online.
    if (args.length >= 1 && /^(@p|@s|me)$/i.test(args[0])) {
      const name = args.slice(1).join(' ') || null;
      const player = await playerPosition(this.bridge, name);
      if (!player) throw new Error(name ? `can't find a player called "${name}" (are they online?)` : 'couldn\'t read your position');
      const { x, z } = player;
      const y = this._feet(x, player.y, z);
      const who = name && name !== this.bridge.player ? name : 'you';
      // To a player: somewhere around them unless asked for their exact spot.
      if (near === false) return { x, y, z, label: `${who === 'you' ? 'your' : `${who}'s`} exact spot` };
      return this._nearGoal(x, y, z, who);
    }

    if (args.length !== 3) throw new Error('usage: <x> <y> <z> (~ for relative to the agent), or @p [player name]');
    const [x, y, z] = args.map((arg, i) => {
      const base = [pose.x, pose.y, pose.z][i];
      const m = /^(~)?(-?\d+)?$/.exec(arg);
      if (!m || (!m[1] && m[2] === undefined)) throw new Error(`"${arg}" isn't a coordinate`);
      return (m[1] ? base : 0) + Number(m[2] || 0);
    });
    if (near === true) return this._nearGoal(x, y, z);
    // A solid target means "go next to it".
    if (this.world.state(x, y, z) !== 'solid') return { x, y, z };
    return { x, y, z, cells: cellsAround(x, y, z) };
  }

  _setPath(kind, path) {
    this.paths[kind] = path;
    this.broadcast(pathMessage(kind, path));
  }

  /** A walked path is used up: drop it, but leave its cells on the Nanny Cam as a faded trail. */
  _finishPath(kind) {
    const path = this.paths[kind];
    this.paths[kind] = null;
    if (path) this.broadcast({ ...pathMessage(kind, path), trail: true });
  }

  _describePlan(plan, goal, fly) {
    const moves = plan.steps.filter((s) => !s.action.startsWith('turn')).length;
    const turns = plan.steps.length - moves;
    if (!plan.steps.length) return `Already at ${describeGoal(goal)}.`;
    return `${fly ? 'Flight path' : 'Path'} to ${describeGoal(goal)}: `
      + `${plan.steps.length} steps (${moves} moves, ${turns} turns)`
      + (plan.unknownSteps ? `, ${plan.unknownSteps} through unknown cells` : ', all through known cells')
      + (plan.approximate ? ' (a quick estimate: every route was expensive, so it may not be the cheapest)' : '')
      + `\n  ${summarizeSteps(plan.steps)}\n  Run ${fly ? '#flypathwalk' : '#pathwalk'} to walk it.`;
  }
}

function describeGoal(goal) {
  const where = `${goal.x} ${goal.y} ${goal.z}`;
  if (goal.label) return `${goal.label} (${where})`;
  return goal.cells ? `next to ${where}` : where;
}

function kindOf(fly) {
  return fly ? 'fly' : 'walk';
}

function pathMessage(kind, path) {
  return { type: 'path', kind, cells: path ? path.cells : [] };
}

module.exports = { Navigator, pathMessage };
