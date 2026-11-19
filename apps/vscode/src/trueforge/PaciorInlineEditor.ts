import * as vscode from "vscode"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { TrueForgeClient } from "./TrueForgeClient"
import { VscodeEditPreview } from "@/hosts/vscode/VscodeEditPreview"
import type { VscodeWebviewProvider } from "@/hosts/vscode/VscodeWebviewProvider"

async function postInlineEditToChatUi(message: { type: "say"; say: "info" | "text" | "error"; text: string }): Promise<void> {
	try {
		const { WebviewProvider } = await import("@/core/webview/WebviewProvider")
		const sidebar = WebviewProvider.getInstance() as VscodeWebviewProvider | undefined
		const controller = sidebar?.controller
		if (!controller) return

		if (!controller.task) {
			const { createTaskProxy } = await import("@/sdk/task-proxy")
			controller.task = createTaskProxy(
				`inline-${Date.now()}`,
				controller.askResponse,
				controller.cancelTask,
			)
			controller.task.messageStateHandler.addMessages([
				{
					ts: Date.now(),
					type: "say",
					say: "task",
					text: message.text,
					partial: false,
				},
			])
		} else {
			controller.task.messageStateHandler.addMessages([
				{
					ts: Date.now(),
					type: message.type,
					say: message.say,
					text: message.text,
					partial: false,
				},
			])
		}
		await controller.postStateToWebview()
	} catch (e) {
		Logger.warn(`[PaciorInlineEditor] Failed to post to chat UI: ${e}`)
	}
}

/**
 * Task A: Inline Edit Mode (Ctrl+I / Cmd+I).
 *
 * Provides sub-1,000 token direct inline code editing directly inside the active editor:
 * 1. Takes the user's active editor selection (or active line) + minimal surrounding context.
 * 2. Prompts user via a quick floating input box for their edit instruction.
 * 3. Shows execution progress, errors, and model fallbacks transparently in the chat UI.
 * 4. Streams request to TrueForge with dynamic model shift resilience.
 * 5. Shows side-by-side Diff Review modal with Accept / Reject.
 * 6. On Accept: swaps code and writes changes. On Reject: discards preview with document untouched.
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

	// Post initial process message to chat UI
	await postInlineEditToChatUi({
		type: "say",
		say: "info",
		text: `✏️ **Pacior Inline Edit**: \`${filePath}:${targetRange.start.line + 1}\`\n> ${instruction.trim()}`,
	})

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
							if (ev.type === "model.message.delta" && ev.content) {
								replacement += ev.content
							} else if (ev.type === "turn.done") {
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

						await postInlineEditToChatUi({
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
							await postInlineEditToChatUi({
								type: "say",
								say: "info",
								text: `⚠️ **Model Shift**: Inline edit model error (${lastErrorMsg}). Automatically shifted to available fallback model "${nextCandidate.name}".`,
							})
						}
					}
				}

				if (!cleanedReplacement && cleanedReplacement !== "" && lastErrorMsg) {
					await postInlineEditToChatUi({
						type: "say",
						say: "error",
						text: `❌ **Pacior Inline Edit Failed**: ${lastErrorMsg}`,
					})
					vscode.window.showErrorMessage(`Pacior Inline Edit Error: ${lastErrorMsg}`)
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err)
				Logger.error("[executePaciorInlineEdit] error:", msg)
				await postInlineEditToChatUi({
					type: "say",
					say: "error",
					text: `❌ **Pacior Inline Edit Error**: ${msg}`,
				})
				vscode.window.showErrorMessage(`Pacior Inline Edit Error: ${msg}`)
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
				await postInlineEditToChatUi({
					type: "say",
					say: "info",
					text: `✓ **Inline Edit Accepted**: Applied changes to \`${filePath}\`.`,
				})
			} else {
				vscode.window.showErrorMessage("Pacior Inline Edit: Failed to apply changes.")
			}
		} else {
			await postInlineEditToChatUi({
				type: "say",
				say: "info",
				text: `✕ **Inline Edit Rejected**: Discarded changes to \`${filePath}\`.`,
			})
		}
	} finally {
		await editPreview.close()
	}
}
