@echo off
setlocal enabledelayedexpansion
title TrueForge Server - Outbound Network Allowed

echo =================================================================
echo   * TrueForge Harness Server (Outbound Network Allowed) *
echo =================================================================

REM 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 22 or newer from https://nodejs.org.
    pause
    exit /b 1
)

REM 2. Configure Outbound Network Permissions and Disable SSRF Loopback Guard
echo [INFO] Enabling outbound URL access and local loopback MCP access for TrueForge...
set ALLOW_OUTBOUND=true
set TRUEFORGE_ALLOW_OUTBOUND=true
set TRUEFORGE_SANDBOX_ALLOW_OUTBOUND=true
set NETWORK_POLICY_ENABLED=false

REM 2b. Apply Gemini Tool-Calling Thought-Signature Compatibility Patch
node "%~dp0scripts\patch-gemini-signature.js"

REM 3. Check if server is already running on port 8790
curl -s -m 2 http://localhost:8790 >nul 2>nul
if %errorlevel% equ 0 (
    echo [SUCCESS] TrueForge server is already active on http://localhost:8790.
    echo [INFO] Provisioning Pacior agent configuration in TrueForge...
    node "%~dp0scripts\provision-trueforge.js"
    echo [INFO] Opening dashboard in browser...
    start http://localhost:8790
    echo TrueForge is ready.
    pause
    exit /b 0
)

REM 4. Start TrueForge server
echo [INFO] Starting TrueForge harness server (port 8790, outbound URLs allowed)...
echo [INFO] Running: npx @truefoundry/trueforge
start http://localhost:8790
npx @truefoundry/trueforge

