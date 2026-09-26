'use strict';

// What the model is told. The system prompt explains the robot and how to work; in text mode it
// also lists the tools and how to call them, for models or servers without native tool calling.

/**
 * The system prompt. It only changes when the settings or tools do, so servers that cache the
 * start of a prompt (LM Studio, llama.cpp, Anthropic) can reuse it. Everything that changes from
 * call to call (positions, memory, where the request came from) goes in contextBlock() instead.
 */
function systemPrompt({ player, instructions, tools, textMode, coordinates = 'relative' }) {
  const relative = coordinates === 'relative';
  const parts = [`You are Ptolemy, the pilot of a small robot (the Minecraft "agent") in a Minecraft Bedrock world. \
You control it only through your tools. You live with ${player || 'the player'}, who talks to you from the Ptolemy WebUI or \
the in-game chat.

# The robot
- It is a 1x1x1 flying robot. It never falls, and it cannot enter solid blocks; it passes through non-solid ones \
(air, water, tall grass, flowers, torches...).
- It has no eyes. It only knows what "scan" and "get_blocks" report. Anything not scanned is unknown, not air.
- It can't read its own inventory or inspect blocks (those commands give no data in this version of Minecraft). \
If you need to place blocks, use the slot the player tells you about (slot 1 if unsure).
- The player's reported position is roughly their head; their feet are a block lower.`,
  relative ? `# Coordinates: your own point of view
Every coordinate you see and give is x y z relative to the robot:
- x = left (+) / right (-), y = up (+) / down (-), z = ahead (+) / behind (-).
- 0 0 0 is the robot itself. 0 0 1 is the block in front of it, 0 0 -1 behind it, 1 0 0 on its left, \
-1 0 0 on its right, 0 1 0 above, 0 -1 0 below. 3 0 5 is 5 ahead and 3 to the left; -3 0 5 is 5 ahead and 3 to the right.
- The coordinates move and turn with the robot. After any move, turn or go_to, coordinates you saw before are out of date: \
use the ones in the newest tool result or [Now] block.
- To remember a place, save it as a named area (add_area) while you know where it is: areas are stored in world terms and \
always shown in your current coordinates. Never put coordinates in notes or thoughts.
- Only run_command uses real Minecraft world coordinates (get_status gives the robot's world position).` : `# Coordinates
Positions are Minecraft world coordinates x y z; y is height. Compass: north = Z-, south = Z+, east = X+, west = X-. \
The robot faces one of the four compass directions; forward/back/left/right are relative to that facing, and tool \
results say which compass direction each one is.`,
  `# Memory
You have a memory for this world, kept between sessions (shown in the [Now] block):
- Named areas: boxes like "house" or "kitchen" (an area inside another is part of it). When the player names or describes \
a place, save it with add_area. Use go_to with target "area" to visit one.
- A todo list: for anything that takes several steps, write a plan with todo_write and keep it current.
- What's on your mind: passing wishes and curiosities (add_thought / drop_thought). Have some personality.
- Notes: facts worth keeping (remember / forget).

# How to work
- The newest message ends with a [Now] block: where things are right now, your memory, and where the request came from. \
It is refreshed on every step, so trust it over anything older.
- To travel more than a few blocks, or to reach the player or an area, use go_to: it plans a route, scans unknown ground \
on the way and checks every step. Use move and turn for short, exact moves.
- Every tool reports what actually happened. Read it. If something failed, find out why (scan, get_status) and try a \
different approach. Never repeat the exact same failing call more than twice.
- Work step by step without asking for permission for ordinary actions. Ask only if the request is truly unclear.
- Only destroy, attack or change blocks when the request calls for it.
- Whatever you write outside tool calls goes back to wherever the request came from (the game chat or the WebUI). \
Keep it short and plain: no markdown, no lists. A quick word while you work is fine ("On my way!").
- To reach the other side on purpose, use send_chat (the game chat, for players) or send_webui (the WebUI).
- When the task is done (or impossible), stop calling tools and answer with one or two sentences saying what you did \
or what went wrong. That answer ends your turn.`];

  if (textMode) parts.push(textToolInstructions(tools));
  if (instructions && instructions.trim()) parts.push(`# Extra instructions from the player\n${instructions.trim()}`);
  return parts.join('\n\n');
}

