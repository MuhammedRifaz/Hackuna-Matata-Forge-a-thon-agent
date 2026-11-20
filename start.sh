#!/usr/bin/env bash
# ==============================================================================
# Pacior Code (TrueForge Agent) - Turnkey Evaluator Launcher (Linux / macOS)
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLASK_DIR="$SCRIPT_DIR/../Flask Practice"

echo "================================================================="
echo "   🚀 PACIOR CODE - Turnkey Evaluator Launcher (TrueForge Agent)"
echo "================================================================="

# 1. Check prerequisites
echo ""
echo "[1/5] Checking prerequisites..."
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

# 2. Check Flask workspace
echo ""
echo "[2/5] Checking evaluation workspace..."
if [ ! -d "$FLASK_DIR" ]; then
    echo "  Cloning Pallets Flask (v3.1.3) into '$FLASK_DIR'..."
    git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git "$FLASK_DIR"
else
    echo "  ✓ Workspace 'Flask Practice' located."
fi

# 3. Check and build extension
echo ""
echo "[3/5] Checking builds..."
EXT_BUNDLE="$SCRIPT_DIR/apps/vscode/dist/extension.js"
WEBVIEW_INDEX="$SCRIPT_DIR/apps/vscode/webview-ui/build/index.html"

if [ ! -f "$EXT_BUNDLE" ] || [ ! -f "$WEBVIEW_INDEX" ]; then
    echo "  Building monorepo and extension..."
    bun install
    bun run build:sdk
    bun --cwd "$SCRIPT_DIR/apps/vscode/webview-ui" run build
    bun --cwd "$SCRIPT_DIR/apps/vscode" esbuild.mjs --production
else
    echo "  ✓ Extension and Webview bundles verified."
fi

# 4. Check / Start TrueForge
echo ""
echo "[4/5] Checking TrueForge Agent Harness (http://localhost:8790)..."
if curl -s -m 2 http://localhost:8790 >/dev/null 2>&1; then
    echo "  ✓ TrueForge server is running on http://localhost:8790."
else
    echo "  Starting TrueForge server via npx @truefoundry/trueforge in background..."
    nohup npx @truefoundry/trueforge >/dev/null 2>&1 &
    sleep 4
fi

# Open browser to TrueForge
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:8790" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
    open "http://localhost:8790" >/dev/null 2>&1 &
fi

# 5. Launch VS Code
echo ""
echo "[5/5] Launching VS Code..."
if command -v code >/dev/null 2>&1; then
    code --extensionDevelopmentPath="$SCRIPT_DIR/apps/vscode" "$FLASK_DIR"
else
    echo "  ! 'code' command not found in PATH. Open VS Code manually and load $SCRIPT_DIR/apps/vscode."
fi

echo ""
echo "================================================================="
echo "  ✅ Pacior Code launched! Click the Pacior icon in the left rail."
echo "================================================================="
