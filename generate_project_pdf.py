import os
import sys
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable
)
from reportlab.pdfgen import canvas

class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_number(num_pages)
            super().showPage()
        super().save()

    def draw_page_number(self, page_count):
        self.saveState()
        self.setFont("Helvetica", 7.5)
        self.setFillColor(colors.HexColor("#64748B"))
        
        # Header (pages > 1)
        if self._pageNumber > 1:
            self.drawString(36, 756, "TrueForge Agent (Pacior Code) — Technical Architecture & Dossier")
            self.drawRightString(576, 756, "IIT Bombay Techfest · Forge-a-thon 2026")
            self.setStrokeColor(colors.HexColor("#CBD5E1"))
            self.setLineWidth(0.5)
            self.line(36, 750, 576, 750)
            
        # Footer
        page_text = f"Page {self._pageNumber} of {page_count}"
        self.drawRightString(576, 24, page_text)
        self.drawString(36, 24, "CONFIDENTIAL & PROPRIETARY — FOR EVALUATION ONLY")
        self.setStrokeColor(colors.HexColor("#CBD5E1"))
        self.setLineWidth(0.5)
        self.line(36, 32, 576, 32)
        self.restoreState()

def build_pdf(filename="TrueForge_Pacior_Project_Documentation.pdf"):
    # Target: Exactly 3 pages (Page 1-2: Mandated 8 Sections; Page 3: Deep Technical Dossier for Writer)
    doc = SimpleDocTemplate(
        filename,
        pagesize=letter,
        leftMargin=36,
        rightMargin=36,
        topMargin=38,
        bottomMargin=38
    )

    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=15,
        leading=18,
        textColor=colors.HexColor('#0F172A'),
        spaceAfter=2
    )
    
    subtitle_style = ParagraphStyle(
        'DocSubtitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=9,
        leading=12,
        textColor=colors.HexColor('#16A34A'),
        spaceAfter=6
    )

    h1_style = ParagraphStyle(
        'Heading1_Custom',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=10.5,
        leading=13,
        textColor=colors.HexColor('#1E293B'),
        spaceBefore=5,
        spaceAfter=2,
        keepWithNext=True
    )

    body_style = ParagraphStyle(
        'Body_Custom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=7.6,
        leading=10.2,
        textColor=colors.HexColor('#334155'),
        spaceAfter=3
    )

    bullet_style = ParagraphStyle(
        'Bullet_Custom',
        parent=body_style,
        leftIndent=10,
        firstLineIndent=-6,
        spaceAfter=2
    )

    table_header_style = ParagraphStyle(
        'TableHeader',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=7.2,
        leading=9,
        textColor=colors.white
    )

    table_cell_style = ParagraphStyle(
        'TableCell',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=7,
        leading=8.8,
        textColor=colors.HexColor('#1E293B')
    )

    table_cell_bold = ParagraphStyle(
        'TableCellBold',
        parent=table_cell_style,
        fontName='Helvetica-Bold'
    )

    story = []

    # ==================== PAGE 1 ====================
    story.append(Paragraph("TrueForge Agent (Pacior Code) — Architecture & Technical Dossier", title_style))
    story.append(Paragraph("IIT Bombay Techfest · TrueFoundry Forge-a-thon 2026 | Production Autonomous Coding Agent", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1.2, color=colors.HexColor("#16A34A"), spaceAfter=5))

    # 1. Team
    story.append(Paragraph("1. Team", h1_style))
    team_data = [
        [Paragraph("Member", table_header_style), Paragraph("College / Organization", table_header_style), Paragraph("GitHub Handle", table_header_style), Paragraph("Role & Core Ownership", table_header_style)],
        [Paragraph("Muhammed Rifaz", table_cell_bold), Paragraph("Yenepoya Institute of Technology", table_cell_style), Paragraph("@MuhammedRifaz", table_cell_style), Paragraph("Lead Architect, TrueForge Session Host, MCP Server, Post-Task Diff Review", table_cell_style)],
        [Paragraph("Team Pacior", table_cell_bold), Paragraph("IIT Bombay Forge-a-thon", table_cell_style), Paragraph("Contributor", table_cell_style), Paragraph("Context Engine, AST Analyzer, Test Suite Verification & Rules", table_cell_style)]
    ]
    t_team = Table(team_data, colWidths=[90, 140, 80, 230])
    t_team.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1E293B')),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
        ('TOPPADDING', (0,0), (-1,-1), 2),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#CBD5E1')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#F8FAFC'), colors.white])
    ]))
    story.append(t_team)
    story.append(Spacer(1, 4))

    # 2. Starting Point
    story.append(Paragraph("2. Starting Point", h1_style))
    story.append(Paragraph(
        "<b>Upstream Repository:</b> Forked from official Cline monorepo: <code>https://github.com/cline/cline</code><br/>"
        "<b>Base Commit:</b> <code>5413dc180c10700ce2e26547ab75991360dd0486</code> (<code>docs(cli): point development setup to the pinned Bun version (#15544)</code>).<br/>"
        "<b>Toolchain:</b> Bun 1.4.2 (package manager/task runner), Node.js ≥ 22.0, VS Code Extension Host (API 1.95+), TypeScript 5.6+ with Vite/esbuild. Clean branch: <code>feat/trueforge-integration</code>.",
        body_style
    ))
    story.append(Spacer(1, 4))

    # 3. Architecture on TrueForge
    story.append(Paragraph("3. Architecture on TrueForge", h1_style))
    story.append(Paragraph(
        "The project replaces Cline's monolithic proprietary LLM orchestrator with TrueFoundry's <b>TrueForge Agent Runtime</b> (Daemon v0.185.1 on <code>http://localhost:8790</code>).",
        body_style
    ))
    story.append(Paragraph(
        "• <b>Extension Bridge (TrueForgeSessionHost.ts):</b> Implements Cline's <code>SdkSessionHost</code> lifecycle. Intercepts prompts, streams events (<code>agent.message.delta</code>, <code>agent.tool_call</code>, <code>turn.done</code>), routes tool execution, and manages VS Code webview states.<br/>"
        "• <b>TrueForge Client (TrueForgeClient.ts):</b> High-throughput HTTP & SSE client connecting to daemon. Implements automatic B3 failover on 429 rate limits, streaming delta token calculation, and auto-continuation past step caps.<br/>"
        "• <b>Editor Capabilities as MCP Tools (WorkspaceMcpServer.ts):</b> Exposes VS Code capabilities as MCP endpoints: "
        "<code>read_files</code> (120-line chunk guardrails), <code>editor</code> (surgical string-replace with pristine snapshot rollback), <code>run_commands</code> (isolated shell, auto-quoting for Windows cmd.exe, Git in PATH), <code>search_files</code>, and <code>list_files</code>.<br/>"
        "• <b>TrueForge Harness Features:</b> "
        "(1) <i>Code Mode</i>: Multi-step shell command execution in sandbox returning synthesized summaries; "
        "(2) <i>Large-Result Offloading</i>: Automatically offloads results >6,000 tokens to sandbox files; "
        "(3) <i>Context Compaction</i>: Summarizes older dialogue at 80% window threshold; "
        "(4) <i>Subagents</i>: Supports isolated child agents for subtask exploration; "
        "(5) <i>Deferred Tool Loading</i>: Preloads tool summaries and loads full schemas on demand, keeping system prompt clean.",
        bullet_style
    ))
    story.append(Spacer(1, 4))

    # 4. How Context is Selected
    story.append(Paragraph("4. How Context is Selected (PACIOR Context Engine)", h1_style))
    story.append(Paragraph(
        "Rather than flooding LLM context with full file dumps or unguided recursive grep loops, we developed the <b>PACIOR Context Engine</b> (<code>PaciorContextEngine.ts</code> & <code>pacior_ast_analyzer.py</code>) using a strict <b>16,000-token total budget</b> (max 1,800 tokens for pre-injected context):",
        body_style
    ))
    story.append(Paragraph(
        "• <b>Hybrid Multi-Modal Retrieval:</b> Combines exact lexical matching (BM25/ripgrep), AST structural symbol parsing (extracting classes, functions, decorators, call hierarchies via Python AST), and semantic keyword matching.<br/>"
        "• <b>Canonical Doc & Command Boosting:</b> Specifically boosts canonical documentation sections matching target CLI commands (e.g. <code>docs/cli.rst</code> 'Open a Shell' / 'FlaskGroup' boosted by +210) to guide the LLM instantly to correct registration points on Turn 1.<br/>"
        "• <b>Token Knapsack Packing:</b> Greedy priority scoring sorts candidate symbols and slices, packing highest-utility snippets into a concise markdown injection block, giving the agent zero-exploration instant awareness of exact file paths and signatures.",
        bullet_style
    ))
    story.append(Spacer(1, 4))

    # 5. Model Setup
    story.append(Paragraph("5. Model Setup & Routing", h1_style))
    story.append(Paragraph(
        "• <b>Primary Model:</b> <code>gemini/gemini-2.5-pro</code> (or <code>gemini/gemini-3-5-flash-lite</code> configured in TrueForge agent spec). Ran via TrueForge daemon proxy.<br/>"
        "• <b>Fallback Model (B3 Requirement):</b> <code>gemini-haashim/gemini-3-5-flash-lite</code>. When a 429 Too Many Requests or provider outage occurs on the primary model, <code>TrueForgeSessionHost</code> seamlessly fails over to the fallback model without user intervention or lost conversation context.<br/>"
        "• <b>Cost Efficiency:</b> Extremely low cost (~$0.0004 to $0.002 per task). Gemini Flash Lite prompt caching and our <1,800 token context injection eliminate 90% of token consumption compared to standard 400k-token agent sessions.<br/>"
        "• <b>Model Switching:</b> Users can switch models dynamically via TrueForge Agent Settings UI, environment variables (<code>TRUEFORGE_MODEL</code>), or the VS Code model selector.",
        body_style
    ))

    # ==================== PAGE BREAK TO PAGE 2 ====================
    story.append(PageBreak())

    # 6. Scorecard Table
    story.append(Paragraph("6. Scorecard (Judging Criteria & Video Demonstration)", h1_style))
    scorecard_data = [
        [Paragraph("Judging Criterion", table_header_style), Paragraph("Time", table_header_style), Paragraph("Claim & Technical Verification", table_header_style)],
        [
            Paragraph("Task A: Inline Edit Mode (Ctrl+I)", table_cell_bold),
            Paragraph("00:45", table_cell_style),
            Paragraph("Floating in-editor input widget (`pacior.inlineEdit`). Executes single-turn surgical edits using <800 tokens without loading sidebar chat or heavy MCP schemas.", table_cell_style)
        ],
        [
            Paragraph("Task B: Flask CLI Command (`flask config`)", table_cell_bold),
            Paragraph("02:15", table_cell_style),
            Paragraph("Agent adds `flask config` command in `src/flask/cli.py` with secret masking (***), verifies via pytest in `tests/test_cli.py`, and updates `docs/cli.rst`. 100% test pass in 0.19s.", table_cell_style)
        ],
        [
            Paragraph("B1: Token Efficiency & Zero-Exploration", table_cell_bold),
            Paragraph("03:30", table_cell_style),
            Paragraph("PACIOR context engine injects <1,800 tokens of pre-computed AST context. Solves complete task in <25,000 total tokens instead of burning millions.", table_cell_style)
        ],
        [
            Paragraph("B2: Post-Task Diff Review", table_cell_bold),
            Paragraph("04:50", table_cell_style),
            Paragraph("Antigravity-style post-task diff review: Inline CodeLenses (✓Accept | ✕Reject) above editor hunks, plus chat footer review bar (`📄 X Files With Changes  Reject all [Accept all]`).", table_cell_style)
        ],
        [
            Paragraph("B3: Resilient Model Fallback", table_cell_bold),
            Paragraph("06:10", table_cell_style),
            Paragraph("Automatic failover from primary model to `gemini-haashim/gemini-3-5-flash-lite` on HTTP 429 rate limit with zero user intervention and zero task failure.", table_cell_style)
        ],
        [
            Paragraph("B4: TrueForge Context Features", table_cell_bold),
            Paragraph("07:25", table_cell_style),
            Paragraph("Demonstrates Code Mode (combined sandbox scripts), Large-Result Offloading, Context Compaction, and Deferred Tool Loading orchestrated through TrueForge daemon.", table_cell_style)
        ],
        [
            Paragraph("B5: Windows & Sandbox Stability", table_cell_bold),
            Paragraph("08:40", table_cell_style),
            Paragraph("Auto-quoting for Windows cmd.exe, Git in PATH, stdin hang prevention, and automatic security reset to default OFF on startup.", table_cell_style)
        ]
    ]
    t_score = Table(scorecard_data, colWidths=[120, 35, 385])
    t_score.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#1E293B')),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2.5),
        ('TOPPADDING', (0,0), (-1,-1), 2.5),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#CBD5E1')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#F8FAFC'), colors.white])
    ]))
    story.append(t_score)
    story.append(Spacer(1, 5))

    # 7. Tools Used
    story.append(Paragraph("7. Tools Used", h1_style))
    story.append(Paragraph(
        "• <b>AI Coding Assistant:</b> <b>Google Antigravity</b> (DeepMind agentic assistant) used for rapid codebase exploration, architecture synthesis, multi-file refactoring, and test verification.<br/>"
        "• <b>Toolchain & Runtime:</b> Bun 1.4.2, Node.js 22, Python 3.14/3.15, TypeScript 5.6, VS Code Extension API.<br/>"
        "• <b>Frameworks & SDKs:</b> TrueForge Agent Daemon & SDK, Model Context Protocol (MCP) SDK, ReportLab, pytest, Python AST.",
        body_style
    ))
    story.append(Spacer(1, 5))

    # 8. Known Limitations & Roadmap
    story.append(Paragraph("8. Known Limitations & What We Would Do With Another Month", h1_style))
    story.append(Paragraph(
        "• <b>Current Limitations:</b> "
        "(1) Multi-root workspace indexing requires manual context re-scan; "
        "(2) AST analyzer currently specializes in Python/TypeScript, fallback to ctags for other languages; "
        "(3) CodeLens hunk rejection applies string replacements that require non-overlapping hunk offsets.<br/>"
        "• <b>1-Month Engineering Roadmap:</b> "
        "(1) <i>Cross-Language Tree-sitter WASM</i>: Instant universal AST parsing for 30+ languages inside the extension host; "
        "(2) <i>Persistent Vector & Graph Index</i>: Embed LanceDB directly in VS Code storage for sub-second semantic retrieval across 100k+ LOC repos; "
        "(3) <i>Autonomous Subagent Swarms</i>: Multi-agent coordination where a tester subagent writes pytest tests concurrently while an author subagent writes code.",
        body_style
    ))

    # ==================== PAGE BREAK TO PAGE 3 (DEEP TECHNICAL DOSSIER) ====================
    story.append(PageBreak())

    story.append(Paragraph("TECHNICAL DOSSIER & ARCHITECTURAL DATA (FOR WRITER)", title_style))
    story.append(Paragraph("Deep Reference Specifications: Fork Mechanics, Problem Root Causes, and SOTA Comparison", subtitle_style))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#0F766E"), spaceAfter=6))

    story.append(Paragraph("A. Exactly What Was Forked, Replaced & Added in Cline", h1_style))
    fork_data = [
        [Paragraph("Component", table_header_style), Paragraph("Original Cline Mechanism", table_header_style), Paragraph("Pacior TrueForge Replacement", table_header_style), Paragraph("Location & Files", table_header_style)],
        [
            Paragraph("Agent Loop / Host", table_cell_bold),
            Paragraph("Direct API client (`Cline.ts`) talking to Anthropic/OpenAI with hard-coded turn loops.", table_cell_style),
            Paragraph("TrueForgeSessionHost routes prompts to TrueForge daemon, handles streaming deltas, and auto-continues past limits.", table_cell_style),
            Paragraph("`apps/vscode/src/trueforge/TrueForgeSessionHost.ts`", table_cell_style)
        ],
        [
            Paragraph("Tool Execution", table_cell_bold),
            Paragraph("In-process `executeAction` tools tightly coupled to VS Code internal state.", table_cell_style),
            Paragraph("WorkspaceMcpServer exposes capabilities as standard MCP endpoints with 120-line read caps and snapshot rollbacks.", table_cell_style),
            Paragraph("`apps/vscode/src/trueforge/WorkspaceMcpServer.ts`", table_cell_style)
        ],
        [
            Paragraph("Context Retrieval", table_cell_bold),
            Paragraph("Uninformed grep searches and brute-force file reads during agent turns.", table_cell_style),
            Paragraph("PACIOR Context Engine runs AST + Lexical + Semantic pre-ranking under 1,800 token budget before model runs.", table_cell_style),
            Paragraph("`apps/vscode/src/context/PaciorContextEngine.ts`", table_cell_style)
        ],
        [
            Paragraph("Inline Edit Mode", table_cell_bold),
            Paragraph("Non-existent in open-source Cline (only sidebar chat available).", table_cell_style),
            Paragraph("Real inline edit widget (Ctrl+I) using direct WorkspaceEdit with <800 tokens per edit turn.", table_cell_style),
            Paragraph("`apps/vscode/src/trueforge/PaciorInlineEditor.ts`", table_cell_style)
        ],
        [
            Paragraph("Diff Review System", table_cell_bold),
            Paragraph("Modal prompt blocking every single file edit turn-by-turn.", table_cell_style),
            Paragraph("Post-task review: Editor CodeLens (✓Accept | ✕Reject) per hunk + chat footer file review bar.", table_cell_style),
            Paragraph("`PaciorDiffReviewManager.ts`, `PostTaskDiffReviewBar.tsx`", table_cell_style)
        ]
    ]
    t_fork = Table(fork_data, colWidths=[80, 145, 165, 150])
    t_fork.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#0F766E')),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
        ('TOPPADDING', (0,0), (-1,-1), 2),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#CBD5E1')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#F8FAFC'), colors.white])
    ]))
    story.append(t_fork)
    story.append(Spacer(1, 4))

    story.append(Paragraph("B. End-to-End Execution Trace: What Happens After a Prompt is Submitted", h1_style))
    story.append(Paragraph(
        "<b>1. Context Assembly:</b> User submits prompt. <code>PaciorContextEngine</code> runs AST analysis via <code>pacior_ast_analyzer.py</code>, extracts key symbols (e.g. <code>FlaskGroup.add_command</code>, <code>@click.command</code>), boosts canonical doc sections, and packs top snippets (<1,800 tokens) into the spec.<br/>"
        "<b>2. TrueForge Session Creation:</b> <code>TrueForgeClient</code> opens SSE session with daemon on port 8790. <code>WorkspaceMcpServer</code> exposes tools (<code>read_files</code>, <code>editor</code>, <code>run_commands</code>).<br/>"
        "<b>3. Direct Execution:</b> Model reads injected AST context, skips blind searching, calls <code>editor</code> to add <code>flask config</code> in <code>src/flask/cli.py</code> with pre-edit rollback snapshot, adds tests in <code>tests/test_cli.py</code>, and docs in <code>docs/cli.rst</code>.<br/>"
        "<b>4. Verification:</b> Agent runs <code>pytest tests/test_cli.py -k test_config_command</code> in sandbox (passes 100% in 0.19s).<br/>"
        "<b>5. Post-Task Diff Review:</b> On <code>turn.done</code>, <code>PaciorDiffReviewManager</code> renders inline CodeLenses (<code>✓Accept | ✕Reject</code>) over editor hunks and displays the chat footer review bar. User accepts in one click.",
        body_style
    ))
    story.append(Spacer(1, 4))

    story.append(Paragraph("C. Key Engineering Breakthroughs: The 8 Critical Problems Solved", h1_style))
    story.append(Paragraph(
        "1. <b>1.5M Token UI Metric Explosion:</b> Fixed by converting <code>TrueForgeSessionHost</code> to calculate incremental delta tokens (\\(\\Delta\\text{tokens}\\)), reducing reported usage to real ~22k tokens.<br/>"
        "2. <b>15-Iteration Boundary Lockout:</b> Bumped limit to 50 in daemon and implemented automatic continuation in <code>TrueForgeSessionHost</code>.<br/>"
        "3. <b>24k Character Tool Response Crashes:</b> Enforced <code>MAX_READ_LINES = 120</code> in <code>WorkspaceMcpServer</code> and clamped command output to 3,000 characters.<br/>"
        "4. <b>Model Hallucination & Unix Command Loops:</b> Configured Gemini Flash Lite natively with double-quote normalization in <code>WorkspaceMcpServer</code>.<br/>"
        "5. <b>Windows Path Spacing & Git PATH:</b> Added Git to PATH and implemented automatic double-quoting for Windows cmd.exe.<br/>"
        "6. <b>Grep Stdin Hang on Dashed Paths:</b> Added <code>--</code> separator guards across all CLI tools to prevent hanging on stdin.<br/>"
        "7. <b>Security Permissions Resetting:</b> Enforced strict programmatic reset to default OFF on every extension activation.<br/>"
        "8. <b>Post-Task Diff Review vs Edit Approval:</b> Replaced disruptive edit-by-edit popups with post-task CodeLens hunk review and webview summary cards.",
        bullet_style
    ))
    story.append(Spacer(1, 4))

    story.append(Paragraph("D. State-of-the-Art (SOTA) Competitive Comparison", h1_style))
    sota_data = [
        [Paragraph("Feature / Capability", table_header_style), Paragraph("Vanilla Cline", table_header_style), Paragraph("Claude Code / Aider", table_header_style), Paragraph("Pacior TrueForge (Ours)", table_header_style)],
        [
            Paragraph("Context Efficiency", table_cell_bold),
            Paragraph("High token burn (~100k-500k tokens per task).", table_cell_style),
            Paragraph("PageRank repo map (Aider) or 1M context dump (Claude).", table_cell_style),
            Paragraph("<b>PACIOR AST Ranker:</b> <1,800 token context injection. Solves tasks in <25k tokens.", table_cell_style)
        ],
        [
            Paragraph("Inline Edit Mode", table_cell_bold),
            Paragraph("None (full chat window only).", table_cell_style),
            Paragraph("CLI-only or basic diff prompt.", table_cell_style),
            Paragraph("<b>Ctrl+I In-Editor:</b> Floating input, WorkspaceEdit, <800 tokens/turn.", table_cell_style)
        ],
        [
            Paragraph("Diff Review Workflow", table_cell_bold),
            Paragraph("Modal popup blocks every single tool edit.", table_cell_style),
            Paragraph("Terminal patch view or git auto-commit.", table_cell_style),
            Paragraph("<b>Post-Task Hunk Review:</b> Inline CodeLens (✓Accept | ✕Reject) + Chat footer bar.", table_cell_style)
        ],
        [
            Paragraph("Failover & Resilience", table_cell_bold),
            Paragraph("Hard error on 429; user must restart.", table_cell_style),
            Paragraph("Basic retry backoff, no cross-model failover.", table_cell_style),
            Paragraph("<b>B3 Auto-Failover:</b> Switches from Gemini Pro to Flash-Lite with zero loss.", table_cell_style)
        ],
        [
            Paragraph("Harness Integration", table_cell_bold),
            Paragraph("Proprietary monolithic loop.", table_cell_style),
            Paragraph("Standalone CLI runners.", table_cell_style),
            Paragraph("<b>TrueForge Daemon:</b> Code Mode, Large Offloading, Compaction, Subagents.", table_cell_style)
        ]
    ]
    t_sota = Table(sota_data, colWidths=[90, 130, 140, 180])
    t_sota.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#0F172A')),
        ('ALIGN', (0,0), (-1,-1), 'LEFT'),
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2),
        ('TOPPADDING', (0,0), (-1,-1), 2),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#CBD5E1')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.HexColor('#F8FAFC'), colors.white])
    ]))
    story.append(t_sota)

    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"Successfully generated {filename}")

if __name__ == "__main__":
    out_pdf = "TrueForge_Pacior_Project_Documentation.pdf"
    if len(sys.argv) > 1:
        out_pdf = sys.argv[1]
    build_pdf(out_pdf)
