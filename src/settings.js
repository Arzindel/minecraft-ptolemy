'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

/**
 * Everything tunable from the Configuration tab (and some console commands), with defaults,
 * limits and help text. Saved to data/settings.json so it survives restarts.
 */
const SCHEMA = [
  {
    group: 'Walking path costs',
    help: 'What entering a cell costs #pathfind, by what holds the robot up there (the best support wins). '
      + 'Think "how many ground steps would it rather walk than go through this". #flypathfind ignores these.',
    fields: [
      { key: 'cost.ground', label: 'Ground (solid block below)', default: 1 },
      { key: 'cost.water', label: 'Water (the cell itself)', default: 5 },
      { key: 'cost.wall', label: 'Wall (beside, sharing a face)', default: 5 },
      { key: 'cost.groundEdge', label: 'Ground edge (below, sharing an edge)', default: 3 },
      { key: 'cost.wallDiagonal', label: 'Wall edge (level, sharing an edge)', default: 8 },
      { key: 'cost.groundCorner', label: 'Ground corner (below, sharing a corner)', default: 10 },
      { key: 'cost.ceiling', label: 'Ceiling (directly above)', default: 15 },
      { key: 'cost.ceilingEdge', label: 'Ceiling edge (above, sharing an edge)', default: 20 },
      { key: 'cost.ceilingCorner', label: 'Ceiling corner (above, sharing a corner)', default: 20 },
      { key: 'cost.airborne', label: 'Airborne (nothing around)', default: 40 },
    ].map((f) => ({ ...f, min: 1, max: 1000, step: 1 })),
  },
  {
    group: 'Scanning',
    fields: [
      { key: 'scan.radius', label: 'Default #scan radius', default: 4, min: 1, max: 15, step: 1,
        help: 'Used by #scan without a radius and preselected in the Nanny Cam (4 = 9x9x9, 15 = 31x31x31).' },
    ],
  },
  {
    group: 'Path planning',
    fields: [
      { key: 'path.turnCost', label: 'Cost of a turn', default: 1, min: 0, max: 100, step: 0.5 },
      { key: 'path.unknownPenalty', label: 'Extra cost of an unseen cell', default: 0.5, min: 0, max: 100, step: 0.5,
        help: 'Unseen cells are allowed (the robot rescans before entering them), but cost this much more.' },
      { key: 'path.scanRadius', label: 'Rescan radius for #pathfindwalk', default: 7, min: 1, max: 15, step: 1,
        help: 'How far around the robot to scan when walking into unknown territory (7 = 15x15x15).' },
      { key: 'path.retries', label: 'Retries for #pathfindwalk', default: 3, min: 0, max: 50, step: 1 },
      { key: 'path.safe', label: 'Safe mode (#pathsafe)', type: 'boolean', default: true,
        help: 'If the agent isn\'t where it should be after a step, keep checking for up to 2s before '
          + 'calling it a failure. Costs nothing when steps succeed straight away.' },
    ],
  },
  {
    group: 'Connection',
    fields: [
      { key: 'bridge.maxInFlight', label: 'Commands in flight (#inflight)', default: 100, min: 1, max: 100, step: 1,
        help: 'Bedrock drops every command beyond 100 outstanding.' },
    ],
  },
];

const FIELDS = new Map(SCHEMA.flatMap((g) => g.fields).map((f) => [f.key, f]));

class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = Object.fromEntries([...FIELDS.values()].map((f) => [f.key, f.default]));
    try {
      this._apply(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[settings] Ignoring ${FILE}: ${err.message}`);
    }
  }

  get(key) {
    return this.values[key];
  }

  /** Walking-path support costs as { ground, water, ... }. */
  costs() {
    const out = {};
    for (const [key, value] of Object.entries(this.values)) if (key.startsWith('cost.')) out[key.slice(5)] = value;
    return out;
  }

  /** Apply a partial update ({ key: value }), clamping to each field's limits. Returns what changed. */
  update(patch) {
    const changed = this._apply(patch);
    if (Object.keys(changed).length) {
      this._save();
      this.emit('change', changed);
    }
    return changed;
  }

  reset() {
    return this.update(Object.fromEntries([...FIELDS.values()].map((f) => [f.key, f.default])));
  }

  message() {
    return { type: 'settings', schema: SCHEMA, values: this.values };
  }

  _apply(patch) {
    const changed = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      const field = FIELDS.get(key);
      if (!field) continue;
      let value;
      if (field.type === 'boolean') {
        value = raw === true || raw === 'true';
      } else {
        value = Number(raw);
        if (!Number.isFinite(value)) continue;
        value = Math.min(field.max, Math.max(field.min, value));
      }
      if (this.values[key] !== value) {
        this.values[key] = value;
        changed[key] = value;
      }
    }
    return changed;
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, `${JSON.stringify(this.values, null, 2)}\n`);
    } catch (err) {
      console.warn(`[settings] Couldn't save ${FILE}: ${err.message}`);
    }
  }
}

module.exports = { Settings, SCHEMA };
