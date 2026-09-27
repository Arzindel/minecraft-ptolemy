'use strict';

const { systemPrompt } = require('../llm/prompts');
const { Frame } = require('../agent/frame');
const { getAgentPose } = require('../agent/pose');

// A small Model Context Protocol server over "Streamable HTTP" (JSON responses only, no SSE),
// serving the same tools as Automatic mode, so MCP clients (Claude Desktop through `npm run mcp`,
// LM Studio, Cursor...) can drive the robot too. JSON-RPC 2.0, one request per POST.

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;
const SERVER_INFO = { name: 'ptolemy', title: 'Ptolemy (Minecraft agent)', version: require('../../package.json').version };

class McpServer {
  /**
   * @param {object} deps
   * @param {ReturnType<import('../tools').createToolbox>} deps.toolbox
   * @param {import('../settings').Settings} deps.settings
   * @param {import('../minecraft/bridge').MinecraftBridge} deps.bridge
   * @param {import('../world/manager').WorldManager} [deps.worlds]
   */
  constructor({ toolbox, settings, bridge, worlds, commands }) {
    Object.assign(this, { toolbox, settings, bridge, worlds, commands });
  }

  /** Handle an HTTP request to /mcp. */
  handleHttp(req, res) {
    if (!this.settings.get('mcp.enabled')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('The MCP server is turned off in the Configuration tab.');
      return;
    }
    // Browsers send an Origin; only pages from this machine may talk to us (DNS rebinding guard).
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden origin');
      return;
    }
    if (req.method !== 'POST') {
      // No server-initiated stream: GET (and DELETE of a session) aren't supported.
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' }).end('Use POST with a JSON-RPC message.');
      return;
    }

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
        return;
      }
      const reply = await this.handleMessage(message);
      if (reply === null) res.writeHead(202).end();
      else sendJson(res, 200, reply);
    });
  }

  /** Handle one JSON-RPC message (or a batch). Returns the reply, or null for notifications. */
  async handleMessage(message) {
    if (Array.isArray(message)) {
      const replies = (await Promise.all(message.map((m) => this.handleMessage(m)))).filter(Boolean);
      return replies.length ? replies : null;
    }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // A response to something we never send, or garbage.
      return message && message.id !== undefined && !message.method ? null : rpcError(message && message.id, -32600, 'Invalid Request');
    }
    const { id, method, params = {} } = message;
    const isNotification = id === undefined || id === null;
    try {
      const result = await this._dispatch(method, params);
      return isNotification ? null : { jsonrpc: '2.0', id, result };
    } catch (err) {
      return isNotification ? null : rpcError(id, err.code || -32603, err.message);
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Tools to drive a Minecraft Bedrock "agent" robot through Ptolemy. '
            + 'Start with get_status. Use go_to for travel, scan to see around the robot. '
            + 'The "pilot" prompt explains the robot in detail.',
        };
      }
      case 'ping':
        return {};
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'tools/list':
        return {
          tools: this.toolbox.list().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
            annotations: {
              readOnlyHint: ['get_status', 'scan', 'get_blocks', 'nearby_entities', 'get_memory'].includes(t.name),
              destructiveHint: Boolean(t.destructive || t.raw),
            },
          })),
        };
      case 'tools/call': {
        if (typeof params.name !== 'string') throw Object.assign(new Error('Missing tool name'), { code: -32602 });
        const res = await this.toolbox.call(params.name, params.arguments || {}, { origin: 'MCP' });
        return { content: [{ type: 'text', text: res.text }], isError: !res.ok };
      }
      case 'prompts/list':
        return {
          prompts: [{
            name: 'pilot',
            title: 'Pilot the Ptolemy robot',
            description: 'How the robot works and how to drive it with these tools, optionally with a task.',
            arguments: [{ name: 'task', description: 'What the robot should do.', required: false }],
          }],
        };
      case 'prompts/get': {
        if (params.name !== 'pilot') throw Object.assign(new Error(`Unknown prompt "${params.name}"`), { code: -32602 });
        const coordinates = this.settings.get('llm.coordinates');
        let frame = null;
        try {
          if (this.bridge.connected) frame = new Frame(await getAgentPose(this.bridge), coordinates);
        } catch { /* no agent: memory shown in world coordinates */ }
        const memory = this.worlds && this.worlds.current ? this.worlds.current.promptBlock(frame) : '';
        const text = `${systemPrompt({
          name: this.settings.get('chat.name') || 'Ptolemy',
          commands: this.commands ? this.commands.promptCommands() : [],
          player: this.bridge.player,
          instructions: this.settings.get('llm.instructions'),
          tools: this.toolbox.list(),
          textMode: false,
        })}\n\nOver MCP there is no [Now] block: call get_status to see where things are.${memory ? `\n\n${memory}` : ''}`;
        const task = params.arguments && params.arguments.task;
        return {
          description: 'Pilot the Ptolemy robot',
          messages: [{ role: 'user', content: { type: 'text', text: task ? `${text}\n\n# Task\n${task}` : text } }],
        };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

module.exports = { McpServer };
