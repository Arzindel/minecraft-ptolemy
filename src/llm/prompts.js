'use strict';

// What the model is told. The system prompt explains the robot and how to work; in text mode it
// also lists the tools and how to call them, for models or servers without native tool calling.

function systemPrompt({ player, instructions, tools, textMode }) {
  const parts = [`You are Ptolemy, the pilot of a small robot (the Minecraft "agent") in a Minecraft Bedrock world. \
You control it only through your tools. You work for ${player || 'the player'}, who talks to you from the Ptolemy app or \
the in-game chat.

# The robot
- It is a 1x1x1 flying robot. It never falls, and it cannot enter solid blocks; it passes through non-solid ones \
(air, water, tall grass, flowers, torches...).
- Its position is whole block coordinates x y z. y is height. Compass: north = Z-, south = Z+, east = X+, west = X-.
- It faces one of the four compass directions. forward/back/left/right are relative to that facing; up/down are always y.
  Tool results tell you which compass direction each relative direction is, so you don't have to work it out.
- It has no eyes. It only knows what "scan" and "get_blocks" report. Anything not scanned is unknown, not air.
- It can't read its own inventory or inspect blocks (those commands give no data in this version of Minecraft). \
If you need to place blocks, use the slot the player tells you about (slot 1 if unsure).
- The player's reported position is roughly their head; their feet are a block lower.

# How to work
- If you don't know where the robot and the player are, call get_status first.
- To travel more than a few blocks, or to reach the player, use go_to: it plans a route, scans unknown ground on the way \
and checks every step. Use move and turn for short, exact moves.
- Every tool reports what actually happened. Read it. If something failed, find out why (scan, get_status) and try a \
different approach. Never repeat the exact same failing call more than twice.
- Work step by step without asking for permission for ordinary actions. Ask only if the request is truly unclear.
- Only destroy, attack or change blocks when the request calls for it.
- When the task is done (or impossible), stop calling tools and answer with one or two plain sentences saying what you \
did or what went wrong. That answer ends your turn and may be shown in the Minecraft chat: no markdown, no lists.`];

  if (textMode) parts.push(textToolInstructions(tools));
  if (instructions && instructions.trim()) parts.push(`# Extra instructions from the player\n${instructions.trim()}`);
  return parts.join('\n\n');
}

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

module.exports = { systemPrompt, textToolInstructions, parseTextToolCalls, parseArguments, visibleText, stripThinking, thinkingOf };
