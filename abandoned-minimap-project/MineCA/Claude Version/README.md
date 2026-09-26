# MineCA - Minecraft Bedrock Minimap & Inventory UI

A complete real-time web UI for Minecraft Bedrock Edition featuring:
- **Interactive Minimap** with zoom controls (7x7 to 101x101)
- **Live Inventory Display** showing all 36 slots + hotbar
- **Chat Integration** for sending and receiving messages

Perfect for use on phones (landscape mode) or Steam Deck!

---

## Features

### Map Tab
- Real-time terrain scanning using batch commands
- Zoom levels: 7x7, 11x11, 15x15, 21x21, 31x31, 41x41, 51x51, 71x71, 101x101
- Player marker with direction indicator
- Block color coding (150+ block types)
- Centered on player position

### Inventory Tab
- Full inventory display (27 slots)
- Hotbar display (9 slots)
- Item names and stack counts
- Color-coded item indicators

### Chat Tab
- View in-game chat messages
- Send messages from external device
- Messages appear with correct player name
- System notifications

---

## Project Structure

```
Claude Version/
├── behavior_pack/           # Minecraft behavior pack
│   ├── manifest.json
│   ├── functions/
│   │   └── scan/           # Terrain scanning functions
│   │       ├── terrain_7x7.mcfunction
│   │       ├── terrain_11x11.mcfunction
│   │       ├── terrain_21x21.mcfunction
│   │       └── ... (up to 101x101)
│   └── scripts/
│       └── main.js         # Inventory scanner & HTTP bridge
│
├── server/                  # Node.js WebSocket bridge
│   ├── package.json
│   └── server.js           # Bridge between Minecraft and Web UI
│
└── web_ui/                  # Web interface
    ├── index.html
    ├── style.css
    ├── app.js              # Main UI logic
    └── blockColors.js      # Block color definitions
```

---

## Setup Instructions

### Prerequisites

