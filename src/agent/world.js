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
    this._bounds = null;
    this._surfaces = new Map(); // "x,z" -> walking height of that known column (or null)
  }

  setSight(scan) {
    this.sight = new Map();
    this._bounds = null;
    this._surfaces.clear();
    for (const c of scan.cells) {
      if (c.block === '?') continue; // couldn't be identified: stays unknown
      const k = key(c.x, c.y, c.z);
      this.sight.set(k, c.block);
      this.blocked.delete(k);
    }
  }

  markBlocked(x, y, z) {
    this.blocked.add(key(x, y, z));
    this._surfaces.clear();
  }

  /**
   * Walking height (the first free cell above solid ground) of the scanned column nearest to
   * (x, z), assuming the terrain carries on beyond Sight as last seen. `nearY` picks which
   * surface when a column has several (caves, overhangs). null when nothing solid is known there.
   */
  surfaceNear(x, z, nearY) {
    const b = this.bounds();
    if (!b) return null;
    const cx = Math.min(b.max[0], Math.max(b.min[0], x));
    const cz = Math.min(b.max[2], Math.max(b.min[2], z));
    const ck = `${cx},${cz}`;
    let surfaces = this._surfaces.get(ck);
    if (!surfaces) {
      surfaces = [];
      for (let y = b.min[1]; y < b.max[1]; y++) {
        if (this.state(cx, y, cz) === 'solid' && this.state(cx, y + 1, cz) === 'free') surfaces.push(y + 1);
      }
      this._surfaces.set(ck, surfaces);
    }
    if (!surfaces.length) return null;
    return surfaces.reduce((best, s) => (Math.abs(s - nearY) < Math.abs(best - nearY) ? s : best));
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
}

module.exports = { WorldKnowledge };
