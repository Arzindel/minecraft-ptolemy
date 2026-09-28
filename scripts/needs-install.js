'use strict';

// Used by start.bat / start.sh: exits with 1 when `npm install` is needed (no packages yet, or
// package.json changed since they were installed), 0 otherwise.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
try {
  const installed = fs.statSync(path.join(root, 'node_modules', '.package-lock.json')).mtimeMs;
  const wanted = Object.keys(require(path.join(root, 'package.json')).dependencies || {});
  const missing = wanted.some((name) => !fs.existsSync(path.join(root, 'node_modules', name, 'package.json')));
  process.exit(missing || fs.statSync(path.join(root, 'package.json')).mtimeMs > installed ? 1 : 0);
} catch {
  process.exit(1);
}
