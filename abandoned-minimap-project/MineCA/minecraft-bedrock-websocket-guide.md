# Minecraft Bedrock WebSocket Guide
## Using /function for Minimap Terrain Scanning & Inventory Detection

---

## Table of Contents
1. [Overview](#overview)
2. [Part 1: Using /function for Batch Terrain Scanning](#part-1-using-function-for-batch-terrain-scanning)
3. [Part 2: Inventory Scanning Methods](#part-2-inventory-scanning-methods)
4. [Implementation Examples](#implementation-examples)
5. [Performance Considerations](#performance-considerations)

---

## Overview

This guide covers two key topics for building a real-time minimap UI with inventory display for Minecraft Bedrock Edition:

1. **Terrain Scanning**: Using `/function` to batch multiple `querytarget` and `gettopsolidblock` commands
2. **Inventory Detection**: Methods to scan player inventory slots and hotbar

---

## Part 1: Using /function for Batch Terrain Scanning

### What is /function?

The `/function` command in Minecraft Bedrock Edition allows you to execute `.mcfunction` files, which can contain up to **10,000 commands** that all execute in a **single server tick** (~50ms).

This is perfect for your minimap needs: instead of sending hundreds of separate WebSocket requests for terrain scanning, you can batch them into one function call.

---

### Step 1: Create a Behavior Pack Structure

To use functions, you need a behavior pack with this structure:

```
minimap_bp/
├── manifest.json
└── functions/
    └── scan/
        ├── terrain_scan.mcfunction
        └── player_location.mcfunction
```

---

### Step 2: Create manifest.json

```json
{
    "format_version": 2,
    "header": {
        "name": "Minimap Scanner",
        "description": "Batch terrain scanning for minimap",
        "uuid": "12345678-1234-1234-1234-123456789abc",
        "version": [1, 0, 0],
        "min_engine_version": [1, 19, 50]
    },
    "modules": [{
        "type": "data",
        "uuid": "87654321-4321-4321-4321-cba987654321",
        "version": [1, 0, 0]
    }]
}
```

**Important**: Replace the UUIDs with unique ones. Generate them at [uuidgenerator.net](https://www.uuidgenerator.net/)

---

### Step 3: Create Terrain Scanning Function

**File**: `functions/scan/terrain_scan.mcfunction`

```mcfunction
# Scan 11x11 grid around player (121 blocks total)
# Center at player position
gettopsolidblock ~ 200 ~

# Row -5 (behind player)
gettopsolidblock ~-5 200 ~-5
gettopsolidblock ~-4 200 ~-5
gettopsolidblock ~-3 200 ~-5
gettopsolidblock ~-2 200 ~-5
gettopsolidblock ~-1 200 ~-5
gettopsolidblock ~0 200 ~-5
gettopsolidblock ~1 200 ~-5
gettopsolidblock ~2 200 ~-5
gettopsolidblock ~3 200 ~-5
gettopsolidblock ~4 200 ~-5
gettopsolidblock ~5 200 ~-5

# Row -4
gettopsolidblock ~-5 200 ~-4
gettopsolidblock ~-4 200 ~-4
gettopsolidblock ~-3 200 ~-4
gettopsolidblock ~-2 200 ~-4
gettopsolidblock ~-1 200 ~-4
gettopsolidblock ~0 200 ~-4
gettopsolidblock ~1 200 ~-4
gettopsolidblock ~2 200 ~-4
gettopsolidblock ~3 200 ~-4
gettopsolidblock ~4 200 ~-4
gettopsolidblock ~5 200 ~-4

# Row -3
gettopsolidblock ~-5 200 ~-3
gettopsolidblock ~-4 200 ~-3
gettopsolidblock ~-3 200 ~-3
gettopsolidblock ~-2 200 ~-3
gettopsolidblock ~-1 200 ~-3
gettopsolidblock ~0 200 ~-3
gettopsolidblock ~1 200 ~-3
gettopsolidblock ~2 200 ~-3
gettopsolidblock ~3 200 ~-3
gettopsolidblock ~4 200 ~-3
gettopsolidblock ~5 200 ~-3

# Row -2
gettopsolidblock ~-5 200 ~-2
gettopsolidblock ~-4 200 ~-2
gettopsolidblock ~-3 200 ~-2
gettopsolidblock ~-2 200 ~-2
gettopsolidblock ~-1 200 ~-2
gettopsolidblock ~0 200 ~-2
gettopsolidblock ~1 200 ~-2
gettopsolidblock ~2 200 ~-2
gettopsolidblock ~3 200 ~-2
gettopsolidblock ~4 200 ~-2
gettopsolidblock ~5 200 ~-2

# Row -1
gettopsolidblock ~-5 200 ~-1
gettopsolidblock ~-4 200 ~-1
gettopsolidblock ~-3 200 ~-1
gettopsolidblock ~-2 200 ~-1
gettopsolidblock ~-1 200 ~-1
gettopsolidblock ~0 200 ~-1
gettopsolidblock ~1 200 ~-1
gettopsolidblock ~2 200 ~-1
gettopsolidblock ~3 200 ~-1
gettopsolidblock ~4 200 ~-1
gettopsolidblock ~5 200 ~-1

# Row 0 (player's X row)
gettopsolidblock ~-5 200 ~0
gettopsolidblock ~-4 200 ~0
gettopsolidblock ~-3 200 ~0
gettopsolidblock ~-2 200 ~0
gettopsolidblock ~-1 200 ~0
# Center already scanned above
gettopsolidblock ~1 200 ~0
gettopsolidblock ~2 200 ~0
gettopsolidblock ~3 200 ~0
gettopsolidblock ~4 200 ~0
gettopsolidblock ~5 200 ~0

# Row 1
gettopsolidblock ~-5 200 ~1
gettopsolidblock ~-4 200 ~1
gettopsolidblock ~-3 200 ~1
gettopsolidblock ~-2 200 ~1
gettopsolidblock ~-1 200 ~1
gettopsolidblock ~0 200 ~1
gettopsolidblock ~1 200 ~1
gettopsolidblock ~2 200 ~1
gettopsolidblock ~3 200 ~1
gettopsolidblock ~4 200 ~1
gettopsolidblock ~5 200 ~1

# Row 2
gettopsolidblock ~-5 200 ~2
gettopsolidblock ~-4 200 ~2
gettopsolidblock ~-3 200 ~2
gettopsolidblock ~-2 200 ~2
gettopsolidblock ~-1 200 ~2
gettopsolidblock ~0 200 ~2
gettopsolidblock ~1 200 ~2
gettopsolidblock ~2 200 ~2
gettopsolidblock ~3 200 ~2
gettopsolidblock ~4 200 ~2
gettopsolidblock ~5 200 ~2

# Row 3
gettopsolidblock ~-5 200 ~3
gettopsolidblock ~-4 200 ~3
gettopsolidblock ~-3 200 ~3
gettopsolidblock ~-2 200 ~3
gettopsolidblock ~-1 200 ~3
gettopsolidblock ~0 200 ~3
gettopsolidblock ~1 200 ~3
gettopsolidblock ~2 200 ~3
gettopsolidblock ~3 200 ~3
gettopsolidblock ~4 200 ~3
gettopsolidblock ~5 200 ~3

# Row 4
gettopsolidblock ~-5 200 ~4
gettopsolidblock ~-4 200 ~4
gettopsolidblock ~-3 200 ~4
gettopsolidblock ~-2 200 ~4
gettopsolidblock ~-1 200 ~4
gettopsolidblock ~0 200 ~4
gettopsolidblock ~1 200 ~4
gettopsolidblock ~2 200 ~4
gettopsolidblock ~3 200 ~4
gettopsolidblock ~4 200 ~4
gettopsolidblock ~5 200 ~4

# Row 5 (in front of player)
gettopsolidblock ~-5 200 ~5
gettopsolidblock ~-4 200 ~5
gettopsolidblock ~-3 200 ~5
gettopsolidblock ~-2 200 ~5
gettopsolidblock ~-1 200 ~5
gettopsolidblock ~0 200 ~5
gettopsolidblock ~1 200 ~5
gettopsolidblock ~2 200 ~5
gettopsolidblock ~3 200 ~5
gettopsolidblock ~4 200 ~5
gettopsolidblock ~5 200 ~5
```

**Note**: 
- Commands in `.mcfunction` files do NOT use the leading `/`
- All 121 commands execute in a single tick
- This scans an 11x11 grid centered on the player

---

### Step 4: Create Player Location Function

**File**: `functions/scan/player_location.mcfunction`

```mcfunction
# Get player's precise location
querytarget @s

# Optional: Get current facing direction
# (Add any additional player data you need)
```

---

### Step 5: Call Functions via WebSocket

Once your behavior pack is installed and active in your world, you can call these functions via WebSocket commands:

```javascript
// Via WebSocket command
ws.send(JSON.stringify({
    "header": {
        "requestId": "uuid-here",
        "messagePurpose": "commandRequest",
        "version": 1
    },
    "body": {
        "commandLine": "execute as @s run function scan/terrain_scan"
    }
}));

// Get player location
ws.send(JSON.stringify({
    "header": {
        "requestId": "uuid-here-2",
        "messagePurpose": "commandRequest",
        "version": 1
    },
    "body": {
        "commandLine": "execute as @s run function scan/player_location"
    }
}));
```

---

### Alternative: Larger Scan Areas

For a 21x21 grid (441 blocks), you'd extend the pattern:

```mcfunction
# Scan from ~-10 to ~10 in both X and Z
# Example rows:
gettopsolidblock ~-10 200 ~-10
gettopsolidblock ~-9 200 ~-10
# ... continue pattern ...
```

**Performance Note**: Stay under the 10,000 command limit. A 21x21 grid = 441 commands, which is safe.

---

### Key Advantages of Using /function

1. **Single WebSocket Request**: Instead of 121+ separate requests, send just one
2. **Atomic Execution**: All commands execute in the same tick
3. **Reduced Network Overhead**: One request/response cycle
4. **Consistent Data**: Terrain snapshot from the same game tick
5. **No Rate Limiting**: Avoid flooding the server with individual commands

---

### Function Command Syntax Reference

```mcfunction
# Comments start with #
# No leading slash (/) required
# One command per line
# Blank lines are ignored

# Target selectors work as expected
execute as @a run say Hello
teleport @s ~ ~1 ~

# Relative coordinates
gettopsolidblock ~ 200 ~
querytarget @s

# Call other functions
function namespace/other_function
```

---

## Part 2: Inventory Scanning Methods

### Challenge: No Direct Inventory Command

Minecraft Bedrock Edition **does not have a command** to directly query inventory contents via WebSocket. However, there are several approaches:

---

### Method 1: /clear Command (Test Mode) ⚠️ Limited

The `/clear` command can detect items without removing them:

```bash
# Test if player has diamonds (doesn't remove them)
/clear @s minecraft:diamond 0 0
```

**Command Breakdown**:
- `@s` - Target player
- `minecraft:diamond` - Item type
- `0` - Data value (0 = default, -1 = any variant)
- `0` - Max count (0 = test mode, doesn't remove)

**Response**:
- Returns success count = number of matching items found
- **Does NOT** tell you which slot(s) contain the item
- **Does NOT** provide item details (enchantments, NBT data)

**Example via WebSocket**:
```javascript
ws.send(JSON.stringify({
    "body": {
        "commandLine": "clear @s minecraft:diamond_sword 0 0"
    }
}));
// Response: "Could not clear the inventory of Player, no items to remove"
// or "Removed 0 items from Player" (success = has item)
```

**Limitations**:
- Cannot identify specific slots
- No slot-by-slot scanning
- Cannot read enchantments or durability
- Only tells you total count across all slots

---

### Method 2: Scripting API (Behavior Pack) ✅ RECOMMENDED

**This is the most powerful method for inventory scanning.**

The Minecraft Bedrock Scripting API provides full access to player inventory via JavaScript/TypeScript.

#### Setup: Create a Script Behavior Pack

**Structure**:
```
inventory_scanner_bp/
├── manifest.json
├── scripts/
│   └── main.js
└── functions/
    └── trigger_scan.mcfunction
```

#### manifest.json

```json
{
    "format_version": 2,
    "header": {
        "name": "Inventory Scanner",
        "description": "Scans player inventory and hotbar",
        "uuid": "22345678-2234-2234-2234-223456789def",
        "version": [1, 0, 0],
        "min_engine_version": [1, 20, 0]
    },
    "modules": [
        {
            "type": "script",
            "language": "javascript",
            "uuid": "32345678-3234-3234-3234-323456789ghi",
            "version": [1, 0, 0],
            "entry": "scripts/main.js"
        }
    ],
    "dependencies": [
        {
            "module_name": "@minecraft/server",
            "version": "1.8.0"
        }
    ]
}
```

#### scripts/main.js (Full Inventory Scanner)

```javascript
import { world, system } from "@minecraft/server";

// Scan player inventory (all 36 slots)
function scanInventory(player) {
    const inventory = player.getComponent("minecraft:inventory");
    if (!inventory || !inventory.container) {
        return null;
    }
    
    const container = inventory.container;
    const result = {
        playerName: player.name,
        inventorySize: container.size, // Should be 36
        emptySlots: container.emptySlotsCount,
        slots: []
    };
    
    // Scan all slots (0-35)
    // Slots 0-8: Hotbar
    // Slots 9-35: Main inventory
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        
        if (item) {
            result.slots.push({
                slot: i,
                type: item.typeId,           // e.g., "minecraft:diamond_sword"
                amount: item.amount,          // Stack size
                name: item.nameTag || null,   // Custom name
                lore: item.lore || []         // Lore lines
            });
        }
    }
    
    return result;
}

// Scan only hotbar (slots 0-8)
function scanHotbar(player) {
    const inventory = player.getComponent("minecraft:inventory");
    if (!inventory || !inventory.container) return null;
    
    const container = inventory.container;
    const hotbar = [];
    
    for (let i = 0; i < 9; i++) {
        const item = container.getItem(i);
        hotbar.push(item ? {
            slot: i,
            type: item.typeId,
            amount: item.amount
        } : null);
    }
    
    return hotbar;
}

// Run every second (20 ticks)
system.runInterval(() => {
    const players = world.getAllPlayers();
    
    for (const player of players) {
        const inventoryData = scanInventory(player);
        
        if (inventoryData) {
            // Send to player as chat message (for debugging)
            player.sendMessage(`§aInventory: ${inventoryData.slots.length} items`);
            
            // TODO: Send to external WebSocket server via HTTP
            // (See Method 3 for HTTP integration)
        }
    }
}, 20); // Every 1 second
```

#### Slot Numbers Reference

```
Hotbar Slots: 0-8
┌───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │
└───┴───┴───┴───┴───┴───┴───┴───┴───┘

Main Inventory Slots: 9-35
┌───┬───┬───┬───┬───┬───┬───┬───┬───┐
│ 9 │10 │11 │12 │13 │14 │15 │16 │17 │
├───┼───┼───┼───┼───┼───┼───┼───┼───┤
│18 │19 │20 │21 │22 │23 │24 │25 │26 │
├───┼───┼───┼───┼───┼───┼───┼───┼───┤
│27 │28 │29 │30 │31 │32 │33 │34 │35 │
└───┴───┴───┴───┴───┴───┴───┴───┴───┘

Armor Slots: Separate component
- Helmet: player.getComponent("minecraft:equippable").getEquipment("Head")
- Chestplate: getEquipment("Chest")
- Leggings: getEquipment("Legs")
- Boots: getEquipment("Feet")
- Offhand: getEquipment("Offhand")
```

---

### Method 3: Scripting API + HTTP Bridge

To send inventory data to your external UI, use HTTP requests from the script:

**Add dependency to manifest.json**:
```json
"dependencies": [
    {
        "module_name": "@minecraft/server",
        "version": "1.8.0"
    },
    {
        "module_name": "@minecraft/server-net",
        "version": "1.0.0"
    }
]
```

**Updated main.js with HTTP**:
```javascript
import { world, system } from "@minecraft/server";
import { HttpRequest, HttpRequestMethod, http } from "@minecraft/server-net";

function sendInventoryToUI(player, inventoryData) {
    const request = new HttpRequest("http://localhost:8080/inventory");
    request.method = HttpRequestMethod.Post;
    request.body = JSON.stringify(inventoryData);
    request.headers = [
        { key: "Content-Type", value: "application/json" }
    ];
    
    http.request(request).then(response => {
        if (response.status !== 200) {
            console.warn(`Failed to send inventory: ${response.status}`);
        }
    }).catch(error => {
        console.error("HTTP Error:", error);
    });
}

// Periodic scan
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const data = scanInventory(player);
        if (data) {
            sendInventoryToUI(player, data);
        }
    }
}, 20); // Every second
```

**Your UI Server** receives JSON like:
```json
{
    "playerName": "Steve",
    "inventorySize": 36,
    "emptySlots": 20,
    "slots": [
        {
            "slot": 0,
            "type": "minecraft:diamond_sword",
            "amount": 1,
            "name": "Legendary Blade",
            "lore": ["Deals extra damage"]
        },
        {
            "slot": 3,
            "type": "minecraft:cooked_beef",
            "amount": 32,
            "name": null,
            "lore": []
        }
    ]
}
```

---

### Method 4: Event-Driven Scanning (Optimized)

Instead of scanning every second, trigger scans on inventory changes:

```javascript
import { world } from "@minecraft/server";

// Detect when player uses an item
world.afterEvents.itemUse.subscribe((event) => {
    const player = event.source;
    const inventoryData = scanInventory(player);
    sendInventoryToUI(player, inventoryData);
});

// Detect when player picks up items
world.afterEvents.itemCompleteUse.subscribe((event) => {
    const player = event.source;
    const inventoryData = scanInventory(player);
    sendInventoryToUI(player, inventoryData);
});

// Detect block breaks (item durability changes)
world.afterEvents.playerBreakBlock.subscribe((event) => {
    const player = event.player;
    const inventoryData = scanInventory(player);
    sendInventoryToUI(player, inventoryData);
});
```

---

### Method Comparison

| Method | Pros | Cons | Best For |
|--------|------|------|----------|
| **/clear Test** | Simple, no behavior pack needed | No slot info, no item details | Quick item detection |
| **Scripting API** | Full access, all slots, item details | Requires behavior pack | Real-time inventory UI |
| **HTTP Bridge** | Direct UI integration | Network overhead | External minimap UI |
| **Event-Driven** | Efficient, updates only on change | May miss some changes | Performance-critical apps |

---

## Implementation Examples

### Example 1: Complete Minimap Scan (Function + Script)

**Behavior Pack Structure**:
```
minimap_complete_bp/
├── manifest.json
├── functions/
│   └── scan/
│       └── terrain.mcfunction
└── scripts/
    └── main.js
```

**main.js** (Calls terrain function + sends data):
```javascript
import { world, system } from "@minecraft/server";
import { HttpRequest, HttpRequestMethod, http } from "@minecraft/server-net";

let scanTick = 0;

system.runInterval(() => {
    scanTick++;
    
    // Scan every 2 seconds (40 ticks)
    if (scanTick % 40 === 0) {
        for (const player of world.getAllPlayers()) {
            // Trigger terrain scan function
            player.runCommand("function scan/terrain");
            
            // Get player location
            const location = player.location;
            const rotation = player.getRotation();
            
            // Scan inventory
            const inventory = scanInventory(player);
            
            // Send to UI
            const data = {
                location: {
                    x: location.x,
                    y: location.y,
                    z: location.z
                },
                rotation: {
                    x: rotation.x,
                    y: rotation.y
                },
                inventory: inventory
            };
            
            sendToUI(data);
        }
    }
}, 1);

function scanInventory(player) {
    const inv = player.getComponent("minecraft:inventory");
    if (!inv || !inv.container) return null;
    
    const slots = [];
    for (let i = 0; i < 9; i++) { // Hotbar only
        const item = inv.container.getItem(i);
        slots.push(item ? {
            slot: i,
            type: item.typeId,
            amount: item.amount
        } : null);
    }
    return { hotbar: slots };
}

function sendToUI(data) {
    const req = new HttpRequest("http://localhost:8080/minimap-update");
    req.method = HttpRequestMethod.Post;
    req.body = JSON.stringify(data);
    http.request(req);
}
```

---

### Example 2: WebSocket + Function Integration (Node.js)

```javascript
// Your Node.js WebSocket client
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:19132'); // Bedrock WebSocket

ws.on('open', () => {
    console.log('Connected to Minecraft');
    
    // Subscribe to command responses
    ws.send(JSON.stringify({
        header: {
            requestId: "sub-1",
            messagePurpose: "subscribe",
            version: 1
        },
        body: {
            eventName: "PlayerMessage"
        }
    }));
    
    // Trigger terrain scan every 2 seconds
    setInterval(() => {
        ws.send(JSON.stringify({
            header: {
                requestId: `scan-${Date.now()}`,
                messagePurpose: "commandRequest",
                version: 1
            },
            body: {
                commandLine: "execute as @a run function scan/terrain"
            }
        }));
    }, 2000);
});

ws.on('message', (data) => {
    const response = JSON.parse(data);
    
    // Parse terrain scan results
    if (response.body.message) {
        const message = response.body.message;
        
        // Example: "The top solid block at 100, 200, 50 is minecraft:grass"
        const match = message.match(/top solid block at (-?\d+), (-?\d+), (-?\d+) is (\w+:\w+)/);
        if (match) {
            const [_, x, y, z, blockType] = match;
            updateMinimap({ x, y, z, blockType });
        }
    }
});

function updateMinimap(blockData) {
    // Update your minimap UI
    console.log('Block detected:', blockData);
}
```

---

## Performance Considerations

### Terrain Scanning

**Optimal Scan Frequency**:
- **Fast movement**: Scan every 1-2 seconds (20-40 ticks)
- **Slow movement**: Scan every 3-5 seconds (60-100 ticks)
- **Stationary**: Scan on-demand or every 10+ seconds

**Grid Size Recommendations**:
- **11x11** (121 blocks): Good for close-range minimap
- **21x21** (441 blocks): Medium-range, still performant
- **31x31** (961 blocks): Large area, may cause lag spikes
- **41x41** (1,681 blocks): Maximum recommended
- **100x100** (10,000 blocks): At the command limit, use cautiously

**Optimization Tips**:
1. Only scan when player moves significantly (>5 blocks)
2. Cache terrain data between scans
3. Use smaller grids when underground (less vertical scanning needed)
4. Consider scanning in chunks (e.g., 4 quadrants with slight delays)

---

### Inventory Scanning

**Optimal Scan Frequency**:
- **Event-driven**: Best performance, scan only on item use/pickup
- **Periodic (1 second)**: Good balance for real-time UI
- **Periodic (5 seconds)**: Low overhead, acceptable delay
- **On-demand**: When player opens inventory screen

**Optimization**:
```javascript
// Cache previous inventory state
let lastInventoryHash = "";

function scanIfChanged(player) {
    const inv = scanInventory(player);
    const hash = JSON.stringify(inv);
    
    if (hash !== lastInventoryHash) {
        lastInventoryHash = hash;
        sendToUI(inv);
        return true;
    }
    return false; // No changes
}
```

---

### Network Optimization

**Batch Updates**:
```javascript
// Instead of sending 121 separate terrain updates,
// batch into one payload
const terrainBatch = [];

// Collect all terrain data
for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
        terrainBatch.push({ x, z, blockType: "..." });
    }
}

// Send once
sendToUI({ type: "terrain", data: terrainBatch });
```

**Compression**:
```javascript
// Use shorter keys for JSON
const compactData = {
    t: "terrain", // type
    d: terrainBatch.map(b => [b.x, b.z, b.blockType[10]]) // drop "minecraft:"
};
```

---

## Troubleshooting

### Functions Not Working

1. **Check manifest.json UUIDs**: Must be unique
2. **Verify file paths**: Use lowercase, underscores only
3. **Enable content logs**: Settings → Creator → Content Log Errors
4. **Reload world**: `/reload` command or restart world

### Inventory Scanning Issues

1. **Script not running**: Check behavior pack is active
2. **HTTP requests fail**: Ensure `@minecraft/server-net` dependency is added
3. **Empty inventory data**: Verify player has `minecraft:inventory` component

### Performance Problems

1. **Lag spikes**: Reduce scan grid size or frequency
2. **WebSocket flooding**: Batch commands into functions
3. **High CPU usage**: Use event-driven scanning instead of polling

---

## Summary

### For Terrain Scanning (Minimap)
✅ **Use `/function` with `.mcfunction` files**
- Batch up to 10,000 `gettopsolidblock` commands
- Execute all in one tick via single WebSocket command
- Start with 11x11 grid (121 blocks), scale as needed

### For Inventory Scanning
✅ **Use Scripting API (Behavior Pack)**
- Full access to all 36 slots + hotbar
- Get item types, amounts, names, lore
- Send to external UI via HTTP bridge
- Use event-driven scanning for best performance

### Quick Start Checklist
1. ✅ Create behavior pack folder structure
2. ✅ Write `manifest.json` with unique UUIDs
3. ✅ Create `.mcfunction` file for terrain scanning
4. ✅ Create JavaScript script for inventory scanning
5. ✅ Activate behavior pack in world settings
6. ✅ Call `/function` via WebSocket
7. ✅ Receive HTTP POST from script to your UI

---

## Additional Resources

- [Bedrock Wiki: Functions](https://wiki.bedrock.dev/commands/mcfunctions.html)
- [Bedrock Scripting API Docs](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/)
- [EntityInventoryComponent API](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/entityinventorycomponent)
- [WebSocket Protocol](https://gist.github.com/jocopa3/54b42fb6361952997c4a6e38945d43b7)

---

Good luck with your minimap project! 🗺️
