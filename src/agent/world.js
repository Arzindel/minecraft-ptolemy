'use strict';

const { isSolid, blockId } = require('../../public/blocks');

const key = (x, y, z) => `${x},${y},${z}`;

/**
 * Everything the robot currently believes about the world, as the pathfinder sees it.
 * For now that's its Sight (the latest scan) plus cells it found blocked while walking;
 * Memory will plug in here later.
 */
class WorldKnowledge {
  constructor() {
    this.sight = new Map(); // "x,y,z" -> block name, including Air
    this.blocked = new Set(); // cells a move failed to enter, until a scan sees them again
  }

  setSight(scan) {
    this.sight = new Map();
    for (const c of scan.cells) {
      if (c.block === '?') continue; // couldn't be identified: stays unknown
      const k = key(c.x, c.y, c.z);
      this.sight.set(k, c.block);
      this.blocked.delete(k);
    }
  }

  markBlocked(x, y, z) {
    this.blocked.add(key(x, y, z));
  }

  /** 'free', 'solid' or 'unknown'. */
  state(x, y, z) {
    const k = key(x, y, z);
    if (this.blocked.has(k)) return 'solid';
    const block = this.sight.get(k);
    if (block === undefined) return 'unknown';
    return isSolid(block) ? 'solid' : 'free';
  }

  isWater(x, y, z) {
    const block = this.sight.get(key(x, y, z));
    return block !== undefined && /water/.test(blockId(block));
  }

  /** Bounding box of what's known, or null. */
  bounds() {
    if (!this.sight.size) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const k of this.sight.keys()) {
      k.split(',').map(Number).forEach((v, i) => {
        if (v < min[i]) min[i] = v;
        if (v > max[i]) max[i] = v;
      });
    }
    return { min, max };
  }
}

module.exports = { WorldKnowledge };
