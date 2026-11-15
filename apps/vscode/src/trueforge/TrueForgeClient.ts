import { TrueForge, type TrueForgeApi, TrueForgeError, TrueForgeTimeoutError } from "@truefoundry/trueforge-sdk"
import { Logger } from "@/shared/services/Logger"

export const DEFAULT_TRUEFORGE_BASE_URL = "http://localhost:8790"
export const DEFAULT_TRUEFORGE_AGENT_NAME = "pacior"
export const VSCODE_MCP_SERVER_NAME = "cline-vscode-workspace"

export interface TrueForgeClientConfig {
	baseUrl?: string
	apiKey?: string
	agentName?: string
}

export interface ResolvedTrueForgeAgent {
	name: string
	spec: TrueForgeApi.AgentSpec
}

export function normalizeBaseUrl(raw?: string): string {
	const candidate = (raw ?? process.env.TRUEFORGE_BASE_URL ?? DEFAULT_TRUEFORGE_BASE_URL).trim()
	return candidate.replace(/\/+$/, "") || DEFAULT_TRUEFORGE_BASE_URL
}

/**
 * Classifies TrueForge and upstream LLM errors into clear, actionable user messages
 * so connection drops, bad keys, and rate limits never freeze the editor.
 */
export function formatTrueForgeError(error: unknown, baseUrl: string): { message: string; status?: number; code?: string } {
	if (error instanceof TrueForgeTimeoutError) {
		return {
			message: `TrueForge request timed out waiting for ${baseUrl}. Check your network connection or try a fallback model.`,
			code: "TRUEFORGE_TIMEOUT",
		}
	}
	if (error instanceof TrueForgeError) {
		const status = error.statusCode
		const bodyText =
			typeof error.body === "object" && error.body !== null && "error" in error.body
				? JSON.stringify((error.body as { error?: unknown }).error)
				: error.message
		if (status === 401 || status === 403) {
			return {
				message: `TrueForge / model provider authentication failed (HTTP ${status}): ${bodyText}. Check your API key in TrueForge Settings -> Models.`,
				status,
				code: "TRUEFORGE_AUTH_ERROR",
			}
		}
		if (status === 429) {
			return {
				message: `Model provider rate limit reached (HTTP 429): ${bodyText}. Wait a moment or switch to another configured model in TrueForge.`,
				status,
				code: "TRUEFORGE_RATE_LIMIT",
			}
		}
		return {
			message: `TrueForge API error${status ? ` (HTTP ${status})` : ""}: ${bodyText}`,
			status,
			code: "TRUEFORGE_API_ERROR",
		}
	}
	const rawMessage = error instanceof Error ? error.message : String(error)
	const lower = rawMessage.toLowerCase()
	if (lower.includes("econnrefused") || lower.includes("fetch failed") || lower.includes("unable to connect")) {
		return {
			message: `Cannot reach TrueForge server at ${baseUrl}. Make sure the TrueForge server is running (e.g. npx @truefoundry/trueforge). Detail: ${rawMessage}`,
			code: "TRUEFORGE_UNREACHABLE",
		}
	}
	return { message: rawMessage, code: "TRUEFORGE_ERROR" }
}

/**
 * Typed client wrapper around @truefoundry/trueforge-sdk for the VS Code extension.
 */
export class TrueForgeClient {
	readonly baseUrl: string
	readonly agentName: string
	private readonly sdk: TrueForge

	constructor(config: TrueForgeClientConfig = {}) {
		this.baseUrl = normalizeBaseUrl(config.baseUrl)
		this.agentName = (config.agentName ?? process.env.TRUEFORGE_AGENT_NAME ?? DEFAULT_TRUEFORGE_AGENT_NAME).trim()
		const apiKey = config.apiKey ?? process.env.TRUEFORGE_API_KEY
		this.sdk = new TrueForge({
			baseUrl: this.baseUrl,
			...(apiKey ? { token: apiKey } : {}),
		})
	}

	/**
	 * Verifies connectivity to TrueForge and lists registered agents.
	 */
	async listAgents(): Promise<TrueForgeApi.Agent[]> {
		const page = await this.sdk.agents.list({ limit: 50 }, { timeoutInSeconds: 10, maxRetries: 0 })
		return page.data
	}

	/**
	 * Lists configured models from TrueForge.
	 */
	async listModels(): Promise<TrueForgeApi.Model[]> {
		const page = await this.sdk.models.list({ timeoutInSeconds: 10, maxRetries: 0 })
		return page.data
	}

	/**
	 * Registers or updates the local VS Code workspace MCP server in TrueForge Settings -> Connectors.
	 */
	async ensureWorkspaceMcpServer(mcpUrl: string, serverName = VSCODE_MCP_SERVER_NAME): Promise<void> {
		await this.sdk.settings.mcpServers.createOrUpdate(
			{
				manifest: {
					name: serverName,
					type: "remote",
					description: "Local VS Code workspace tools (read, search, list, diff-preview edit, and terminal execution)",
					url: mcpUrl,
				},
			},
			{ timeoutInSeconds: 10, maxRetries: 1 },
		)
		Logger.log(`[TrueForgeClient] Registered MCP server "${serverName}" at ${mcpUrl}`)
	}

