@echo off
setlocal
echo =================================================================
echo    PACIOR CODE - Turnkey Evaluator Launcher (TrueForge Agent)
echo =================================================================

REM Check Node
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js ^>= 22 from https://nodejs.org.
    pause
    exit /b 1
)

REM Check Bun
where bun >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Installing Bun...
    powershell -c "irm bun.sh/install.ps1 | iex"
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

REM Build if needed
if not exist "apps\vscode\dist\extension.js" (
    echo [INFO] Building extension bundle...
    call bun install
    call bun run build:sdk
    cd apps\vscode && call bun run build:webview && call bun esbuild.mjs --production && cd ..\..
)

REM Check TrueForge
curl -s -m 2 http://localhost:8790 >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Starting TrueForge Harness server in background...
    start "TrueForge Server" cmd /k "npx @truefoundry/trueforge"
    timeout /t 5 >nul
)

echo [INFO] Launching VS Code with Pacior Code...
code --extensionDevelopmentPath="%~dp0apps\vscode" "%~dp0..\Flask Practice"

echo =================================================================
echo   Pacior Code launched! Click the Pacior icon in the Activity Bar.
echo =================================================================
