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

/**
 * One HTTP request to the endpoint. With `onEvent`, the answer is read as a server-sent event
 * stream: onEvent(eventName, data) for each event, and `timeoutMs` counts silence rather than the
 * whole request, so a long answer that keeps arriving never times out.
 */
async function request(config, path, { method = 'GET', body, signal, timeoutMs = 60000, onEvent } = {}) {
  const timer = new AbortController();
  let timedOut = false;
  let idle = null;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      timer.abort();
    }, timeoutMs);
  };
  arm();
  const combined = signal ? anySignal([signal, timer.signal]) : timer.signal;
  const headers = { 'Content-Type': 'application/json' };
  if (config.api === 'anthropic') {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (config.apiKey) headers['x-api-key'] = config.apiKey;
  } else if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (onEvent) headers.Accept = 'text/event-stream';

  const fail = (err) => {
    if (signal && signal.aborted) return new LlmError('stopped');
    if (timedOut) return new LlmError(`no answer from ${config.label} for ${Math.round(timeoutMs / 1000)}s`);
    if (err instanceof LlmError) return err;
    const cause = err.cause && (err.cause.code || err.cause.message);
    return new LlmError(`can't reach ${config.label} at ${config.baseUrl} (${cause || err.message}). Is the server running?`);
  };

  try {
    let res;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method, headers, body: body && JSON.stringify(body), signal: combined,
      });
    } catch (err) {
      throw fail(err);
    }

    const streaming = onEvent && res.ok && /event-stream/i.test(res.headers.get('content-type') || '');
    if (!streaming) {
      const text = await res.text().catch((err) => { throw fail(err); });
      if (!res.ok) throw httpError(config, res.status, text);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new LlmError(`${config.label} sent something that isn't JSON: ${text.slice(0, 200)}`);
      }
      // A server that ignored stream: true still gets its answer used.
      if (onEvent) onEvent('whole', json);
      return json;
    }

    // Server-sent events: "event: name" / "data: {...}" lines, blank line between events.
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    let data = [];
    const flush = () => {
      if (!data.length) return;
      const raw = data.join('\n');
      data = [];
      const name = event;
      event = 'message';
      if (raw === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        return; // keep-alive comments and the like
      }
      if (json && json.error) throw httpError(config, 200, JSON.stringify(json));
      onEvent(name, json);
    };
    try {
      for await (const chunk of res.body) {
        arm();
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line) flush();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          else if (line.startsWith('event:')) event = line.slice(6).trim();
        }
      }
      flush();
    } catch (err) {
      throw fail(err);
    }
    return null;
  } finally {
    clearTimeout(idle);
  }
}

function httpError(config, status, text) {
  let detail = text;
  try {
    const json = JSON.parse(text);
    detail = (json.error && (json.error.message || json.error)) || json.detail || json.message || text;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* not JSON */ }
  const hint = status === 401 || status === 403 ? ' Check the API key.' : '';
  return new LlmError(`${config.label} answered ${status}: ${String(detail).slice(0, 500)}${hint}`, { status, body: text });
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
      else if (opts.onDelta && err.status >= 400 && err.status < 500 && /\bstream/i.test(text) && !known.has('noStream')) learned = 'noStream';
      else if (err.status === 400 && /max_completion_tokens/i.test(text) && !known.has('maxCompletionTokens')) learned = 'maxCompletionTokens';
      if (!learned || attempt > 2) throw err;
      known.add(learned);
      quirks.set(key, known);
    }
  }
}

