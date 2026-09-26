# Command Testing Setup

## Changes Made

### 1. Disabled Periodic Pings
- Commented out the automatic data requests that were running every second
- No more automatic `/time query daytime`, `/querytarget @a`, `/list` commands

### 2. Added Command Testing Interface
- Added a text input field and "Send Command" button to the UI
- Implemented JavaScript function to send commands to the WebSocket
- Added Enter key support for quick command sending

### 3. Updated Server Logic
- Added handling for `command` message type in the WebSocket server
- Commands sent from the UI are now forwarded to Minecraft

## How to Use

1. **Start the server**: `npm start`
2. **Open the web UI**: http://localhost:3000
3. **Connect Minecraft**: In Minecraft, run `/connect ws://localhost:8080`
4. **Test commands**: Type commands in the text box and click "Send Command" or press Enter

## Example Commands to Test

```
/gettopsolidblock 0 64 0
/time query daytime
/querytarget @a
/list
/seed
```

## Benefits

- **Simplified testing**: No more automatic pings interfering with command responses
- **Real-time debugging**: See command responses immediately in the server console
- **Flexible experimentation**: Test any Minecraft command without modifying code
- **Better troubleshooting**: Isolate specific commands and their responses

## Server Console Output

All command responses will be logged to the server console in JSON format, making it easy to:
- See the exact response structure
- Debug command failures
- Understand what data is available
- Test new commands quickly

## Next Steps

Use this setup to experiment with the terrain mapping commands:
- `/gettopsolidblock` - Test surface elevation detection
- `/getchunkdata` - Explore chunk visualization data
- `/getchunks` - Identify loaded chunk boundaries