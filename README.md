# Ptolemy

**An LLM, a Minecraft agent, and a bad idea.**

Minecraft Bedrock Edition still ships the `agent` command it inherited from Education Edition: a small,
indestructible robot that does exactly one thing per command and never checks whether it worked.
Bedrock can also open a WebSocket to an external program with `/connect`, which lets that program run
commands in the world without any mods.

Ptolemy connects the two. An LLM drives the agent in an MCP-style loop. It is slow,
it wastes tokens, and it is awesome.

## The idea: make the agent a closed-loop system

On its own, the agent is an **open-loop** controller. It receives a command, executes it, and doesn't
care what actually happened. For an LLM to control it properly, the loop has to be closed: sense,
act, sense again. Doing that naively means re-scanning the surroundings after every step, which
is painfully slow.

The fix is to scan less. Ptolemy works like a **Roomba**:

1. You give it a bounded region (a coordinate box) that the agent must stay inside.
2. It maps that region once and remembers every block.
3. After each action it only re-scans a small neighbourhood around the agent and updates the map.

The LLM reasons over the stored map, and the game is only asked about what might have changed.

## Status

| Piece | State |
| --- | --- |
| WebSocket bridge to Minecraft | ✅ Working |
| WebUI: header with connection status | ✅ Working |
| Manual mode: raw command console | ✅ Working |
| Information panel (connection info, response inspector) | ✅ Basic |
| Manual mode: agent buttons (move, turn, detect, teleport...) | 🔜 Next |
| Bounded-region mapping (the Roomba part) | 🔜 Planned |
| Scanning, pathfinding, Nanny Cam 3D view | ✅ Working |
| Automatic mode: LLM control (LM Studio, text-generation-webui, NVIDIA Build, any OpenAI-compatible server) | ✅ New, needs real-world testing |
| Instructions from in-game chat (`ptolemy, come here`) | ✅ New |
| MCP server (the same tools for Claude Desktop, LM Studio, Cursor...) | ✅ New |

## Requirements

- **Node.js 18.11 or newer** (for `--watch`)
- **Minecraft Bedrock Edition**, unmodded. No add-ons or behaviour packs are required.
- A world with **cheats enabled**.
- In Minecraft: `Settings → General → Require Encrypted Websockets` turned **off**.
- For `agent` commands, turn on **Education Edition** in the world settings (under *Cheats* /
  *Experiments*, depending on your game version). Without it the game rejects `agent` commands, while
  other commands still work.

## Quick start

```bash
npm install
npm run start
```

`npm run start` runs in watch mode. When code under `src/` changes (after a `git pull`, say), Ptolemy
restarts itself. Minecraft is the side that opens the connection, so after a restart you need to run
`/connect` in the game again. The WebUI reconnects on its own. If you'd rather not have automatic
restarts, use `npm run start:once`. If a pull adds new dependencies, you still need `npm install`.

Then:

1. Open **http://localhost:3000** in your browser.
2. In Minecraft, open chat and run:
   ```
   /connect localhost:8080
   ```
   (If Minecraft runs on another device, use the PC's LAN IP instead of `localhost`. Hover the connect
   command in the WebUI to see the addresses.)
3. The header switches to **Connected as &lt;your name&gt;**. Type commands into the Manual console, e.g.
   ```
   agent create
   agent move forward
   agent turn left
   agent detect forward
   agent tp 0 64 0
   ```

The leading `/` is optional.

**Agent results arrive separately.** An `agent` command's response only confirms that the command ran
(`"Agent inspect successful"`). The actual outcome, like the block `inspect` saw or whether `detect`
found something, arrives shortly after as an `AgentCommand` game event. Ptolemy subscribes to it
automatically and shows it as a 🤖 line in the console.

### Console commands

Lines starting with `#` are handled by Ptolemy instead of being sent to the game:

