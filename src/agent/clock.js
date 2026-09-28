'use strict';

const { EventEmitter } = require('events');
const { getAgentPose } = require('./pose');

// The game's clock and weather, only ever read (never changed):
//   time query daytime   ticks since the day started, 0-23999 (0 is 6:00, 6000 noon, 18000 midnight)
//   time query day       how many in-game days have passed
//   weather query        clear, rain or thunder
// Checked every few seconds (the "clock.seconds" setting); in between, the time is worked out from the
// last reading (20 ticks a second), unless the daylight cycle looked stopped last time.

const TICKS_PER_DAY = 24000;
const TICKS_PER_SECOND = 20;
const WEATHERS = ['clear', 'rain', 'thunder'];

/** A number from a query reply: body.data if the game sent one, else the first number in the message. */
function numberFrom(res) {
  if (!res || !res.ok) return null;
  const body = res.body || {};
  if (typeof body.data === 'number') return body.data;
  const m = /-?\d+/.exec(res.statusMessage || '');
  return m ? Number(m[0]) : null;
}

function weatherFrom(res) {
  if (!res || !res.ok) return null;
  const m = /\b(clear|rain|thunder)/i.exec(`${res.statusMessage || ''} ${JSON.stringify(res.body || {})}`);
  return m ? m[1].toLowerCase() : null;
}

/** Ticks of the day as a 24-hour clock: 0 → "06:00", 6000 → "12:00", 18000 → "00:00". */
function clockText(daytime) {
  const t = ((Math.floor(daytime) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const minutes = Math.floor((((t + 6000) % TICKS_PER_DAY) * 1440) / TICKS_PER_DAY);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Morning, noon, evening... (and whether mobs come out). */
function partOfDay(daytime) {
  const t = ((Math.floor(daytime) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  if (t >= 23000 || t < 1000) return 'dawn';
  if (t < 5000) return 'morning';
  if (t < 7000) return 'noon';
  if (t < 11000) return 'afternoon';
  if (t < 13000) return 'evening';
  return 'night';
}

class Clock extends EventEmitter {
  /** @param {{ bridge: import('../minecraft/bridge').MinecraftBridge }} deps */
  constructor({ bridge }) {
    super();
    this.bridge = bridge;
    this.reading = null; // { daytime, day, weather, at, running }
    this._refreshing = null;
  }

  /** Ask the game (all three at once, about one round trip). Resolves to now(), or null. */
  refresh() {
    if (!this._refreshing) {
      this._refreshing = this._refresh().finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  async _refresh() {
    if (!this.bridge.connected) return null;
    const send = (cmd) => this.bridge.sendCommand(cmd, { quiet: true });
    const [t, d, w] = await Promise.all([send('time query daytime'), send('time query day'), send('weather query')]);
    const daytime = numberFrom(t);
    if (daytime === null) return this.now();
    const before = this.reading;
    // The daylight cycle is off if the time didn't move since the last reading (a second or more ago).
    const running = !before || Date.now() - before.at < 1000 ? (before ? before.running : true) : daytime !== before.daytime;
    this.reading = {
      daytime,
      day: numberFrom(d) ?? (before && before.day) ?? null,
      weather: weatherFrom(w) || (before && before.weather) || null,
      at: Date.now(),
      running,
    };
    const now = this.now();
    this.emit('change', now);
    return now;
  }

  /** The time now, worked out from the last reading: { daytime, time, part, day, weather, running, at } or null. */
  now() {
    const r = this.reading;
    if (!r) return null;
    const elapsed = r.running ? ((Date.now() - r.at) / 1000) * TICKS_PER_SECOND : 0;
    const daytime = Math.floor(r.daytime + elapsed) % TICKS_PER_DAY;
    return { daytime, time: clockText(daytime), part: partOfDay(daytime), day: r.day, weather: r.weather, running: r.running, at: r.at };
  }

  /** "14:05 (afternoon), day 12, weather: rain" */
  describe() {
    const n = this.now();
    if (!n) return null;
    return `${n.time} (${n.part}${n.running ? '' : ', the daylight cycle is stopped'})`
      + `${n.day !== null ? `, day ${n.day}` : ''}${n.weather ? `. Weather: ${n.weather}` : ''}`;
  }

  message() {
    return { type: 'clock', now: this.now() };
  }
}

// --- Placeholders ------------------------------------------------------------------
// The model can write these in what it says; they are filled in the moment the message goes out,
// so "It's {time_now}" is right even when the model took a minute to write it.

const PLACEHOLDERS = {
  time_now: 'the game time right now, 24-hour clock (e.g. 14:05)',
  weather: 'the weather right now (clear, rain or thunder)',
  day: 'how many in-game days have passed',
  my_coordinates: 'where you (the robot) are right now, as x y z',
};
const PLACEHOLDER_SOURCE = `\\{(${Object.keys(PLACEHOLDERS).join('|')})\\}`;
// A fresh regex each time: a shared global one carries its lastIndex from one use to the next.
const placeholderRe = () => new RegExp(PLACEHOLDER_SOURCE, 'g');

function hasPlaceholders(text) {
  return placeholderRe().test(String(text || ''));
}

/**
 * Fill in the placeholders in `text` from fresh readings (the clock and the robot's position are
 * asked for right now; if that fails, the last reading is used, and a placeholder that can't be
 * filled at all is left as it is).
 */
async function expandPlaceholders(text, { bridge, clock }) {
  const s = String(text ?? '');
  if (!hasPlaceholders(s)) return s;
  const wanted = new Set([...s.matchAll(placeholderRe())].map((m) => m[1]));
  const needsClock = wanted.has('time_now') || wanted.has('weather') || wanted.has('day');
  const [now, pose] = await Promise.all([
    needsClock && clock ? clock.refresh().catch(() => clock.now()) : null,
    wanted.has('my_coordinates') && bridge.connected ? getAgentPose(bridge).catch(() => null) : null,
  ]);
  const values = {
    time_now: now && now.time,
    weather: now && now.weather,
    day: now && now.day !== null && now.day !== undefined ? String(now.day) : null,
    my_coordinates: pose && `${pose.x} ${pose.y} ${pose.z}`,
  };
  return s.replace(placeholderRe(), (whole, name) => values[name] || whole);
}

/** One line per placeholder, for prompts and tool descriptions. */
function placeholderHelp() {
  return Object.entries(PLACEHOLDERS).map(([name, what]) => `{${name}}: ${what}`).join('; ');
}

module.exports = {
  Clock, clockText, partOfDay, numberFrom, weatherFrom, expandPlaceholders, hasPlaceholders, placeholderHelp, PLACEHOLDERS, WEATHERS,
};
