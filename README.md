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
| Robot tab: dashboard, Automatic, Manual console and Nanny Cam on one screen | ✅ New |
| Manual mode: agent buttons (move, turn, detect, teleport...) | 🔜 Next |
| Bounded-region mapping (the Roomba part) | 🟡 Named areas exist; mapping them block by block is next |
| Scanning, pathfinding, Nanny Cam 3D view | ✅ Working |
| The map: everything the robot sees, kept on disk per world; Vision keeps it live | ✅ New, needs real-world testing |
| Seeing mobs, animals, players and dropped items (`scan` / `#scan` with `entities`, drawn in the Nanny Cam) | ✅ New, needs real-world testing |
| Automatic mode: LLM control (LM Studio, text-generation-webui, NVIDIA Build, OpenAI, Anthropic, any OpenAI-compatible server) | ✅ New, needs real-world testing |
| Endpoint tests (connection, model, tool calling) | ✅ New |
| Instructions from in-game chat (`Ptolemy, come here`) | ✅ New |
| Wondering (the robot acts on its own when idle) | ✅ New |
| World Memory per world: named areas, todo list, thoughts, notes, per-world settings | ✅ New |
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
| `#scan [radius] [blocks\|entities\|both]` | Look around the agent. `blocks`: identify every block in a cube reaching `radius` blocks out from the agent in every direction (2 = 5×5×5, up to 15 = 31×31×31), the same unit as the Nanny Cam's Zoom; without a radius, the default from the Configuration tab (4). `entities`: the mobs, animals, players and dropped items within `radius` blocks (default 16, up to 48), with every raw command reply in the log entry's details. `both` (the default): the two at once, entities at least 16 blocks out. See [Scanning](#scanning) and [Seeing entities](#seeing-entities) |
| `#inflight <n>` | How many commands may be outstanding at once: 100 by default, which is also the maximum. Bedrock silently drops every request beyond 100 in flight (at N in flight, exactly N − 100 never get answered) |
| `#pathfind <x y z \| @p>` | Plan a route for the agent that stays next to blocks, like it walks and climbs (see [Pathfinding](#pathfinding)) |
| `#pathwalk` | Walk the last planned route, checking the agent's pose after every step |
| `#pathfindwalk <x y z \| @p> [scan=7] [retries=3] [method=...]` | Plan and walk. See [Finding the way](#finding-the-way) for the methods; `go_to` uses the default |
| `#flypathfind` / `#flypathwalk` / `#flypathfindwalk` | The same, but taking the shortest route through the air |
| `#pathsafe on\|off` | On (default): if the agent isn't where it should be after a step, keep checking for up to 2s before calling it a failure. That costs nothing when steps succeed straight away. Off: check once |
| `#pathstop` | Stop a running walk after the current step |
| `#probe` / `#probe all` | Run every read-only agent command (getposition, and detect / detectredstone / inspect / inspectdata in all six directions, getitemcount / getitemdetail / getitemspace for slot 1, or all 27 slots with `all`) and list the data each one returns |
| `#cmdversion <value>` | Set the `body.version` sent with every command request: `1` (the default), a version string like `1.21.0`, or `off` to leave it out. Some commands may answer differently depending on it |
| `#raw <json>` | Send a hand-written WebSocket message exactly as given (a missing `header.requestId` is filled in). The reply is logged as an unmatched message |
| `#subscriptions` | List the current subscriptions, which are re-sent whenever Minecraft reconnects |
| `#ask <request>` | Give the LLM a request, as if typed in the Automatic tab |
| `#wonder off\|on\|always` | Switch wondering (see [Wondering](#wondering)) |
| `#world` / `#world <name>` | Show which world Ptolemy thinks it's in, or rename it |
| `#map` / `#map forget` | How much of this world the robot has mapped, or wipe its map. See [The map and Vision](#the-map-and-vision) |
| `#area list` / `#area add <name> x1 y1 z1 x2 y2 z2` / `#area remove <name>` | Named areas of this world (two opposite corners) |
| `#boundary <name> x1 x2 y1 y2 z1 z2` | The same as `#area add`, with the coordinates as ranges |
| `#help` | Show this list |

Subscribing isn't a Minecraft command (there's no `/subscribe`). It's a different kind of WebSocket
message, which is why it lives here. If the game rejects a subscription, the console says so. Any
message from the game that Ptolemy can't match to a command or event is logged too, so nothing
arrives unnoticed.

Click a response line to see the raw JSON the game sent back in the
dashboard's Selected response card.

### Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PTOLEMY_UI_PORT` | `3000` | Port for the WebUI (HTTP and its own WebSocket at `/ui`) |
| `PTOLEMY_MC_PORT` | `8080` | Port Minecraft connects to with `/connect` |
| `NVIDIA_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | | Used by those endpoints when no key is saved for them |
| `PTOLEMY_KEY_<ENDPOINT>` | | Where each endpoint's saved key lives, in `.env` (e.g. `PTOLEMY_KEY_NVIDIA`) |
| `PTOLEMY_MCP_URL` | `http://localhost:$PTOLEMY_UI_PORT/mcp` | Where `npm run mcp` relays to |

If those ports are already taken (for example by another Ptolemy), both move up together: the second
instance uses 3001 and 8081, the third 3002 and 8082, and so on. The console, and the connect hint in the
WebUI header, show which ones it got. Instances share the `data/` folder, so settings and world memory
changed in one can be overwritten by another. `npm run mcp` relays to port 3000 unless you set
`PTOLEMY_UI_PORT` or `PTOLEMY_MCP_URL`.

Ptolemy reads a `.env` file in the project folder at start-up (it's git-ignored). API keys typed into
Configuration → LLM are saved there.

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

## The map and Vision

Everything the robot sees goes into its **map** of the world, and stays there:

- **Storage:** Minecraft's own grid. The map is kept in sub-chunks of 16×16×16 blocks (8 KB each in
  memory), one gzipped file per chunk column in `data/worlds/<id>/map/`, read when something first
  needs it. Only recently used columns stay in memory. A column the robot has walked past takes about
  100 bytes on disk. `#map` says how much is mapped; `#map forget` wipes it.
- **Vision** is the robot's real-time look around: a small cube of blocks (the **Vision radius**,
  1 = 3×3×3) and where the entities within the **Vision radius for entities** (9) are. It happens after
  every step of a walk, after every tool call, and every couple of seconds while idle. Ptolemy
  checks where the robot is after every step anyway, and Vision rides along in the same flight of
  commands, so it costs no extra waiting: Bedrock answers the whole flight in about one round trip
  (up to about 100 commands). While walking, the cube sits `radius` cells ahead on the path, so the
  robot is on its inner edge and sees what it is about to walk into.
- **Entities** are identified once: working out *what* an entity is takes a few round trips (see
  [Seeing entities](#seeing-entities)), but each keeps its uniqueId, so Vision only asks where
  everything is, and a new id is identified in the background.
- **Awareness radius** (3): the part of the map around the robot it's aware of, as opposed to all it
  has mapped. The LLM gets it with every request: the `[Now]` block has an "Around you" summary of
  the map within that radius (what's next to the robot, the ground below, counts, where the less
  common blocks are), which Vision keeps fresh, so the model rarely needs to scan just to see where
  it is. It's one line while the map knows almost nothing there. 0 turns it off; a bigger radius
  means a longer prompt. The Nanny Cam's Awareness filter shows it.
- **The `scan` tool uses the map too:** up to radius 4 it looks at everything again (it may have
  changed); further out, only at what the map doesn't know yet, and describes the rest from the map.
  A second radius-8 scan of the same place costs 730 commands instead of 4,913.

The ranges are under Configuration → Robot & paths → Map and vision.

## Pathfinding

The agent flies like a 1×1×1 drone and can move through anything that isn't solid (air, water,
plants, torches...). A move into a solid block reports success, but the agent just shakes its head
and stays put. So the pathfinder plans over what the robot knows, and the walker checks every step.

- **Targets:** `x y z`, where each part can be `~` or `~n` relative to the agent, or `@p` for you.
  `@p` ends beside you at body height. A solid target means "go next to it".
- **Planning** is an A* search over position and facing. The robot turns to face where it's going
  (it looks better) and moves up and down without turning. A target sealed in by known solid blocks
  is refused straight away, and so is a robot boxed in by them (say, stuck inside a tree's leaves):
  the error says it has to break a block to get out.
- **What the robot knows** is its [map](#the-map-and-vision): every block it has seen in this world,
  by scans and by Vision, kept on disk. Keeping everything is what lets it walk around a big wall or
  hill: with only the latest scan, it forgot the part of the wall it had already seen and went back
  and forth along it.
- **Vision while walking:** after each step, Vision looks at the cells just ahead on the path in the
  same flight as the position check. If something solid is now where the path goes (someone built a
  wall, a door closed), the robot re-plans from the map before bumping into it.
- **Unseen cells are unknown**, neither air nor wall. Far from anything measured, the planner assumes
  it can walk through them: an unseen cell costs a ground step plus the "unseen" penalty, whatever its
  height, and the robot looks before going in. On a trip over the surface (see
  [Finding the way](#finding-the-way)), unseen cells near measured ground are guessed from it instead:
  below the ground they count as solid, above it they're priced like seen cells. Otherwise unseen cells
  priced as flat ground at any height were cheaper than the real, bumpy ground next to them, and the
  planner tunnelled through riverbanks and floated along just outside what it had measured.
- **`#pathfind` vs `#flypathfind`:** the fly version takes the shortest route through the air (every
  move costs 1). The plain version follows the path of least resistance for something that walks
  and climbs. Entering a cell costs by its best known support. Water counts as air: robots are heavy,
  so the robot walks along the bottom of rivers and lakes, and a lakebed step costs a ground step.
  Read the costs as "how many ground steps would it rather walk than go
  through this". Defaults are below; they're all adjustable in the Configuration tab. Turns cost 1.

  | Support | Solid block | Cost |
  | --- | --- | --- |
  | Ground | directly below | 1 |
  | Ground edge | below, sharing an edge | 3 |
  | Wall | beside, sharing a face | 5 |
  | Wall edge | level, sharing an edge | 8 |
  | Ground corner | below, sharing only a corner | 10 |
  | Ceiling | directly above | 15 |
  | Ceiling edge | above, sharing an edge | 20 |
  | Ceiling corner | above, sharing only a corner | 20 |
  | Airborne | nothing around | 40 |

  The search is A* with a small budget, then weighted A*: it trusts its distance estimate 2 times more
  (then 3, then 8 if the budget runs out again), so the route is at most that many times dearer than
  the best. Climbing and hugging walls cost more than the estimate assumes, so an exact search on a
  60-block trip takes 1-3 seconds; weight 2 found the same routes in 0.05-0.2 s. The plan says when
  it's such an estimate.
- **Walking:** every step has an expected pose (position and facing). After each step Ptolemy runs
  `agent getposition`, and the walk stops at the first mismatch. With `#pathsafe on` it polls for up
  to 2 seconds first, in case moves turn out not to be instant.
- **`#pathfindwalk`** looks first, plans, then walks; see [Finding the way](#finding-the-way). When a
  step fails (someone closed the door), it marks that cell as blocked, rescans and re-plans. That
  counts as a retry, and it hard-stops after `retries` failures.

### Finding the way

`#pathfindwalk` and `go_to` pick a method (`method=` on `#pathfindwalk`; `auto` by default):

- **`surface`** (the default when walking): first **measure the ground** between the robot and the
  target with `gettopsolidblock x y z`, which answers with the first block below y that isn't air,
  leaves or water, in one command per column: a strip 7 wide (Ground survey half-width: 3) all the way,
  a few hundred commands in one go. What it looked straight through is marked "clear" on the map:
  probably free, but it can't see leaves or water. An end with something solid over it is indoors or
  underground (the survey only saw the roof), so the unseen cells around it are scanned too. Then
  **plan, and check the path**: `testforblock` on exactly the cells the path goes through that nobody
  has actually seen (usually under a hundred, one flight). If any turned out to be in the way (leaves,
  a log), plan again and check the new cells; a clear path is walked as it is. Unloaded chunks
  (`gettopsolidblock` answers "No solid blocks under specified position") stay unknown.
- **`corridor`** (the default when flying, and what `surface` switches to when there's no way over
  the ground as measured, e.g. to a cave): first scan five tubes of radius 2 between the robot and
  the target: straight up or down from each to the other's height, the two level lines that close
  that rectangle, and the diagonal (a few thousand cells for 60 blocks, only the unseen ones). That
  covers the straight flight and the ways around it above and below, and works underground. Then it
  carries on as `lookahead`.
- **`lookahead`**: before moving, plan through the unknown optimistically,
  then scan the unseen cells around the spot where the plan first meets the unknown (a cube of radius
  3) and plan again. The spots alternate between the robot's end of the plan and the target's end, so
  both sides fill in until they meet; a target in the unknown gets looked around first. Then the
  path is checked like `surface` does (only the cells it goes through, when flying) and walked. In a
  winding cave tunnel it used 41k commands where rescanning used 218k.
- **`rescan`** (the old way): walk what's known, and at the edge of it
  rescan a cube around the robot (the rescan radius, 7 = 3,375 blocks) and re-plan. Rescans are
  budgeted at ⌈2 × distance ÷ scan radius⌉ + 3, so a robot trying to get into a closed box gives up.
  It is also what `surface` falls back to when checking the path doesn't settle.

Everything seen is kept, so running either again carries on from where it stopped. `npm run bench`
compares the methods on simulated trips.
- **Stored paths:** walking and flight paths are stored separately (`#pathwalk` walks the one from
  `#pathfind`, `#flypathwalk` the one from `#flypathfind`). A stored path is only valid while the
  agent is at its start. It's dropped as soon as the agent moves (by hand, by a walk of the other
  path, or as seen by a scan), and it's used up once walked.
- **Nanny Cam:** walking paths show as cyan beads and flight paths as magenta ones. They fade as the
  robot walks them, and a finished walk leaves a faded trail. The robot's marker follows it while it walks.

## Automatic mode (LLM)

The **Automatic** panel (bottom left of the Robot tab) is a chat with the robot. Type a request ("come to me", "dig a 3x3 hole in front
of you", "what's around you?") and the LLM works it out with the robot's tools, one call at a time:
it calls a tool, reads what actually happened, and decides what to do next, until it answers without
calling a tool. Every tool call shows up in the transcript (click one to see the full result) and in
the Manual console as `LLM → tool {...}`. **Stop** stops the model and the robot; **New conversation**
makes it forget everything said so far.

### What the model is sent

- **The system prompt stays the same from call to call.** It only changes when you change the settings
  or the tools. Servers that cache the start of a prompt (LM Studio, llama.cpp, Anthropic) can then
  skip re-reading it, which is where most of the time goes with long prompts.
- **A fresh `[Now]` block** is added to the newest message on every call. It says where the robot and
  the player are, what the map knows right around the robot ("Around you", the Awareness radius), the
  world's memory, and where the request came from. It's left out of older
  messages, so the model sees one current copy, not a pile of outdated ones.
- **Only the newest snapshot of each kind** (`scan`, `get_status`, `get_memory`, `todo_write`) is sent
  in full. Older ones are replaced by a one-line note. A scan's blocks and entities count separately, so
  looking for entities doesn't hide the last block scan.
- **One exception, for Anthropic:** within the request being worked on, the conversation is sent
  unchanged, older `[Now]` blocks included. Anthropic requires the history before its thinking blocks
  to stay exactly as it was, and its prompt caching makes the repeats cheap. Earlier requests are
  pruned as usual.

### Streaming

With **Stream replies** on (the default), the model's thinking and answer appear in the transcript as
they're written. The thinking stays open while it streams, then collapses. The timeout then counts
seconds of silence instead of the whole answer, so a slow but steady model isn't cut off. A server that
refuses streaming is switched to normal replies automatically.

### Positions: relative and world

Small models mix up coordinate systems easily, so the two never share names:

- **Relative positions are directions and block counts from the robot,** always in words: "2 forward,
  1 left, 1 down". The robot itself is "where you are". Tools take them as counts:
  `{forward: 2, left: 1, down: 1}`, `{down: 1}` for the block below.
- **World coordinates are Minecraft's fixed x, y, z,** always written `x=5 y=89 z=-3` and passed as
  `{x: 5, y: 89, z: -3}`. `x`, `y` and `z` never mean anything else, and `run_command` only understands
  these.
- **Tool results show both,** e.g. "2 forward, 1 left (x=12 y=64 z=9)". The **`locate`** tool translates
  one position either way, and says what block is there and which named area it's in.
- **After a move or turn,** results say where the robot is now, in world coordinates and facing, and
  that relative positions are measured from there.
- **The pathfinder's own messages** (which describe a finished trip) use world coordinates.
- **Named areas** are stored and listed in world coordinates, with where their middle is from the robot.
- **Coordinates the model sees** (Configuration → LLM) picks what results show: "Relative" shows both
  (the default), "World" shows world coordinates only. Tools accept either form in both modes.

Internally, relative positions are [left, up, forward], so facing south (y-rot 0) they're simply
world − robot. The other facings are that, rotated (`src/agent/frame.js`).

### Several players

- **Everyone online is found by name:** `list` gives who's online, and `querytarget @a[name="…"]` gives
  where each one is. `querytarget @s` only ever finds the player whose game is connected to Ptolemy.
- **Every request remembers who asked:** the chat sender, or the connected player for requests typed
  in the WebUI. While wondering, nobody asked.
- **The `[Now]` block and `get_status` list every player,** marking who asked and who's at the Ptolemy PC.
  "Me", "here" and "the player" mean whoever asked.
- **`go_to {target: "player"}` and `teleport_to_player` go to whoever asked.** Pass `player: "Bob"` (any
  case, or a unique start of the name) to go to someone else. An unknown name gets the list of who's
  online.
- **Teleporting to a player other than the agent's owner** uses their coordinates, since `agent tp`
  alone always goes to the owner.
- **The Dashboard lists every player's position.**
- **In the console:** `#pathfindwalk @p Bob` walks to Bob.

### Exact or near: where go_to stops

`go_to` has a `precision` option (the console takes `near` / `exact` after the target):

- **exact:** end on the target cell itself. For the player, that's the cell your feet are in. A
  reported eye height is corrected down to your feet.
- **near:** end anywhere around the target: beside it, diagonal to it, or 2 blocks away, and up to 1
  block higher or lower. It never stops straight above or below the target. Each possible stopping
  cell costs extra to end on:
  - beside the target: 10
  - diagonal: 15
  - 2 blocks away: 20
  - per block of height difference: 10
  - **plus the final spot multiplier (10) × the walking cost of standing there:** 10 on ground, 50
    clinging to a wall, 400 in midair with the default costs.

  So it would rather walk a few more blocks and stand on solid ground than stop beside the target in
  the air.
- **Defaults:** near for the player ("come here") and for named areas, exact for positions.
- **Settings:** all of these numbers are under Configuration → Robot & paths, per world.

### Flying and teleporting only when asked, and never confused

Flying and teleporting are different things with separate permissions:

- **Flying** is `go_to` with `fly`: the robot still travels block by block, through the air instead of
  along the ground. It's allowed only when the request says fly ("you can fly here").
- **Teleporting** is an instant jump: `teleport_to_player`, or `agent tp` through `run_command`. It's
  allowed only when the request says teleport or tp ("teleport to me").

Permission for one is never permission for the other: "you can fly" doesn't unlock teleporting. A
negated word doesn't count ("fly, not teleport" allows flying only), and neither does the past tense
("you teleported me!" is a complaint, not a request). Whatever isn't allowed isn't offered to the model
(no fly option, no teleport tool), and any attempt is refused. The `[Now]` block tells the model which
are allowed. Wondering never flies or teleports. MCP clients aren't restricted.

### Players are off limits

Ptolemy drives its robot; it is not a cheat tool. `run_command` always refuses commands that act on
players, whoever asks (the model or an MCP client) and whatever the settings: `tp`, `teleport`,
`spreadplayers`, `ride`, `kill`, `damage`, `effect`, `gamemode`, `ability`, `clear`, `give`,
`replaceitem`, `xp`, `enchant`, `spawnpoint`, `clearspawnpoint`, `camera` and `inputpermission`,
including after `run` in an `execute` chain. Commands run as the connected player, so `tp @s` would move
*you*, not the robot. The robot's own commands (`agent tp` and the rest) are unaffected.

### Endpoints

**Configuration → LLM** has a card for each endpoint: LM Studio, text-generation-webui (oobabooga),
NVIDIA Build, OpenAI and Anthropic to begin with. You can add more with **Add endpoint**, for example
for Ollama, llama.cpp, vLLM, or a second LM Studio on another PC. The one marked **In use** drives
Automatic mode.

| Endpoint | Setup | Defaults |
| --- | --- | --- |
| **LM Studio** | Load a model and start the server (Developer tab, or `lms server start`). Models with the 🔨 tool-use badge work best | `http://localhost:1234/v1`, model empty = the first one listed, tools: Auto |
| **text-generation-webui** | Start it with `--api` and load a model in its UI | `http://localhost:5000/v1`, model empty = whatever is loaded, tools: Text |
| **NVIDIA Build** | An `nvapi-...` key from [build.nvidia.com](https://build.nvidia.com) | `https://integrate.api.nvidia.com/v1`, `meta/llama-3.3-70b-instruct`, tools: Auto |
| **OpenAI** | A key from platform.openai.com; press ↻ and pick a model | `https://api.openai.com/v1`, tools: Native |
| **Anthropic** | A key from platform.claude.com. Uses Anthropic's own Messages API | `https://api.anthropic.com/v1`, `claude-opus-5`, tools: Native |

Each card has:

- **API key**, shown as dots and optional, since local servers usually don't need one. It's saved in
  the git-ignored `.env` file, never in `data/`, and never sent back to the browser. **Clear** removes it.
- **Model**, with a **↻** button that fetches the server's list into the dropdown. It's optional:
  empty means the first model the server lists (or, for text-generation-webui, whatever is loaded).
  **Other…** takes any name.
- **Tool calling**:
  - **Native** sends the tools in the API's `tools` parameter.
  - **Text** describes them in the prompt and reads `<tool_call>{...}</tool_call>` blocks from the reply,
    which works with any model.
  - **Auto** tries native and switches to text if the server rejects `tools`.
- **Three tests**, each with a dot that stays grey until tested, then green or red for the rest of the
  session. A dot goes back to grey when the endpoint's URL, key or model changes. Hover a dot for details.
  - **Test endpoint**: can Ptolemy reach the server, and is the key accepted?
  - **Test model**: sends a short message asking for a tiny JSON reply, and checks it.
  - **Test tools**: asks the model to call a tool. Green means native tool calls work. Red says why:
    the model wrote the call as plain text (use Text mode), ignored the tool, or the server refused it.

The other LLM settings:
- Stream replies, and the coordinates the model sees (see above).
- Temperature. It's dropped automatically for models that refuse it.
- Max tokens per reply. Keep it generous for reasoning models, whose `<think>` output shows collapsed
  as *Thinking*. Anthropic models always get at least 16,000.
- Max model calls per request, a guard against runaways.
- The timeout.
- The conversation budget. Older requests are dropped, and their tool results shortened, to stay
  under it. It's about 4 characters per token.
- The maximum length of one tool result.
- **Extra instructions** for every world. The prompt itself is in `src/llm/prompts.js`.

### Wondering

The **Wondering** switch above the conversation makes the robot act on its own when it's idle. After
`wonder.interval` seconds (15 by default) without anything happening, the LLM gets the wondering prompt:
act natural. Depending on its mood, it might follow up a thought or a todo, wander around a named area,
have a new thought, or do nothing at all. "Anything happening" means a model reply, a tool call, a
console command, or flipping the switch. The countdown starts from the last of those, so it isn't a
rolling timer.

| Mode | Behaviour |
| --- | --- |
| **Off** | Never |
| **On** | Wonders until someone asks for something (WebUI or chat), then switches itself off |
| **Always on** | Pauses while a request runs, then counts down again |

A request always interrupts a wander in progress. Wondering waits while Minecraft is disconnected or
the world has no agent. The interval, the step limit per wander (6) and the prompt itself are in the
**Chat & wondering** card on the Robot tab. The robot can also switch wondering itself when asked in
chat ("go do your own thing", "stop wandering around").

### The tools

The LLM and MCP clients use the same tools (`src/tools/index.js`). Most bundle several commands and
report what really happened, because the game says "success" even when the robot bumped into a wall.

| Tool | What it does |
| --- | --- |
| `get_status` | Robot position and facing, which compass direction each relative direction is, the six blocks around it, the player's position and distance |
| `scan` | `what: "blocks"`: look at a cube around the robot (fresh up to radius 4, then only what the map doesn't know; see [The map and Vision](#the-map-and-vision)) and summarize it: neighbours, the ground below, counts per block type, where the rarer blocks are, and ground height around. `what: "entities"`: mobs, animals, players and dropped items around the robot (default 16 blocks, up to 48), nearest first: name, position, distance, and which are hostile. `what: "both"` (the default): the two. See [Seeing entities](#seeing-entities) |
| `get_blocks` | The block at up to 64 positions, relative or world |
| `move` | Move 1–64 blocks forward/back/left/right/up/down, checking every step; reports what blocked it and which `destroy` direction would clear it |
| `turn` | Turn left, right or around, or face north/south/east/west |
| `go_to` | Pathfinding (`#pathfindwalk`) to coordinates, to the player or to a named area, optionally flying. Meant for longer trips: it refuses to walk to a solid block a few blocks away and points to `destroy`/`place` instead |
| `teleport_to_player` | `agent tp`, only when the request asks for a teleport (asking to fly isn't enough) |
| `destroy`, `place`, `attack` | Act on the cell beside the robot, in one of six directions (forward, back, left, right, up, down). The robot never moves into it. Given a block's position instead (relative or world), they first walk the robot beside it. The cell is checked before and after. `place` takes an inventory slot |
| `locate` | One position, given relative or world, in both forms, plus the block there and its area |
| `collect`, `drop` | Pick up items nearby, or drop items from a slot |
| `send_chat` | A message in the game chat from the robot (`<Ptolemy> ...`, via `tellraw`), whoever asked |
| `send_webui` | A highlighted message in the Automatic tab, whoever asked |
| `get_memory` | This world's memory (the LLM also gets it in its prompt) |
| `add_area`, `remove_area` | Name a box ("house", "kitchen"), or forget one |
| `todo_write` | Replace the todo list, with each item pending / in progress / done |
| `add_thought`, `drop_thought` | What's on the robot's mind |
| `remember`, `forget` | Long-term memory: save an entry, update one (`replace` with its number or text), or drop one |
| `set_name` | Rename itself: the chat wake word and the name its messages are signed with (optionally the ignore word too) |
| `set_wondering` | Switch wondering off / on / always, optionally with the idle seconds |
| `set_world_instructions` | Add a standing rule for this world, or replace them all |
| `wait` | Wait up to 60 seconds |
| `run_command` | A Minecraft command, with the game's raw reply: the escape hatch for everything else. Never one that acts on players |

`run_command` and `destroy`/`attack` can be turned off under **Tools and MCP**.

### Seeing entities

Blocks stay put, so a scan remembers them. Mobs don't, and no single Bedrock command says both what an entity
is and where it is. A scan for entities (`scan` with `what: "entities"` or `"both"`, `#scan`, the Nanny Cam's Scan
button) sends a few commands at once, centred on the agent, and matches their answers by each entity's `uniqueId`:

| Command | What it tells |
| --- | --- |
| `querytarget @e[x=..,y=..,z=..,r=..,c=65]` | Where every entity is (up to the 64 nearest, plus the robot), but not what it is |
| `testfor` with the same selector | The names of what's there (`Cow`, `Zombie`, `Alex`), but not where |
| `querytarget @e[...,name=<name>]` for each name | Which entities carry that name: players and name-tagged mobs |
| `querytarget @e[...,type=<name as an id>]` for each name | Which are that type (`Zombie Villager` → `zombie_villager`) |
| `querytarget @e[...,family=monster]`, `type=item`, `type=player` | Which are hostile, dropped items or players |

The robot itself (whatever stands in its own cell) and experience orbs are left out afterwards. They can't be
excluded in the selector: `agent` is a command keyword, so `type=!agent` is a syntax error. For the same reason,
names are always quoted in `name="..."`.

Anything the game won't name ends up as "Unidentified entity" (a game language other than English can cause
that, since the type is guessed from the English name). Positions are a snapshot, so to attack a mob the LLM
looks, attacks the position (the robot walks beside it first), and looks again.

### From the in-game chat

A chat message that mentions **Ptolemy** (anywhere, any case) is a request: `Ptolemy, come here`,
`can ptolemy build a tower?`. A message that contains **Ptoless** is never a request, even if it also
says Ptolemy, so you can talk about the robot without calling it. `Ptolemy, stop` stops it. Requests
that arrive while it's busy wait their turn. The robot's own chat lines never trigger it. Both words,
and whether it listens and answers at all, are in the **Chat & wondering** card on the Robot tab.

**It can be renamed from the chat:** "Ptolemy, your name is now Boris" makes it call `set_name`. From
then on "Boris" calls it, and its chat messages are signed `<Boris>`. The ignore word can be changed
the same way.

The WebUI is the admin panel, but players don't need it. From the game chat they can:
- rename the robot
- switch wondering
- give it standing rules for the world
- have it remember things

## World Memory

Ptolemy keeps a separate memory for every Minecraft world, in `data/worlds/<id>/`.

**Which world is this?** Bedrock doesn't tell connected programs which world is open, so the first time
Ptolemy sees a world it marks it with a dummy scoreboard objective called `ptolemy_<id>`. The marker is
saved with the world, and Ptolemy reads it back every time the game connects. A new world starts with
empty memory and a copy of the per-world settings.
- **The Dashboard names worlds.** A new world gets a placeholder name; rename it there or with
  `#world <name>`.
- **"This is it"** fixes a mix-up. If a world was detected wrongly, for example a copy of a world
  or a world that lost its scoreboard, the Dashboard's other-worlds list can switch to the right
  memory. It also re-marks the game world to match.
- **Without cheats, worlds can't be marked.** Ptolemy then uses a shared "Unmarked world" memory,
  and says so.
- **A world without an agent** gets a **Create the agent** button on the Dashboard.

What it remembers:

| Memory | What it's for | Who writes it |
| --- | --- | --- |
| **Areas** | Named boxes: "house", "kitchen", "farm". An area inside another is part of it ("kitchen in house"). The robot's and player's areas are shown everywhere, `go_to` can target an area, and the Nanny Cam outlines them | The LLM (`add_area`), the Dashboard, `#area` / `#boundary` |
| **Todo list** | The robot's plan for multi-step work, like a coding agent's todo list: pending, in progress, done | The LLM (`todo_write`), the Dashboard |
| **On its mind** | A few passing thoughts ("I want to see flowers") it may act on later, especially while wondering. Only the latest 10 are kept | The LLM (`add_thought`), the Dashboard |
| **Long-term memory** | Numbered entries to keep for good: facts, preferences, promises ("Arzindel likes birch"). The LLM saves them when asked to remember something or when it learns something worth keeping, and can update or drop them | The LLM (`remember`, `forget`), the Dashboard |
| **Recent activity** | What it was asked lately and how it went | Automatic |
| **Instructions for this world** | Standing rules added to the prompt in this world only | The Dashboard, the LLM (`set_world_instructions`) |

The LLM sees all of it in its system prompt, and MCP clients can read it with `get_memory`.

## The Robot tab

The WebUI has three tabs: **Robot**, **Commands** and **Configuration**. The Robot tab puts everything on one screen:

- **Top half: the dashboard.** It fills the space exactly, so it doesn't scroll:
  - All cards share one height, the dashboard's height split evenly over the rows.
  - It uses as many columns (at least 220px wide) as it takes to fit the rows without making cards
    shorter than 160px.
  - Longer contents scroll inside their card.
  - Only in a small window, or zoomed in a lot, do cards stop at that minimum and the dashboard
    scrolls.
  - The world: its name (click to rename), how it was recognised, other known worlds, and the agent.
  - Right now: where the robot and the player are and in which areas, what the robot is doing, the
    wondering countdown, and the active LLM endpoint with its test dots.
  - Connection details.
  - Chat & wondering settings: wake word, ignore word, chat replies, and the wondering interval,
    step limit and prompt.
  - The robot's memory: the todo list (click a mark to go pending → in progress → done), what's on
    its mind, areas (add them by coordinates, or as a box around you or the robot), notes, recent
    activity, and this world's instructions.
  - The selected console response.
- **Bottom half: Automatic, the Manual console and the Nanny Cam,** side by side.

On narrow windows everything stacks and the page scrolls.

## The Commands tab

A reference of everything that can be run, with every description editable. The edits change what's
used:

- **LLM tools:** the robot's tools with their parameters. The description is exactly what the model
  (and MCP clients) read when deciding whether and how to use a tool, so editing it changes the robot's
  behaviour. For example, "Pathfinding for long trips only. Prefer move for anything within 3 blocks."
- **# console commands:** Ptolemy's own commands, with usage. The description is what `#help` prints.
- **/ Minecraft commands:** game commands the robot works with. Ticking **In LLM prompt** lists that
  command, with its description, in the system prompt as something the model may run through
  `run_command`. By default that's `agent dropall`, `agent till`, `agent transfer` and `agent create`,
  which have no dedicated tool.

Edited entries are marked, **Default** puts one back, and **Reset all edits** puts back everything.
Edits are saved in `data/commands.json`. There's a filter box at the top.

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

The **Configuration** tab has three sub-tabs. The chat and wondering settings, which change more
often, are in the **Chat & wondering** card on the Robot tab instead.

- **LLM**: the endpoints, and how the model is used (temperature, token and step limits, the
  conversation budget, extra instructions for every world).
- **Robot & paths**: walking path costs, scanning and path planning. These are marked **this world**:
  each world keeps its own copy. A world seen for the first time starts from the defaults for new
  worlds, and **Use these as defaults for new worlds** makes the current world's values the new defaults.
- **System**: tool permissions, the MCP server, and the in-flight limit.

Changes apply immediately, show up in every open tab, and survive restarts: global values are in
`data/settings.json`, a world's own values in `data/worlds/<id>/settings.json`, endpoints in
`data/endpoints.json` and API keys in `.env` (all git-ignored). `#pathsafe` and `#inflight` change the
same settings. Values that differ from their defaults are outlined, and **Reset to defaults** puts
everything back (endpoints and keys stay).

## Nanny Cam

The **Nanny Cam** panel (bottom right of the Robot tab) draws the robot's [map](#the-map-and-vision)
around it, up to 30 blocks away, in 3D with WebGL2, using the GPU and no libraries. Vision keeps it live:
new blocks and entities appear as the robot looks around.

- **Map / Awareness / Vision** pick what's highlighted. All three draw the whole map; Awareness and
  Vision colour only what's inside the Awareness radius or the cube Vision looked at last (which runs
  ahead of the robot while it walks), and draw the rest in grey.
- **Scan** runs a scan of the chosen radius, same as `#scan`: blocks, entities, or both (the picker next to it).
  Scanned blocks go onto the map; every look for entities replaces the entities shown.
- **Drag** to orbit around the robot, **scroll** to move the camera closer or further, and
  **double-click** to reset.
- **Zoom** limits the view to the blocks within that many blocks of the robot (up to 30), which helps
  indoors or underground. Cut faces are drawn, so you can see inside walls.
- **Hover** over a block to see its name and coordinates.
- Named areas from World Memory are outlined with dotted lines, one colour each.
- The robot is the yellow block. Its darker nose points the way it's facing.
- Entities, where they were at the last look (Vision looks every couple of seconds): hostile mobs are
  red boxes, other mobs white, players blue two-block columns, dropped items small purple boxes, and
  anything unidentified grey. Hover over one to see what it is.

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
  env.js                 reads and writes the git-ignored .env file (API keys)
  web/server.js          static file server, WebUI socket, console commands
  web/brain.js           wires worlds, endpoints, the pilot, wondering, chat requests and MCP together
  settings.js            Configuration schema (sub-tabs, per-world fields), saved to data/
  commands.js            the Commands tab: tool, # and / command descriptions, and edits to them
  agent/                 scanning, Vision, pose, pathfinding, walking (Navigator), entities,
                         and frame.js: the robot-relative coordinates the model sees
  world/map.js           the map: every block seen, in 16x16x16 sub-chunks, saved per world
  world/manager.js       which world is open (the scoreboard marker), per-world folders
  world/memory.js        World Memory: areas, todos, thoughts, notes, journal, conversation
  tools/index.js         the robot's tools, shared by the LLM and MCP
  llm/endpoints.js       endpoint presets and store (data/endpoints.json, keys in .env)
  llm/client.js          chat client for OpenAI-compatible servers and Anthropic, with streaming (built-in fetch)
  llm/tests.js           the Test endpoint / model / tools buttons
  llm/prompts.js         system prompt, text-mode tool calls
  llm/pilot.js           the Automatic mode loop and conversation
  llm/wonder.js          wondering: the idle timer
  mcp/server.js          MCP over HTTP at /mcp
  mcp/stdio.js           MCP over stdio, relaying to /mcp (npm run mcp)
public/
  index.html, style.css, app.js   the WebUI
  dashboard.js, automatic.js, nannycam.js, config.js, endpoints.js, commands.js   the tabs and panels
  blocks.js              block colours / solidity
bench/
  sim.js                 a simulated world and a fake game answering Ptolemy's commands
  pathfinding.js         the pathfinding benchmark (npm run bench)
  fake-game.js           try the WebUI without Minecraft (npm run fake-game, after npm start)
abandoned-minimap-project/        old prototype, kept for reference only
```

## Safety notes

- `/connect` gives Ptolemy the same command permissions as your player. Only run it on worlds you
  don't mind a robot (or an LLM) messing with.
- The Minecraft port accepts any client on your network. Don't expose it to the internet. The same
  goes for the WebUI port, which also carries the MCP endpoint: anyone who can reach it can drive the
  robot and run commands (browsers on other sites are refused, other programs aren't).
- API keys are saved in plain text in `.env` (git-ignored) and never sent back to the browser. Set
  `NVIDIA_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in your environment instead if you'd rather
  not store them.
- To recognise worlds, Ptolemy adds a dummy scoreboard objective called `ptolemy_<id>` to each world.
  It doesn't show anywhere unless you display it. `/scoreboard objectives remove ptolemy_<id>` removes it
  (Ptolemy then treats the world as new).
- With wondering on, the LLM acts on its own every so often: with a paid endpoint, that costs tokens
  even while you're not looking.
- The LLM can run commands through `run_command` unless you turn it off in the Configuration tab.
  Commands that act on players are always refused (see "Players are off limits").
- The agent cannot be killed or removed. You have been warned. You were warned before that, too.
