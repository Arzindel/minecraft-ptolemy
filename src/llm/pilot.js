'use strict';

const { EventEmitter } = require('events');
const { chat, LlmError } = require('./client');
const { resolveModel } = require('./tests');
const { systemPrompt, contextBlock, parseTextToolCalls, parseArguments, visibleText, thinkingOf } = require('./prompts');
const { getAgentPose } = require('../agent/pose');
const { Frame } = require('../agent/frame');
const { allPlayers } = require('../agent/players');

const TRANSCRIPT_LIMIT = 300;
const QUEUE_LIMIT = 5;
const STREAM_FLUSH_MS = 120;
// Flying and teleporting are only allowed when the request itself asks for them.
const FLIGHT_WORDS = /\b(fly|flies|flying|flew|flight|teleport\w*|tp)\b/i; // how often streamed text is pushed to the WebUI
// Tools whose result is a snapshot: once a newer one exists, the older ones are left out of the prompt.
const SNAPSHOT_TOOLS = new Set(['get_status', 'scan', 'get_memory', 'todo_write']);

/**
 * Automatic mode: takes requests (from the WebUI, the in-game chat, or the wondering timer) and
 * runs the model in a loop, executing its tool calls, until it answers without calling a tool.
 *
 * The conversation is kept in a neutral form and rendered for the API on each call, either with
 * native tool calls or as plain text, so switching tool modes (or endpoints) mid-conversation works.
 * It is saved per world, next to the world's memory.
 *
 * Events:
 *   'entry'   a transcript entry, new or updated
 *   'state'   running / phase changed
 *   'say'     ({ text, source, sender, error }) something the model said: its "default replies",
 *             which the server routes back to where the request came from
 *   'cleared' the conversation was reset
 */
class Pilot extends EventEmitter {
  constructor({ settings, endpoints, toolbox, bridge, worlds }) {
    super();
    Object.assign(this, { settings, endpoints, toolbox, bridge, worlds });
    this.turns = []; // [[{ role: 'user', text } | { role: 'assistant', text, calls, raw, api } | { role: 'results', results }]]
    this.transcript = [];
    this.queue = [];
    this.running = false;
    this.current = null; // the request being worked on
    this.phase = 'idle';
    this.detail = '';
    this.abort = null;
    this.nextId = 1;
    this.fallbackToText = new Set(); // endpoint+model combinations that rejected native tools
    this.lastActivity = Date.now();
  }

  state() {
    const config = this.endpoints.config();
    return {
      type: 'pilot',
      running: this.running,
      source: this.current && this.current.source,
      phase: this.phase,
      detail: this.detail,
      queued: this.queue.length,
      endpoint: config.label,
      model: config.model,
      toolMode: this._toolMode(config),
    };
  }

  /**
   * A request. From a person (source 'ui' or 'chat') it pre-empts wondering; otherwise it's
   * queued while the pilot is busy.
   */
  send(text, { source = 'ui', sender = null } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const request = { text: clean, source, sender };
    if (this.running) {
      if (source !== 'wonder' && this.current && this.current.source === 'wonder') {
        // A person wants something: drop the daydream and get to it.
        this.queue.unshift(request);
        this._interrupt();
        return;
      }
      if (source === 'wonder') return;
      if (this.queue.length >= QUEUE_LIMIT) {
        this._entry({ kind: 'error', text: `Too many requests waiting; "${clean}" was dropped.` });
        return;
      }
      this.queue.push(request);
      this._entry({ kind: 'info', text: `Queued until the current request finishes: "${clean}"` });
      this._setPhase(this.phase, this.detail);
      return;
    }
    this._run(request).catch((err) => {
      this._entry({ kind: 'error', text: `Pilot crashed: ${err.stack || err.message}` });
    });
  }

  /** Stop the current request (and anything queued). */
  stop() {
    this.queue = [];
    if (!this.running) return false;
    this._interrupt();
    return true;
  }

  /** Forget the conversation (the model starts fresh next time). */
  reset() {
    this.stop();
    this.turns = [];
    this.transcript = [];
    this.emit('cleared');
    this._entry({ kind: 'info', text: 'New conversation.' });
    this._save();
  }

  /** A message from the model to the WebUI (the send_webui tool). */
  notice(text) {
    this._entry({ kind: 'notice', text });
  }

  /** Something happened that counts as activity (for the wondering timer). */
  touch() {
    this.lastActivity = Date.now();
  }

  /** Load the conversation saved for the world that just opened (after saving the old one). */
  switchWorld(previous, memory) {
    if (previous) this._save(previous);
    this.stop();
    const saved = memory && memory.loadConversation();
    this.turns = (saved && saved.turns) || [];
    this.transcript = (saved && saved.transcript) || [];
    this.nextId = Math.max(this.nextId, ...this.transcript.map((e) => e.id + 1));
    this.emit('cleared');
    if (memory) this._entry({ kind: 'info', text: `World: ${memory.name}.` });
  }

