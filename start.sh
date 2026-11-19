#!/usr/bin/env bash
# ==============================================================================
# Pacior Code (TrueForge Agent) - Turnkey Evaluator Launcher (Linux / macOS)
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_WORKSPACE="${1:-$SCRIPT_DIR/../Flask Practice}"

echo "================================================================="
echo "   🚀 PACIOR CODE - Turnkey Evaluator Launcher (TrueForge Agent)"
echo "================================================================="

# 1. Check prerequisites
echo ""
echo "[1/4] Checking prerequisites..."
if ! command -v node >/dev/null 2>&1; then
    echo "  ✗ Node.js is missing. Please install Node.js >= 22 (https://nodejs.org)."
    exit 1
fi
echo "  ✓ Node.js $(node -v)"

if ! command -v bun >/dev/null 2>&1; then
    echo "  Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi
echo "  ✓ Bun $(bun -v)"

# 2. Build if needed
echo ""
echo "[2/4] Checking builds..."
if [ ! -f "$SCRIPT_DIR/apps/vscode/dist/extension.js" ] || [ ! -d "$SCRIPT_DIR/apps/vscode/webview-ui/build" ]; then
    echo "  Building monorepo and extension..."
    bun install
    bun run build:sdk
    bun --cwd "$SCRIPT_DIR/apps/vscode" build:webview
    bun --cwd "$SCRIPT_DIR/apps/vscode" esbuild.mjs --production
else
    echo "  ✓ Extension bundles ready."
fi

# 3. Check / Start TrueForge
echo ""
echo "[3/4] Checking TrueForge Agent Harness (http://localhost:8790)..."
if curl -s -m 2 http://localhost:8790 >/dev/null 2>&1; then
    echo "  ✓ TrueForge server is running on http://localhost:8790."
else
    echo "  Starting TrueForge server via npx @truefoundry/trueforge in background..."
    nohup npx @truefoundry/trueforge >/dev/null 2>&1 &
    sleep 4
fi

# 4. Launch VS Code
echo ""
echo "[4/4] Launching VS Code..."
if [ -d "$TARGET_WORKSPACE" ]; then
    code --extensionDevelopmentPath="$SCRIPT_DIR/apps/vscode" "$TARGET_WORKSPACE"
else
    code --extensionDevelopmentPath="$SCRIPT_DIR/apps/vscode" "$SCRIPT_DIR"
fi

echo ""
echo "================================================================="
echo "  ✅ Pacior Code launched! Click the Pacior icon in the left rail."
echo "================================================================="
