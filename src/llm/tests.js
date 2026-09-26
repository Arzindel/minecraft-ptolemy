'use strict';

const { chat, listModels, LlmError } = require('./client');
const { stripThinking } = require('./prompts');

// The three buttons next to each endpoint in Configuration → LLM. Each resolves to
// { ok, message } and never throws.

const modelCache = new Map(); // baseUrl -> first model the server listed

/**
 * With no model set, use the first chat model the server lists. text-generation-webui ignores the
 * field (it uses whatever is loaded), so it's left empty there. Mutates and returns `config`.
 */
async function resolveModel(config, { signal, refresh = false } = {}) {
  if (config.model || config.preset === 'oobabooga') return config;
  if (refresh || !modelCache.has(config.baseUrl)) {
    let models;
    try {
      models = await listModels(config, { signal });
    } catch (err) {
      if (err.message === 'stopped') throw err;
      throw new LlmError(`no model is set and the model list couldn't be fetched: ${err.message}`);
    }
    const pick = models.find((m) => !/embed|whisper|tts|dall-e|moderation|image|audio|realtime/i.test(m)) || models[0];
    if (!pick) throw new LlmError(`${config.label} has no models loaded. Load one, or pick a model.`);
    modelCache.set(config.baseUrl, pick);
  }
  config.model = modelCache.get(config.baseUrl);
  config.autoModel = true;
  return config;
}

async function testEndpoint(config) {
  const started = Date.now();
  try {
    const models = await listModels(config);
    return { ok: true, message: `Reachable in ${Date.now() - started} ms, ${models.length} model${models.length === 1 ? '' : 's'} listed.`, models };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function testModel(config) {
  const started = Date.now();
  try {
    await resolveModel(config);
    const reply = await chat(config, {
      messages: [
        { role: 'system', content: 'You are a connection test. Follow the instruction exactly.' },
        { role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok": true, "robot": "ptolemy"}' },
      ],
      temperature: 0,
      maxTokens: 1024,
      timeoutMs: 120000,
    });
    const text = stripThinking(reply.content);
    const json = extractJson(text);
    const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    const who = config.model ? `${config.model}${config.autoModel ? ' (first listed)' : ''}` : 'The loaded model';
    if (json && json.ok === true) return { ok: true, message: `${who} answered with valid JSON in ${took}.` };
    if (!text) return { ok: false, message: `${who} answered with nothing (finish reason: ${reply.finishReason || 'unknown'}). Try more max tokens.` };
    return { ok: false, message: `${who} answered in ${took}, but not with the JSON asked for: "${text.slice(0, 160)}"` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/** Can this endpoint + model make native tool calls, or does it write them out as text? */
async function testTools(config) {
  const tool = {
    name: 'set_lamp',
    description: 'Turn the lamp on or off.',
    parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
  };
  try {
    await resolveModel(config);
    const reply = await chat(config, {
      messages: [
        { role: 'system', content: 'You control a lamp through tools.' },
        { role: 'user', content: 'Turn the lamp on.' },
      ],
      tools: [tool],
      temperature: 0,
      maxTokens: 1024,
      timeoutMs: 120000,
    });
    const call = reply.toolCalls.find((c) => c.name === 'set_lamp');
    if (call) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* checked below */ }
      if (args.on === true) return { ok: true, message: 'Native tool calls work: it called set_lamp(on: true). Tool calling can be Native or Auto.' };
      return { ok: false, message: `It called the tool, but with odd arguments (${call.arguments}). Native calls may be unreliable; try Text mode.` };
    }
    const text = stripThinking(reply.content);
    if (/set_lamp|tool_call|"name"\s*:/i.test(text)) {
      return { ok: false, message: `It wrote the tool call as plain text instead of calling it ("${text.slice(0, 120)}"). Use Text mode for this endpoint.` };
    }
    return { ok: false, message: `It answered without calling the tool ("${text.slice(0, 120)}"). Native tool calls probably won't work; use Text mode.` };
  } catch (err) {
    if (err instanceof LlmError && err.rejectsTools) {
      return { ok: false, message: `The server refuses the tools parameter (${err.message}). Use Text mode for this endpoint.` };
    }
    return { ok: false, message: err.message };
  }
}

function extractJson(text) {
  const candidates = [text, ...(text.match(/```(?:json)?\s*([\s\S]*?)```/g) || []).map((f) => f.replace(/```(?:json)?|```/g, '')),
    (text.match(/\{[\s\S]*\}/) || [''])[0]];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === 'object') return v;
    } catch { /* next */ }
  }
  return null;
}

module.exports = { testEndpoint, testModel, testTools, resolveModel };
