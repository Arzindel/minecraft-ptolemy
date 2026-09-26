# Development Guide

This guide is for developers who want to modify or extend the MineCA project.

## Architecture Overview

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  Minecraft      │◄───WS───►│  Node.js        │◄───WS───►│  Web Browser    │
│  Bedrock        │         │  Bridge Server  │         │  (UI)           │
│                 │         │                 │         │                 │
│  - Behavior Pack│         │  - server.js    │         │  - index.html   │
│  - Functions    │◄───HTTP─┤  - Port 3000    │         │  - app.js       │
│  - Scripts      │         │  - WebSocket    │         │  - style.css    │
└─────────────────┘         └─────────────────┘         └─────────────────┘
```

### Communication Flow

1. **Behavior Pack → Server**: HTTP POST to `/update` with player/inventory data
2. **Server → Minecraft**: WebSocket commands (querytarget, gettopsolidblock)
3. **Server → Web UI**: WebSocket broadcasts (player data, terrain, chat)
4. **Web UI → Server**: WebSocket requests (chat messages, scan requests)

---

## Project Components

### 1. Behavior Pack

**Location**: `behavior_pack/`

**Key Files**:
- `manifest.json` - Pack metadata and dependencies
- `scripts/main.js` - JavaScript for inventory scanning and HTTP communication
- `functions/scan/*.mcfunction` - Terrain scanning command batches

**Modifying Behavior Pack**:
```javascript
// behavior_pack/scripts/main.js

// Change scan interval (default: 2 seconds)
const SCAN_INTERVAL = 40; // ticks (20 ticks = 1 second)

// Change HTTP server endpoint
const HTTP_SERVER = "http://localhost:3000";

// Add custom inventory processing
function scanInventory(player) {
    const inventory = player.getComponent("minecraft:inventory");
    // Your custom logic here
}
```

**Testing Changes**:
1. Edit files in `behavior_pack/`
2. Run `INSTALL_BEHAVIOR_PACK.bat` to update
3. In Minecraft, run `/reload`
4. Check for errors: Settings → Creator → Content Log

---

### 2. Node.js Bridge Server

**Location**: `server/`

**Key Files**:
- `server.js` - Main server logic
- `package.json` - Dependencies

**Server Responsibilities**:
- Connect to Minecraft WebSocket (port 19132)
- Serve web UI static files (port 3000)
- Accept HTTP POST from behavior pack
- Broadcast updates to web clients
- Parse Minecraft command responses

**Modifying Server**:
```javascript
// server/server.js

// Add custom message handler
function handleMinecraftMessage(message) {
    // Your custom parsing logic
    if (message.body.statusMessage.includes('custom')) {
        // Handle custom responses
    }
}

// Add custom web client handler
function handleWebClientMessage(message, ws) {
    switch (message.type) {
        case 'myCustomType':
            // Handle custom message from web UI
            break;
    }
}

// Add HTTP endpoints
app.post('/custom-endpoint', (req, res) => {
    // Handle custom HTTP requests
    res.json({ success: true });
});
```

**Testing Server**:
```bash
cd server
npm install
npm run dev  # Uses nodemon for auto-restart
```

---

### 3. Web UI

**Location**: `web_ui/`

**Key Files**:
- `index.html` - UI structure
- `style.css` - Styling
- `app.js` - Main UI logic and WebSocket client
- `blockColors.js` - Block color definitions

**UI State Management**:
```javascript
// web_ui/app.js

// Global state
let playerData = {
    name: '',
    location: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0 },
    inventory: []
};

let terrainData = new Map(); // "x,z" → blockType
let chatMessages = [];
```

**Adding New Features**:

**Example: Add a new tab**
```html
<!-- index.html -->
<button class="tab" data-tab="stats">Stats</button>

<div id="stats-tab" class="tab-content">
    <div id="player-stats"></div>
</div>
```

```javascript
// app.js
function updateStats(data) {
    const statsDiv = document.getElementById('player-stats');
    statsDiv.innerHTML = `
        <div>Health: ${data.health}</div>
        <div>Hunger: ${data.hunger}</div>
    `;
}
```

**Example: Add new block color**
```javascript
// blockColors.js
const BLOCK_COLORS = {
    // Add your new block
    'my_custom_block': '#ff00ff',
    
    // Or multiple variants
    'custom_red': '#ff0000',
    'custom_blue': '#0000ff',
};
```

---

## Adding New Features

### Feature: Add Armor Display

**1. Update Behavior Pack Script**
```javascript
// behavior_pack/scripts/main.js

function getArmorSlots(player) {
    const equippable = player.getComponent("minecraft:equippable");
    if (!equippable) return null;
    
    return {
        helmet: equippable.getEquipment("Head"),
        chestplate: equippable.getEquipment("Chest"),
        leggings: equippable.getEquipment("Legs"),
        boots: equippable.getEquipment("Feet"),
        offhand: equippable.getEquipment("Offhand")
    };
}

// In getPlayerData():
armor: getArmorSlots(player)
```

**2. Update Server (if needed)**
```javascript
// server/server.js
// Server just passes data through, no changes needed
```

**3. Update Web UI**
```html
<!-- web_ui/index.html -->
<div class="armor-section">
    <h3>Armor</h3>
    <div id="armor-slots" class="armor-grid"></div>
</div>
```

```javascript
// web_ui/app.js
function updateArmor() {
    if (!playerData.armor) return;
    
    const armorDiv = document.getElementById('armor-slots');
    armorDiv.innerHTML = `
        <div class="armor-slot">${playerData.armor.helmet?.type || 'Empty'}</div>
        <div class="armor-slot">${playerData.armor.chestplate?.type || 'Empty'}</div>
        <div class="armor-slot">${playerData.armor.leggings?.type || 'Empty'}</div>
        <div class="armor-slot">${playerData.armor.boots?.type || 'Empty'}</div>
    `;
}
```

---

### Feature: Add Waypoint Markers

**1. Update Web UI to add waypoints**
```javascript
// web_ui/app.js

let waypoints = []; // { x, z, label, color }

function addWaypoint(x, z, label, color = '#ffff00') {
    waypoints.push({ x, z, label, color });
    drawMinimap(); // Redraw with new waypoint
}

// In drawMinimap():
waypoints.forEach(waypoint => {
    const offsetX = waypoint.x - centerX;
    const offsetZ = waypoint.z - centerZ;
    
    if (Math.abs(offsetX) <= radius && Math.abs(offsetZ) <= radius) {
        const canvasX = (offsetX + radius) * CELL_SIZE;
        const canvasY = (offsetZ + radius) * CELL_SIZE;
        
        // Draw waypoint marker
        ctx.fillStyle = waypoint.color;
        ctx.beginPath();
        ctx.arc(canvasX, canvasY, 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw label
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px Arial';
        ctx.fillText(waypoint.label, canvasX + 6, canvasY + 3);
    }
});
```

**2. Add UI controls**
```html
<!-- index.html -->
<div class="waypoint-controls">
    <input type="text" id="waypoint-label" placeholder="Waypoint name">
    <button id="add-waypoint">Add Current Location</button>
</div>
```

```javascript
// app.js
document.getElementById('add-waypoint').addEventListener('click', () => {
    const label = document.getElementById('waypoint-label').value;
    if (label) {
        addWaypoint(
            Math.floor(playerData.location.x),
            Math.floor(playerData.location.z),
            label
        );
    }
});
```

---

### Feature: Entity Tracking (Mobs/Players)

**Limitation**: Bedrock WebSocket doesn't provide entity queries directly.

**Workaround**: Use behavior pack to track entities

```javascript
// behavior_pack/scripts/main.js

function getNearbyEntities(player) {
    const dimension = player.dimension;
    const location = player.location;
    
    const entities = dimension.getEntities({
        location: location,
        maxDistance: 50,
        excludeTypes: ['minecraft:item'] // Don't track dropped items
    });
    
    return entities.map(entity => ({
        type: entity.typeId.replace('minecraft:', ''),
        location: {
            x: entity.location.x,
            y: entity.location.y,
            z: entity.location.z
        }
    }));
}

// In getPlayerData():
nearbyEntities: getNearbyEntities(player)
```

---

## Debugging

### Debug Behavior Pack

**Enable Debug Mode:**
```javascript
// behavior_pack/scripts/main.js

const DEBUG = true;

function debug(message) {
    if (DEBUG) {
        console.warn(`[MineCA] ${message}`);
    }
}

// Use throughout code:
debug(`Inventory scanned: ${slots.length} items`);
```

**View Logs:**
- In-game: Settings → Creator → Content Log
- Or check: `%localappdata%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\logs\`

---

### Debug Server

**Add logging:**
```javascript
// server/server.js

const DEBUG = true;

function log(category, message, data = null) {
    if (!DEBUG) return;
    
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${category}] ${message}`);
    if (data) {
        console.log(JSON.stringify(data, null, 2));
    }
}

// Use throughout:
log('MINECRAFT', 'Received message', message);
log('WEB', 'Client connected');
log('TERRAIN', 'Block update', { x, y, z, type });
```

**Monitor WebSocket messages:**
```javascript
minecraftWs.on('message', (data) => {
    console.log('← FROM MINECRAFT:', data.toString());
    // ... existing handler
});

minecraftWs.send = (originalSend => function(data) {
    console.log('→ TO MINECRAFT:', data);
    return originalSend.call(this, data);
})(minecraftWs.send);
```

---

### Debug Web UI

**Browser Console:**
```javascript
// web_ui/app.js

// Add debug flag
const DEBUG = true;

function debugLog(category, message, data) {
    if (!DEBUG) return;
    console.log(`[${category}] ${message}`, data || '');
}

// Use throughout:
debugLog('WS', 'Received message', data);
debugLog('MAP', 'Drawing terrain', terrainData.size);
debugLog('INV', 'Updating inventory', playerData.inventory);
```

**Network Monitoring:**
- Open DevTools (F12)
- Go to Network tab
- Filter by WS (WebSocket) to see messages
- Filter by Fetch/XHR to see HTTP requests

---

## Testing

### Manual Testing Checklist

**Behavior Pack:**
- [ ] Run `/reload` - no errors in content log
- [ ] Run `/function scan/terrain_7x7` - terrain appears in UI
- [ ] Pick up item - inventory updates in UI
- [ ] Send chat message - appears in game

**Server:**
- [ ] Server starts without errors
- [ ] Connects to Minecraft (green status)
- [ ] Web clients can connect
- [ ] HTTP endpoint receives behavior pack data

**Web UI:**
- [ ] All tabs render correctly
- [ ] Map zoom controls work
- [ ] Inventory displays items
- [ ] Chat sends and receives

---

### Automated Testing

**Test Server Endpoints:**
```javascript
// test-server.js
const axios = require('axios');

async function testServer() {
    try {
        // Test HTTP endpoint
        const response = await axios.post('http://localhost:3000/update', {
            name: 'TestPlayer',
            location: { x: 100, y: 64, z: 200 },
            inventory: []
        });
        
        console.log('✓ HTTP endpoint working');
    } catch (error) {
        console.error('✗ HTTP endpoint failed:', error.message);
    }
}

testServer();
```

---

## Performance Optimization

### Optimize Terrain Scanning

**Adaptive Zoom:**
```javascript
// Adjust zoom based on player movement speed
let lastLocation = { x: 0, z: 0 };

function calculateOptimalZoom(currentLocation) {
    const distance = Math.sqrt(
        Math.pow(currentLocation.x - lastLocation.x, 2) +
        Math.pow(currentLocation.z - lastLocation.z, 2)
    );
    
    if (distance > 10) {
        return 51; // Moving fast, larger zoom
    } else if (distance > 5) {
        return 21; // Moving medium
    } else {
        return 11; // Moving slow or stationary
    }
}
```

**Progressive Scanning:**
```javascript
// Scan center first, then expand outward
function progressiveScan(player, maxRadius) {
    for (let radius = 3; radius <= maxRadius; radius += 2) {
        player.runCommand(`function scan/terrain_${radius}x${radius}`);
        // Add delay between scans
        system.runTimeout(() => {}, radius * 5);
    }
}
```

---

### Optimize Inventory Updates

**Delta Updates:**
```javascript
let previousInventory = [];

function getInventoryChanges(currentInventory) {
    const changes = [];
    
    currentInventory.forEach((item, index) => {
        const prevItem = previousInventory[index];
        
        if (JSON.stringify(item) !== JSON.stringify(prevItem)) {
            changes.push({ slot: index, item });
        }
    });
    
    previousInventory = [...currentInventory];
    return changes;
}

// Send only changes
const changes = getInventoryChanges(inventory);
if (changes.length > 0) {
    sendToWebUI({ type: 'inventoryDelta', changes });
}
```

---

## Contributing Guidelines

If you want to contribute improvements:

1. **Code Style:**
   - Use 4-space indentation
   - Semicolons required in JavaScript
   - Descriptive variable names
   - Comment complex logic

2. **Testing:**
   - Test all changes in-game
   - Verify on multiple browsers
   - Check mobile compatibility

3. **Documentation:**
   - Update README.md for user-facing changes
   - Update DEVELOPMENT.md for technical changes
   - Add comments for complex code

4. **Performance:**
   - Profile changes for lag
   - Test with large terrain areas
   - Monitor memory usage

---

## Useful Resources

- [Bedrock Script API Docs](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/)
- [WebSocket Protocol Docs](https://gist.github.com/jocopa3/54b42fb6361952997c4a6e38945d43b7)
- [Bedrock Wiki](https://wiki.bedrock.dev/)
- [Canvas API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)

---

Happy developing! 🚀
