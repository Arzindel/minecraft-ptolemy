'use strict';

const { FORWARD, turnLeft } = require('./pose');

const COMPASS_NAMES = ['south', 'west', 'north', 'east'];

/**
 * The coordinates the LLM sees. Internally, relative positions are [left, up, forward] from the
 * robot, turning with it: [0, 0, 1] is the block in front of it, [1, 0, 0] the one on its left,
 * whatever way it faces in the world. The model never sees these numbers (see below).
 *
 * x is left rather than right so that at y-rot 0 (facing Z+) the frame lines up with the world's
 * axes: relative = world - robot. The other facings are that, rotated:
 *   y-rot 0    (facing Z+):  x =  dX, z =  dZ
 *   y-rot 90   (facing X-):  x =  dZ, z = -dX
 *   y-rot ±180 (facing Z-):  x = -dX, z = -dZ
 *   y-rot -90  (facing X+):  x = -dZ, z =  dX
 *
 * Everything stored (areas, paths) stays in world coordinates; a Frame converts at the edge,
 * using the robot's pose at that moment.
 *
 * What the model sees never mixes the two: world positions are always written "x=5 y=64 z=-3"
 * and passed as x/y/z, relative ones are always words, "2 forward, 1 left, 1 down", and passed as
 * forward/back/left/right/up/down counts. Internally, relative is still [left, up, forward].
 */
const REL_KEYS = ['forward', 'back', 'left', 'right', 'up', 'down'];

class Frame {
  /**
   * @param {{x: number, y: number, z: number, facing: number}} pose  the robot's world pose
   * @param {'relative'|'world'} mode
   */
  constructor(pose, mode = 'relative') {
    this.pose = pose;
    this.relative = mode === 'relative';
    const [fx, , fz] = FORWARD[pose.facing];
    const [lx, , lz] = FORWARD[turnLeft(pose.facing)];
    this.f = [fx, fz]; // world direction of relative z (ahead)
    this.l = [lx, lz]; // world direction of relative x (left)
  }

  /** World coordinates to this frame's. */
  from(x, y, z) {
    if (!this.relative) return [x, y, z];
    const dx = x - this.pose.x;
    const dz = z - this.pose.z;
    return [dx * this.l[0] + dz * this.l[1], y - this.pose.y, dx * this.f[0] + dz * this.f[1]];
  }

  /** This frame's coordinates to world coordinates. */
  to(a, b, c) {
    if (!this.relative) return [a, b, c];
    return [
      this.pose.x + a * this.l[0] + c * this.f[0],
      this.pose.y + b,
      this.pose.z + a * this.l[1] + c * this.f[1],
    ];
  }

  /** "2 forward, 1 left, 1 down" for a world position (or "where you are"). */
  words(x, y, z) {
    const [left, up, forward] = this.relative ? this.from(x, y, z) : new Frame(this.pose, 'relative').from(x, y, z);
    const parts = [];
    if (forward) parts.push(`${Math.abs(forward)} ${forward > 0 ? 'forward' : 'back'}`);
    if (left) parts.push(`${Math.abs(left)} ${left > 0 ? 'left' : 'right'}`);
    if (up) parts.push(`${Math.abs(up)} ${up > 0 ? 'up' : 'down'}`);
    return parts.length ? parts.join(', ') : 'where you are';
  }

  /** "x=5 y=64 z=-3" */
  static world(x, y, z) {
    return `x=${x} y=${y} z=${z}`;
  }

  /** A position the way the model reads it: words and world in relative mode, world only otherwise. */
  fmt(x, y, z) {
    return this.relative ? `${this.words(x, y, z)} (${Frame.world(x, y, z)})` : Frame.world(x, y, z);
  }

  /**
   * A position given by the model, as world coordinates: x/y/z are world coordinates;
   * forward/back/left/right/up/down are counts from the robot. null if it gave neither.
   */
  parse(p) {
    if (!p || typeof p !== 'object') return null;
    const n = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)));
    const [x, y, z] = [n(p.x), n(p.y), n(p.z)];
    if ([x, y, z].some((v) => v !== null)) {
      if ([x, y, z].some((v) => v === null || !Number.isFinite(v))) throw new Error('world coordinates need all three of x, y and z');
      return [x, y, z];
    }
    if (!REL_KEYS.some((k) => n(p[k]) !== null)) return null;
    const c = (k) => { const v = n(p[k]); if (v !== null && !Number.isFinite(v)) throw new Error(`${k} must be a number`); return v || 0; };
    const rel = new Frame(this.pose, 'relative');
    return rel.to(c('left') - c('right'), c('up') - c('down'), c('forward') - c('back'));
  }

  /** A world box ({min, max}) as this frame's min/max corners (a 90° turn keeps boxes axis-aligned). */
  box(min, max) {
    const a = this.from(...min);
    const b = this.from(...max);
    return { min: a.map((v, i) => Math.min(v, b[i])), max: a.map((v, i) => Math.max(v, b[i])) };
  }

  /** Where the robot is, for the model. */
  here() {
    const { x, y, z, facing } = this.pose;
    return `${Frame.world(x, y, z)}, facing ${COMPASS_NAMES[facing]} (${facingAxis(facing)})`;
  }

  /**
   * Label the bare "x y z" triples in a line of text (e.g. the pathfinder's messages) as world
   * coordinates, "x=.. y=.. z=..", and drop its "facing ..." details. They narrate a trip that is
   * over by the time the model reads them, so relative words would be misleading.
   */
  convertText(text) {
    return text
      .replace(/ facing [XZ][+-] \((north|south|east|west)\)/g, '')
      .replace(/(^|[^\d.-])(-?\d+) (-?\d+) (-?\d+)(?!\.?\d)/g, (m, pre, x, y, z) => `${pre}${Frame.world(Number(x), Number(y), Number(z))}`);
  }
}

function facingAxis(facing) {
  return ['Z+', 'X-', 'Z-', 'X+'][facing];
}

module.exports = { Frame, COMPASS_NAMES, REL_KEYS };
