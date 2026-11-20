import * as vscode from "vscode"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { TrueForgeClient } from "./TrueForgeClient"
import { VscodeEditPreview } from "@/hosts/vscode/VscodeEditPreview"
import type { VscodeWebviewProvider } from "@/hosts/vscode/VscodeWebviewProvider"
import { sendChatButtonClickedEvent } from "@/core/controller/ui/subscribeToChatButtonClicked"
import { pushMessageToWebview } from "@/sdk/webview-grpc-bridge"
import type { ClineMessage } from "@/shared/ExtensionMessage"

interface InlineChatSession {
	controller: any
	taskId: string
	seq: number
	reasoningTs: number
	textTs: number
	accumulatedReasoning: string
	accumulatedText: string
}

async function startInlineChatSession(initialTaskPrompt: string): Promise<InlineChatSession | undefined> {
	try {
		const { WebviewProvider } = await import("@/core/webview/WebviewProvider")
		const sidebar = WebviewProvider.getInstance() as VscodeWebviewProvider | undefined
		const controller = sidebar?.controller
		if (!controller) return undefined

		// 1. Clear any active or stale task and reset view
		await controller.clearTask()
		// 2. Switch webview immediately to Chat tab (away from history/welcome cards)
		await sendChatButtonClickedEvent()

		const taskId = `inline-${Date.now()}`
		const { createTaskProxy } = await import("@/sdk/task-proxy")
		controller.task = createTaskProxy(
			taskId,
			controller.askResponse,
			controller.cancelTask,
		)

		// 3. Add initial task message to open the chat interface with task prompt
		const taskMsg: ClineMessage = {
			ts: Date.now(),
			type: "say",
			say: "task",
			text: initialTaskPrompt,
			partial: false,
		}
		controller.task.messageStateHandler.addMessages([taskMsg])

		// 4. Set turn state to "streaming" so thinking loader and realtime streaming activate
		if (controller.turnStateTracker?.set) {
			controller.turnStateTracker.set("streaming")
		}

		// 5. Post state to webview immediately so new chat view is mounted
		await controller.postStateToWebview()

		return {
			controller,
			taskId,
			seq: 1,
			reasoningTs: Date.now() + 1,
			textTs: Date.now() + 2,
			accumulatedReasoning: "",
			accumulatedText: "",
		}
	} catch (e) {
		Logger.warn(`[PaciorInlineEditor] Failed to start inline chat session: ${e}`)
		return undefined
	}
}

async function streamReasoningDelta(session: InlineChatSession | undefined, delta: string): Promise<void> {
	if (!session || !delta) return
	session.accumulatedReasoning += delta
	session.seq += 1
	const msg: ClineMessage = {
		ts: session.reasoningTs,
		type: "say",
		say: "reasoning",
		text: session.accumulatedReasoning,
		partial: true,
		seq: session.seq,
	}
	// Update in task message handler
	session.controller.task?.messageStateHandler?.addMessages([msg])
	// Push directly through realtime partial message gRPC stream
	await pushMessageToWebview(msg)
}

async function streamTextDelta(session: InlineChatSession | undefined, delta: string): Promise<void> {
	if (!session || !delta) return
	session.accumulatedText += delta
	session.seq += 1
	const msg: ClineMessage = {
		ts: session.textTs,
		type: "say",
		say: "text",
		text: session.accumulatedText,
		partial: true,
		seq: session.seq,
	}
	session.controller.task?.messageStateHandler?.addMessages([msg])
	await pushMessageToWebview(msg)
}

async function completeReasoningStream(session: InlineChatSession | undefined): Promise<void> {
	if (!session || !session.accumulatedReasoning) return
	session.seq += 1
	const msg: ClineMessage = {
		ts: session.reasoningTs,
		type: "say",
		say: "reasoning",
		text: session.accumulatedReasoning,
		partial: false,
		seq: session.seq,
	}
	session.controller.task?.messageStateHandler?.addMessages([msg])
	await pushMessageToWebview(msg)
}

