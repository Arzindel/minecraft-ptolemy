'use strict';

const { planPath, summarizeSteps, cellsAround, contradicts } = require('./pathfind');
const { getAgentPose, samePose, describePose } = require('./pose');
const { playerPosition } = require('./players');
const { aheadOnPath } = require('./vision');
const { surveySurface, surveyColumns, checkCells, unknownAround, corridorCells } = require('./survey');

const SAFE_WAIT_MS = 2000;
// Re-plans after Vision saw the path blocked, per walk (each costs nothing but a plan).
const MAX_REPLANS = 50;
// Rounds of checking a planned path's unseen cells before walking it (reset by each rescan).
const MAX_CHECKS = 30;
// The first look around before a walk (a small cube: the survey and the path checks see the rest),
// and around an end that turned out to be indoors or underground.
const LOCAL_SCAN_RADIUS = 3;
const END_SCAN_RADIUS = 4;
// How #pathfindwalk / go_to find their way (method=... picks one; auto: surface when walking, rescan when flying).
const METHODS = {
  surface: 'surveying the ground first',
  corridor: 'scanning a corridor of tubes between here and there first, then looking ahead',
  lookahead: 'looking ahead where the plan meets the unknown, before moving',
  rescan: 'rescanning around the robot at the edge of what it knows',
};
// Look-ahead: the cube scanned (unseen cells only) where the plan first meets the unknown.
const LOOK_RADIUS = 3;
// Look-ahead: when something solid is in the way, the ground is measured this far around it.
const HILL_RADIUS = 4;
// Method 1: the radius of the five tubes scanned between the robot and the target.
const CORRIDOR_RADIUS = 2;
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
   * @param {import('../world/map').WorldMap} deps.world
   * @param {(radius: number, opts?: {quiet?: boolean}) => Promise<object|null>} deps.scan  refreshes Sight
   * @param {(text: string, extra?: object) => void} deps.log
   * @param {(message: object) => void} deps.broadcast
   * @param {import('./vision').Vision} [deps.vision]  looks ahead after every step (in the same flight as the position check)
   */
  constructor({ bridge, world, settings, scan, log, broadcast, vision = null }) {
    Object.assign(this, { bridge, world, settings, scan, log, broadcast, vision });
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
    method = 'auto',
  } = {}) {
    const kind = kindOf(fly);
    await this._exclusive(async () => {
      this.walking = kind;
      try {
        await this._pathfindwalk(kind, args, { scanRadius, retries, fly, near, method });
      } finally {
        this.walking = null;
        this._finishPath(kind);
      }
    });
  }

  async _pathfindwalk(kind, args, { scanRadius: radius, retries, fly, near, method = 'auto' }) {
    let how = method === 'auto' ? (fly ? 'corridor' : 'surface') : method;
    if (!METHODS[how]) throw new Error(`unknown method "${method}" (auto, ${Object.keys(METHODS).join(', ')})`);
    // Look around first: the whole rescan radius for the old way, a small cube otherwise (the ground
    // survey and the path checks see the rest).
    await this.scan(how === 'rescan' ? radius : Math.min(radius, LOCAL_SCAN_RADIUS), { quiet: true });
    let pose = await getAgentPose(this.bridge);
    let goal = await this._resolveGoal(args, pose, { near });

    // Rescans on the way into unknown territory are budgeted by distance, so a robot trying
    // to get into a closed box gives up instead of looping forever. Everything seen is kept, so
    // running it again carries on from where it stopped rather than starting over.
    const distance = Math.hypot(goal.x - pose.x, goal.y - pose.y, goal.z - pose.z);
    const maxRescans = Math.ceil((2 * distance) / radius) + 3;
    let rescans = 0;
    let failures = 0;
    let replans = 0;
    let checks = 0;
    let looks = 0;
    const maxLooks = Math.ceil(distance / LOOK_RADIUS) + 10;
    this.log(`Heading to ${describeGoal(goal)}, ${round(distance)} blocks away, ${METHODS[how]} `
      + `(up to ${retries} retries and ${maxRescans} rescans of radius ${radius}).`);
    // A trip between two places under open sky stays on the surface: unseen cells below the measured
    // ground are planned as solid (see planPath's `underground`).
    // (An end under a roof is fine: the cells around it were scanned, and known cells beat guesses.)
    if (how === 'surface') await this._surveyWay(pose, goal);
    if (how === 'corridor') {
      await this._scanCorridor(pose, goal);
      how = 'lookahead'; // then fill in whatever the corridor missed
    }
    if (how === 'lookahead') {
      // A target in the unknown: look around it first, so the plan starts filling in from both ends.
      const around = unknownAround(this.world, goal, LOOK_RADIUS);
      if (around.length) {
        await checkCells(this.bridge, this.world, around);
        this.log(`Looking ahead: ${around.length} unseen cells around the target first.`);
      }
    }
    // Looking ahead on a trip between two places under open sky may guess the ground like surface
    // does (see below: what's found in the way gets its ground measured). Under a roof, no guesses.
    let overGround = how === 'surface' || (how === 'lookahead' && !(await this._endsCovered(pose, goal)));

    // The plan is kept while what's learned only confirms it; it's planned again when something
    // contradicts it (a cell in the way, a step that lost what held the robot up), and after a walk.
    let plan = null;
    const planOptions = () => ({ ...this._planOptions(fly), underground: !overGround });
    // Learned something new about the plan's cells: does it still stand?
    const recheck = (what) => {
      const why = contradicts(this.world, plan, planOptions());
      if (why) {
        this.log(`${what}; ${why}, so planning again.`);
        plan = null;
      } else {
        this.log(`${what}; the plan stands.`);
      }
      return why;
    };

    for (;;) {
      if (!plan) {
        // A target that turned out to be solid once seen means "go next to it".
        if (!goal.cells && this.world.state(goal.x, goal.y, goal.z) === 'solid') {
          goal = { ...goal, cells: cellsAround(goal.x, goal.y, goal.z) };
        }
        plan = planPath(this.world, pose, goal, planOptions());
        if (plan.error && overGround) {
          // No way over the surface as guessed (say, the target is in a cave): look ahead instead.
          overGround = false;
          how = 'lookahead';
          this.log(`No way over the ground as measured, so ${METHODS.corridor} instead.`);
          await this._scanCorridor(pose, goal);
          plan = null;
          continue;
        }
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
      }
      const unseen = (st) => st.enters && (how === 'rescan' ? st.unknown : !this.world.verified(...st.enters));

      // Method 2, where the plan leaves the measured strip (a detour around a wall, say): measure
      // the ground of the columns it goes through, instead of relying on guesses.
      if (how === 'surface' && overGround && checks < MAX_CHECKS) {
        const columns = new Map();
        for (const st of plan.steps) {
          if (!st.enters) continue;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              const [x, z] = [st.enters[0] + dx, st.enters[2] + dz];
              if (this.world.groundY(x, z) === null) columns.set(`${x},${z}`, [x, z]);
            }
          }
        }
        if (columns.size) {
          checks++;
          const top = Math.max(...plan.steps.filter((st) => st.enters).map((st) => st.enters[1]));
          const s = await surveyColumns(this.bridge, this.world, [...columns.values()], top);
          recheck(`Measuring the ground where the plan leaves the survey: ${s.columns} more columns (${checks}/${MAX_CHECKS})`);
          continue;
        }
      }

      // Method 3, before moving: where the plan meets the unknown, scan the unseen cells around that
      // spot, alternating between the robot's end of the plan and the target's end, so both sides
      // fill in until they meet. Plan again only if what's found contradicts the plan.
      if (how === 'lookahead' && looks < maxLooks) {
        const unknown = plan.steps.filter((st) => st.enters && this.world.state(...st.enters) === 'unknown');
        if (unknown.length) {
          const at = unknown[looks % 2 ? unknown.length - 1 : 0].enters;
          looks++;
          const cells = unknownAround(this.world, { x: at[0], y: at[1], z: at[2] }, LOOK_RADIUS);
          await checkCells(this.bridge, this.world, cells);
          const why = recheck(`Looking ahead: ${cells.length} unseen cells around ${at.join(' ')}, `
            + `${looks % 2 ? 'the first' : 'the last'} unknown spot on the plan (${looks}/${maxLooks})`);
          // Something solid in the way is likely a hill or a mountain, not a lone wall: every scan
          // further into it would just find more of it. Measure the ground around it (one command a
          // column) so the next plan goes over or around it straight away.
          if (why && overGround) {
            const columns = [];
            for (let dx = -HILL_RADIUS; dx <= HILL_RADIUS; dx++) {
              for (let dz = -HILL_RADIUS; dz <= HILL_RADIUS; dz++) {
                if (this.world.groundY(at[0] + dx, at[2] + dz) === null) columns.push([at[0] + dx, at[2] + dz]);
              }
            }
            if (columns.length) {
              await surveyColumns(this.bridge, this.world, columns, Math.max(at[1], goal.y));
              this.log(`Looking ahead: measured the ground of ${columns.length} columns around what's in the way, `
                + 'to plan over or around it.');
            }
          }
          continue;
        }
      }

      // Before walking, check the cells the path goes through that nobody has actually seen (never
      // seen, or only "clear" by the ground survey: they may be leaves or water), and the ones beside
      // and below them that hold the robot up there (the plan may lean on a guess: a wall or a bank
      // that isn't really there). Flying needs nothing to hold it up: only its own cells matter.
      if (how !== 'rescan' && checks < MAX_CHECKS) {
        const doubtful = [];
        for (const st of plan.steps) {
          if (!st.enters) continue;
          for (const c of fly ? [st.enters] : [st.enters, ...leanedOn(st.enters)]) if (!this.world.verified(...c)) doubtful.push(c);
        }
        if (doubtful.length) {
          checks++;
          const n = await checkCells(this.bridge, this.world, doubtful);
          recheck(`Checking the path: looked at ${n} unseen cells on and around it (${checks}/${MAX_CHECKS})`);
          continue;
        }
      }

      // Walk while the path goes through cells that have been seen; at the first unseen one, stop and look.
      const stopAt = plan.steps.findIndex(unseen);
      const known = stopAt === -1 ? plan.steps : plan.steps.slice(0, stopAt);
      const result = await this._walk(known, { ahead: plan.steps });
      pose = result.pose;
      plan = null; // walked (or interrupted): the next plan starts from where the robot is

      if (result.stopped) {
        this.log(`Stopped by #pathstop at ${describePose(pose)}.`);
        return;
      }
      if (result.seenBlocked) {
        // Vision saw something in the way that wasn't expected: plan again from here.
        if (++replans > MAX_REPLANS) {
          this.log(`Giving up after re-planning ${MAX_REPLANS} times around things in the way, at ${describePose(pose)}.`);
          return;
        }
        this.log(`Re-planning: ${result.reason}.`);
        continue;
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
      if (stopAt === -1) {
        this.log(`Arrived at ${describePose(pose)}.`);
        return;
      }

      rescans++;
      if (rescans > maxRescans) {
        this.log(`Giving up for now: ${maxRescans} rescans used without reaching ${describeGoal(goal)}, `
          + `at ${describePose(pose)}. The way may be long (a big wall or hill to go around) or the target enclosed. `
          + 'What was seen is remembered, so trying again carries on from here.');
        return;
      }
      this.log(`Entering unknown territory at ${describePose(pose)}; rescanning (${rescans}/${maxRescans}).`);
      await this.scan(radius, { quiet: true });
      checks = 0;
    }
  }

  /** Is either end under something solid (indoors, in a cave)? Two gettopsolidblock calls. */
  async _endsCovered(pose, goal) {
    const ends = [[pose.x, pose.z], [goal.x, goal.z]];
    await surveyColumns(this.bridge, this.world, ends, Math.max(pose.y, goal.y));
    return [pose, goal].some((e) => {
      const g = this.world.groundY(e.x, e.z);
      return g !== null && g >= e.y;
    });
  }

  /** Method 1: scan the unseen cells of the five tubes between the robot and the goal. */
  async _scanCorridor(pose, goal) {
    // Unverified cells too: "clear" by the ground survey may still be leaves, which matter when flying.
    const cells = corridorCells(pose, goal, CORRIDOR_RADIUS).filter((c) => !this.world.verified(...c));
    if (cells.length) await checkCells(this.bridge, this.world, cells);
    this.log(`Scanned a corridor between here and there: ${cells.length} unseen cells in five tubes of radius ${CORRIDOR_RADIUS}.`);
  }

  /**
   * Method 2: measure the ground between the robot and the goal with gettopsolidblock. An end with
   * something solid over it is indoors or underground (the survey only saw the roof), so the unseen
   * cells around it are looked at too. Resolves to true if both ends are under open sky.
   */
  async _surveyWay(pose, goal) {
    let open = true;
    const s = await surveySurface(this.bridge, this.world, pose, goal, { width: this.settings.get('path.surveyWidth') });
    this.log(`Surveyed the ground: ${s.columns} columns between here and there (${s.commands} commands`
      + `${s.unloaded ? `; ${s.unloaded} are in chunks that aren't loaded, so unknown` : ''}).`);
    for (const [label, end] of [['The robot', pose], ['The target', goal]]) {
      const groundY = s.ground.get(`${end.x},${end.z}`);
      if (groundY === undefined || groundY < end.y) continue; // open sky above it
      open = false;
      const cells = unknownAround(this.world, end, END_SCAN_RADIUS);
      if (!cells.length) continue;
      await checkCells(this.bridge, this.world, cells);
      this.log(`${label} is under a roof or underground (${this.world.get(end.x, groundY, end.z) || 'a block'} above it): `
        + `looked at the ${cells.length} unseen cells around it.`);
    }
    return open;
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

  /**
   * Execute steps in order. Stops at the first step whose resulting pose isn't the expected one.
   * After each step, Vision looks ahead along `ahead` (the whole plan, of which `steps` may be the
   * first part) in the same flight as the position check; if that shows something solid where the
   * plan still has to go, the walk stops before it: { ok: false, seenBlocked: true, step, ... }.
   */
  async _walk(steps, { ahead = steps } = {}) {
    let pose = null;
    for (let i = 0; i < steps.length; i++) {
      if (this.stopRequested) return { ok: false, stopped: true, index: i, pose: pose || await getAgentPose(this.bridge) };
      const step = steps[i];
      const res = await this.bridge.sendCommand(step.command, { quiet: true });
      if (!res.ok) {
        return { ok: false, index: i, step, pose: await getAgentPose(this.bridge), reason: `${step.command}: ${res.statusMessage}` };
      }

      const deadline = Date.now() + (this.safe ? SAFE_WAIT_MS : 0);
      for (let first = true; ; first = false) {
        if (first && this.vision) {
          const center = aheadOnPath(ahead, i, this.vision.radius, step.expect);
          [pose] = await Promise.all([getAgentPose(this.bridge), this.vision.look(center, step.expect).catch(() => null)]);
        } else {
          pose = await getAgentPose(this.bridge);
        }
        if (samePose(pose, step.expect) || Date.now() >= deadline) break;
        await sleep(SAFE_POLL_MS);
      }
      this.broadcast({ type: 'agent', position: { x: pose.x, y: pose.y, z: pose.z }, yRot: pose.yRot });
      this.agentMoved(pose);
      if (this.vision) this.vision.robotAt(pose);
      if (!samePose(pose, step.expect)) {
        return {
          ok: false, index: i, step, pose,
          reason: `after "${step.command}" the agent is at ${describePose(pose)}, expected ${describePose(step.expect)}`,
        };
      }
      // Something solid that Vision just saw where the rest of the plan goes. Only what was just
      // looked at counts: older map knowledge may be stale, and the plan was made with it anyway.
      const box = this.vision && this.vision.last;
      const inView = ([x, y, z]) => box && box.center && Math.max(Math.abs(x - box.center.x), Math.abs(y - box.center.y),
        Math.abs(z - box.center.z)) <= box.radius;
      // Only the very next cell: the robot keeps going until it is right in front of the obstacle.
      const next = ahead.slice(i + 1).findIndex((s) => s.enters);
      if (next !== -1 && inView(ahead[i + 1 + next].enters) && this.world.state(...ahead[i + 1 + next].enters) === 'solid') {
        const blocked = ahead[i + 1 + next];
        const [x, y, z] = blocked.enters;
        return {
          ok: false, seenBlocked: true, index: i + 1 + next, step: blocked, pose,
          reason: `${this.world.get(x, y, z) || 'something solid'} is in the way ahead, at ${x} ${y} ${z}`,
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

/** The cells that can hold the robot up in `cell`: the six touching it and the four below its edges. */
function leanedOn([x, y, z]) {
  return [[x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z], [x, y, z + 1], [x, y, z - 1],
    [x + 1, y - 1, z], [x - 1, y - 1, z], [x, y - 1, z + 1], [x, y - 1, z - 1]];
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

module.exports = { Navigator, pathMessage, METHODS };
