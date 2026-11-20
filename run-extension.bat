@echo off
setlocal enabledelayedexpansion
title Pacior Code - VS Code Extension Launcher

echo =================================================================
echo   * Pacior Code Extension (Flask Practice Evaluation Workspace) *
echo =================================================================

REM 1. Ensure Bun is available
where bun >nul 2>nul
if !errorlevel! neq 0 (
    if exist "%USERPROFILE%\.bun\bin\bun.exe" (
        set "PATH=%USERPROFILE%\.bun\bin;!PATH!"
    ) else (
        echo [INFO] Bun not found in PATH. Attempting automatic installation...
        powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
        set "PATH=%USERPROFILE%\.bun\bin;!PATH!"
    )
)

REM 2. Ensure Flask Practice evaluation repository exists parallel to TrueForge
set "FLASK_DIR="
for %%I in ("%~dp0..\Flask Practice") do set "FLASK_DIR=%%~fI"

if not exist "!FLASK_DIR!\pyproject.toml" (
    echo [INFO] Parallel evaluation workspace Flask Practice not found or incomplete.
    echo [INFO] Cloning Pallets Flask v3.1.3 into "!FLASK_DIR!"...
    if exist "!FLASK_DIR!" rmdir /s /q "!FLASK_DIR!"
    git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git "!FLASK_DIR!"
    if !errorlevel! neq 0 (
        echo [WARNING] Failed to clone Flask repository via git. Creating fallback directory...
        mkdir "!FLASK_DIR!"
    )
) else (
    echo [INFO] Evaluation workspace Flask Practice located at "!FLASK_DIR!".
)

REM 3. Ensure Extension bundle exists
set "EXT_BUNDLE=%~dp0apps\vscode\dist\extension.js"
set "WEBVIEW_INDEX=%~dp0apps\vscode\webview-ui\build\index.html"

set "NEED_BUILD=0"
if not exist "%EXT_BUNDLE%" set "NEED_BUILD=1"
if not exist "%WEBVIEW_INDEX%" set "NEED_BUILD=1"

if "!NEED_BUILD!"=="1" (
    echo [INFO] Building extension bundle...
    call bun install
    call bun run build:sdk
    cd /d "%~dp0apps\vscode\webview-ui"
    call bun run build
    cd /d "%~dp0apps\vscode"
    call bun esbuild.mjs --production
    cd /d "%~dp0"
)

REM 4. Provision / sync Pacior Agent with TrueForge if running
curl -s -m 2 http://localhost:8790 >nul 2>nul
if !errorlevel! equ 0 (
    node "%~dp0scripts\provision-trueforge.js" >nul 2>nul
)

REM 5. Launch VS Code with Pacior Code extension inside Flask Practice workspace
set "EXT_DIR="
for %%I in ("%~dp0apps\vscode") do set "EXT_DIR=%%~fI"

set "CODE_CMD="
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" set "CODE_CMD=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined CODE_CMD if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" set "CODE_CMD=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not defined CODE_CMD if exist "%ProgramFiles%\Microsoft VS Code\bin\code.cmd" set "CODE_CMD=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
if not defined CODE_CMD if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" set "CODE_CMD=%ProgramFiles%\Microsoft VS Code\Code.exe"
if not defined CODE_CMD (
    for /f "tokens=*" %%I in ('where.exe code.cmd 2^>nul') do set "CODE_CMD=%%I"
)
if not defined CODE_CMD (
    for /f "tokens=*" %%I in ('where.exe code 2^>nul') do set "CODE_CMD=%%I"
)

if defined CODE_CMD (
    echo [INFO] Launching fresh VS Code window for "!FLASK_DIR!"...
    call "!CODE_CMD!" -n "!FLASK_DIR!" --extensionDevelopmentPath="!EXT_DIR!"
    echo [SUCCESS] Pacior Code extension launched successfully in Flask Practice!
) else (
    echo [WARNING] VS Code CLI code was not found in PATH or standard installation directories.
    echo Please open VS Code, open folder "!FLASK_DIR!", and load extension from "!EXT_DIR!".
)

echo =================================================================
echo   [OK] Launcher finished. Check VS Code window.
echo =================================================================
pause

