const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');

// Configuration
const WEB_PORT = 3000;
const MINECRAFT_HOST = 'localhost';
const MINECRAFT_PORT = 19132;

// Express app for serving web UI
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../web_ui')));

// Create HTTP server
const server = http.createServer(app);

// WebSocket server for web clients
const wss = new WebSocket.Server({ server });

// Store connected clients
let webClients = new Set();
let minecraftWs = null;
let playerName = '';
let requestId = 0;

// Terrain data cache
let terrainCache = new Map();
let lastPlayerLocation = { x: 0, y: 0, z: 0 };

// Connect to Minecraft Bedrock WebSocket
function connectToMinecraft() {
    console.log(`Connecting to Minecraft at ${MINECRAFT_HOST}:${MINECRAFT_PORT}...`);
    
    try {
        minecraftWs = new WebSocket(`ws://${MINECRAFT_HOST}:${MINECRAFT_PORT}`);
        
        minecraftWs.on('open', () => {
            console.log('Connected to Minecraft!');
            
            // Subscribe to events
            subscribeToEvents();
            
            // Start periodic player data requests
            setInterval(queryPlayerData, 2000); // Every 2 seconds
        });
        
        minecraftWs.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                handleMinecraftMessage(message);
            } catch (error) {
                console.error('Failed to parse Minecraft message:', error);
            }
        });
        
        minecraftWs.on('error', (error) => {
            console.error('Minecraft WebSocket error:', error);
        });
        
        minecraftWs.on('close', () => {
            console.log('Disconnected from Minecraft. Reconnecting in 5 seconds...');
            minecraftWs = null;
            setTimeout(connectToMinecraft, 5000);
        });
    } catch (error) {
        console.error('Failed to connect to Minecraft:', error);
        setTimeout(connectToMinecraft, 5000);
    }
}

// Subscribe to Minecraft events
function subscribeToEvents() {
    if (!minecraftWs || minecraftWs.readyState !== WebSocket.OPEN) return;
    
    // Subscribe to PlayerMessage event
    sendToMinecraft({
        header: {
            requestId: getRequestId(),
            messagePurpose: 'subscribe',
            version: 1
        },
        body: {
            eventName: 'PlayerMessage'
        }
    });
}

// Query player data
function queryPlayerData() {
    if (!minecraftWs || minecraftWs.readyState !== WebSocket.OPEN) return;
    
    // Get player location using querytarget
    sendToMinecraft({
        header: {
            requestId: getRequestId(),
            messagePurpose: 'commandRequest',
            version: 1
        },
        body: {
            commandLine: 'querytarget @s'
        }
    });
}

// Handle Minecraft messages
function handleMinecraftMessage(message) {
    const { header, body } = message;
    
    if (!body) return;
    
    // Handle command responses
    if (header && header.messagePurpose === 'commandResponse') {
        if (body.statusCode === 0 && body.statusMessage) {
            parseCommandResponse(body.statusMessage);
        }
    }
    
    // Handle events
    if (header && header.messagePurpose === 'event') {
        if (body.eventName === 'PlayerMessage') {
            broadcastToWebClients({
                type: 'chat',
                sender: body.properties?.Sender || 'Player',
                message: body.properties?.Message || ''
            });
        }
    }
}

// Parse command responses
function parseCommandResponse(message) {
    // Parse querytarget response
    // Format: "Player is at X, Y, Z"
    const queryMatch = message.match(/(.+?) is at (-?\d+\.?\d*), (-?\d+\.?\d*), (-?\d+\.?\d*)/);
    if (queryMatch) {
        playerName = queryMatch[1];
        lastPlayerLocation = {
            x: parseFloat(queryMatch[2]),
            y: parseFloat(queryMatch[3]),
            z: parseFloat(queryMatch[4])
        };
        
        // Broadcast player data to web clients
        broadcastToWebClients({
            type: 'playerData',
            name: playerName,
            location: lastPlayerLocation,
            rotation: { x: 0, y: 0 }, // Rotation not available from querytarget
            inventory: [] // Will be populated by behavior pack
        });
        
        return;
    }
    
    // Parse gettopsolidblock response
    // Format: "The top solid block at X, Y, Z is minecraft:block_type"
    const blockMatch = message.match(/top solid block at (-?\d+), (-?\d+), (-?\d+) is (.+)/);
    if (blockMatch) {
        const x = parseInt(blockMatch[1]);
        const y = parseInt(blockMatch[2]);
        const z = parseInt(blockMatch[3]);
        const blockType = blockMatch[4].replace('minecraft:', '');
        
        // Cache terrain data
        const key = `${x},${z}`;
        terrainCache.set(key, blockType);
        
        // Broadcast terrain update
        broadcastToWebClients({
            type: 'terrain',
            blocks: [{
                x: x,
                y: y,
                z: z,
                type: blockType
            }]
        });
        
        return;
    }
}

