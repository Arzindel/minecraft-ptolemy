// MineCA Web UI Application

// State
let ws = null;
let currentTab = 'map';
let playerData = {
    name: '',
    location: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0 },
    inventory: []
};
let terrainData = new Map(); // Map<"x,z", blockType>
let chatMessages = [];

// Zoom levels
const ZOOM_LEVELS = [7, 11, 15, 21, 31, 41, 51, 71, 101];
let currentZoomIndex = 0;
let currentZoomLevel = ZOOM_LEVELS[currentZoomIndex];

// Canvas
let canvas = null;
let ctx = null;
const CELL_SIZE = 8; // pixels per block

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initUI();
    initCanvas();
    connectToServer();
    startUpdateLoop();
});

// Initialize UI event listeners
function initUI() {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });
    
    // Zoom controls
    document.getElementById('zoom-out').addEventListener('click', zoomOut);
    document.getElementById('zoom-in').addEventListener('click', zoomIn);
    
    // Chat
    document.getElementById('chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });
    
    // Initialize inventory grids
    initInventoryGrids();
}

// Switch tabs
function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    currentTab = tabName;
    
    // Redraw if switching to map
    if (tabName === 'map') {
        drawMinimap();
    }
}

// Initialize canvas
function initCanvas() {
    canvas = document.getElementById('minimap');
    ctx = canvas.getContext('2d');
    
    // Set canvas size based on zoom level
    updateCanvasSize();
}

// Update canvas size
function updateCanvasSize() {
    const size = currentZoomLevel * CELL_SIZE;
    canvas.width = size;
    canvas.height = size;
    drawMinimap();
}

// Zoom in
function zoomIn() {
    if (currentZoomIndex < ZOOM_LEVELS.length - 1) {
        currentZoomIndex++;
        currentZoomLevel = ZOOM_LEVELS[currentZoomIndex];
        updateZoomDisplay();
        updateCanvasSize();
    }
}

// Zoom out
function zoomOut() {
    if (currentZoomIndex > 0) {
        currentZoomIndex--;
        currentZoomLevel = ZOOM_LEVELS[currentZoomIndex];
        updateZoomDisplay();
        updateCanvasSize();
    }
}

// Update zoom display
function updateZoomDisplay() {
    document.getElementById('zoom-level').textContent = `${currentZoomLevel}x${currentZoomLevel}`;
}

// Draw minimap
function drawMinimap() {
    if (!ctx) return;
    
    // Clear canvas
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const radius = Math.floor(currentZoomLevel / 2);
    const centerX = Math.floor(playerData.location.x);
    const centerZ = Math.floor(playerData.location.z);
    
    // Draw terrain
    for (let z = -radius; z <= radius; z++) {
        for (let x = -radius; x <= radius; x++) {
            const worldX = centerX + x;
            const worldZ = centerZ + z;
            const key = `${worldX},${worldZ}`;
            
            const blockType = terrainData.get(key);
            if (blockType) {
                const color = getBlockColor(blockType);
                ctx.fillStyle = color;
                
                const canvasX = (x + radius) * CELL_SIZE;
                const canvasY = (z + radius) * CELL_SIZE;
                
                ctx.fillRect(canvasX, canvasY, CELL_SIZE, CELL_SIZE);
            }
        }
    }
    
    // Draw player marker (center)
    const playerX = radius * CELL_SIZE + CELL_SIZE / 2;
    const playerY = radius * CELL_SIZE + CELL_SIZE / 2;
    
    // Draw player as a red circle
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(playerX, playerY, CELL_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw player direction indicator
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playerX, playerY);
    
    // Calculate direction based on rotation (yaw)
    const angle = (playerData.rotation.y + 90) * Math.PI / 180;
    const dirLength = CELL_SIZE * 0.8;
    const dirX = playerX + Math.cos(angle) * dirLength;
    const dirY = playerY + Math.sin(angle) * dirLength;
    
    ctx.lineTo(dirX, dirY);
    ctx.stroke();
}

// Initialize inventory grids
function initInventoryGrids() {
    const mainInventory = document.getElementById('main-inventory');
    const hotbarInventory = document.getElementById('hotbar-inventory');
    
    // Create 27 slots for main inventory (slots 9-35)
    for (let i = 0; i < 27; i++) {
        const slot = createInventorySlot(i + 9);
        mainInventory.appendChild(slot);
    }
    
    // Create 9 slots for hotbar (slots 0-8)
    for (let i = 0; i < 9; i++) {
        const slot = createInventorySlot(i);
        hotbarInventory.appendChild(slot);
    }
}

