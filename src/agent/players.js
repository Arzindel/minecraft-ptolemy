'use strict';

// Players in the world. `querytarget @s` only ever finds the player whose game is connected to
// Ptolemy, so other players are looked up by name: `list` for who's online, then
// `querytarget @a[name="..."]` for where each one is.

/** A player name as a selector argument: bare if simple, quoted otherwise. */
function selectorName(name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `"${String(name).replace(/["\\]/g, '')}"`;
}

/** Names of everyone online (the connected player first). Falls back to just the connected player. */
async function listPlayers(bridge) {
  const res = await bridge.sendCommand('list', { quiet: true });
  let names = [];
  const body = res.body || {};
  if (typeof body.players === 'string') names = body.players.split(',');
  else if (Array.isArray(body.players)) names = body.players;
  else {
    // "There are 2/10 players online:\nAlex, Bob"
    const m = /online:?\s*\n?([\s\S]*)$/i.exec(res.statusMessage || '');
    if (m) names = m[1].split(/[,\n]/);
  }
  names = names.map((n) => String(n).replace(/§./g, '').trim()).filter(Boolean);
  if (bridge.player && !names.includes(bridge.player)) names.unshift(bridge.player);
  if (bridge.player) names = [bridge.player, ...names.filter((n) => n !== bridge.player)];
  return [...new Set(names)];
}

/**
 * Where a player is: { name, x, y, z, yRot } with whole-block coordinates (y may be closer to eye
 * height than feet), or null if they can't be found. Without a name: the connected player.
 */
async function playerPosition(bridge, name = null) {
  const own = !name || name === bridge.player;
  const res = await bridge.sendCommand(`querytarget ${own ? '@s' : `@a[name=${selectorName(name)}]`}`, { quiet: true });
  try {
    const p = JSON.parse(res.body.details)[0];
    if (!p) return null;
    return {
      name: own ? bridge.player || name : name,
      x: Math.floor(p.position.x),
      y: Math.floor(p.position.y),
      z: Math.floor(p.position.z),
      yRot: p.yRot,
    };
  } catch {
    return null;
  }
}

/** Every online player with their position (players that can't be found are left out). */
async function allPlayers(bridge) {
  const names = await listPlayers(bridge);
  const found = await Promise.all(names.map((n) => playerPosition(bridge, n)));
  return found.filter(Boolean);
}

/** The online player whose name matches (any case, or a unique prefix), or null. */
function matchPlayer(names, wanted) {
  const w = String(wanted || '').trim().toLowerCase();
  if (!w) return null;
  return names.find((n) => n.toLowerCase() === w)
    || (names.filter((n) => n.toLowerCase().startsWith(w)).length === 1 ? names.find((n) => n.toLowerCase().startsWith(w)) : null);
}

module.exports = { listPlayers, playerPosition, allPlayers, matchPlayer, selectorName };
