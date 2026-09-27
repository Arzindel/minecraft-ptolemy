'use strict';

const WebSocket = require('ws');
const { createToolbox, sayInChat, isOwnChat } = require('../tools');
const { Pilot } = require('../llm/pilot');
const { Wonder } = require('../llm/wonder');
const { EndpointStore } = require('../llm/endpoints');
const { listModels } = require('../llm/client');
const { testEndpoint, testModel, testTools } = require('../llm/tests');
const { WorldManager } = require('../world/manager');
const { McpServer } = require('../mcp/server');
const { getAgentPose } = require('../agent/pose');
const { allPlayers } = require('../agent/players');

const POSITION_POLL_MS = 4000;

/**
 * Everything above the robot's body: world detection and memory, the LLM endpoints, the pilot
 * (Automatic mode), wondering, chat requests and MCP. The WebServer hands it UI messages, chat
 * lines and console commands it doesn't handle itself.
 */
class Brain {
  /**
   * @param {object} deps  bridge, settings, navigator, world (WorldKnowledge), scan, sight(), log, broadcast
   */
  constructor(deps) {
    Object.assign(this, deps);
    const { bridge, settings } = deps;

    this.endpoints = new EndpointStore();
    this.worlds = new WorldManager({ bridge, log: (text) => this.log(text) });

    this.toolbox = createToolbox({
      bridge,
      world: deps.world,
      navigator: deps.navigator,
      settings,
      scan: deps.scan,
      log: (text) => this.log(text),
      sight: deps.sight,
      worlds: this.worlds,
      notify: (text) => this.pilot.notice(text),
      activity: () => this.pilot.touch(),
    });
    this.pilot = new Pilot({ settings, endpoints: this.endpoints, toolbox: this.toolbox, bridge, worlds: this.worlds });
    this.wonder = new Wonder({ settings, pilot: this.pilot, bridge, worlds: this.worlds });
    this.mcp = new McpServer({ toolbox: this.toolbox, settings, bridge, worlds: this.worlds });

    this.pilot.on('entry', (entry) => this.broadcast({ type: 'pilotEntry', entry }));
    this.pilot.on('cleared', () => this.broadcast({ type: 'pilotTranscript', entries: this.pilot.transcript }));
    this.pilot.on('state', (state) => this.broadcast(state));
    // "Default replies": what the model says goes back to where the request came from.
    this.pilot.on('say', ({ text, source }) => {
      if (source === 'chat' && settings.get('chat.replies')) sayInChat(bridge, settings, text);
    });
    this.wonder.on('state', (state) => this.broadcast(state));
    this.endpoints.on('change', () => {
      this.broadcast(this.endpoints.message());
      this.broadcast(this.pilot.state());
    });

    this.worlds.on('world', (memory) => {
      const previous = this._openWorld;
      this._openWorld = memory;
      if (previous !== memory) {
        settings.setWorld(memory);
        this.pilot.switchWorld(previous, memory);
      } else if (settings.world) {
        settings.world.name = memory.name; // renamed
      }
      this.broadcast(settings.message());
      this._broadcastMemory();
      this.broadcast(this.worlds.status());
    });
    this.worlds.on('memory', () => this._broadcastMemory());
    this.worlds.on('status', () => {
      this.broadcast(this.worlds.status());
      this.broadcast(this.wonder.state());
    });

    // Work out the world whenever the game (re)connects.
    this._wasConnected = false;
    bridge.on('status', (status) => {
      if (status.connected && !this._wasConnected) {
        setTimeout(() => this.worlds.detect().catch((err) => this.log(`World detection failed: ${err.message}`)), 300);
      }
      if (!status.connected && this._wasConnected) {
        this.worlds.agent = { exists: null };
        this.worlds.detection = { state: 'waiting', message: 'Minecraft disconnected. The last world stays loaded until it reconnects.' };
        this.broadcast(this.worlds.status());
      }
      this._wasConnected = status.connected;
    });

    this.positions = null;
    this._poll = setInterval(() => this._pollPositions(), POSITION_POLL_MS);
    this._poll.unref();
  }

