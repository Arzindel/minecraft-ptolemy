'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');
const { PROVIDERS, TOOL_MODES } = require('./llm/providers');

/**
 * Everything tunable from the Configuration tab (and some console commands), with defaults,
 * limits and help text. Saved to data/settings.json so it survives restarts.
 */
const SCHEMA = [
  {
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
    ].map((f) => ({ ...f, min: 1, max: 1000, step: 1 })),
  },
  {
    group: 'Scanning',
    fields: [
      { key: 'scan.radius', label: 'Default #scan radius', default: 4, min: 1, max: 15, step: 1,
        help: 'Used by #scan without a radius and preselected in the Nanny Cam (4 = 9x9x9, 15 = 31x31x31).' },
    ],
  },
  {
    group: 'Path planning',
    fields: [
      { key: 'path.turnCost', label: 'Cost of a turn', default: 1, min: 0, max: 100, step: 0.5 },
      { key: 'path.unknownPenalty', label: 'Extra cost of an unseen cell', default: 0.5, min: 0, max: 100, step: 0.5,
        help: 'Unseen cells are allowed (the robot rescans before entering them), but cost this much more.' },
      { key: 'path.scanRadius', label: 'Rescan radius for #pathfindwalk', default: 7, min: 1, max: 15, step: 1,
        help: 'How far around the robot to scan when walking into unknown territory (7 = 15x15x15).' },
      { key: 'path.retries', label: 'Retries for #pathfindwalk', default: 3, min: 0, max: 50, step: 1 },
      { key: 'path.safe', label: 'Safe mode (#pathsafe)', type: 'boolean', default: true,
        help: 'If the agent isn\'t where it should be after a step, keep checking for up to 2s before '
          + 'calling it a failure. Costs nothing when steps succeed straight away.' },
    ],
  },
  {
    group: 'LLM (Automatic tab)',
    help: 'Which language model drives the robot. All three backends speak the OpenAI chat API; '
      + 'only the fields of the selected provider are shown. Leave the model empty to use whatever '
      + 'the server has loaded (LM Studio, text-generation-webui).',
    fields: [
      { key: 'llm.provider', label: 'Provider', type: 'select', default: 'lmstudio',
        options: PROVIDERS.map((p) => ({ value: p.id, label: p.label })) },
      ...PROVIDERS.flatMap((p) => [
        { key: `llm.${p.id}.baseUrl`, label: 'Server URL', type: 'text', default: p.baseUrl,
          showIf: { key: 'llm.provider', value: p.id }, help: p.urlHelp },
        { key: `llm.${p.id}.apiKey`, label: 'API key', type: 'secret', default: '',
          showIf: { key: 'llm.provider', value: p.id }, help: p.keyHelp },
        { key: `llm.${p.id}.model`, label: 'Model', type: 'text', default: p.model, models: true,
          showIf: { key: 'llm.provider', value: p.id }, help: p.modelHelp },
        { key: `llm.${p.id}.toolMode`, label: 'Tool calling', type: 'select', default: p.toolMode,
          options: TOOL_MODES, showIf: { key: 'llm.provider', value: p.id },
          help: 'Native: the API\'s own tool calls. Text: tools are described in the prompt and the model '
            + 'writes <tool_call> blocks (works with any model). Auto: native, falling back to text if the '
            + 'server rejects tools.' },
      ]),
      { key: 'llm.temperature', label: 'Temperature', default: 0.3, min: 0, max: 2, step: 0.05 },
      { key: 'llm.maxTokens', label: 'Max tokens per reply', default: 2048, min: 64, max: 32768, step: 64,
        help: 'Reasoning models spend tokens thinking before they act, so don\'t set this too low.' },
      { key: 'llm.maxSteps', label: 'Max model calls per request', default: 25, min: 1, max: 200, step: 1,
        help: 'A request stops after this many round trips to the model, even if it isn\'t finished.' },
      { key: 'llm.timeout', label: 'Model timeout (seconds)', default: 180, min: 5, max: 1800, step: 5 },
      { key: 'llm.historyChars', label: 'Conversation budget (characters)', default: 16000, min: 2000, max: 400000, step: 1000,
        help: 'Older turns are dropped (and old tool results shortened) to keep the conversation under this size. '
          + 'About 4 characters per token: lower it for models with a small context window.' },
      { key: 'llm.toolResultChars', label: 'Max characters per tool result', default: 3000, min: 200, max: 50000, step: 100 },
      { key: 'llm.instructions', label: 'Extra instructions', type: 'textarea', default: '',
        help: 'Added to the end of the system prompt, e.g. "Always build with Cobblestone from slot 1."' },
    ],
  },
  {
    group: 'In-game chat',
    fields: [
      { key: 'chat.enabled', label: 'Take requests from chat', type: 'boolean', default: true,
        help: 'Chat messages starting with the name below go to the LLM, e.g. "ptolemy, come here". '
          + '"ptolemy stop" stops it.' },
      { key: 'chat.name', label: 'Name to call it by', type: 'text', default: 'ptolemy' },
      { key: 'chat.replies', label: 'Answer in chat', type: 'boolean', default: true,
        help: 'Send the model\'s final answer (and errors) back to chat for requests that came from chat.' },
    ],
  },
  {
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
    group: 'Connection',
    fields: [
      { key: 'bridge.maxInFlight', label: 'Commands in flight (#inflight)', default: 100, min: 1, max: 100, step: 1,
        help: 'Bedrock drops every command beyond 100 outstanding.' },
    ],
  },
];

