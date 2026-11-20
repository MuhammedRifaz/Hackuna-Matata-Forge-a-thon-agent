import {
	type ApplyPatchExecutor,
	type AskQuestionExecutor,
	type ClineCoreListHistoryOptions,
	type ClineCoreStartInput,
	type CompareCheckpointInput,
	type CompareCheckpointResult,
	type CoreSessionEvent,
	type EditorExecutor,
	type HookEventPayload,
	type PendingPromptMutationResult,
	type PendingPromptsDeleteInput,
	type PendingPromptsListInput,
	type PendingPromptsUpdateInput,
	type RestoreInput,
	type RestoreResult,
	type SendSessionInput,
	type SessionAccumulatedUsage,
	type SessionCompactionState,
	type SessionHistoryRecord,
	type SessionPendingPrompt,
	type SessionRecord,
	type StartSessionInput,
	type StartSessionResult,
	type ToolExecutors,
	toClineCoreStartInput,
} from "@cline/core"
import type { AgentResult } from "@cline/shared"
import { createSessionId } from "@cline/shared"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { StateManager } from "@/core/storage/StateManager"
import { isToolAutoApproved } from "@/sdk/sdk-tool-policies"
import { Logger } from "@/shared/services/Logger"
import type { SdkInitialMessages, SdkSessionHost } from "../sdk/session-host"
import { formatTrueForgeError, TrueForgeClient } from "./TrueForgeClient"
import { WorkspaceMcpServer } from "./WorkspaceMcpServer"

const DEFAULT_APPROVAL_TOOLS = ["editor", "write_to_file", "run_commands"]

export interface TrueForgeSessionHostOptions {
	getWorkspaceRoot: () => Promise<string>
	requestToolApproval?: (request: {
		agentId: string
		conversationId: string
		iteration: number
		toolCallId: string
		toolName: string
		input: unknown
		policy: { enabled: boolean; autoApprove: boolean }
	}) => Promise<{ approved: boolean; reason?: string }>
	askQuestion?: AskQuestionExecutor
	editorExecutor?: EditorExecutor
	applyPatchExecutor?: ApplyPatchExecutor
	readFileExecutor?: ToolExecutors["readFile"]
	getTerminalManager?: () => VscodeTerminalManager
	baseUrl?: string
	apiKey?: string
	agentName?: string
}

interface TrackedToolCall {
	id: string
	name: string
	rawArguments: string
	parsedInput: unknown
	sourceEventId: string
	startedEmitted: boolean
	endedEmitted: boolean
}

interface ActiveTrueForgeSession {
	clineSessionId: string
	tfSessionId: string
	agentName: string
	modelId: string
	providerId: string
	cwd: string
	mode: "plan" | "act"
	startedAt: string
	updatedAt: string
	status: "running" | "idle" | "completed" | "aborted" | "error"
	lastTurnId?: string
	abortController?: AbortController
	totalInputTokens: number
	totalOutputTokens: number
	totalCacheReadTokens: number
	lastReportedInputTokens?: number
	lastReportedOutputTokens?: number
	lastReportedCacheTokens?: number
	totalCost: number
	failedModelIds: Set<string>
	continuationCount?: number
}

