'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { isSolid, blockId } = require('../../public/blocks');

// The robot's map of a world: every block it has ever seen, kept in Minecraft's own grid.
//
// Cells live in sub-chunks of 16x16x16, each a Uint16Array of 4096 numbers: 0 = never seen,
// n = palette[n - 1] (a block name, "Air" included). Sub-chunks are grouped by chunk column
// (16x16, all heights) and each column is one gzipped file, data/worlds/<id>/map/<cx>,<cz>.bin,
// read when something first needs it and written back a moment after it changes. The palette
// (every block name seen in this world) is map/palette.json, append-only so files stay valid.
//
// Only recently used columns stay in RAM; the rest are forgotten (after saving) and read back from
// disk when needed again. 4096 cells take 8 KB, so even the cache's limit is only tens of MB.

const SIZE = 16;
const CELLS = SIZE * SIZE * SIZE;
const MAX_COLUMNS_IN_RAM = 1024;
const SAVE_DELAY_MS = 2000;
const FILE_VERSION = 1;

// Numeric keys (faster than strings in the pathfinder's inner loop). Chunk x/z fit in 22 bits
// (the world is 30M blocks wide), sub-chunk y in 6.
const OFFSET = 2 ** 21;
const columnKey = (cx, cz) => (cx + OFFSET) * 2 ** 22 + (cz + OFFSET);
const subKey = (cx, cy, cz) => columnKey(cx, cz) * 64 + (cy + 32);
const indexOf = (x, y, z) => ((y & 15) * SIZE + (z & 15)) * SIZE + (x & 15);

class WorldMap extends EventEmitter {
  constructor() {
    super();
    this.dir = null; // where this world's map is saved; null = not saved (no world detected yet)
    this._reset();
  }

  _reset() {
    this.palette = []; // index + 1 = cell value
    this.paletteIndex = new Map(); // name -> cell value
    this.solid = [false]; // by cell value: is it solid? (0 = unknown, never solid)
    this.water = [false];
    this.subs = new Map(); // subKey -> Uint16Array
    this.columns = new Map(); // columnKey -> { cx, cz, subs: Set<cy>, seen: time, dirty }, most recently used last
    this.onDisk = new Set(); // columnKeys that have a file
    this.blocked = new Set(); // "x,y,z": cells a move failed to enter, until they're seen again
    this._last = { key: null, cells: null }; // one-entry cache for the pathfinder
    this._dirty = new Set();
    this._savedPalette = 0;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
  }

