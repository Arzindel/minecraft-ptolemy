'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const SRC_DIR = path.join(__dirname, '..');
const STARTED_AT = Date.now();
const LOG_HISTORY = 500;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serves the WebUI over HTTP and keeps every open browser tab in sync
 * with the Minecraft bridge through a WebSocket on `/ui`.
 */
class WebServer {
  constructor({ port, bridge }) {
    this.port = port;
    this.bridge = bridge;
    this.log = [];
    this.nextLogId = 1;

    this.http = http.createServer((req, res) => this._serveStatic(req, res));
    this.wss = new WebSocket.Server({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://localhost').pathname !== '/ui') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this._onClient(ws));
    });

    bridge.on('status', () => this._broadcastStatus());
    bridge.on('log', (text) => this._addLog('system', text));
    bridge.on('command', ({ id, commandLine }) => {
      this._addLog('command', commandLine, { requestId: id });
      this._broadcastStatus();
    });
    bridge.on('response', (res) => {
      this._addLog(res.ok ? 'response' : 'error', res.statusMessage, {
        requestId: res.id,
        commandLine: res.commandLine,
        statusCode: res.statusCode,
        body: res.body,
      });
      this._broadcastStatus();
    });
    bridge.on('chat', ({ sender, message }) => this._addLog('chat', message, { sender }));
    bridge.on('event', ({ name, body }) => {
      if (name === 'PlayerMessage' || name === 'AgentCommand') return; // logged above/below
      this._addLog('event', name || '(unnamed event)', { commandLine: name, body });
    });
    bridge.on('raw', ({ purpose, body }) => {
      this._addLog('system', `Unmatched message from Minecraft (${purpose || 'no purpose'})`, { body });
    });
    bridge.on('agent', ({ commandName, result, body }) => {
      this._addLog('agent', summarizeAgentResult(commandName, result), { commandLine: commandName, body });
    });
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, resolve);
    });
  }

  close() {
    this.wss.clients.forEach((ws) => ws.close());
    this.http.close();
  }

  status() {
    return {
      type: 'status',
      minecraft: this.bridge.getStatus(),
      mcPort: this.bridge.port,
      addresses: localAddresses(),
    };
  }

  // ---------------------------------------------------------------------------

  _onClient(ws) {
    ws.send(JSON.stringify(this.status()));
    ws.send(JSON.stringify({ type: 'history', entries: this.log }));

    // The WebUI is re-read from disk on every page load, but the server code only on
    // start-up, so after a `git pull` the page can be newer than the server behind it.
    if (codeChangedSinceStart()) {
      this._addLog('system', 'Ptolemy\'s server code changed since it was started. '
        + 'Restart it (`npm run start` does this automatically; `npm run start:once` does not), '
        + 'or new features may not work.');
    }

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }

      switch (msg.type) {
        case 'command':
          // `#name` (or `/#name`) is for Ptolemy itself; everything else goes to the game,
          // where the leading slash is optional.
          const consoleCommand = String(msg.text || '').trim().match(/^\/*#(.*)$/s);
          if (consoleCommand) {
            this._runConsoleCommand(consoleCommand[1].trim());
          } else {
            this.bridge.sendCommand(msg.text);
          }
          break;
        case 'disconnect':
          this.bridge.disconnect();
          break;
        case 'clearLog':
          this.log = [];
          this._broadcast({ type: 'history', entries: [] });
          break;
        default:
          break;
      }
    });
  }

  /**
   * Commands for Ptolemy itself rather than the game, typed as `#name args` in the console.
   */
  _runConsoleCommand(text) {
    const [name = '', ...args] = text.split(/\s+/);
    const say = (line) => this._addLog('system', line);

    switch (name.toLowerCase()) {
      case 'subscribe':
      case 'unsubscribe': {
        if (!args.length) {
          say(`Usage: #${name} <EventName> [EventName...]`);
          return;
        }
        for (const eventName of args) {
          if (name.toLowerCase() === 'subscribe') this.bridge.subscribe(eventName);
          else this.bridge.unsubscribe(eventName);
        }
        say(`${name} ${args.join(', ')}`
          + (this.bridge.connected ? '' : ' (will be sent when Minecraft connects)'));
        return;
      }
      case 'probe':
        this._probeAgent(args[0] === 'all');
        return;
      case 'subscriptions':
        say(`Subscribed events: ${[...this.bridge.subscriptions].join(', ') || '(none)'}`);
        return;
      case 'help':
      case '':
        say('Console commands: #subscribe <Event...>, #unsubscribe <Event...>, #subscriptions, '
          + '#probe [all] (run every read-only agent command and summarize what each returns), #help. '
          + 'Anything not starting with # is sent to Minecraft.');
        return;
      default:
        say(`Unknown console command "#${name}". Try #help.`);
    }
  }

  /**
   * Runs every read-only agent command once and reports which fields each response carries
   * beyond statusCode/statusMessage, to map out what the agent can actually sense.
   */
  async _probeAgent(allSlots) {
    if (!this.bridge.connected) {
      this._addLog('system', 'Probe needs Minecraft to be connected.');
      return;
    }

    const directions = ['forward', 'back', 'left', 'right', 'up', 'down'];
    const slots = allSlots ? Array.from({ length: 27 }, (_, i) => i + 1) : [1];
    const commands = [
      'agent getposition',
      ...['detect', 'detectredstone', 'inspect', 'inspectdata']
        .flatMap((sub) => directions.map((dir) => `agent ${sub} ${dir}`)),
      ...['getitemcount', 'getitemdetail', 'getitemspace']
        .flatMap((sub) => slots.map((slot) => `agent ${sub} ${slot}`)),
    ];

    this._addLog('system', `Probing ${commands.length} agent commands...`);

    // One at a time, so the results line up with what the agent was doing.
    const results = {};
    const lines = [];
    for (const command of commands) {
      const res = await this.bridge.sendCommand(command);
      const { statusCode, statusMessage, ...data } = res.body || {};
      results[command] = res.body || { statusCode: res.statusCode, statusMessage: res.statusMessage };
      const fields = Object.keys(data);
      lines.push(`${res.ok ? '✓' : '✗'} ${command}  →  `
        + (fields.length ? fields.map((k) => `${k}=${JSON.stringify(data[k])}`).join('  ') : `(no data) "${res.statusMessage}"`));
    }

    this._addLog('system', `Probe results:\n${lines.join('\n')}`, { commandLine: 'Probe results', body: results });
  }

  _addLog(kind, text, extra = {}) {
    const entry = { ...extra, id: this.nextLogId++, time: Date.now(), kind, text: String(text ?? '') };
    this.log.push(entry);
    if (this.log.length > LOG_HISTORY) this.log.splice(0, this.log.length - LOG_HISTORY);
    this._broadcast({ type: 'log', entry });
  }

  _broadcastStatus() {
    this._broadcast(this.status());
  }

  _broadcast(message) {
    const payload = JSON.stringify(message);
    this.wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  }

  _serveStatic(req, res) {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, relative));

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    });
  }
}

function summarizeAgentResult(commandName, result) {
  const prefix = commandName ? `agent ${commandName}: ` : 'agent: ';
  if (result === null || result === undefined) return `${prefix}(no result)`;
  if (typeof result !== 'object') return prefix + String(result);

  // Show the interesting fields first, then whatever else the game sent.
  const { commandName: _ignored, ...rest } = result;
  const text = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
  return prefix + (text || '(empty result)');
}

function codeChangedSinceStart(dir = SRC_DIR) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() ? codeChangedSinceStart(full) : fs.statSync(full).mtimeMs > STARTED_AT) {
      return true;
    }
  }
  return false;
}

/** LAN IPv4 addresses, so the UI can suggest a `/connect` target for other devices. */
function localAddresses() {
  const out = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

module.exports = { WebServer };
