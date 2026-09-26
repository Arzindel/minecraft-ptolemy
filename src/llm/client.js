'use strict';

// A minimal OpenAI-compatible chat client on Node's built-in fetch (Node 18+), so no SDK needed.

class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }

  /** True when the server seems to have refused the `tools` parameter itself. */
  get rejectsTools() {
    return (this.status === 400 || this.status === 422 || this.status === 500)
      && /tool|function/i.test(`${this.message} ${this.body || ''}`);
  }
}

async function request(config, path, { method = 'GET', body, signal, timeoutMs = 60000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? anySignal([signal, timeout]) : timeout;
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

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

/** Model ids the server offers (GET /models). */
async function listModels(config, { signal } = {}) {
  const json = await request(config, '/models', { signal, timeoutMs: 15000 });
  const data = Array.isArray(json) ? json : json.data || json.models || [];
  return data.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

/**
 * One chat completion. Returns { content, reasoning, toolCalls: [{ id, name, arguments }], finishReason, usage }.
 * `arguments` is left as the raw string the model produced; the caller parses it.
 */
async function chat(config, { messages, tools, temperature, maxTokens, signal, timeoutMs }) {
  const body = { model: config.model || undefined, messages, temperature, max_tokens: maxTokens, stream: false };
  if (tools && tools.length) {
    body.tools = tools;
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
  };
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
