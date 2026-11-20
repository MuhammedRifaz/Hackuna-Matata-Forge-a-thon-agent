@echo off
setlocal enabledelayedexpansion
title PACIOR CODE - Turnkey Evaluator Launcher

echo =================================================================
echo    🚀 PACIOR CODE - Turnkey Evaluator Launcher (TrueForge Agent)
echo =================================================================

REM 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js ^>= 22 from https://nodejs.org.
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
set "FLASK_DIR=%~dp0..\Flask Practice"
if not exist "%FLASK_DIR%" (
    echo [INFO] Parallel evaluation workspace 'Flask Practice' not found.
    echo [INFO] Cloning Pallets Flask (v3.1.3) into '%FLASK_DIR%'...
    git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git "%FLASK_DIR%"
    if !errorlevel! neq 0 (
        echo [WARNING] Failed to clone Flask repository via git. Creating directory fallback...
        mkdir "%FLASK_DIR%"
    )
) else (
    echo [INFO] Evaluation workspace 'Flask Practice' located.
)

REM 4. Build Extension and Webview if not already built
set "EXT_BUNDLE=%~dp0apps\vscode\dist\extension.js"
set "WEBVIEW_INDEX=%~dp0apps\vscode\webview-ui\build\index.html"

if not exist "%EXT_BUNDLE%" (
    set "NEED_BUILD=1"
) else if not exist "%WEBVIEW_INDEX%" (
    set "NEED_BUILD=1"
) else (
    set "NEED_BUILD=0"
)

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
    cd "%~dp0apps\vscode\webview-ui"
    call bun run build
    if !errorlevel! neq 0 (
        echo [ERROR] Webview build failed.
        cd "%~dp0"
        pause
        exit /b 1
    )
    cd "%~dp0"

    echo [INFO] Bundling VS Code Extension with esbuild...
    cd "%~dp0apps\vscode"
    call bun esbuild.mjs --production
    if !errorlevel! neq 0 (
        echo [ERROR] esbuild bundling failed.
        cd "%~dp0"
        pause
        exit /b 1
    )
    cd "%~dp0"
)

REM Verify bundle integrity
if not exist "%EXT_BUNDLE%" (
    echo [ERROR] Missing extension bundle at '%EXT_BUNDLE%'.
    pause
    exit /b 1
)
if not exist "%WEBVIEW_INDEX%" (
    echo [ERROR] Missing webview build at '%WEBVIEW_INDEX%'.
    pause
    exit /b 1
)
echo [SUCCESS] Extension and Webview bundles verified.

REM 5. Start TrueForge Harness Server if not running
echo [INFO] Checking TrueForge Agent Harness (http://localhost:8790)...
curl -s -m 2 http://localhost:8790 >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Starting TrueForge harness in background (npx @truefoundry/trueforge)...
    start "TrueForge Agent Harness" cmd /k "npx @truefoundry/trueforge"
    echo [INFO] Waiting for TrueForge server to boot...
    timeout /t 6 >nul
) else (
    echo [SUCCESS] TrueForge harness is already running on http://localhost:8790.
)

REM 6. Open TrueForge web UI in browser
echo [INFO] Opening TrueForge web dashboard at http://localhost:8790 ...
start http://localhost:8790

REM 7. Launch VS Code with Pacior Code extension
echo [INFO] Launching VS Code with Pacior Code extension in workspace...
where code >nul 2>nul
if %errorlevel% equ 0 (
    code --extensionDevelopmentPath="%~dp0apps\vscode" "%FLASK_DIR%"
) else (
    echo [WARNING] 'code' command not found in PATH.
    echo Please open VS Code, press F5 (or Run Extension) targeting apps\vscode.
)

echo =================================================================
echo   ✅ Pacior Code launched!
echo   1. Check TrueForge in browser (http://localhost:8790)
echo   2. Click the Pacior Code icon in the left Activity Bar of VS Code
echo =================================================================
pause
