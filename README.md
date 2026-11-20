<p align="center">
  <img src="assets/branding/pacior-logo.svg" width="120" height="120" alt="Pacior Code Logo" />
</p>

<h1 align="center">Pacior Code — Autonomous TrueForge Agent</h1>

<p align="center">
  <strong>Autonomous AI Coding Agent built on TrueFoundry's TrueForge Harness & Cline IDE Architecture</strong><br>
  <em>IIT Bombay Forge-a-thon 2026 Submission</em>
</p>

<p align="center">
  <a href="#-declared-fork-point"><strong>Fork Point</strong></a> •
  <a href="#-quick-start-from-a-clean-clone"><strong>Quick Start</strong></a> •
  <a href="#-architecture-on-trueforge"><strong>Architecture</strong></a> •
  <a href="#-model-configuration--zero-secrets-policy"><strong>Model Setup</strong></a> •
  <a href="#-evaluation-scorecard"><strong>Scorecard</strong></a> •
  <a href="#-team"><strong>Team</strong></a>
</p>

---

## 📌 Executive Overview

**Pacior Code** is an autonomous software engineering agent that integrates the **TrueForge Agent Runtime (`v0.185.1`)** with a rich VS Code extension IDE host. It completely decouples prompt reasoning, turn streaming, tool approvals, and context compaction to TrueForge, while exposing full editor capabilities through a streamable Model Context Protocol (MCP) server.

### Key Capabilities:
- 🧠 **TrueForge Native Agent Loop**: All model streaming, SSE events, and session turns run on TrueForge (`http://localhost:8790`).
- 🛠️ **Full Editor MCP Server**: Exposes `read_files`, `editor`, `write_to_file`, `run_commands`, `list_files`, and `search_files` as standard MCP tools.
- 🎯 **PACIOR Context Engine (Criterion B1)**: AST structural dependency graph slicing and IDF lexical ranking assembling compact context under strict token budgets.
- 🗜️ **Automatic Context Compaction (Criterion B2)**: Calibrated at 12,000 tokens to keep prompt size lean and prevent token explosion (~150k–250k total tokens per task).
- 🛡️ **Dynamic Resilient Model Shifting (Criterion B3 & Task C)**: Automatically detects 429 rate limits or provider failures, shifts to the next available model, preserves all workspace edits, and resumes without restarting from step 0.
- 🔍 **Antigravity-Style Post-Task Diff Review (Criterion B4)**: Non-blocking autonomous execution with post-task in-editor hunk CodeLenses (`✓Accept | ✕Reject`) and a chat footer review summary.

---

## 🍴 Declared Fork Point

Per hackathon submission rules, Pacior Code was developed as an integration on top of the open-source **Cline** monorepo:

