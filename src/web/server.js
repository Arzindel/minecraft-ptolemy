'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { scanAroundAgent, formatScan } = require('../agent/scan');
const { WorldKnowledge } = require('../agent/world');
const { Navigator, pathMessage, DEFAULT_SCAN_SIZE, DEFAULT_RETRIES } = require('../agent/navigator');
const { getAgentPose, facingFromRotation } = require('../agent/pose');
const { MAX_IN_FLIGHT_LIMIT } = require('../minecraft/bridge');

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
    this.sight = null; // the latest scan, in the compact form sent to the Nanny Cam
    this.world = new WorldKnowledge();
    this.navigator = new Navigator({
      bridge,
      world: this.world,
      scan: (size, opts) => this._scan(size, opts),
      log: (text, extra) => this._addLog('system', text, extra),
      broadcast: (message) => {
        // Keep the stored Sight's robot pose current, so pages opened mid-walk see where it is.
        if (message.type === 'agent' && this.sight) {
          this.sight.agent = { ...this.sight.agent, position: message.position, yRot: message.yRot };
        }
        this._broadcast(message);
      },
    });
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
    // Moving the agent by hand invalidates stored paths (the walker's own commands are quiet).
    bridge.on('response', (res) => {
      if (!res.ok || !/^agent (move|turn|tp|teleport)\b/i.test(res.commandLine)) return;
      getAgentPose(bridge).then((pose) => this.navigator.agentMoved(pose), () => {});
    });
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
    if (this.sight) ws.send(JSON.stringify(this.sight));
    ws.send(JSON.stringify(pathMessage('walk', this.navigator.paths.walk)));
    ws.send(JSON.stringify(pathMessage('fly', this.navigator.paths.fly)));

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
        case 'scan': {
          const cube = Number(msg.size) || null;
          this._scan(cube && cube % 2 === 1 && cube <= 31 ? cube : null);
          break;
        }
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
      case 'cmdversion': {
        const value = args.join(' ');
        if (value) {
          // "off" omits the field, a plain integer is sent as a number, anything else as a string.
          this.bridge.commandVersion = value === 'off' ? null : /^\d+$/.test(value) ? Number(value) : value;
        }
        const current = this.bridge.commandVersion;
        say(`Command requests are sent with body.version = ${current === null ? '(omitted)' : JSON.stringify(current)}`
          + (value ? '' : '. Usage: #cmdversion <1 | 1.21.0 | off>'));
        return;
      }
      case 'raw': {
        const json = text.slice(name.length).trim();
        let message;
        try {
          message = JSON.parse(json);
        } catch (err) {
          say(`Usage: #raw {"header":{...},"body":{...}}  (${err.message})`);
          return;
        }
        if (this.bridge.sendRaw(message)) {
          this._addLog('system', 'Sent raw message', { commandLine: 'Raw message sent', body: message });
        } else {
          say('Minecraft is not connected.');
        }
        return;
      }
      case 'scan': {
        const cube = args[0] ? Number(args[0]) : null;
        if (cube !== null && !(Number.isInteger(cube) && cube >= 1 && cube % 2 === 1 && cube <= 31)) {
          say('Usage: #scan (field of view) or #scan <odd size up to 31> for a cube, e.g. #scan 5');
          return;
        }
        this._scan(cube);
        return;
      }
      case 'inflight': {
        const n = Number(args[0]);
        if (args[0] && Number.isInteger(n) && n >= 1) {
          if (n > MAX_IN_FLIGHT_LIMIT) {
            say(`Bedrock drops every command beyond ${MAX_IN_FLIGHT_LIMIT} in flight, so the limit stays at ${MAX_IN_FLIGHT_LIMIT}.`);
            this.bridge.maxInFlight = MAX_IN_FLIGHT_LIMIT;
          } else {
            this.bridge.maxInFlight = n;
          }
        }
        say(`Up to ${this.bridge.maxInFlight} commands are sent to Minecraft at once`
          + (args[0] ? '' : `. Usage: #inflight <1-${MAX_IN_FLIGHT_LIMIT}>`));
        return;
      }
      case 'pathfind':
      case 'flypathfind':
        this.navigator.pathfind(args, { fly: name.toLowerCase().startsWith('fly') });
        return;
      case 'pathwalk':
      case 'flypathwalk':
        this.navigator.pathwalk({ fly: name.toLowerCase().startsWith('fly') });
        return;
      case 'pathfindwalk':
      case 'flypathfindwalk': {
        // #pathfindwalk x y z [scan=15] [retries=3]
        const opts = { scanSize: DEFAULT_SCAN_SIZE, retries: DEFAULT_RETRIES, fly: name.toLowerCase().startsWith('fly') };
        const coords = [];
        for (const arg of args) {
          const m = /^(scan|retries)=(\d+)$/.exec(arg);
          if (!m) coords.push(arg);
          else if (m[1] === 'scan') opts.scanSize = Number(m[2]);
          else opts.retries = Number(m[2]);
        }
        if (opts.scanSize % 2 === 0 || opts.scanSize < 3 || opts.scanSize > 31) {
          say('scan= must be an odd size from 3 to 31.');
          return;
        }
        this.navigator.pathfindwalk(coords, opts);
        return;
      }
      case 'pathsafe':
        if (args[0] === 'on' || args[0] === 'off') this.navigator.setSafe(args[0] === 'on');
        else say(`Path safe mode is ${this.navigator.safe ? 'on' : 'off'}. Usage: #pathsafe on|off`);
        return;
      case 'pathstop':
        this.navigator.stop();
        return;
      case 'probe':
        this._probeAgent(args[0] === 'all');
        return;
      case 'subscriptions':
        say(`Subscribed events: ${[...this.bridge.subscriptions].join(', ') || '(none)'}`);
        return;
      case 'help':
      case '':
        say('Console commands: #subscribe <Event...>, #unsubscribe <Event...>, #subscriptions, '
          + '#probe [all] (run every read-only agent command and summarize what each returns), '
          + '#scan [size] (identify the blocks around the agent; a size like 5 scans a 5x5x5 cube), '
          + '#inflight <n> (how many commands may be outstanding at once), '
          + '#pathfind <x y z | @p> (plan a route that stays next to blocks; ~ = relative to the agent), '
          + '#pathwalk (walk it), #pathfindwalk <x y z | @p> [scan=15] [retries=3] (plan and walk, '
          + 'rescanning on the way), #flypathfind / #flypathwalk / #flypathfindwalk (the same, flying straight), '
          + '#pathsafe on|off, #pathstop, '
          + '#cmdversion <1 | 1.21.0 | off> (command syntax version sent with commands), '
          + '#raw <json> (send a hand-written WebSocket message), #help. '
          + 'Anything not starting with # is sent to Minecraft.');
        return;
      default:
        say(`Unknown console command "#${name}". Try #help.`);
    }
  }

  /** Scan around the agent and make the result its Sight. `quiet` logs one line instead of the layers. */
  async _scan(cube, { quiet = false } = {}) {
    if (!this.bridge.connected) {
      this._addLog('system', 'Scan needs Minecraft to be connected.');
      return null;
    }
    if (!quiet) this._addLog('system', 'Scanning around the agent...');
    try {
      const scan = await scanAroundAgent(this.bridge, { cube });
      if (quiet) {
        const { x, y, z } = scan.agent.position;
        this._addLog('system', `Scanned ${scan.cells.length} blocks around ${x} ${y} ${z} `
          + `in ${(scan.tookMs / 1000).toFixed(1)}s.`);
      } else {
        this._addLog('system', formatScan(scan), { commandLine: 'Scan result', body: scan });
      }
      // Each scan replaces the robot's Sight, and tells us where the agent is.
      this.world.setSight(scan);
      const { x, y, z } = scan.agent.position;
      this.navigator.agentMoved({ x, y, z, facing: facingFromRotation(scan.agent.yRot) });
      this.sight = sightMessage(scan);
      this._broadcast(this.sight);
      return scan;
    } catch (err) {
      this._addLog('system', `Scan failed: ${err.message}`);
      return null;
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

/**
 * Compact form of a scan for the Nanny Cam: a palette of block names plus a flat
 * [x, y, z, paletteIndex, ...] array of every non-air block (~30k blocks stay well under 1 MB).
 */
function sightMessage(scan) {
  const palette = [];
  const index = new Map();
  const blocks = [];
  for (const cell of scan.cells) {
    if (cell.block === 'Air' || cell.block === '?') continue; // '?' = couldn't be identified
    if (!index.has(cell.block)) {
      index.set(cell.block, palette.length);
      palette.push(cell.block);
    }
    blocks.push(cell.x, cell.y, cell.z, index.get(cell.block));
  }
  return { type: 'sight', agent: scan.agent, scanned: scan.cells.length, time: Date.now(), palette, blocks };
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