  /** Messages a newly opened page needs. */
  initialMessages() {
    return [
      this.endpoints.message(),
      { type: 'pilotTranscript', entries: this.pilot.transcript },
      this.pilot.state(),
      this.wonder.state(),
      this.worlds.status(),
      this._memoryMessage(),
      this.positions,
    ].filter(Boolean);
  }

  /** Something typed in the Manual console: counts as activity for the wondering countdown. */
  manualActivity() {
    this.pilot.touch();
    this.broadcast(this.wonder.state());
  }

  // --- In-game chat ---------------------------------------------------------------

  /**
   * A chat message is a request when it contains the wake word ("Ptolemy") and not the ignore
   * word ("Ptoless", for talking about the robot without calling it). "Ptolemy, stop" stops it.
   */
  chat(sender, message, type) {
    const { settings } = this;
    if (!settings.get('chat.enabled') || typeof message !== 'string') return;
    if (isOwnChat(message) || /^tellraw$/i.test(type || '')) return;
    const name = (settings.get('chat.name') || '').trim();
    const ignore = (settings.get('chat.ignore') || '').trim();
    if (!name) return;
    if (!new RegExp(`\\b${escapeRe(name)}\\b`, 'i').test(message)) return;
    if (ignore && message.toLowerCase().includes(ignore.toLowerCase())) return;

    const rest = message.replace(new RegExp(`[@!]?\\b${escapeRe(name)}\\b[\\s,:;!.?-]*`, 'ig'), ' ').trim();
    const reply = (text) => settings.get('chat.replies') && sayInChat(this.bridge, settings, text);
    if (/^(stop|halt|cancel|enough)[.!]*$/i.test(rest)) {
      reply(this.pilot.stop() ? 'Stopping.' : 'I wasn\'t doing anything.');
      return;
    }
    if (!rest) {
      reply(`Yes? Say "${name}, <what to do>".`);
      return;
    }
    this.wonder.personRequested();
    this.pilot.send(message, { source: 'chat', sender });
  }

  // --- UI messages -----------------------------------------------------------------

  /** Returns true if the message was handled here. */
  handle(ws, msg) {
    const reply = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    const e = this.endpoints;
    switch (msg.type) {
      case 'pilotSend':
        this.wonder.personRequested();
        this.pilot.send(msg.text, { source: 'ui' });
        return true;
      case 'pilotStop':
        this.pilot.stop();
        return true;
      case 'pilotReset':
        this.pilot.reset();
        return true;
      case 'wonderMode':
        this.wonder.setMode(msg.mode);
        return true;
      case 'endpointActive':
        e.setActive(msg.id);
        return true;
      case 'endpointUpdate':
        e.update(msg.id, msg.patch || {});
        return true;
      case 'endpointKey':
        e.setKey(msg.id, msg.key);
        return true;
      case 'endpointAdd':
        e.add(msg.preset);
        return true;
      case 'endpointRemove':
        e.remove(msg.id);
        return true;
      case 'endpointModels':
        this._models(msg.id, reply).catch((err) => this.log(`Listing models failed: ${err.message}`));
        return true;
      case 'endpointTest':
        this._test(msg.id, msg.kind).catch((err) => this.log(`Endpoint test failed: ${err.message}`));
        return true;
      case 'memory':
        this._memoryOp(msg).catch((err) => reply({ type: 'memoryError', message: err.message }));
        return true;
      default:
        return false;
    }
  }

  async _models(id, reply) {
    if (!this.endpoints.get(id)) return;
    const config = this.endpoints.config(id);
    try {
      reply({ type: 'endpointModels', id, models: await listModels(config) });
      this.endpoints.setTest(id, 'endpoint', { ok: true, message: 'Reachable (model list fetched).' });
    } catch (err) {
      reply({ type: 'endpointModels', id, error: err.message });
      this.endpoints.setTest(id, 'endpoint', { ok: false, message: err.message });
    }
  }

