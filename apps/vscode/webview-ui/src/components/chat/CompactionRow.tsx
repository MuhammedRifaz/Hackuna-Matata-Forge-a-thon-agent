import type { ClineCompactionInfo, ClineMessage } from "@shared/ExtensionMessage"
import { FoldVerticalIcon, LoaderCircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Mirrors the CLI's formatTokenCount (apps/cli/src/tui/utils/compaction-status.ts). */
function formatTokenCount(count: number): string {
	if (count < 1_000) {
		return `${count}`
	}
	if (count < 1_000_000) {
		return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`
	}
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

function parseCompactionInfo(text: string | undefined): ClineCompactionInfo | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
			return parsed as ClineCompactionInfo
		}
	} catch {
		// Fall through to undefined for malformed payloads.
	}
	return undefined
}

/** Mirrors the CLI's formatCompactionDividerLabel wording for product consistency. */
function formatCompactionLabel(info: ClineCompactionInfo): string {
	if (info.status === "started") {
		return info.mode === "manual" ? "Compacting context" : "Auto compacting context"
	}
	if (info.status === "failed") {
		return "Compaction failed"
	}
	if (info.status === "cancelled") {
		return "Compaction cancelled"
	}
	if (info.status === "skipped") {
		return "Compaction skipped"
	}
	const parts: string[] = [info.mode === "manual" ? "Context compacted (manual)" : "Context compacted"]
	if (typeof info.tokensBefore === "number" && typeof info.tokensAfter === "number") {
		parts.push(`${formatTokenCount(info.tokensBefore)} → ${formatTokenCount(info.tokensAfter)} tokens`)
	}
	if (typeof info.messagesBefore === "number" && typeof info.messagesAfter === "number") {
		parts.push(`${info.messagesBefore} → ${info.messagesAfter} messages`)
	}
	return parts.join(" · ")
}

/**
 * Divider row for context compaction progress and results — the webview
 * counterpart of the CLI's CompactionDividerRow. Shows a spinner while a
 * compaction is running; the same message (same ts) is updated in place to
 * its terminal state when it finishes.
 */
export const CompactionRow = ({ message }: { message: ClineMessage }) => {
	const info = parseCompactionInfo(message.text)
	if (!info) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}

	const inProgress = info.status === "started"
	const isFailed = info.status === "failed"

	return (
		<div
			className={cn(
				"border rounded-md p-2.5 my-2 shadow-sm flex items-center gap-2.5 select-none transition-all",
				isFailed
					? "border-red-500/60 bg-red-950/25 text-red-200"
					: "border-sky-500/60 bg-sky-950/30 text-sky-200"
			)}>
			{inProgress ? (
				<LoaderCircleIcon className="size-4 shrink-0 animate-spin text-sky-400" />
			) : (
				<FoldVerticalIcon className="size-4 shrink-0 text-sky-400" />
			)}
			<div className="flex-1 min-w-0 text-xs">
				<span className="font-semibold text-sky-300 mr-2">⚡ TrueForge Context Compaction (Criterion B4):</span>
				<span className="font-mono text-[11px] text-sky-100">
					{formatCompactionLabel(info)}
					{inProgress ? "…" : ""}
				</span>
			</div>
		</div>
	)
}

export default CompactionRow