async function chatOpenAi(config, { messages, tools, temperature, maxTokens, signal, timeoutMs, onDelta }, known) {
  const body = {
    model: config.model || undefined,
    messages: messages.map(({ _anthropic, ...m }) => m),
  };
  if (!known.has('noTemperature') && temperature !== undefined) body.temperature = temperature;
  body[known.has('maxCompletionTokens') ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  const stream = Boolean(onDelta) && !known.has('noStream');
  body.stream = stream;

  let whole = null;
  const out = { content: '', reasoning: '', calls: [], finishReason: null, usage: null };
  const onEvent = (name, json) => {
    if (name === 'whole') {
      whole = json;
      return;
    }
    if (json.usage) out.usage = json.usage;
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
    const d = choice.delta || {};
    const thinking = d.reasoning_content || d.reasoning;
    if (typeof thinking === 'string' && thinking) {
      out.reasoning += thinking;
      onDelta('thinking', thinking);
    }
    if (typeof d.content === 'string' && d.content) {
      out.content += d.content;
      onDelta('text', d.content);
    }
    for (const [i, tc] of (d.tool_calls || []).entries()) {
      const at = tc.index ?? i;
      const call = out.calls[at] || (out.calls[at] = { id: '', name: '', arguments: '' });
      if (tc.id) call.id = tc.id;
      if (tc.function && tc.function.name) call.name = call.name && call.name !== tc.function.name ? call.name + tc.function.name : tc.function.name;
      if (tc.function && typeof tc.function.arguments === 'string') call.arguments += tc.function.arguments;
    }
  };
  const json = await request(config, '/chat/completions', { method: 'POST', body, signal, timeoutMs, onEvent: stream ? onEvent : undefined });
  const full = stream ? whole : json;
  if (full) return fromOpenAiMessage(config, full);
  return {
    content: out.content,
    reasoning: out.reasoning,
    toolCalls: out.calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.arguments })).filter((c) => c.name),
    finishReason: out.finishReason,
    usage: out.usage,
    raw: null,
  };
}

function fromOpenAiMessage(config, json) {
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

async function chatAnthropic(config, { messages, tools, temperature, maxTokens, signal, timeoutMs, onDelta }, known) {
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
  const stream = Boolean(onDelta) && !known.has('noStream');
  if (stream) body.stream = true;

  // Streamed: rebuild the content blocks from their start/delta events.
  let whole = null;
  const blocks = [];
  let stopReason = null;
  let stopDetails = null;
  let usage = null;
  const onEvent = (name, ev) => {
    if (name === 'whole') {
      whole = ev;
      return;
    }
    switch (ev.type) {
      case 'message_start':
        usage = ev.message && ev.message.usage;
        break;
      case 'content_block_start': {
        const b = { ...ev.content_block };
        if (b.type === 'tool_use') b._json = '';
        blocks[ev.index] = b;
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') {
          b.text = (b.text || '') + d.text;
          onDelta('text', d.text);
        } else if (d.type === 'thinking_delta') {
          b.thinking = (b.thinking || '') + d.thinking;
          onDelta('thinking', d.thinking);
        } else if (d.type === 'signature_delta') {
          b.signature = (b.signature || '') + d.signature;
        } else if (d.type === 'input_json_delta') {
          b._json += d.partial_json;
        }
        break;
      }
      case 'message_delta':
        if (ev.delta) {
          stopReason = ev.delta.stop_reason || stopReason;
          stopDetails = ev.delta.stop_details || stopDetails;
        }
        if (ev.usage) usage = { ...usage, ...ev.usage };
        break;
      case 'error':
        throw new LlmError(`${config.label}: ${(ev.error && ev.error.message) || 'stream error'}`);
      default:
        break;
    }
  };

  const json = await request(config, '/messages', { method: 'POST', body, signal, timeoutMs, onEvent: stream ? onEvent : undefined });
  let content;
  if (stream && !whole) {
    content = blocks.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use') return b;
      const { _json, ...rest } = b;
      let input = {};
      try { input = _json ? JSON.parse(_json) : (rest.input || {}); } catch { /* keep {} */ }
      return { ...rest, input };
    });
  } else {
    const full = whole || json;
    content = Array.isArray(full.content) ? full.content : [];
    stopReason = full.stop_reason;
    stopDetails = full.stop_details;
    usage = full.usage;
  }
  if (stopReason === 'refusal') {
    const why = stopDetails && (stopDetails.explanation || stopDetails.category);
    throw new LlmError(`${config.label} declined this request${why ? ` (${why})` : ''}.`);
  }
  return {
    content: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    reasoning: content.filter((b) => b.type === 'thinking').map((b) => b.thinking).filter(Boolean).join('\n'),
    toolCalls: content.filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) })),
    finishReason: stopReason,
    usage,
    raw: content,
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