// Create inventory slot element
function createInventorySlot(slotIndex) {
    const slot = document.createElement('div');
    slot.className = 'inventory-slot empty';
    slot.dataset.slot = slotIndex;
    
    const icon = document.createElement('div');
    icon.className = 'slot-icon';
    slot.appendChild(icon);
    
    const amount = document.createElement('div');
    amount.className = 'slot-amount';
    slot.appendChild(amount);
    
    return slot;
}

// Update inventory display
function updateInventory() {
    if (!playerData.inventory) return;
    
    // Clear all slots first
    document.querySelectorAll('.inventory-slot').forEach(slot => {
        slot.classList.add('empty');
        slot.querySelector('.slot-icon').style.backgroundColor = '';
        slot.querySelector('.slot-amount').textContent = '';
        slot.title = '';
    });
    
    // Update slots with items
    playerData.inventory.forEach((item, index) => {
        if (item) {
            const slot = document.querySelector(`.inventory-slot[data-slot="${index}"]`);
            if (slot) {
                slot.classList.remove('empty');
                
                const color = getItemColor(item.type);
                slot.querySelector('.slot-icon').style.backgroundColor = color;
                
                if (item.amount > 1) {
                    slot.querySelector('.slot-amount').textContent = item.amount;
                }
                
                const itemName = item.name || item.type.replace(/_/g, ' ');
                slot.title = `${itemName} x${item.amount}`;
            }
        }
    });
}

// Add chat message
function addChatMessage(sender, message, type = 'player') {
    const messagesDiv = document.getElementById('chat-messages');
    
    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${type}`;
    
    const timestamp = new Date().toLocaleTimeString();
    
    messageEl.innerHTML = `
        <span class="chat-sender">${sender}:</span>
        <span class="chat-text">${escapeHtml(message)}</span>
        <span class="chat-timestamp">${timestamp}</span>
    `;
    
    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    chatMessages.push({ sender, message, timestamp, type });
}

// Send chat message
function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message) return;
    
    // Send to server
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'chat',
            message: message
        }));
        
        // Clear input
        input.value = '';
        
        // Add to local chat immediately
        addChatMessage('You', message, 'player');
    } else {
        addChatMessage('System', 'Not connected to server', 'system');
    }
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Connect to WebSocket server
function connectToServer() {
    const serverUrl = 'ws://localhost:3000';
    
    try {
        ws = new WebSocket(serverUrl);
        
        ws.onopen = () => {
            console.log('Connected to server');
            updateConnectionStatus(true);
            addChatMessage('System', 'Connected to Minecraft', 'system');
        };
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleServerMessage(data);
            } catch (error) {
                console.error('Failed to parse message:', error);
            }
        };
        
        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            updateConnectionStatus(false);
        };
        
        ws.onclose = () => {
            console.log('Disconnected from server');
            updateConnectionStatus(false);
            addChatMessage('System', 'Disconnected from server. Reconnecting...', 'system');
            
            // Attempt to reconnect after 3 seconds
            setTimeout(connectToServer, 3000);
        };
    } catch (error) {
        console.error('Failed to connect:', error);
        updateConnectionStatus(false);
        
        // Attempt to reconnect
        setTimeout(connectToServer, 3000);
    }
}

// Handle server messages
function handleServerMessage(data) {
    switch (data.type) {
        case 'playerData':
            playerData = data;
            updatePlayerDisplay();
            updateInventory();
            break;
            
        case 'terrain':
            // Update terrain data
            if (data.blocks) {
                data.blocks.forEach(block => {
                    const key = `${block.x},${block.z}`;
                    terrainData.set(key, block.type);
                });
                
                // Redraw map if on map tab
                if (currentTab === 'map') {
                    drawMinimap();
                }
            }
            break;
            
        case 'chat':
            addChatMessage(data.sender, data.message, 'player');
            break;
            
        case 'zoom':
            // Update zoom level from server
            const zoomIndex = ZOOM_LEVELS.indexOf(data.zoomLevel);
            if (zoomIndex !== -1) {
                currentZoomIndex = zoomIndex;
                currentZoomLevel = ZOOM_LEVELS[currentZoomIndex];
                updateZoomDisplay();
                updateCanvasSize();
            }
            break;
    }
}

// Update player display
function updatePlayerDisplay() {
    const coordsEl = document.getElementById('player-coords');
    coordsEl.textContent = `${playerData.name} | X: ${playerData.location.x.toFixed(1)} Y: ${playerData.location.y.toFixed(1)} Z: ${playerData.location.z.toFixed(1)}`;
}

// Update connection status
function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    statusEl.className = connected ? 'status-connected' : 'status-disconnected';
}

// Start update loop
function startUpdateLoop() {
    setInterval(() => {
        // Redraw minimap if on map tab
        if (currentTab === 'map') {
            drawMinimap();
        }
    }, 100); // 10 FPS
}
