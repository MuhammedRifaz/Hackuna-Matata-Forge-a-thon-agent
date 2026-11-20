import * as vscode from "vscode"
import type { VscodeWebviewProvider } from "@/hosts/vscode/VscodeWebviewProvider"
import { sendChatButtonClickedEvent } from "@/core/controller/ui/subscribeToChatButtonClicked"

/**
 * Task A: Inline Edit Mode (Ctrl+I / Cmd+I).
 *
 * Provides sub-1,000 token direct inline code editing directly inside the active editor:
 * 1. Takes the user's active editor selection (or active line) + minimal surrounding context.
 * 2. Prompts user via a quick floating input box for their edit instruction.
 * 3. Opens a NEW CHAT interface in the sidebar showing realtime streaming thoughts & text.
 * 4. Transparently renders model fallbacks and error cards inline in the chat.
 * 5. Applies edits via the `editor` tool and opens the post-task diff review.
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

	// 1. Reveal and focus sidebar
	await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")

	// 2. Obtain WebviewProvider controller
	const { WebviewProvider } = await import("@/core/webview/WebviewProvider")
	let sidebar = WebviewProvider.getInstance() as VscodeWebviewProvider | undefined
	let controller = sidebar?.controller
	if (!controller) {
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100))
			sidebar = WebviewProvider.getInstance() as VscodeWebviewProvider | undefined
			controller = sidebar?.controller
			if (controller) break
		}
	}

	if (!controller) {
		vscode.window.showErrorMessage("Pacior Inline Edit: Sidebar controller is not ready.")
		return
	}

	// 3. Ensure mode is set to 'act' so it executes directly without requiring an upfront plan phase
	try {
		const { StateManager } = await import("@/core/storage/StateManager")
		StateManager.get().setGlobalState("mode", "act")
	} catch {}

	// 4. Clear any stale task and switch webview immediately to Chat tab
	await controller.clearTask()
	await sendChatButtonClickedEvent()

	// 5. Build clean, minimal prompt for inline editing
	const prompt = [
		`✏️ **Pacior Inline Edit**: \`${filePath}:${targetRange.start.line + 1}\``,
		`> **Instruction**: ${instruction.trim()}`,
		"",
		`Target snippet from \`${filePath}\` (Lines ${targetRange.start.line + 1} to ${targetRange.end.line + 1}):`,
		"```" + languageId,
		selectedCode,
		"```",
		"",
		`STRICT INLINE EDIT INSTRUCTIONS:`,
		`1. Stream a 1-sentence explanation of the modification.`,
		`2. Directly replace the targeted snippet in \`${filePath}\` using the \`editor\` tool.`,
		`3. Do NOT search files, read other files, or run tests. Conclude immediately.`
	].join("\n")

	// 6. Launch a real task in the controller: mounts a brand new chat interface in the UI,
	// streams realtime reasoning/thinking and text deltas, shows errors/fallbacks as cards in the chat,
	// renders the answer, and triggers post-task diff review.
	await controller.initTask(prompt)
}
