'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { scanAroundAgent, formatScan } = require('../agent/scan');
const { WorldMap, CLEAR } = require('../world/map');
const { Navigator, pathMessage, METHODS } = require('../agent/navigator');
const { Settings } = require('../settings');
const { getAgentPose, facingFromRotation } = require('../agent/pose');
const {
  nearbyEntities, countsText, entityRadius, entitiesMessage, MAX_ENTITIES, MAX_RADIUS: MAX_ENTITY_RADIUS, WHAT,
} = require('../agent/entities');
const { MAX_IN_FLIGHT_LIMIT } = require('../minecraft/bridge');
const { Vision } = require('../agent/vision');
const { Brain } = require('./brain');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const SRC_DIR = path.join(__dirname, '..');
const STARTED_AT = Date.now();
const LOG_HISTORY = 500;
const MAX_SCAN_RADIUS = 15; // 31x31x31, about 30 seconds
// The Nanny Cam gets the map this far around the robot (its Zoom goes up to here), and a fresh copy
// once the robot has moved REGION_MOVE blocks from where the last one was centered. Only what the map
// knows is sent (air left out), so a big radius costs what's been seen, not the whole cube.
const MAP_VIEW_RADIUS = 100;
const REGION_MOVE = 16;
// Map changes are sent in batches; a batch bigger than this (a big scan) sends the whole region instead.
const MAP_BATCH_MS = 100;
const MAP_BATCH_LIMIT = 4000;

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
    this.sight = null; // { agent, scanned, time } of the latest scan
    this.entities = null; // the latest look for entities, for the Nanny Cam
    this.agent = null; // { position, yRot } of the robot, as last seen
    this.world = new WorldMap(); // everything the robot has seen, saved per world
    this._region = null; // center of the map region the Nanny Cam has
    this._pendingCells = [];
    this._mapTimer = null;

    // Tunables from the Configuration tab, saved in data/settings.json.
    this.settings = new Settings();
    const applySettings = () => { bridge.maxInFlight = this.settings.get('bridge.maxInFlight'); };
    applySettings();
    this.settings.on('change', () => {
      applySettings();
      this._broadcast(this.settings.message());
    });

    // Vision: a small look around after every step and action (and when idle), into the map.
    this.vision = new Vision({
      bridge, world: this.world, settings: this.settings, busy: () => this.navigator.busy, enabled: () => this._agentReady(),
    });
    this.vision.on('look', (look) => this._onLook(look));
    this.vision.on('moved', (pose) => {
      // The robot moved without Ptolemy moving it (by hand, or a teleport).
      this.navigator.agentMoved(pose);
      this._agentAt({ position: { x: pose.x, y: pose.y, z: pose.z }, yRot: pose.yRot });
    });
    this.vision.start();

    this.navigator = new Navigator({
      bridge,
      world: this.world,
      settings: this.settings,
      scan: (radius, opts) => this._scan(radius, opts),
      log: (text, extra) => this._addLog('system', text, extra),
      vision: this.vision,
      broadcast: (message) => {
        if (message.type === 'agent') this._agentAt(message, { broadcast: false });
        this._broadcast(message);
      },
    });

    // Everything seen goes to the map; the Nanny Cam gets the changes near the robot.
    this.world.on('change', (cells) => this._mapChanged(cells));
    this.world.on('reset', () => this._sendRegion());
    this.nextLogId = 1;

    // Worlds and their memory, LLM endpoints, Automatic mode, wondering, chat requests, MCP.
    this.brain = new Brain({
      bridge,
      settings: this.settings,
      navigator: this.navigator,
      world: this.world,
      vision: this.vision,
      scan: (radius, opts) => this._scan(radius, opts),
      lookForEntities: (radius, opts) => this._entities(radius, opts),
      sight: () => this.sight,
      log: (text) => this._addLog('system', text),
      broadcast: (message) => this._broadcast(message),
    });

    this.http = http.createServer((req, res) => {
      if (new URL(req.url, 'http://localhost').pathname === '/mcp') this.brain.mcp.handleHttp(req, res);
      else this._serveStatic(req, res);
    });
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
    bridge.on('chat', ({ sender, message, type }) => {
      this._addLog('chat', message, { sender });
      this.brain.chat(sender, message, type);
    });
    // An agent command that worked (typed in the console, say) means the agent exists now.
    bridge.on('response', (res) => {
      if (res.ok && /^agent\s/i.test(res.commandLine)) this.brain.agentSeen();
    });
    // Moving the agent by hand invalidates stored paths (the walker's own commands are quiet).
    bridge.on('response', (res) => {
      if (!res.ok || !/^agent (move|turn|tp|teleport)\b/i.test(res.commandLine)) return;
      getAgentPose(bridge).then((pose) => {
        this.navigator.agentMoved(pose);
        this.vision.robotAt(pose);
        this.vision.soon();
        this._agentAt({ position: { x: pose.x, y: pose.y, z: pose.z }, yRot: pose.yRot });
      }, () => {});
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

  listen(port = this.port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.http.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.http.removeListener('error', onError);
        this.port = port;
        resolve();
      };
      this.http.once('error', onError);
      this.http.once('listening', onListening);
      this.http.listen(port);
    });
  }

  close() {
    this.vision.stop();
    this.world.flush();
    this.brain.close();
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
    if (this.agent) ws.send(JSON.stringify(this._regionMessage()));
    if (this.vision.last && this.vision.last.center) ws.send(JSON.stringify(visionMessage(this.vision.last)));
    if (this.entities) ws.send(JSON.stringify(this.entities));
    ws.send(JSON.stringify(this.settings.message()));
    ws.send(JSON.stringify(pathMessage('walk', this.navigator.paths.walk)));
    ws.send(JSON.stringify(pathMessage('fly', this.navigator.paths.fly)));
    for (const message of this.brain.initialMessages()) {
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        this._addLog('system', `Couldn't send the page its ${message.type}: ${err.message}`);
      }
    }

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
          this.brain.manualActivity();
          break;
        case 'scan': {
          const radius = Number(msg.radius);
          const what = WHAT.includes(msg.what) ? msg.what : 'both';
          // The Scan radius box is for blocks; entities alone are looked for at the default distance.
          this._look(what === 'entities' ? null : Number.isInteger(radius) && radius >= 1 && radius <= MAX_SCAN_RADIUS
            ? radius : this.settings.get('scan.radius'), what);
          break;
        }
        case 'settings':
          this.settings.update(msg.values);
          break;
        case 'settingsReset':
          this.settings.reset();
          this._addLog('system', 'Configuration reset to defaults.');
          break;
        case 'disconnect':
          this.bridge.disconnect();
          break;
        case 'settingsWorldToDefaults':
          this.settings.worldToDefaults();
          break;
        default:
          this.brain.handle(ws, msg);
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
    if (this.brain.console(name.toLowerCase(), args, text)) return;

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
        // #scan [radius] [blocks|entities|both], in any order
        const what = args.find((a) => WHAT.includes(a.toLowerCase()))?.toLowerCase() || 'both';
        const given = args.find((a) => !WHAT.includes(a.toLowerCase()));
        const radius = given !== undefined ? Number(given) : null;
        const max = what === 'entities' ? MAX_ENTITY_RADIUS : MAX_SCAN_RADIUS;
        if (args.length > 2 || (radius !== null && !(Number.isInteger(radius) && radius >= 1 && radius <= max))) {
          say(`Usage: #scan [radius] [blocks|entities|both]. blocks: a cube around the agent (radius 1-${MAX_SCAN_RADIUS}, `
            + `2 = 5x5x5; default ${this.settings.get('scan.radius')}). entities: mobs, animals, players and dropped items `
            + `(radius 1-${MAX_ENTITY_RADIUS}, default 16). both (the default): the two at once.`);
          return;
        }
        this._look(radius ?? (what === 'entities' ? null : this.settings.get('scan.radius')), what);
        return;
      }
      case 'survey': {
        // #survey [radius]: the survey tool (gettopsolidblock on every column), its report in the log.
        const radius = args[0] !== undefined ? Number(args[0]) : undefined;
        if (args.length > 1 || (radius !== undefined && !(Number.isInteger(radius) && radius >= 1 && radius <= 24))) {
          say('Usage: #survey [radius]: the height of every column around the agent, up to 24 blocks out (default 8).');
          return;
        }
        this.brain.toolbox.call('survey', radius === undefined ? {} : { radius }, { origin: 'Console' })
          .then((res) => say(res.text));
        return;
      }
      case 'inflight': {
        const n = Number(args[0]);
        if (args[0] && Number.isInteger(n) && n >= 1) {
          if (n > MAX_IN_FLIGHT_LIMIT) {
            say(`Bedrock drops every command beyond ${MAX_IN_FLIGHT_LIMIT} in flight, so the limit stays at ${MAX_IN_FLIGHT_LIMIT}.`);
          }
          this.settings.update({ 'bridge.maxInFlight': Math.min(n, MAX_IN_FLIGHT_LIMIT) });
        }
        say(`Up to ${this.bridge.maxInFlight} commands are sent to Minecraft at once`
          + (args[0] ? '' : `. Usage: #inflight <1-${MAX_IN_FLIGHT_LIMIT}>`));
        return;
      }
      case 'pathfind':
      case 'flypathfind':
        this.navigator.pathfind(args.filter((a) => !/^(near|exact)$/i.test(a)), {
          fly: name.toLowerCase().startsWith('fly'),
          near: args.some((a) => /^near$/i.test(a)) ? true : args.some((a) => /^exact$/i.test(a)) ? false : null,
        });
        return;
      case 'pathwalk':
      case 'flypathwalk':
        this.navigator.pathwalk({ fly: name.toLowerCase().startsWith('fly') });
        return;
      case 'pathfindwalk':
      case 'flypathfindwalk': {
        // #pathfindwalk x y z [scan=7] [retries=3] [method=auto]   (scan = rescan radius)
        const opts = {
          scanRadius: this.settings.get('path.scanRadius'),
          retries: this.settings.get('path.retries'),
          fly: name.toLowerCase().startsWith('fly'),
        };
        const coords = [];
        for (const arg of args) {
          const m = /^(scan|retries)=(\d+)$/.exec(arg);
          const how = /^method=(\w+)$/i.exec(arg);
          if (/^(near|exact)$/i.test(arg)) opts.near = arg.toLowerCase() === 'near';
          else if (how) opts.method = how[1].toLowerCase();
          else if (!m) coords.push(arg);
          else if (m[1] === 'scan') opts.scanRadius = Number(m[2]);
          else opts.retries = Number(m[2]);
        }
        if (opts.method && opts.method !== 'auto' && !METHODS[opts.method]) {
          say(`method= is one of: auto, ${Object.keys(METHODS).map((k) => `${k} (${METHODS[k]})`).join(', ')}.`);
          return;
        }
        if (opts.scanRadius < 1 || opts.scanRadius > MAX_SCAN_RADIUS) {
          say(`scan= is the rescan radius, from 1 to ${MAX_SCAN_RADIUS}.`);
          return;
        }
        this.navigator.pathfindwalk(coords, opts);
        return;
      }
      case 'map': {
        if (args[0] === 'forget') {
          this.world.clear();
          say('Forgot this world\'s map. The robot starts seeing it again from scratch.');
          return;
        }
        const st = this.world.stats();
        say(`The map of this world: ${st.columnsOnDisk} chunk columns saved`
          + `${this.world.dir ? '' : ' (not saved: no world detected yet)'}, ${st.columnsInRam} in memory `
          + `(${st.subChunksInRam} sub-chunks of 16x16x16). #map forget wipes it.`);
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
        // Descriptions come from the Commands tab, where they can be edited.
        say(`Console commands (anything not starting with # goes to Minecraft):\n${this.brain.commands.helpLines().join('\n')}`);
        return;
      default:
        say(`Unknown console command "#${name}". Try #help.`);
    }
  }

  /** The connected player has an agent (so asking where it is won't create one). */
  _agentReady() {
    return Boolean(this.brain && this.brain.agentReady());
  }

  /** Scan around the agent and make the result its Sight. `quiet` logs one line instead of the layers. */
  async _scan(radius, { quiet = false } = {}) {
    if (!this.bridge.connected) {
      this._addLog('system', 'Scan needs Minecraft to be connected.');
      return null;
    }
    if (!this._agentReady()) {
      this._addLog('system', 'There\'s no agent yet: create it first (the Create Agent button), then scan.');
      return null;
    }
    if (!quiet) this._addLog('system', 'Scanning around the agent...');
    try {
      const scan = await scanAroundAgent(this.bridge, { radius });
      if (quiet) {
        const { x, y, z } = scan.agent.position;
        this._addLog('system', `Scanned ${scan.cells.length} blocks around ${x} ${y} ${z} `
          + `in ${(scan.tookMs / 1000).toFixed(1)}s.`);
      } else {
        this._addLog('system', formatScan(scan), { commandLine: 'Scan result', body: scan });
      }
      // Each scan goes into the map, and tells us where the agent is.
      const { x, y, z } = scan.agent.position;
      const pose = { x, y, z, facing: facingFromRotation(scan.agent.yRot), yRot: scan.agent.yRot };
      this.navigator.agentMoved(pose);
      this.vision.robotAt(pose);
      this.sight = { agent: scan.agent, scanned: scan.cells.length, time: Date.now() };
      this._agentAt({ position: scan.agent.position, yRot: scan.agent.yRot });
      this.world.setSight(scan);
      return scan;
    } catch (err) {
      this._addLog('system', `Scan failed: ${err.message}`);
      return null;
    }
  }

  /** Scan blocks, look for entities, or both at once (#scan, the Nanny Cam's Scan button). */
  async _look(radius, what = 'both') {
    await Promise.all([
      what !== 'entities' && this._scan(radius),
      what !== 'blocks' && this._entities(entityRadius(radius, what)),
    ]);
  }

  /**
   * Look for mobs, animals, players and dropped items around the agent, and show them in the Nanny
   * Cam. The log entry carries every command reply behind the list, to check how they were matched up.
   * Resolves to { pose, entities } (nearest first), or null if it failed.
   */
  async _entities(radius, { quiet = false } = {}) {
    if (!this.bridge.connected) {
      this._addLog('system', 'Looking for entities needs Minecraft to be connected.');
      return null;
    }
    if (!this._agentReady()) {
      this._addLog('system', 'There\'s no agent yet: create it first (the Create Agent button), then look for entities.');
      return null;
    }
    try {
      const pose = await getAgentPose(this.bridge);
      const { entities, raw } = await nearbyEntities(this.bridge, pose, radius);
      const where = `within ${radius} blocks of the agent at ${pose.x} ${pose.y} ${pose.z}`;
      const summary = entities.length
        ? `${entities.length}${entities.length === MAX_ENTITIES ? '+' : ''} entities ${where}: ${countsText(entities)}`
        : `No entities ${where}.`;
      const lines = entities.map((e) => `${e.name}${e.hostile ? ' (hostile)' : ''}${e.type ? ` [${e.type}]` : ''}: `
        + `${e.x} ${e.y} ${e.z}, ${e.distance.toFixed(1)} blocks`);
      this._addLog('system', quiet || !lines.length ? summary : `${summary}\n${lines.join('\n')}`,
        { commandLine: 'Entities', body: { entities, raw } });
      this.entities = entitiesMessage({ x: pose.x, y: pose.y, z: pose.z, yRot: pose.yRot }, radius, entities);
      this._broadcast(this.entities);
      return { pose, entities };
    } catch (err) {
      this._addLog('system', `Looking for entities failed: ${err.message}`);
      return null;
    }
  }

  // --- The map, as the Nanny Cam sees it ---------------------------------------------

  /** The robot is here: remember it, and send the Nanny Cam a fresh region if it went far. */
  _agentAt({ position, yRot }, { broadcast = true } = {}) {
    this.agent = { position: { x: position.x, y: position.y, z: position.z }, yRot };
    if (broadcast) this._broadcast({ type: 'agent', position: this.agent.position, yRot });
    const r = this._region;
    if (!r || Math.max(Math.abs(r.x - position.x), Math.abs(r.y - position.y), Math.abs(r.z - position.z)) >= REGION_MOVE) {
      this._sendRegion();
    }
  }

  _mapChanged(cells) {
    if (!this._region) return;
    for (const c of cells) this._pendingCells.push(c);
    if (!this._mapTimer) this._mapTimer = setTimeout(() => this._flushMapChanges(), MAP_BATCH_MS);
  }

  _flushMapChanges() {
    this._mapTimer = null;
    const cells = this._pendingCells;
    this._pendingCells = [];
    if (cells.length > MAP_BATCH_LIMIT) {
      this._sendRegion();
      return;
    }
    const r = this._region;
    const near = cells.filter(([x, y, z]) => Math.max(Math.abs(x - r.x), Math.abs(y - r.y), Math.abs(z - r.z)) <= MAP_VIEW_RADIUS);
    if (near.length) this._broadcast({ type: 'mapCells', ...packCells(near) });
  }

  _sendRegion() {
    if (!this.agent) return;
    clearTimeout(this._mapTimer);
    this._mapTimer = null;
    this._pendingCells = [];
    this._broadcast(this._regionMessage());
  }

  /** Every known block within MAP_VIEW_RADIUS of the robot (air left out), for the Nanny Cam. */
  _regionMessage() {
    const { x, y, z } = this.agent.position;
    this._region = { x, y, z };
    const r = MAP_VIEW_RADIUS;
    const cells = [];
    this.world.forEachIn([x - r, y - r, z - r], [x + r, y + r, z + r], (cx, cy, cz, name) => {
      if (name !== 'Air' && name !== CLEAR) cells.push([cx, cy, cz, name]);
    });
    return { type: 'map', center: { x, y, z }, radius: r, agent: this.agent, time: Date.now(), ...packCells(cells) };
  }

  _onLook(look) {
    this._broadcast(visionMessage(look));
    if (look.entities) {
      this.entities = entitiesMessage({ ...look.robot, yRot: this.agent ? this.agent.yRot : 0 }, look.entityRadius, look.entities);
      this._broadcast(this.entities);
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
 * Cells for the WebUI: a palette of block names plus a flat [x, y, z, paletteIndex, ...] array
 * ("Air" is a name too: a cell that turned out empty).
 */
function packCells(cells) {
  const palette = [];
  const index = new Map();
  const blocks = [];
  for (const [x, y, z, name] of cells) {
    if (!index.has(name)) {
      index.set(name, palette.length);
      palette.push(name);
    }
    blocks.push(x, y, z, index.get(name));
  }
  return { palette, blocks };
}

/** Where Vision looked last, for the Nanny Cam's Vision filter. */
function visionMessage({ center, radius, robot, time }) {
  return { type: 'vision', center, radius, robot, time };
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
