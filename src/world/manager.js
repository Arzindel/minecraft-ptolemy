'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WorldMemory } = require('./memory');

const WORLDS_DIR = path.join(__dirname, '..', '..', 'data', 'worlds');
// Bedrock can't tell us which world it has open, so Ptolemy marks each world itself: a dummy
// scoreboard objective named ptolemy_<id>. It's saved with the world, invisible unless someone
// displays it, and read back with `scoreboard objectives list` whenever the game connects.
const MARKER_PREFIX = 'ptolemy_';
const MARKER_RE = /\bptolemy_([0-9a-f]{8})\b/i;
const UNMARKED_ID = 'unmarked';

/**
 * Knows which world the game has open and keeps its memory (data/worlds/<id>/).
 * Events: 'world' (the current world changed or was renamed), 'memory' (its contents changed),
 * 'status' (detection / agent state changed).
 */
class WorldManager extends EventEmitter {
  /** @param {{ bridge, log, thoughtRules?: () => { ttl: number, max: number } }} deps */
  constructor({ bridge, log, thoughtRules = null }) {
    super();
    Object.assign(this, { bridge, log, thoughtRules });
    this.current = null; // WorldMemory
    this.detection = { state: 'waiting', message: 'Waiting for Minecraft to connect.' };
    this.agent = { exists: null }; // null = unknown
    this._detecting = null;
  }

  /** Every world Ptolemy has seen, newest first. */
  list() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(WORLDS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { /* none yet */ }
    return dirs.map((id) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(WORLDS_DIR, id, 'memory.json'), 'utf8'));
        return { id, name: data.name, lastSeenAt: data.lastSeenAt, areas: (data.areas || []).length };
      } catch {
        return null;
      }
    }).filter(Boolean).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** Work out which world is open. Safe to call repeatedly; concurrent calls share one run. */
  detect() {
    if (!this._detecting) {
      this._detecting = this._detect().finally(() => { this._detecting = null; });
    }
    return this._detecting;
  }

  async _detect() {
    if (!this.bridge.connected) return;
    this._setDetection('detecting', 'Looking for this world\'s marker...');
    let id = await this._readMarker();
    let created = false;
    if (!id) {
      // No marker yet (or the list couldn't be read, e.g. an empty scoreboard answering with an
      // error): add one and check that it reads back.
      const fresh = crypto.randomBytes(4).toString('hex');
      const res = await this.bridge.sendCommand(`scoreboard objectives add ${MARKER_PREFIX}${fresh} dummy "Ptolemy"`, { quiet: true });
      if (res.ok && (await this._readMarker()) === fresh) {
        id = fresh;
        created = true;
      } else {
        if (res.ok) await this.bridge.sendCommand(`scoreboard objectives remove ${MARKER_PREFIX}${fresh}`, { quiet: true });
        // Can't use the scoreboard (cheats off?): all such worlds share one memory.
        this._open(UNMARKED_ID, { name: 'Unmarked world' });
        this._setDetection('unmarked', `Couldn't mark this world, so it can't be told apart from other unmarked worlds `
          + `(the game said: "${res.statusMessage}"). Are cheats on?`);
        await this.checkAgent();
        return;
      }
    }
    const isNew = !fs.existsSync(path.join(WORLDS_DIR, id, 'memory.json'));
    this._open(id, { name: `World ${id.slice(0, 4)} (${new Date().toLocaleDateString()})` });
    this._setDetection('ok', created
      ? 'New world: marked it so Ptolemy recognises it next time. Give it a name on the Dashboard.'
      : isNew ? 'This world was marked before, but its memory is gone: starting fresh.' : 'Recognised this world.');
    if (created || isNew) this.log(`New world ${id}: its memory and per-world settings start now. Rename it on the Dashboard.`);
    else this.log(`Recognised world "${this.current.name}".`);
    await this.checkAgent();
  }

  /** The marker id, or null if there's none (or the list couldn't be read). */
  async _readMarker() {
    const res = await this.bridge.sendCommand('scoreboard objectives list', { quiet: true });
    const m = MARKER_RE.exec(`${res.statusMessage || ''} ${JSON.stringify(res.body || {})}`);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * Does the connected player have an agent in this world yet? `agent ...` commands only ever reach
   * the agent of the player whose game runs them, so another player's agent never counts.
   */
  async checkAgent() {
    if (!this.bridge.connected) return;
    const res = await this.bridge.sendCommand('agent getposition', { quiet: true });
    // A timeout or a dropped connection (no reply from the game at all) says nothing either way.
    if (!res.ok && !res.body) return;
    this.agent = { exists: Boolean(res.ok && res.body && res.body.position), message: res.ok ? '' : res.statusMessage };
    this.emit('status');
  }

  /**
   * "This is actually world X": re-mark the open game world with X's id and switch to it.
   * Used from the Dashboard when a world was detected wrongly (or re-created).
   */
  async claim(id) {
    if (!fs.existsSync(path.join(WORLDS_DIR, id, 'memory.json'))) throw new Error('unknown world');
    if (this.bridge.connected) {
      const old = await this._readMarker();
      if (old && old !== id) await this.bridge.sendCommand(`scoreboard objectives remove ${MARKER_PREFIX}${old}`, { quiet: true });
      if (old !== id) await this.bridge.sendCommand(`scoreboard objectives add ${MARKER_PREFIX}${id} dummy "Ptolemy"`, { quiet: true });
    }
    this._open(id, {});
    this._setDetection('ok', 'Switched by hand; the game world is now marked as this one.');
  }

  /** Forget a world's memory (not the current one). */
  deleteWorld(id) {
    if (this.current && this.current.id === id) throw new Error('can\'t delete the world that\'s open');
    if (!/^[0-9a-z]+$/.test(id)) throw new Error('bad world id');
    fs.rmSync(path.join(WORLDS_DIR, id), { recursive: true, force: true });
    this.emit('status');
  }

  rename(name) {
    if (!this.current) return;
    this.current.setName(name);
    this.emit('world', this.current);
  }

  status() {
    return {
      type: 'worldStatus',
      detection: this.detection,
      agent: this.agent,
      current: this.current && { id: this.current.id, name: this.current.name },
      worlds: this.list(),
    };
  }

  _open(id, fallback) {
    if (this.current && this.current.id === id) {
      this.current.touch();
      return;
    }
    if (this.current) {
      this.current.save();
      this.current.removeAllListeners('change');
    }
    const memory = WorldMemory.load(path.join(WORLDS_DIR, id), { id, ...fallback });
    if (this.thoughtRules) memory.thoughtRules = this.thoughtRules;
    memory.pruneThoughts();
    memory.touch();
    memory.on('change', () => this.emit('memory', memory));
    this.current = memory;
    this.emit('world', memory);
  }

  _setDetection(state, message) {
    this.detection = { state, message };
    this.emit('status');
  }
}

module.exports = { WorldManager, WORLDS_DIR };
