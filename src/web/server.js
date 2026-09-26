'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const LOG_HISTORY = 500;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serves the WebUI over HTTP and keeps every open browser tab in sync
 * with the Minecraft bridge through a WebSocket on `/ui`.
 */
class WebServer {
  constructor({ port, bridge }) {
    this.port = port;
    this.bridge = bridge;
    this.log = [];
    this.nextLogId = 1;

    this.http = http.createServer((req, res) => this._serveStatic(req, res));
    this.wss = new WebSocket.Server({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://localhost').pathname !== '/ui') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this._onClient(ws));
    });

    bridge.on('status', () => this._broadcastStatus());
    bridge.on('log', (text) => this._addLog('system', text));
    bridge.on('command', ({ id, commandLine }) => {
      this._addLog('command', commandLine, { requestId: id });
      this._broadcastStatus();
    });
    bridge.on('response', (res) => {
      this._addLog(res.ok ? 'response' : 'error', res.statusMessage, {
        requestId: res.id,
        commandLine: res.commandLine,
        statusCode: res.statusCode,
        body: res.body,
      });
      this._broadcastStatus();
    });
    bridge.on('chat', ({ sender, message }) => this._addLog('chat', message, { sender }));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, resolve);
    });
  }

  close() {
    this.wss.clients.forEach((ws) => ws.close());
    this.http.close();
  }

  status() {
    return {
      type: 'status',
      minecraft: this.bridge.getStatus(),
      mcPort: this.bridge.port,
      addresses: localAddresses(),
    };
  }

  // ---------------------------------------------------------------------------

  _onClient(ws) {
    ws.send(JSON.stringify(this.status()));
    ws.send(JSON.stringify({ type: 'history', entries: this.log }));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }

      switch (msg.type) {
        case 'command':
          this.bridge.sendCommand(msg.text);
          break;
        case 'disconnect':
          this.bridge.disconnect();
          break;
        case 'clearLog':
          this.log = [];
          this._broadcast({ type: 'history', entries: [] });
          break;
        default:
          break;
      }
    });
  }

  _addLog(kind, text, extra = {}) {
    const entry = { ...extra, id: this.nextLogId++, time: Date.now(), kind, text: String(text ?? '') };
    this.log.push(entry);
    if (this.log.length > LOG_HISTORY) this.log.splice(0, this.log.length - LOG_HISTORY);
    this._broadcast({ type: 'log', entry });
  }

  _broadcastStatus() {
    this._broadcast(this.status());
  }

  _broadcast(message) {
    const payload = JSON.stringify(message);
    this.wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
  }

  _serveStatic(req, res) {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, relative));

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    });
  }
}

/** LAN IPv4 addresses, so the UI can suggest a `/connect` target for other devices. */
function localAddresses() {
  const out = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

module.exports = { WebServer };
