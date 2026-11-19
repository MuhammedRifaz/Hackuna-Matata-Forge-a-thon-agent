<#
.SYNOPSIS
    Turnkey Launch Script for Pacior Code (TrueForge Agent) on Windows.
.DESCRIPTION
    Verifies prerequisites (Node.js, Bun, Python, VS Code), installs dependencies,
    builds the extension if needed, ensures TrueForge server is running on http://localhost:8790,
    and launches VS Code with Pacior Code loaded for evaluation.
.PARAMETER TargetWorkspace
    The path to the folder/project to open for evaluation (e.g. Flask repository).
#>

param(
    [string]$TargetWorkspace = "$PSScriptRoot\..\Flask Practice"
)

$ErrorActionPreference = "Stop"
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "   🚀 PACIOR CODE - Turnkey Evaluator Launcher (TrueForge Agent)  " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Verify Prerequisites
Write-Host "`n[1/5] Checking prerequisites..." -ForegroundColor Yellow

# Node.js
try {
    $nodeVer = node -v
    Write-Host "  ✓ Node.js: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Node.js is not installed. Please install Node.js >= 22 (https://nodejs.org)." -ForegroundColor Red
    exit 1
}

# Bun
try {
    $bunVer = bun -v
    Write-Host "  ✓ Bun: $bunVer" -ForegroundColor Green
} catch {
    Write-Host "  ! Bun is not in PATH. Installing Bun via powershell..." -ForegroundColor Yellow
    powershell -c "irm bun.sh/install.ps1 | iex"
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
}

# Python
try {
    $pyVer = python --version
    Write-Host "  ✓ Python: $pyVer" -ForegroundColor Green
} catch {
    Write-Host "  ! Warning: Python was not found in PATH. Targeted test execution (pytest) may require Python." -ForegroundColor Yellow
}

# 2. Check and Install Dependencies
Write-Host "`n[2/5] Checking dependencies & builds..." -ForegroundColor Yellow
if (!(Test-Path "$PSScriptRoot\node_modules")) {
    Write-Host "  Installing monorepo dependencies with Bun..." -ForegroundColor Cyan
    bun install
}

$extBundle = "$PSScriptRoot\apps\vscode\dist\extension.js"
$webviewBundle = "$PSScriptRoot\apps\vscode\webview-ui\build\index.html"

if (!(Test-Path $extBundle) -or !(Test-Path $webviewBundle)) {
    Write-Host "  Building SDK packages & VS Code extension bundle..." -ForegroundColor Cyan
    bun run build:sdk
    bun --cwd "$PSScriptRoot\apps\vscode" build:webview
    bun --cwd "$PSScriptRoot\apps\vscode" esbuild.mjs --production
} else {
    Write-Host "  ✓ Extension and Webview bundles are ready." -ForegroundColor Green
}

# 3. Check / Start TrueForge Harness Server
Write-Host "`n[3/5] Checking TrueForge Agent Harness (http://localhost:8790)..." -ForegroundColor Yellow
$tfAlive = $false
try {
    $res = Invoke-WebRequest -Uri "http://localhost:8790" -Method GET -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($res.StatusCode -lt 500) { $tfAlive = $true }
} catch {
    $tfAlive = $false
}

if ($tfAlive) {
    Write-Host "  ✓ TrueForge server is already listening on http://localhost:8790." -ForegroundColor Green
} else {
    Write-Host "  Starting TrueForge server via npx @truefoundry/trueforge in background..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "npx @truefoundry/trueforge" -WindowStyle Minimized
    
    # Wait up to 30 seconds for TrueForge to boot
    $timeout = 30
    $elapsed = 0
    while ($elapsed -lt $timeout) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        try {
            $check = Invoke-WebRequest -Uri "http://localhost:8790" -Method GET -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($check.StatusCode -lt 500) {
                $tfAlive = $true
                break
            }
        } catch {}
    }

    if ($tfAlive) {
        Write-Host "  ✓ TrueForge server successfully started on http://localhost:8790." -ForegroundColor Green
    } else {
        Write-Host "  ! TrueForge server is booting. If it doesn't respond, run 'npx @truefoundry/trueforge' in a separate terminal." -ForegroundColor Yellow
    }
}

# 4. Model & API Key Verification Notice
Write-Host "`n[4/5] Model Configuration..." -ForegroundColor Yellow
Write-Host "  Pacior Code communicates directly with TrueForge models." -ForegroundColor Gray
Write-Host "  Ensure at least ONE LLM provider (e.g. Gemini, OpenAI, OpenRouter, or Ollama) is configured." -ForegroundColor Gray
Write-Host "  - You can configure models at: http://localhost:8790 -> Models" -ForegroundColor Gray
Write-Host "  - Or provide your API key in environment variables (e.g. `$env:GEMINI_API_KEY = '...'`)." -ForegroundColor Gray
Write-Host "  - See models.config.example.yaml and .env.example for full details." -ForegroundColor Gray

# 5. Launch VS Code with Pacior Extension Host
Write-Host "`n[5/5] Launching VS Code with Pacior Code..." -ForegroundColor Yellow
$extPath = "$PSScriptRoot\apps\vscode"

if (Test-Path $TargetWorkspace) {
    $resolvedWorkspace = (Resolve-Path $TargetWorkspace).Path
    Write-Host "  Opening workspace: $resolvedWorkspace" -ForegroundColor Green
    code --extensionDevelopmentPath="$extPath" "$resolvedWorkspace"
} else {
    Write-Host "  Opening current directory: $PSScriptRoot" -ForegroundColor Green
    code --extensionDevelopmentPath="$extPath" "$PSScriptRoot"
}

Write-Host "`n=================================================================" -ForegroundColor Cyan
Write-Host "  ✅ Pacior Code launched successfully! Click the Pacior icon in " -ForegroundColor Green
Write-Host "     the VS Code Activity Bar (left sidebar) to start prompting.  " -ForegroundColor Green
Write-Host "=================================================================`n" -ForegroundColor Cyan
