'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { setEnvVar } = require('../env');

// The LLM endpoints Ptolemy can talk to, set up in Configuration → LLM. Connection details are
// saved in data/endpoints.json; API keys go to the git-ignored .env file, never to data/ or the browser.

const FILE = path.join(__dirname, '..', '..', 'data', 'endpoints.json');

const PRESETS = {
  lmstudio: {
    label: 'LM Studio', api: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', toolMode: 'auto',
    help: 'Load a model and start the server (Developer tab, or `lms server start`). Models with the 🔨 badge can call tools natively.',
  },
  oobabooga: {
    label: 'text-generation-webui', api: 'openai', baseUrl: 'http://localhost:5000/v1', model: '', toolMode: 'text',
    help: 'Start it with --api and load a model in its UI. The model box can stay empty: it uses whatever is loaded.',
  },
  nvidia: {
    label: 'NVIDIA Build', api: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', toolMode: 'auto',
    envKey: 'NVIDIA_API_KEY', help: 'Hosted models from build.nvidia.com. Needs an nvapi-... key.',
  },
  openai: {
    label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', toolMode: 'native',
    envKey: 'OPENAI_API_KEY', help: 'Needs an API key from platform.openai.com. Refresh to pick a model.',
  },
  anthropic: {
    label: 'Anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5', toolMode: 'native',
    envKey: 'ANTHROPIC_API_KEY', help: 'Claude, through the Anthropic API. Needs an API key from platform.claude.com.',
  },
  custom: {
    label: 'OpenAI-compatible server', api: 'openai', baseUrl: 'http://localhost:11434/v1', model: '', toolMode: 'auto',
    help: 'Anything with /v1/chat/completions: Ollama (port 11434), llama.cpp, vLLM, KoboldCpp...',
  },
};

const BUILTIN = ['lmstudio', 'oobabooga', 'nvidia', 'openai', 'anthropic'];
const TOOL_MODES = ['auto', 'native', 'text'];

class EndpointStore extends EventEmitter {
  constructor() {
    super();
    this.endpoints = BUILTIN.map((preset) => defaults(preset, preset));
    this.activeId = 'lmstudio';
    // Test results for this run of Ptolemy only: id -> { endpoint, model, mcp } of { ok, message, time }.
    this.tests = {};
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (Array.isArray(saved.endpoints) && saved.endpoints.length) {
        this.endpoints = saved.endpoints.filter((e) => PRESETS[e.preset]).map((e) => ({ ...defaults(e.preset, e.id), ...e }));
      }
      if (this.get(saved.active)) this.activeId = saved.active;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[endpoints] Ignoring ${FILE}: ${err.message}`);
    }
  }

  get(id) {
    return this.endpoints.find((e) => e.id === id) || null;
  }

  active() {
    return this.get(this.activeId) || this.endpoints[0];
  }

  setActive(id) {
    if (!this.get(id)) return;
    this.activeId = id;
    this._changed();
  }

  update(id, patch) {
    const e = this.get(id);
    if (!e) return;
    const before = { ...e };
    if (typeof patch.name === 'string' && patch.name.trim()) e.name = patch.name.trim().slice(0, 60);
    if (typeof patch.baseUrl === 'string') e.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '') || PRESETS[e.preset].baseUrl;
    if (typeof patch.model === 'string') e.model = patch.model.trim().slice(0, 200);
    if (TOOL_MODES.includes(patch.toolMode)) e.toolMode = patch.toolMode;
    if (e.baseUrl !== before.baseUrl) this._resetTests(id, ['endpoint', 'model', 'mcp']);
    else if (e.model !== before.model) this._resetTests(id, ['model', 'mcp']);
    this._changed();
  }

  add(preset = 'custom') {
    if (!PRESETS[preset]) return null;
    let n = 2;
    let id = preset;
    while (this.get(id)) id = `${preset}-${n++}`;
    const e = defaults(preset, id);
    if (id !== preset) e.name = `${e.name} ${n - 1}`;
    this.endpoints.push(e);
    this._changed();
    return e;
  }

  remove(id) {
    if (this.endpoints.length <= 1 || !this.get(id)) return;
    this.endpoints = this.endpoints.filter((e) => e.id !== id);
    if (this.activeId === id) this.activeId = this.endpoints[0].id;
    this.setKey(id, '');
    delete this.tests[id];
    this._changed();
  }

  /** Store (or clear, with '') an endpoint's API key in .env. */
  setKey(id, key) {
    try {
      setEnvVar(envName(id), String(key || '').trim());
    } catch (err) {
      console.warn(`[endpoints] Couldn't write the API key to .env: ${err.message}`);
    }
    this._resetTests(id, ['endpoint', 'model', 'mcp']);
    this._changed();
  }

  /** The key to send: the saved one, else the provider's usual environment variable. */
  keyFor(e) {
    return process.env[envName(e.id)] || (PRESETS[e.preset].envKey && process.env[PRESETS[e.preset].envKey]) || '';
  }

  keySource(e) {
    if (process.env[envName(e.id)]) return '.env';
    if (PRESETS[e.preset].envKey && process.env[PRESETS[e.preset].envKey]) return PRESETS[e.preset].envKey;
    return null;
  }

  /** What the client needs to talk to an endpoint. */
  config(id = this.activeId) {
    const e = this.get(id) || this.active();
    return {
      id: e.id,
      api: PRESETS[e.preset].api,
      preset: e.preset,
      label: e.name,
      baseUrl: e.baseUrl,
      apiKey: this.keyFor(e),
      model: e.model,
      toolMode: e.toolMode,
    };
  }

  setTest(id, kind, result) {
    if (!this.tests[id]) this.tests[id] = {};
    this.tests[id][kind] = { ...result, time: Date.now() };
    this.emit('change');
  }

  /** For the browser: everything except the keys themselves. */
  message() {
    return {
      type: 'endpoints',
      active: this.activeId,
      presets: Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { label: p.label, api: p.api, help: p.help }])),
      endpoints: this.endpoints.map((e) => ({
        ...e,
        api: PRESETS[e.preset].api,
        keySource: this.keySource(e),
        keyEnv: envName(e.id),
        tests: this.tests[e.id] || {},
      })),
    };
  }

  _resetTests(id, kinds) {
    if (!this.tests[id]) return;
    for (const k of kinds) delete this.tests[id][k];
  }

  _changed() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, `${JSON.stringify({ active: this.activeId, endpoints: this.endpoints }, null, 2)}\n`);
    } catch (err) {
      console.warn(`[endpoints] Couldn't save ${FILE}: ${err.message}`);
    }
    this.emit('change');
  }
}

function defaults(preset, id) {
  const p = PRESETS[preset];
  return { id, preset, name: p.label, baseUrl: p.baseUrl, model: p.model, toolMode: p.toolMode };
}

function envName(id) {
  return `PTOLEMY_KEY_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

module.exports = { EndpointStore, PRESETS, TOOL_MODES };