  // ---------------------------------------------------------------------------

  _interrupt() {
    this.stopping = true;
    if (this.abort) this.abort.abort();
    this.toolbox.stopRobot();
    this._setPhase('stopping', '');
  }

  async _run(request) {
    this.running = true;
    this.current = request;
    this.stopping = false;
    this.abort = new AbortController();
    const { signal } = this.abort;
    const wondering = request.source === 'wonder';
    const flight = !wondering && FLIGHT_WORDS.test(request.text);
    // Who "me" is: the chat sender, the person at the WebUI (the connected player), nobody while wondering.
    const requester = wondering ? null : request.sender || this.bridge.player || null;
    this._entry({ kind: 'user', text: request.text, source: request.source, sender: request.sender });
    const say = (text, error = false) => this.emit('say', { text, source: request.source, sender: request.sender, error });

    let finalText = '';
    try {
      const config = this.endpoints.config();
      await resolveModel(config, { signal });
      const turn = [{ role: 'user', text: request.text }];
      this.turns.push(turn);

      const maxSteps = this.settings.get(wondering ? 'wonder.maxSteps' : 'llm.maxSteps');
      let step = 0;
      for (; step < maxSteps && !signal.aborted; step++) {
        const textMode = this._toolMode(config) === 'text';
        const tools = this.toolbox.list({ flight });
        this._setPhase('thinking', `${config.label}${config.model ? ` · ${config.model}` : ''}`);

        // Fresh state for this call only: it rides on the newest message and is dropped from older ones.
        turn[turn.length - 1].context = await this._context(request.source, flight, requester);
        const live = this._liveEntries(request.source);

        let reply;
        try {
          reply = await chat(config, {
            messages: this._render(config, tools, textMode),
            tools: textMode ? null : tools,
            temperature: this.settings.get('llm.temperature'),
            maxTokens: this.settings.get('llm.maxTokens'),
            timeoutMs: this.settings.get('llm.timeout') * 1000,
            signal,
            onDelta: this.settings.get('llm.stream') ? live.onDelta : undefined,
          });
        } catch (err) {
          live.discard();
          if (err instanceof LlmError && err.rejectsTools && !textMode && config.toolMode === 'auto') {
            this.fallbackToText.add(this._configKey(config));
            this._entry({ kind: 'info', text: `${config.label} refused native tool calls, so tools are now described in the prompt instead (text mode). ${err.message}` });
            step--;
            continue;
          }
          throw err;
        }
        this.touch();

        // Tool calls: native ones, or written into the text (text mode, or a server that didn't parse them).
        const names = tools.map((t) => t.name);
        let calls = reply.toolCalls.map((c) => ({ id: c.id, name: c.name, args: parseArguments(c.arguments) }));
        if (!calls.length) {
          calls = parseTextToolCalls(reply.content, names)
            .map((c, i) => ({ id: `call_${Date.now()}_${i}`, name: c.name, args: c.arguments }));
        }
        const thinking = reply.reasoning || thinkingOf(reply.content);
        const text = visibleText(reply.content);
        live.finish(thinking, text, !calls.length);
        if (text) say(text);
        turn.push({ role: 'assistant', text, calls, raw: reply.raw, api: config.api });

        if (!calls.length) {
          finalText = text;
          if (!text) this._entry({ kind: 'info', text: `The model finished without saying anything (finish reason: ${reply.finishReason || 'unknown'}).` });
          break;
        }

        const results = [];
        for (const call of calls) {
          if (signal.aborted) {
            results.push({ id: call.id, name: call.name, text: 'Not run: the request was stopped.' });
            continue;
          }
          const entry = this._entry({ kind: 'tool', name: call.name, args: call.args, pending: true });
          this._setPhase('tool', call.name);
          const res = await this.toolbox.call(call.name, call.args, {
            signal, flight, player: requester, origin: wondering ? 'LLM (wondering)' : 'LLM',
          });
          this.touch();
          const limit = this.settings.get('llm.toolResultChars');
          const resultText = res.text.length > limit ? `${res.text.slice(0, limit)}\n... (cut to ${limit} characters)` : res.text;
          this._update(entry, { pending: false, ok: res.ok, result: resultText });
          results.push({ id: call.id, name: call.name, text: resultText });
        }
        turn.push({ role: 'results', results });
      }

      if (signal.aborted || this.stopping) {
        this._entry({ kind: 'info', text: wondering && this.queue.length ? 'Stopped wondering: someone asked for something.' : 'Stopped.' });
        finalText = '(stopped)';
      } else if (step >= maxSteps) {
        const msg = wondering ? `Done wondering after ${maxSteps} model calls.` : `I gave up after ${maxSteps} steps without finishing.`;
        this._entry({ kind: wondering ? 'info' : 'error', text: wondering ? msg : `Stopped after ${maxSteps} model calls without finishing (Max model calls in Configuration → LLM).` });
        if (!wondering) say(msg, true);
        finalText = msg;
      }
    } catch (err) {
      if (err.message === 'stopped' || signal.aborted) {
        this._entry({ kind: 'info', text: 'Stopped.' });
        finalText = '(stopped)';
      } else {
        this._entry({ kind: 'error', text: err.message });
        say(`Error: ${err.message}`, true);
        finalText = `Error: ${err.message}`;
      }
    } finally {
      this.running = false;
      this.current = null;
      this.abort = null;
      this.touch();
      this._setPhase('idle', '');
    }

    const memory = this.worlds.current;
    if (memory && !(wondering && finalText === '(stopped)')) {
      memory.addJournal({ source: request.source, request: wondering ? '' : request.text, result: finalText || '(no answer)' });
    }
    this._save();
    this.emit('finished', request);
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

  /** The [Now] block: where the request came from, where things are (in the model's frame), and the memory. */
  async _context(source, flight, requester) {
    const memory = this.worlds.current;
    const inArea = (x, y, z) => {
      const where = memory && memory.describeAreasAt(x, y, z);
      return where ? ` (in ${where})` : '';
    };
    let frame = null;
    const parts = [];
    if (!this.bridge.connected) {
      parts.push('Minecraft is not connected right now.');
    } else {
      try {
        const pose = await getAgentPose(this.bridge);
        frame = new Frame(pose, this.settings.get('llm.coordinates'));
        parts.push(`Robot: ${frame.here()}${inArea(pose.x, pose.y, pose.z)}.`);
      } catch {
        parts.push('Robot: position unknown (there may be no agent in this world yet; run_command "agent create" makes one).');
      }
      try {
        const everyone = await allPlayers(this.bridge);
        for (const p of everyone) {
          const tags = [p.name === requester ? 'asked you' : '', p.name === this.bridge.player ? 'at the Ptolemy PC' : '']
            .filter(Boolean).join(', ');
          parts.push(`Player ${p.name}${tags ? ` (${tags})` : ''}: ${frame ? frame.fmt(p.x, p.y, p.z) : Frame.world(p.x, p.y, p.z)}`
            + `${inArea(p.x, p.y, p.z) || inArea(p.x, p.y - 1, p.z)}.`);
        }
        if (everyone.length > 1) {
          parts.push(requester
            ? `"Me", "here" and "the player" mean ${requester}. go_to and teleport_to_player go to ${requester} unless you name another player.`
            : 'Nobody in particular asked (wondering). Name a player in go_to to go to one.');
        }
      } catch { /* not important */ }
    }
    parts.push(flight
      ? 'Flying and teleporting: allowed for this request (the player asked for it).'
      : 'Flying and teleporting: NOT allowed for this request. Walk; if you can\'t get there on foot, say so.');
    return contextBlock({ source, status: parts.join('\n'), memory: memory && memory.promptBlock(frame) });
  }

  /**
   * Transcript entries for one model call. With streaming, the thinking and the answer appear
   * and grow as they arrive (pushed to the WebUI every STREAM_FLUSH_MS); otherwise they're added
   * when the call returns.
   */
  _liveEntries(source) {
    let rawText = '';
    let rawThinking = '';
    let thinkingEntry = null;
    let textEntry = null;
    let timer = null;
    const flush = () => {
      timer = null;
      const thinking = rawThinking || thinkingOf(rawText);
      const text = visibleText(rawText);
      if (thinking) {
        if (!thinkingEntry) thinkingEntry = this._entry({ kind: 'thinking', text: thinking, streaming: true });
        else this._update(thinkingEntry, { text: thinking });
      }
      if (text) {
        if (!textEntry) textEntry = this._entry({ kind: 'assistant', text, source, streaming: true });
        else this._update(textEntry, { text });
      }
    };
    const drop = (entry) => {
      if (!entry) return;
      this.transcript = this.transcript.filter((e) => e !== entry);
      this._update(entry, { removed: true });
    };
    return {
      onDelta: (kind, piece) => {
        if (kind === 'thinking') rawThinking += piece;
        else rawText += piece;
        if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS);
      },
      finish: (thinking, text, final) => {
        clearTimeout(timer);
        if (thinking) {
          if (thinkingEntry) this._update(thinkingEntry, { text: thinking, streaming: false });
          else this._entry({ kind: 'thinking', text: thinking });
        } else drop(thinkingEntry);
        if (text) {
          if (textEntry) this._update(textEntry, { text, final, streaming: false });
          else this._entry({ kind: 'assistant', text, final, source });
        } else drop(textEntry);
      },
      discard: () => {
        clearTimeout(timer);
        if (thinkingEntry) this._update(thinkingEntry, { streaming: false });
        drop(textEntry);
      },
    };
  }

