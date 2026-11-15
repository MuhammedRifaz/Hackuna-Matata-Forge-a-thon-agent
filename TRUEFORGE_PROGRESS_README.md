# TrueForge (Pacior Code) - Architecture, Integration & Master Roadmap

> **IIT Bombay Techfest · TrueFoundry Forge-a-thon 2026**  
> Complete project reference, architectural breakdown, technical progress log, and operational instructions for restarting or picking up evaluation.

---

## 1. Executive Summary & Competition Objectives

The goal of this project is to deliver a production-grade autonomous coding agent embedded in VS Code and integrated with TrueFoundry's **TrueForge** agent runtime platform.

### Core Deliverables & Problem Statement
1. **Task A — Real Inline Edit Mode (Ctrl+I / Cmd+I)**:
   - Provide an in-editor floating input widget for zero-latency, targeted edits.
   - Restrict token usage to $< 1,000$ tokens per edit turn without spinning up the heavy sidebar chat or loading full MCP tool definitions.
   - Directly modify the active document via VS Code `WorkspaceEdit` with diff highlighting and instant user acceptance.

2. **Task B — Autonomous Coding Agent Mode (Flask Practice Task)**:
   - Built-in CLI command `flask config` in Flask (`src/flask/cli.py`).
   - Masks sensitive values (`SECRET`, `PASSWORD`, `TOKEN`, `KEY` $\to$ `***`).
   - Appears in `flask --help`.
   - Comprehensive test suite in `tests/test_cli.py` passing pytest under Python 3.14.
   - Complete technical documentation in `docs/cli.rst`.
   - Context-engineered pre-injection ($\le 1,800$ tokens) avoiding full repository file dumps.

3. **Context Engineering, Token Efficiency & Model Resilience**:
   - Zero-waste AST and lexical symbol analysis pipeline.
   - Multi-provider failover (OpenRouter, Gemini, Vercel AI SDK).
   - High-throughput streaming without token metric inflation.
   - Uninterrupted execution without iteration lockouts.

---

## 2. Full Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            VISUAL STUDIO CODE                               │
│                                                                             │
│   ┌────────────────────────┐                   ┌────────────────────────┐   │
│   │   Task A: Inline Edit  │                   │   Task B: Agent Mode   │   │
│   │     (Ctrl+I / Cmd+I)   │                   │    (Sidebar Webview)   │   │
│   └───────────┬────────────┘                   └───────────┬────────────┘   │
│               │                                            │                │
│       PaciorInlineEditor                           TrueForgeSessionHost     │
│   (Single-turn, no tool load,                    (AST Slices, Streaming,   │
│       direct WorkspaceEdit)                       Auto-Continue, Sessions)  │
│               │                                            │                │
└───────────────┼────────────────────────────────────────────┼────────────────┘
                │                                            │
                ▼                                            ▼