| Command | What it does |
| --- | --- |
| `#subscribe <Event> [Event...]` | Subscribe to game events, e.g. `#subscribe BlockBroken ItemUsed`. Events are logged as ⚡ lines. |
| `#unsubscribe <Event> [Event...]` | Stop receiving those events |
| `#scan` / `#scan <radius>` | Identify every block in a cube reaching `radius` blocks out from the agent in every direction (2 = 5×5×5, up to 15 = 31×31×31), the same unit as the Nanny Cam's Zoom. Without a radius it uses the default from the Configuration tab (4). See [Scanning](#scanning) |
| `#inflight <n>` | How many commands may be outstanding at once: 100 by default, which is also the maximum. Bedrock silently drops every request beyond 100 in flight (at N in flight, exactly N − 100 never get answered) |
| `#pathfind <x y z \| @p>` | Plan a route for the agent that stays next to blocks, like it walks and climbs (see [Pathfinding](#pathfinding)) |
| `#pathwalk` | Walk the last planned route, checking the agent's pose after every step |
| `#pathfindwalk <x y z \| @p> [scan=7] [retries=3]` | Plan and walk, rescanning when entering unknown territory and re-planning when something is in the way |
| `#flypathfind` / `#flypathwalk` / `#flypathfindwalk` | The same, but taking the shortest route through the air |
| `#pathsafe on\|off` | On (default): if the agent isn't where it should be after a step, keep checking for up to 2s before calling it a failure. That costs nothing when steps succeed straight away. Off: check once |
| `#pathstop` | Stop a running walk after the current step |
| `#probe` / `#probe all` | Run every read-only agent command (getposition, and detect / detectredstone / inspect / inspectdata in all six directions, getitemcount / getitemdetail / getitemspace for slot 1, or all 27 slots with `all`) and list the data each one returns |
| `#cmdversion <value>` | Set the `body.version` sent with every command request: `1` (the default), a version string like `1.21.0`, or `off` to leave it out. Some commands may answer differently depending on it |
| `#raw <json>` | Send a hand-written WebSocket message exactly as given (a missing `header.requestId` is filled in). The reply is logged as an unmatched message |
| `#subscriptions` | List the current subscriptions, which are re-sent whenever Minecraft reconnects |
| `#help` | Show this list |

Subscribing isn't a Minecraft command (there's no `/subscribe`). It's a different kind of WebSocket
message, which is why it lives here. If the game rejects a subscription, the console says so. Any
message from the game that Ptolemy can't match to a command or event is logged too, so nothing
arrives unnoticed.

Click a response line to see the raw JSON the game sent back in the
Information panel.

### Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PTOLEMY_UI_PORT` | `3000` | Port for the WebUI (HTTP and its own WebSocket at `/ui`) |
| `PTOLEMY_MC_PORT` | `8080` | Port Minecraft connects to with `/connect` |
| `NVIDIA_API_KEY` | | NVIDIA Build API key, used when none is saved in the Configuration tab |
| `PTOLEMY_LLM_API_KEY` | | API key for any provider, used when none is saved |
| `PTOLEMY_MCP_URL` | `http://localhost:$PTOLEMY_UI_PORT/mcp` | Where `npm run mcp` relays to |

## Scanning

In plain Bedrock, the agent's own sensing commands (`agent inspect`, `detect`, `getitem*`) succeed but
return no data. Only `agent getposition` does. So Ptolemy senses the world with ordinary commands:

1. `agent getposition` gives the agent's block position and `y-rot`, snapped to a facing:
   `0` → Z+, `90` → X-, `±180` → Z-, `-90` → X+.
2. For every cell in a cube around the agent, `testforblock x y z air` either matches (air) or fails
   with "The block at X,Y,Z is Oak Log (expected: Air)", which names the block.

It's fast: with 100 commands in flight, Bedrock answers about 1,000 blocks a second, so a radius-15
scan (29,791 blocks) takes about 30 seconds.

`#scan` prints three top-down layers (above, level, below) from the agent's point of view. Forward
is up the page and `[ ]` marks the agent's cell. Click the result to see every cell with its world
and relative coordinates.

## Pathfinding

The agent flies like a 1×1×1 drone and can move through anything that isn't solid (air, water,
plants, torches...). A move into a solid block reports success, but the agent just shakes its head
and stays put. So the pathfinder plans over what the robot knows, and the walker checks every step.

- **Targets:** `x y z`, where each part can be `~` or `~n` relative to the agent, or `@p` for you.
  `@p` ends beside you at body height. A solid target means "go next to it".
- **Planning** is an A* search over position and facing. The robot turns to face where it's going
  (it looks better) and moves up and down without turning. A target sealed in by known solid blocks
  is refused straight away.
- **Unseen cells are unknown**, neither air nor wall. The terrain is assumed to carry on as last seen:
  an unseen cell costs a ground step at the walking height of the nearest scanned column, and the
  airborne price above or below it. Every unseen cell also costs the "unseen" penalty on top.
  `#pathfindwalk` stops and rescans before entering one, so a cliff just past the edge of Sight is
  found and climbed down, not flown over.
