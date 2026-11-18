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
								onClick={() => handleOpenFile(file.absPath)}
								className="pt-1.5 first:pt-0 flex items-center justify-between cursor-pointer hover:bg-(--vscode-list-hoverBackground) px-1.5 py-1 rounded group">
								<div className="flex items-center gap-2 truncate">
									<span className="text-orange-400 font-bold text-sm leading-none">⊙</span>
									<span className="text-emerald-400 font-mono text-[11px] font-semibold">+{file.additions}</span>
									<span className="text-rose-400 font-mono text-[11px] font-semibold">-{file.deletions}</span>
									<span className="font-medium text-foreground group-hover:text-blue-400 transition-colors">
										{fileName}
									</span>
									<span className="text-muted-foreground text-[10px] truncate max-w-[180px]">
										{file.path}
									</span>
								</div>
								<span className="text-[10px] text-muted-foreground group-hover:text-foreground">
									View Diff
								</span>
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

