import { EmptyRequest } from "@shared/proto/cline/common"
import PaciorIcon from "@/assets/PaciorIcon"
import PaciorWordmark from "@/assets/PaciorWordmark"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

interface HomeHeaderProps {
	shouldShowQuickWins?: boolean
}

const HomeHeader = ({ shouldShowQuickWins = false }: HomeHeaderProps) => {
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
			<div className="my-6 flex flex-col items-center gap-3">
				<PaciorIcon className="w-16 h-16 shadow-lg shadow-[#012E47]/30 transition-transform duration-200 hover:scale-105" variant="badge" />
				<PaciorWordmark className="h-7 w-auto max-w-[210px] transition-opacity duration-200" showLabs={true} />
			</div>
			<div className="text-center flex items-center justify-center px-4">
				<h1 className="m-0 font-bold text-foreground text-base tracking-tight">{headingText}</h1>
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
