'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');

// Bedrock silently drops command requests once roughly 100 are in flight,
// so we keep our own queue and only let a safe number out at a time.
const DEFAULT_MAX_IN_FLIGHT = 50;
const COMMAND_TIMEOUT_MS = 10000;

/**
 * Owns the WebSocket server that Minecraft Bedrock connects to (`/connect host:port`).
 *
 * Events:
 *   'status'   ({ connected, remote, since, player })
 *   'command'  ({ id, commandLine })                 a command was sent to the game
 *   'response' ({ id, commandLine, ok, statusCode, statusMessage, body })
 *   'event'    ({ name, body })                      a subscribed game event fired
 *   'raw'      ({ purpose, body })                   a message we couldn't match to anything
 *   'chat'     ({ sender, message, type })           a PlayerMessage event
 *   'agent'    ({ commandName, result, body })       an AgentCommand event: the outcome of an
 *                                                    `agent ...` command (e.g. what inspect saw)
 *   'log'      (string)                              bridge-level diagnostics
 */
class MinecraftBridge extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.wss = null;
    this.socket = null;
    this.remote = null;
    this.since = null;
    this.player = null;
    this.pending = new Map(); // requestId -> { commandLine, resolve, timer }
    this.queue = []; // { requestId, commandLine, resolve }
    // Event subscriptions survive reconnects: they are re-sent every time the game connects.
    this.subscriptions = new Set(['PlayerMessage', 'AgentCommand']);
    this.subscribeRequests = new Map(); // requestId -> { purpose, eventName }
    // body.version of command requests: the command syntax version. Other tools send a
    // Minecraft version string (e.g. "1.21.0"); null leaves the field out entirely.
    this.commandVersion = 1;
    this.maxInFlight = DEFAULT_MAX_IN_FLIGHT;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocket.Server({ port: this.port });
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
      this.wss.on('connection', (socket, req) => this._onConnection(socket, req));
    });
  }

  close() {
    this.disconnect();
    if (this.wss) this.wss.close();
  }

  get connected() {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  getStatus() {
    return {
      connected: this.connected,
      remote: this.remote,
      since: this.since,
      player: this.player,
      pending: this.pending.size + this.queue.length,
    };
  }

  disconnect() {
    if (this.socket) this.socket.close();
  }

  /**
   * Send a command to the game. Resolves (never rejects) with the parsed response,
   * so callers can treat failures, timeouts and "not connected" uniformly.
   * `quiet` commands (e.g. the hundreds a scan issues) are not reported to the console.
   */
  sendCommand(commandLine, { quiet = false } = {}) {
    const line = String(commandLine || '').trim().replace(/^\/+/, '');
    const requestId = crypto.randomUUID();

    if (!line) {
      return Promise.resolve(this._result(requestId, line, -1, 'Empty command', null, quiet));
    }
    if (!this.connected) {
      return Promise.resolve(this._result(requestId, line, -1, 'Minecraft is not connected', null, quiet));
    }

    return new Promise((resolve) => {
      this.queue.push({ requestId, commandLine: line, resolve, quiet });
      this._pump();
    });
  }

  /**
   * Send a hand-written message as-is (for protocol experiments). A missing
   * header.requestId is filled in; the reply shows up as an unmatched message.
   */
  sendRaw(message) {
    if (!this.connected) return false;
    message.header = { requestId: crypto.randomUUID(), ...(message.header || {}) };
    this.socket.send(JSON.stringify(message));
    return true;
  }

  subscribe(eventName) {
    this.subscriptions.add(eventName);
    this._sendSubscription('subscribe', eventName);
  }

  unsubscribe(eventName) {
    this.subscriptions.delete(eventName);
    this._sendSubscription('unsubscribe', eventName);
  }

  _sendSubscription(purpose, eventName) {
    if (!this.connected) return;
    const requestId = crypto.randomUUID();
    this.subscribeRequests.set(requestId, { purpose, eventName });
    // The game only answers a subscription when it fails, so forget it after a while.
    setTimeout(() => this.subscribeRequests.delete(requestId), COMMAND_TIMEOUT_MS);
    this._send(purpose, { eventName }, requestId);
  }

  // ---------------------------------------------------------------------------

  _onConnection(socket, req) {
    if (this.socket) {
      // Only one game client at a time: the newest connection wins.
      this.emit('log', 'A new Minecraft client connected; dropping the previous one.');
      this.socket.close();
    }

    this.socket = socket;
    this.remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    this.since = Date.now();
    this.player = null;
    this.emit('log', `Minecraft connected from ${this.remote}`);
    this._emitStatus();

    socket.on('message', (data) => this._onMessage(data));
    socket.on('error', (err) => {
      if (/invalid status code 0/.test(err.message)) {
        // Minecraft sometimes drops a fresh connection with a malformed close frame
        // and immediately reconnects; nothing we can (or need to) do about it.
        this.emit('log', 'Minecraft dropped the connection with a malformed close frame; it usually reconnects on its own.');
        return;
      }
      this.emit('log', `Minecraft socket error: ${err.message}`);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return; // an older, replaced socket
      this.socket = null;
      this.remote = null;
      this.since = null;
      this.player = null;
      this._failAll('Minecraft disconnected');
      this.emit('log', 'Minecraft disconnected');
      this._emitStatus();
    });

    // PlayerMessage: in-game chat. AgentCommand: agent commands only acknowledge the
    // request in their commandResponse ("Agent inspect successful"); the actual
    // outcome is expected to arrive later as this event.
    for (const eventName of this.subscriptions) this._sendSubscription('subscribe', eventName);
    this.emit('log', `Subscribed to events: ${[...this.subscriptions].join(', ')}`);
    this.sendCommand('getlocalplayername').then((res) => {
      if (res.ok && res.body && typeof res.body.localplayername === 'string') {
        this.player = res.body.localplayername;
        this._emitStatus();
      }
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch (err) {
      this.emit('log', `Unparseable message from Minecraft: ${err.message}`);
      return;
    }

    const header = msg.header || {};
    const body = msg.body || {};

    if (header.messagePurpose === 'event') {
      const name = header.eventName || body.eventName;
      if (name === 'PlayerMessage') {
        // Newer versions put fields on the body, older ones under body.properties.
        const props = body.properties || body;
        const sender = props.sender || (props.player && props.player.name) || props.Sender || 'unknown';
        this.emit('chat', { sender, message: props.message, type: props.type || props.MessageType });
      }
      if (name === 'AgentCommand') {
        this.emit('agent', parseAgentCommand(body));
      }
      this.emit('event', { name, body });
      return;
    }

    if (header.messagePurpose === 'commandResponse' || header.messagePurpose === 'error') {
      const sub = this.subscribeRequests.get(header.requestId);
      if (sub) {
        this.subscribeRequests.delete(header.requestId);
        const ok = body.statusCode === 0 || body.statusCode === undefined;
        if (!ok && sub.purpose === 'subscribe') this.subscriptions.delete(sub.eventName);
        this.emit('log', `${sub.purpose} ${sub.eventName}: ${ok ? 'OK' : 'failed'}`
          + (body.statusMessage ? ` (${body.statusMessage})` : ''));
        return;
      }

      const entry = this.pending.get(header.requestId);
      if (!entry) {
        // Late (already timed out) or unsolicited: still worth seeing.
        this.emit('raw', { purpose: header.messagePurpose, body });
        return;
      }
      this.pending.delete(header.requestId);
      clearTimeout(entry.timer);
      const code = typeof body.statusCode === 'number' ? body.statusCode : -1;
      entry.resolve(this._result(header.requestId, entry.commandLine, code, body.statusMessage, body, entry.quiet));
      this._pump();
      return;
    }

    this.emit('raw', { purpose: header.messagePurpose, body });
  }

  _pump() {
    while (this.connected && this.queue.length && this.pending.size < this.maxInFlight) {
      const { requestId, commandLine, resolve, quiet } = this.queue.shift();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(this._result(requestId, commandLine, -1, `No response after ${COMMAND_TIMEOUT_MS / 1000}s`, null, quiet));
        this._pump();
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(requestId, { commandLine, resolve, timer, quiet });
      const body = { commandLine, origin: { type: 'player' } };
      if (this.commandVersion !== null) body.version = this.commandVersion;
      this._send('commandRequest', body, requestId);
      if (!quiet) this.emit('command', { id: requestId, commandLine });
    }
  }

  _send(purpose, body, requestId = crypto.randomUUID()) {
    if (!this.connected) return;
    this.socket.send(JSON.stringify({
      header: {
        requestId,
        messagePurpose: purpose,
        version: 1,
        messageType: 'commandRequest',
      },
      body,
    }));
  }

  _result(id, commandLine, statusCode, statusMessage, body = null, quiet = false) {
    const result = {
      id,
      commandLine,
      ok: statusCode === 0,
      statusCode,
      statusMessage: statusMessage || (statusCode === 0 ? 'OK' : 'Command failed'),
      body,
    };
    if (!quiet) this.emit('response', result);
    return result;
  }

  _failAll(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(this._result(id, entry.commandLine, -1, reason, null, entry.quiet));
    }
    this.pending.clear();
    for (const { requestId, commandLine, resolve, quiet } of this.queue.splice(0)) {
      resolve(this._result(requestId, commandLine, -1, reason, null, quiet));
    }
  }

  _emitStatus() {
    this.emit('status', this.getStatus());
  }
}

/**
 * AgentCommand payloads differ between game versions: fields may sit on the body or
 * under body.properties, and the result may be an object or a JSON-encoded string.
 */
function parseAgentCommand(body) {
  const props = body.properties || body;
  let result = props.Result ?? props.result ?? null;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      // leave it as the raw string
    }
  }
  const commandName = props.CommandName ?? props.commandName
    ?? (result && typeof result === 'object' ? result.commandName : undefined) ?? null;
  return { commandName, result, body };
}

module.exports = { MinecraftBridge };
