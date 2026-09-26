import { world, system } from "@minecraft/server";
import { HttpRequest, HttpRequestMethod, http } from "@minecraft/server-net";

// Configuration
const HTTP_SERVER = "http://localhost:3000";
const SCAN_INTERVAL = 40; // ticks (2 seconds)

// State
let scanTick = 0;
let currentZoomLevel = 7; // Default 7x7

// Inventory scanning
function scanInventory(player) {
    const inventory = player.getComponent("minecraft:inventory");
    if (!inventory || !inventory.container) {
        return null;
    }
    
    const container = inventory.container;
    const slots = [];
    
    // Scan all 36 slots (0-8: hotbar, 9-35: main inventory)
    for (let i = 0; i < 36; i++) {
        const item = container.getItem(i);
        if (item) {
            slots.push({
                slot: i,
                type: item.typeId.replace('minecraft:', ''),
                amount: item.amount,
                name: item.nameTag || null
            });
        } else {
            slots.push(null);
        }
    }
    
    return slots;
}

// Get player data
function getPlayerData(player) {
    const location = player.location;
    const rotation = player.getRotation();
    const inventory = scanInventory(player);
    
    return {
        name: player.name,
        location: {
            x: Math.floor(location.x * 100) / 100,
            y: Math.floor(location.y * 100) / 100,
            z: Math.floor(location.z * 100) / 100
        },
        rotation: {
            x: Math.floor(rotation.x * 100) / 100,
            y: Math.floor(rotation.y * 100) / 100
        },
        inventory: inventory
    };
}

// Send data to web server
function sendToWebUI(data) {
    try {
        const request = new HttpRequest(`${HTTP_SERVER}/update`);
        request.method = HttpRequestMethod.Post;
        request.body = JSON.stringify(data);
        request.headers = [
            { key: "Content-Type", value: "application/json" }
        ];
        
        http.request(request).catch(error => {
            // Silently fail if web server is not available
            // console.warn("Failed to send to web UI:", error);
        });
    } catch (error) {
        // Silently fail
    }
}

// Main loop
system.runInterval(() => {
    scanTick++;
    
    // Scan every SCAN_INTERVAL ticks
    if (scanTick % SCAN_INTERVAL === 0) {
        const players = world.getAllPlayers();
        
        for (const player of players) {
            // Get player data
            const playerData = getPlayerData(player);
            
            // Trigger terrain scan based on current zoom level
            try {
                player.runCommand(`function scan/terrain_${currentZoomLevel}x${currentZoomLevel}`);
            } catch (error) {
                // Fallback to 7x7 if specific size not found
                player.runCommand("function scan/terrain_7x7");
            }
            
            // Send player data to web UI
            sendToWebUI(playerData);
        }
    }
}, 1);

// Listen for chat commands to change zoom level
world.beforeEvents.chatSend.subscribe((event) => {
    const message = event.message;
    
    // Command: !zoom <size>
    if (message.startsWith("!zoom ")) {
        const size = parseInt(message.substring(6));
        const validSizes = [7, 11, 15, 21, 31, 41, 51, 71, 101];
        
        if (validSizes.includes(size)) {
            currentZoomLevel = size;
            event.sender.sendMessage(`§aZoom level set to ${size}x${size}`);
            
            // Send zoom update to web UI
            sendToWebUI({
                type: "zoom",
                zoomLevel: size
            });
        } else {
            event.sender.sendMessage(`§cInvalid zoom level. Valid: ${validSizes.join(", ")}`);
        }
        
        event.cancel = true;
    }
});

// Subscribe to chat messages to forward to web UI
world.afterEvents.chatSend.subscribe((event) => {
    sendToWebUI({
        type: "chat",
        sender: event.sender.name,
        message: event.message
    });
});

console.warn("MineCA Minimap behavior pack loaded!");