- **`#pathfind` vs `#flypathfind`:** the fly version takes the shortest route through the air (every
  move costs 1). The plain version follows the path of least resistance for something that walks,
  swims and climbs. Entering a cell costs by its best known support, and a cell in water always
  costs the water price. Read the costs as "how many ground steps would it rather walk than go
  through this". Defaults are below; they're all adjustable in the Configuration tab. Turns cost 1.

  | Support | Solid block | Cost |
  | --- | --- | --- |
  | Ground | directly below | 1 |
  | Ground edge | below, sharing an edge | 3 |
  | Water | the cell itself is water | 5 |
  | Wall | beside, sharing a face | 5 |
  | Wall edge | level, sharing an edge | 8 |
  | Ground corner | below, sharing only a corner | 10 |
  | Ceiling | directly above | 15 |
  | Ceiling edge | above, sharing an edge | 20 |
  | Ceiling corner | above, sharing only a corner | 20 |
  | Airborne | nothing around | 40 |

  When every route is expensive (say, a target up in open air), the exact search gets a time budget
  and then falls back to a greedier one. The plan says when it's such a quick estimate.
- **Walking:** every step has an expected pose (position and facing). After each step Ptolemy runs
  `agent getposition`, and the walk stops at the first mismatch. With `#pathsafe on` it polls for up
  to 2 seconds first, in case moves turn out not to be instant.
- **`#pathfindwalk`** scans first, then walks. Before entering unknown cells it stops, rescans and
  re-plans. Those rescans are budgeted at ⌈1.5 × distance ÷ scan radius⌉, so a robot trying to get
  into a closed box gives up. When a step fails (someone closed the door), it marks that cell as
  blocked, rescans and re-plans. That counts as a retry, and it hard-stops after `retries` failures.
- **Stored paths:** walking and flight paths are stored separately (`#pathwalk` walks the one from
  `#pathfind`, `#flypathwalk` the one from `#flypathfind`). A stored path is only valid while the
  agent is at its start. It's dropped as soon as the agent moves (by hand, by a walk of the other
  path, or as seen by a scan), and it's used up once walked.
- **Nanny Cam:** walking paths show as cyan beads and flight paths as magenta ones. They fade as the
  robot walks them, and a finished walk leaves a faded trail. The robot's marker follows it while it walks.

## Automatic mode (LLM)

