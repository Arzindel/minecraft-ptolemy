# Minecraft Bedrock Websocket API Documentation

## Overview

The Minecraft Bedrock Edition Websocket API allows external applications to interact with Minecraft Bedrock Edition through a WebSocket connection. This enables real-time communication for sending commands, subscribing to events, and receiving game data.

## Connection Setup

### Prerequisites
- Minecraft Bedrock Edition with cheats enabled
- Disable encrypted websockets: `Settings` → `General` → `Require Encrypted Websockets` (set to OFF)

### Connection Command
From within Minecraft, connect to your WebSocket server:
```
/connect ws://localhost:8080/ws/someid
```

## Message Structure

All WebSocket messages follow a consistent JSON format with `header` and `body` sections.

### Common Header Fields
```json
{
  "header": {
    "requestId": "xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxxxxxxx", // UUID
    "messagePurpose": "purpose_type",
    "version": 1,
    "messageType": "message_type" // Optional for some message types
  },
  "body": {
    // Message-specific data
  }
}
```

## Message Types

### 1. Command Request
Send Minecraft commands to the game.

**Request:**
```json
{
  "body": {
    "commandLine": "say Hello World"
  },
  "header": {
    "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "messagePurpose": "commandRequest",
    "version": 1,
    "messageType": "commandRequest"
  }
}
```

**Response:**
```json
{
  "body": {
    "statusCode": 0, // 0 = success, negative = error
    "statusMessage": "response message",
    "data": {} // Command-specific response data
  },
  "header": {
    "messagePurpose": "commandResponse",
    "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "version": 1
  }
}
```

### 2. Event Subscription
Subscribe to receive specific game events.

**Subscribe:**
```json
{
  "body": {
    "eventName": "PlayerMessage"
  },
  "header": {
    "requestId": "xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxxxxxxx",
    "messagePurpose": "subscribe",
    "version": 1,
    "messageType": "commandRequest"
  }
}
```

**Unsubscribe:**
```json
{
  "body": {
    "eventName": "PlayerMessage"
  },
  "header": {
    "requestId": "xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxxxxxxx",
    "messagePurpose": "unsubscribe",
    "version": 1,
    "messageType": "commandRequest"
  }
}
```

**Event Notification:**
```json
{
  "body": {
    "eventName": "PlayerMessage",
    "measurements": null,
    "properties": {
      "player": {
        "name": "PlayerName"
      },
      "message": "Hello World"
    }
  },
  "header": {
    "messagePurpose": "event",
    "requestId": "00000000-0000-0000-0000-000000000000", // Always zeros
    "version": 1
  }
}
```

### 3. Error Response
```json
{
  "body": {
    "statusMessage": "Error description",
    "statusCode": -2147483647 // Error type code
  },
  "header": {
    "messagePurpose": "error",
    "requestId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "version": 1
  }
}
```

## Available Events

### Player Events
- `PlayerJoin` - Player joins the game
- `PlayerLeave` - Player leaves the game
- `PlayerMessage` - Player sends chat message
- `PlayerDied` - Player dies
- `PlayerTeleported` - Player teleports
- `PlayerTravelled` - Player changes biome/location
- `PlayerTransform` - Player position/orientation changes

### World Events
- `BlockPlaced` - Block placed in world
- `BlockBroken` - Block broken/destroyed
- `WorldLoaded` - World loads
- `WorldUnloaded` - World unloads
- `ChunkChanged` - Chunk data changes
- `ChunkLoaded` - Chunk loads
- `ChunkUnloaded` - Chunk unloads

### Game Events
- `GameSessionStart` - Game session begins
- `GameSessionComplete` - Game session ends
- `MultiplayerRoundStart` - Multiplayer round starts
- `MultiplayerRoundEnd` - Multiplayer round ends
- `AwardAchievement` - Player earns achievement

### Item Events
- `ItemAcquired` - Player obtains item
- `ItemUsed` - Player uses item
- `ItemCrafted` - Player crafts item
- `ItemSmelted` - Player smelts item
- `ItemEnchanted` - Player enchants item
- `ItemDestroyed` - Item destroyed

### Mob Events
- `MobKilled` - Mob killed
- `MobInteracted` - Player interacts with mob
- `BossKilled` - Boss mob defeated
- `EntitySpawned` - Entity spawns in world