	/**
	 * Resolves the target TrueForge agent specification (defaulting to `pacior`, or the first
	 * registered agent/model) and attaches the live workspace MCP server + workspace context.
	 */
	async resolveAgentSpec(options: {
		cwd: string
		mode: "plan" | "act"
		mcpServerName?: string
		requireApprovalForTools?: TrueForgeApi.McpServerApprovalToolSelector[]
		preferredAgentName?: string
	}): Promise<ResolvedTrueForgeAgent> {
		const targetName = options.preferredAgentName?.trim() || this.agentName
		const agents = await this.listAgents()
		const matchedAgent =
			agents.find((a) => a.name.toLowerCase() === targetName.toLowerCase()) ??
			agents[0]

		let baseManifest: TrueForgeApi.AgentSpec
		let resolvedName: string

		if (matchedAgent) {
			resolvedName = matchedAgent.name
			baseManifest = { ...matchedAgent.manifest }
		} else {
			const modelsResp = await this.sdk.models.list({ timeoutInSeconds: 10, maxRetries: 0 })
			const firstModel = modelsResp.data[0]
			if (!firstModel) {
				throw new Error(
					`No agents or models are configured in TrueForge (${this.baseUrl}). Open TrueForge Settings -> Models and add a model first.`,
				)
			}
			resolvedName = targetName
			baseManifest = {
				model: { name: firstModel.name },
				instructions: "You are an expert autonomous software engineer working inside Visual Studio Code.",
			}
		}

		const mcpServerName = options.mcpServerName ?? VSCODE_MCP_SERVER_NAME
		const existingMcpServers = (baseManifest.mcpServers ?? []).filter((srv) => srv.name !== mcpServerName)
		const approvalList = options.requireApprovalForTools ?? ["editor", "write_to_file", "run_commands"]
		const workspaceMcpEntry: any = {
			name: mcpServerName,
			preload: true,
			enableTools: ["@all"],
			enable_tools: ["@all"],
			requireApprovalForTools: approvalList,
			require_approval_for_tools: approvalList,
		}

		const isActMode = options.mode !== "plan"
		const modeGuidance =
			options.mode === "plan"
				? "MODE: PLAN MODE — Inspect the codebase and formulate a clear plan before requesting edits."
				: "MODE: ACT MODE — Use your workspace tools to inspect code, propose exact clean edits with editor/write_to_file, and verify with tests via run_commands."

		const workspaceContext = [
			baseManifest.instructions?.trim(),
			"",
			`VS Code Workspace Root: ${options.cwd}`,
			modeGuidance,
			"CRITICAL WORKSPACE EXECUTION RULES (Strict Token & Flow Discipline):",
			"1. ALWAYS use the `editor` MCP tool (or `write_to_file`) to propose changes to workspace files. NEVER attempt to write or edit files using terminal or shell commands (cat, sed, echo, etc.). Proposing edits via `editor` is strictly required so diff previews are rendered in the editor for user review.",
			"2. The Python runtime and all project dependencies (including Flask) are already pre-configured in the workspace. Do NOT attempt to install packages or run package managers (pip, uv, apt).",
			"3. Do NOT run broad filesystem scans (find /, grep -r, ls /opt). Use `read_files` or `search_files` with workspace relative paths.",
			"4. To verify changes with tests, run `pytest tests/test_cli.py -q` using `run_commands`.",
			"5. Anti-Loop Rule: Work concisely and directly: 1) Propose edit in `src/flask/cli.py`, 2) Propose test in `tests/test_cli.py`, 3) Propose doc in `docs/cli.rst`, 4) Run pytest via `run_commands`. Once tests pass, call `finish` with a summary to complete the task.",
			"6. Autonomous Execution: Do NOT call `ask_user_question` or pause to ask permission when you have the task instruction. Proceed directly to inspect code, edit with `editor`, and verify with `pytest`.",
			"7. CONTEXT ENGINEERING & ZERO-WASTE EXECUTION: The initial prompt includes pre-assembled AST focus context identifying the exact target files and line ranges. Do NOT run redundant exploratory reads (`read_files`) or shell searches (`grep`/`find`). Proceed DIRECTLY to proposing edits in the target files with `editor`, verify with `pytest tests/test_cli.py -q` via `run_commands`, and then call `finish`.",
		]
			.filter((line) => line !== undefined)
			.join("\n")
			.trim()

		return {
			name: resolvedName,
			spec: {
				...baseManifest,
				instructions: workspaceContext,
				mcpServers: [...existingMcpServers, workspaceMcpEntry],
				config: {
					...baseManifest.config,
					iteration_limit: 10,
					iterationLimit: 10,
					dynamic_sub_agents: { enabled: false },
					dynamicSubAgents: { enabled: false },
					sandbox: {
						enabled: false,
						file_downloads: true,
						fileDownloads: true,
					},
					generative_ui: { enabled: false },
					generativeUI: { enabled: false },
					ask_user_questions: { enabled: !isActMode },
					askUserQuestions: { enabled: !isActMode },
					context_management: {
						compaction: { enabled: true },
						large_tool_response: { enabled: false },
					},
					contextManagement: {
						compaction: { enabled: true },
						largeToolResponse: { enabled: false },
					},
				} as any,
			},
		}
	}

