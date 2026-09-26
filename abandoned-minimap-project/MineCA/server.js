const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

// Create Express app
const app = express();
const server = http.createServer(app);

// Create WebSocket server for web UI connections on port 3000
const webUIWss = new WebSocket.Server({ noServer: true });

// Upgrade HTTP connections to WebSocket for web UI
server.on('upgrade', (request, socket, head) => {
    webUIWss.handleUpgrade(request, socket, head, (ws) => {
        webUIWss.emit('connection', ws, request);
    });
});

// Handle web UI WebSocket connections
webUIWss.on('connection', (ws, req) => {
    console.log('[WEB UI] Connected\n');
    
    // Handle messages from web UI
     ws.on('message', (data) => {
         try {
             const message = JSON.parse(data.toString());
             
             // Handle chat message requests
             if (message.type === 'chat' && message.text) {
                 wss.clients.forEach((client) => {
                     if (client.readyState === WebSocket.OPEN) {
                         sendCommand(client, `tellraw @a {\"text\":\"${message.text}\",\"color\":\"white\"}`);
                     }
                 });
             }
             
             // Handle command requests
             if (message.type === 'command' && message.text) {
                 wss.clients.forEach((client) => {
                     if (client.readyState === WebSocket.OPEN) {
                         sendCommand(client, message.text);
                     }
                 });
             }
         } catch (error) {
             console.log('[ERROR]', error.message);
         }
     });
    
    ws.on('close', () => {
        console.log('[WEB UI] Disconnected\n');
    });
});

// Serve static files
app.use(express.static('public'));

// Create WebSocket server on port 8080 for Minecraft
const wss = new WebSocket.Server({ port: 8080 });

console.log('Minecraft WebSocket Server Starting...');
console.log('WebSocket: ws://localhost:8080');
console.log('Web UI: http://localhost:3000\n');

// Helper function to generate UUID
function generateUUID() {
    return crypto.randomUUID();
}

// Helper function to subscribe to an event
function subscribeToEvent(ws, eventName) {
    const subscribeMessage = {
        body: {
            eventName: eventName
        },
        header: {
            requestId: generateUUID(),
            messagePurpose: "subscribe",
            version: 1,
            messageType: "commandRequest"
        }
    };
    
    ws.send(JSON.stringify(subscribeMessage));
}

// Helper function to send a command
function sendCommand(ws, command) {
    const commandMessage = {
        body: {
            commandLine: command
        },
        header: {
            requestId: generateUUID(),
            messagePurpose: "commandRequest",
            version: 1,
            messageType: "commandRequest"
        }
    };
    
    ws.send(JSON.stringify(commandMessage));
}

// WebSocket connection handler for Minecraft
wss.on('connection', (ws, req) => {
    console.log('[MINECRAFT] Connected\n');
    
    // Track active player for this connection
    ws.activePlayer = null;
    
    // Get the active player name and seed
    setTimeout(() => {
        sendCommand(ws, 'testfor @s');
        sendCommand(ws, 'seed'); // Get world seed
        subscribeToEvent(ws, 'PlayerTravelled'); // For biome detection
    }, 100);
    
    // Periodic data requests for player position and time
    const timeInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            sendCommand(ws, 'time query daytime');
            sendCommand(ws, 'querytarget @a'); // Get all players
            sendCommand(ws, 'list');
        }
    }, 1000);
    
    // Handle incoming messages
    ws.on('message', (data) => {
        try {
            const jsonData = JSON.parse(data.toString('utf8'));
            
            // Only log command responses, skip events
            if (jsonData.header?.messagePurpose === 'commandResponse') {
                console.log(JSON.stringify(jsonData, null, 2));
            }
            
            // Handle PlayerTravelled event for biome detection
            if (jsonData.header?.messagePurpose === 'event' && jsonData.body?.player?.name === ws.activePlayer) {
                if (jsonData.body.newBiome !== undefined) {
                    webUIWss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'biome',
                                value: jsonData.body.newBiome
                            }));
                        }
                    });
                }
            }
            
            // Check if this is a successful command response
            if (jsonData.body && jsonData.body.statusCode === 0) {
                let messageToSend = null;
                
                // Check for testfor response (active player detection)
                if (jsonData.body.statusMessage?.includes('Found')) {
                    const playerMatch = jsonData.body.statusMessage.match(/Found ([A-Za-z0-9_]+)/);
                    if (playerMatch) {
                        ws.activePlayer = playerMatch[1];
                        console.log(`[ACTIVE PLAYER] ${ws.activePlayer}\n`);
                    }
                }
                // Check for seed response
                else if (jsonData.body.statusMessage?.includes('Seed:')) {
                    const seedMatch = jsonData.body.statusMessage.match(/Seed: \[(-?\d+)\]/);
                    if (seedMatch) {
                        const seed = seedMatch[1];
                        console.log(`[SEED] ${seed}\n`);
                        messageToSend = {
                            type: 'seed',
                            value: seed
                        };
                    }
                }
                // Check for time response
                else if (jsonData.body.data !== undefined && jsonData.body.statusMessage?.includes('Daytime is')) {
                    messageToSend = {
                        type: 'daytime',
                        value: jsonData.body.data
                    };
                }
                // Check for querytarget response (coordinates for all players)
                else if (jsonData.body.details) {
                    // querytarget returns player details including position as JSON string
                    try {
                        const details = JSON.parse(jsonData.body.details);
                        if (Array.isArray(details) && details.length > 0) {
                            // Build object with all player positions
                            const allPlayerPositions = {};
                            let selfPosition = null;
                            
                            details.forEach(player => {
                                if (player.position) {
                                    const pos = {
                                        x: player.position.x,
                                        y: player.position.y,
                                        z: player.position.z
                                    };
                                    
                                    // Store in map
                                    const playerId = player.id;
                                    allPlayerPositions[playerId] = pos;
                                    
                                    // Check if this is the self player
                                    if (player.id === details[0].id && ws.activePlayer) {
                                        selfPosition = pos;
                                    }
                                }
                            });
                            
                            messageToSend = {
                                type: 'coordinates',
                                value: {
                                    self: selfPosition || details[0].position,
                                    all: allPlayerPositions,
                                    activePlayer: ws.activePlayer
                                }
                            };
                        }
                    } catch (e) {
                        console.log('[ERROR] Parsing querytarget details:', e.message);
                    }
                }

                // Check for player list response
                else if (jsonData.body.players !== undefined) {
                    messageToSend = {
                        type: 'playerList',
                        value: {
                            active: ws.activePlayer,
                            count: jsonData.body.currentPlayerCount,
                            max: jsonData.body.maxPlayerCount,
                            players: jsonData.body.players
                        }
                    };
                }
                
                // Send to web UI
                if (messageToSend) {
                    webUIWss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(messageToSend));
                        }
                    });
                }
            }
        } catch (error) {
            console.log('[ERROR]', error.message);
        }
    });
    
    // Handle errors
    ws.on('error', (error) => {
        console.log('[ERROR]', error.message);
    });
    
     // Handle disconnection
     ws.on('close', () => {
         clearInterval(timeInterval);
         console.log('[MINECRAFT] Disconnected\n');
     });
});

// Start Express server on port 3000
server.listen(3000, () => {
    console.log('[WEB SERVER] Running on http://localhost:3000\n');
});