### Technical Events
- `ApiInit` - API initialization
- `AppPaused` - Application paused
- `AppResumed` - Application resumed
- `AppSuspended` - Application suspended
- `ConfigurationChanged` - Game configuration changes

## Available Commands

### Player Management
- `/list` - List online players
- `/querytarget @a` - Get detailed player information including coordinates
- `/testfor @s` - Test for specific player
- `/tp @s x y z` - Teleport player
- `/give @p item_name quantity` - Give items to player

### World Information
- `/time query daytime` - Get current game time
- `/seed` - Get world seed
- `/list` - Get player count information
- `/locate structure_name` - Locate structures

### Game State
- `/gamerule rule_name value` - Set game rules
- `/difficulty difficulty_level` - Set difficulty
- `/weather weather_type` - Set weather
- `/time set value` - Set game time

### Hidden/Advanced Commands
- `/getlocalplayername` - Get local player name
- `/gettopsolidblock x y z` - Get top solid block position
- `/getchunkdata` - Get chunk pixel data
- `/getchunks` - Get loaded chunks list
- `/querytarget` - Get entity transform and ID information

## Response Data Formats

### Player Information (querytarget)
```json
{
  "details": "[{\"id\":\"player_id\",\"name\":\"PlayerName\",\"position\":{\"x\":0,\"y\":64,\"z\":0}}]"
}
```

### Time Information
```json
{
  "data": 6000,
  "statusMessage": "Daytime is 6000"
}
```

### Seed Information
```json
{
  "statusMessage": "Seed: [123456789]"
}
```

### Player List Information
```json
{
  "currentPlayerCount": 1,
  "maxPlayerCount": 20,
  "players": ["PlayerName"]
}
```

## Implementation Notes

### Permission Levels
- The WebSocket connection inherits the permissions of the connected player
- Commands requiring operator status will fail if player is not an operator
- Some commands are "cheat only" and require cheats to be enabled

### Connection Behavior
- Each WebSocket connection is tied to a specific player
- Events and command responses are specific to that player's perspective
- Multiple WebSocket connections can exist simultaneously

### Error Handling
- Always check `statusCode` in responses (0 = success)
- Error responses include descriptive `statusMessage`
- Some commands may return partial success with warnings

## Example Usage Patterns

### Real-time Player Tracking
```javascript
// Subscribe to player movement events
subscribeToEvent('PlayerTransform');
subscribeToEvent('PlayerTravelled');

// Query player positions periodically
setInterval(() => {
  sendCommand('querytarget @a');
}, 1000);
```

### Chat Integration
```javascript
// Subscribe to chat messages
subscribeToEvent('PlayerMessage');

// Send chat messages
sendCommand('tellraw @a {"text":"Hello from WebSocket","color":"green"}');
```

### World Monitoring
```javascript
// Monitor world changes
subscribeToEvent('BlockPlaced');
subscribeToEvent('BlockBroken');
subscribeToEvent('EntitySpawned');

// Get world information
sendCommand('time query daytime');
sendCommand('seed');
```

## Security Considerations

- Disable encrypted WebSockets for development
- WebSocket connections share player permissions
- Avoid exposing WebSocket endpoints to untrusted networks
- Validate and sanitize all incoming commands

## Troubleshooting

### Common Issues
- **Connection refused**: Ensure WebSocket server is running on correct port
- **Permission denied**: Player must have appropriate permissions/cheats enabled
- **Event not firing**: Some events may be version-specific or have specific triggers
- **Command not working**: Verify command syntax and player permissions

### Debugging Tips
- Log all incoming and outgoing messages
- Check Minecraft console for error messages
- Verify WebSocket connection is established
- Test with simple commands first (e.g., `/say hello`)

## Resources

- [Minecraft Commands Wiki](https://minecraft.fandom.com/wiki/Commands)
- [WebSocket Event List](https://gist.github.com/jocopa3/5f718f4198f1ea91a37e3a9da468675c)
- [Message Format Reference](https://gist.github.com/jocopa3/54b42fb6361952997c4a6e38945e306f)

---

*This documentation covers Minecraft Bedrock Edition WebSocket API as of version 1.20+. Features may vary between versions.*