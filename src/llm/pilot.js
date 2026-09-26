'use strict';

const { EventEmitter } = require('events');
const { chat, listModels, LlmError } = require('./client');
const { providerConfig } = require('./providers');
const { systemPrompt, parseTextToolCalls, parseArguments, visibleText, thinkingOf } = require('./prompts');
const { getAgentPose } = require('../agent/pose');

const TRANSCRIPT_LIMIT = 300;
const QUEUE_LIMIT = 5;
const KEEP_RECENT_RESULTS = 6; // tool results in the current turn that are never shortened

/**
 * Automatic mode: takes requests (from the Automatic tab or the in-game chat), and runs the
 * model in a loop, executing its tool calls, until it answers without calling a tool.
 *
 * The conversation is kept in a neutral form and rendered for the API on each call, either with
 * native tool calls or as plain text, so switching tool modes mid-conversation works.
 *
 * Events: 'entry' (transcript entry, new or updated), 'state', 'reply' ({ text, source, sender }).
 */
class Pilot extends EventEmitter {
  constructor({ settings, toolbox, bridge, log }) {
    super();
    Object.assign(this, { settings, toolbox, bridge, log });
    this.turns = []; // [[{ role: 'user', text } | { role: 'assistant', text, calls } | { role: 'results', results }]]
    this.transcript = [];
    this.queue = [];
    this.running = false;
    this.phase = 'idle';
    this.detail = '';
    this.abort = null;
    this.nextId = 1;
    this.fallbackToText = new Set(); // provider+url combinations that rejected native tools
    this.modelCache = new Map();
  }

  state() {
    const config = providerConfig(this.settings);
    return {
      type: 'pilot',
      running: this.running,
      phase: this.phase,
      detail: this.detail,
      queued: this.queue.length,
      provider: config.label,
      model: config.model || this.modelCache.get(config.baseUrl) || '',
      toolMode: this._toolMode(config),
    };
  }

  /** A request from the user. Queued if the pilot is busy. */
  send(text, { source = 'ui', sender = null } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (this.running) {
      if (this.queue.length >= QUEUE_LIMIT) {
        this._entry({ kind: 'error', text: `Too many requests waiting; "${clean}" was dropped.` });
        return;
      }
      this.queue.push({ text: clean, source, sender });
      this._entry({ kind: 'info', text: `Queued until the current request finishes: "${clean}"` });
      this._setPhase(this.phase, this.detail);
      return;
    }
    this._run({ text: clean, source, sender }).catch((err) => {
      this._entry({ kind: 'error', text: `Pilot crashed: ${err.stack || err.message}` });
    });
  }

  /** Stop the current request (and anything queued). */
  stop() {
    this.queue = [];
    if (!this.running) return false;
    this.stopping = true;
    if (this.abort) this.abort.abort();
    this.toolbox.stopRobot();
    this._setPhase('stopping', '');
    return true;
  }

  /** Forget the conversation (the model starts fresh next time). */
  reset() {
    this.stop();
    this.turns = [];
    this.transcript = [];
    this.emit('cleared');
    this._entry({ kind: 'info', text: 'New conversation.' });
  }

  // ---------------------------------------------------------------------------

