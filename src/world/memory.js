'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const LIMITS = { areas: 60, todos: 30, thoughts: 10, notes: 60, journal: 50 };
const TODO_STATES = ['pending', 'in_progress', 'done'];
const SAVE_DELAY_MS = 300;

/**
 * Everything Ptolemy remembers about one Minecraft world, saved in data/worlds/<id>/memory.json:
 *   - areas:    named boxes ("house", "kitchen"); an area inside another is shown as part of it
 *   - todos:    the robot's task list, like a coding agent's todo list
 *   - thoughts: what's on its mind ("I want to see flowers"), few and fleeting
 *   - notes:    facts worth keeping ("the chest with wood is at 10 64 5")
 *   - journal:  what it was asked recently and how that went
 *   - instructions: extra instructions for the LLM, for this world only
 * The conversation with the LLM is kept next to it, in conversation.json.
 */
class WorldMemory extends EventEmitter {
  constructor(dir, data) {
    super();
    this.dir = dir;
    this.data = {
      id: data.id,
      name: data.name || 'Unnamed world',
      createdAt: data.createdAt || Date.now(),
      lastSeenAt: data.lastSeenAt || Date.now(),
      instructions: data.instructions || '',
      areas: data.areas || [],
      todos: data.todos || [],
      thoughts: data.thoughts || [],
      notes: data.notes || [],
      journal: data.journal || [],
      nextId: data.nextId || 1,
    };
    this._timer = null;
  }

