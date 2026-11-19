import React, { useState } from "react"
import { PLATFORM_CONFIG } from "@/config/platform.config"

export interface DiffReviewFile {
	path: string
	absPath: string
	additions: number
	deletions: number
}

interface PostTaskDiffReviewBarProps {
	visible: boolean
	files: DiffReviewFile[]
}

export const PostTaskDiffReviewBar: React.FC<PostTaskDiffReviewBarProps> = ({ visible, files }) => {
	const [isExpanded, setIsExpanded] = useState(true)

	if (!visible || files.length === 0) {
		return null
	}

	const handleAcceptAll = () => {
		PLATFORM_CONFIG.postMessage({
			type: "pacior_diff_action",
			pacior_diff_action: { action: "accept_all" },
		})
	}

	const handleRejectAll = () => {
		PLATFORM_CONFIG.postMessage({
			type: "pacior_diff_action",
			pacior_diff_action: { action: "reject_all" },
		})
	}

	const handleOpenFile = (absPath: string) => {
		PLATFORM_CONFIG.postMessage({
			type: "pacior_diff_action",
			pacior_diff_action: { action: "open_file", path: absPath },
		})
	}

	const handleAcceptFile = (absPath: string) => {
		PLATFORM_CONFIG.postMessage({
			type: "pacior_diff_action",
			pacior_diff_action: { action: "accept_file", path: absPath },
		})
	}

	const handleRejectFile = (absPath: string) => {
		PLATFORM_CONFIG.postMessage({
			type: "pacior_diff_action",
			pacior_diff_action: { action: "reject_file", path: absPath },
		})
	}

	return (
		<div className="border border-(--vscode-editorGroup-border) bg-(--vscode-sideBar-background) rounded-md mx-2 mb-2 p-2.5 text-xs shadow-md select-none transition-all">
			{/* File list header row matching Image 2 */}
			{isExpanded && (
				<div className="mb-2 max-h-48 overflow-y-auto space-y-1.5 divide-y divide-(--vscode-editorGroup-border)/40">
					{files.map((file) => {
						const fileName = file.path.split(/[/\\]/).pop() || file.path
						return (
							<div
								key={file.absPath}
								className="pt-1.5 first:pt-0 flex items-center justify-between hover:bg-(--vscode-list-hoverBackground) px-1.5 py-1 rounded group transition-colors">
								<div
									onClick={() => handleOpenFile(file.absPath)}
									className="flex items-center gap-2 truncate cursor-pointer flex-1 min-w-0"
									title={`Click to view diff for ${file.path}`}>
									<span className="text-orange-400 font-bold text-sm leading-none">⊙</span>
									<span className="text-emerald-400 font-mono text-[11px] font-semibold">+{file.additions}</span>
									<span className="text-rose-400 font-mono text-[11px] font-semibold">-{file.deletions}</span>
									<span className="font-medium text-foreground group-hover:text-blue-400 transition-colors truncate">
										{fileName}
									</span>
									<span className="text-muted-foreground text-[10px] truncate max-w-[140px]">
										{file.path}
									</span>
								</div>
								<div className="flex items-center gap-1.5 ml-2 shrink-0">
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation()
											handleOpenFile(file.absPath)
										}}
										className="text-[10px] px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-(--vscode-toolbar-hoverBackground) rounded transition-colors"
										title="View diff in editor">
										Diff
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation()
											handleRejectFile(file.absPath)
										}}
										className="text-[10px] px-1.5 py-0.5 text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 border border-rose-500/30 rounded transition-colors"
										title="Reject this file's changes">
										Reject
									</button>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation()
											handleAcceptFile(file.absPath)
										}}
										className="text-[10px] px-2 py-0.5 font-semibold text-emerald-300 hover:text-emerald-200 bg-emerald-950/50 hover:bg-emerald-900/60 border border-emerald-500/40 rounded shadow-sm transition-colors"
										title="Accept this file's changes">
										Accept
									</button>
								</div>
							</div>
						)
					})}
				</div>
			)}

			{/* Bottom summary bar with Accept all / Reject all */}
			<div className="flex items-center justify-between pt-1 border-t border-(--vscode-editorGroup-border)/60">
				<button
					type="button"
					onClick={() => setIsExpanded(!isExpanded)}
					className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground font-medium transition-colors">
					<i className="codicon codicon-files text-sm" />
					<span>
						{files.length} {files.length === 1 ? "File" : "Files"} With Changes
					</span>
					<i className={`codicon codicon-chevron-${isExpanded ? "down" : "right"} text-xs`} />
				</button>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={handleRejectAll}
						className="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-(--vscode-toolbar-hoverBackground) rounded transition-colors">
						Reject all
					</button>
					<button
						type="button"
						onClick={handleAcceptAll}
						className="px-3.5 py-1 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded shadow-sm transition-colors">
						Accept all
					</button>
				</div>
			</div>
		</div>
	)
}

