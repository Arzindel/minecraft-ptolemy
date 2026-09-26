# Quick Start Guide

Get up and running in 5 minutes!

## Step 1: Enable WebSocket in Minecraft (30 seconds)

1. Open Minecraft Bedrock Edition
2. Load your world (with cheats enabled)
3. Press `/` and type:
   ```
   /wsserver 19132
   ```
4. You should see: "WebSocket server started"

## Step 2: Install Behavior Pack (2 minutes)

### Windows:
1. Copy the `behavior_pack` folder
2. Paste into: `%localappdata%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs\`
3. Rename it to `mineca_bp`
4. In Minecraft: Settings → Game → Add-Ons
5. Add "MineCA Minimap" to Active Packs
6. Restart world

### Quick Copy Command (Windows PowerShell):
```powershell
Copy-Item "behavior_pack" -Destination "$env:LOCALAPPDATA\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs\mineca_bp" -Recurse
```

## Step 3: Start Server (1 minute)

```bash
cd "Claude Version/server"
npm install
npm start
```

Wait for: "Connected to Minecraft!"

## Step 4: Open Web UI (10 seconds)

Open browser to: **http://localhost:3000**

## Done!

You should see:
- ✅ Green status indicator
- ✅ Your coordinates in header
- ✅ Map updating as you move

---

## Quick Test

1. **Map Tab**: Walk around, watch terrain appear
2. **Inv Tab**: Pick up an item, see it appear
3. **Chat Tab**: Type "Hello from Web UI" and send

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't connect | Run `/wsserver 19132` in Minecraft |
| No terrain | Run `/function scan/terrain_7x7` manually |
| No inventory | Check behavior pack is active in world settings |
| Chat not working | Verify server shows "Connected to Minecraft!" |

---

## Mobile Access

1. Find your PC's IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. On phone/tablet (same WiFi): `http://<pc-ip>:3000`
3. Use landscape mode for best experience

---

**Need more help?** See full README.md for detailed instructions.