// Send message to Minecraft
function sendToMinecraft(data) {
    if (minecraftWs && minecraftWs.readyState === WebSocket.OPEN) {
        minecraftWs.send(JSON.stringify(data));
    }
}

// Broadcast to all web clients
function broadcastToWebClients(data) {
    const message = JSON.stringify(data);
    webClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Generate request ID
function getRequestId() {
    return `req_${++requestId}`;
}

// Handle web client connections
wss.on('connection', (ws) => {
    console.log('Web client connected');
    webClients.add(ws);
    
    // Send cached terrain data to new client
    const terrainBlocks = [];
    terrainCache.forEach((blockType, key) => {
        const [x, z] = key.split(',').map(Number);
        terrainBlocks.push({ x, z, type: blockType, y: 64 });
    });
    
    if (terrainBlocks.length > 0) {
        ws.send(JSON.stringify({
            type: 'terrain',
            blocks: terrainBlocks
        }));
    }
    
    // Send current player data
    if (playerName) {
        ws.send(JSON.stringify({
            type: 'playerData',
            name: playerName,
            location: lastPlayerLocation,
            rotation: { x: 0, y: 0 },
            inventory: []
        }));
    }
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleWebClientMessage(message, ws);
        } catch (error) {
            console.error('Failed to parse web client message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('Web client disconnected');
        webClients.delete(ws);
    });
});

// Handle web client messages
function handleWebClientMessage(message, ws) {
    const { type } = message;
    
    switch (type) {
        case 'chat':
            // Send chat message to Minecraft using tellraw with player name
            if (playerName) {
                const chatCommand = `tellraw @a {"rawtext":[{"text":"<${playerName}> ${message.message}"}]}`;
                sendToMinecraft({
                    header: {
                        requestId: getRequestId(),
                        messagePurpose: 'commandRequest',
                        version: 1
                    },
                    body: {
                        commandLine: chatCommand
                    }
                });
            } else {
                // Fallback to regular say command
                sendToMinecraft({
                    header: {
                        requestId: getRequestId(),
                        messagePurpose: 'commandRequest',
                        version: 1
                    },
                    body: {
                        commandLine: `say [External] ${message.message}`
                    }
                });
            }
            break;
            
        case 'requestScan':
            // Request terrain scan
            const zoomLevel = message.zoomLevel || 7;
            sendToMinecraft({
                header: {
                    requestId: getRequestId(),
                    messagePurpose: 'commandRequest',
                    version: 1
                },
                body: {
                    commandLine: `execute as @a run function scan/terrain_${zoomLevel}x${zoomLevel}`
                }
            });
            break;
    }
}

// HTTP endpoint for behavior pack to send data
app.post('/update', (req, res) => {
    const data = req.body;
    
    // Broadcast to web clients
    broadcastToWebClients(data);
    
    // Update cached data
    if (data.name) {
        playerName = data.name;
    }
    if (data.location) {
        lastPlayerLocation = data.location;
    }
    
    res.sendStatus(200);
});

// Start servers
server.listen(WEB_PORT, () => {
    console.log(`Web UI server running on http://localhost:${WEB_PORT}`);
    console.log('Open http://localhost:3000 in your browser');
});

// Connect to Minecraft
connectToMinecraft();

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    
    if (minecraftWs) {
        minecraftWs.close();
    }
    
    webClients.forEach(client => {
        client.close();
    });
    
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

console.log('MineCA Server starting...');
console.log('Make sure Minecraft Bedrock is running with WebSocket enabled!');
console.log('Enable WebSocket: /wsserver <port> or check server.properties');
