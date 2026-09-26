# MineCA Architecture

Visual overview of how all components work together.

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         MINECRAFT BEDROCK                          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Behavior Pack                          │   │
│  │                                                            │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │  Functions  │  │   Scripts    │  │   Events     │   │   │
│  │  │             │  │              │  │              │   │   │
│  │  │ terrain_    │  │ main.js      │  │ ChatSend     │   │   │
│  │  │ 7x7.mc      │  │ - Inventory  │  │ ItemUse      │   │   │
│  │  │ ...         │  │ - HTTP POST  │  │              │   │   │
│  │  │ 101x101.mc  │  │ - Scanner    │  │              │   │   │
│  │  └─────────────┘  └──────────────┘  └──────────────┘   │   │
│  │         │                 │                              │   │
│  └─────────┼─────────────────┼──────────────────────────────┘   │
│            │                 │                                   │
│            │ Commands        │ HTTP POST                         │
│            ▼                 ▼                                   │
│  ┌─────────────────────────────────────┐                       │
│  │     WebSocket Server (Port 19132)   │                       │
│  └─────────────────────────────────────┘                       │
└────────────────────────────────────────────────────────────────────┘
                             │
                             │ WebSocket
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                      NODE.JS BRIDGE SERVER                         │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    server.js                              │   │
│  │                                                            │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │  WebSocket  │  │     HTTP     │  │   Parser     │   │   │
│  │  │   Client    │  │   Server     │  │              │   │   │
│  │  │             │  │              │  │ Command      │   │   │
│  │  │ Connect to  │  │ Port 3000    │  │ Response     │   │   │
│  │  │ Minecraft   │  │ Serve UI     │  │ Parser       │   │   │
│  │  │             │  │ /update      │  │              │   │   │
│  │  └─────────────┘  └──────────────┘  └──────────────┘   │   │
│  │         │                 │                  │           │   │
│  └─────────┼─────────────────┼──────────────────┼───────────┘   │
│            │                 │                  │               │
└────────────┼─────────────────┼──────────────────┼───────────────┘
             │                 │                  │
             │ WebSocket       │ HTTP             │ Broadcast
             ▼                 ▼                  │
┌────────────────────────────────────────────────┼───────────────────┐
│                        WEB BROWSER             │                   │
│                                                │                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                     Web UI (Port 3000)                    │   │
│  │                                                            │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │   Map Tab   │  │   Inv Tab    │  │   Chat Tab   │   │   │
│  │  │             │  │              │  │              │   │   │
│  │  │ Canvas      │  │ Grid Display │  │ Messages     │   │   │
│  │  │ Zoom +/-    │  │ 36 Slots     │  │ Input        │   │   │
│  │  │ Minimap     │  │ Hotbar       │  │ Send         │   │   │
│  │  └─────────────┘  └──────────────┘  └──────────────┘   │   │
│  │                                                            │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │              app.js (WebSocket Client)              │ │   │
│  │  │  - Receive terrain data                             │ │   │
│  │  │  - Receive inventory updates                        │ │   │
│  │  │  - Receive chat messages                            │ │   │
│  │  │  - Send chat messages                               │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagrams

### 1. Terrain Scanning Flow

```
Player moves in game
        │
        ▼
Behavior Pack Timer triggers (every 2s)
        │
        ├──> Run terrain scan function
        │    (e.g., /function scan/terrain_21x21)
        │
        ▼
Minecraft executes 441 gettopsolidblock commands
        │
        ▼
Command responses sent via WebSocket
        │
        ▼
Server receives and parses responses
        │    "The top solid block at 100, 64, 200 is minecraft:grass"
        │
        ▼
Server caches terrain data
        │    terrainCache.set("100,200", "grass")
        │
        ▼
Server broadcasts to all web clients
        │    { type: "terrain", blocks: [{x:100,y:64,z:200,type:"grass"}] }
        │
        ▼
Web UI receives terrain update
        │
        ▼
Update terrainData Map
        │
        ▼
Redraw minimap canvas with new blocks
```

---

### 2. Inventory Scanning Flow

