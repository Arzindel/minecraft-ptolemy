'use strict';

// Mobs, animals, players and dropped items near a point. Bedrock has no single command that says
// "what is where", so the answers of a few commands are stitched together by each entity's uniqueId:
//   querytarget @e[...]              where every entity is (uniqueId, position), but not what it is
//   testfor @e[...]                  the names of what's there ("Cow", "Zombie", "Alex"), but not where
//   querytarget @e[..., name=Cow]    which uniqueIds carry that name (players, name-tagged mobs)
//   querytarget @e[..., type=cow]    which uniqueIds are that type (the name, as a type id)
//   querytarget @e[..., family=monster] / type=item / type=player   which are hostile, items or players
// Everything is sent at once, so a look around costs about one round trip.

const MAX_ENTITIES = 64;
const DEFAULT_RADIUS = 16; // entities are cheap to look for, so they're looked for further than blocks
const MAX_RADIUS = 48;
const WHAT = ['blocks', 'entities', 'both'];
const MAX_NAMES = 16; // distinct names looked up per call; the rest stay "unidentified"
const NO_TARGETS = /no targets matched/i;
// Names that are also command keywords break a selector ("type=!agent" is a syntax error), so the
// robot and experience orbs are left out after the fact instead of in the selector.
const KEYWORDS = new Set(['agent']);
const HIDDEN_NAMES = /^experience orb$/i;

/** `@e[...]` around a center, with extra selector arguments. */
function selector({ x, y, z }, radius, extra = '') {
  return `@e[x=${x},y=${y},z=${z},r=${radius}${extra ? `,${extra}` : ''}]`;
}

/** querytarget's matches as [{ id, x, y, z, yRot }] (float positions), [] if nothing matched. */
function parseTargets(res) {
  if (!res.ok) {
    if (NO_TARGETS.test(res.statusMessage || '')) return [];
    return null;
  }
  try {
    const list = JSON.parse(res.body.details);
    return list.filter((d) => d && d.position).map((d) => ({
      id: String(d.uniqueId ?? d.id ?? `${d.position.x},${d.position.y},${d.position.z}`),
      x: d.position.x,
      y: d.position.y,
      z: d.position.z,
      yRot: d.yRot,
    }));
  } catch {
    return null;
  }
}

/** testfor's matches as names, e.g. ["Cow", "Cow", "Alex"]. */
function parseNames(res) {
  if (!res.ok) return [];
  const body = res.body || {};
  let names = Array.isArray(body.victim) ? body.victim : null;
  if (!names) {
    const m = /^Found (.+)$/s.exec(res.statusMessage || '');
    names = m ? m[1].split(', ') : [];
  }
  return names.map((n) => String(n).replace(/§./g, '').trim()).filter(Boolean);
}

