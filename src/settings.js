'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_WONDER_PROMPT = `Nobody has asked you for anything right now. You have a quiet moment: act natural, like a small \
robot living in this world would. Look at what's on your mind and your todo list. You could follow up on one of them, \
wander a little (stay inside the named areas if there are any), look around with a small scan, have a new thought \
(add_thought) or let go of an old one, or simply do nothing and enjoy the view. Keep it small: a few actions at most. \
Don't talk in the game chat unless you have a real reason to. End with one short sentence about what you did or thought.`;

/**
 * Everything tunable from the Configuration tab (and some console commands), with defaults,
 * limits and help text. Each group sits on one of the Configuration sub-tabs (`tab`).
 *
 * Fields with `scope: 'world'` are kept per Minecraft world: each world gets its own copy
 * (started from the global values the first time it's seen), so e.g. path costs can differ
 * between worlds. Everything else is global. Global values live in data/settings.json, a world's
 * copy in data/worlds/<id>/settings.json.
 */
const SCHEMA = [
  {
    tab: 'llm',
    group: 'Model behaviour',
    help: 'How the Automatic mode uses whichever endpoint is active above.',
    fields: [
      { key: 'llm.stream', label: 'Stream replies', type: 'boolean', default: true,
        help: 'Show the model\'s thinking and answer as they are written instead of all at once. The timeout then counts '
          + 'silence, not the whole answer. Turned off automatically for a server that refuses it.' },
      { key: 'llm.coordinates', label: 'Coordinates the model sees', type: 'select', default: 'relative',
        options: [{ value: 'relative', label: 'Relative' }, { value: 'world', label: 'World' }],
        help: 'Relative: tool results give positions as directions from the robot ("2 forward, 1 left") plus world '
          + 'x=/y=/z=. World: world coordinates only. Either way the model can pass relative counts or world x, y, z, '
          + 'and the locate tool translates between them. Applies to MCP clients too.' },
      { key: 'llm.temperature', label: 'Temperature', default: 0.3, min: 0, max: 2, step: 0.05,
        help: 'Ignored automatically by models that don\'t accept it.' },
      { key: 'llm.maxTokens', label: 'Max tokens per reply', default: 4096, min: 64, max: 65536, step: 64,
        help: 'Reasoning models spend tokens thinking before they act, so don\'t set this too low. Anthropic models always get at least 16000.' },
      { key: 'llm.maxSteps', label: 'Max model calls per request', default: 25, min: 1, max: 200, step: 1,
        help: 'A request stops after this many round trips to the model, even if it isn\'t finished.' },
      { key: 'llm.timeout', label: 'Model timeout (seconds)', default: 180, min: 5, max: 1800, step: 5,
        help: 'While streaming, this counts seconds without any new text, not the whole answer.' },
      { key: 'llm.historyChars', label: 'Conversation budget (characters)', default: 16000, min: 2000, max: 400000, step: 1000,
        help: 'Older requests are dropped (and their tool results shortened) to keep the conversation under this size. '
          + 'About 4 characters per token: lower it for models with a small context window.' },
      { key: 'llm.toolResultChars', label: 'Max characters per tool result', default: 3000, min: 200, max: 50000, step: 100 },
      { key: 'llm.instructions', label: 'Extra instructions (every world)', type: 'textarea', default: '',
        help: 'Added to the system prompt in every world. Instructions for one world go on the Dashboard.' },
    ],
  },
  {
    tab: 'automatic',
    group: 'In-game chat',
    help: 'Chat messages that mention the robot\'s name become requests; the ignore word lets you talk about it without calling it.',
    fields: [
      { key: 'chat.enabled', label: 'Take requests from chat', type: 'boolean', default: true },
      { key: 'chat.name', label: 'Wake word', type: 'text', default: 'Ptolemy',
        help: 'A chat message containing this word (any case) goes to the LLM. "Ptolemy, stop" stops it.' },
      { key: 'chat.ignore', label: 'Ignore word', type: 'text', default: 'Ptoless',
        help: 'A message containing this word is never a request, even if it also contains the wake word.' },
      { key: 'chat.replies', label: 'Answer chat requests in chat', type: 'boolean', default: true,
        help: 'What the model says while working on a chat request (its "default replies") goes back to the chat. '
          + 'Requests from the WebUI get their replies in the WebUI.' },
    ],
  },
  {
    tab: 'automatic',
    group: 'Wondering',
    help: 'While wondering, the robot is prompted to "act natural" whenever it has been idle for a while. '
      + 'The Off / On / Always on switch is in the Automatic panel. The robot can change all of these itself when asked in '
      + 'the chat.',
    fields: [
      { key: 'wonder.mode', label: 'Mode', type: 'select', hidden: true, default: 'off',
        options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }, { value: 'always', label: 'Always on' }] },
      { key: 'wonder.interval', label: 'Idle seconds before wondering', default: 15, min: 5, max: 3600, step: 1,
        help: 'Counted from the last thing the robot or its model did (or from switching wondering on), not rolling.' },
      { key: 'wonder.maxSteps', label: 'Max model calls per wander', default: 6, min: 1, max: 50, step: 1 },
      { key: 'wonder.prompt', label: 'Wondering prompt', type: 'textarea', default: DEFAULT_WONDER_PROMPT },
    ],
  },
  {
    tab: 'robot',
    group: 'Walking path costs',
    help: 'What entering a cell costs #pathfind, by what holds the robot up there (the best support wins). '
      + 'Think "how many ground steps would it rather walk than go through this". #flypathfind ignores these.',
    fields: [
      { key: 'cost.ground', label: 'Ground (solid block below)', default: 1 },
      { key: 'cost.water', label: 'Water (the cell itself)', default: 5 },
      { key: 'cost.wall', label: 'Wall (beside, sharing a face)', default: 5 },
      { key: 'cost.groundEdge', label: 'Ground edge (below, sharing an edge)', default: 3 },
      { key: 'cost.wallDiagonal', label: 'Wall edge (level, sharing an edge)', default: 8 },
      { key: 'cost.groundCorner', label: 'Ground corner (below, sharing a corner)', default: 10 },
      { key: 'cost.ceiling', label: 'Ceiling (directly above)', default: 15 },
      { key: 'cost.ceilingEdge', label: 'Ceiling edge (above, sharing an edge)', default: 20 },
      { key: 'cost.ceilingCorner', label: 'Ceiling corner (above, sharing a corner)', default: 20 },
      { key: 'cost.airborne', label: 'Airborne (nothing around)', default: 40 },
    ].map((f) => ({ ...f, min: 1, max: 1000, step: 1, scope: 'world' })),
  },
  {
    tab: 'robot',
    group: 'Scanning',
    fields: [
      { key: 'scan.radius', label: 'Default #scan radius', default: 4, min: 1, max: 15, step: 1, scope: 'world',
        help: 'Used by #scan without a radius and preselected in the Nanny Cam (4 = 9x9x9, 15 = 31x31x31).' },
    ],
  },
  {
    tab: 'robot',
    group: 'Path planning',
    fields: [
      { key: 'path.turnCost', label: 'Cost of a turn', default: 1, min: 0, max: 100, step: 0.5 },
      { key: 'path.unknownPenalty', label: 'Extra cost of an unseen cell', default: 0.5, min: 0, max: 100, step: 0.5,
        help: 'Unseen cells are allowed (the robot rescans before entering them), but cost this much more.' },
      { key: 'path.scanRadius', label: 'Rescan radius for #pathfindwalk', default: 7, min: 1, max: 15, step: 1,
        help: 'How far around the robot to scan when walking into unknown territory (7 = 15x15x15).' },
      { key: 'path.retries', label: 'Retries for #pathfindwalk', default: 3, min: 0, max: 50, step: 1 },
      { key: 'path.finalMultiplier', label: 'Final spot multiplier (approximate go_to)', default: 10, min: 0, max: 1000, step: 1,
        help: 'Where an approximate go_to stops costs this many times the walking cost of standing there: 10 on ground, 50 '
          + 'in water or on a wall, 400 in midair with the default costs. So it would rather stop a little further away, on '
          + 'solid ground, than right next to the target in the air.' },
      { key: 'path.nearSide', label: 'Approximate stop: beside the target', default: 10, min: 0, max: 1000, step: 1 },
      { key: 'path.nearDiagonal', label: 'Approximate stop: diagonal to the target', default: 15, min: 0, max: 1000, step: 1 },
      { key: 'path.nearFar', label: 'Approximate stop: 2 blocks away', default: 20, min: 0, max: 1000, step: 1 },
      { key: 'path.nearHeight', label: 'Approximate stop: per block higher or lower', default: 10, min: 0, max: 1000, step: 1 },
      { key: 'path.safe', label: 'Safe mode (#pathsafe)', type: 'boolean', default: true,
        help: 'If the agent isn\'t where it should be after a step, keep checking for up to 2s before '
          + 'calling it a failure. Costs nothing when steps succeed straight away.' },
    ].map((f) => ({ ...f, scope: 'world' })),
  },
  {
    tab: 'system',
    group: 'Tools and MCP',
    fields: [
      { key: 'tools.allowRaw', label: 'Allow raw commands (run_command)', type: 'boolean', default: true,
        help: 'Lets the LLM and MCP clients run any Minecraft command, not just the robot tools.' },
      { key: 'tools.allowDestructive', label: 'Allow destroy / attack', type: 'boolean', default: true },
      { key: 'mcp.enabled', label: 'MCP server at /mcp', type: 'boolean', default: true,
        help: 'Exposes the same tools to MCP clients (Claude Desktop, LM Studio, ...) over HTTP on this '
          + 'WebUI\'s port, or over stdio with `npm run mcp`.' },
    ],
  },
  {
    tab: 'system',
    group: 'Connection',
    fields: [
      { key: 'bridge.maxInFlight', label: 'Commands in flight (#inflight)', default: 100, min: 1, max: 100, step: 1,
        help: 'Bedrock drops every command beyond 100 outstanding.' },
    ],
  },
];

