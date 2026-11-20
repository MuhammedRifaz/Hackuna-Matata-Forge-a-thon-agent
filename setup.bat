@echo off
setlocal enabledelayedexpansion
title PACIOR CODE - Turnkey Evaluator Launcher

echo =================================================================
echo    * PACIOR CODE - Turnkey Evaluator Launcher (TrueForge Agent) *
echo =================================================================

REM 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 22 or newer from https://nodejs.org.
    pause
    exit /b 1
)

REM 2. Check Bun
where bun >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Bun not found in PATH. Attempting automatic installation...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
    where bun >nul 2>nul
    if !errorlevel! neq 0 (
        echo [ERROR] Bun could not be found after install.
        echo Please restart your terminal or install Bun from https://bun.sh.
        pause
        exit /b 1
    )
)

REM 3. Ensure Flask Practice evaluation repository exists parallel to TrueForge
set "FLASK_DIR="
for %%I in ("%~dp0..\Flask Practice") do set "FLASK_DIR=%%~fI"

if not exist "%FLASK_DIR%\pyproject.toml" (
    echo [INFO] Parallel evaluation workspace Flask Practice not found or incomplete.
    echo [INFO] Cloning Pallets Flask v3.1.3 into "%FLASK_DIR%"...
    if exist "%FLASK_DIR%" rmdir /s /q "%FLASK_DIR%"
    git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git "%FLASK_DIR%"
    if !errorlevel! neq 0 (
        echo [WARNING] Failed to clone Flask repository via git. Creating directory fallback...
        mkdir "%FLASK_DIR%"
    )
) else (
    echo [INFO] Evaluation workspace Flask Practice located at "%FLASK_DIR%".
)

REM 4. Build Extension and Webview if not already built
set "EXT_BUNDLE=%~dp0apps\vscode\dist\extension.js"
set "WEBVIEW_INDEX=%~dp0apps\vscode\webview-ui\build\index.html"

set "NEED_BUILD=0"
if not exist "%EXT_BUNDLE%" set "NEED_BUILD=1"
if not exist "%WEBVIEW_INDEX%" set "NEED_BUILD=1"

if "%NEED_BUILD%"=="1" (
    echo [INFO] Installing monorepo dependencies...
    call bun install
    if !errorlevel! neq 0 (
        echo [ERROR] bun install failed.
        pause
        exit /b 1
    )

    echo [INFO] Compiling SDK packages...
    call bun run build:sdk
    if !errorlevel! neq 0 (
        echo [ERROR] build:sdk failed.
        pause
        exit /b 1
    )

    echo [INFO] Building Webview UI...
    cd /d "%~dp0apps\vscode\webview-ui"
    call bun run build
    if !errorlevel! neq 0 (
        echo [ERROR] Webview build failed.
        cd /d "%~dp0"
        pause
        exit /b 1
    )
    cd /d "%~dp0"

    echo [INFO] Bundling VS Code Extension with esbuild...
    cd /d "%~dp0apps\vscode"
    call bun esbuild.mjs --production
    if !errorlevel! neq 0 (
        echo [ERROR] esbuild bundling failed.
        cd /d "%~dp0"
        pause
        exit /b 1
    )
    cd /d "%~dp0"
)

REM Verify bundle integrity
if not exist "%EXT_BUNDLE%" (
    echo [ERROR] Missing extension bundle at "%EXT_BUNDLE%".
    pause
    exit /b 1
)
if not exist "%WEBVIEW_INDEX%" (
    echo [ERROR] Missing webview build at "%WEBVIEW_INDEX%".
    pause
    exit /b 1
)
echo [SUCCESS] Extension and Webview bundles verified.

REM 5. Start TrueForge Harness Server if not running (Outbound URLs Allowed & Loopback MCP)
echo [INFO] Enabling outbound network access and loopback MCP access for TrueForge...
set ALLOW_OUTBOUND=true
set TRUEFORGE_ALLOW_OUTBOUND=true
set TRUEFORGE_SANDBOX_ALLOW_OUTBOUND=true
set NETWORK_POLICY_ENABLED=false

echo [INFO] Checking TrueForge Agent Harness at http://localhost:8790 ...
curl -s -m 2 http://localhost:8790 >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Starting TrueForge harness in background: npx @truefoundry/trueforge ...
    start "TrueForge Agent Harness" cmd /k "set ALLOW_OUTBOUND=true&& set TRUEFORGE_ALLOW_OUTBOUND=true&& set TRUEFORGE_SANDBOX_ALLOW_OUTBOUND=true&& set NETWORK_POLICY_ENABLED=false&& npx @truefoundry/trueforge"
    echo [INFO] Waiting for TrueForge server to boot...
    ping -n 6 127.0.0.1 >nul
) else (
    echo [SUCCESS] TrueForge harness is already running on http://localhost:8790.
)

REM 6. Synchronize Pacior Agent and Configuration into TrueForge
echo [INFO] Provisioning Pacior agent configuration in TrueForge...
node "%~dp0scripts\provision-trueforge.js"

REM 7. Open TrueForge web UI in browser
echo [INFO] Opening TrueForge web dashboard at http://localhost:8790 ...
start http://localhost:8790

REM 8. Launch VS Code with Pacior Code extension inside Flask Practice workspace
echo [INFO] Launching VS Code with Pacior Code extension in "%FLASK_DIR%"...

set "EXT_DIR="
for %%I in ("%~dp0apps\vscode") do set "EXT_DIR=%%~fI"

REM Find VS Code executable (PATH or standard Windows installations)
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
    echo [INFO] Opening fresh VS Code window for "%FLASK_DIR%"...
    call "%CODE_CMD%" -n "%FLASK_DIR%" --extensionDevelopmentPath="%EXT_DIR%"
    echo [SUCCESS] Pacior Code extension launched successfully in Flask Practice!
) else (
    echo [WARNING] VS Code CLI code was not found in PATH or standard installation directories.
    echo Please open VS Code, open folder "%FLASK_DIR%", and load extension from "%EXT_DIR%".
)

echo =================================================================
echo   [OK] Pacior Code launched in Flask Practice!
echo   1. Check TrueForge in browser: http://localhost:8790
echo   2. Check VS Code: Flask Practice workspace is active in sidebar
echo =================================================================
pause
