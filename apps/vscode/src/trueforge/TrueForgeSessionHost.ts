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
import { Logger } from "@/shared/services/Logger"
import type { SdkInitialMessages, SdkSessionHost } from "../sdk/session-host"
import { formatTrueForgeError, TrueForgeClient } from "./TrueForgeClient"
import { WorkspaceMcpServer } from "./WorkspaceMcpServer"

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
	totalCost: number
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
			const resolved = await this.client.resolveAgentSpec({
				cwd,
				mode,
				requireApprovalForTools: ["editor", "write_to_file", "run_commands"],
			})
			const tfSession = await this.client.createSession(resolved.spec, `Cline VSCode (${path.basename(cwd)})`)

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
			})

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
				const latest = await this.client.resolveAgentSpec({
					cwd: session.cwd,
					mode: session.mode,
					requireApprovalForTools: ["editor", "write_to_file", "run_commands"],
				})
				const latestModelId = latest.spec.model?.name ?? session.modelId
				if (latestModelId !== session.modelId) {
					await this.client.updateSessionAgent(session.tfSessionId, latest.spec)
					session.modelId = latestModelId
					session.agentName = latest.name
					Logger.log(`[TrueForgeSessionHost] Synced session ${session.tfSessionId} model -> ${latestModelId}`)
				}
			} catch (syncErr) {
				Logger.warn(`[TrueForgeSessionHost] Pre-turn agent spec sync skipped: ${syncErr}`)
			}

			const contentParts: Array<{ type: "text"; text: string }> = []
			if (input.prompt?.trim()) {
				let promptText = input.prompt

				// Auto Context Assembly Optimization:
				// If this is Turn 1 (or prompt is requesting code changes) and context engine is ready,
				// auto-pack relevant AST snippets and append to prompt to avoid 800k+ token dumps.
				try {
					const { PaciorContextEngine } = await import("@/context/PaciorContextEngine")
					const engine = PaciorContextEngine.getInstance()
					const cache = engine.getCache()
					if (cache && Object.keys(cache.fileMap).length > 0) {
						const packed = await engine.assembleContext(promptText, 3500)
						if (packed.snippets.length > 0) {
							promptText += `\n\n[Pacior Context Engineering - Assembled Focus Context (${packed.totalEstimatedTokens} tokens)]:`
							for (const exp of packed.explainability) {
								promptText += `\n- ${exp}`
							}
							promptText += `\n\nRelevant AST Snippets:`
							for (const s of packed.snippets) {
								promptText += `\n--- ${s.path} (L${s.lines[0]}-L${s.lines[1]}) ---\n${s.content}\n`
							}
						}
					}
				} catch (ctxErr) {
					Logger.warn(`[TrueForgeSessionHost] Auto-context assembly skipped: ${ctxErr}`)
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
					return this.buildAbortedResult(session, finalText, iterationCount, startedAt)
				}

				const toolCallsById = new Map<string, TrackedToolCall>()
				const toolCallOrder: string[] = []
				let activeReasoning = ""
				let activeText = ""
				let openReasoning = false
				let openText = false
				let activeSourceEventId = ""
				let pendingApprovals: Array<{ threadId: string; toolCallId: string }> = []
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

				const stream = await this.client.streamTurn(
					session.tfSessionId,
					nextInput,
					session.lastTurnId,
					abortController.signal,
				)

				for await (const ev of stream) {
					if (abortController.signal.aborted) {
						return this.buildAbortedResult(session, finalText, iterationCount, startedAt)
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
										tracked = {
											id: callId,
											name: normalizeApprovalToolName(tcDelta.function?.name ?? "unknown"),
											rawArguments: "",
											parsedInput: {},
											sourceEventId: activeSourceEventId || ev.id,
											startedEmitted: false,
											endedEmitted: false,
										}
										toolCallsById.set(callId, tracked)
										toolCallOrder[idx] = callId
									}
									if (tcDelta.function?.name) {
										tracked.name = normalizeApprovalToolName(tcDelta.function.name)
									}
									if (tcDelta.function?.arguments) {
										tracked.rawArguments += tcDelta.function.arguments
										tracked.parsedInput = parseJsonSafe(tracked.rawArguments)
									}
								}
							}

							if (ev.finishReason === "tool_calls") {
								for (const id of toolCallOrder) {
									const tc = toolCallsById.get(id)
									if (!tc) continue
									tc.parsedInput = parseJsonSafe(tc.rawArguments)
									// Approval-gated tools wait until tool.approval_required so the approval ask renders first
									if (!tc.startedEmitted && !isApprovalManagedTool(tc.name)) {
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
								session.totalInputTokens += inputTokens
								session.totalOutputTokens += outputTokens
								session.totalCacheReadTokens += cacheReadTokens
								this.emitAgentEvent(session.clineSessionId, {
									type: "usage",
									inputTokens,
									outputTokens,
									cacheReadTokens,
									totalInputTokens: session.totalInputTokens,
									totalOutputTokens: session.totalOutputTokens,
									totalCacheReadTokens: session.totalCacheReadTokens,
									totalCost: session.totalCost,
								})
							}
							break
						}

						case "tool.approval_required": {
							closeOpenTextAndReasoning()
							for (const ref of ev.toolCalls) {
								pendingApprovals.push({ threadId: ev.threadId, toolCallId: ref.id })
							}
							break
						}

						case "tool.response": {
							const tc = toolCallsById.get(ev.toolCallId)
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
							break
						}

						case "turn.done": {
							closeOpenTextAndReasoning()
							if (ev.state.status === "error") {
								const errDetail =
									(ev.state as { error?: { message?: string } }).error?.message ??
									"TrueForge model execution failed."
								turnErrorMessage = errDetail
							} else if (ev.state.status === "cancelled") {
								turnCancelled = true
							} else if (ev.state.status === "done" && ev.state.output?.content) {
								finalText =
									typeof ev.state.output.content === "string"
										? ev.state.output.content
										: finalText
							}
							break
						}
					}
				}

				if (turnErrorMessage) {
					session.status = "error"
					const errObj = new Error(turnErrorMessage)
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
					return this.buildAgentResult(session, "error", finalText, iterationCount, startedAt)
				}

				if (turnCancelled) {
					return this.buildAbortedResult(session, finalText, iterationCount, startedAt)
				}

				if (pendingApprovals.length === 0) {
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

				// Resolve all requested tool approvals via VS Code UI (diff previews + Approve/Reject)
				const approvalInputs: import("@truefoundry/trueforge-sdk").TrueForgeApi.TurnInputItem[] = []
				for (const pending of pendingApprovals) {
					const tc = toolCallsById.get(pending.toolCallId)
					const rawToolName = tc?.name ?? "editor"
					const approvalPrep = await prepareApprovalToolPayload(rawToolName, tc?.parsedInput ?? {}, session.cwd)

					let approved = true
					let reason: string | undefined
					if (this.options.requestToolApproval) {
						const decision = await this.options.requestToolApproval({
							agentId: session.agentName,
							conversationId: session.clineSessionId,
							iteration: Math.max(1, iterationCount),
							toolCallId: pending.toolCallId,
							toolName: approvalPrep.displayToolName,
							input: approvalPrep.displayInput,
							policy: { enabled: true, autoApprove: false },
						})
						approved = decision.approved
						reason = decision.reason
					}

					if (approved) {
						// Queue toolCallId so WorkspaceMcpServer shares the same diff preview session when executing
						const list = this.approvedToolCalls.get(rawToolName) ?? []
						list.push({ toolCallId: pending.toolCallId, signal: abortController.signal })
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

					approvalInputs.push({
						type: "user.tool_approval",
						threadId: pending.threadId,
						toolCallId: pending.toolCallId,
						approval: approved ? { status: "allow" } : { status: "deny", ...(reason ? { reason } : {}) },
					})
				}

				if (currentTurnId) {
					session.lastTurnId = currentTurnId
				}
				nextInput = approvalInputs
			}
		} catch (error) {
			if (abortController.signal.aborted) {
				return this.buildAbortedResult(session, finalText, iterationCount, startedAt)
			}
			const formatted = formatTrueForgeError(error, this.runtimeAddress)
			Logger.error(`[TrueForgeSessionHost] Turn failed: ${formatted.message}`)

			// B3: Automatic fallback to a secondary configured model with zero user action & workspace unchanged
			const isModelFailure = /model|rate limit|quota|unauthorized|failed to fetch|overloaded|503|502|429/i.test(
				formatted.message,
			)
			if (isModelFailure) {
				try {
					const models = await this.client.listModels()
					const fallbackCandidate = models.find((m: { name: string }) => m.name !== session.modelId)
					if (fallbackCandidate) {
						Logger.log(
							`[TrueForgeSessionHost] [B3 Fallback] Triggering automatic failover from ${session.modelId} -> ${fallbackCandidate.name}`,
						)
						const latest = await this.client.resolveAgentSpec({
							cwd: session.cwd,
							mode: session.mode,
							requireApprovalForTools: ["editor", "write_to_file", "run_commands"],
						})
						latest.spec.model = { name: fallbackCandidate.name }
						await this.client.updateSessionAgent(session.tfSessionId, latest.spec)
						session.modelId = fallbackCandidate.name

						this.emitAgentEvent(session.clineSessionId, {
							type: "content_delta",
							delta: `\n> ⚠️ *Primary model error (${formatted.message}). Automatically failed over to fallback model \`${fallbackCandidate.name}\` with no user intervention needed.*\n\n`,
						})

						// Retry the send transparently on the fallback model
						return this.send(input)
					}
				} catch (fallbackErr) {
					Logger.error(`[TrueForgeSessionHost] [B3 Fallback] Failover attempt failed: ${fallbackErr}`)
				}
			}

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

	private buildAbortedResult(
		session: ActiveTrueForgeSession,
		finalText: string,
		iterationCount: number,
		startedAt: Date,
	): AgentResult {
		session.status = "aborted"
		this.emitAgentEvent(session.clineSessionId, {
			type: "done",
			reason: "aborted",
			text: finalText,
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
		await this.client.cancelSession(session.tfSessionId)
	}

	async stop(sessionId: string): Promise<void> {
		await this.abort(sessionId)
	}

	async dispose(): Promise<void> {
		this.disposed = true
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
			const events = await this.client.listSessionEvents(tfId, 200)
			const ordered = [...events].reverse()
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
				} else if (ev.type === "model.message" && typeof ev.content === "string" && ev.content.trim()) {
					messages.push({ role: "assistant", content: [{ type: "text", text: ev.content }] })
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