```
Behavior Pack Script runs (every 2s)
        │
        ▼
scanInventory(player) called
        │
        ├──> Get EntityInventoryComponent
        │
        ├──> Loop through 36 slots
        │    │
        │    ├──> container.getItem(0) → Hotbar slot 0
        │    ├──> container.getItem(1) → Hotbar slot 1
        │    │    ...
        │    ├──> container.getItem(8) → Hotbar slot 8
        │    ├──> container.getItem(9) → Main inv slot 0
        │    │    ...
        │    └──> container.getItem(35) → Main inv slot 26
        │
        ▼
Collect item data for each slot
        │    { slot: 0, type: "diamond_sword", amount: 1 }
        │
        ▼
HTTP POST to server /update endpoint
        │    
        │    POST http://localhost:3000/update
        │    {
        │      name: "Steve",
        │      location: {x: 100, y: 64, z: 200},
        │      inventory: [...]
        │    }
        │
        ▼
Server receives HTTP POST
        │
        ▼
Update cached player data
        │
        ▼
Broadcast to web clients via WebSocket
        │
        ▼
Web UI receives inventory update
        │
        ▼
updateInventory() renders grid
        │
        ├──> Clear all slots
        ├──> For each item:
        │    └──> Set color, amount, tooltip
        └──> Display in correct slot
```

---

### 3. Chat Message Flow

#### Sending (Web UI → Minecraft):

```
User types message in Chat tab
        │
        ▼
Clicks "Send" or presses Enter
        │
        ▼
app.js sends WebSocket message
        │    { type: "chat", message: "Hello!" }
        │
        ▼
Server receives chat message
        │
        ▼
Construct tellraw command
        │    tellraw @a {"rawtext":[{"text":"<Steve> Hello!"}]}
        │
        ▼
Send command to Minecraft WebSocket
        │
        ▼
Minecraft displays message in-game
        │    <Steve> Hello!
        │
        ▼
Game chat event triggers
        │
        ▼
Server receives PlayerMessage event
        │
        ▼
Broadcast back to web clients
        │
        ▼
Message appears in Chat tab
```

#### Receiving (Minecraft → Web UI):

```
Player sends chat message in-game
        │    "Hello from game!"
        │
        ▼
ChatSend event fires
        │
        ▼
Behavior Pack captures event
        │
        ▼
Forward to server via HTTP POST
        │
        ▼
Server broadcasts to web clients
        │    { type: "chat", sender: "Steve", message: "Hello from game!" }
        │
        ▼
Web UI receives message
        │
        ▼
addChatMessage() displays in Chat tab
```

---

## Component Interactions

### Startup Sequence

```
1. User starts Minecraft
        │
        ▼
2. User runs: /wsserver 19132
        │
        ▼
3. WebSocket server starts on port 19132
        │
        ▼
4. User activates behavior pack in world
        │
        ▼
5. Behavior pack scripts initialize
        │
        ▼
6. User runs: npm start (in server folder)
        │
        ▼
7. Node.js server starts
        │    ├──> HTTP server on port 3000
        │    └──> WebSocket client connects to :19132
        │
        ▼
8. Server subscribes to Minecraft events
        │
        ▼
9. User opens: http://localhost:3000
        │
        ▼
10. Web UI loads
        │    ├──> Connect to server WebSocket
        │    ├──> Initialize canvas
        │    └──> Request initial data
        │
        ▼
11. System running! All components communicating
```

---

## File Responsibilities

### Behavior Pack Files

**manifest.json**
- Defines pack metadata
- Declares dependencies (@minecraft/server, @minecraft/server-net)
- Sets minimum engine version
- Registers script module

**functions/scan/terrain_*.mcfunction**
- Contains gettopsolidblock commands
- Each file for different zoom level
- Commands execute in single tick
- No leading slash on commands

**scripts/main.js**
- Scans player inventory
- Sends HTTP POST to server
- Monitors chat events
- Runs on configurable interval

---

### Server Files

**server.js**
- WebSocket client (connects to Minecraft)
- WebSocket server (for web clients)
- HTTP server (serves web UI + /update endpoint)
- Message parser (command responses)
- Broadcast manager (send to all clients)
- Request ID generator

**package.json**
- Dependencies: ws, express
- Start script
- Dev script with nodemon

---

### Web UI Files

**index.html**
- Tab navigation structure
- Map canvas element
- Inventory grid containers
- Chat message display
- Input controls

**style.css**
- Responsive layout
- Tab styling
- Minimap canvas styling
- Inventory grid
- Chat message bubbles
- Dark theme

**app.js**
- WebSocket client connection
- State management (player, terrain, inventory)
- Canvas drawing logic
- Tab switching
- Zoom controls
- Inventory rendering
- Chat handling

**blockColors.js**
- Block type → color mapping
- 150+ block definitions
- Fallback colors for unknown blocks
- Item color helper functions

