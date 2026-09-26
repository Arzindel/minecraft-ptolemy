'use strict';

// The agent's pose: its block position plus a facing, 0-3, derived from y-rot.
// y-rot 0 faces Z+ (south), 90 faces X- (west), ±180 faces Z- (north), -90 faces X+ (east),
// so turning right adds 90° and turning left subtracts 90°.
const FACING_NAMES = ['Z+ (south)', 'X- (west)', 'Z- (north)', 'X+ (east)'];
const FORWARD = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];

function facingFromRotation(yRot) {
  return ((Math.round(yRot / 90) % 4) + 4) % 4;
}

function turnRight(facing) { return (facing + 1) % 4; }
function turnLeft(facing) { return (facing + 3) % 4; }

/** Ask the game where the agent is. Resolves to { x, y, z, facing, yRot } or throws. */
async function getAgentPose(bridge) {
  const res = await bridge.sendCommand('agent getposition', { quiet: true });
  if (!res.ok || !res.body || !res.body.position) {
    throw new Error(`agent getposition failed: ${res.statusMessage}`);
  }
  const { x, y, z } = res.body.position;
  const yRot = res.body['y-rot'] ?? 0;
  return { x, y, z, yRot, facing: facingFromRotation(yRot) };
}

function samePose(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.facing === b.facing;
}

function describePose(p) {
  return `${p.x} ${p.y} ${p.z} facing ${FACING_NAMES[p.facing]}`;
}

module.exports = {
  FACING_NAMES, FORWARD, facingFromRotation, turnLeft, turnRight, getAgentPose, samePose, describePose,
};