  /** The conversation as API messages, trimmed to the configured budget. */
  _render(config, tools, textMode) {
    const system = systemPrompt({
      name: this.settings.get('chat.name') || 'Ptolemy',
      player: this.bridge.player,
      instructions: this.settings.get('llm.instructions'),
      tools,
      textMode,
    });
    const budget = this.settings.get('llm.historyChars');
    const turns = this._trimmed(budget - system.length);
    const messages = [{ role: 'system', content: system }];
    const anthropic = config.api === 'anthropic';

    // Snapshots (scans, status, memory, the todo list) go stale: only the newest of each kind is sent.
    const newest = new Map();
    for (const turn of turns) {
      for (const m of turn) if (m.role === 'results') for (const r of m.results) if (SNAPSHOT_TOOLS.has(r.name)) newest.set(r.name, r);
    }
    const lastMessage = turns.length ? turns[turns.length - 1][turns[turns.length - 1].length - 1] : null;

    turns.forEach((turn, ti) => {
      const latest = ti === turns.length - 1;
      // Anthropic checks that the history before its thinking blocks is unchanged within a tool loop,
      // so the request in progress is sent exactly as it was (old [Now] blocks and snapshots included).
      const frozen = anthropic && latest;
      const withContext = (m, content) => (m.context && (m === lastMessage || frozen) ? `${content}\n\n${m.context}` : content);
      const resultText = (r) => (SNAPSHOT_TOOLS.has(r.name) && newest.get(r.name) !== r && !frozen
        ? `(Older ${r.name} result left out: a newer one follows.)` : r.text);
      for (const m of turn) {
        if (m.role === 'user') {
          messages.push({ role: 'user', content: withContext(m, m.text) });
        } else if (m.role === 'assistant') {
          if (textMode || !m.calls.length) {
            const blocks = m.calls.map((c) => `<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.args })}\n</tool_call>`);
            messages.push({ role: 'assistant', content: [m.text, ...blocks].filter(Boolean).join('\n') || '(no reply)' });
          } else {
            const msg = {
              role: 'assistant',
              content: m.text || '',
              tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
            };
            // Anthropic wants its own blocks (thinking included) back unchanged within a tool loop;
            // older turns go without, which it allows.
            if (latest && m.raw && m.api === config.api) msg._anthropic = m.raw;
            messages.push(msg);
          }
        } else if (m.role === 'results') {
          if (textMode) {
            messages.push({ role: 'user', content: withContext(m, `Tool results:\n${m.results.map((r) => `[${r.name}]\n${resultText(r)}`).join('\n\n')}`) });
          } else {
            m.results.forEach((r, i) => messages.push({
              role: 'tool',
              tool_call_id: r.id,
              content: i === m.results.length - 1 ? withContext(m, resultText(r)) : resultText(r),
            }));
          }
        }
      }
    });
    return messages;
  }

