'use strict';

const fs = require('fs');
const path = require('path');

// A tiny .env reader/writer (no dotenv dependency). Secrets such as API keys live in `.env` at the
// project root, which is git-ignored, instead of data/settings.json.

const FILE = path.join(__dirname, '..', '.env');

function parse(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value.replace(/\\n/g, '\n');
  }
  return out;
}

/** Load .env into process.env without overriding variables that are already set. */
function loadEnv() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parse(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Set (or remove, with an empty value) one variable in .env and in process.env. */
function setEnvVar(name, value) {
  let lines = [];
  try {
    lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
  } catch { /* new file */ }
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  lines = lines.filter((line) => !re.test(line));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (value) lines.push(`${name}=${JSON.stringify(String(value))}`);
  if (!lines.length || !lines.some((l) => l.startsWith('#'))) {
    lines.unshift('# Ptolemy secrets (API keys). This file is git-ignored: never commit it.');
  }
  fs.writeFileSync(FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
  if (value) process.env[name] = String(value);
  else delete process.env[name];
}

module.exports = { loadEnv, setEnvVar, ENV_FILE: FILE };
