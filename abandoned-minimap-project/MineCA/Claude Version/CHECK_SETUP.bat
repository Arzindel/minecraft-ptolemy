@echo off
echo MineCA Setup Checker
echo ====================
echo.

set "PASS=✓"
set "FAIL=✗"

echo Checking setup...
echo.

:: Check Node.js
echo [1/5] Checking Node.js...
node --version >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo %PASS% Node.js is installed
    node --version
) else (
    echo %FAIL% Node.js is NOT installed
    echo      Download from: https://nodejs.org/
)
echo.

:: Check behavior pack folder
echo [2/5] Checking behavior pack...
if exist "behavior_pack\manifest.json" (
    echo %PASS% Behavior pack folder found
) else (
    echo %FAIL% Behavior pack folder missing or incomplete
)
echo.

:: Check if behavior pack is installed
echo [3/5] Checking behavior pack installation...
set "BP_PATH=%localappdata%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs\mineca_bp"
if exist "%BP_PATH%\manifest.json" (
    echo %PASS% Behavior pack is installed in Minecraft
) else (
    echo %FAIL% Behavior pack NOT installed in Minecraft
    echo      Run INSTALL_BEHAVIOR_PACK.bat to install
)
echo.

:: Check server folder
echo [4/5] Checking server files...
if exist "server\server.js" (
    echo %PASS% Server files found
) else (
    echo %FAIL% Server files missing
)
echo.

:: Check web UI files
echo [5/5] Checking web UI files...
if exist "web_ui\index.html" (
    echo %PASS% Web UI files found
) else (
    echo %FAIL% Web UI files missing
)
echo.

echo ====================
echo.
echo Next steps:
echo 1. Run INSTALL_BEHAVIOR_PACK.bat (if not installed)
echo 2. Enable WebSocket in Minecraft: /wsserver 19132
echo 3. Run START_SERVER.bat
echo 4. Open http://localhost:3000 in your browser
echo.

pause