  static load(dir, fallback) {
    let data = fallback;
    try {
      data = { ...fallback, ...JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[world] Ignoring ${dir}/memory.json: ${err.message}`);
    }
    return new WorldMemory(dir, data);
  }

  get id() { return this.data.id; }

  get name() { return this.data.name; }

  // --- Areas ------------------------------------------------------------------

  /** Add or replace an area by name. Corners in any order; a single point is a 1x1x1 area. */
  setArea(name, a, b = a, note = '') {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('an area needs a name');
    const nums = [...a, ...b].map(Number);
    if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) throw new Error('an area needs whole-number corners');
    const [x1, y1, z1, x2, y2, z2] = nums.map(Math.round);
    const area = {
      name: clean,
      min: [Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2)],
      max: [Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)],
      note: String(note || '').slice(0, 200),
    };
    const existing = this.findArea(clean);
    if (existing) Object.assign(existing, area);
    else {
      if (this.data.areas.length >= LIMITS.areas) throw new Error(`at most ${LIMITS.areas} areas`);
      this.data.areas.push({ id: this._id('a'), ...area });
    }
    this._changed();
    return this.findArea(clean);
  }

  removeArea(nameOrId) {
    const area = this.findArea(nameOrId);
    if (!area) return false;
    this.data.areas = this.data.areas.filter((a) => a !== area);
    this._changed();
    return true;
  }

  findArea(nameOrId) {
    const key = String(nameOrId || '').trim().toLowerCase();
    return this.data.areas.find((a) => a.id === key || a.name.toLowerCase() === key) || null;
  }

  /** Areas containing a point, smallest first. */
  areasAt(x, y, z) {
    return this.data.areas
      .filter((a) => x >= a.min[0] && x <= a.max[0] && y >= a.min[1] && y <= a.max[1] && z >= a.min[2] && z <= a.max[2])
      .sort((a, b) => volume(a) - volume(b));
  }

  /** The smallest other area that fully contains this one. */
  parentOf(area) {
    return this.data.areas
      .filter((o) => o !== area && volume(o) > volume(area) && [0, 1, 2].every((i) => o.min[i] <= area.min[i] && o.max[i] >= area.max[i]))
      .sort((a, b) => volume(a) - volume(b))[0] || null;
  }

  /** "kitchen (in house)" */
  describeAreasAt(x, y, z) {
    const inside = this.areasAt(x, y, z);
    return inside.length ? inside.map((a) => a.name).join(' in ') : null;
  }

  // --- Todos, thoughts, notes ---------------------------------------------------

  /** Replace the whole todo list (how the LLM updates it, like a coding agent's todo tool). */
  setTodos(todos) {
    if (!Array.isArray(todos)) throw new Error('todos must be a list');
    this.data.todos = todos.slice(0, LIMITS.todos).map((t) => {
      const text = String((t && (t.text || t.content || t.task)) || '').trim().slice(0, 200);
      if (!text) throw new Error('every todo needs text');
      const status = TODO_STATES.includes(t.status) ? t.status : t.status === 'completed' ? 'done' : 'pending';
      const old = this.data.todos.find((o) => o.text === text);
      return { id: (old && old.id) || this._id('t'), text, status };
    });
    this._changed();
  }

  addTodo(text) {
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    this.data.todos.push({ id: this._id('t'), text: clean, status: 'pending' });
    this.data.todos = this.data.todos.slice(-LIMITS.todos);
    this._changed();
  }

  updateTodo(id, patch) {
    const todo = this.data.todos.find((t) => t.id === id);
    if (!todo) return;
    if (TODO_STATES.includes(patch.status)) todo.status = patch.status;
    if (typeof patch.text === 'string' && patch.text.trim()) todo.text = patch.text.trim().slice(0, 200);
    this._changed();
  }

  removeTodo(id) {
    this.data.todos = this.data.todos.filter((t) => t.id !== id);
    this._changed();
  }

  clearDoneTodos() {
    this.data.todos = this.data.todos.filter((t) => t.status !== 'done');
    this._changed();
  }

  /** A new thought; the oldest one fades when there are too many. */
  addThought(text) {
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) throw new Error('a thought needs text');
    this.data.thoughts.push({ id: this._id('h'), text: clean, time: Date.now() });
    this.data.thoughts = this.data.thoughts.slice(-LIMITS.thoughts);
    this._changed();
  }

  addNote(text) {
    const clean = String(text || '').trim().slice(0, 300);
    if (!clean) throw new Error('a note needs text');
    if (this.data.notes.length >= LIMITS.notes) this.data.notes.shift();
    this.data.notes.push({ id: this._id('n'), text: clean, time: Date.now() });
    this._changed();
  }

  /** Remove a thought or note by id, number (1-based) or matching text. */
  remove(list, which) {
    const items = this.data[list];
    const key = String(which ?? '').trim().toLowerCase();
    let index = items.findIndex((i) => i.id === key);
    if (index === -1 && /^\d+$/.test(key)) index = Number(key) - 1;
    if (index === -1 || !items[index]) index = items.findIndex((i) => i.text.toLowerCase().includes(key) && key);
    if (index === -1 || !items[index]) return null;
    const [removed] = items.splice(index, 1);
    this._changed();
    return removed;
  }

  addJournal(entry) {
    this.data.journal.push({ time: Date.now(), ...entry });
    this.data.journal = this.data.journal.slice(-LIMITS.journal);
    this._changed();
  }

  setName(name) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) return;
    this.data.name = clean;
    this._changed();
  }

  setInstructions(text) {
    this.data.instructions = String(text || '').slice(0, 4000);
    this._changed();
  }

  touch() {
    this.data.lastSeenAt = Date.now();
    this._changed();
  }

  // --- For the LLM --------------------------------------------------------------

  /** The memory as a compact block for the system prompt. */
  promptBlock() {
    const d = this.data;
    const lines = [`# World memory: ${d.name}`];
    if (d.areas.length) {
      lines.push('Named areas (x y z from..to; use go_to with area to visit one):');
      for (const a of d.areas) {
        const parent = this.parentOf(a);
        lines.push(`- ${a.name}: ${a.min[0]}..${a.max[0]} ${a.min[1]}..${a.max[1]} ${a.min[2]}..${a.max[2]}`
          + `${parent ? ` (in ${parent.name})` : ''}${a.note ? `, ${a.note}` : ''}`);
      }
    } else {
      lines.push('No named areas yet. When the player names a place, save it with add_area.');
    }
    lines.push(d.todos.length
      ? `Todo list:\n${d.todos.map((t) => `- [${t.status}] ${t.text}`).join('\n')}`
      : 'Todo list: empty.');
    lines.push(d.thoughts.length
      ? `On your mind:\n${d.thoughts.map((t) => `- ${t.text} (${ago(t.time)})`).join('\n')}`
      : 'On your mind: nothing in particular.');
    if (d.notes.length) lines.push(`Notes:\n${d.notes.map((n) => `- ${n.text}`).join('\n')}`);
    const recent = d.journal.slice(-5);
    if (recent.length) {
      lines.push(`Recently:\n${recent.map((j) => `- ${ago(j.time)}: ${j.request ? `"${j.request.slice(0, 80)}" → ` : ''}${(j.result || '').slice(0, 120)}`).join('\n')}`);
    }
    if (d.instructions.trim()) lines.push(`Instructions for this world:\n${d.instructions.trim()}`);
    return lines.join('\n');
  }

  /** For the Dashboard. */
  toJSON() {
    return {
      ...this.data,
      areas: this.data.areas.map((a) => ({ ...a, parent: (this.parentOf(a) || {}).name || null })),
    };
  }

  // --- Conversation (saved separately, it's larger and changes often) ---------------

  loadConversation() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'conversation.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  saveConversation(conversation) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'conversation.json'), JSON.stringify(conversation));
    } catch (err) {
      console.warn(`[world] Couldn't save the conversation: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------------

  _id(prefix) {
    return `${prefix}${this.data.nextId++}`;
  }

  _changed() {
    this.emit('change');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  save() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'memory.json'), `${JSON.stringify(this.data, null, 2)}\n`);
    } catch (err) {
      console.warn(`[world] Couldn't save ${this.dir}: ${err.message}`);
    }
  }
}

function volume(a) {
  return (a.max[0] - a.min[0] + 1) * (a.max[1] - a.min[1] + 1) * (a.max[2] - a.min[2] + 1);
}

function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

module.exports = { WorldMemory, TODO_STATES };
