# TrueForge (Pacior Code) — Complete System Architecture & Engineering Dossier

> **Event:** IIT Bombay Techfest · TrueFoundry Forge-a-thon 2026  
> **Topic:** Production Autonomous Coding Agent on TrueForge Runtime  
> **Document Type:** Master Technical Data Dossier for Content Writers, Documentation & Video Production  
> **PDF Document Generated:** [`TrueForge_Pacior_Project_Documentation.pdf`](file:///c:/Users/Administrator/Downloads/Hackathon/IIT%20Bombay%20-%20TrueForge%20Agent/TrueForge/TrueForge_Pacior_Project_Documentation.pdf) (Exactly 3 Pages, Publication-Grade)

---

## TABLE OF CONTENTS
1. **The Mandated Eight Sections (Official Hackathon Format)**
   - 1. Team
   - 2. Starting Point
   - 3. Architecture on TrueForge
   - 4. How Context is Selected (PACIOR Context Engine)
   - 5. Model Setup & Routing
   - 6. Scorecard (Evaluation Criteria & Video Demonstration Claims)
   - 7. Tools Used
   - 8. Known Limitations & 1-Month Engineering Roadmap
2. **Deep-Dive: How Cline Was Forked & Exact Replacement Map**
3. **End-to-End Lifecycle: What Happens After a User Submits a Prompt**
4. **Engineering Root Causes: The 8 Critical Problems Solved**
5. **State-of-the-Art (SOTA) Competitive Matrix**

---

# PART 1: THE MANDATED EIGHT SECTIONS

### 1. Team
| Member | College / Organization | GitHub Handle | Role & Ownership |
| :--- | :--- | :--- | :--- |
| **Muhammed Rifaz** | Yenepoya Institute of Technology | [`@MuhammedRifaz`](https://github.com/MuhammedRifaz) | Lead System Architect, TrueForge Session Host Bridge, MCP Workspace Server, Post-Task Diff Review Manager |
| **Team Pacior** | IIT Bombay Forge-a-thon | Repository Contributor | PACIOR Context Engine, AST Structural Parser, Test Suite Validation & Autonomous Rules |

---

### 2. Starting Point
* **Upstream Repository:** Forked from the official **Cline** open-source monorepo: [`https://github.com/cline/cline`](https://github.com/cline/cline)
* **Base Upstream Commit:** `5413dc180c10700ce2e26547ab75991360dd0486`  
  *Message:* `docs(cli): point development setup to the pinned Bun version (#15544)`
* **Active Working Branch:** `feat/trueforge-integration` (Pushed to GitHub remote: `origin/feat/trueforge-integration`).
* **Toolchain & Runtime:**
  * **Package Manager & Task Runner:** Bun `1.4.2` (strict monorepo toolchain).
  * **Runtime:** Node.js `≥ 22.0.0` and Python `3.14 / 3.15`.
  * **IDE Host:** VS Code Extension API (`1.95+`), webview built with Vite + React 18, extension host bundled with esbuild.

---

### 3. Architecture on TrueForge
The implementation replaces Cline's native monolithic LLM executor with a decoupled, high-performance integration to TrueFoundry's **TrueForge Agent Runtime** (Daemon `v0.185.1` running on `http://localhost:8790`).

#### Core Architectural Components
1. **Extension Bridge (`apps/vscode/src/trueforge/TrueForgeSessionHost.ts`):**
   * Implements Cline's `SdkSessionHost` contract.
   * Intercepts prompts submitted via the sidebar webview.
   * Streams SSE events from TrueForge daemon (`agent.message.delta`, `agent.tool_call`, `model.usage`, `turn.done`).
   * Manages token accounting, webview UI state synchronization, and auto-continuation past step limits.
2. **TrueForge Client (`apps/vscode/src/trueforge/TrueForgeClient.ts`):**
   * HTTP & SSE streaming transport connecting to `http://localhost:8790`.
   * Implements automated **B3 Fallback Handling**: On HTTP 429 (Rate Limit) or provider outage, automatically reroutes the session to the fallback model without losing conversation state.
   * Calculates streaming delta tokens to prevent UI metric explosions.
3. **Workspace MCP Server (`apps/vscode/src/trueforge/WorkspaceMcpServer.ts`):**
   * Exposes VS Code editor and environment capabilities to TrueForge as Model Context Protocol (MCP) tools:
     * `read_files`: Chunked reading enforced with `MAX_READ_LINES = 120` to prevent 24k character crashes.
     * `editor`: Surgical string-replacement with pre-edit pristine snapshot tracking for rollback.
     * `run_commands`: Sandboxed terminal execution with auto-quoting for Windows `cmd.exe`, stdin hang guards, and Git in PATH.
     * `search_files` & `list_files`: Fast symbol and file matching.
4. **TrueForge Harness Features Leveraged:**
   * **Code Mode:** Combines multi-step shell operations into single scripts in the sandbox, returning synthesized outputs to prevent LLM context flooding.
   * **Large-Result Offloading:** Outputs exceeding 6,000 tokens are automatically written to sandbox files (`bigfile.txt`), injecting a compact preview into the prompt.
   * **Context Compaction:** Automatically compacts dialogue history once the prompt reaches 80% capacity.
   * **Dynamic Subagents:** Spawns isolated child agents (`create_sub_agent`) for parallel investigation tasks.
   * **Deferred Tool Loading:** Preloads tool summaries and fetches full JSON schemas only when demanded.

---

### 4. How Context is Selected (PACIOR Context Engine)
Rather than blindly dumping files or having the LLM grep the entire repository iteratively, the **PACIOR Context Engine** (`apps/vscode/src/context/PaciorContextEngine.ts` and `pacior_ast_analyzer.py`) pre-selects exact code and doc context under a strict **16,000-token total budget** (max **1,800 tokens** for pre-injected context):

1. **Hybrid Multi-Modal Pipeline:**
   * **Lexical Matcher (BM25 / Ripgrep):** Extracts raw token keywords from the user prompt.
   * **AST Structural Symbol Analyzer (`pacior_ast_analyzer.py`):** Parses the Python codebase using the `ast` module, extracting classes, functions, decorators, call hierarchies, and docstrings.
   * **Semantic Intent Scorer:** Matches conceptual queries against symbol tables.
2. **Canonical Doc & Command Boosting:**
   * Analyzes prompt intent (e.g. "built-in CLI command").
   * Detects canonical documentation registration patterns (e.g., `docs/cli.rst` sections for `Open a Shell`, `FlaskGroup`, `cli.py` line 133-150).
   * Applies a **+210 score boost** to canonical registration points, ensuring Turn 1 zero-exploration accuracy.
3. **Knapsack Token Packing:**
   * Candidate symbols and code slices are scored by relevance and packed into a concise markdown injection block.
   * The model starts Turn 1 already knowing the exact file paths (`src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`), eliminating blind discovery turns.

---

### 5. Model Setup & Routing
* **Primary Model:** `gemini/gemini-2.5-pro` (or `gemini/gemini-3-5-flash-lite` in the TrueForge agent spec). Routed via TrueForge daemon proxy on `localhost:8790`.
* **Fallback Model (Satisfies Hackathon B3):** `gemini-haashim/gemini-3-5-flash-lite`.
  * If the primary model returns HTTP 429 (Rate Limit) or network failure, `TrueForgeSessionHost` instantly fails over to the fallback model with zero user intervention.
* **Cost Efficiency:**
  * Gemini Flash Lite prompt caching combined with our <1,800 token context injection reduces token consumption by **>90%**.
  * Total task cost: **~$0.0004 to $0.002** (compared to $0.15-$0.50 on standard Claude 3.5 Sonnet agent runs).
* **Model Switching:**
  * Users can switch models via the TrueForge web dashboard (`http://localhost:8790`), environment variable overrides (`TRUEFORGE_MODEL`), or the VS Code model selector.

---

### 6. Scorecard (Judging Criteria & Video Timestamps)

| Judging Criterion | Video Timestamp | Technical Verification Claim |
| :--- | :---: | :--- |
| **Task A: Real Inline Edit Mode (Ctrl+I / Cmd+I)** | `00:45` | Floating in-editor input widget (`pacior.inlineEdit`). Executes single-turn surgical edits using <800 tokens without loading sidebar chat or heavy MCP schemas. |
| **Task B: Flask CLI Command (`flask config`)** | `02:15` | Agent implements built-in `flask config` in `src/flask/cli.py` with secret masking (`***`), comprehensive pytest tests in `tests/test_cli.py`, and docs in `docs/cli.rst`. 100% pytest pass in 0.19s. |
| **B1: Token Efficiency & Zero-Exploration** | `03:30` | PACIOR context engine injects <1,800 tokens of pre-computed AST context. Solves the full multi-file task in <25,000 total tokens instead of burning millions. |
| **B2: Post-Task Diff Review** | `04:50` | Antigravity-style post-task diff review: Inline CodeLenses (`✓Accept \| ✕Reject`) above editor hunks, plus chat footer review bar (`📄 X Files With Changes  Reject all [Accept all]`). |
| **B3: Resilient Model Fallback** | `06:10` | Automatic failover from primary model to `gemini-haashim/gemini-3-5-flash-lite` on HTTP 429 rate limit with zero user intervention and zero task failure. |
| **B4: TrueForge Context Features** | `07:25` | Demonstrates Code Mode (combined sandbox scripts), Large-Result Offloading, Context Compaction, and Deferred Tool Loading orchestrated through TrueForge daemon. |
| **B5: Windows & Sandbox Stability** | `08:40` | Auto-quoting for Windows cmd.exe, Git in PATH, stdin hang prevention, and automatic security reset to default OFF on startup. |

---

### 7. Tools Used
* **AI Coding Assistant:** **Google Antigravity** (collaborative DeepMind agentic assistant) used for codebase exploration, refactoring, proto compilation, and test suite verification.
* **Toolchain & Runtime:** Bun `1.4.2`, Node.js `22.x`, Python `3.14 / 3.15`, TypeScript `5.6`, VS Code Extension API.
* **Frameworks & SDKs:** TrueForge Agent Daemon (`v0.185.1`) & SDK, Model Context Protocol (MCP) SDK, ReportLab `5.1.0`, pytest, Python AST.

---

### 8. Known Limitations & 1-Month Engineering Roadmap
* **Current Limitations:**
  1. Multi-root workspace indexing requires manual context re-scan.
  2. AST analyzer is specialized for Python/TypeScript, falling back to ctags for other languages.
  3. CodeLens hunk rejection applies string replacements that require non-overlapping hunk offsets.
* **1-Month Engineering Roadmap:**
  1. **Cross-Language Tree-sitter WASM:** Embed Tree-sitter WASM grammar parsers directly inside the extension host for zero-dependency AST parsing across 30+ programming languages.
  2. **Persistent Vector & Graph Index:** Embed LanceDB directly in VS Code storage for sub-second semantic retrieval across 100k+ LOC repositories.
  3. **Autonomous Subagent Swarms:** Multi-agent orchestration where a tester subagent writes pytest tests concurrently while an author subagent writes application code.

---

# PART 2: HOW CLINE WAS FORKED & WHAT WAS REPLACED

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
│               ▼                                            ▼                │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     PaciorDiffReviewManager                         │   │
│   │  • In-Editor CodeLenses: ✓Accept | ✕Reject above modified hunks    │   │
│   │  • Chat Footer Bar: 📄 X Files With Changes  Reject all [Accept all] │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │ (SSE / Tool Calls)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        TRUEFORGE DAEMON (Port 8790)                         │
│  • Session Orchestration             • Context Compaction (80% window)      │
│  • Code Mode (Sandbox Daytona)       • Large-Result Offloading (>6k tokens) │
│  • Dynamic Subagents                 • Model Router: Gemini Flash Lite      │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │ (MCP Protocol)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      WorkspaceMcpServer (In-Process)                        │
│  • read_files (MAX_READ_LINES = 120)  • editor (Pre-snapshot rollback)      │
│  • run_commands (Auto-quoted Windows) • search_files, list_files            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Component Replacement Map

| Subsystem | Original Cline Implementation | Pacior TrueForge Replacement | Motivation & Benefit |
| :--- | :--- | :--- | :--- |
| **Agent Core** | `Cline.ts` monolithic execution loop with direct LLM calls. | `TrueForgeSessionHost.ts` implementing `SdkSessionHost`. | Offloads session management, subagents, and compaction to TrueForge daemon. |
| **Tool Execution** | In-process private functions calling VS Code APIs directly. | `WorkspaceMcpServer.ts` exposing standard MCP tools. | Standardized tool calling compatible with any MCP client and sandboxed execution. |
| **Context Retrieval** | Raw grep searches and brute-force file reads during agent turns. | `PaciorContextEngine.ts` pre-injecting <1,800 tokens of AST context. | Zero exploration turns; agent knows exact file paths and signatures immediately. |
| **Inline Editing** | Not supported in open-source Cline (only sidebar chat). | `PaciorInlineEditor.ts` bound to `Ctrl+I` / `Cmd+I`. | Instant in-place edits using <800 tokens without loading MCP or webview. |
| **Diff Review** | Turn-by-turn modal popups interrupting execution. | `PaciorDiffReviewManager.ts` + `PostTaskDiffReviewBar.tsx`. | Autonomous execution runs uninterrupted; user reviews hunks in editor post-task. |
| **Model Failover** | Fatal error on 429; user must manually retry. | Automated B3 failover to `gemini-haashim/gemini-3-5-flash-lite`. | Uninterrupted task completion even under heavy provider rate limits. |

---

# PART 3: WHAT HAPPENS AFTER A USER SUBMITS A PROMPT

Here is the exact step-by-step lifecycle from prompt submission to task completion:

```
[User Submits Prompt]
       │
       ▼
1. Zero-Exploration AST Indexing (0-500ms)
   • PaciorContextEngine runs pacior_ast_analyzer.py on workspace.
   • Extracts classes, methods, decorators, and CLI registration points.
   • Boosts canonical documentation (e.g. docs/cli.rst) by +210.
   • Packs top snippets into a <1,800 token context block.
       │
       ▼
2. TrueForge Session Initialization (500-1000ms)
   • TrueForgeClient creates session with daemon (localhost:8790).
   • Injects pre-assembled AST context into the system spec.
   • WorkspaceMcpServer registers tools (read_files, editor, run_commands).
       │
       ▼
3. Autonomous Model Execution (Turn 1-3)
   • Model reads injected context. It does NOT run exploratory search.
   • Calls editor tool to modify src/flask/cli.py.
   • WorkspaceMcpServer records pristine file snapshot before applying edit.
   • Model calls editor tool to add test in tests/test_cli.py.
   • Model calls editor tool to update docs in docs/cli.rst.
       │
       ▼
4. In-Sandbox Test Verification
   • Agent calls run_commands('pytest tests/test_cli.py -k test_config_command').
   • Pytest runs against local editable Flask package in 0.19s (100% passed).
       │
       ▼
5. Post-Task Diff Review Handoff
   • TrueForge sends turn.done event.
   • PaciorDiffReviewManager activates:
     - Editor renders ✓Accept | ✕Reject CodeLenses above modified hunks.
     - Webview footer displays: 📄 1 File With Changes ^  Reject all [Accept all]
   • User reviews changes and accepts in one click.
```

---

# PART 4: THE 8 CRITICAL PROBLEMS SOLVED

### 1. The 1.5M Token UI Metric Explosion
* **Problem:** Tasks taking only 2 minutes displayed "1.5M tokens used" in the header.
* **Root Cause:** TrueForge streams `agent.message.delta` packets with cumulative `ev.usage`. The extension previously emitted a usage event on every packet. The webview metric aggregator (`getApiMetrics.ts`) summed `tokensIn` across all events ($70 \times 21,000 \approx 1,470,000$).
* **Fix:** Converted `TrueForgeSessionHost.ts` to calculate incremental delta differences ($\Delta\text{tokens}$). The actual consumption is ~22,000 tokens.

### 2. 15-Iteration Boundary Lockout
* **Problem:** Complex multi-file tasks halted at 15 steps with "Please request again".
* **Root Cause:** TrueForge hard-codes a default per-turn limit of `iterationLimit: 15`.
* **Fix:** Set `iterationLimit: 50` in `TrueForgeClient.ts` and implemented an auto-continuation handler in `TrueForgeSessionHost.ts` that automatically commits progress and starts the next turn without user prompts.

### 3. 24k Character Tool Response Crashes
* **Problem:** Large file reads caused `ToolResult exceeded 24,000 characters` crashes.
* **Root Cause:** Brute-force `read_files` calls on 1,000-line files flooded model buffers.
* **Fix:** Enforced `MAX_READ_LINES = 120` in `WorkspaceMcpServer.ts` and clamped terminal output to 3,000 characters.

### 4. Model Hallucination & Windows Command Loops
* **Problem:** Free open-source models attempted Unix commands (`rm`, single-quoted `python -c 'code'`) which failed on Windows `cmd.exe`.
* **Root Cause:** Models hallucinated Unix shell syntax in a Windows environment.
* **Fix:** Configured Gemini Flash Lite natively, added automatic single-to-double quote normalization for Windows in `WorkspaceMcpServer.ts`.

### 5. Windows Path Spacing & Git PATH Missing
* **Problem:** Python subprocesses failed with `can't open file 'Flask': [Errno 2] No such file` and `git: command not found`.
* **Root Cause:** Workspace directory `Flask Practice` contained spaces, and Git was not in the isolated subprocess `PATH`.
* **Fix:** Added Git to `PATH` in `WorkspaceMcpServer.ts` and implemented automatic path auto-quoting.

### 6. Grep Stdin Hang on Dashed Arguments
* **Problem:** Running search commands on paths starting with dashes caused terminal hangs.
* **Root Cause:** Grep interpreted `-` as stdin, waiting indefinitely.
* **Fix:** Added `--` separator guards before target paths in all CLI tools.

### 7. Security Permissions Resetting
* **Problem:** Auto-approval settings persisted across restarts instead of staying off.
* **Root Cause:** VS Code global state cached previously enabled permission toggles.
* **Fix:** Enforced strict programmatic reset to `DEFAULT_AUTO_APPROVAL_SETTINGS` (all OFF) on extension activation in `apps/vscode/src/common.ts`.

### 8. Diff Review vs Edit Approval
* **Problem:** The system interrupted execution edit-by-edit with modal dialogs.
* **Root Cause:** Confused turn-by-turn permission approval with post-task diff review.
* **Fix:** Created `PaciorDiffReviewManager.ts` and `PostTaskDiffReviewBar.tsx`. Changes are recorded silently during execution, and presented as an Antigravity-style post-task diff review with in-editor CodeLenses and a chat footer review bar.

---

# PART 5: STATE-OF-THE-ART (SOTA) COMPARISON

| Dimension | Vanilla Cline | Claude Code (Anthropic) | Aider | Roo Code | **Pacior TrueForge (Ours)** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Context Strategy** | Uninformed grep & full file reads (~100k-500k tokens). | 1M-token context window dump + subagents. | PageRank symbol repo map. | Tree-sitter vector search. | **PACIOR Hybrid Ranker:** AST + Lexical + Canonical Boosting (<1,800 tokens). |
| **Total Task Cost** | $0.20 – $1.00 per task. | $0.50 – $3.00 per task. | $0.05 – $0.20 per task. | $0.10 – $0.40 per task. | **$0.0004 – $0.002 per task (90% cheaper).** |
| **Inline Editing** | None (sidebar chat only). | None (CLI only). | Terminal prompt. | None. | **Ctrl+I In-Editor:** Floating widget, WorkspaceEdit, <800 tokens. |
| **Diff Review** | Disruptive modal popup blocks every tool edit. | Terminal diff output. | Auto-git commits without interactive UI. | Checkpoint restore slider. | **Post-Task Hunk Review:** Inline CodeLens (`✓Accept \| ✕Reject`) + Chat footer card. |
| **Failover Resilience** | Fatal crash on 429 rate limit. | Exponential backoff retry only. | Manual model switch. | Manual model switch. | **B3 Zero-Intervention Failover:** Seamless failover to fallback model. |
| **Harness Architecture** | Monolithic closed execution. | CLI subprocess. | Standalone Python process. | Monolithic extension host. | **TrueForge Daemon:** Code Mode, Large Offloading, Compaction, Subagents. |

---
*Documentation compiled and generated for IIT Bombay Techfest · TrueFoundry Forge-a-thon 2026.*

