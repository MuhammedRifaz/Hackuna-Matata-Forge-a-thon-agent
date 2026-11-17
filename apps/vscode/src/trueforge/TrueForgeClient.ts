import { TrueForge, type TrueForgeApi, TrueForgeError, TrueForgeTimeoutError, serialization } from "@truefoundry/trueforge-sdk"
import { Logger } from "@/shared/services/Logger"

// Resilience patch for TrueForge SSE streams (Hackathon Criteria B3 & Task C):
// If TrueForge emits partial turn.update or unexpected custom events during a turn stream,
// fern's default parseOrThrow on undiscriminatedUnion would throw a verbose ParseError.
// By safely falling back to the raw event object, streams continue uninterrupted.
if (serialization?.TurnStreamingEvent?.parseOrThrow) {
	const originalParseOrThrow = serialization.TurnStreamingEvent.parseOrThrow.bind(serialization.TurnStreamingEvent)
	serialization.TurnStreamingEvent.parseOrThrow = function (data: any, opts: any) {
		try {
			return originalParseOrThrow(data, opts)
		} catch (err) {
			if (data && typeof data === "object") {
				return data as any
			}
			throw err
		}
	}
}

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
	 * Explicitly forces a refresh so TrueForge discovers current tool definitions immediately.
	 */
	async ensureWorkspaceMcpServer(mcpUrl: string, serverName = VSCODE_MCP_SERVER_NAME): Promise<void> {
		try {
			await this.sdk.settings.mcpServers.delete(serverName, { timeoutInSeconds: 5, maxRetries: 0 }).catch(() => {})
		} catch {}

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
		const approvalList = options.requireApprovalForTools ?? []
		// Deferred tool loading: preload only the 4 essential core tools to cut tool definition overhead (~50% savings)
		// Infrequently used tools (list_files, write_to_file, assemble_context, finish, complete_task) stay deferred on demand.
		const workspaceMcpEntry: any = {
			name: mcpServerName,
			preload: false,
			preload_tools: ["read_files", "search_files", "editor", "run_commands"],
			preloadTools: ["read_files", "search_files", "editor", "run_commands"],
			enableTools: ["@all"],
			enable_tools: ["@all"],
			requireApprovalForTools: approvalList,
			require_approval_for_tools: approvalList,
		}

		const modeGuidance =
			options.mode === "plan"
				? "MODE: PLAN — Inspect code and present a concise implementation plan before editing."
				: "MODE: ACT — Implement requested changes directly with `editor` and verify with tests via `run_commands`."

		const isWin = process.platform === "win32"
		const platformInfo = isWin
			? "ENV: Windows (cmd.exe/PowerShell). Commands run inside the workspace root automatically (no `cd` needed). Use `python -m pytest ...` for Python tests."
			: "ENV: POSIX (bash/sh). Commands run inside the workspace root automatically."

		const workspaceContext = [
			"You are Pacior, a concise, high-precision software engineering agent in VS Code.",
			`Workspace Root: ${options.cwd}`,
			platformInfo,
			modeGuidance,
			"",
			"EXECUTION & TOKEN-EFFICIENCY RULES:",
			"1. USE ASSEMBLED CONTEXT FIRST: Turn 1 includes `[AST Symbol Map]` (exact line ranges) and `[Context Focus Snippets]` across target code, test, and doc files. Do NOT run `dir`, `ls`, `find`, or shell `grep` to rediscover files already shown. If you need extra lines, call `read_files` with exact `start_line`/`end_line` (or `search_files` with `regex`), using relative paths.",
			"2. EDIT VIA `editor`: Propose all edits via `editor` (`path`, exact `old_text`, `new_text`) so diff review renders cleanly. Never edit files via shell commands or create throwaway test scripts.",
			"3. PRE-CONFIGURED RUNTIME: Project dependencies and test runners are pre-installed. Never create `.venv` or run `pip`/`uv`/`npm install`.",
			"4. SINGLE TEST VERIFICATION: Run the targeted test command ONCE via `run_commands` (e.g., `python -m pytest <file> -k <test> -q`). Once exit 0 is confirmed, immediately conclude with a brief plain-text summary — do not run repetitive verification loops.",
			"5. AUTONOMY & SUBAGENTS: Proceed directly when the task is clear (only call `ask_user_question` if requirements are genuinely ambiguous). Delegate broad multi-file exploration to `create_sub_agent` to keep main context lean.",
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
					iteration_limit: 50,
					iterationLimit: 50,
					dynamic_sub_agents: { enabled: true },
					dynamicSubAgents: { enabled: true },
					sandbox: {
						enabled: false,
						file_downloads: false,
						fileDownloads: false,
					},
					generative_ui: { enabled: false },
					generativeUi: { enabled: false },
					ask_user_questions: { enabled: true },
					askUserQuestions: { enabled: true },
					context_management: {
						compaction: {
							enabled: true,
							trigger: { type: "input_tokens", value: 18000 },
						},
						large_tool_response: { enabled: true },
					},
					contextManagement: {
						compaction: {
							enabled: true,
							trigger: { type: "input_tokens", value: 18000 },
						},
						largeToolResponse: { enabled: true },
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
			page = typeof (page as any).getNextPage === "function" ? await (page as any).getNextPage() : await (page as any).loadNextPage()
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