async function completeTextStream(session: InlineChatSession | undefined): Promise<void> {
	if (!session || !session.accumulatedText) return
	session.seq += 1
	const msg: ClineMessage = {
		ts: session.textTs,
		type: "say",
		say: "text",
		text: session.accumulatedText,
		partial: false,
		seq: session.seq,
	}
	session.controller.task?.messageStateHandler?.addMessages([msg])
	await pushMessageToWebview(msg)
}

async function postInlineCardMessage(
	session: InlineChatSession | undefined,
	message: { type: "say"; say: "info" | "text" | "error"; text: string },
): Promise<void> {
	try {
		const { WebviewProvider } = await import("@/core/webview/WebviewProvider")
		const sidebar = WebviewProvider.getInstance() as VscodeWebviewProvider | undefined
		const controller = sidebar?.controller ?? session?.controller
		if (!controller) return

		const cardMsg: ClineMessage = {
			ts: Date.now(),
			type: message.type,
			say: message.say,
			text: message.text,
			partial: false,
		}

		if (controller.task) {
			controller.task.messageStateHandler.addMessages([cardMsg])
		}
		await pushMessageToWebview(cardMsg)
		await controller.postStateToWebview()
	} catch (e) {
		Logger.warn(`[PaciorInlineEditor] Failed to post inline card message: ${e}`)
	}
}

/**
 * Task A: Inline Edit Mode (Ctrl+I / Cmd+I).
 *
 * Provides sub-1,000 token direct inline code editing directly inside the active editor:
 * 1. Takes the user's active editor selection (or active line) + minimal surrounding context.
 * 2. Prompts user via a quick floating input box for their edit instruction.
 * 3. Opens a NEW CHAT interface in the sidebar showing realtime streaming thoughts & text.
 * 4. Transparently renders model fallbacks and error cards inline in the chat.
 * 5. Streams request to TrueForge with dynamic model shift resilience.
 * 6. Shows side-by-side Diff Review modal with Accept / Reject.
 * 7. On Accept: swaps code and writes changes. On Reject: discards preview with document untouched.
 */
