import React, { useState, useEffect } from "react"
import { CpuIcon, RefreshCwIcon, DatabaseIcon, SparklesIcon, CheckCircle2Icon, AlertCircleIcon } from "lucide-react"
import { PLATFORM_CONFIG } from "@/config/platform.config"
import { Button } from "@/components/ui/button"

interface ContextStatus {
	isIndexing: boolean
	fileCount: number
	symbolCount: number
	lastIndexed: number
	message?: string
}

interface AssembledContext {
	query: string
	totalEstimatedTokens: number
	tokenBudget: number
	snippets: Array<{
		path: string
		lines: [number, number]
		score: number
		reason: string
		content: string
	}>
	explainability: string[]
}

interface ContextViewProps {
	onDone: () => void
}

export const ContextView: React.FC<ContextViewProps> = ({ onDone }) => {
	const [status, setStatus] = useState<ContextStatus>({
		isIndexing: false,
		fileCount: 0,
		symbolCount: 0,
		lastIndexed: 0,
	})
	const [latestAssembly, setLatestAssembly] = useState<AssembledContext | null>(null)
	const [testQuery, setTestQuery] = useState("add cli command to mask secret config")

	useEffect(() => {
		// Listen for context updates from host
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "pacior_context_update" && message.pacior_context_update) {
				if (message.pacior_context_update.status) {
					setStatus(message.pacior_context_update.status)
				}
				if (message.pacior_context_update.latestAssembly) {
					setLatestAssembly(message.pacior_context_update.latestAssembly)
				}
			}
		}

		window.addEventListener("message", handleMessage)

		// Request initial status
		PLATFORM_CONFIG.postMessage({
			type: "pacior_context_action",
			pacior_context_action: { action: "get_status" },
		})

		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const handleReindex = () => {
		PLATFORM_CONFIG.postMessage({
			type: "pacior_context_action",
			pacior_context_action: { action: "reindex" },
		})
	}

	const handleAssembleTest = () => {
		if (!testQuery.trim()) return
		PLATFORM_CONFIG.postMessage({
			type: "pacior_context_action",
			pacior_context_action: { action: "assemble", query: testQuery, tokenBudget: 3500 },
		})
	}

	const tokenPercent = latestAssembly
		? Math.min(100, Math.round((latestAssembly.totalEstimatedTokens / latestAssembly.tokenBudget) * 100))
		: 0

	return (
		<div className="flex flex-col h-full bg-[var(--vscode-sideBar-background)] text-[var(--vscode-foreground)] p-4 overflow-y-auto">
			{/* Top Header */}
			<div className="flex items-center justify-between pb-3 border-b border-[var(--vscode-panel-border)]/40 mb-4">
				<div className="flex items-center gap-2">
					<CpuIcon className="w-5 h-5 text-[#B9E01E]" />
					<h2 className="text-sm font-semibold text-foreground">Pacior Context Engine</h2>
				</div>
				<Button
					onClick={onDone}
					variant="secondary"
					className="h-7 px-3 text-xs bg-[var(--vscode-button-secondaryBackground)] hover:bg-[var(--vscode-button-secondaryHoverBackground)]">
					Done
				</Button>
			</div>

			{/* Index Status Card */}
			<div className="rounded-lg bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)]/50 p-4 mb-4">
				<div className="flex items-center justify-between mb-2">
					<span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
						<DatabaseIcon className="w-4 h-4 text-[#B9E01E]" /> AST & Dependency Index
					</span>
					{status.isIndexing ? (
						<span className="flex items-center gap-1 text-[11px] text-yellow-400 font-medium">
							<RefreshCwIcon className="w-3 h-3 animate-spin" /> Indexing in background...
						</span>
					) : (
						<span className="flex items-center gap-1 text-[11px] text-[#B9E01E] font-medium">
							<CheckCircle2Icon className="w-3.5 h-3.5" /> Ready & Cached
						</span>
					)}
				</div>

				{status.message && (
					<p className="text-[11px] text-muted-foreground mb-3 bg-[var(--vscode-panel-border)]/20 p-2 rounded">
						{status.message}
					</p>
				)}

				<div className="grid grid-cols-2 gap-3 mb-3">
					<div className="bg-[var(--vscode-sideBar-background)] p-2.5 rounded border border-[var(--vscode-panel-border)]/30">
						<div className="text-[10px] text-muted-foreground uppercase font-medium">Indexed Files</div>
						<div className="text-base font-bold text-foreground mt-0.5">{status.fileCount}</div>
					</div>
					<div className="bg-[var(--vscode-sideBar-background)] p-2.5 rounded border border-[var(--vscode-panel-border)]/30">
						<div className="text-[10px] text-muted-foreground uppercase font-medium">Parsed Symbols</div>
						<div className="text-base font-bold text-foreground mt-0.5">{status.symbolCount}</div>
					</div>
				</div>

				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground">
						{status.lastIndexed ? `Cached: ${new Date(status.lastIndexed).toLocaleTimeString()}` : "Not indexed yet"}
					</span>
					<Button
						onClick={handleReindex}
						disabled={status.isIndexing}
						className="h-6 text-[11px] px-2.5 bg-[#B9E01E] text-black font-semibold hover:bg-[#a6cb1b]">
						<RefreshCwIcon className={`w-3 h-3 mr-1 ${status.isIndexing ? "animate-spin" : ""}`} />
						Re-index Repository
					</Button>
				</div>
			</div>

			{/* Context Assembly & Token Knapsack Inspector */}
			<div className="rounded-lg bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)]/50 p-4 mb-4">
				<div className="flex items-center justify-between mb-3">
					<span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
						<SparklesIcon className="w-4 h-4 text-[#B9E01E]" /> Context Assembly & Knapsack
					</span>
				</div>

				<div className="flex items-center gap-2 mb-3">
					<input
						type="text"
						value={testQuery}
						onChange={(e) => setTestQuery(e.target.value)}
						placeholder="Test query (e.g. mask config)"
						className="flex-1 bg-[var(--vscode-input-background)] border border-[var(--vscode-input-border)] rounded px-2.5 py-1 text-xs text-foreground focus:outline-none"
					/>
					<Button
						onClick={handleAssembleTest}
						className="h-7 text-xs px-3 bg-[#B9E01E] text-black font-semibold hover:bg-[#a6cb1b]">
						Test Packing
					</Button>
				</div>

				{latestAssembly ? (
					<div>
						{/* Token Meter */}
						<div className="mb-3">
							<div className="flex justify-between text-[11px] mb-1">
								<span>Token Budget Usage</span>
								<span className="font-bold text-[#B9E01E]">
									{latestAssembly.totalEstimatedTokens} / {latestAssembly.tokenBudget} tokens ({tokenPercent}%)
								</span>
							</div>
							<div className="w-full bg-[var(--vscode-sideBar-background)] h-2 rounded overflow-hidden">
								<div
									className="bg-[#B9E01E] h-full transition-all duration-300"
									style={{ width: `${tokenPercent}%` }}
								/>
							</div>
						</div>

						{/* Explainability Breakdown */}
						<div className="mb-3">
							<div className="text-[11px] font-semibold text-muted-foreground mb-1.5">
								Explainability (Why Snippets Were Selected):
							</div>
							<div className="space-y-1.5 max-h-36 overflow-y-auto">
								{latestAssembly.explainability.map((exp, i) => (
									<div
										key={i}
										className="text-[10px] bg-[var(--vscode-sideBar-background)] p-1.5 rounded border border-[var(--vscode-panel-border)]/30 font-mono">
										{exp}
									</div>
								))}
							</div>
						</div>

						{/* Snippets Selected */}
						<div>
							<div className="text-[11px] font-semibold text-muted-foreground mb-1.5">
								Packed Snippets ({latestAssembly.snippets.length}):
							</div>
							<div className="space-y-2 max-h-48 overflow-y-auto">
								{latestAssembly.snippets.map((snip, i) => (
									<div
										key={i}
										className="bg-[var(--vscode-sideBar-background)] p-2 rounded border border-[var(--vscode-panel-border)]/40 text-[11px]">
										<div className="flex justify-between font-semibold text-[#B9E01E] font-mono text-[10px] mb-1">
											<span>{snip.path} (L{snip.lines[0]}-L{snip.lines[1]})</span>
											<span>Score: {snip.score}</span>
										</div>
										<pre className="text-[9px] bg-black/40 p-1.5 rounded overflow-x-auto text-muted-foreground max-h-24">
											{snip.content}
										</pre>
									</div>
								))}
							</div>
						</div>
					</div>
				) : (
					<p className="text-xs text-muted-foreground text-center py-4">
						Run a test packing above or send a prompt in chat to see real-time context assembly metrics.
					</p>
				)}
			</div>
		</div>
	)
}

export default ContextView

