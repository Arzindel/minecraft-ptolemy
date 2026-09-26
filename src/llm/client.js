'use strict';

// A small chat client on Node's built-in fetch (no SDKs, in keeping with Ptolemy's
// one-dependency rule). Two wire formats:
//   - 'openai': /chat/completions, spoken by LM Studio, text-generation-webui, NVIDIA Build,
//     OpenAI, Ollama, llama.cpp, vLLM...
//   - 'anthropic': Anthropic's Messages API (/v1/messages).
// Callers always use the OpenAI message shape; Anthropic requests are converted here.

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MIN_TOKENS = 16000; // thinking models spend tokens before answering

class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }

  /** True when the server seems to have refused the `tools` parameter itself. */
  get rejectsTools() {
    return (this.status === 400 || this.status === 422 || this.status === 500)
      && /\btools?\b|function/i.test(`${this.message} ${this.body || ''}`);
  }
}

// Parameters a server refused once (e.g. temperature on models that don't take it), per endpoint.
const quirks = new Map();

async function request(config, path, { method = 'GET', body, signal, timeoutMs = 60000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? anySignal([signal, timeout]) : timeout;
  const headers = { 'Content-Type': 'application/json' };
  if (config.api === 'anthropic') {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (config.apiKey) headers['x-api-key'] = config.apiKey;
  } else if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  let res;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method, headers, body: body && JSON.stringify(body), signal: combined,
    });
  } catch (err) {
    if (signal && signal.aborted) throw new LlmError('stopped');
    if (timeout.aborted) throw new LlmError(`no answer from ${config.label} after ${Math.round(timeoutMs / 1000)}s`);
    const cause = err.cause && (err.cause.code || err.cause.message);
    throw new LlmError(`can't reach ${config.label} at ${config.baseUrl} (${cause || err.message}). Is the server running?`);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const json = JSON.parse(text);
      detail = (json.error && (json.error.message || json.error)) || json.detail || json.message || text;
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch { /* not JSON */ }
    const hint = res.status === 401 || res.status === 403 ? ' Check the API key.' : '';
    throw new LlmError(`${config.label} answered ${res.status}: ${String(detail).slice(0, 500)}${hint}`,
      { status: res.status, body: text });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError(`${config.label} sent something that isn't JSON: ${text.slice(0, 200)}`);
  }
}

/** Model ids the server offers. */
async function listModels(config, { signal } = {}) {
  const json = await request(config, config.api === 'anthropic' ? '/models?limit=100' : '/models', { signal, timeoutMs: 15000 });
  const data = Array.isArray(json) ? json : json.data || json.models || [];
  return data.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

/**
 * One chat completion.
 * @param {object} config  { api, label, baseUrl, apiKey, model }
 * @param {object} opts    messages (OpenAI shape), tools ([{ name, description, parameters }] or null), ...
 * @returns {{ content, reasoning, toolCalls: [{ id, name, arguments }], finishReason, usage, raw }}
 *   `arguments` is the raw JSON string; `raw` is the provider's own assistant content (Anthropic
 *   blocks), to replay unchanged in the next request.
 */
async function chat(config, opts) {
  const key = `${config.api}|${config.baseUrl}|${config.model}`;
  const known = quirks.get(key) || new Set();
  for (let attempt = 0; ; attempt++) {
    try {
      return config.api === 'anthropic' ? await chatAnthropic(config, opts, known) : await chatOpenAi(config, opts, known);
    } catch (err) {
      // Some models refuse sampling parameters or want max_completion_tokens (newer OpenAI
      // models). Drop what was refused, remember it for this endpoint, and try again.
      const text = `${err.message} ${err.body || ''}`;
      let learned = null;
      if (err.status === 400 && /temperature/i.test(text) && !known.has('noTemperature')) learned = 'noTemperature';
      else if (err.status === 400 && /max_completion_tokens/i.test(text) && !known.has('maxCompletionTokens')) learned = 'maxCompletionTokens';
      if (!learned || attempt > 2) throw err;
      known.add(learned);
      quirks.set(key, known);
    }
  }
}

async function chatOpenAi(config, { messages, tools, temperature, maxTokens, signal, timeoutMs }, known) {
  const body = {
    model: config.model || undefined,
    messages: messages.map(({ _anthropic, ...m }) => m),
    stream: false,
  };
  if (!known.has('noTemperature') && temperature !== undefined) body.temperature = temperature;
  body[known.has('maxCompletionTokens') ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  const json = await request(config, '/chat/completions', { method: 'POST', body, signal, timeoutMs });
  const choice = json.choices && json.choices[0];
  if (!choice) throw new LlmError(`${config.label} returned no choices: ${JSON.stringify(json).slice(0, 300)}`);
  const message = choice.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: message.reasoning_content || message.reasoning || '',
    toolCalls: (message.tool_calls || []).map((call, i) => ({
      id: call.id || `call_${Date.now()}_${i}`,
      name: call.function && call.function.name,
      arguments: call.function && call.function.arguments,
    })).filter((c) => c.name),
    finishReason: choice.finish_reason,
    usage: json.usage,
    raw: null,
  };
}

async function chatAnthropic(config, { messages, tools, temperature, maxTokens, signal, timeoutMs }, known) {
  if (!config.model) throw new LlmError(`${config.label} needs a model: pick one in the LLM settings.`);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const body = {
    model: config.model,
    max_tokens: Math.max(maxTokens || 0, ANTHROPIC_MIN_TOKENS),
    messages: toAnthropicMessages(messages.filter((m) => m.role !== 'system')),
  };
  if (system) body.system = system;
  if (!known.has('noTemperature') && temperature !== undefined) body.temperature = temperature;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    body.tool_choice = { type: 'auto' };
  }
  const json = await request(config, '/messages', { method: 'POST', body, signal, timeoutMs });
  const blocks = Array.isArray(json.content) ? json.content : [];
  if (json.stop_reason === 'refusal') {
    const why = json.stop_details && (json.stop_details.explanation || json.stop_details.category);
    throw new LlmError(`${config.label} declined this request${why ? ` (${why})` : ''}.`);
  }
  return {
    content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    reasoning: blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).filter(Boolean).join('\n'),
    toolCalls: blocks.filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) })),
    finishReason: json.stop_reason,
    usage: json.usage,
    raw: blocks,
  };
}

/** OpenAI-shaped history to Anthropic messages: tool calls become tool_use blocks, results tool_result blocks. */
function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m._anthropic) {
        push('assistant', m._anthropic);
        continue;
      }
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { /* keep {} */ }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '(no reply)' });
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content) }]);
    } else {
      push('user', [{ type: 'text', text: String(m.content) }]);
    }
  }
  return out;
}

/** AbortSignal.any, which only arrived in Node 20. */
function anySignal(signals) {
  if (AbortSignal.any) return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

module.exports = { chat, listModels, LlmError };