  async _test(id, kind) {
    if (!this.endpoints.get(id)) return;
    const run = { endpoint: testEndpoint, model: testModel, mcp: testTools }[kind];
    if (!run) return;
    this.endpoints.setTest(id, kind, { running: true, message: 'Testing...' });
    const { models, ...result } = await run(this.endpoints.config(id));
    this.endpoints.setTest(id, kind, result);
    this.log(`Test ${kind} of ${this.endpoints.get(id).name}: ${result.ok ? 'passed' : 'failed'}. ${result.message}`);
  }

  async _memoryOp(msg) {
    const w = this.worlds;
    switch (msg.op) {
      case 'detect': await w.detect(); return;
      case 'claim': await w.claim(String(msg.id)); return;
      case 'deleteWorld': w.deleteWorld(String(msg.id)); return;
      case 'agentCreate':
        await this.bridge.sendCommand('agent create');
        await w.checkAgent();
        return;
      case 'toDefaults':
        this.settings.worldToDefaults();
        this.log('This world\'s robot & path settings are now the defaults for new worlds.');
        return;
      default: break;
    }
    const m = w.current;
    if (!m) throw new Error('No world is loaded yet: connect Minecraft first.');
    switch (msg.op) {
      case 'rename': w.rename(msg.name); break;
      case 'instructions': m.setInstructions(msg.text); break;
      case 'areaSet': m.setArea(msg.name, msg.a, msg.b || msg.a, msg.note); break;
      case 'areaAround': {
        // An area around the robot or the player, e.g. "this room" while standing in it.
        const r = Math.max(0, Math.min(64, Math.round(Number(msg.radius) || 0)));
        const p = msg.who === 'player' ? await this._playerPosition() : await getAgentPose(this.bridge);
        if (!p) throw new Error('couldn\'t get that position');
        m.setArea(msg.name, [p.x - r, p.y - (msg.who === 'player' ? 1 : 0), p.z - r], [p.x + r, p.y + Math.max(r, 2), p.z + r], msg.note);
        break;
      }
      case 'areaRemove': m.removeArea(msg.name); break;
      case 'todoAdd': m.addTodo(msg.text); break;
      case 'todoUpdate': m.updateTodo(msg.id, msg); break;
      case 'todoRemove': m.removeTodo(msg.id); break;
      case 'todoClearDone': m.clearDoneTodos(); break;
      case 'thoughtAdd': m.addThought(msg.text); break;
      case 'thoughtRemove': m.remove('thoughts', msg.id); break;
      case 'noteAdd': m.addNote(msg.text); break;
      case 'noteRemove': m.remove('notes', msg.id); break;
      default: throw new Error(`unknown memory operation "${msg.op}"`);
    }
  }

  // --- Console commands ----------------------------------------------------------

