'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Everything that can be run, in one list for the WebUI's Commands tab:
//   - tools:  what the LLM (and MCP clients) call. Their descriptions ARE what the model reads.
//   - hash:   Ptolemy's own #console commands. Their descriptions are what #help prints.
//   - slash:  Minecraft commands useful with the robot. Those marked "in prompt" are listed in the
//             system prompt as things the model may run with run_command.
// Every description can be edited in the WebUI; edits are saved in data/commands.json.

const FILE = path.join(__dirname, '..', 'data', 'commands.json');

const HASH = [
  ['help', '', 'List these commands.'],
  ['ask', '<request>', 'Give the LLM a request, as if typed in the Automatic panel.'],
  ['scan', '[radius] [blocks|entities|both]', 'Look around the agent. blocks: identify every block in a cube (radius 2 = 5x5x5, up to 15; without a radius, the configured default). entities: mobs, animals, players and dropped items (default 16 blocks, up to 48), with the raw replies behind the list. both (the default): the two at once. Both show up in the Nanny Cam.'],
  ['survey', '[radius]', 'A view of the land from above: gettopsolidblock on every column around the agent (default 8 blocks out = 17x17 columns, up to 24), as a grid of heights, with cliffs, walls and trees called out. Sees how far down a cliff goes or how high a wall or tree is, which a #scan cube misses. The same as the LLM\'s survey tool; what it finds goes on the map.'],
  ['pathfind', '<x y z | @p [name]> [near|exact]', 'Plan a route that stays next to blocks. ~ = relative to the agent; @p = a player (near them unless exact).'],
  ['pathwalk', '', 'Walk the last planned route, checking the agent\'s position after every step.'],
  ['pathfindwalk', '<x y z | @p [name]> [near|exact] [scan=7] [retries=3] [method=auto|surface|corridor|lookahead|rescan]', 'Plan and walk. surface (the default when walking): measure the ground along the way first and check the path before walking it; corridor (the default when flying, and the fallback for caves): scan five tubes between here and there, then look ahead; lookahead: scan where the plan meets the unknown before moving; rescan: rescan around the robot at the edge of what it knows.'],
  ['flypathfind', '<x y z | @p [name]>', 'Like #pathfind, but the shortest route through the air.'],
  ['flypathwalk', '', 'Walk the last planned flight path.'],
  ['flypathfindwalk', '<x y z | @p [name]>', 'Like #pathfindwalk, flying.'],
  ['pathsafe', 'on|off', 'Safe mode: wait up to 2s for the agent after each step before calling it a failure.'],
  ['pathstop', '', 'Stop a running walk after the current step.'],
  ['wonder', 'off|on|always', 'Switch wondering: the robot acting on its own when idle.'],
  ['map', '[forget]', 'How much of this world the robot has mapped; "forget" wipes its map.'],
  ['world', '[new name]', 'Show which world Ptolemy thinks it\'s in, or rename it.'],
  ['area', 'list | add <name> x1 y1 z1 x2 y2 z2 | remove <name>', 'Named areas of this world, by two opposite corners.'],
  ['boundary', '<name> x1 x2 y1 y2 z1 z2', 'Add a named area with the coordinates given as ranges.'],
  ['inflight', '<n>', 'How many commands may be waiting for an answer at once (at most 100).'],
  ['subscribe', '<Event> [Event...]', 'Subscribe to game events, e.g. BlockBroken ItemUsed. They show up as ⚡ lines.'],
  ['unsubscribe', '<Event> [Event...]', 'Stop receiving those events.'],
  ['subscriptions', '', 'List the current event subscriptions.'],
  ['probe', '[all]', 'Run every read-only agent command and list what each returns.'],
  ['cmdversion', '<1 | 1.21.0 | off>', 'The command syntax version sent with every command.'],
  ['raw', '<json>', 'Send a hand-written WebSocket message to the game.'],
];

// [command, usage, description, in prompt by default]
const SLASH = [
  ['agent move', '<forward|back|left|right|up|down>', 'Move the agent one block. Reports success even when blocked.', false],
  ['agent turn', '<left|right>', 'Turn the agent 90 degrees.', false],
  ['agent destroy', '<direction>', 'Break the block beside the agent.', false],
  ['agent place', '<slot> <direction>', 'Place a block from an inventory slot (1-27) beside the agent.', false],
  ['agent attack', '<direction>', 'Attack whatever is beside the agent.', false],
  ['agent collect', '<item|all>', 'Pick up dropped items near the agent.', false],
  ['agent drop', '<slot> <quantity> <direction>', 'Drop items from an inventory slot.', false],
  ['agent dropall', '<direction>', 'Drop everything in the agent\'s inventory in a direction.', true],
  ['agent till', '<direction>', 'Till the dirt or grass block beside the agent into farmland.', true],
  ['agent transfer', '<source slot> <quantity> <destination slot>', 'Move items between the agent\'s own inventory slots.', true],
  ['agent tp', '[x y z]', 'Teleport the agent to its owner, or to world coordinates. Only when a player asked for a teleport.', false],
  ['agent create', '', 'Create the agent for this player if it doesn\'t exist yet.', true],
  ['agent getposition', '', 'The agent\'s world position and rotation.', false],
  ['agent detect / inspect / inspectdata', '<direction>', 'Meant to sense blocks, but return no data in regular Bedrock.', false],
  ['testforblock', '<x y z> <block>', 'Checks one block; Ptolemy uses it (with "air") to identify blocks.', false],
  ['querytarget', '<selector>', 'Position of players or entities (not what they are); Ptolemy uses it to find players and mobs.', false],
  ['testfor', '<selector>', 'Names of the entities a selector matches, e.g. testfor @e[type=cow,r=10]; Ptolemy uses it to tell mobs apart.', false],
  ['list', '', 'Who is online.', false],
  ['tellraw', '@a <json>', 'Send a formatted chat message; Ptolemy uses it for the robot\'s chat lines.', false],
  ['gettopsolidblock', '<x y z>', 'The first solid block below a position (sees through air, leaves and water); Ptolemy uses it to measure the ground and for survey.', false],
  ['time query', '<daytime|gametime|day>', 'Read the time (daytime: 0 = 06:00, 6000 = noon). Ptolemy reads it for the [Now] block and {time_now}.', false],
  ['weather query', '', 'Read the weather (clear, rain or thunder).', false],
  ['time set', '<day|night|noon|midnight|value>', 'Set the time of day.', false],
  ['weather', '<clear|rain|thunder> [duration]', 'Change the weather.', false],
  ['tickingarea', 'add|remove|list ...', 'Keep chunks loaded even without a player nearby.', false],
  ['scoreboard objectives', 'add|remove|list ...', 'Scoreboards; Ptolemy keeps a ptolemy_<id> objective to recognise the world.', false],
];

