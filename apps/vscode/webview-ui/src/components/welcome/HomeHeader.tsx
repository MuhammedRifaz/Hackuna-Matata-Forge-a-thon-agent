import { EmptyRequest } from "@shared/proto/cline/common"
import { CpuIcon } from "lucide-react"
import PaciorIcon from "@/assets/PaciorIcon"
import PaciorWordmark from "@/assets/PaciorWordmark"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

interface HomeHeaderProps {
	shouldShowQuickWins?: boolean
}

const HomeHeader = ({ shouldShowQuickWins = false }: HomeHeaderProps) => {
	const { navigateToContext } = useExtensionState()
	const handleTakeATour = async () => {
		try {
			await UiServiceClient.openWalkthrough(EmptyRequest.create())
		} catch (error) {
			console.error("Error opening walkthrough:", error)
		}
	}

	const headingText = "What can I do for you?"

	return (
		<div className="flex flex-col items-center mb-5 px-3">
			<div className="my-6 flex flex-col items-center gap-4">
				<PaciorIcon className="w-24 h-24 transition-transform duration-200 hover:scale-105" />
				<PaciorWordmark className="h-8 w-auto max-w-[240px] transition-opacity duration-200" showLabs={true} />
			</div>
			<div className="text-center flex items-center justify-center px-4">
				<h1 className="m-0 font-bold text-foreground text-base tracking-tight">{headingText}</h1>
			</div>

			{/* Context Engine Quick Access Pill */}
			<div className="mt-3">
				<button
					type="button"
					onClick={() => navigateToContext()}
					className="flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--vscode-panel-border)]/60 bg-[var(--vscode-editor-background)] hover:border-[#B9E01E]/60 text-xs text-muted-foreground hover:text-foreground transition-all cursor-pointer">
					<CpuIcon className="w-3.5 h-3.5 text-[#B9E01E]" />
					<span>Context Engine & Knapsack</span>
				</button>
			</div>

			{shouldShowQuickWins && (
				<div className="mt-4">
					<button
						className="flex items-center gap-2 px-4 py-2 rounded-full border border-border-panel bg-white/2 hover:bg-list-background-hover transition-colors duration-150 ease-in-out text-code-foreground text-sm font-medium cursor-pointer"
						onClick={handleTakeATour}
						type="button">
						Take a Tour
						<span className="codicon codicon-play scale-90" />
					</button>
				</div>
			)}
		</div>
	)
}

export default HomeHeader
