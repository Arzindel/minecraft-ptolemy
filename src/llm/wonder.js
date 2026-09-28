'use strict';

const { EventEmitter } = require('events');
const { chat } = require('./client');
const { resolveModel } = require('./tests');
const { stripThinking } = require('./prompts');

const MODES = ['off', 'on', 'always'];
// The shower thought list is a textarea setting (at most 8000 characters): the oldest lines go first.
const THOUGHT_LIST_CHARS = 7800;

/**
 * Wondering: when the robot has been idle for `wonder.interval` seconds, prompt the LLM to act
 * natural. The countdown starts from the last thing the robot or its model did (a model reply, a
 * tool call, a command from the console) or from switching wondering on; it isn't rolling.
 *
 *   off     never
 *   on      until a person asks for something, then it switches itself off
 *   always  pauses while a person's request runs, then counts down again
 *
 * Right before each wander, its mind may wander too: Forget (every thought wiped for one set text)
 * and ADHD (a random shower thought on top), each on its own chance. Thoughts also fade with time
 * (thoughts.ttl) and beyond a number (thoughts.max), whether or not it's wondering.
 *
 * Events: 'state' (for the WebUI's switch and countdown).
 */
class Wonder extends EventEmitter {
  constructor({ settings, pilot, bridge, worlds, endpoints = null }) {
    super();
    Object.assign(this, { settings, pilot, bridge, worlds, endpoints });
    this.preparing = false; // Forget / ADHD running, just before a wander
    this.timer = setInterval(() => this._tick(), 1000);
    this.timer.unref();
    pilot.on('state', () => this.emit('state', this.state()));
  }

  get mode() {
    return this.settings.get('wonder.mode');
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.settings.update({ 'wonder.mode': mode });
    this.pilot.touch();
    this.emit('state', this.state());
  }

  /** A person asked for something: "on" ends here, "always" just waits for the pilot to be idle again. */
  personRequested() {
    if (this.mode === 'on') this.setMode('off');
  }

  /** Why it isn't counting down right now, or null. */
  blocker() {
    if (!this.bridge.connected) return 'Minecraft isn\'t connected';
    if (this.worlds.agent.exists !== true) return 'there\'s no agent in this world yet';
    if (this.preparing) return 'its mind is wandering';
    if (this.pilot.running) return this.pilot.current && this.pilot.current.source === 'wonder' ? 'wondering now' : 'busy with a request';
    return null;
  }

  state() {
    const blocked = this.mode === 'off' ? null : this.blocker();
    return {
      type: 'wonder',
      mode: this.mode,
      interval: this.settings.get('wonder.interval'),
      nextAt: this.mode !== 'off' && !blocked ? this.pilot.lastActivity + this.settings.get('wonder.interval') * 1000 : null,
      blocked,
    };
  }

  close() {
    clearInterval(this.timer);
  }

  _tick() {
    if (this.worlds.current) this.worlds.current.pruneThoughts();
    if (this.mode === 'off' || this.blocker() || this.pilot.queue.length) return;
    if (Date.now() - this.pilot.lastActivity < this.settings.get('wonder.interval') * 1000) return;
    this.preparing = true;
    this.emit('state', this.state());
    this._mindWanders()
      .catch((err) => this.pilot.info(`Its mind wandered off a cliff: ${err.message}`))
      .finally(() => {
        this.preparing = false;
        // Someone may have asked for something (or switched it off) while the model came up with a thought.
        if (this.mode !== 'off' && !this.blocker() && !this.pilot.queue.length) {
          this.pilot.send(this.settings.get('wonder.prompt'), { source: 'wonder' });
        }
        this.emit('state', this.state());
      });
  }

  /** Forget and ADHD, each on its own chance. Both: the mind is wiped and the shower thought replaces the forget text. */
  async _mindWanders() {
    const memory = this.worlds.current;
    if (!memory) return;
    const forget = roll(this.settings.get('wonder.forgetChance'));
    const adhd = roll(this.settings.get('wonder.adhdChance'));
    if (!forget && !adhd) return;
    const shower = adhd ? await this._showerThought() : null;
    if (forget) {
      memory.clearThoughts();
      const text = shower || this.settings.get('wonder.forgetText') || 'I forgot what I was thinking about';
      memory.addThought(text);
      this.pilot.info(shower ? `Forget and ADHD at once: it forgot everything and now thinks "${text}".`
        : `Forget: it forgot everything it had on its mind ("${text}").`);
    } else if (shower) {
      memory.addThought(shower);
      this.pilot.info(`ADHD: "${shower}" popped into its head.`);
    }
  }

  /** A shower thought from the list (after asking the model for a new one, if that's on). */
  async _showerThought() {
    let lines = splitLines(this.settings.get('wonder.adhdThoughts'));
    if (this.settings.get('wonder.adhdGenerate') && this.endpoints) {
      try {
        const fresh = await generateShowerThought(this.endpoints, this.settings);
        if (fresh && !lines.some((l) => l.toLowerCase() === fresh.toLowerCase())) {
          lines.push(fresh);
          while (lines.length > 1 && lines.join('\n').length > THOUGHT_LIST_CHARS) lines.shift();
          this.settings.update({ 'wonder.adhdThoughts': lines.join('\n') });
        }
      } catch (err) {
        this.pilot.info(`ADHD: couldn't get a new shower thought from the model (${err.message}); picking one from the list.`);
      }
    }
    return lines.length ? lines[Math.floor(Math.random() * lines.length)] : null;
  }
}

/**
 * Ask the model, with nothing but the shower thought prompt (no conversation, no tools), for
 * {"shower_thought": "..."}. Resolves to the thought, or throws.
 */
async function generateShowerThought(endpoints, settings) {
  const config = endpoints.config();
  await resolveModel(config);
  const reply = await chat(config, {
    messages: [{ role: 'user', content: settings.get('wonder.showerPrompt') }],
    tools: null,
    temperature: 1,
    maxTokens: settings.get('llm.maxTokens'),
    timeoutMs: settings.get('llm.timeout') * 1000,
  });
  const thought = parseShowerThought(reply.content);
  if (!thought) throw new Error('the reply had no {"shower_thought": "..."} in it');
  return thought;
}

/** The "shower_thought" of the first JSON object in a reply (thinking left out), or null. */
function parseShowerThought(content) {
  const text = stripThinking(content);
  let value = null;
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const json = JSON.parse(m[0]);
      if (json && typeof json.shower_thought === 'string') {
        value = json.shower_thought;
        break;
      }
    } catch { /* not this one */ }
  }
  if (value === null) {
    const m = /"shower_thought"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (m) {
      try {
        value = JSON.parse(`"${m[1]}"`);
      } catch {
        value = m[1];
      }
    }
  }
  const clean = value && value.replace(/\s+/g, ' ').trim().slice(0, 200);
  return clean || null;
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** True with this chance, in percent. */
function roll(percent) {
  return Math.random() * 100 < (Number(percent) || 0);
}

module.exports = { Wonder, MODES, parseShowerThought, generateShowerThought };