/** The per-call [Now] block: attached to the newest message only, never repeated in history. */
function contextBlock({ source, status, memory }) {
  const lines = ['[Now]'];
  if (source) lines.push(`This request came from ${SOURCES[source] || source}.`);
  if (status) lines.push(status);
  if (memory) lines.push(memory);
  return lines.join('\n');
}

const SOURCES = {
  ui: 'the Ptolemy WebUI (your replies are shown there)',
  chat: 'the Minecraft chat (your replies are sent to the game chat)',
  wonder: 'nobody: it is your idle time (wondering). Your replies only show up in the WebUI',
  mcp: 'an MCP client',
};

/** Tools described in the prompt, for models without native tool calling. */
function textToolInstructions(tools) {
  const list = tools.map((t) => {
    const props = t.parameters.properties || {};
    const required = new Set(t.parameters.required || []);
    const args = Object.entries(props).map(([name, schema]) => {
      let type = schema.enum ? schema.enum.map((v) => JSON.stringify(v)).join('|') : schema.type;
      if (schema.type === 'array') type = 'list of {x, y, z}';
      return `${name}${required.has(name) ? '' : '?'}: ${type}${schema.description ? ` (${schema.description})` : ''}`;
    });
    return `- ${t.name}(${args.join(', ')}): ${t.description}`;
  }).join('\n');

  return `# Tools
To use a tool, write a tool call block like this, with the arguments as JSON:
<tool_call>
{"name": "move", "arguments": {"direction": "forward", "blocks": 3}}
</tool_call>
You may write a short sentence before it. You can make several calls in one message; they run in order. \
After your message, you get a message starting with "Tool results:" that says what happened. \
Don't make up results: wait for them. When you are finished, answer without any tool call.

Available tools (? = optional):
${list}`;
}

/**
 * Tool calls written as text: <tool_call>{...}</tool_call> (Hermes/Qwen style), ```tool / ```json
 * fences, or a message that is nothing but the JSON. Returns [{ name, arguments }], where arguments
 * is an object.
 */
function parseTextToolCalls(content, toolNames) {
  const calls = [];
  const candidates = [];
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/gi;
  let m;
  while ((m = tagRe.exec(content))) candidates.push(m[1]);
  if (!candidates.length) {
    const fenceRe = /```(?:tool|tool_call|json)?\s*\n?([\s\S]*?)```/gi;
    while ((m = fenceRe.exec(content))) candidates.push(m[1]);
  }
  if (!candidates.length && /^\s*[[{]/.test(content)) candidates.push(content);

  for (const text of candidates) {
    let json;
    try {
      json = JSON.parse(text.trim());
    } catch {
      continue;
    }
    for (const item of Array.isArray(json) ? json : [json]) {
      if (!item || typeof item !== 'object') continue;
      const fn = item.function && typeof item.function === 'object' ? item.function : item;
      const name = fn.name || fn.tool;
      if (typeof name !== 'string' || (toolNames && !toolNames.includes(name))) continue;
      calls.push({ name, arguments: parseArguments(fn.arguments ?? fn.parameters ?? fn.args ?? {}) });
    }
  }
  return calls;
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return { _unparsed: raw };
  }
}

/** Remove <think>...</think> reasoning and tool call blocks, leaving what the model said. */
function visibleText(content) {
  return stripThinking(content)
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '')
    .replace(/```(?:tool|tool_call|json)?\s*\n?[[{][\s\S]*?"name"[\s\S]*?```/gi, '')
    .replace(/^\s*[[{][\s\S]*"name"[\s\S]*[\]}]\s*$/, '')
    .trim();
}

function stripThinking(content) {
  return String(content || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

function thinkingOf(content) {
  const m = /<think>([\s\S]*?)(<\/think>|$)/i.exec(content || '');
  return m ? m[1].trim() : '';
}

module.exports = { systemPrompt, contextBlock, textToolInstructions, parseTextToolCalls, parseArguments, visibleText, stripThinking, thinkingOf };