1. **Minecraft Bedrock Edition** (Windows 10/11, or Bedrock Dedicated Server)
2. **Node.js** (v16 or higher) - [Download here](https://nodejs.org/)
3. **WebSocket enabled** in Minecraft

---

### Step 1: Enable WebSocket in Minecraft

#### For Minecraft Bedrock (Windows 10/11):

1. Open Minecraft
2. Create or load a world
3. Enable cheats (World Settings → Cheats: ON)
4. In-game, run command:
   ```
   /wsserver 19132
   ```
   You should see: "WebSocket server started on port 19132"

#### For Bedrock Dedicated Server:

1. Edit `server.properties`
2. Add or modify:
   ```
   enable-websocket-encryption=false
   ```
3. Restart server

---

### Step 2: Install Behavior Pack

1. **Locate your Minecraft behavior packs folder:**
   - **Windows**: `%localappdata%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs`
   - **Or**: Open Minecraft → Settings → Storage → Open Folder → Navigate to `behavior_packs`

2. **Copy the behavior pack:**
   ```bash
   # From the Claude Version folder
   cp -r behavior_pack "%localappdata%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs\mineca_bp"
   ```

3. **Activate the behavior pack:**
   - Open Minecraft
   - Go to Settings → Game → scroll to Add-Ons
   - Find "MineCA Minimap" under Available Packs
   - Click to add it to Active Packs
   - Restart the world if needed

4. **Verify it's working:**
   - You should see in chat: "Behavior pack active"
   - Try running: `/function scan/terrain_7x7`

---

### Step 3: Install Node.js Server

1. **Navigate to server folder:**
   ```bash
   cd "Claude Version/server"
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

   You should see:
   ```
   MineCA Server starting...
   Web UI server running on http://localhost:3000
   Connecting to Minecraft at localhost:19132...
   Connected to Minecraft!
   ```

---

### Step 4: Open Web UI

1. **Open your browser:**
   - Go to: `http://localhost:3000`
   - Or from another device on the same network: `http://<your-pc-ip>:3000`

2. **Check connection:**
   - The status indicator (●) should be green
   - You should see your player coordinates in the header

3. **Test features:**
   - **Map Tab**: Click zoom buttons to change view size
   - **Inv Tab**: View your inventory (pick up items to see changes)
   - **Chat Tab**: Send a message to test chat integration

---

## Usage Guide

### Map Tab

**Zoom Controls:**
- Click **-** to zoom out (larger area, less detail)
- Click **+** to zoom in (smaller area, more detail)
- Current zoom level shown between buttons

**Map Legend:**
- **Red circle** = Your player
- **White line** = Direction you're facing
- **Colors** = Different block types (see `blockColors.js`)

**Tips:**
- Terrain updates every 2 seconds
- Walk around to see more terrain
- Use zoom 7x7-15x15 for close exploration
- Use zoom 51x51-101x101 for overview

---

### Inventory Tab

**Layout:**
- **Main Inventory**: 27 slots (top 3 rows)
- **Hotbar**: 9 slots (bottom row)

**Slot Info:**
- Hover over items to see name and count
- Empty slots appear darker
- Stack counts shown in bottom-right corner

**Notes:**
- Inventory updates every 2 seconds
- Changes reflect when you pick up/drop items
- Armor slots not yet implemented

---

### Chat Tab

**Sending Messages:**
1. Type message in input box
2. Press Enter or click Send
3. Message appears in-game with your player name

**Message Format:**
- Your messages appear as: `<PlayerName> message`
- In-game messages show with sender name
- System messages appear in orange

**Tips:**
- Chat history persists until page refresh
- Timestamps shown on all messages
- Use for communication while on external device

---

## Advanced Configuration

### Change Server Ports

**Web UI Port** (default: 3000):
```javascript
// In server/server.js, line 8:
const WEB_PORT = 3000;
```

**Minecraft WebSocket Port** (default: 19132):
```javascript
// In server/server.js, line 10:
const MINECRAFT_PORT = 19132;
```

Also update in Minecraft: `/wsserver <new_port>`

---

### Adjust Scan Frequency

**Terrain Scan Interval:**
```javascript
// In behavior_pack/scripts/main.js, line 8:
const SCAN_INTERVAL = 40; // ticks (40 = 2 seconds)
```

**Player Data Query:**
```javascript
// In server/server.js, line 47:
setInterval(queryPlayerData, 2000); // milliseconds
```

---

### Add Custom Block Colors

Edit `web_ui/blockColors.js`:
```javascript
const BLOCK_COLORS = {
    // Add your custom colors
    'my_custom_block': '#ff00ff',
    // ...existing colors
};
```

Colors can be:
- Hex: `#ff0000`
- RGB: `rgb(255, 0, 0)`
- Named: `red`

---

### Use on Mobile/Steam Deck

1. **Find your PC's local IP:**
   ```bash
   # Windows
   ipconfig
   # Look for "IPv4 Address" (e.g., 192.168.1.100)
   
   # Linux/Mac
   ifconfig
   ```

2. **On your mobile device:**
   - Connect to same WiFi network
   - Open browser to: `http://<pc-ip>:3000`
   - Example: `http://192.168.1.100:3000`

3. **For best mobile experience:**
   - Use landscape orientation
   - Add to home screen for fullscreen
   - Chrome/Firefox recommended

---

## Troubleshooting

### "Connection failed" in Web UI

**Check:**
1. Is Minecraft running and WebSocket enabled?
   - Run: `/wsserver 19132`
2. Is the Node.js server running?
   - Check terminal for "Connected to Minecraft!"
3. Firewall blocking connection?
   - Allow Node.js through firewall

---

### Behavior pack not working

**Check:**
1. Is the pack activated in world settings?
2. Are cheats enabled? (Required for commands)
3. Check content log:
   - Settings → Creator → Content Log Errors
4. Try reloading:
   - Run: `/reload` in-game
   - Or restart the world

---

### Terrain not showing

**Check:**
1. Are you in a loaded chunk?
2. Try manually running:
   ```
   /function scan/terrain_7x7
   ```
3. Check browser console (F12) for errors
4. Verify block responses in server terminal

---

### Inventory not updating

**Check:**
1. Is the behavior pack's script running?
   - Look for "Behavior pack loaded" in chat
2. Is the HTTP endpoint accessible?
   - Test: `curl http://localhost:3000/update`
3. Check server terminal for HTTP requests

---

### Chat messages not appearing

**Check:**
1. Is PlayerMessage event subscribed?
   - Server should log "Connected to Minecraft!"
2. Try sending from both directions:
   - In-game to Web UI
   - Web UI to in-game
3. Check player name is detected:
   - Should appear in status bar

---

## Performance Optimization

### For Low-End Devices:

**Reduce scan frequency:**
```javascript
// behavior_pack/scripts/main.js
const SCAN_INTERVAL = 60; // Slower: 3 seconds
```

**Use smaller zoom levels:**
- Stick to 7x7, 11x11, 15x15
- Avoid 71x71 and 101x101

**Lower canvas resolution:**
```javascript
// web_ui/app.js, line 18
const CELL_SIZE = 4; // Smaller blocks = less GPU load
```

---

### For High-End Devices:

**Increase scan frequency:**
```javascript
const SCAN_INTERVAL = 20; // Faster: 1 second
```

**Higher canvas resolution:**
```javascript
const CELL_SIZE = 12; // Larger blocks = more detail
```

---

## Known Limitations

1. **No rotation from querytarget**: Player direction uses dummy value (behavior pack limitation)
2. **Armor slots not shown**: Can be added with additional scripting
3. **No item durability**: Requires enchantment component access
4. **Terrain updates slowly for large areas**: 101x101 = 10,201 commands
5. **Chat player name detection**: Requires querytarget to get correct name

---

## Future Enhancements

Potential additions (not yet implemented):
- [ ] Item drag-and-drop in inventory
- [ ] Waypoint markers on map
- [ ] Entity tracking (mobs, other players)
- [ ] Health/hunger bars
- [ ] Compass/coordinates overlay
- [ ] Armor and offhand slots
- [ ] Chest/container viewing
- [ ] Redstone signal visualization
- [ ] Biome overlay
- [ ] Cave/underground view

---

## Contributing

Feel free to modify and extend this project! Some ideas:

- Add more block colors to `blockColors.js`
- Create item sprites instead of solid colors
- Add sound notifications for events
- Create mobile-optimized layouts
- Add dark/light theme toggle

---

## License

This project is provided as-is for educational and personal use.

Minecraft is a trademark of Mojang Studios / Microsoft.

---

## Credits

Built with:
- **Node.js** - Server runtime
- **WebSocket (ws)** - Real-time communication
- **Express** - HTTP server
- **Minecraft Bedrock Script API** - Inventory scanning

Created for the MineCA project.

---

## Support

If you encounter issues:

1. Check the Troubleshooting section above
2. Verify all setup steps were completed
3. Check server terminal and browser console for errors
4. Review Minecraft content log for behavior pack errors

---

**Enjoy your real-time Minecraft minimap!** 🗺️