┌──────────────────────────────────────┐     ┌────────────────────────────────┐
│   WorkspaceMcpServer (HTTP / SSE)    │     │   TrueForge Daemon (Port 8790) │
│  • read_files (MAX_READ_LINES = 120) │◄────┤  • Session Orchestration       │
│  • editor (Pre-snapshot rollback)    │     │  • Context Compaction          │
│  • run_commands (PATH, 3k char cap)  │     │  • Dynamic Subagents           │
│  • search_files, list_files          │     │  • Model Router: Gemini Flash  │
└──────────────────────────────────────┘     └────────────────────────────────┘
```

---

## 3. What Was Planned vs. What Was Done

| Milestone / Component | Initial Plan | Final Implementation Status | Verification Details |
| :--- | :--- | :--- | :--- |
| **Task A: Inline Edit UI** | Register command, prompt user, send code chunk | **Done (`apps/vscode/src/trueforge/PaciorInlineEditor.ts`)** | Registered `pacior.inlineEdit` & `cline.inlineEdit` on `Ctrl+I`/`Cmd+I`. Uses $< 800$ tokens. |
| **Task B: Flask CLI Command** | Add `flask config` with masking | **Done (`src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`)** | `py -3.14 -m pytest tests/test_cli.py -k test_config_command` passes 100% in 0.19s. |
| **Python Environment** | Rely on system path | **Done (`pip install -e "Flask Practice"`)** | Editable package installation active in Python 3.14. Pytest imports local code directly. |
| **Tool Response Limit** | Prevent 24k character crashes | **Done (`apps/vscode/src/trueforge/WorkspaceMcpServer.ts`)** | `MAX_READ_LINES = 120` enforced across all `read_files` calls. |
| **15 Iteration Limit** | Prevent "please request again" | **Done (`TrueForgeClient.ts`, `TrueForgeSessionHost.ts`)** | `iterationLimit` bumped to 50 + seamless auto-continuation into next turn without prompt dialog. |
| **Token Metric Explosion** | Stop UI reporting 1.5M tokens | **Done (`TrueForgeSessionHost.ts`, `WorkspaceMcpServer.ts`)** | Streaming usage converted to incremental differential ($\Delta$) reporting. Terminal outputs clamped to 3,000 chars. |
| **Model Selection** | Stop hallucination loops | **Done (Updated `pacior` to `gemini/gemini-3-5-flash-lite`)** | Replaced `nvidia-nemotron` with Gemini 3.5 Flash-Lite in TrueForge database. Fixed Git in Windows `PATH`. |

---

## 4. Key Root Cause Analyses (Technical Details)

### A. The 1.5M "Tokens Used" Mystery
- **The Symptom**: The task header displayed `1.5M tokens used` even though the task only took 2–3 minutes.
- **The Cause**: TrueForge streams chunks as `model.message.delta` and attaches `ev.usage` to every packet. The VS Code `TrueForgeSessionHost` was previously emitting an SDK `usage` event on every delta. The webview metric aggregator (`getApiMetrics.ts`) sums `tokensIn` across all events:
  $$\text{Total Tokens} = \sum_{\text{events}} \text{tokensIn}$$
  Because 70+ streaming packets each carried the full turn's cumulative count (~21,000 tokens), the UI computed $70 \times 21,000 \approx 1,470,000$ tokens!
- **The Solution**: Converted the emitter to track `lastReportedInputTokens` and only emit the incremental difference ($\Delta \text{tokens}$). The actual LLM consumption is $\approx 22,000$ tokens.

### B. The 64 Tool Calls & Hallucination Loop
- **The Symptom**: The free `openrouter/nvidia-nemotron-3-5-lightning-free` model ran 64 tool calls, creating dummy files (`test_app/app.py`, `Practice/`) and attempting invalid commands (`rm`, `python -c ...`).
- **The Cause**: Smaller open-source models struggle with tool calling on Windows, emitting Unix shell idioms (`rm`, bash quotes) and failing to recognize that `CliRunner` test harnesses don't require spawning external python scripts.
- **The Solution**: Updated the default agent `pacior` in TrueForge to `gemini/gemini-3-5-flash-lite`, which natively supports tool calling and prompt caching without getting stuck in loops.

### C. The 15 Iteration Boundary
- **The Symptom**: The user had to constantly click "Retry" because the turn halted at 15 iterations.
- **The Cause**: TrueForge hard-codes an internal per-turn limit of `iterationLimit: 15`. Multi-file editing + test verification can take 16–25 iterations.
- **The Solution**: Set `iterationLimit: 50` and added an auto-continuation handler in `TrueForgeSessionHost.ts` that commits progress and starts the next turn automatically without user intervention.

---

## 5. Repository & Working Tree State

- **Branch**: `feat/trueforge-integration`
- **Latest Commit**: Clean and pushed to GitHub remote (`origin/feat/trueforge-integration`).
- **Workspace Directories**:
  - `TrueForge/`: Root repo for the extension, SDK packages, and TrueForge integration.
  - `Flask Practice/`: Target repository for Task B. Working tree is clean, and editable package install is verified (`pip install -e .`).
- **TrueForge Daemon**:
  - Running on `http://localhost:8790` (Version `0.185.1`).
  - Agent `pacior` configured with `gemini/gemini-3-5-flash-lite`.

---

## 6. How to Run & Verify in a Fresh Chat

When opening a new session:

1. **Verify Daemon & Server**:
   ```powershell
   # Ensure TrueForge server is running on port 8790
   Get-Process -Id (Get-NetTCPConnection -LocalPort 8790).OwningProcess
   ```
2. **Reload VS Code Window**:
   - Press `Ctrl+Shift+P` $\to$ select `Developer: Reload Window`.
3. **Verify Task A (Inline Edit)**:
   - Open any file in the editor.
   - Press `Ctrl+I` (or `Cmd+I`).
   - Enter an instruction (e.g., *"Add a docstring explaining this function"*).
   - Verify: Instant diff in editor, $< 800$ tokens used, no sidebar chat needed.
4. **Verify Task B (Agent Mode)**:
   - Open the **Pacior Code** sidebar.
   - Submit the prompt:
     > *"Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as \*\*\*. It must appear in flask --help, be covered by a test in tests/test_cli.py, and be documented in docs/cli.rst. Verify using pytest tests/test_cli.py -k test_config_command."*
   - Verify: Runs smoothly with `gemini/gemini-3-5-flash-lite`, finishes in 3–5 iterations, passes pytest, and uses $\le 25\text{k}$ total tokens.