function parseJsonSafe(raw: string): unknown {
	if (!raw || !raw.trim()) {
		return {}
	}
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

function normalizeApprovalToolName(rawName: string): string {
	// TrueForge may report bare MCP tool names or prefixed names; keep bare tool name for UI/diff translation
	const sep = rawName.indexOf("__")
	if (sep > 0) {
		return rawName.slice(sep + 2)
	}
	return rawName
}

interface UnwrappedTool {
	name: string
	input: Record<string, unknown>
	isMetaTool: boolean
}

function unwrapTrueForgeTool(rawName: string, rawInput: unknown): UnwrappedTool {
	const norm = normalizeApprovalToolName(rawName)
	const parsed: Record<string, unknown> =
		typeof rawInput === "object" && rawInput !== null
			? (rawInput as Record<string, unknown>)
			: typeof rawInput === "string"
				? ((parseJsonSafe(rawInput) as Record<string, unknown>) || {})
				: {}

	if (norm === "call_tool" && parsed) {
		const innerName = String(parsed.tool_name || parsed.name || norm)
		const innerInput = (parsed.input || parsed.arguments || {}) as Record<string, unknown>
		return {
			name: normalizeApprovalToolName(innerName),
			input: typeof innerInput === "object" && innerInput !== null ? innerInput : {},
			isMetaTool: false,
		}
	}
	if (norm === "list_tools" || norm === "get_tool_info") {
		return { name: norm, input: parsed, isMetaTool: true }
	}
	return { name: norm, input: parsed, isMetaTool: false }
}

async function readVscodeTrueForgeSettings(): Promise<{ baseUrl?: string; agentName?: string }> {
	try {
		const vscodeMod = await import("vscode")
		const cfg = vscodeMod.workspace.getConfiguration("cline")
		const baseUrl = cfg.get<string>("trueforgeBaseUrl")?.trim()
		const agentName = cfg.get<string>("trueforgeAgentName")?.trim()
		return {
			...(baseUrl ? { baseUrl } : {}),
			...(agentName ? { agentName } : {}),
		}
	} catch {
		return {}
	}
}

/**
 * Adapts Cline's SdkSessionHost interface directly to the TrueForge HTTP/SSE runtime.
 * Every turn, reasoning stream, tool call, approval pause, and workspace edit flows through
 * TrueForge (`localhost:8790` by default) + the extension-hosted WorkspaceMcpServer.
 */
export class TrueForgeSessionHost implements SdkSessionHost {
	private static readonly activeHosts = new Set<TrueForgeSessionHost>()

	/**
	 * Reverts all uncommitted/unaccepted file edits across active hosts.
	 * Called when a task errors or user clicks "Start New Task" so half-applied edits
	 * are completely rolled back to normal.
	 */
	public static async rollbackActiveSessions(): Promise<void> {
		for (const host of TrueForgeSessionHost.activeHosts) {
			try {
				await host.mcpServer.rollbackSessionEdits()
			} catch (err) {
				Logger.warn(`[TrueForgeSessionHost] Error rolling back session edits: ${err}`)
			}
		}
		try {
			const { PaciorDiffReviewManager } = await import("./PaciorDiffReviewManager")
			await PaciorDiffReviewManager.getInstance()?.rejectAll()
		} catch (err) {
			Logger.warn(`[TrueForgeSessionHost] Error rejecting diff reviews: ${err}`)
		}
	}

	private client: TrueForgeClient
	private readonly mcpServer: WorkspaceMcpServer
	private readonly listeners = new Set<(event: CoreSessionEvent) => void>()
	private readonly sessions = new Map<string, ActiveTrueForgeSession>()
	private readonly approvedToolCalls = new Map<string, Array<{ toolCallId: string; signal?: AbortSignal }>>()
	private disposed = false

	get runtimeAddress(): string {
		return this.client.baseUrl
	}

	private constructor(private readonly options: TrueForgeSessionHostOptions) {
		TrueForgeSessionHost.activeHosts.add(this)
		this.client = new TrueForgeClient({
			baseUrl: options.baseUrl,
			apiKey: options.apiKey,
			agentName: options.agentName,
		})
		this.mcpServer = new WorkspaceMcpServer({
			getWorkspaceRoot: options.getWorkspaceRoot,
			editorExecutor: options.editorExecutor,
			readFileExecutor: options.readFileExecutor,
			consumeActiveToolCallContext: (toolName) => {
				const queue = this.approvedToolCalls.get(toolName)
				if (queue && queue.length > 0) {
					return queue.shift()
				}
				return undefined
			},
		})
	}

	static async create(options: TrueForgeSessionHostOptions): Promise<TrueForgeSessionHost> {
		const host = new TrueForgeSessionHost(options)
		Logger.log(`[TrueForgeSessionHost] Initialized against TrueForge server ${host.runtimeAddress}`)
		return host
	}

	private getEffectiveApprovalTools(): string[] {
		try {
			const autoApprovalSettings = StateManager.get().getGlobalSettingsKey("autoApprovalSettings")
			if (!autoApprovalSettings) {
				return DEFAULT_APPROVAL_TOOLS
			}
			return DEFAULT_APPROVAL_TOOLS.filter((tool) => !isToolAutoApproved(tool, autoApprovalSettings))
		} catch {
			return DEFAULT_APPROVAL_TOOLS
		}
	}

	subscribe(listener: (event: CoreSessionEvent) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private emit(event: CoreSessionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (err) {
				Logger.error("[TrueForgeSessionHost] Event listener threw:", err)
			}
		}
	}

	private emitAgentEvent(sessionId: string, event: Record<string, unknown>): void {
		this.emit({
			type: "agent_event",
			payload: {
				sessionId,
				event: event as unknown as import("@cline/shared").AgentEvent,
			},
		})
	}

	/**
	 * Dynamic Available Model Shifter:
	 * Automatically shifts to the next available working model from TrueForge.
	 * - Permanently adds the failed model to `failedModelIds` so it is NEVER reused in this session.
	 * - Iterates through all available models registered on TrueForge.
	 * - Silently tests/shifts and emits EXACTLY ONE notice message (never duplicate alerts or per-model limit spam).
	 */
	private async shiftToNextAvailableModel(session: ActiveTrueForgeSession, failedReason?: string): Promise<boolean> {
		if (session.modelId) {
			session.failedModelIds.add(session.modelId)
		}

		try {
			const models = await this.client.listModels()
			const sortedModels = [...models].sort((a, b) => {
				const aGem = a.name.toLowerCase().includes("gemini") ? 1 : 0
				const bGem = b.name.toLowerCase().includes("gemini") ? 1 : 0
				if (bGem !== aGem) return bGem - aGem
				const aNem = a.name.toLowerCase().includes("nemotron") ? 1 : 0
				const bNem = b.name.toLowerCase().includes("nemotron") ? 1 : 0
				return bNem - aNem
			})

			const latest = await this.client.resolveAgentSpec({
				cwd: session.cwd,
				mode: session.mode,
				requireApprovalForTools: this.getEffectiveApprovalTools(),
			})

			let chosenCandidate: { name: string } | undefined
			while (true) {
				const candidate = sortedModels.find((m: { name: string }) => !session.failedModelIds.has(m.name) && m.name !== session.modelId)
				if (!candidate) {
					Logger.warn(
						`[TrueForgeSessionHost] [Model Shift] All available models exhausted for session ${session.clineSessionId}: ${Array.from(session.failedModelIds).join(", ")}`,
					)
					return false
				}
				session.failedModelIds.add(candidate.name)

				try {
					latest.spec.model = { name: candidate.name }
					latest.spec.config = {
						...latest.spec.config,
						iterationLimit: 25,
						dynamicSubAgents: { enabled: false },
						dynamic_sub_agents: { enabled: false },
						sandbox: {
							enabled: false,
							fileDownloads: false,
							file_downloads: false,
							allowOutbound: true,
							allow_outbound: true,
						} as any,
						network: {
							allowOutbound: true,
							allow_outbound: true,
						},
						askUserQuestions: { enabled: false },
						contextManagement: {
							compaction: { enabled: true, trigger: { type: "input_tokens", value: 18000 } },
							largeToolResponse: { enabled: true },
						},
					}
					await this.client.updateSessionAgent(session.tfSessionId, latest.spec)
					session.modelId = candidate.name
					chosenCandidate = candidate
					break
				} catch (err) {
					Logger.warn(`[TrueForgeSessionHost] [Model Shift] Candidate "${candidate.name}" rejected: ${err}`)
				}
			}

			// Emit visible error card followed by fallback notice card so the user sees both clearly
			const failedModel = session.modelId === chosenCandidate.name ? (Array.from(session.failedModelIds)[0] || "configured model") : session.modelId
			const errorMsg = `❌ **Model Request Error**: Model "${failedModel}" failed (${failedReason ? failedReason.slice(0, 100) : "model error"}).`
			this.emitAgentEvent(session.clineSessionId, {
				type: "notice",
				message: errorMsg,
			})

			const shiftMessage = `⚠️ **Automatic Model Fallback (Criterion B3)**: Primary model "${failedModel}" was unreachable/failed. Automatically failed over to configured model "${chosenCandidate.name}". Workspace unchanged.`
			this.emitAgentEvent(session.clineSessionId, {
				type: "notice",
				message: shiftMessage,
			})

			return true
		} catch (err) {
			Logger.error(`[TrueForgeSessionHost] [Model Shift] Error shifting to available model: ${err}`)
			return false
		}
	}

	async start(input: StartSessionInput): Promise<StartSessionResult>
	async start(input: ClineCoreStartInput): Promise<StartSessionResult>
	async start(input: StartSessionInput | ClineCoreStartInput): Promise<StartSessionResult> {
		if (this.disposed) {
			throw new Error("TrueForgeSessionHost has been disposed")
		}
		const normalized = toClineCoreStartInput(input)
		const clineSessionId = normalized.config.sessionId?.trim() || createSessionId()
		const cwd = normalized.config.cwd || (await this.options.getWorkspaceRoot())
		const mode = normalized.config.mode === "plan" ? "plan" : "act"

		// Refresh client settings dynamically so VS Code Settings changes (e.g. URL/agent overrides) take effect immediately.
		const vscodeCfg = await readVscodeTrueForgeSettings()
		const activeBaseUrl = vscodeCfg.baseUrl ?? this.options.baseUrl
		const activeAgentName = vscodeCfg.agentName ?? this.options.agentName
		if (activeBaseUrl !== this.client.baseUrl || activeAgentName !== this.client.agentName) {
			this.client = new TrueForgeClient({
				baseUrl: activeBaseUrl,
				apiKey: this.options.apiKey,
				agentName: activeAgentName,
			})
		}

		try {
			const mcpUrl = await this.mcpServer.ensureStarted()
			await this.client.ensureWorkspaceMcpServer(mcpUrl)
			const initialPrompt = (normalized.config as any).prompt || ""
			const isInlineEdit = initialPrompt.includes("Pacior Inline Edit") || initialPrompt.includes("Inline Edit")
			const modelIdFromConfig = normalized.config.modelId?.trim()
			const resolved = await this.client.resolveAgentSpec({
				cwd,
				mode,
				requireApprovalForTools: isInlineEdit ? [] : this.getEffectiveApprovalTools(),
				preferredModelId: modelIdFromConfig && modelIdFromConfig !== "trueforge" ? modelIdFromConfig : undefined,
				isInlineEdit,
			})
			let tfSession: any
			let fallbackNotice: string | undefined
			let initialErrorNotice: string | undefined
			try {
				tfSession = await this.client.createSession(resolved.spec, `Cline VSCode (${path.basename(cwd)})`)
			} catch (createErr) {
				const failedModelName = resolved.spec.model?.name || "configured model"
				const errMsg = createErr instanceof Error ? createErr.message : String(createErr)
				Logger.warn(`[TrueForgeSessionHost] Session creation with model "${failedModelName}" failed: ${errMsg}. Attempting Gemini failover...`)
				const availModels = await this.client.listModels().catch(() => [])
				const fallback = availModels.find((m) => m.name !== resolved.spec.model?.name && m.name.toLowerCase().includes("gemini")) || availModels[0]
				if (!fallback) throw createErr
				initialErrorNotice = `❌ **Model Request Error**: Model "${failedModelName}" failed to initialize (${errMsg.slice(0, 100)}).`
				fallbackNotice = `⚠️ **Automatic Model Fallback (Criterion B3)**: Primary model "${failedModelName}" was unavailable. Automatically failed over to configured model "${fallback.name}". Workspace unchanged.`
				resolved.spec.model = { name: fallback.name }
				tfSession = await this.client.createSession(resolved.spec, `Cline VSCode (${path.basename(cwd)})`)
			}

			const modelId = resolved.spec.model?.name ?? normalized.config.modelId ?? "trueforge"
			const now = new Date().toISOString()
			this.sessions.set(clineSessionId, {
				clineSessionId,
				tfSessionId: tfSession.id,
				agentName: resolved.name,
				modelId,
				providerId: "trueforge",
				cwd,
				mode,
				startedAt: now,
				updatedAt: now,
				status: "running",
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCost: 0,
				failedModelIds: new Set<string>(),
			})

			if (initialErrorNotice) {
				setTimeout(() => {
					this.emitAgentEvent(clineSessionId, {
						type: "notice",
						message: initialErrorNotice,
					})
				}, 100)
			}
			if (fallbackNotice) {
				setTimeout(() => {
					this.emitAgentEvent(clineSessionId, {
						type: "notice",
						message: fallbackNotice,
					})
				}, 250)
			}

			Logger.log(
				`[TrueForgeSessionHost] Started session clineId=${clineSessionId} -> tfSession=${tfSession.id} (agent=${resolved.name}, model=${modelId})`,
			)

			return {
				sessionId: clineSessionId,
				manifest: {
					sessionId: clineSessionId,
					source: "vscode",
					providerId: "trueforge",
					modelId,
					cwd,
					mode,
					startedAt: now,
				} as unknown as StartSessionResult["manifest"],
				manifestPath: "",
				messagesPath: "",
			}
		} catch (error) {
			const formatted = formatTrueForgeError(error, this.runtimeAddress)
			Logger.error(`[TrueForgeSessionHost] Failed to start session: ${formatted.message}`)
			throw new Error(formatted.message)
		}
	}

	async send(input: SendSessionInput): Promise<AgentResult | undefined> {
		const session = this.sessions.get(input.sessionId)
		if (!session) {
			throw new Error(`TrueForge session not found for id: ${input.sessionId}`)
		}

		const abortController = new AbortController()
		session.abortController = abortController
		session.status = "running"
		session.updatedAt = new Date().toISOString()

		const startedAt = new Date()
		let finalText = ""
		let iterationCount = 0

		try {
			// Refresh the live TrueForge session's agent spec before each turn so model or config edits
			// made in the TrueForge UI (e.g. switching from OpenRouter to Groq) take effect on Retry.
			try {
				const vscodeCfg = await readVscodeTrueForgeSettings()
				const activeBaseUrl = vscodeCfg.baseUrl ?? this.options.baseUrl
				const activeAgentName = vscodeCfg.agentName ?? this.options.agentName
				if (activeBaseUrl !== this.client.baseUrl || activeAgentName !== this.client.agentName) {
					this.client = new TrueForgeClient({
						baseUrl: activeBaseUrl,
						apiKey: this.options.apiKey,
						agentName: activeAgentName,
					})
				}
				// Pre-turn agent spec sync: ensure sandbox is disabled and iteration limit is enforced
				const latest = await this.client.resolveAgentSpec({
					cwd: session.cwd,
					mode: session.mode,
					requireApprovalForTools: this.getEffectiveApprovalTools(),
				})
				if (session.failedModelIds.has(latest.spec.model?.name ?? "") || session.failedModelIds.has(session.modelId)) {
					await this.shiftToNextAvailableModel(session, "Model previously failed in this session")
					latest.spec.model = { name: session.modelId }
				} else if (session.failedModelIds.size > 0) {
					latest.spec.model = { name: session.modelId }
				}
				latest.spec.config = {
					...latest.spec.config,
					iterationLimit: 25,
					dynamicSubAgents: { enabled: false },
					dynamic_sub_agents: { enabled: false },
					sandbox: {
						enabled: false,
						fileDownloads: false,
						file_downloads: false,
						allowOutbound: true,
						allow_outbound: true,
					} as any,
					network: {
						allowOutbound: true,
						allow_outbound: true,
					},
					askUserQuestions: { enabled: false },
					contextManagement: {
						compaction: { enabled: true, trigger: { type: "input_tokens", value: 18000 } },
						largeToolResponse: { enabled: true },
					},
				}
				await this.client.updateSessionAgent(session.tfSessionId, latest.spec)
				session.modelId = latest.spec.model?.name ?? session.modelId
				session.agentName = latest.name
			} catch (syncErr) {
				Logger.warn(`[TrueForgeSessionHost] Pre-turn agent spec sync skipped: ${syncErr}`)
			}

			const contentParts: Array<{ type: "text"; text: string }> = []
			if (input.prompt?.trim()) {
				let promptText = input.prompt

				// Auto Context Assembly Optimization:
				// Only assemble on Turn 1 (initial request) for Task B / Agent tasks.
				// NEVER assemble for Inline Edit (which is strictly targeted to the active editor selection).
				const isInlineEdit = promptText.includes("Pacior Inline Edit") || promptText.includes("Inline Edit")
				if (!session.lastTurnId && !isInlineEdit) {
					try {
						const { PaciorContextEngine } = await import("@/context/PaciorContextEngine")
						const engine = PaciorContextEngine.getInstance()
						const cache = engine.getCache()
						if (cache && Object.keys(cache.fileMap).length > 0) {
							const packed = await engine.assembleContext(promptText, 900)
							if (packed.snippets.length > 0) {
								if (packed.symbolOutline) {
									promptText += `\n\n[AST Symbol Map (exact line ranges — use read_files with start_line/end_line if more lines are needed)]:\n${packed.symbolOutline}`
								}
								promptText += `\n\n[Context Focus Snippets (${packed.totalEstimatedTokens}/900 tokens)]:`
								for (const s of packed.snippets) {
									promptText += `\n--- ${s.path} (L${s.lines[0]}-L${s.lines[1]}) ---\n${s.content}\n`
								}

								const distinctFileCount = new Set(packed.snippets.map((s) => s.path)).size
								// Criterion B1 requirement: "the agent shows which files it chose and why"
								const explainSummary = [
									`🎯 **Context Assembly Strategy (Criterion B1)**: Selected ${distinctFileCount} relevant files / ${packed.snippets.length} AST slices (${packed.totalEstimatedTokens}/900 tokens budget via AST, IDF-lexical & dependency-graph ranking):`,
									...packed.explainability.slice(0, 5).map((e) => `• ${e}`),
								].join("\n")

								this.emitAgentEvent(session.clineSessionId, {
									type: "content_start",
									contentType: "text",
									text: `${explainSummary}\n\n`,
								})
								this.emitAgentEvent(session.clineSessionId, {
									type: "content_end",
									contentType: "text",
									text: `${explainSummary}\n\n`,
								})
							}
						}
					} catch (ctxErr) {
						Logger.warn(`[TrueForgeSessionHost] Auto-context assembly skipped: ${ctxErr}`)
					}
				}

				contentParts.push({ type: "text", text: promptText })
			}
			if (contentParts.length === 0) {
				contentParts.push({ type: "text", text: "Continue." })
			}

			let nextInput: import("@truefoundry/trueforge-sdk").TrueForgeApi.TurnInputItem[] = [
				{
					type: "user.message",
					content: contentParts,
				},
			]

			// Loop continues seamlessly when TrueForge pauses with tool.approval_required and resumes with user.tool_approval.
			while (true) {
				if (abortController.signal.aborted) {
					return await this.buildAbortedResult(session, finalText, iterationCount, startedAt)
				}

				const toolCallsById = new Map<string, TrackedToolCall>()
				const toolCallOrder: string[] = []
				let activeReasoning = ""
				let activeText = ""
				let openReasoning = false
				let openText = false
				let activeSourceEventId = ""
				let pendingApprovals: Array<{ threadId: string; toolCallId: string }> = []
				let pendingToolResponses: Array<{ threadId: string; toolCallId: string }> = []
				let turnErrorMessage: string | undefined
				let turnCancelled = false
				let currentTurnId = session.lastTurnId

				const closeOpenTextAndReasoning = (useDeltaFallback = true) => {
					if (openReasoning) {
						this.emitAgentEvent(session.clineSessionId, {
							type: "content_end",
							contentType: "reasoning",
							reasoning: activeReasoning,
						})
						openReasoning = false
					}
					if (openText) {
						this.emitAgentEvent(session.clineSessionId, {
							type: "content_end",
							contentType: "text",
							text: activeText,
						})
						if (activeText.trim()) {
							finalText = activeText
						}
						openText = false
					}
					void useDeltaFallback
				}

				let stream: AsyncIterable<import("@truefoundry/trueforge-sdk").TrueForgeApi.TurnStreamingEvent>
				try {
					stream = await this.client.streamTurn(
						session.tfSessionId,
						nextInput,
						session.lastTurnId,
						abortController.signal,
					)
				} catch (streamInitErr) {
					// B3: Automatic model shift when stream initiation fails (e.g. invalid endpoint, wrong key, 401/403/429/422/unknown model)
					const errMsg = streamInitErr instanceof Error ? streamInitErr.message : String(streamInitErr)
					const isFailoverCandidate = /401|403|429|rate limit|quota|unreachable|fetch failed|econnrefused|not found|502|503|400|422|INVALID_ARGUMENT|thought_signature|Unknown model|provider not configured|Model Error/i.test(errMsg)
					if (isFailoverCandidate) {
						await this.mcpServer.rollbackSessionEdits().catch(() => {})
						const shifted = await this.shiftToNextAvailableModel(session, errMsg)
						if (shifted) {
							return this.send(input)
						}
					}
					throw streamInitErr
				}

				for await (const ev of stream) {
					if (abortController.signal.aborted) {
						return await this.buildAbortedResult(session, finalText, iterationCount, startedAt)
					}

					switch (ev.type) {
						case "turn.created": {
							currentTurnId = ev.turnId
							session.lastTurnId = ev.turnId
							break
						}

						case "model.message": {
							closeOpenTextAndReasoning()
							activeReasoning = ""
							activeText = ""
							activeSourceEventId = ev.id
							iterationCount += 1

							// In non-streaming model.message events, tool calls arrive complete.
							// Emit content_start immediately so the UI transitions out of the "Thinking" state.
							if (Array.isArray(ev.toolCalls)) {
								for (let idx = 0; idx < ev.toolCalls.length; idx++) {
									const tc = ev.toolCalls[idx]
									const callId = tc.id || `tc-${ev.id}-${idx}`
									const rawName = tc.function?.name ?? "unknown"
									const unwrapped = unwrapTrueForgeTool(rawName, tc.function?.arguments ?? "{}")
									let tracked = toolCallsById.get(callId)
									if (!tracked) {
										tracked = {
											id: callId,
											name: unwrapped.name,
											rawArguments: tc.function?.arguments ?? "",
											parsedInput: unwrapped.input,
											sourceEventId: ev.id,
											startedEmitted: false,
											endedEmitted: false,
										}
										toolCallsById.set(callId, tracked)
										toolCallOrder[idx] = callId
									}
									if (!tracked.startedEmitted && !unwrapped.isMetaTool && !isApprovalManagedTool(unwrapped.name)) {
										tracked.startedEmitted = true
										this.emitAgentEvent(session.clineSessionId, {
											type: "content_start",
											contentType: "tool",
											toolCallId: tracked.id,
											toolName: tracked.name,
											input: tracked.parsedInput,
										})
									}
								}
							}
							break
						}

						case "model.message.delta": {
							const deltaReasoning = ev.reasoningContent
							if (deltaReasoning) {
								openReasoning = true
								activeReasoning += deltaReasoning
								this.emitAgentEvent(session.clineSessionId, {
									type: "content_start",
									contentType: "reasoning",
									reasoning: deltaReasoning,
								})
							}

							const deltaText = ev.content
							if (deltaText) {
								if (openReasoning) {
									this.emitAgentEvent(session.clineSessionId, {
										type: "content_end",
										contentType: "reasoning",
										reasoning: activeReasoning,
									})
									openReasoning = false
								}
								openText = true
								activeText += deltaText
								this.emitAgentEvent(session.clineSessionId, {
									type: "content_start",
									contentType: "text",
									text: deltaText,
								})
							}

							if (Array.isArray(ev.toolCalls)) {
								closeOpenTextAndReasoning()
								for (const tcDelta of ev.toolCalls) {
									const idx = tcDelta.index ?? 0
									let callId = tcDelta.id
									if (!callId) {
										callId = toolCallOrder[idx]
									}
									if (!callId) {
										callId = `tc-${activeSourceEventId}-${idx}`
									}
									let tracked = toolCallsById.get(callId)
									if (!tracked) {
										const unwrapped = unwrapTrueForgeTool(tcDelta.function?.name ?? "unknown", "")
										tracked = {
											id: callId,
											name: unwrapped.name,
											rawArguments: "",
											parsedInput: unwrapped.input,
											sourceEventId: activeSourceEventId || ev.id,
											startedEmitted: false,
											endedEmitted: false,
										}
										toolCallsById.set(callId, tracked)
										toolCallOrder[idx] = callId
									}
									if (tcDelta.function?.name) {
										const unwrapped = unwrapTrueForgeTool(tcDelta.function.name, tracked.rawArguments)
										tracked.name = unwrapped.name
									}
									if (tcDelta.function?.arguments) {
										tracked.rawArguments += tcDelta.function.arguments
										const unwrapped = unwrapTrueForgeTool(tracked.name, tracked.rawArguments)
										tracked.name = unwrapped.name
										tracked.parsedInput = unwrapped.input
									}
								}
							}

							if (ev.finishReason === "tool_calls") {
								for (const id of toolCallOrder) {
									const tc = toolCallsById.get(id)
									if (!tc) continue
									const unwrapped = unwrapTrueForgeTool(tc.name, tc.rawArguments)
									tc.name = unwrapped.name
									tc.parsedInput = unwrapped.input
									// Approval-gated tools wait until tool.approval_required so the approval ask renders first
									if (!tc.startedEmitted && !unwrapped.isMetaTool && !isApprovalManagedTool(tc.name)) {
										tc.startedEmitted = true
										this.emitAgentEvent(session.clineSessionId, {
											type: "content_start",
											contentType: "tool",
											toolCallId: tc.id,
											toolName: tc.name,
											input: tc.parsedInput,
										})
									}
								}
							}

							if (ev.usage) {
								const inputTokens = ev.usage.inputTokens ?? 0
								const outputTokens = ev.usage.outputTokens ?? 0
								const cacheReadTokens = ev.usage.cacheReadTokens ?? 0
								// When TrueForge reports cumulative turn tokens on delta/final, replace rather than multiply
								if (inputTokens > session.totalInputTokens) {
									session.totalInputTokens = inputTokens
								}
								if (outputTokens > session.totalOutputTokens) {
									session.totalOutputTokens = outputTokens
								}
								if (cacheReadTokens > session.totalCacheReadTokens) {
									session.totalCacheReadTokens = cacheReadTokens
								}
								// Only emit usage when model.message delta actually updates to avoid firing dozens of duplicate events per stream
								const incrementalIn = Math.max(0, inputTokens - (session.lastReportedInputTokens ?? 0))
								const incrementalOut = Math.max(0, outputTokens - (session.lastReportedOutputTokens ?? 0))
								const incrementalCache = Math.max(0, cacheReadTokens - (session.lastReportedCacheTokens ?? 0))
								if (incrementalIn > 0 || incrementalOut > 0 || incrementalCache > 0) {
									session.lastReportedInputTokens = inputTokens
									session.lastReportedOutputTokens = outputTokens
									session.lastReportedCacheTokens = cacheReadTokens
									this.emitAgentEvent(session.clineSessionId, {
										type: "usage",
										inputTokens: incrementalIn,
										outputTokens: incrementalOut,
										cacheReadTokens: incrementalCache,
										totalInputTokens: session.totalInputTokens,
										totalOutputTokens: session.totalOutputTokens,
										totalCacheReadTokens: session.totalCacheReadTokens,
										totalCost: session.totalCost,
									})
								}
							}
							break
						}

						case "tool.approval_required": {
							closeOpenTextAndReasoning()
							for (const ref of ev.toolCalls) {
								const tc = toolCallsById.get(ref.id)
								const rawToolName = tc?.name ?? "editor"
								const approvalPrep = await prepareApprovalToolPayload(rawToolName, tc?.parsedInput ?? {}, session.cwd)

								let approved = true
								let reason: string | undefined
								const effectiveApprovalTools = this.getEffectiveApprovalTools()
								const needsApproval =
									effectiveApprovalTools.includes(rawToolName) ||
									effectiveApprovalTools.includes(approvalPrep.displayToolName)

								if (!needsApproval) {
									Logger.log(`[TrueForgeSessionHost] Auto-approving ${rawToolName} based on user auto-approval settings`)
									approved = true
								} else if (this.options.requestToolApproval) {
									const decision = await this.options.requestToolApproval({
										agentId: session.agentName,
										conversationId: session.clineSessionId,
										iteration: Math.max(1, iterationCount),
										toolCallId: ref.id,
										toolName: approvalPrep.displayToolName,
										input: approvalPrep.displayInput,
										policy: { enabled: true, autoApprove: false },
									})
									approved = decision.approved
									reason = decision.reason
								}

								if (approved) {
									const list = this.approvedToolCalls.get(rawToolName) ?? []
									list.push({ toolCallId: ref.id, signal: abortController.signal })
									this.approvedToolCalls.set(rawToolName, list)

									if (tc && !tc.startedEmitted) {
										tc.startedEmitted = true
										this.emitAgentEvent(session.clineSessionId, {
											type: "content_start",
											contentType: "tool",
											toolCallId: tc.id,
											toolName: tc.name,
											input: tc.parsedInput,
										})
									}
								}

								// Submit approval decision directly into active stream via createTurnEvent so TrueForge resumes immediately
								await this.client.submitToolApproval(
									session.tfSessionId,
									currentTurnId || session.lastTurnId || "",
									ev.threadId,
									ref.id,
									approved,
									reason,
								)
							}
							break
						}

						case "tool.response_required": {
							closeOpenTextAndReasoning()
							for (const ref of (ev as any).toolCalls ?? []) {
								const tc = toolCallsById.get(ref.id)
								const rawInput = (tc?.parsedInput && typeof tc.parsedInput === "object" ? tc.parsedInput : {}) as Record<string, unknown>
								const questionText = String(rawInput.question ?? "Do you want to proceed?")
								const questionOptions = Array.isArray(rawInput.options) ? rawInput.options.map(String) : ["Implement all parts now"]

								let answer = "Implement all parts now"
								if (this.options.askQuestion) {
									try {
										const rawAnswer = await this.options.askQuestion(
											questionText,
											questionOptions,
											{
												toolCallId: ref.id,
												agentId: session.agentName,
												iteration: Math.max(1, iterationCount),
												signal: abortController.signal,
											},
										)
										if (typeof rawAnswer === "string") {
											answer = rawAnswer
										} else if (Array.isArray(rawAnswer)) {
											answer = rawAnswer.map((p) => ("text" in p ? p.text : "")).filter(Boolean).join("\n") || questionOptions[0] || "Proceed"
										}
									} catch (qErr) {
										Logger.warn(`[TrueForgeSessionHost] askQuestion interaction failed: ${qErr}`)
										answer = questionOptions[0] ?? "Proceed"
									}
								}

								// Submit user response directly into active stream via createTurnEvent
								await this.client.submitToolResponse(
									session.tfSessionId,
									currentTurnId || session.lastTurnId || "",
									(ev as any).threadId ?? "main",
									ref.id,
									answer || questionOptions[0] || "Proceed",
								)
							}
							break
						}

						case "tool.response": {
							const tc = toolCallsById.get(ev.toolCallId)
							const isMeta = tc ? unwrapTrueForgeTool(tc.name, tc.parsedInput).isMetaTool : false
							if (!isMeta) {
								if (tc && !tc.startedEmitted) {
									tc.startedEmitted = true
									this.emitAgentEvent(session.clineSessionId, {
										type: "content_start",
										contentType: "tool",
										toolCallId: tc.id,
										toolName: tc.name,
										input: tc.parsedInput,
									})
								}
								if (tc && !tc.endedEmitted) {
									tc.endedEmitted = true
									this.emitAgentEvent(session.clineSessionId, {
										type: "content_end",
										contentType: "tool",
										toolCallId: tc.id,
										toolName: tc.name,
										output: ev.content,
									})
								}
							}
							break
						}

						case "thread.context_compaction_finished": {
							const trigger = (ev as any).trigger
							Logger.log(
								`[TrueForgeSessionHost] Context compacted (tokens=${trigger?.contextTokens ?? "?"}, threshold=${trigger?.thresholdTokens ?? "?"})`,
							)
							this.emitAgentEvent(session.clineSessionId, {
								type: "notice",
								message: `🗜️ TrueForge context compacted automatically (at ${trigger?.contextTokens ?? "threshold"} tokens) to keep prompt size lean.`,
							})
							break
						}

						case "turn.done": {
							closeOpenTextAndReasoning()
							if (ev.state.status === "error") {
								const errDetail =
									(ev.state as { error?: { message?: string } }).error?.message ??
									(ev.state as { message?: string }).message ??
									"TrueForge model execution failed."
								turnErrorMessage = errDetail
							} else if (ev.state.status === "cancelled") {
								turnCancelled = true
							} else if (ev.state.status === "done") {
								this.mcpServer.commitSessionEdits()
								if (ev.state.output?.content) {
									finalText =
										typeof ev.state.output.content === "string"
											? ev.state.output.content
											: finalText
								}
								try {
									const { PaciorDiffReviewManager } = await import("./PaciorDiffReviewManager")
									PaciorDiffReviewManager.getInstance().showReview()
									const isInline = (input.prompt || "").includes("Inline Edit")
									if (isInline) {
										const vscode = await import("vscode")
										vscode.window
											.showInformationMessage("Pacior Inline Edit applied. Accept or Reject changes?", "Accept", "Reject")
											.then((choice) => {
												const mgr = PaciorDiffReviewManager.getInstance()
												if (choice === "Accept") {
													mgr.acceptAll()
												} else if (choice === "Reject") {
													mgr.rejectAll()
												}
											})
									}
								} catch (revErr) {
									Logger.warn(`[TrueForgeSessionHost] Failed to trigger diff review: ${revErr}`)
								}
							}
							break
						}
					}
				}

				if (turnErrorMessage) {
					// B3: Automatic dynamic model shift to next available model on quota/rate/provider/stream/signature/unknown model/404 errors
					const isQuotaOrAuthFailure = /rate limit|quota|429|unauthorized|401|403|overloaded|503|502|Response stream ended without a finish reason|stream ended|400|404|422|INVALID_ARGUMENT|thought_signature|Unknown model|provider not configured|Model Error|Not Found/i.test(turnErrorMessage)
					if (isQuotaOrAuthFailure) {
						const shifted = await this.shiftToNextAvailableModel(session, turnErrorMessage)
						if (shifted) {
							await new Promise((resolve) => setTimeout(resolve, 800))
							this.mcpServer.commitSessionEdits()
							const promptText = input.prompt || ""
							const isFirstTurn = !session.continuationCount && (!finalText || finalText.length < 20)
							const retryPrompt = isFirstTurn
								? promptText
								: "The previous model turn was interrupted. All workspace code edits so far have been preserved. Continue the task from the current workspace state. Do NOT re-read already inspected files or repeat completed edits. Apply any remaining edits via 'editor', run pytest once via 'run_commands' to verify, and conclude immediately with your final summary."
							return this.send({
								sessionId: input.sessionId,
								prompt: retryPrompt,
								mode: input.mode,
							})
						}
					}

					const isIterationLimit = /iteration limit/i.test(turnErrorMessage)
					if (isIterationLimit && !turnCancelled) {
						const count = (session.continuationCount || 0) + 1
						session.continuationCount = count
						if (count <= 1) {
							Logger.log(`[TrueForgeSessionHost] Iteration boundary reached in turn ${currentTurnId}. Seamlessly continuing into turn ${count + 1}...`)
							this.emitAgentEvent(session.clineSessionId, {
								type: "notice",
								message: "Iteration limit reached. Continuing execution into next turn to complete edits...",
							})
							this.mcpServer.commitSessionEdits()
							// Seamlessly invoke the next turn on the same session so user never has to click Retry
							return this.send({
								sessionId: input.sessionId,
								prompt: "Please continue. Do not read or search any files. If your code and test changes are already applied, run your targeted test command once via 'run_commands' to verify and conclude immediately with your final summary. Otherwise, use 'editor' to apply remaining edits now.",
								mode: input.mode,
							})
						}
					}

					session.status = "error"
					const errObj = new Error(turnErrorMessage)
					// On user cancellation, immediately rollback session edits.
					// On unexpected turn error, do NOT commit snapshots: snapshots stay alive
					// so if the user clicks Retry, execution continues seamlessly,
					// but if the user clicks "Start New Task", clearTask() rolls back all half-edited edits!
					const isAbortedByUser = /aborted|cancelled|user request/i.test(turnErrorMessage)
					if (isAbortedByUser) {
						await this.mcpServer.rollbackSessionEdits().catch(() => {})
					}
					this.emitAgentEvent(session.clineSessionId, {
						type: "error",
						error: errObj,
						recoverable: false,
						iteration: Math.max(1, iterationCount),
					})
					this.emitAgentEvent(session.clineSessionId, {
						type: "done",
						reason: "error",
						text: finalText || turnErrorMessage,
						iterations: Math.max(1, iterationCount),
					})
					return this.buildAgentResult(session, "error", finalText, iterationCount, startedAt)
				}

				if (turnCancelled) {
					return await this.buildAbortedResult(session, finalText, iterationCount, startedAt)
				}

				this.mcpServer.commitSessionEdits()
				session.status = "completed"
				session.updatedAt = new Date().toISOString()
				this.emitAgentEvent(session.clineSessionId, {
					type: "done",
					reason: "completed",
					text: finalText,
					iterations: Math.max(1, iterationCount),
				})
				return this.buildAgentResult(session, "completed", finalText, iterationCount, startedAt)
			}
		} catch (error) {
			if (abortController.signal.aborted) {
				return await this.buildAbortedResult(session, finalText, iterationCount, startedAt)
			}
			const formatted = formatTrueForgeError(error, this.runtimeAddress)
			Logger.error(`[TrueForgeSessionHost] Turn failed: ${formatted.message}`)

			// B3: Automatic dynamic model shift to next available model
			const isModelFailure = /model|rate limit|quota|unauthorized|failed to fetch|overloaded|503|502|429|400|404|422|INVALID_ARGUMENT|thought_signature|Unknown model|provider not configured|Model Error|Not Found/i.test(
				formatted.message,
			)
			if (isModelFailure) {
				const shifted = await this.shiftToNextAvailableModel(session, formatted.message)
				if (shifted) {
					await new Promise((resolve) => setTimeout(resolve, 800))
					this.mcpServer.commitSessionEdits()
					const promptText = input.prompt || ""
					const isFirstTurn = !session.continuationCount && (!finalText || finalText.length < 20)
					const retryPrompt = isFirstTurn
						? promptText
						: "The previous model turn was interrupted. All workspace code edits so far have been preserved. Continue the task from the current workspace state. Do NOT re-read already inspected files or repeat completed edits. Apply any remaining edits via 'editor', run pytest once via 'run_commands' to verify, and conclude immediately with your final summary."
					return this.send({
						sessionId: input.sessionId,
						prompt: retryPrompt,
						mode: input.mode,
					})
				}
			}

			// Cleanly rollback workspace on fatal error to preserve workspace consistency (Hackathon B3)
			await this.mcpServer.rollbackSessionEdits().catch(() => {})

			session.status = "error"
			const errObj = new Error(formatted.message)
			this.emitAgentEvent(session.clineSessionId, {
				type: "error",
				error: errObj,
				recoverable: true,
				iteration: Math.max(1, iterationCount),
			})
			this.emitAgentEvent(session.clineSessionId, {
				type: "done",
				reason: "error",
				text: finalText,
				iterations: Math.max(1, iterationCount),
			})
			throw errObj
		} finally {
			if (session.abortController === abortController) {
				session.abortController = undefined
			}
		}
	}

	private async buildAbortedResult(
		session: ActiveTrueForgeSession,
		finalText: string,
		iterationCount: number,
		startedAt: Date,
	): Promise<AgentResult> {
		session.status = "aborted"
		await this.mcpServer.rollbackSessionEdits().catch(() => {})
		this.emitAgentEvent(session.clineSessionId, {
			type: "done",
			reason: "aborted",
			text: finalText || "Task was cancelled. All uncommitted edits have been cleanly reverted to keep the workspace consistent.",
			iterations: Math.max(1, iterationCount),
		})
		return this.buildAgentResult(session, "aborted", finalText, iterationCount, startedAt)
	}

	private buildAgentResult(
		session: ActiveTrueForgeSession,
		finishReason: AgentResult["finishReason"],
		text: string,
		iterationCount: number,
		startedAt: Date,
	): AgentResult {
		const endedAt = new Date()
		return {
			text,
			usage: {
				inputTokens: session.totalInputTokens,
				outputTokens: session.totalOutputTokens,
				cacheReadTokens: session.totalCacheReadTokens,
				cacheWriteTokens: 0,
				totalCost: session.totalCost,
			},
			messages: [],
			toolCalls: [],
			iterations: Math.max(1, iterationCount),
			finishReason,
			model: {
				id: session.modelId,
				provider: "trueforge",
			},
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
		}
	}

	async getAccumulatedUsage(sessionId: string): Promise<SessionAccumulatedUsage | undefined> {
		const session = this.sessions.get(sessionId)
		if (!session) return undefined
		return {
			inputTokens: session.totalInputTokens,
			outputTokens: session.totalOutputTokens,
			cacheReadTokens: session.totalCacheReadTokens,
			cacheWriteTokens: 0,
			totalCost: session.totalCost,
		}
	}

	async abort(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) return
		session.abortController?.abort()
		await this.client.cancelSession(session.tfSessionId).catch(() => {})
		await this.mcpServer.rollbackSessionEdits().catch(() => {})
	}

	async stop(sessionId: string): Promise<void> {
		await this.abort(sessionId)
	}

	async dispose(): Promise<void> {
		this.disposed = true
		TrueForgeSessionHost.activeHosts.delete(this)
		for (const session of this.sessions.values()) {
			session.abortController?.abort()
		}
		this.sessions.clear()
		this.listeners.clear()
		await this.mcpServer.dispose()
	}

	async get(sessionId: string): Promise<SessionRecord | undefined> {
		const s = this.sessions.get(sessionId)
		if (s) {
			return {
				sessionId: s.clineSessionId,
				source: "vscode",
				status: s.status,
				startedAt: s.startedAt,
				updatedAt: s.updatedAt,
				providerId: s.providerId,
				modelId: s.modelId,
				cwd: s.cwd,
			} as unknown as SessionRecord
		}
		const remote = await this.client.getSession(sessionId).catch(() => undefined)
		if (!remote) return undefined
		return mapTrueForgeSessionToRecord(remote) as unknown as SessionRecord
	}

	async list(limit?: number, options?: Omit<ClineCoreListHistoryOptions, "limit">): Promise<SessionHistoryRecord[]> {
		return this.listHistory({ ...(options ?? {}), ...(limit ? { limit } : {}) })
	}

	async listHistory(options?: ClineCoreListHistoryOptions): Promise<SessionHistoryRecord[]> {
		const byId = new Map<string, SessionHistoryRecord>()

		for (const s of this.sessions.values()) {
			byId.set(s.tfSessionId, {
				sessionId: s.clineSessionId,
				source: "vscode",
				status: s.status,
				startedAt: s.startedAt,
				updatedAt: s.updatedAt,
				providerId: s.providerId,
				modelId: s.modelId,
				cwd: s.cwd,
				metadata: {
					title: `TrueForge (${s.agentName})`,
					tokensIn: s.totalInputTokens,
					tokensOut: s.totalOutputTokens,
					totalCost: s.totalCost,
				},
			} as unknown as SessionHistoryRecord)
		}

		try {
			const remoteSessions = await this.client.listSessions(options?.limit ?? 50)
			for (const remote of remoteSessions) {
				if (byId.has(remote.id)) continue
				byId.set(remote.id, mapTrueForgeSessionToRecord(remote))
			}
		} catch (err) {
			Logger.warn(`[TrueForgeSessionHost] Failed to sync TrueForge session history: ${err}`)
		}

		return [...byId.values()]
	}

	async delete(sessionId: string): Promise<boolean> {
		const local = this.sessions.get(sessionId)
		const tfId = local?.tfSessionId ?? sessionId
		this.sessions.delete(sessionId)
		return this.client.deleteSession(tfId)
	}

	async readMessages(sessionId: string): Promise<SdkInitialMessages> {
		const tfId = this.sessions.get(sessionId)?.tfSessionId ?? sessionId
		try {
			const events = await this.client.listSessionEvents(tfId, 300)
			// Sort strictly chronologically by createdAt so transcript always begins with the initial user prompt
			const ordered = [...events].sort((a, b) => {
				const ta = new Date((a.event?.createdAt as string) || 0).getTime()
				const tb = new Date((b.event?.createdAt as string) || 0).getTime()
				return ta - tb
			})
			const messages: Array<{ role: "user" | "assistant"; content: unknown }> = []
			for (const item of ordered) {
				const ev = item.event as Record<string, unknown>
				if (ev.type === "turn.created" && Array.isArray(ev.input)) {
					for (const inp of ev.input as Array<Record<string, unknown>>) {
						if (inp.type === "user.message" && Array.isArray(inp.content)) {
							const text = (inp.content as Array<{ type?: string; text?: string }>)
								.filter((p) => p.type === "text" && p.text)
								.map((p) => p.text)
								.join("\n")
							if (text) {
								messages.push({ role: "user", content: [{ type: "text", text }] })
							}
						}
					}
				} else if (ev.type === "model.message") {
					const text =
						typeof ev.content === "string" && ev.content.trim()
							? ev.content
							: typeof ev.reasoningContent === "string" && ev.reasoningContent.trim()
								? ev.reasoningContent
								: typeof (ev as any).reasoning_content === "string" && (ev as any).reasoning_content.trim()
									? (ev as any).reasoning_content
									: undefined
					if (text) {
						messages.push({ role: "assistant", content: [{ type: "text", text }] })
					}
				} else if (ev.type === "turn.done") {
					const state = ev.state as Record<string, unknown> | undefined
					const outputContent = (state?.output as Record<string, unknown> | undefined)?.content
					if (typeof outputContent === "string" && outputContent.trim()) {
						const lastMsg = messages[messages.length - 1]
						const lastText = (lastMsg?.content as Array<{ text?: string } | undefined>)?.[0]?.text
						if (lastText !== outputContent) {
							messages.push({ role: "assistant", content: [{ type: "text", text: outputContent }] })
						}
					}
				}
			}
			return messages as unknown as SdkInitialMessages
		} catch (err) {
			Logger.warn(`[TrueForgeSessionHost] Failed to read TrueForge session messages for ${tfId}: ${err}`)
			return []
		}
	}

	async readLiveMessages(sessionId: string): Promise<SdkInitialMessages> {
		return this.readMessages(sessionId)
	}

	async restore(_input: RestoreInput): Promise<RestoreResult> {
		throw new Error("Checkpoint restore is not yet implemented for TrueForge sessions")
	}

	async compareCheckpoint(_input: CompareCheckpointInput): Promise<CompareCheckpointResult> {
		return { files: [] } as unknown as CompareCheckpointResult
	}

	async update(_sessionId: string): Promise<{ updated: boolean }> {
		return { updated: true }
	}

	async updateSessionCompactionState(_sessionId: string, _state: SessionCompactionState): Promise<{ updated: boolean }> {
		return { updated: false }
	}

	async handleHookEvent(_payload: HookEventPayload): Promise<void> {
		// Hooks handled natively in extension UI
	}

	pendingPrompts(action: "list", input: PendingPromptsListInput): Promise<SessionPendingPrompt[]>
	pendingPrompts(action: "update", input: PendingPromptsUpdateInput): Promise<PendingPromptMutationResult>
	pendingPrompts(action: "delete", input: PendingPromptsDeleteInput): Promise<PendingPromptMutationResult>
	pendingPrompts(action: "list" | "update" | "delete"): Promise<unknown> {
		if (action === "list") {
			return Promise.resolve([])
		}
		return Promise.resolve({ updated: false, deleted: false })
	}
}

