#!/usr/bin/env node
'use strict';

// MCP over stdio, for clients that launch a command (e.g. Claude Desktop): forwards each
// newline-delimited JSON-RPC message to a running Ptolemy's /mcp endpoint and prints the reply.
// Ptolemy itself must already be running (`npm run start`); this process only relays.
//
//   node src/mcp/stdio.js [url]     default http://localhost:$PTOLEMY_UI_PORT/mcp (port 3000)

const readline = require('readline');

const URL = process.argv[2] || process.env.PTOLEMY_MCP_URL
  || `http://localhost:${Number(process.env.PTOLEMY_UI_PORT) || 3000}/mcp`;

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let chain = Promise.resolve(); // keep replies in request order

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  chain = chain.then(() => relay(message));
});

async function relay(message) {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
    });
    if (res.status === 202) return;
    const text = await res.text();
    if (!res.ok && !text.startsWith('{')) throw new Error(`${res.status} ${text}`);
    out(JSON.parse(text));
  } catch (err) {
    process.stderr.write(`[ptolemy-mcp] ${err.message}\n`);
    if (message.id !== undefined && message.id !== null) {
      out({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `Can't reach Ptolemy at ${URL} (${err.cause ? err.cause.code || err.cause.message : err.message}). Is it running?` },
      });
    }
  }
}
