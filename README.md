# Ptolemy

**An LLM, a Minecraft agent, and a bad idea.**

Minecraft Bedrock Edition still ships the `agent` command it inherited from Education Edition: a small,
indestructible robot that does exactly one thing per command and never checks whether it worked.
Bedrock can also open a WebSocket to an external program with `/connect`, which lets that program run
commands in the world without any mods.

Ptolemy connects the two. The end goal is an MCP-style loop where an LLM drives the agent. It is slow,
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
| Automatic mode: LLM control (NVIDIA Build, text-generation-webui, LM Studio) | 🔜 Planned |
| Instructions from in-game chat | 🔜 Planned (chat is already captured) |

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
| `#scan` / `#scan <size>` | Identify every block around the agent: its field of view, or with a size like `5` a 5×5×5 cube centred on it (odd sizes up to 31). See [Scanning](#scanning) |
| `#inflight <n>` | How many commands may be outstanding at once: 100 by default, which is also the maximum. Bedrock silently drops every request beyond 100 in flight (at N in flight, exactly N − 100 never get answered) |
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

## Scanning

In plain Bedrock, the agent's own sensing commands (`agent inspect`, `detect`, `getitem*`) succeed but
return no data. Only `agent getposition` does. So Ptolemy senses the world with ordinary commands:

1. `agent getposition` gives the agent's block position and `y-rot`, snapped to a facing:
   `0` → Z+, `90` → X-, `±180` → Z-, `-90` → X+.
2. For every cell in the agent's field of view, `testforblock x y z air` either matches (air) or fails
   with "The block at X,Y,Z is Oak Log (expected: Air)", which names the block.

The field of view, relative to the agent (right, up, forward), is 63 blocks:

- everything within 1 block, diagonals and the agent's own cell included (in case it's standing in water),
- widened by 1 block to each side: right −2…2, up −1…1, forward −1…1,
- plus 2 more blocks forward: right −1…1, up −1…1, forward 2…3.

`#scan` prints three top-down layers (above, level, below) from the agent's point of view. Forward
is up the page and `[ ]` marks the agent's cell. Click the result to see every cell with its world
and relative coordinates.

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
  web/server.js          static file server + WebUI socket
public/
  index.html, style.css, app.js   the WebUI
abandoned-minimap-project/        old prototype, kept for reference only
```

## Safety notes

- `/connect` gives Ptolemy the same command permissions as your player. Only run it on worlds you
  don't mind a robot (or an LLM) messing with.
- The Minecraft port accepts any client on your network. Don't expose it to the internet.
- The agent cannot be killed or removed. You have been warned. You were warned before that, too.
