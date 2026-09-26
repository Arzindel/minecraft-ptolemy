# 🚀 START HERE - MineCA Project

Welcome! This is a **complete Minecraft Bedrock minimap system** with a web UI.

---

## ⚡ Quick Start (5 minutes)

### Step 1: Enable WebSocket
In Minecraft, run:
```
/wsserver 19132
```

### Step 2: Install Behavior Pack
**Windows**: Double-click `INSTALL_BEHAVIOR_PACK.bat`

**Manual**: Copy `behavior_pack/` to:
```
%localappdata%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs\mineca_bp
```

Then activate it in World Settings → Add-Ons

### Step 3: Start Server
Double-click `START_SERVER.bat`

Or manually:
```bash
cd server
npm install
npm start
```

### Step 4: Open Web UI
Visit: **http://localhost:3000**

---

## 📚 Documentation Guide

**New users? Start here:**
1. 👉 **[QUICKSTART.md](QUICKSTART.md)** - Get running in 5 minutes
2. 📖 **[README.md](README.md)** - Complete user guide
3. ✅ **[CHECK_SETUP.bat](CHECK_SETUP.bat)** - Verify your installation

**Developers? Go here:**
1. 🏗️ **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design
2. 💻 **[DEVELOPMENT.md](DEVELOPMENT.md)** - Developer guide  
3. 📦 **[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)** - Feature overview

**Want details?**
1. ✅ **[COMPLETE.md](COMPLETE.md)** - What was built

---

## 🎯 What This Does

### Map Tab
Real-time minimap showing terrain around you:
- 7 zoom levels (7x7 to 101x101 blocks)
- Your position and direction
- Color-coded block types
- Zoom with + and - buttons

### Inv Tab  
Live inventory display:
- All 36 inventory slots
- 9-slot hotbar
- Stack counts
- Item names

### Chat Tab
Send and receive messages:
- View in-game chat
- Send from web UI
- Proper player names
- Timestamps

---

## 📱 Perfect For

- 📱 Phone/tablet as second screen (landscape mode)
- 🎮 Steam Deck companion
- 🖥️ Desktop while playing
- 📺 Streaming overlays
- 🛠️ Building/mining assistance

---

## 🗂️ Project Structure

```
Claude Version/
├── 📄 START_HERE.md           ← You are here
├── 📄 QUICKSTART.md            Quick setup
├── 📄 README.md                Full documentation
├── 📄 DEVELOPMENT.md           Developer guide
├── 📄 ARCHITECTURE.md          Technical design
├── 📄 PROJECT_OVERVIEW.md      Features & specs
├── 📄 COMPLETE.md              What was built
│
├── 🎮 behavior_pack/           Minecraft add-on
│   ├── manifest.json          Pack config
│   ├── functions/scan/        Terrain scanners (9 sizes)
│   └── scripts/main.js        Inventory scanner
│
├── 🖥️ server/                  Node.js bridge
│   ├── package.json           Dependencies
│   └── server.js              WebSocket bridge
│
├── 🌐 web_ui/                  Web interface
│   ├── index.html             UI structure
│   ├── style.css              Styling
│   ├── app.js                 Logic
│   └── blockColors.js         Block colors (150+)
│
└── 🔧 Helper Scripts
    ├── INSTALL_BEHAVIOR_PACK.bat
    ├── START_SERVER.bat
    └── CHECK_SETUP.bat
```

---

## ❓ Troubleshooting

### Can't connect?
- Run `/wsserver 19132` in Minecraft
- Check firewall allows Node.js
- See README.md troubleshooting section

### No terrain showing?
- Verify behavior pack is active
- Try manual: `/function scan/terrain_7x7`
- Check loaded chunks

### Inventory not updating?
- Confirm pack scripts are running
- Check content log for errors
- Run `CHECK_SETUP.bat`

**More help**: See [README.md](README.md) → Troubleshooting

---

## 🎨 Features

✅ Real-time minimap with 7 zoom levels  
✅ Live inventory display (36 slots)  
✅ Integrated chat system  
✅ Mobile-optimized UI  
✅ 150+ block colors  
✅ Auto-reconnection  
✅ Connection status  
✅ Player coordinates  
✅ Direction indicator  

---

## 🔧 System Requirements

**Minecraft**: Bedrock Edition (Windows 10/11) with cheats  
**Server**: Node.js v16+ (100 MB RAM)  
**Client**: Modern browser (Chrome, Firefox, Safari, Edge)  
**Network**: Local or same WiFi for mobile  

---

## 🚀 What to Do Next

### First Time Setup
1. ✅ Run `CHECK_SETUP.bat` to verify installation
2. ✅ Follow QUICKSTART.md step-by-step
3. ✅ Test all three tabs (Map, Inv, Chat)
4. ✅ Try different zoom levels

### Customize
- Edit `blockColors.js` for custom colors
- Adjust scan frequency in behavior pack
- Change ports in server.js
- Modify UI styling in style.css

### Extend
- Add waypoint markers
- Display armor slots
- Track nearby entities
- Add health/hunger bars
- See DEVELOPMENT.md for ideas

---

## 📖 Documentation Index

| File | Purpose | For |
|------|---------|-----|
| START_HERE.md | This file | Everyone |
| QUICKSTART.md | 5-min setup | New users |
| README.md | Complete guide | Users |
| DEVELOPMENT.md | Dev guide | Developers |
| ARCHITECTURE.md | System design | Developers |
| PROJECT_OVERVIEW.md | Features | Everyone |
| COMPLETE.md | Build summary | Curious |

---

## 💡 Tips

**Performance**:
- Use 7x7 or 11x11 for best performance
- 101x101 may lag briefly (10,000+ commands)
- Adjust scan interval if needed

**Mobile**:
- Use landscape orientation
- Connect to same WiFi
- Find PC IP: `ipconfig` (Windows)
- Access: `http://<pc-ip>:3000`

**Streaming**:
- Open in OBS browser source
- Set to 1280x720 landscape
- Position as overlay

---

## 🏆 You're All Set!

This project is **100% complete** and ready to use.

Start with **[QUICKSTART.md](QUICKSTART.md)** and you'll be up and running in 5 minutes!

---

## 📞 Need Help?

1. Check [README.md](README.md) Troubleshooting section
2. Run `CHECK_SETUP.bat` to diagnose issues
3. Review console/logs for errors
4. See [DEVELOPMENT.md](DEVELOPMENT.md) for debugging

---

**Happy mapping!** 🗺️

*Built for the MineCA Project*
