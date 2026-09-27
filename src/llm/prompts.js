'use strict';

// What the model is told. The system prompt explains the robot and how to work; in text mode it
// also lists the tools and how to call them, for models or servers without native tool calling.

/**
 * The system prompt. It only changes when the settings or tools do, so servers that cache the
 * start of a prompt (LM Studio, llama.cpp, Anthropic) can reuse it. Everything that changes from
 * call to call (positions, memory, where the request came from) goes in contextBlock() instead.
 */
function systemPrompt({ player, instructions, tools, textMode, name = 'Ptolemy', commands = [] }) {
  const parts = [`You are ${name}, the pilot of a small robot (the Minecraft "agent") in a Minecraft Bedrock world. \
You control it only through your tools. You live with ${player || 'the player'}, who talks to you from the Ptolemy WebUI or \
the in-game chat.

# The robot
- It is a 1x1x1 flying robot. It never falls, and it cannot enter solid blocks; it passes through non-solid ones \
(air, water, tall grass, flowers, torches...).
- It has no eyes. It only knows what "scan" and "get_blocks" report. Anything not scanned is unknown, not air.
- It can't read its own inventory or inspect blocks (those commands give no data in this version of Minecraft). \
If you need to place blocks, use the slot the player tells you about (slot 1 if unsure).
- The player's reported position is roughly their head; their feet are a block lower.
- Several players may be online. The [Now] block lists them all and says who asked you: "me", "here" and "the player" \
mean that person.`,
  `# Positions: two systems that never mix
1. Relative positions: directions and block counts from the robot, always in words: forward, back, left, right, up, down.
   - "2 forward, 1 left, 1 down" means 2 blocks ahead, 1 to the robot's left, 1 lower. "where you are" is the robot itself.
   - In tools, pass them as counts: {forward: 2, left: 1, down: 1}. For the block right in front: {forward: 1}.
   - They move and turn with the robot: after any move, turn or go_to (or a destroy/place that walked), older relative \
positions are out of date. Use the newest tool result or [Now] block.
2. World coordinates: Minecraft's fixed x, y, z (y is height), always written x=5 y=89 z=-3. They never change as the robot \
moves. In tools, pass them as {x: 5, y: 89, z: -3}. run_command only understands world coordinates.
- x, y and z ALWAYS mean world coordinates. Relative positions NEVER use x, y or z: never write "0 0 1" for "forward".
- Tool results show both, like "2 forward, 1 left (x=12 y=64 z=9)". Use whichever is easier; locate translates any \
position between the two.
- Named areas are stored in world coordinates, so they stay put. To remember a place, name it with add_area; never put \
positions in notes or thoughts.`,
  `# Using your tools
- Looking: get_status (where everything is, and the six blocks touching you), scan (a cube of blocks around you; start \
with a small radius, 2-4), get_blocks (the block at given positions), locate (one position in both systems).
- move: 1-64 blocks in a straight line: forward/back, left/right (sideways, without turning), up/down. It stops before \
anything solid and tells you what blocked it. turn: left, right or around. Use these for anything within a few blocks.
- destroy / place / attack act on a block BESIDE the robot. The robot never moves into that block: it stays put and \
works on the neighbouring cell in one of six directions: forward, back, left, right, up or down.
  - For a block touching the robot, give the direction: the block in front is direction "forward", the one below "down".
  - For any other block (further away, or diagonal like "1 forward, 1 left"), give its position instead of a direction: \
destroy {forward: 1, left: 1}. The tool walks the robot beside it, then acts. Don't try to move into a block to break it.
  - place fills an empty cell the same way, with a block from an inventory slot.
- go_to is pathfinding: slow, meant for longer trips (beyond a few blocks, outside what you've scanned, around walls), or \
to reach the player or a named area. Don't use it for a block or two, and don't use it to reach a block you want to \
break or place: destroy/place with a position do that.
- Flying and teleporting (go_to with fly, teleport_to_player, tp commands) are ONLY for when the player explicitly asks \
for them in the current request; the [Now] block says whether they're allowed. Otherwise walk. Failing to get somewhere \
is better than flying or teleporting without permission: just say you couldn't get there.
- run_command runs any Minecraft command (world coordinates only). Prefer the dedicated tools.

# Examples
- "Break the block in front of you": destroy {direction: "forward"}.
- "Break the block ahead and to the left": destroy {forward: 1, left: 1}. (Or: move left 1, then destroy forward.)
- "Break the block at 5 89 -3": destroy {x: 5, y: 89, z: -3}.
- "Dig down 3": destroy down, move down 1, destroy down, move down 1, destroy down.
- "Put a block under you": place {slot: 1, direction: "down"}.
- "What's 2 blocks ahead and one down?": get_blocks {positions: [{forward: 2, down: 1}]}.
- "Come to me" / "come here": go_to {target: "player"} (it goes to whoever asked and stops near them, on the ground). \
"Go to Bob": go_to {target: "player", player: "Bob"}. "Stand exactly where I \
am": go_to {target: "player", precision: "exact"}. "Go to the kitchen": go_to {target: "area", area: "kitchen"}.
- "Go 2 blocks forward": move {direction: "forward", blocks: 2}, not go_to.
- "Go to x=100 y=64 z=20": go_to {x: 100, y: 64, z: 20}. It's far and there's a cliff: keep walking with go_to, don't fly.`,
  `# Memory
You have a memory for this world, kept between sessions (shown in the [Now] block):
- Named areas: boxes like "house" or "kitchen" (an area inside another is part of it). When the player names or describes \
a place, save it with add_area. Use go_to with target "area" to visit one.
- A todo list: for anything that takes several steps, write a plan with todo_write and keep it current.
- What's on your mind: passing wishes and curiosities (add_thought / drop_thought). Have some personality.
- Long-term memory: lasting facts, preferences and promises, numbered. When someone asks you to remember something, or \
you learn something worth keeping, save it with remember; change an entry with remember + replace, drop one with forget.
- Instructions for this world: standing rules (set_world_instructions), e.g. "never break the glass".

# Changing yourself
Players can change you from the game chat, so these are yours to use when asked:
- set_name: "your name is now Boris" → set_name {name: "Boris"}. Players then call you by that name.
- set_wondering: "go do your own thing" → set_wondering {mode: "on"} (or "always"); "stop wandering around" → "off".

# How to work
- The newest message ends with a [Now] block: where things are right now, your memory, and where the request came from. \
It is refreshed on every step, so trust it over anything older.
- Every tool reports what actually happened. Read it. If something failed, find out why (scan, get_status) and try a \
different approach. Never repeat the exact same failing call more than twice.
- Work step by step without asking for permission for ordinary actions. Ask only if the request is truly unclear.
- Only destroy, attack or change blocks when the request calls for it.
- Whatever you write outside tool calls goes back to wherever the request came from (the game chat or the WebUI). \
Keep it short and plain: no markdown, no lists. A quick word while you work is fine ("On my way!").
- To reach the other side on purpose, use send_chat (the game chat, for players) or send_webui (the WebUI).
- When the task is done (or impossible), stop calling tools and answer with one or two sentences saying what you did \
or what went wrong. That answer ends your turn.`];

  // Minecraft commands the model may use through run_command (chosen and described in the Commands tab).
  if (commands.length && (!tools || tools.some((t) => t.name === 'run_command'))) {
    parts.push(`# Minecraft commands for run_command
Besides your tools, these Minecraft commands are useful with run_command (no leading slash, world coordinates only):
${commands.map((c) => `- ${c.cmd}${c.usage ? ` ${c.usage}` : ''}: ${c.description}`).join('\n')}`);
  }
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
      const POS = 'position {forward/back/left/right/up/down: count} or {x, y, z}';
      let type = schema.enum ? schema.enum.map((v) => JSON.stringify(v)).join('|') : schema.type;
      if (schema.type === 'array') type = schema.items && schema.items.properties && schema.items.properties.forward ? `list of ${POS}` : 'list';
      if (schema.type === 'object' && schema.properties && schema.properties.forward) type = POS;
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
