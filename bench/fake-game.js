'use strict';

// A fake Minecraft Bedrock client, to try Ptolemy without the game: it connects to Ptolemy's
// Minecraft port like `/connect` does and answers commands from a simulated world (bench/sim.js):
// the agent can move and turn, blocks can be tested, a player and a couple of mobs stand around.
//
//   npm start                          (Ptolemy, as usual)
//   node bench/fake-game.js [port]     (port: Ptolemy's Minecraft port, 8080 by default)
//
// The world marker Ptolemy adds lives only as long as this process; pass it back to reopen the
// same world (and its map) after a restart: FAKE_WORLD=ptolemy_1234abcd node bench/fake-game.js

const WebSocket = require('ws');
const { makeTerrain, FakeBridge } = require('./sim');

const port = Number(process.argv[2] || 8080);
const terrain = makeTerrain({ seed: 3, trees: 0.03 });
terrain.addTree(-112, 78);
const agent = { x: -118, y: terrain.height(-118, 76) + 1, z: 76, facing: 0 };
const player = { x: -100, z: 80 };
player.y = terrain.height(player.x, player.z) + 1;
const game = new FakeBridge(terrain, agent, player);
game.entities = [
  { id: '-1', name: 'Arzindel', pos: { x: player.x + 0.5, y: player.y + 1.62, z: player.z + 0.5 } },
  { id: '-2', name: 'Cow', pos: { x: agent.x + 3.5, y: agent.y, z: agent.z + 2.5 } },
  { id: '-3', name: 'Zombie', pos: { x: agent.x - 4.5, y: agent.y, z: agent.z + 5.5 } },
];
const objectives = new Set(process.env.FAKE_WORLD ? [process.env.FAKE_WORLD] : []);
const started = Date.now();
let noAgent = Boolean(process.env.FAKE_NO_AGENT);

/** A PlayerMessage event, as the game sends for chat (and for tellraw lines). */
function chat(sender, message, type = 'chat') {
  ws.send(JSON.stringify({ header: { messagePurpose: 'event', eventName: 'PlayerMessage', version: 1 }, body: { sender, message, type } }));
}

/** querytarget with name=/type=/family= filters, for identifying entities. */
function filteredTargets(line) {
  const m = /name="?([^",\]]+)"?/.exec(line) || /type=(\w+)/.exec(line);
  const match = game.entities.filter((e) => (/family=monster/.test(line) ? e.name === 'Zombie'
    : /type=player/.test(line) ? e.name === 'Arzindel'
      : m && e.name.toLowerCase() === m[1].toLowerCase().replace(/_/g, ' ')));
  return match.length
    ? { ok: true, body: { details: JSON.stringify(match.map((e) => ({ uniqueId: e.id, position: e.pos }))) } }
    : { ok: false, body: { statusMessage: 'No targets matched selector' } };
}

async function answer(line) {
  if (line === 'getlocalplayername') return { ok: true, body: { localplayername: 'Arzindel' } };
  if (line === 'scoreboard objectives list') {
    return { ok: true, body: { statusMessage: [...objectives].map((o) => `- ${o}: "Ptolemy"`).join('\n') || 'No objectives' } };
  }
  if (line.startsWith('scoreboard objectives add')) {
    objectives.add(line.split(' ')[3]);
    console.log(`Ptolemy marked this world: ${line.split(' ')[3]} (FAKE_WORLD=${line.split(' ')[3]} reopens it)`);
    return { ok: true, body: { statusMessage: 'Added' } };
  }
  // FAKE_NO_AGENT=1: no agent until Ptolemy runs "agent create" (to try the Create Agent button).
  if (noAgent && line.startsWith('agent ')) {
    if (line === 'agent create') noAgent = false;
    return line === 'agent create' ? { ok: true, body: { statusMessage: 'Agent created' } }
      : { ok: false, body: { statusCode: -2147352576, statusMessage: 'No agent found for this player' } };
  }
  if (/^querytarget @e\[.*(name=|type=|family=)/.test(line)) return filteredTargets(line);
  // The clock runs 20 ticks a second from 1000 (07:00); it rains.
  const daytime = Math.floor(1000 + (Date.now() - started) / 50) % 24000;
  if (line === 'time query daytime') return { ok: true, body: { statusMessage: `Daytime is ${daytime}`, data: daytime } };
  if (line === 'time query day') return { ok: true, body: { statusMessage: 'Day is 12', data: 12 } };
  if (line === 'weather query') return { ok: true, body: { statusMessage: 'Weather state is: rain' } };
  if (line.startsWith('tellraw ')) {
    // The robot's own chat lines come back as chat events, as in the game.
    const text = JSON.parse(line.slice(line.indexOf('{'))).rawtext.map((r) => r.text).join('');
    console.log(`[chat] ${text.replace(/§./g, '')}`);
    setTimeout(() => chat('Arzindel', text, 'tellraw'), 20);
    return { ok: true, body: { statusMessage: '' } };
  }
  return game.sendCommand(line);
}

const ws = new WebSocket(`ws://localhost:${port}`);
ws.on('open', () => console.log(`Fake game connected to Ptolemy on port ${port}. The robot is at ${agent.x} ${agent.y} ${agent.z}.`));
ws.on('close', () => { console.log('Ptolemy closed the connection.'); process.exit(0); });
ws.on('error', (err) => { console.error(`Can't connect to Ptolemy on port ${port}: ${err.message}`); process.exit(1); });
// Type chat lines here to send them as someone's chat: "Diego: Ptolemy, hi" (a player), or
// "robot Robo: hey Ptolemy" (another player's robot).
process.stdin.setEncoding('utf8');
let pendingInput = '';
process.stdin.on('data', (piece) => {
  pendingInput += piece;
  let at;
  while ((at = pendingInput.indexOf('\n')) !== -1) {
    const line = pendingInput.slice(0, at).trim();
    pendingInput = pendingInput.slice(at + 1);
    const robot = /^robot (\w+):\s*(.*)$/.exec(line);
    const person = /^(\w+):\s*(.*)$/.exec(line);
    if (robot) chat('Diego', `§b<${robot[1]}>§r ${robot[2]}`, 'tellraw');
    else if (person) chat(person[1], person[2]);
  }
});

ws.on('message', async (data) => {
  const msg = JSON.parse(data);
  if (msg.header.messagePurpose !== 'commandRequest') return;
  const res = await answer(msg.body.commandLine.replace(/^\//, ''));
  const body = { statusCode: res.ok ? 0 : -1, ...(res.body || {}) };
  if (res.statusMessage && !body.statusMessage) body.statusMessage = res.statusMessage;
  ws.send(JSON.stringify({ header: { requestId: msg.header.requestId, messagePurpose: 'commandResponse', version: 1 }, body }));
});