export async function executePaciorInlineEdit(clientConfig?: { baseUrl?: string; apiKey?: string }): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		vscode.window.showWarningMessage("Pacior Inline Edit: No active text editor found.")
		return
	}

	const document = editor.document
	const selection = editor.selection
	const isSelectionEmpty = selection.isEmpty

	// Use selected range or the current line if no selection
	const targetRange = isSelectionEmpty
		? document.lineAt(selection.active.line).range
		: new vscode.Range(selection.start, selection.end)

	const selectedCode = document.getText(targetRange)
	const filePath = vscode.workspace.asRelativePath(document.uri)
	const languageId = document.languageId

	// Ask the user for the edit instruction
	const instruction = await vscode.window.showInputBox({
		title: `Pacior Inline Edit (${filePath}:${targetRange.start.line + 1})`,
		placeHolder: "E.g. Refactor to use list comprehension, add docstring, mask secrets...",
		prompt: "Enter edit instruction and press Enter",
		ignoreFocusOut: true,
	})

	if (!instruction || !instruction.trim()) {
		return
	}

	// Focus/reveal sidebar so user can see progress and transparent notifications in chat UI
	vscode.commands.executeCommand("claude-dev.SidebarProvider.focus").then(undefined, () => {})

	// Start a fresh chat interface for this inline edit task
	const initialPromptText = `✏️ **Pacior Inline Edit**: \`${filePath}:${targetRange.start.line + 1}\`\n\n> ${instruction.trim()}`
	const chatSession = await startInlineChatSession(initialPromptText)

	// Capture surrounding lines (up to 15 lines before and after) to maintain context without token bloat
	const startLine = Math.max(0, targetRange.start.line - 15)
	const endLine = Math.min(document.lineCount - 1, targetRange.end.line + 15)
	const contextBefore = document.getText(new vscode.Range(startLine, 0, targetRange.start.line, targetRange.start.character))
	const contextAfter = document.getText(new vscode.Range(targetRange.end.line, targetRange.end.character, endLine, document.lineAt(endLine).text.length))

	const client = new TrueForgeClient(clientConfig)

	let cleanedReplacement = ""
	let lastErrorMsg = ""

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Window,
			title: "Pacior Inline Edit: Generating changes...",
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: "Requesting edit from TrueForge..." })

			try {
				const models = await client.listModels()
				// Prioritize stable gemini models first, then any other available model
				const sortedModels = [...models].sort((a, b) => {
					const aGem = a.name.toLowerCase().includes("gemini") ? 1 : 0
					const bGem = b.name.toLowerCase().includes("gemini") ? 1 : 0
					return bGem - aGem
				})

				const triedModels = new Set<string>()

				for (const modelCandidate of sortedModels) {
					if (token.isCancellationRequested) break
					if (triedModels.has(modelCandidate.name)) continue
					triedModels.add(modelCandidate.name)

					try {
						progress.report({ message: `Generating with ${modelCandidate.name}...` })

						const session = await client.createSession({
							model: { name: modelCandidate.name },
							instructions:
								"You are an expert precision code editor. When given existing code and an instruction, output ONLY the replacement code that should directly replace the target block. Do NOT include markdown code fences (```), commentary, explanations, or notes. Output raw replacement code only.",
							config: {
								iteration_limit: 1,
								iterationLimit: 1,
								sandbox: { enabled: false },
								dynamic_sub_agents: { enabled: false },
								context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
							} as any,
						})

						const prompt = [
							`File: ${filePath} (${languageId})`,
							`Surrounding Context Before:\n${contextBefore}`,
							`Target Code To Replace:\n${selectedCode}`,
							`Surrounding Context After:\n${contextAfter}`,
							`Edit Instruction: ${instruction.trim()}`,
							"",
							"Return ONLY the raw replacement string for 'Target Code To Replace'.",
						].join("\n\n")

						// Build standard AbortController bridge from vscode.CancellationToken
						const abortController = new AbortController()
						token.onCancellationRequested(() => abortController.abort())

						const stream = await client.streamTurn(
							session.id,
							[{ type: "user.message", content: [{ type: "text", text: prompt }] }],
							undefined,
							abortController.signal,
						)

						let replacement = ""
						for await (const ev of stream) {
							if (token.isCancellationRequested) break

							// Realtime streaming: thinking / reasoning deltas
							const deltaReasoning = (ev as any).reasoningContent ?? (ev as any).reasoning_content
							if (deltaReasoning) {
								await streamReasoningDelta(chatSession, String(deltaReasoning))
							}

							// Realtime streaming: replacement text deltas
							if (ev.type === "model.message.delta" && ev.content) {
								replacement += ev.content
								await completeReasoningStream(chatSession)
								await streamTextDelta(chatSession, ev.content)
							} else if (ev.type === "turn.done") {
								await completeReasoningStream(chatSession)
								if (ev.state.status === "error") {
									const errDetail =
										(ev.state as { error?: { message?: string } }).error?.message ??
										(ev.state as { message?: string }).message ??
										"Turn error"
									throw new Error(errDetail)
								}
								if (ev.state.status === "done" && typeof ev.state.output?.content === "string") {
									replacement = ev.state.output.content
								}
							}
						}

						await completeTextStream(chatSession)

						// Preserve session in TrueForge daemon for full transparency & inspection in history
						Logger.log(`[executePaciorInlineEdit] Preserved inline session in TrueForge daemon: ${session.id}`)

						if (token.isCancellationRequested) {
							return
						}

						let cleaned = replacement.trim()
						if (cleaned.startsWith("```")) {
							const firstNewline = cleaned.indexOf("\n")
							if (firstNewline !== -1) {
								cleaned = cleaned.slice(firstNewline + 1)
							}
							if (cleaned.endsWith("```")) {
								cleaned = cleaned.slice(0, cleaned.length - 3).trimEnd()
							}
						}
						cleanedReplacement = cleaned

						await postInlineCardMessage(chatSession, {
							type: "say",
							say: "info",
							text: `⚡ **Inline Edit Generated**: Proposed diff ready for \`${filePath}\`. Reviewing changes in editor...`,
						})
						break // Model succeeded!
					} catch (attemptErr: unknown) {
						lastErrorMsg = attemptErr instanceof Error ? attemptErr.message : String(attemptErr)
						Logger.warn(`[executePaciorInlineEdit] Model ${modelCandidate.name} failed: ${lastErrorMsg}`)

						// Find next candidate for resilient fallback
						const nextCandidate = sortedModels.find((m) => !triedModels.has(m.name))
						if (nextCandidate) {
							await postInlineCardMessage(chatSession, {
								type: "say",
								say: "info",
								text: `⚠️ **Model Shift**: Inline edit model error (${lastErrorMsg}). Automatically shifted to available fallback model "${nextCandidate.name}".`,
							})
						}
					}
				}

				if (!cleanedReplacement && cleanedReplacement !== "" && lastErrorMsg) {
					await postInlineCardMessage(chatSession, {
						type: "say",
						say: "error",
						text: `❌ **Pacior Inline Edit Failed**: ${lastErrorMsg}`,
					})
					vscode.window.showErrorMessage(`Pacior Inline Edit Error: ${lastErrorMsg}`)
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err)
				Logger.error("[executePaciorInlineEdit] error:", msg)
				await postInlineCardMessage(chatSession, {
					type: "say",
					say: "error",
					text: `❌ **Pacior Inline Edit Error**: ${msg}`,
				})
				vscode.window.showErrorMessage(`Pacior Inline Edit Error: ${msg}`)
			} finally {
				// Mark turn as idle/completed in the turn state tracker
				if (chatSession?.controller?.turnStateTracker?.set) {
					chatSession.controller.turnStateTracker.set("idle")
					await chatSession.controller.postStateToWebview()
				}
			}
		},
	)

	if (!cleanedReplacement && cleanedReplacement !== "") {
		return
	}

	// Prepare proposed full document text for Diff Review
	const fullDocText = document.getText()
	const docStartOffset = document.offsetAt(targetRange.start)
	const docEndOffset = document.offsetAt(targetRange.end)
	const proposedDocText =
		fullDocText.slice(0, docStartOffset) + cleanedReplacement + fullDocText.slice(docEndOffset)

	// Open Diff Review tab using VscodeEditPreview
	const editPreview = new VscodeEditPreview()
	try {
		await editPreview.open({
			displayPath: filePath,
			absolutePath: filePath,
			leftContent: fullDocText,
			rightContent: proposedDocText,
			title: `${filePath} (Diff Review: Inline Edit)`,
		})

		// Use a persistent QuickPick modal UI that requires explicit selection
		// and allows immediate keyboard selection (Enter to Accept, Down+Enter or Esc to Reject)
		const qp = vscode.window.createQuickPick()
		qp.title = `Pacior Inline Edit Diff Review: ${path.basename(filePath)}`
		qp.placeholder = "Choose an action: Enter to Accept, Esc / Down+Enter to Reject"
		qp.items = [
			{
				label: "$(check) Accept and Apply Changes",
				description: "Swap selected code with the generated diff",
				alwaysShow: true,
			},
			{
				label: "$(x) Reject Changes",
				description: "Preserve original code and close diff preview",
				alwaysShow: true,
			},
		]
		qp.ignoreFocusOut = true // Never disappears when clicking away

		const choicePromise = new Promise<string>((resolve) => {
			qp.onDidAccept(() => {
				const selected = qp.selectedItems[0]?.label || ""
				resolve(selected.includes("Accept") ? "Accept" : "Reject")
				qp.hide()
			})
			qp.onDidHide(() => {
				resolve("Reject")
				qp.dispose()
			})
		})

		qp.show()
		const choice = await choicePromise

		if (choice === "Accept") {
			const edit = new vscode.WorkspaceEdit()
			edit.replace(document.uri, targetRange, cleanedReplacement)
			const success = await vscode.workspace.applyEdit(edit)
			if (success) {
				await postInlineCardMessage(chatSession, {
					type: "say",
					say: "info",
					text: `✓ **Inline Edit Accepted**: Applied changes to \`${filePath}\`.`,
				})
			} else {
				vscode.window.showErrorMessage("Pacior Inline Edit: Failed to apply changes.")
			}
		} else {
			await postInlineCardMessage(chatSession, {
				type: "say",
				say: "info",
				text: `✕ **Inline Edit Rejected**: Discarded changes to \`${filePath}\`.`,
			})
		}
	} finally {
		await editPreview.close()
	}
}