const FIELDS = new Map(SCHEMA.flatMap((g) => g.fields).map((f) => [f.key, f]));

class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = Object.fromEntries([...FIELDS.values()].map((f) => [f.key, f.default]));
    try {
      this._apply(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[settings] Ignoring ${FILE}: ${err.message}`);
    }
  }

  get(key) {
    return this.values[key];
  }

  /** Walking-path support costs as { ground, water, ... }. */
  costs() {
    const out = {};
    for (const [key, value] of Object.entries(this.values)) if (key.startsWith('cost.')) out[key.slice(5)] = value;
    return out;
  }

  /** Apply a partial update ({ key: value }), clamping to each field's limits. Returns what changed. */
  update(patch) {
    const changed = this._apply(patch);
    if (Object.keys(changed).length) {
      this._save();
      this.emit('change', changed);
    }
    return changed;
  }

  reset() {
    return this.update(Object.fromEntries([...FIELDS.values()].map((f) => [f.key, f.default])));
  }

  /** For the browser: secrets are never sent back, only whether they are set. */
  message() {
    const values = { ...this.values };
    const secretsSet = {};
    for (const field of FIELDS.values()) {
      if (field.type !== 'secret') continue;
      secretsSet[field.key] = Boolean(values[field.key]);
      values[field.key] = '';
    }
    return { type: 'settings', schema: SCHEMA, values, secretsSet };
  }

  _apply(patch) {
    const changed = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      const field = FIELDS.get(key);
      if (!field) continue;
      let value;
      if (field.type === 'boolean') {
        value = raw === true || raw === 'true';
      } else if (field.type === 'select') {
        value = String(raw);
        if (!field.options.some((o) => o.value === value)) continue;
      } else if (field.type === 'text' || field.type === 'secret' || field.type === 'textarea') {
        value = String(raw ?? '');
        if (field.type !== 'textarea') value = value.trim();
        value = value.slice(0, field.type === 'textarea' ? 8000 : 500);
      } else {
        value = Number(raw);
        if (!Number.isFinite(value)) continue;
        value = Math.min(field.max, Math.max(field.min, value));
      }
      if (this.values[key] !== value) {
        this.values[key] = value;
        changed[key] = value;
      }
    }
    return changed;
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, `${JSON.stringify(this.values, null, 2)}\n`);
    } catch (err) {
      console.warn(`[settings] Couldn't save ${FILE}: ${err.message}`);
    }
  }
}

module.exports = { Settings, SCHEMA };
