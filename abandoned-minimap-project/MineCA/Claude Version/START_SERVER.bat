@echo off
echo Starting MineCA Server...
echo.

cd server

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting server...
echo.
echo Web UI will be available at: http://localhost:3000
echo Make sure Minecraft is running with WebSocket enabled: /wsserver 19132
echo.
echo Press Ctrl+C to stop the server
echo.

call npm start

pause
