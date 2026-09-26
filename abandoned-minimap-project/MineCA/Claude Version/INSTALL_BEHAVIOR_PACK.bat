@echo off
echo Installing MineCA Behavior Pack...
echo.

set "SOURCE=%~dp0behavior_pack"
set "DEST=%localappdata%\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\behavior_packs\mineca_bp"

echo Source: %SOURCE%
echo Destination: %DEST%
echo.

if not exist "%SOURCE%" (
    echo ERROR: behavior_pack folder not found!
    echo Make sure you're running this from the Claude Version folder.
    pause
    exit /b 1
)

echo Copying behavior pack...
xcopy /E /I /Y "%SOURCE%" "%DEST%"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS! Behavior pack installed.
    echo.
    echo Next steps:
    echo 1. Open Minecraft
    echo 2. Go to Settings ^> Game ^> Add-Ons
    echo 3. Add "MineCA Minimap" to Active Packs
    echo 4. Restart your world
    echo.
) else (
    echo.
    echo ERROR: Failed to copy behavior pack.
    echo Make sure Minecraft is closed and try again.
    echo.
)

pause