  /** Switch to another world's map (saving the current one first). `dir` null: an unsaved map. */
  open(dir) {
    this.flush();
    this._reset();
    this.dir = dir;
    if (!dir) return;
    try {
      this.palette = JSON.parse(fs.readFileSync(path.join(dir, 'palette.json'), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[map] Ignoring ${dir}/palette.json: ${err.message}`);
      this.palette = [];
    }
    this.palette.forEach((name, i) => this._learn(name, i + 1));
    this._savedPalette = this.palette.length;
    try {
      for (const file of fs.readdirSync(dir)) {
        const m = /^(-?\d+),(-?\d+)\.bin$/.exec(file);
        if (m) this.onDisk.add(columnKey(Number(m[1]), Number(m[2])));
      }
    } catch { /* no map yet */ }
    this.emit('reset');
  }

  // --- Reading ------------------------------------------------------------------

  /** The block name at a cell, or null if it was never seen. */
  get(x, y, z) {
    const v = this._value(x, y, z);
    return v ? this.palette[v - 1] : null;
  }

  /** 'free', 'solid' or 'unknown', as the pathfinder sees it. */
  state(x, y, z) {
    if (this.blocked.size && this.blocked.has(`${x},${y},${z}`)) return 'solid';
    const v = this._value(x, y, z);
    if (!v) return 'unknown';
    return this.solid[v] ? 'solid' : 'free';
  }

  isWater(x, y, z) {
    return this.water[this._value(x, y, z)] || false;
  }

  /** Every known cell in a box (inclusive corners), as (x, y, z, name) calls. Air included. */
  forEachIn(min, max, fn) {
    for (let cx = min[0] >> 4; cx <= max[0] >> 4; cx++) {
      for (let cz = min[2] >> 4; cz <= max[2] >> 4; cz++) {
        const column = this._column(cx, cz);
        if (!column) continue;
        for (const cy of column.subs) {
          if (cy * SIZE > max[1] || cy * SIZE + SIZE - 1 < min[1]) continue;
          const cells = this.subs.get(subKey(cx, cy, cz));
          const x0 = Math.max(min[0], cx * SIZE); const x1 = Math.min(max[0], cx * SIZE + SIZE - 1);
          const y0 = Math.max(min[1], cy * SIZE); const y1 = Math.min(max[1], cy * SIZE + SIZE - 1);
          const z0 = Math.max(min[2], cz * SIZE); const z1 = Math.min(max[2], cz * SIZE + SIZE - 1);
          for (let y = y0; y <= y1; y++) {
            for (let z = z0; z <= z1; z++) {
              for (let x = x0; x <= x1; x++) {
                const v = cells[indexOf(x, y, z)];
                if (v) fn(x, y, z, this.palette[v - 1]);
              }
            }
          }
        }
      }
    }
  }

  // --- Writing ------------------------------------------------------------------

  /** Add a scan ({ cells: [{ x, y, z, block }] }); cells that couldn't be identified ('?') are skipped. */
  setSight(scan) {
    this.setBlocks(scan.cells.filter((c) => c.block !== '?').map((c) => [c.x, c.y, c.z, c.block]));
  }

  /** One cell seen outside a scan (e.g. after the robot broke or placed a block). */
  setBlock(x, y, z, block) {
    if (!block || block.startsWith('unknown')) return;
    this.setBlocks([[x, y, z, block]]);
  }

  /**
   * Record what was seen: [[x, y, z, name], ...]. Emits 'change' with the cells whose block
   * changed (including ones seen for the first time), as [[x, y, z, name], ...].
   */
  setBlocks(list) {
    const changed = [];
    const now = Date.now();
    for (const [x, y, z, name] of list) {
      if (!name || y < -64 || y > 319) continue;
      const v = this._valueOf(name);
      const cells = this._cellsFor(x, y, z, true);
      const i = indexOf(x, y, z);
      if (this.blocked.size) this.blocked.delete(`${x},${y},${z}`);
      const column = this.columns.get(columnKey(x >> 4, z >> 4));
      column.seen = now;
      if (cells[i] === v) continue;
      cells[i] = v;
      changed.push([x, y, z, name]);
      this._markDirty(column);
    }
    if (changed.length) this.emit('change', changed);
    return changed;
  }

  markBlocked(x, y, z) {
    this.blocked.add(`${x},${y},${z}`);
  }

  /** Forget everything in RAM and on disk for this world. */
  clear() {
    const dir = this.dir;
    this._reset();
    this.dir = dir;
    if (dir) {
      try {
        for (const file of fs.readdirSync(dir)) if (/\.bin$|^palette\.json$/.test(file)) fs.unlinkSync(path.join(dir, file));
      } catch { /* nothing saved */ }
    }
    this.emit('reset');
  }

  /** Save every changed column now. */
  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.dir || !this._dirty.size) {
      this._dirty.clear();
      return;
    }
    this._saveColumns([...this._dirty]);
    this._dirty.clear();
  }

  /** How much is known: chunk columns saved, and columns and sub-chunks in RAM. */
  stats() {
    let subChunks = 0;
    for (const column of this.columns.values()) subChunks += column.subs.size;
    return { columnsOnDisk: this.onDisk.size, columnsInRam: this.columns.size, subChunksInRam: subChunks };
  }

  // --- Internals ----------------------------------------------------------------

  _learn(name, v) {
    this.paletteIndex.set(name, v);
    this.solid[v] = isSolid(name);
    this.water[v] = /water/.test(blockId(name));
  }

  _valueOf(name) {
    let v = this.paletteIndex.get(name);
    if (v === undefined) {
      if (this.palette.length >= 65534) throw new Error('the map\'s block palette is full');
      this.palette.push(name);
      v = this.palette.length;
      this._learn(name, v);
    }
    return v;
  }

  _value(x, y, z) {
    const cells = this._cellsFor(x, y, z, false);
    return cells ? cells[indexOf(x, y, z)] : 0;
  }

  /** The sub-chunk holding a cell (created if `create`), loading its column from disk if needed. */
  _cellsFor(x, y, z, create) {
    const cx = x >> 4; const cy = y >> 4; const cz = z >> 4;
    const key = subKey(cx, cy, cz);
    if (this._last.key === key) return this._last.cells;
    let cells = this.subs.get(key);
    if (!cells) {
      let column = this._column(cx, cz);
      if (column) cells = this.subs.get(key);
      if (!cells) {
        if (!create) return null;
        if (!column) column = this._newColumn(cx, cz);
        cells = new Uint16Array(CELLS);
        this.subs.set(key, cells);
        column.subs.add(cy);
      }
    }
    this._last = { key, cells };
    return cells;
  }

  /** A column in RAM (loaded from disk if it has a file), or null if nothing is known there. */
  _column(cx, cz) {
    const key = columnKey(cx, cz);
    let column = this.columns.get(key);
    if (column) {
      // Most recently used last, for eviction.
      this.columns.delete(key);
      this.columns.set(key, column);
      return column;
    }
    if (!this.onDisk.has(key)) return null;
    column = this._load(cx, cz);
    return column;
  }

  _newColumn(cx, cz) {
    const column = { cx, cz, subs: new Set(), seen: 0, dirty: false };
    this.columns.set(columnKey(cx, cz), column);
    this._evict();
    return column;
  }

  _markDirty(column) {
    this._dirty.add(column);
    if (!this._saveTimer && this.dir) this._saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  _evict() {
    if (this.columns.size <= MAX_COLUMNS_IN_RAM) return;
    for (const [key, column] of this.columns) {
      if (this.columns.size <= MAX_COLUMNS_IN_RAM) break;
      if (this._dirty.has(column)) {
        if (!this.dir) continue; // unsaved map: keep changes until a world opens
        this._saveColumns([column]);
        this._dirty.delete(column);
      }
      for (const cy of column.subs) this.subs.delete(subKey(column.cx, cy, column.cz));
      this.columns.delete(key);
    }
    this._last = { key: null, cells: null };
  }

  /** Write columns (and the palette they refer to) to disk. */
  _saveColumns(columns) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (this._savedPalette !== this.palette.length) {
        fs.writeFileSync(path.join(this.dir, 'palette.json'), JSON.stringify(this.palette));
        this._savedPalette = this.palette.length;
      }
      for (const column of columns) this._save(column);
    } catch (err) {
      console.warn(`[map] Couldn't save ${this.dir}: ${err.message}`);
    }
  }

  // File: gzip of [u8 version][f64 seen][u16 count] then per sub-chunk [i8 cy][4096 x u16].
  _file(cx, cz) {
    return path.join(this.dir, `${cx},${cz}.bin`);
  }

  _save(column) {
    const subs = [...column.subs];
    const buf = Buffer.alloc(1 + 8 + 2 + subs.length * (1 + CELLS * 2));
    let o = buf.writeUInt8(FILE_VERSION, 0);
    o = buf.writeDoubleLE(column.seen, o);
    o = buf.writeUInt16LE(subs.length, o);
    for (const cy of subs) {
      o = buf.writeInt8(cy, o);
      const cells = this.subs.get(subKey(column.cx, cy, column.cz));
      Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength).copy(buf, o);
      o += CELLS * 2;
    }
    fs.writeFileSync(this._file(column.cx, column.cz), zlib.gzipSync(buf));
    this.onDisk.add(columnKey(column.cx, column.cz));
  }

  _load(cx, cz) {
    const column = this._newColumn(cx, cz);
    try {
      const buf = zlib.gunzipSync(fs.readFileSync(this._file(cx, cz)));
      if (buf.readUInt8(0) !== FILE_VERSION) throw new Error(`unknown file version ${buf.readUInt8(0)}`);
      column.seen = buf.readDoubleLE(1);
      const count = buf.readUInt16LE(9);
      let o = 11;
      for (let i = 0; i < count; i++) {
        const cy = buf.readInt8(o);
        o += 1;
        const cells = new Uint16Array(CELLS);
        Buffer.from(cells.buffer).set(buf.subarray(o, o + CELLS * 2));
        o += CELLS * 2;
        this.subs.set(subKey(cx, cy, cz), cells);
        column.subs.add(cy);
      }
    } catch (err) {
      console.warn(`[map] Ignoring ${this._file(cx, cz)}: ${err.message}`);
    }
    return column;
  }
}

module.exports = { WorldMap };