/** A readable name for "%entity.cow.name" style keys; other names as they are. */
function displayName(name) {
  const m = /^%?entity\.([\w:]+)\.name$/.exec(name);
  if (!m) return name;
  return m[1].replace(/^minecraft:/, '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The type id a name most likely stands for ("Zombie Villager" → zombie_villager), or null. */
function typeGuess(name) {
  const key = /^%?entity\.([\w:]+)\.name$/.exec(name);
  if (key) return key[1].replace(/^minecraft:/, '');
  const id = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return /^[a-z][a-z_]*$/.test(id) && !KEYWORDS.has(id) ? id : null;
}

/**
 * What is within `radius` blocks of `center` (world block coordinates), nearest first:
 * [{ id, name, type, hostile, player, item, x, y, z, exact: {x, y, z}, distance }].
 * `raw` has every command's reply, to check the stitching against the game.
 */
async function nearbyEntities(bridge, center, radius) {
  const mid = { x: center.x + 0.5, y: center.y + 0.5, z: center.z + 0.5 };
  const send = (cmd) => bridge.sendCommand(cmd, { quiet: true });
  const all = `c=${MAX_ENTITIES + 1}`; // +1: the robot itself is among them
  const [baseRes, namesRes, hostileRes, itemRes, playerRes] = await Promise.all([
    send(`querytarget ${selector(mid, radius, all)}`),
    send(`testfor ${selector(mid, radius, all)}`),
    send(`querytarget ${selector(mid, radius, 'family=monster')}`),
    send(`querytarget ${selector(mid, radius, 'type=item')}`),
    send(`querytarget ${selector(mid, radius, 'type=player')}`),
  ]);
  const base = parseTargets(baseRes);
  if (!base) throw new Error(`querytarget failed: ${baseRes.statusMessage}`);
  const raw = { querytarget: baseRes.body, testfor: namesRes.body || namesRes.statusMessage };
  if (!base.length) return { entities: [], raw };

  const found = new Map(base.map((e) => [e.id, { ...e, name: null, type: null, hostile: false, player: false, item: false }]));
  const ids = (res) => (parseTargets(res) || []).map((e) => e.id).filter((id) => found.has(id));
  for (const id of ids(hostileRes)) found.get(id).hostile = true;
  for (const id of ids(itemRes)) found.get(id).item = true;
  for (const id of ids(playerRes)) found.get(id).player = true;

  // Look each distinct name up by name and by type, all at once.
  const names = [...new Set(parseNames(namesRes))].slice(0, MAX_NAMES);
  const lookups = names.flatMap((name) => {
    const quoted = `"${name.replace(/["\\]/g, '')}"`; // always quoted, so a name can't read as a keyword
    const list = [{ name, by: 'name', cmd: `querytarget ${selector(mid, radius, `name=${quoted}`)}` }];
    const type = typeGuess(name);
    if (type) list.push({ name, by: 'type', type, cmd: `querytarget ${selector(mid, radius, `type=${type}`)}` });
    return list;
  });
  const replies = await Promise.all(lookups.map((l) => send(l.cmd)));
  raw.lookups = lookups.map((l, i) => ({ command: l.cmd, reply: replies[i].body || replies[i].statusMessage }));
  // A name match is the most specific (a cow called "Bessie"), so those claim entities first.
  for (const by of ['name', 'type']) {
    lookups.forEach((l, i) => {
      if (l.by !== by) return;
      for (const id of ids(replies[i])) {
        const e = found.get(id);
        if (!e.name) e.name = displayName(l.name);
        if (l.type && !e.type) e.type = l.type;
      }
    });
  }

  // The robot itself: whatever stands in its own cell, unless it turned out to be something else.
  const self = [...found.values()].find((e) => Math.floor(e.x) === center.x && Math.floor(e.z) === center.z
    && Math.abs(e.y - center.y) < 1 && !e.player && !e.item && (!e.name || /agent/i.test(e.name)));
  if (self) found.delete(self.id);
  for (const [id, e] of found) if (e.name && HIDDEN_NAMES.test(e.name)) found.delete(id);

  const entities = [...found.values()].slice(0, MAX_ENTITIES).map((e) => {
    const distance = Math.hypot(e.x - mid.x, e.y - center.y, e.z - mid.z);
    return {
      id: e.id,
      name: e.name || (e.item ? 'Dropped item' : e.player ? 'Player' : 'Unidentified entity'),
      type: e.type || (e.item ? 'item' : e.player ? 'player' : null),
      hostile: e.hostile,
      player: e.player,
      item: e.item,
      x: Math.floor(e.x),
      y: Math.floor(e.y),
      z: Math.floor(e.z),
      exact: { x: e.x, y: e.y, z: e.z },
      distance,
    };
  }).sort((a, b) => a.distance - b.distance);
  return { entities, raw };
}

/** "Cow 3, Zombie 1 (hostile), Alex (player)" */
function countsText(entities) {
  const counts = new Map();
  for (const e of entities) {
    const label = `${e.name}${e.hostile ? ' (hostile)' : ''}${e.player ? ' (player)' : ''}${e.item && e.name !== 'Dropped item' ? ' (item)' : ''}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(', ');
}

/**
 * How far to look for entities: the radius asked for when looking only for entities, otherwise at
 * least DEFAULT_RADIUS (a block scan's radius is small, since blocks are slow to scan).
 */
function entityRadius(radius, what) {
  const r = Math.round(Number(radius));
  if (what === 'entities') return Number.isFinite(r) && radius !== null && radius !== undefined ? Math.min(MAX_RADIUS, Math.max(1, r)) : DEFAULT_RADIUS;
  return Math.min(MAX_RADIUS, Math.max(DEFAULT_RADIUS, Number.isFinite(r) ? r : 0));
}

/** The compact form sent to the Nanny Cam (exact positions, so mobs stand where they are). */
function entitiesMessage(center, radius, entities) {
  return {
    type: 'entities',
    center,
    radius,
    time: Date.now(),
    list: entities.map((e) => ({
      name: e.name, type: e.type, hostile: e.hostile, player: e.player, item: e.item, ...e.exact,
    })),
  };
}

module.exports = {
  nearbyEntities, countsText, entityRadius, entitiesMessage, parseTargets, parseNames, typeGuess, displayName,
  MAX_ENTITIES, DEFAULT_RADIUS, MAX_RADIUS, WHAT,
};