	async createSession(agentSpec: TrueForgeApi.AgentSpec, title?: string): Promise<TrueForgeApi.Session> {
		const res = await this.sdk.sessions.create(
			{
				agent: { spec: agentSpec },
			},
			{ timeoutInSeconds: 15, maxRetries: 0 },
		)
		if (title) {
			await this.sdk.sessions.update(res.data.id, { title }, { timeoutInSeconds: 10, maxRetries: 0 }).catch(() => {})
		}
		return res.data
	}

	async updateSessionAgent(sessionId: string, agentSpec: TrueForgeApi.AgentSpec): Promise<void> {
		await this.sdk.sessions.update(
			sessionId,
			{ agent: { spec: agentSpec } },
			{ timeoutInSeconds: 10, maxRetries: 0 },
		)
	}

	async streamTurn(
		sessionId: string,
		input: TrueForgeApi.TurnInputItem[],
		previousTurnId?: string,
		abortSignal?: AbortSignal,
	): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>> {
		return this.sdk.sessions.createTurnStream(
			sessionId,
			{
				input,
				...(previousTurnId ? { previousTurnId } : {}),
			},
			{
				abortSignal,
				timeoutInSeconds: 300,
				maxRetries: 0,
			},
		)
	}

	async submitToolApproval(
		sessionId: string,
		turnId: string,
		threadId: string,
		toolCallId: string,
		approved: boolean,
		reason?: string,
	): Promise<void> {
		const approval: TrueForgeApi.ApprovalDecision = approved
			? { status: "allow" }
			: { status: "deny", ...(reason ? { reason } : {}) }

		await this.sdk.sessions.createTurnEvent(
			sessionId,
			turnId,
			{
				events: [
					{
						type: "user.tool_approval",
						threadId,
						toolCallId,
						approval,
					},
				],
			},
			{ timeoutInSeconds: 15, maxRetries: 1 },
		)
	}

	async submitToolResponse(
		sessionId: string,
		turnId: string,
		threadId: string,
		toolCallId: string,
		content: string,
	): Promise<void> {
		await this.sdk.sessions.createTurnEvent(
			sessionId,
			turnId,
			{
				events: [
					{
						type: "user.tool_response",
						threadId,
						toolCallId,
						content,
					} as any,
				],
			},
			{ timeoutInSeconds: 15, maxRetries: 1 },
		)
	}

	async cancelSession(sessionId: string): Promise<void> {
		await this.sdk.sessions.cancel(sessionId, {}, { timeoutInSeconds: 10, maxRetries: 0 }).catch((err) => {
			Logger.debug(`[TrueForgeClient] Cancel session ${sessionId} ignored error: ${err}`)
		})
	}

	async listSessions(limit = 20): Promise<TrueForgeApi.Session[]> {
		const page = await this.sdk.sessions.list({ limit: Math.min(25, limit) }, { timeoutInSeconds: 10, maxRetries: 0 })
		return page.data
	}

	async getSession(sessionId: string): Promise<TrueForgeApi.Session | undefined> {
		try {
			const res = await this.sdk.sessions.get(sessionId, { timeoutInSeconds: 10, maxRetries: 0 })
			return res.data
		} catch {
			return undefined
		}
	}

	async listSessionEvents(sessionId: string, maxEvents = 100): Promise<Array<{ turnId: string; event: Record<string, unknown> }>> {
		const all: Array<{ turnId: string; event: Record<string, unknown> }> = []
		const pageSize = Math.min(100, Math.max(1, maxEvents))
		let page = await this.sdk.sessions.listEvents(sessionId, { limit: pageSize }, { timeoutInSeconds: 10, maxRetries: 0 })
		if (Array.isArray(page.data)) {
			all.push(...(page.data as unknown as Array<{ turnId: string; event: Record<string, unknown> }>))
		}
		while (all.length < maxEvents && typeof (page as any).hasNextPage === "function" && (page as any).hasNextPage()) {
			page = await (page as any).loadNextPage()
			if (Array.isArray(page.data)) {
				all.push(...(page.data as unknown as Array<{ turnId: string; event: Record<string, unknown> }>))
			} else {
				break
			}
		}
		return all
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		try {
			await this.sdk.sessions.delete(sessionId, { timeoutInSeconds: 10, maxRetries: 0 })
			return true
		} catch {
			return false
		}
	}
}
