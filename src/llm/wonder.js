'use strict';

const { EventEmitter } = require('events');

const MODES = ['off', 'on', 'always'];

/**
 * Wondering: when the robot has been idle for `wonder.interval` seconds, prompt the LLM to act
 * natural. The countdown starts from the last thing the robot or its model did (a model reply, a
 * tool call, a command from the console) or from switching wondering on; it isn't rolling.
 *
 *   off     never
 *   on      until a person asks for something, then it switches itself off
 *   always  pauses while a person's request runs, then counts down again
 *
 * Events: 'state' (for the WebUI's switch and countdown).
 */
class Wonder extends EventEmitter {
  constructor({ settings, pilot, bridge, worlds }) {
    super();
    Object.assign(this, { settings, pilot, bridge, worlds });
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
    if (this.worlds.agent.exists === false) return 'there\'s no agent in this world yet';
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
    if (this.mode === 'off' || this.blocker() || this.pilot.queue.length) return;
    if (Date.now() - this.pilot.lastActivity < this.settings.get('wonder.interval') * 1000) return;
    this.pilot.send(this.settings.get('wonder.prompt'), { source: 'wonder' });
  }
}

module.exports = { Wonder, MODES };
