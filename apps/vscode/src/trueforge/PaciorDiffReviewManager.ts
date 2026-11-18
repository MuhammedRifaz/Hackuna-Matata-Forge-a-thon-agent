import * as vscode from "vscode"
import * as path from "path"
import * as diff from "diff"
import * as fs from "fs/promises"
import { Logger } from "@/shared/services/Logger"
import { WebviewProvider } from "@/core/webview"
import { VscodeWebviewProvider } from "@/hosts/vscode/VscodeWebviewProvider"

export interface DiffHunkInfo {
	hunkIndex: number
	oldStart: number
	oldLines: number
	newStart: number
	newLines: number
	lines: string[]
	status: "pending" | "accepted" | "rejected"
}

export interface TrackedFileReview {
	absPath: string
	relPath: string
	originalContent: string | null
	currentContent: string
	additions: number
	deletions: number
	hunks: DiffHunkInfo[]
}

export class PaciorDiffReviewManager implements vscode.CodeLensProvider {
	private static instance: PaciorDiffReviewManager | null = null

	private trackedFiles = new Map<string, TrackedFileReview>()
	private codeLensEmitter = new vscode.EventEmitter<void>()
	public readonly onDidChangeCodeLenses = this.codeLensEmitter.event

	private addedDecorationType: vscode.TextEditorDecorationType
	private isReviewVisible = false