---

## Network Protocol

### WebSocket Messages (Minecraft ↔ Server)

**Subscribe to Event:**
```json
{
  "header": {
    "requestId": "req_1",
    "messagePurpose": "subscribe",
    "version": 1
  },
  "body": {
    "eventName": "PlayerMessage"
  }
}
```

**Command Request:**
```json
{
  "header": {
    "requestId": "req_2",
    "messagePurpose": "commandRequest",
    "version": 1
  },
  "body": {
    "commandLine": "querytarget @s"
  }
}
```

**Command Response:**
```json
{
  "header": {
    "requestId": "req_2",
    "messagePurpose": "commandResponse",
    "version": 1
  },
  "body": {
    "statusCode": 0,
    "statusMessage": "Steve is at 100.5, 64.0, 200.3"
  }
}
```

---

### HTTP Messages (Behavior Pack → Server)

**Player Data Update:**
```json
POST /update
{
  "name": "Steve",
  "location": { "x": 100.5, "y": 64.0, "z": 200.3 },
  "rotation": { "x": 0, "y": 90 },
  "inventory": [
    { "slot": 0, "type": "diamond_sword", "amount": 1, "name": null },
    { "slot": 1, "type": "cooked_beef", "amount": 32, "name": null },
    null,
    ...
  ]
}
```

---

### WebSocket Messages (Server ↔ Web UI)

**Player Data:**
```json
{
  "type": "playerData",
  "name": "Steve",
  "location": { "x": 100.5, "y": 64.0, "z": 200.3 },
  "rotation": { "x": 0, "y": 90 },
  "inventory": [...]
}
```

**Terrain Update:**
```json
{
  "type": "terrain",
  "blocks": [
    { "x": 100, "y": 64, "z": 200, "type": "grass" },
    { "x": 101, "y": 63, "z": 200, "type": "dirt" }
  ]
}
```

**Chat Message:**
```json
{
  "type": "chat",
  "sender": "Steve",
  "message": "Hello!"
}
```

---

## State Management

### Server State

```javascript
// Connected clients
webClients: Set<WebSocket>

// Minecraft connection
minecraftWs: WebSocket

// Player data
playerName: string
lastPlayerLocation: { x, y, z }

// Cached terrain
terrainCache: Map<"x,z", blockType>

// Request tracking
requestId: number
```

### Web UI State

```javascript
// WebSocket connection
ws: WebSocket

// Current tab
currentTab: 'map' | 'inv' | 'chat'

// Player data
playerData: {
  name: string,
  location: { x, y, z },
  rotation: { x, y },
  inventory: Array<Item | null>
}

// Terrain data
terrainData: Map<"x,z", blockType>

// Chat history
chatMessages: Array<Message>

// Zoom level
currentZoomIndex: number
currentZoomLevel: 7 | 11 | 15 | 21 | 31 | 41 | 51 | 71 | 101
```

---

## Performance Characteristics

### Memory Usage

**Behavior Pack**: ~5-10 MB
- Scripts in memory
- Event listeners
- Small state storage

**Server**: ~50-100 MB
- Node.js runtime
- WebSocket connections
- Terrain cache (grows with exploration)

**Web UI**: ~20-50 MB
- Browser rendering
- Canvas memory
- Terrain data map
- Chat history

### CPU Usage

**Behavior Pack**: Low (1-3%)
- Runs every 2 seconds
- Quick inventory scan
- HTTP POST

**Server**: Low (1-5%)
- Message parsing
- JSON serialization
- Broadcasting

**Web UI**: Low-Medium (2-10%)
- Canvas redraws
- DOM updates
- WebSocket handling

### Network Bandwidth

**Idle**: ~0.5 KB/s
**Active**: ~5-20 KB/s
**Heavy Scan**: ~50-200 KB/s (101x101 terrain)

---

## Error Handling

### Behavior Pack
- Silently fails if HTTP endpoint unavailable
- Continues running even if server disconnects
- Logs errors to content log

### Server
- Auto-reconnect to Minecraft (5s delay)
- Graceful WebSocket disconnections
- Error logging to console
- HTTP 200 responses even on partial failures

### Web UI
- Auto-reconnect to server (3s delay)
- Fallback colors for unknown blocks
- Empty state handling
- Connection status indicator

---

This architecture enables real-time, bidirectional communication between Minecraft and a web interface with minimal latency and good performance characteristics.