The **Automatic** tab is a chat with the robot. Type a request ("come to me", "dig a 3x3 hole in front
of you", "what's around you?") and the LLM works it out with the robot's tools, one call at a time:
it calls a tool, reads what actually happened, and decides what to do next, until it answers without
calling a tool. Every tool call shows up in the transcript (click one to see the full result) and in
the Manual console as `LLM → tool {...}`. **Stop** stops the model and the robot; **New conversation**
makes it forget everything said so far.

Each request starts with the robot's and player's positions attached, so the model rarely has to ask.

### Setting up a model

Pick the provider in the **Configuration** tab. Each one keeps its own URL, key and model.

| Provider | Setup | Defaults |
| --- | --- | --- |
| **LM Studio** | Load a model and start the server (Developer tab, or `lms server start`). Models with the 🔨 tool-use badge work best | `http://localhost:1234/v1`, model empty = the first one listed, tools: Auto |
| **text-generation-webui** (oobabooga) | Start it with `--api` and load a model in its UI | `http://localhost:5000/v1`, model empty = whatever is loaded, tools: Text |
| **NVIDIA Build** | Get an `nvapi-...` key at [build.nvidia.com](https://build.nvidia.com) and paste it into **API key** (or set `NVIDIA_API_KEY`) | `https://integrate.api.nvidia.com/v1`, `meta/llama-3.3-70b-instruct`, tools: Auto |
| **Other OpenAI-compatible** | Ollama (`http://localhost:11434/v1`), llama.cpp's server, vLLM, OpenAI... | `http://localhost:8000/v1`, tools: Auto |

**List models** next to the model box asks the server what it offers.

**Tool calling** decides how the model learns about its tools:

- **Native** sends them in the API's `tools` parameter. Needs a model and server that support function
  calling.
- **Text** describes them in the system prompt and reads `<tool_call>{"name": ..., "arguments": ...}</tool_call>`
  blocks from the reply. Works with any instruction-following model, which is why it's the default for
  text-generation-webui.
- **Auto** tries native, and switches to text for the rest of the session if the server rejects the
  `tools` parameter. Tool calls written as text are picked up in native mode too, for servers that
  don't parse them.

The other LLM settings:
- Temperature.
- Max tokens per reply. Keep it generous for reasoning models; their `<think>` output shows collapsed
  as *Thinking*.
- Max model calls per request, a guard against runaways.
- The timeout.
- The conversation budget. Older turns are dropped, and old tool results shortened, to stay under it.
  It's about 4 characters per token, so lower it for small context windows.
- The maximum length of one tool result.
- **Extra instructions**, appended to the system prompt. The prompt itself is in `src/llm/prompts.js`.

### The tools

The LLM and MCP clients use the same tools (`src/tools/index.js`). Most bundle several commands and
report what really happened, because the game says "success" even when the robot bumped into a wall.

| Tool | What it does |
| --- | --- |
| `get_status` | Robot position and facing, which compass direction each relative direction is, the six blocks around it, the player's position and distance |
| `scan` | Scan a cube around the robot (updates Sight and the Nanny Cam) and summarize it: neighbours, the ground below, counts per block type, where the rarer blocks are, and ground height around |
| `get_blocks` | The block at up to 64 exact coordinates |
| `move` | Move 1–64 blocks forward/back/left/right/up/down, checking every step; reports what blocked it |
| `turn` | Turn left, right or around, or face north/south/east/west |
| `go_to` | `#pathfindwalk` to coordinates or to the player, optionally flying |
| `teleport_to_player` | `agent tp` |
| `destroy`, `place`, `attack` | The agent commands. For `destroy` and `place`, the target cell is checked before and after. `place` takes an inventory slot |
| `collect`, `drop` | Pick up items nearby, or drop items from a slot |
| `say` | A chat line from the robot (`<Ptolemy> ...`, via `tellraw`) |
| `wait` | Wait up to 60 seconds |
| `run_command` | Any Minecraft command, with the game's raw reply: the escape hatch for everything else |

`run_command` and `destroy`/`attack` can be turned off under **Tools and MCP**.

### From the in-game chat

Start a chat message with the robot's name: `ptolemy, come here`, `Ptolemy: build a tower`. It joins
the same conversation (shown as *(chat)* in the transcript), and the final answer comes back in the
chat. `ptolemy stop` stops it. Requests that arrive while it's busy wait their turn. Under **In-game chat**
in the Configuration tab you can change the name and choose whether it listens and answers at all.

## MCP server

Ptolemy is also an [MCP](https://modelcontextprotocol.io) server, so other AI apps can drive the robot
with the same tools. It offers the tools above plus a `pilot` prompt (the system prompt, with an
optional task).

- **Over HTTP** (Streamable HTTP, JSON responses) at `http://localhost:3000/mcp` while Ptolemy runs.
  For LM Studio, add it to `mcp.json`:
  ```json
  { "mcpServers": { "ptolemy": { "url": "http://localhost:3000/mcp" } } }
  ```
- **Over stdio**, for apps that launch a command, like Claude Desktop. `src/mcp/stdio.js` relays to the
  running Ptolemy, so start Ptolemy first (`npm run mcp` runs the relay by hand):
  ```json
  { "mcpServers": { "ptolemy": { "command": "node", "args": ["C:/path/to/minecraft-ptolemy/src/mcp/stdio.js"] } } }
  ```

Tool calls from MCP clients show up in the Manual console as `MCP → tool {...}`. The endpoint can be
turned off under **Tools and MCP**.

## Configuration

The **Configuration** tab holds the LLM, chat, tool and MCP settings described above, and the robot's tunables: the walking path costs, turn cost, unseen-cell penalty,
the rescan radius and retries for `#pathfindwalk`, safe mode and the in-flight limit. Changes apply
immediately, show up in every open tab, and are saved to `data/settings.json` (git-ignored), so they
survive restarts. `#pathsafe` and `#inflight` change the same settings. Values that differ from their
defaults are outlined, and **Reset to defaults** puts everything back.

## Nanny Cam

The **Nanny Cam** tab draws the robot's **Sight** (the latest scan) in 3D with WebGL2, using the GPU
and no libraries:

- **Scan** runs a scan of the chosen radius, same as `#scan`. Every new scan replaces Sight.
- **Drag** to orbit around the robot, **scroll** to move the camera closer or further, and
  **double-click** to reset.
- **Zoom** limits the view to the blocks within that many blocks of the robot, which helps indoors
  or underground. Cut faces are drawn, so you can see inside walls.
- **Hover** over a block to see its name and coordinates.
- The robot is the yellow block. Its darker nose points the way it's facing.

Air isn't drawn, and neither are blocks completely enclosed by other blocks. Water, glass and ice
are drawn see-through, as is everything the robot can move through (plants, flowers, torches...).
Block colours and the list of non-solid blocks live in `public/blocks.js`; blocks missing from the colour
table get a stable colour derived from their name.

## How it works

```
 ┌──────────────┐  /connect   ┌──────────────────────────┐   ws /ui   ┌─────────┐
 │  Minecraft   │ ──────────▶ │  Ptolemy (Node.js)       │ ◀────────▶ │  WebUI  │
 │  Bedrock     │ ◀────────── │  • MinecraftBridge :8080 │            │ browser │
 └──────────────┘  commands / │  • WebServer       :3000 │            └─────────┘
                   responses  └──────────────────────────┘
```

- **`src/minecraft/bridge.js`** is the WebSocket server the game connects to. It wraps every command
  in Bedrock's `commandRequest` envelope, matches each `commandResponse` to its request by
  `requestId`, and returns a promise per command. It caps how many commands are in flight, because
  Bedrock silently drops every request beyond 100 in flight. It also times out commands that get no answer
  and subscribes to `PlayerMessage` (in-game chat) and `AgentCommand` (the results of
  `agent` commands).
- **`src/web/server.js`** serves `public/` and relays status, commands, responses and chat to every
  open browser tab. It keeps a short log history, so a refreshed tab picks up where it left off.
- **`public/`** is the WebUI in plain HTML, CSS and JS, with no build step.

The only runtime dependency is [`ws`](https://github.com/websockets/ws), the WebSocket library.
Everything else is Node's standard library.

### Bedrock WebSocket message format

Command request sent to the game:

```json
{
  "header": { "requestId": "<uuid>", "messagePurpose": "commandRequest", "version": 1, "messageType": "commandRequest" },
  "body":   { "commandLine": "agent move forward", "version": 1, "origin": { "type": "player" } }
}
```

The game answers with `messagePurpose: "commandResponse"` and the same `requestId`. `body.statusCode`
is `0` on success and negative on failure. `body.statusMessage` is human-readable, and some commands
add extra fields.

## Project layout

```
src/
  index.js               entry point (npm run start)
  minecraft/bridge.js    Minecraft WebSocket bridge
  web/server.js          static file server, WebUI socket, console commands, chat requests
  settings.js            Configuration tab schema, saved to data/settings.json
  agent/                 scanning, world knowledge, pose, pathfinding, walking (Navigator)
  tools/index.js         the robot's tools, shared by the LLM and MCP
  llm/providers.js       LM Studio, text-generation-webui, NVIDIA Build, custom
  llm/client.js          OpenAI-compatible chat client (built-in fetch)
  llm/prompts.js         system prompt, text-mode tool calls
  llm/pilot.js           the Automatic mode loop and conversation
  mcp/server.js          MCP over HTTP at /mcp
  mcp/stdio.js           MCP over stdio, relaying to /mcp (npm run mcp)
public/
  index.html, style.css, app.js   the WebUI
  automatic.js, nannycam.js, config.js, blocks.js   the tabs, and block colours / solidity
abandoned-minimap-project/        old prototype, kept for reference only
```

## Safety notes

- `/connect` gives Ptolemy the same command permissions as your player. Only run it on worlds you
  don't mind a robot (or an LLM) messing with.
- The Minecraft port accepts any client on your network. Don't expose it to the internet. The same
  goes for the WebUI port, which also carries the MCP endpoint: anyone who can reach it can drive the
  robot and run commands (browsers on other sites are refused, other programs aren't).
- API keys are saved in plain text in `data/settings.json` (git-ignored) and never sent back to the
  browser. Use `NVIDIA_API_KEY` instead if you'd rather not store it.
- The LLM can run any command through `run_command` unless you turn it off in the Configuration tab.
- The agent cannot be killed or removed. You have been warned. You were warned before that, too.