  async _run(request) {
    this.running = true;
    this.stopping = false;
    this.abort = new AbortController();
    const { signal } = this.abort;
    this._entry({ kind: 'user', text: request.text, source: request.source, sender: request.sender });

    let finalText = '';
    let failed = false;
    try {
      const config = providerConfig(this.settings);
      await this._resolveModel(config, signal);
      const status = await this._statusLine();
      const turn = [{ role: 'user', text: status ? `${request.text}\n\n[${status}]` : request.text }];
      this.turns.push(turn);

      const maxSteps = this.settings.get('llm.maxSteps');
      let step = 0;
      for (; step < maxSteps && !signal.aborted; step++) {
        const textMode = this._toolMode(config) === 'text';
        const tools = this.toolbox.list();
        this._setPhase('thinking', `${config.label}${config.model ? ` · ${config.model}` : ''}`);

        let reply;
        try {
          reply = await chat(config, {
            messages: this._render(config, tools, textMode),
            tools: textMode ? null : tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
            temperature: this.settings.get('llm.temperature'),
            maxTokens: this.settings.get('llm.maxTokens'),
            timeoutMs: this.settings.get('llm.timeout') * 1000,
            signal,
          });
        } catch (err) {
          if (err instanceof LlmError && err.rejectsTools && !textMode && config.toolMode === 'auto') {
            this.fallbackToText.add(this._configKey(config));
            this._entry({ kind: 'info', text: `${config.label} refused native tool calls, so tools are now described in the prompt instead (text mode). ${err.message}` });
            step--;
            continue;
          }
          throw err;
        }

        // Tool calls: native ones, or written into the text (text mode, or a server that didn't parse them).
        const names = tools.map((t) => t.name);
        let calls = reply.toolCalls.map((c) => ({ id: c.id, name: c.name, args: parseArguments(c.arguments) }));
        if (!calls.length) {
          calls = parseTextToolCalls(reply.content, names)
            .map((c, i) => ({ id: `call_${Date.now()}_${i}`, name: c.name, args: c.arguments }));
        }
        const thinking = reply.reasoning || thinkingOf(reply.content);
        const text = visibleText(reply.content);
        if (thinking) this._entry({ kind: 'thinking', text: thinking });
        if (text) this._entry({ kind: 'assistant', text, final: !calls.length });
        turn.push({ role: 'assistant', text, calls });

        if (!calls.length) {
          finalText = text;
          if (!text) this._entry({ kind: 'info', text: `The model finished without saying anything (finish reason: ${reply.finishReason || 'unknown'}).` });
          break;
        }

        const results = [];
        for (const call of calls) {
          if (signal.aborted) break;
          const entry = this._entry({ kind: 'tool', name: call.name, args: call.args, pending: true });
          this._setPhase('tool', call.name);
          const res = await this.toolbox.call(call.name, call.args, { signal, origin: 'LLM' });
          const limit = this.settings.get('llm.toolResultChars');
          const resultText = res.text.length > limit ? `${res.text.slice(0, limit)}\n... (cut to ${limit} characters)` : res.text;
          this._update(entry, { pending: false, ok: res.ok, result: resultText });
          results.push({ id: call.id, name: call.name, text: resultText });
        }
        turn.push({ role: 'results', results });
      }

      if (signal.aborted || this.stopping) {
        this._entry({ kind: 'info', text: 'Stopped.' });
        finalText = '';
      } else if (step >= maxSteps) {
        this._entry({ kind: 'error', text: `Stopped after ${maxSteps} model calls without finishing (Max model calls in the Configuration tab).` });
        finalText = `I gave up after ${maxSteps} steps without finishing.`;
        failed = true;
      }
    } catch (err) {
      failed = true;
      finalText = err.message === 'stopped' ? '' : `Error: ${err.message}`;
      if (finalText) this._entry({ kind: 'error', text: err.message });
      else this._entry({ kind: 'info', text: 'Stopped.' });
    } finally {
      this.running = false;
      this.abort = null;
      this._setPhase('idle', '');
    }

    if (finalText) this.emit('reply', { text: finalText, source: request.source, sender: request.sender, failed });
    const next = this.queue.shift();
    if (next) this.send(next.text, next);
  }

  _toolMode(config) {
    if (config.toolMode === 'auto' && this.fallbackToText.has(this._configKey(config))) return 'text';
    return config.toolMode === 'text' ? 'text' : 'native';
  }

  _configKey(config) {
    return `${config.id}|${config.baseUrl}|${config.model}`;
  }

  /** With no model set, use the first chat model the server lists (text-generation-webui ignores the field). */
  async _resolveModel(config, signal) {
    if (config.model || config.id === 'oobabooga') return;
    if (!this.modelCache.has(config.baseUrl)) {
      let models = [];
      try {
        models = await listModels(config, { signal });
      } catch (err) {
        throw new LlmError(`no model is set and the model list couldn't be fetched: ${err.message}`);
      }
      const pick = models.find((m) => !/embed/i.test(m)) || models[0];
      if (!pick) throw new LlmError(`${config.label} has no models loaded. Load one, or set the model in the Configuration tab.`);
      this.modelCache.set(config.baseUrl, pick);
      this._entry({ kind: 'info', text: `Using ${pick} (the first model ${config.label} lists).` });
    }
    config.model = this.modelCache.get(config.baseUrl);
  }