  /** #area, #boundary, #world, #wonder, #ask, #endpoint. Returns true if handled. */
  console(name, args, text) {
    const say = (line) => this.log(line);
    const m = this.worlds.current;
    switch (name) {
      case 'ask':
        if (!args.length) say('Usage: #ask <request for the LLM>');
        else {
          this.wonder.personRequested();
          this.pilot.send(text.replace(/^\S+\s*/, ''), { source: 'ui' });
        }
        return true;
      case 'wonder':
        if (['off', 'on', 'always'].includes(args[0])) this.wonder.setMode(args[0]);
        say(`Wondering is ${this.wonder.mode}${['off', 'on', 'always'].includes(args[0]) ? '' : '. Usage: #wonder off|on|always'}.`);
        return true;
      case 'world':
        if (!m) say('No world is loaded yet.');
        else if (args.length) {
          this.worlds.rename(args.join(' '));
          say(`This world is now called "${m.name}".`);
        } else say(`World "${m.name}" (${m.id}). ${this.worlds.detection.message} Rename it with #world <name>.`);
        return true;
      case 'boundary':
      case 'area': {
        if (!m) {
          say('No world is loaded yet: connect Minecraft first.');
          return true;
        }
        // #boundary <name> x1 x2 y1 y2 z1 z2 (the original ranges syntax) and
        // #area add <name> x1 y1 z1 x2 y2 z2 (two corners), #area remove <name>, #area list.
        const sub = name === 'boundary' ? 'ranges' : (args[0] || 'list').toLowerCase();
        const rest = name === 'boundary' ? args : args.slice(1);
        try {
          if (sub === 'list') {
            say(m.data.areas.length ? `Areas:\n${m.data.areas.map((a) => {
              const parent = m.parentOf(a);
              return `  ${a.name}: ${a.min.join(' ')} to ${a.max.join(' ')}${parent ? ` (in ${parent.name})` : ''}`;
            }).join('\n')}` : 'No areas yet. #area add <name> x1 y1 z1 x2 y2 z2');
          } else if (sub === 'remove') {
            say(m.removeArea(rest.join(' ')) ? `Removed "${rest.join(' ')}".` : `No area called "${rest.join(' ')}".`);
          } else if (sub === 'add' || sub === 'ranges') {
            const nums = rest.filter((a) => /^-?\d+$/.test(a)).map(Number);
            const label = rest.filter((a) => !/^-?\d+$/.test(a)).join(' ');
            if (!label || nums.length !== 6) throw new Error(name === 'boundary'
              ? 'usage: #boundary <name> x1 x2 y1 y2 z1 z2'
              : 'usage: #area add <name> x1 y1 z1 x2 y2 z2');
            const [a, b] = sub === 'ranges'
              ? [[nums[0], nums[2], nums[4]], [nums[1], nums[3], nums[5]]]
              : [nums.slice(0, 3), nums.slice(3)];
            const area = m.setArea(label, a, b);
            const parent = m.parentOf(area);
            say(`Area "${area.name}": ${area.min.join(' ')} to ${area.max.join(' ')}${parent ? `, inside "${parent.name}"` : ''}.`);
          } else {
            say('Usage: #area list | #area add <name> x1 y1 z1 x2 y2 z2 | #area remove <name> | #boundary <name> x1 x2 y1 y2 z1 z2');
          }
        } catch (err) {
          say(err.message);
        }
        return true;
      }
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------------

  async _playerPosition() {
    const res = await this.bridge.sendCommand('querytarget @s', { quiet: true });
    try {
      const p = JSON.parse(res.body.details)[0].position;
      return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    } catch {
      return null;
    }
  }

  /** Robot and player positions (and which areas they're in) for the Dashboard. */
  async _pollPositions() {
    if (!this.bridge.connected || !this.worlds.current) return;
    const m = this.worlds.current;
    let robot = null;
    try {
      const pose = await getAgentPose(this.bridge);
      robot = { x: pose.x, y: pose.y, z: pose.z, facing: ['south', 'west', 'north', 'east'][pose.facing], areas: m.describeAreasAt(pose.x, pose.y, pose.z) };
      if (this.worlds.agent.exists !== true) {
        this.worlds.agent = { exists: true };
        this.broadcast(this.worlds.status());
      }
    } catch { /* no agent */ }
    const everyone = await allPlayers(this.bridge).catch(() => []);
    const list = everyone.map((p) => ({ ...p, areas: m.describeAreasAt(p.x, p.y, p.z) || m.describeAreasAt(p.x, p.y - 1, p.z), host: p.name === this.bridge.player }));
    this.positions = { type: 'positions', robot, players: list, time: Date.now() };
    this.broadcast(this.positions);
  }

  _memoryMessage() {
    return { type: 'memory', world: this.worlds.current ? this.worlds.current.toJSON() : null };
  }

  _broadcastMemory() {
    this.broadcast(this._memoryMessage());
  }

  close() {
    clearInterval(this._poll);
    this.wonder.close();
    if (this.worlds.current) this.worlds.current.save();
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { Brain };