// Groups on the 'automatic' tab (chat and wondering) aren't a Configuration sub-tab: the WebUI shows
// them on the Robot tab, where they're changed more often.
const TABS = [
  { id: 'llm', label: 'LLM' },
  { id: 'robot', label: 'Robot & paths' },
  { id: 'system', label: 'System' },
];

const FIELDS = new Map(SCHEMA.flatMap((g) => g.fields).map((f) => [f.key, f]));
const WORLD_KEYS = [...FIELDS.values()].filter((f) => f.scope === 'world').map((f) => f.key);

class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = Object.fromEntries([...FIELDS.values()].map((f) => [f.key, f.default]));
    this.world = null; // { id, name, file, values } while a world is loaded
    try {
      this._apply(this.values, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[settings] Ignoring ${FILE}: ${err.message}`);
    }
  }

  get(key) {
    if (this.world && FIELDS.has(key) && FIELDS.get(key).scope === 'world') return this.world.values[key];
    return this.values[key];
  }

  /** Walking-path support costs as { ground, water, ... }. */
  costs() {
    const out = {};
    for (const key of FIELDS.keys()) if (key.startsWith('cost.')) out[key.slice(5)] = this.get(key);
    return out;
  }

  /**
   * Apply a partial update ({ key: value }), clamping to each field's limits. Per-world fields
   * change the current world's copy (or the global value when no world is loaded). Returns what changed.
   */
  update(patch) {
    const globalPatch = {};
    const worldPatch = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (this.world && FIELDS.has(key) && FIELDS.get(key).scope === 'world') worldPatch[key] = value;
      else globalPatch[key] = value;
    }
    const changed = { ...this._apply(this.values, globalPatch) };
    if (this.world) Object.assign(changed, this._apply(this.world.values, worldPatch));
    if (Object.keys(changed).length) {
      this._save();
      this.emit('change', changed);
    }
    return changed;
  }

  reset() {
    return this.update(Object.fromEntries([...FIELDS.values()].map((f) => [f.key, f.default])));
  }

  /**
   * Switch to a world's own copy of the per-world settings (null for none). A world seen for the
   * first time starts from the current global values.
   */
  setWorld(world) {
    const before = Object.fromEntries(WORLD_KEYS.map((k) => [k, this.get(k)]));
    if (!world) {
      this.world = null;
    } else {
      const file = path.join(world.dir, 'settings.json');
      const values = Object.fromEntries(WORLD_KEYS.map((k) => [k, this.values[k]]));
      try {
        this._apply(values, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[settings] Ignoring ${file}: ${err.message}`);
      }
      this.world = { id: world.id, name: world.name, file, values };
      this._save();
    }
    const changed = {};
    for (const k of WORLD_KEYS) if (this.get(k) !== before[k]) changed[k] = this.get(k);
    this.emit('change', changed);
  }

  /** Make the current world's per-world settings the defaults for worlds seen from now on. */
  worldToDefaults() {
    if (!this.world) return;
    Object.assign(this.values, this.world.values);
    this._save();
    this.emit('change', {});
  }

  message() {
    const values = Object.fromEntries([...FIELDS.keys()].map((k) => [k, this.get(k)]));
    const defaults = Object.fromEntries(WORLD_KEYS.map((k) => [k, this.values[k]]));
    return {
      type: 'settings',
      tabs: TABS,
      schema: SCHEMA,
      values,
      world: this.world && { id: this.world.id, name: this.world.name },
      worldDefaults: defaults,
    };
  }

  _apply(target, patch) {
    const changed = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      const field = FIELDS.get(key);
      if (!field || !(key in target) && target !== this.values) continue;
      let value;
      if (field.type === 'boolean') {
        value = raw === true || raw === 'true';
      } else if (field.type === 'select') {
        value = String(raw);
        if (!field.options.some((o) => o.value === value)) continue;
      } else if (field.type === 'text' || field.type === 'textarea') {
        value = String(raw ?? '');
        if (field.type === 'text') value = value.trim();
        value = value.slice(0, field.type === 'textarea' ? 8000 : 500);
      } else {
        value = Number(raw);
        if (!Number.isFinite(value)) continue;
        value = Math.min(field.max, Math.max(field.min, value));
      }
      if (target[key] !== value) {
        target[key] = value;
        changed[key] = value;
      }
    }
    return changed;
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, `${JSON.stringify(this.values, null, 2)}\n`);
      if (this.world) {
        fs.mkdirSync(path.dirname(this.world.file), { recursive: true });
        fs.writeFileSync(this.world.file, `${JSON.stringify(this.world.values, null, 2)}\n`);
      }
    } catch (err) {
      console.warn(`[settings] Couldn't save: ${err.message}`);
    }
  }
}

module.exports = { Settings, SCHEMA, DEFAULT_WONDER_PROMPT };
