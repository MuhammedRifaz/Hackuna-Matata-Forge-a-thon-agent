import * as vscode from "vscode"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { TrueForgeClient } from "./TrueForgeClient"
import { VscodeEditPreview } from "@/hosts/vscode/VscodeEditPreview"

/**
 * Task A: Inline Edit Mode (Ctrl+I / Cmd+I).
 *
 * Provides sub-1,000 token direct inline code editing directly inside the active editor:
 * 1. Takes the user's active editor selection (or active line) + minimal surrounding context.
 * 2. Prompts user via a quick floating input box for their edit instruction.
 * 3. Streams a single 1-turn request to TrueForge asking strictly for the replacement text.
 * 4. Shows side-by-side Diff Review with Accept / Reject.
 * 5. On Accept: swaps code and writes changes. On Reject: discards preview with document untouched.
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

	// Capture surrounding lines (up to 15 lines before and after) to maintain context without token bloat
	const startLine = Math.max(0, targetRange.start.line - 15)
	const endLine = Math.min(document.lineCount - 1, targetRange.end.line + 15)
	const contextBefore = document.getText(new vscode.Range(startLine, 0, targetRange.start.line, targetRange.start.character))
	const contextAfter = document.getText(new vscode.Range(targetRange.end.line, targetRange.end.character, endLine, document.lineAt(endLine).text.length))

	const client = new TrueForgeClient(clientConfig)

	let cleanedReplacement = ""

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Pacior Inline Edit: Generating changes...",
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: "Requesting edit from TrueForge..." })

			try {
				const models = await client.listModels()
				const modelName = models[0]?.name ?? "openrouter-haashim/nvidia-nemotron-3-5-lightning-free"

				const session = await client.createSession({
					model: { name: modelName },
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
						if (ev.state.status === "done" && typeof ev.state.output?.content === "string") {
							replacement = ev.state.output.content
						}
					}
				}

				// Clean up temporary session
				client.deleteSession(session.id).catch(() => {})

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
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err)
				Logger.error("[executePaciorInlineEdit] error:", msg)
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

		// Use a persistent QuickPick modal UI so it never auto-dismisses like a notification
		// and allows immediate keyboard selection (Enter to Accept, Down+Enter or Esc to Reject)
		const qp = vscode.window.createQuickPick()
		qp.title = `Pacior Inline Edit Diff Review: ${path.basename(filePath)}`
		qp.placeholder = "Select an action (or press Enter to Accept, Esc to Reject)"
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
				vscode.window.showInformationMessage("Pacior Inline Edit: Applied changes successfully.")
			} else {
				vscode.window.showErrorMessage("Pacior Inline Edit: Failed to apply changes.")
			}
		} else {
			vscode.window.showInformationMessage("Pacior Inline Edit: Edit rejected, original code preserved.")
		}
	} finally {
		await editPreview.close()
	}
}