class CommandCatalog extends EventEmitter {
  /** @param {{ tools: Array<{name, description, parameters, raw?, destructive?, teleport?, offline?}> }} deps */
  constructor({ tools }) {
    super();
    this.tools = tools;
    this.overrides = { tools: {}, hash: {}, slash: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      for (const kind of Object.keys(this.overrides)) Object.assign(this.overrides[kind], saved[kind] || {});
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[commands] Ignoring ${FILE}: ${err.message}`);
    }
  }

  /** The description the LLM gets for a tool: the edited one, else its own. */
  toolDescription(name, fallback) {
    const o = this.overrides.tools[name];
    return (o && o.description) || fallback;
  }

  hashDescription(name) {
    const o = this.overrides.hash[name];
    const def = HASH.find((h) => h[0] === name);
    return (o && o.description) || (def && def[2]) || '';
  }

  /** "#name usage: description" lines for #help. */
  helpLines() {
    return HASH.map(([name, usage]) => `#${name}${usage ? ` ${usage}` : ''}: ${this.hashDescription(name)}`);
  }

  /** Minecraft commands to list in the system prompt, with their (possibly edited) descriptions. */
  promptCommands() {
    return SLASH.map(([cmd, usage, description, inPrompt]) => {
      const o = this.overrides.slash[cmd] || {};
      return { cmd, usage, description: o.description || description, inPrompt: o.inPrompt ?? inPrompt };
    }).filter((c) => c.inPrompt);
  }

  /** Edit one entry: { description } (empty = back to the default) and, for slash commands, { inPrompt }. */
  update(kind, name, patch) {
    if (!this.overrides[kind]) throw new Error(`unknown command kind "${kind}"`);
    if (!this._exists(kind, name)) throw new Error(`unknown command "${name}"`);
    const o = { ...(this.overrides[kind][name] || {}) };
    if (typeof patch.description === 'string') {
      const text = patch.description.trim().slice(0, 2000);
      if (text && text !== this._default(kind, name)) o.description = text;
      else delete o.description;
    }
    if (kind === 'slash' && typeof patch.inPrompt === 'boolean') {
      if (patch.inPrompt === SLASH.find((s) => s[0] === name)[3]) delete o.inPrompt;
      else o.inPrompt = patch.inPrompt;
    }
    if (Object.keys(o).length) this.overrides[kind][name] = o;
    else delete this.overrides[kind][name];
    this._save();
  }

  resetAll() {
    this.overrides = { tools: {}, hash: {}, slash: {} };
    this._save();
  }

  message() {
    const edited = (kind, name) => Boolean(this.overrides[kind][name]);
    return {
      type: 'commands',
      tools: this.tools.map((t) => ({
        name: t.name,
        description: this.toolDescription(t.name, t.description),
        defaultDescription: t.description,
        params: paramSummary(t.parameters),
        tags: [t.raw && 'raw', t.destructive && 'destructive', t.teleport && 'only when asked to teleport', t.offline && 'works offline'].filter(Boolean),
        edited: edited('tools', t.name),
      })),
      hash: HASH.map(([name, usage, description]) => ({
        name, usage, description: this.hashDescription(name), defaultDescription: description, edited: edited('hash', name),
      })),
      slash: SLASH.map(([cmd, usage, description, inPrompt]) => {
        const o = this.overrides.slash[cmd] || {};
        return {
          name: cmd, usage, description: o.description || description, defaultDescription: description,
          inPrompt: o.inPrompt ?? inPrompt, edited: edited('slash', cmd),
        };
      }),
    };
  }

  _exists(kind, name) {
    if (kind === 'tools') return this.tools.some((t) => t.name === name);
    if (kind === 'hash') return HASH.some((h) => h[0] === name);
    return SLASH.some((s) => s[0] === name);
  }

  _default(kind, name) {
    if (kind === 'tools') return (this.tools.find((t) => t.name === name) || {}).description;
    if (kind === 'hash') return (HASH.find((h) => h[0] === name) || [])[2];
    return (SLASH.find((s) => s[0] === name) || [])[2];
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, `${JSON.stringify(this.overrides, null, 2)}\n`);
    } catch (err) {
      console.warn(`[commands] Couldn't save ${FILE}: ${err.message}`);
    }
    this.emit('change');
  }
}

/** "direction, blocks?" from a JSON schema. */
function paramSummary(schema) {
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  return Object.keys(props).map((k) => `${k}${required.has(k) ? '' : '?'}`).join(', ');
}

module.exports = { CommandCatalog, HASH, SLASH };