	private constructor() {
		this.addedDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(0, 255, 0, 0.12)",
			isWholeLine: true,
			border: "1px solid rgba(0, 255, 0, 0.4)",
			overviewRulerColor: "rgba(0, 255, 0, 0.7)",
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		})

		vscode.window.onDidChangeActiveTextEditor(() => this.updateDecorations())
		vscode.workspace.onDidChangeTextDocument((e) => {
			if (this.trackedFiles.has(e.document.uri.fsPath)) {
				this.updateDecorations()
			}
		})
	}

	static getInstance(): PaciorDiffReviewManager {
		if (!PaciorDiffReviewManager.instance) {
			PaciorDiffReviewManager.instance = new PaciorDiffReviewManager()
		}
		return PaciorDiffReviewManager.instance
	}

	static register(context: vscode.ExtensionContext): PaciorDiffReviewManager {
		const manager = PaciorDiffReviewManager.getInstance()
		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider({ scheme: "file" }, manager),
			vscode.commands.registerCommand("pacior.acceptHunk", (absPath: string, hunkIndex: number) =>
				manager.acceptHunk(absPath, hunkIndex),
			),
			vscode.commands.registerCommand("pacior.rejectHunk", (absPath: string, hunkIndex: number) =>
				manager.rejectHunk(absPath, hunkIndex),
			),
			vscode.commands.registerCommand("pacior.acceptAllDiffs", () => manager.acceptAll()),
			vscode.commands.registerCommand("pacior.rejectAllDiffs", () => manager.rejectAll()),
			vscode.commands.registerCommand("pacior.openDiffFile", (absPath: string) => manager.openFile(absPath)),
		)
		return manager
	}

	recordSnapshot(absPath: string, relPath: string, originalContent: string | null): void {
		if (this.trackedFiles.has(absPath)) return
		this.trackedFiles.set(absPath, {
			absPath,
			relPath: relPath.replace(/\\/g, "/"),
			originalContent,
			currentContent: originalContent ?? "",
			additions: 0,
			deletions: 0,
			hunks: [],
		})
	}

	async updateFileContent(absPath: string, newContent: string): Promise<void> {
		const record = this.trackedFiles.get(absPath)
		if (!record) return
		record.currentContent = newContent
		this.recomputeHunks(record)
		this.codeLensEmitter.fire()
		this.updateDecorations()
	}

	private recomputeHunks(record: TrackedFileReview): void {
		const oldStr = record.originalContent ?? ""
		const newStr = record.currentContent
		const patch = diff.structuredPatch(record.relPath, record.relPath, oldStr, newStr, "", "", { context: 0 })

		let adds = 0
		let dels = 0
		const hunks: DiffHunkInfo[] = []

		patch.hunks.forEach((h, idx) => {
			for (const l of h.lines) {
				if (l.startsWith("+")) adds++
				else if (l.startsWith("-")) dels++
			}
			hunks.push({
				hunkIndex: idx,
				oldStart: h.oldStart,
				oldLines: h.oldLines,
				newStart: h.newStart,
				newLines: h.newLines,
				lines: h.lines,
				status: "pending",
			})
		})

		record.additions = adds
		record.deletions = dels
		record.hunks = hunks
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (!this.isReviewVisible) return []
		const record = this.trackedFiles.get(document.uri.fsPath)
		if (!record || record.hunks.length === 0) return []

		const lenses: vscode.CodeLens[] = []
		for (const h of record.hunks) {
			if (h.status !== "pending") continue
			// 0-based line number in modified document
			const lineNum = Math.max(0, Math.min(document.lineCount - 1, h.newStart - 1))
			const range = new vscode.Range(lineNum, 0, lineNum, 0)

			lenses.push(
				new vscode.CodeLens(range, {
					title: "✓Accept",
					command: "pacior.acceptHunk",
					arguments: [record.absPath, h.hunkIndex],
					tooltip: "Accept this edit hunk",
				}),
				new vscode.CodeLens(range, {
					title: "✕Reject",
					command: "pacior.rejectHunk",
					arguments: [record.absPath, h.hunkIndex],
					tooltip: "Reject and revert this edit hunk",
				}),
			)
		}
		return lenses
	}

	private updateDecorations(): void {
		const editor = vscode.window.activeTextEditor
		if (!editor) return

		if (!this.isReviewVisible) {
			editor.setDecorations(this.addedDecorationType, [])
			return
		}

		const record = this.trackedFiles.get(editor.document.uri.fsPath)
		if (!record || record.hunks.length === 0) {
			editor.setDecorations(this.addedDecorationType, [])
			return
		}

		const ranges: vscode.Range[] = []
		for (const h of record.hunks) {
			if (h.status !== "pending" || h.newLines === 0) continue
			const startLine = Math.max(0, h.newStart - 1)
			const endLine = Math.min(editor.document.lineCount - 1, startLine + h.newLines - 1)
			ranges.push(new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER))
		}
		editor.setDecorations(this.addedDecorationType, ranges)
	}

	async acceptHunk(absPath: string, hunkIndex: number): Promise<void> {
		const record = this.trackedFiles.get(absPath)
		if (!record) return
		const hunk = record.hunks.find((h) => h.hunkIndex === hunkIndex)
		if (hunk) {
			hunk.status = "accepted"
			this.codeLensEmitter.fire()
			this.updateDecorations()
			this.checkAllResolved()
		}
	}

	async rejectHunk(absPath: string, hunkIndex: number): Promise<void> {
		const record = this.trackedFiles.get(absPath)
		if (!record) return
		const hunk = record.hunks.find((h) => h.hunkIndex === hunkIndex)
		if (!hunk) return

		// Build the reverted hunk text from lines starting with '-' or ' '
		const revertedLines = hunk.lines.filter((l) => !l.startsWith("+")).map((l) => l.slice(1))
		const replacementText = revertedLines.join("\n") + (revertedLines.length > 0 ? "\n" : "")

		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath))
		const edit = new vscode.WorkspaceEdit()
		const startLine = Math.max(0, hunk.newStart - 1)
		const endLine = Math.min(doc.lineCount, startLine + hunk.newLines)
		const range = new vscode.Range(startLine, 0, endLine, 0)
		edit.replace(doc.uri, range, replacementText)
		await vscode.workspace.applyEdit(edit)
		await doc.save()

		hunk.status = "rejected"
		record.currentContent = doc.getText()
		this.recomputeHunks(record)
		this.codeLensEmitter.fire()
		this.updateDecorations()
		this.broadcastReview()
		this.checkAllResolved()
	}

	async acceptAll(): Promise<void> {
		this.trackedFiles.clear()
		this.isReviewVisible = false
		this.codeLensEmitter.fire()
		this.updateDecorations()
		this.broadcastReview()
		vscode.window.showInformationMessage("All task changes accepted.")
	}

	async rejectAll(): Promise<void> {
		for (const [absPath, record] of this.trackedFiles.entries()) {
			try {
				if (record.originalContent !== null) {
					await fs.writeFile(absPath, record.originalContent, "utf8")
				} else {
					await fs.unlink(absPath).catch(() => {})
				}
			} catch (err) {
				Logger.warn(`[PaciorDiffReviewManager] Failed to revert ${absPath}: ${err}`)
			}
		}
		this.trackedFiles.clear()
		this.isReviewVisible = false
		this.codeLensEmitter.fire()
		this.updateDecorations()
		this.broadcastReview()
		vscode.window.showInformationMessage("All task changes rejected and reverted.")
	}

	async openFile(absPath: string): Promise<void> {
		try {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath))
			const editor = await vscode.window.showTextDocument(doc)
			const record = this.trackedFiles.get(absPath)
			if (record && record.hunks.length > 0) {
				const firstPending = record.hunks.find((h) => h.status === "pending") ?? record.hunks[0]
				const targetLine = Math.max(0, firstPending.newStart - 1)
				editor.revealRange(new vscode.Range(targetLine, 0, targetLine, 0), vscode.TextEditorRevealType.InCenter)
			}
		} catch (err) {
			Logger.warn(`[PaciorDiffReviewManager] Failed to open file ${absPath}: ${err}`)
		}
	}

	private checkAllResolved(): void {
		let hasPending = false
		for (const r of this.trackedFiles.values()) {
			if (r.hunks.some((h) => h.status === "pending")) {
				hasPending = true
				break
			}
		}
		if (!hasPending && this.trackedFiles.size > 0) {
			this.trackedFiles.clear()
			this.isReviewVisible = false
			this.broadcastReview()
		}
	}

	showReview(): void {
		// Filter out records where no actual changes occurred
		for (const [path, r] of Array.from(this.trackedFiles.entries())) {
			if (r.hunks.length === 0 || (r.additions === 0 && r.deletions === 0)) {
				this.trackedFiles.delete(path)
			}
		}
		if (this.trackedFiles.size === 0) return

		this.isReviewVisible = true
		this.codeLensEmitter.fire()
		this.updateDecorations()
		this.broadcastReview()

		// Automatically open the first modified file so the inline diff is immediately visible in the editor
		const firstFile = Array.from(this.trackedFiles.values())[0]
		if (firstFile) {
			void this.openFile(firstFile.absPath)
		}
	}

	broadcastReview(): void {
		try {
			const sidebarInstance = WebviewProvider.getInstance() as VscodeWebviewProvider
			const webview = sidebarInstance.getWebview()
			if (!webview) return

			const filesPayload = Array.from(this.trackedFiles.values())
				.filter((r) => r.hunks.some((h) => h.status === "pending"))
				.map((r) => ({
					path: r.relPath,
					absPath: r.absPath,
					additions: r.additions,
					deletions: r.deletions,
				}))

			void webview.webview.postMessage({
				type: "pacior_diff_review",
				pacior_diff_review: {
					visible: this.isReviewVisible && filesPayload.length > 0,
					files: filesPayload,
				},
			})
		} catch (err) {
			Logger.warn(`[PaciorDiffReviewManager] Failed to broadcast review: ${err}`)
		}
	}
}

