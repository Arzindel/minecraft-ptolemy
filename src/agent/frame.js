'use strict';

const { FORWARD, turnLeft } = require('./pose');

const COMPASS_NAMES = ['south', 'west', 'north', 'east'];

/**
 * The coordinates the LLM sees. In the relative frame the robot is always at 0 0 0 and the axes
 * turn with it: x = its left, y = up, z = ahead. So 0 0 1 is the block in front of it, 0 1 0 the
 * one above, 1 0 0 the one on its left, whatever way it faces in the world. In the world frame,
 * coordinates are Minecraft's own.
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
 */
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

  /** "x y z" of a world position, in this frame. */
  fmt(x, y, z) {
    return this.from(x, y, z).join(' ');
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
    return this.relative
      ? `0 0 0 (you). World position ${x} ${y} ${z}, facing ${COMPASS_NAMES[facing]}: only needed for run_command`
      : `${x} ${y} ${z}, facing ${COMPASS_NAMES[facing]} (${facingAxis(facing)})`;
  }

  /**
   * Rewrite world coordinates in a line of text (e.g. the pathfinder's messages) into this frame,
   * dropping "facing ..." details that only make sense in world terms.
   */
  convertText(text) {
    if (!this.relative) return text;
    return text
      .replace(/ facing [XZ][+-] \((north|south|east|west)\)/g, '')
      .replace(/(^|[^\d.-])(-?\d+) (-?\d+) (-?\d+)(?!\.?\d)/g, (m, pre, x, y, z) => `${pre}${this.fmt(Number(x), Number(y), Number(z))}`);
  }
}

function facingAxis(facing) {
  return ['Z+', 'X-', 'Z-', 'X+'][facing];
}

module.exports = { Frame, COMPASS_NAMES };
