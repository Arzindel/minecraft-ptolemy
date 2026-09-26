'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');

// Bedrock silently drops command requests once roughly 100 are in flight,
// so we keep our own queue and only let a safe number out at a time.
const MAX_IN_FLIGHT = 50;
const COMMAND_TIMEOUT_MS = 10000;

/**
 * Owns the WebSocket server that Minecraft Bedrock connects to (`/connect host:port`).
 *
 * Events:
 *   'status'   ({ connected, remote, since, player })
 *   'command'  ({ id, commandLine })                 a command was sent to the game
 *   'response' ({ id, commandLine, ok, statusCode, statusMessage, body })
 *   'event'    ({ name, body })                      a subscribed game event fired
 *   'chat'     ({ sender, message, type })           a PlayerMessage event
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
   */
  sendCommand(commandLine) {
    const line = String(commandLine || '').trim().replace(/^\/+/, '');
    const requestId = crypto.randomUUID();

    if (!line) {
      return Promise.resolve(this._result(requestId, line, -1, 'Empty command'));
    }
    if (!this.connected) {
      return Promise.resolve(this._result(requestId, line, -1, 'Minecraft is not connected'));
    }

    return new Promise((resolve) => {
      this.queue.push({ requestId, commandLine: line, resolve });
      this._pump();
    });
  }

  subscribe(eventName) {
    this._send('subscribe', { eventName });
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
    socket.on('error', (err) => this.emit('log', `Minecraft socket error: ${err.message}`));
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

    this.subscribe('PlayerMessage');
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
      this.emit('event', { name, body });
      return;
    }

    if (header.messagePurpose === 'commandResponse' || header.messagePurpose === 'error') {
      const entry = this.pending.get(header.requestId);
      if (!entry) return; // e.g. a subscribe acknowledgement
      this.pending.delete(header.requestId);
      clearTimeout(entry.timer);
      const code = typeof body.statusCode === 'number' ? body.statusCode : -1;
      entry.resolve(this._result(header.requestId, entry.commandLine, code, body.statusMessage, body));
      this._pump();
    }
  }

  _pump() {
    while (this.connected && this.queue.length && this.pending.size < MAX_IN_FLIGHT) {
      const { requestId, commandLine, resolve } = this.queue.shift();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(this._result(requestId, commandLine, -1, `No response after ${COMMAND_TIMEOUT_MS / 1000}s`));
        this._pump();
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(requestId, { commandLine, resolve, timer });
      this._send('commandRequest', { commandLine, version: 1, origin: { type: 'player' } }, requestId);
      this.emit('command', { id: requestId, commandLine });
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

  _result(id, commandLine, statusCode, statusMessage, body = null) {
    const result = {
      id,
      commandLine,
      ok: statusCode === 0,
      statusCode,
      statusMessage: statusMessage || (statusCode === 0 ? 'OK' : 'Command failed'),
      body,
    };
    this.emit('response', result);
    return result;
  }

  _failAll(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(this._result(id, entry.commandLine, -1, reason));
    }
    this.pending.clear();
    for (const { requestId, commandLine, resolve } of this.queue.splice(0)) {
      resolve(this._result(requestId, commandLine, -1, reason));
    }
  }

  _emitStatus() {
    this.emit('status', this.getStatus());
  }
}

module.exports = { MinecraftBridge };