* **Upstream Repository:** [`https://github.com/cline/cline`](https://github.com/cline/cline)
* **Base Upstream Commit:** `5413dc180c10700ce2e26547ab75991360dd0486`  
  *Message:* `docs(cli): point development setup to the pinned Bun version (#15544)`
* **Active Working Branch:** `feat/trueforge-integration`
* **Upstream License:** Apache 2.0 (strictly preserved in [`LICENSE`](./LICENSE))
* **Zero Secrets Committed:** No API keys, credentials, or secrets exist in the repository (audited with `gitleaks` & regex scans; all keys are user-supplied via environment variables or TrueForge UI).

---

## 🚀 Quick Start from a Clean Clone

You can evaluate Pacior Code on any clean machine (Windows, macOS, Linux) in minutes.

### Prerequisites:
- **Node.js**: `≥ 22.0.0` ([nodejs.org](https://nodejs.org))
- **Bun**: `≥ 1.2.0` ([bun.sh](https://bun.sh))
- **Python**: `≥ 3.10` (for pytest verification and AST analysis)
- **VS Code**: Installed on system path (`code` command available)

---

### Option A: Automated Evaluator Launchers (Windows CMD / Turnkey)

We provide dedicated standalone `.bat` scripts tailored for evaluation on any Windows machine:

1. **Turnkey Launcher (Extension + TrueForge Server)**:
   ```cmd
   setup.bat
   ```
   *Auto-clones `pallets/flask` (v3.1.3), verifies/builds the extension, starts TrueForge with outbound network access allowed (`ALLOW_OUTBOUND=true`), opens the dashboard in browser (`http://localhost:8790`), and opens VS Code directly inside the `Flask Practice` workspace.*

2. **Run TrueForge Harness Only (Outbound Network Allowed)**:
   ```cmd
   run-trueforge.bat
   ```
   *Starts the TrueForge agent server on port 8790 with outbound URL/network access explicitly permitted (`ALLOW_OUTBOUND=true`, `TRUEFORGE_ALLOW_OUTBOUND=true`) and opens `http://localhost:8790`.*

3. **Run VS Code Extension Only**:
   ```cmd
   run-extension.bat
   ```
   *Ensures `Flask Practice` evaluation workspace exists and launches a fresh VS Code window directly into `Flask Practice` with the Pacior Code extension loaded.*

---

### Option B: Step-by-Step Manual Setup

If you prefer running each step manually:

#### 1. Install Dependencies & Build Packages
```bash
# From repository root
bun install
bun run build:sdk
```

#### 2. Build the VS Code Extension & Webview
```bash
# Build Vite React Webview
bun --cwd apps/vscode build:webview

# Bundle the extension with esbuild
bun --cwd apps/vscode esbuild.mjs --production
```

#### 3. Start TrueForge Agent Harness
TrueForge runs locally as an independent daemon on port `8790`:
```bash
npx @truefoundry/trueforge
```
TrueForge web dashboard will open at **`http://localhost:8790`**.

#### 4. Configure Your LLM Provider in TrueForge
Open `http://localhost:8790` in your browser:
- Navigate to **Settings** $\to$ **Models** / **Providers**.
- Add your preferred provider (Google Gemini, OpenRouter, OpenAI, Anthropic, or local Ollama).
- Enter your API key. (See [`models.config.example.yaml`](./models.config.example.yaml) and [`.env.example`](./.env.example)).

#### 5. Launch VS Code with Pacior Code
```bash
code --extensionDevelopmentPath="apps/vscode" "path/to/your/workspace"
```
Click the **Pacior Code** icon in the VS Code Activity Bar (left sidebar) to open the chat panel.

---

## 🏛️ Architecture on TrueForge

```
┌────────────────────────────────────────────────────────────────────────┐
│                        VS Code IDE Host                                │
│                                                                        │
│   ┌───────────────────────┐             ┌───────────────────────────┐  │
│   │   Pacior Chat UI      │             │  PostTaskDiffReviewBar    │  │
│   │  (React 18 / Vite)    │             │  & In-Editor CodeLenses   │  │
│   └───────────┬───────────┘             └─────────────▲─────────────┘  │
│               │                                       │                │
│   ┌───────────▼───────────────────────────────────────┴─────────────┐  │
│   │                 TrueForgeSessionHost.ts                         │  │
│   │    - Maps SdkSessionHost to TrueForge SSE Stream                │  │
│   │    - Resilient Model Failover & Auto-Compaction                 │  │
│   └───────────┬───────────────────────────────────────▲─────────────┘  │
│               │ HTTP / SSE                            │                │
│               │ (Port 8790)                           │                │
└───────────────┼───────────────────────────────────────┼────────────────┘
                │                                       │
┌───────────────▼───────────────────────────────────────┼────────────────┐
│               TrueForge Agent Harness Runtime         │                │
│                                                       │                │
│   ┌──────────────────────────────────────────────┐    │                │
│   │  Agent Execution Loop (agent.pacior.yaml)    │    │                │
│   │  - Iteration Limit: 25                       │    │                │
│   │  - Auto-Compaction: 12,000 tokens            │    │                │
│   │  - Outbound URLs: ALLOWED                    │    │                │
│   │  - Dynamic Fallback Routing                  │    │                │
│   └──────────────────────┬───────────────────────┘    │                │
│                          │ Tool Call (Streamable HTTP)│                │
└──────────────────────────┼────────────────────────────┼────────────────┘
                           │                            │
┌──────────────────────────▼────────────────────────────┴────────────────┐
│                     WorkspaceMcpServer.ts                              │
│   Hosted locally inside the extension process over 127.0.0.1:           │
│   - read_files      (Reads slices with rate-pacing)                    │
│   - editor          (Applies atomic surgical search-and-replace)       │
│   - write_to_file   (Full file rewrite with pre-edit snapshot)         │
│   - run_commands    (Executes targeted test commands e.g. pytest)      │
│   - list_files      (Repository directory discovery)                   │
│   - search_files    (Regex search across project)                      │
│   - assemble_context(PACIOR AST structural & IDF ranking)              │
└────────────────────────────────────────────────────────────────────────┘
```

### What Replaced What from Upstream Cline:
| Upstream Cline Component | Replaced By / Integrated With | Role & Reason |
| :--- | :--- | :--- |
| `Cline.ts` native monolithic loop | `TrueForgeSessionHost.ts` | Delegates turn management, SSE streaming, and compaction to TrueForge. |
| In-process filesystem & shell tools | `WorkspaceMcpServer.ts` | Exposes editor operations as standard streamable MCP tools. |
| Modal per-edit diff approvals | `PaciorDiffReviewManager.ts` & `PostTaskDiffReviewBar.tsx` | Uninterrupted autonomous task execution; comprehensive post-task hunk review. |
| Naive grep/file context | `PaciorContextEngine.ts` & `pacior_ast_analyzer.py` | AST structural dependency graph slicing and explainable context assembly. |

---

## ⚙️ Model Configuration & Zero Secrets Policy

### Zero Secrets Guarantee:
This repository contains **NO API keys, passwords, or personal credentials**.
All model access is routed through TrueForge via user-supplied credentials.

### How to Configure Models:
1. **Via TrueForge Web UI (Easiest)**:
   - Start TrueForge (`npx @truefoundry/trueforge`).
   - Open `http://localhost:8790` and configure your API key under **Settings** $\to$ **Models**.
2. **Via Environment Variables**:
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Set your keys:
     ```env
     GEMINI_API_KEY=your_key_here
     OPENROUTER_API_KEY=your_key_here
     OPENAI_API_KEY=your_key_here
     ```
3. **Example YAML Reference**:
   - See [`models.config.example.yaml`](./models.config.example.yaml) for full schema and model specifications.

### How Model Failover Works:
If the active model encounters a `429 Rate Limit`, quota exhaustion, or stream failure:
1. TrueForge catches the error in `TrueForgeSessionHost.ts`.
2. A single **⚠️ Model Shift** alert is surfaced in the UI.
3. The session commits all workspace edits so far.
4. A 5-second rate-cooldown window elapses.
5. The session automatically shifts to the next available configured model (e.g. Gemini $\to$ OpenRouter $\to$ OpenAI) with a targeted continuation prompt—**without restarting the task from step 0**.

---

## 📊 Evaluation Scorecard

| Criterion | Requirement | Implementation & Claim |
| :--- | :--- | :--- |
| **Task A (Agent Loop on TrueForge)** | All model turns run through TrueForge with human-in-the-loop approvals. | `TrueForgeSessionHost.ts` executes every prompt turn on TrueForge (`http://localhost:8790`). `tool.approval_required` pauses execution for human approval when auto-approval is toggled OFF. |
| **Task B1 (Context Engine)** | Smart context selection with explainability within strict budget. | `PaciorContextEngine.ts` uses AST parsing and IDF ranking to assemble relevant slices within a 900-token budget. Displays an AST card in chat showing which files were selected and why. |
| **Task B2 (Context Compaction)** | Automatic context compaction to keep prompt size lean. | Configured via `contextManagement.compaction` in `agent.pacior.yaml` triggered at 18,000 tokens. Emits a blue compaction card and restricts task token usage to ~200k–300k. |
| **Task B3 (Resilient Failover)** | Resilient error recovery and dynamic model switching. | `shiftToNextAvailableModel()` seamlessly shifts across configured models upon 429 or provider errors without restarting from scratch or duplicating UI cards. |
| **Task B4 (Diff Review)** | Review changes after task completion. | `PaciorDiffReviewManager.ts` provides post-task in-editor hunk CodeLenses (`✓Accept \| ✕Reject`) and a chat footer review summary with per-row and accept-all controls. |
| **Task C (Fault Tolerance)** | Seamless execution across network/rate hiccups. | Paced MCP tool executions (1,200ms delay) eliminate rapid RPM spikes; continuation protocol guarantees zero loss of completed edits. |

---

## 👥 Team

| Member | College / Organization | GitHub Handle | Role |
| :--- | :--- | :--- | :--- |
| **Muhammed Rifaz** | Yenepoya Institute of Technology | [`@MuhammedRifaz`](https://github.com/MuhammedRifaz) | Lead System Architect, TrueForge Session Host Bridge, MCP Workspace Server, Post-Task Diff Review Manager |
| **Team Pacior** | IIT Bombay Forge-a-thon | Repository Contributor | PACIOR Context Engine, AST Structural Parser, Evaluation Validation & Packaging |

---

## 📄 License

This project is licensed under the **Apache License 2.0** — see the [`LICENSE`](./LICENSE) file for details. Preserved from upstream Cline per open-source requirements.