  /** "Robot at ..., player at ..." so the model rarely needs a get_status call to start. */
  async _statusLine() {
    if (!this.bridge.connected) return 'Minecraft is not connected right now.';
    const parts = [];
    try {
      const pose = await getAgentPose(this.bridge);
      parts.push(`robot at ${pose.x} ${pose.y} ${pose.z} facing ${['south', 'west', 'north', 'east'][pose.facing]}`);
    } catch {
      parts.push('robot position unknown (it may not exist yet; "agent create" makes one)');
    }
    try {
      const res = await this.bridge.sendCommand('querytarget @s', { quiet: true });
      const p = JSON.parse(res.body.details)[0].position;
      parts.push(`player at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    } catch { /* not important */ }
    return `Status: ${parts.join(', ')}`;
  }

  /** The conversation as API messages, trimmed to the configured budget. */
  _render(config, tools, textMode) {
    const system = systemPrompt({
      player: this.bridge.player,
      instructions: this.settings.get('llm.instructions'),
      tools,
      textMode,
    });
    const budget = this.settings.get('llm.historyChars');
    const turns = this._trimmed(budget - system.length);
    const messages = [{ role: 'system', content: system }];
    for (const turn of turns) {
      for (const m of turn) {
        if (m.role === 'user') {
          messages.push({ role: 'user', content: m.text });
        } else if (m.role === 'assistant') {
          if (textMode || !m.calls.length) {
            const blocks = m.calls.map((c) => `<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.args })}\n</tool_call>`);
            messages.push({ role: 'assistant', content: [m.text, ...blocks].filter(Boolean).join('\n') || '(no reply)' });
          } else {
            messages.push({
              role: 'assistant',
              content: m.text || '',
              tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
            });
          }
        } else if (m.role === 'results') {
          if (textMode) {
            messages.push({ role: 'user', content: `Tool results:\n${m.results.map((r) => `[${r.name}]\n${r.text}`).join('\n\n')}` });
          } else {
            for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.text });
          }
        }
      }
    }
    return messages;
  }

  /** Whole turns from the newest back while they fit; within the kept turns, old tool results shrink first. */
  _trimmed(budget) {
    const size = (turn) => turn.reduce((n, m) => n + (m.text ? m.text.length : 0)
      + (m.calls ? JSON.stringify(m.calls).length : 0)
      + (m.results ? m.results.reduce((k, r) => k + r.text.length, 0) : 0), 0);

    // Shorten tool results beyond the most recent few, oldest first, until it fits.
    const shrink = (turns) => {
      const results = turns.flatMap((t) => t.filter((m) => m.role === 'results').flatMap((m) => m.results));
      let total = turns.reduce((n, t) => n + size(t), 0);
      for (const r of results.slice(0, Math.max(0, results.length - KEEP_RECENT_RESULTS))) {
        if (total <= budget) break;
        if (r.text.length <= 120) continue;
        const short = `${r.text.slice(0, 100)}... (older result shortened)`;
        total -= r.text.length - short.length;
        r.shortened = true;
        r.text = short;
      }
      return total;
    };

    const kept = [];
    let total = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const s = size(this.turns[i]);
      if (kept.length && total + s > budget) break;
      kept.unshift(this.turns[i]);
      total += s;
    }
    if (kept.length < this.turns.length) this.turns = this.turns.slice(this.turns.length - kept.length);
    shrink(kept);
    return kept;
  }

  _setPhase(phase, detail) {
    this.phase = phase;
    this.detail = detail;
    this.emit('state', this.state());
  }

  _entry(fields) {
    const entry = { id: this.nextId++, time: Date.now(), ...fields };
    this.transcript.push(entry);
    if (this.transcript.length > TRANSCRIPT_LIMIT) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_LIMIT);
    this.emit('entry', entry);
    return entry;
  }

  _update(entry, fields) {
    Object.assign(entry, fields);
    this.emit('entry', entry);
  }
}

module.exports = { Pilot };
