'use strict';

const { isSolid, blockId } = require('../../public/blocks');

const key = (x, y, z) => `${x},${y},${z}`;

// How many cells the robot remembers. A radius-7 scan is 3375 cells, so this is the last ~60 scans'
// worth; past it the cells seen longest ago are forgotten first.
const MAX_CELLS = 200000;

/**
 * Everything the robot currently believes about the world, as the pathfinder sees it: every cell
 * its scans have seen (a newer scan overwrites what an older one said), plus cells it found
 * blocked while walking. Keeping older scans matters when walking around something big, like a
 * wall or a hill: if each scan replaced the last, the part of the wall seen before would be
 * forgotten, and the planner would try that way again, back and forth along the wall.
 */
class WorldKnowledge {
  constructor() {
    this.sight = new Map(); // "x,y,z" -> block name, including Air; oldest first
    this.blocked = new Set(); // cells a move failed to enter, until a scan sees them again
    this._bounds = null;
  }

  /** Add a scan to what's known. */
  setSight(scan) {
    for (const c of scan.cells) {
      if (c.block === '?') continue; // couldn't be identified: stays as it was
      this._set(key(c.x, c.y, c.z), c.block);
    }
    this._prune();
    this._bounds = null;
  }

  /** One cell seen outside a scan (e.g. after the robot broke or placed a block). */
  setBlock(x, y, z, block) {
    if (!block || block.startsWith('unknown')) return;
    this._set(key(x, y, z), block);
    this._bounds = null;
  }

  markBlocked(x, y, z) {
    this.blocked.add(key(x, y, z));
  }

  /** Forget everything (another Minecraft world was opened). */
  clear() {
    this.sight.clear();
    this.blocked.clear();
    this._bounds = null;
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
    if (this._bounds) return this._bounds;
    if (!this.sight.size) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const k of this.sight.keys()) {
      k.split(',').map(Number).forEach((v, i) => {
        if (v < min[i]) min[i] = v;
        if (v > max[i]) max[i] = v;
      });
    }
    this._bounds = { min, max };
    return this._bounds;
  }

  /** Re-inserting keeps the map ordered from least to most recently seen. */
  _set(k, block) {
    this.sight.delete(k);
    this.sight.set(k, block);
    this.blocked.delete(k);
  }

  _prune() {
    if (this.sight.size <= MAX_CELLS) return;
    let extra = this.sight.size - MAX_CELLS;
    for (const k of this.sight.keys()) {
      if (extra-- <= 0) break;
      this.sight.delete(k);
    }
  }
}

module.exports = { WorldKnowledge };