  /**
   * Whole requests from the newest back while they fit. Tool results of older requests are
   * shortened first; the request being worked on is never edited.
   */
  _trimmed(budget) {
    const size = (turn) => turn.reduce((n, m) => n + (m.text ? m.text.length : 0)
      + (m.calls ? JSON.stringify(m.calls).length : 0)
      + (m.results ? m.results.reduce((k, r) => k + r.text.length, 0) : 0), 0);

    for (const turn of this.turns.slice(0, -1)) {
      for (const m of turn) {
        if (m.role !== 'results') continue;
        for (const r of m.results) {
          if (r.text.length > 160) r.text = `${r.text.slice(0, 140)}... (older result shortened)`;
        }
      }
    }

    const kept = [];
    let total = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const s = size(this.turns[i]);
      if (kept.length && total + s > budget) break;
      kept.unshift(this.turns[i]);
      total += s;
    }
    if (kept.length < this.turns.length) this.turns = this.turns.slice(this.turns.length - kept.length);
    return kept;
  }

  _save(memory = this.worlds.current) {
    if (!memory) return;
    // Anthropic's raw blocks are only needed within a request; don't keep them on disk.
    const turns = this.turns.map((t) => t.map(({ raw, context, ...m }) => m));
    memory.saveConversation({ turns, transcript: this.transcript.slice(-TRANSCRIPT_LIMIT) });
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
