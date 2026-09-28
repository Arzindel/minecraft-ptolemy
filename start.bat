@echo off
rem Ptolemy launcher for Windows: double-click it.
rem  1. Uses Node.js if it's installed (18.11 or newer); otherwise downloads a private copy into .node\
rem     (only this folder uses it, nothing is installed on the system).
rem  2. Installs Ptolemy's packages the first time, and again when package.json changes.
rem  3. Starts Ptolemy and opens the WebUI in the browser. Close this window (or Ctrl+C) to stop it.
setlocal EnableExtensions
cd /d "%~dp0"
title Ptolemy
set "NODE_DIR=%~dp0.node"
set "NODE_EXE="
set "CHECK_VERSION=const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=11)?0:1)"

where node >nul 2>nul
if not errorlevel 1 (
  node -e "%CHECK_VERSION%" >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE if exist "%NODE_DIR%\node.exe" set "NODE_EXE=%NODE_DIR%\node.exe"
if not defined NODE_EXE (
  echo Node.js 18.11 or newer wasn't found, so a private copy is being downloaded into .node\
  echo This happens once. It needs an internet connection.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1" -Dest "%NODE_DIR%"
  if errorlevel 1 goto failed
  set "NODE_EXE=%NODE_DIR%\node.exe"
)
if not "%NODE_EXE%"=="node" set "PATH=%NODE_DIR%;%PATH%"

"%NODE_EXE%" scripts\needs-install.js
if errorlevel 1 (
  echo Installing Ptolemy's packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto failed
)

echo.
"%NODE_EXE%" --watch src\index.js --watched --open
echo.
echo Ptolemy stopped.
pause
exit /b 0

:failed
echo.
echo Something went wrong (see above). Ptolemy didn't start.
pause
exit /b 1