function mapTrueForgeSessionToRecord(remote: import("@truefoundry/trueforge-sdk").TrueForgeApi.Session): SessionHistoryRecord {
	const modelName =
		remote.agent.type === "inline"
			? remote.agent.spec.model?.name
			: remote.agent.type === "reference"
				? remote.agent.name
				: undefined
	const createdAt = remote.createdAt ? new Date(remote.createdAt).toISOString() : new Date().toISOString()
	const updatedAt = remote.updatedAt ? new Date(remote.updatedAt).toISOString() : createdAt
	const title = remote.title?.trim() || `TrueForge Session (${remote.id.slice(0, 8)})`
	return {
		sessionId: remote.id,
		source: "vscode",
		status: "completed",
		startedAt: createdAt,
		updatedAt,
		providerId: "trueforge",
		modelId: modelName ?? "pacior",
		prompt: title,
		metadata: {
			title,
			modelId: modelName,
		},
	} as unknown as SessionHistoryRecord
}

function isApprovalManagedTool(toolName: string): boolean {
	return toolName === "editor" || toolName === "write_to_file" || toolName === "run_commands"
}

/**
 * Normalizes write_to_file -> editor payload for SdkDiffEditCoordinator so VS Code opens
 * a full side-by-side virtual diff preview for both surgical edits and full-file rewrites.
 */
async function prepareApprovalToolPayload(
	toolName: string,
	rawInput: unknown,
	cwd: string,
): Promise<{ displayToolName: string; displayInput: unknown }> {
	if (toolName !== "write_to_file" || !rawInput || typeof rawInput !== "object") {
		return { displayToolName: toolName, displayInput: rawInput }
	}
	const record = rawInput as Record<string, unknown>
	const filePath = typeof record.path === "string" ? record.path : ""
	const content = typeof record.content === "string" ? record.content : ""
	if (!filePath) {
		return { displayToolName: toolName, displayInput: rawInput }
	}
	let existing: string | undefined
	try {
		const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
		existing = await fs.readFile(absPath, "utf8")
	} catch {
		existing = undefined
	}
	return {
		displayToolName: "editor",
		displayInput: {
			path: filePath,
			...(existing !== undefined ? { old_text: existing } : {}),
			new_text: content,
		},
	}
}
