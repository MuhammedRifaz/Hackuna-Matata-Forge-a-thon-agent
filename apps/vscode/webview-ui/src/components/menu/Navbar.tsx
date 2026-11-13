import { HistoryIcon, PlusIcon, PuzzleIcon, SettingsIcon } from "lucide-react"
import { useMemo } from "react"
import PaciorIcon from "@/assets/PaciorIcon"
import PaciorWordmark from "@/assets/PaciorWordmark"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "../../context/ExtensionStateContext"

interface NavbarProps {
	startNewTask: (source: "navbar") => Promise<boolean>
}

export const Navbar = ({ startNewTask }: NavbarProps) => {
	const { navigateToHistory, navigateToSettings, navigateToMarketplace, navigateToChat } = useExtensionState()

	const SETTINGS_TABS = useMemo(
		() => [
			{
				id: "chat",
				name: "Chat",
				tooltip: "New Task",
				icon: PlusIcon,
				navigate: async () => {
					try {
						if (await startNewTask("navbar")) {
							navigateToChat()
						}
					} catch (error) {
						console.error("Failed to clear task:", error)
					}
				},
			},
			{
				id: "customize",
				name: "Customize",
				tooltip: "Customize",
				icon: PuzzleIcon,
				navigate: navigateToMarketplace,
			},
			{
				id: "history",
				name: "History",
				tooltip: "History",
				icon: HistoryIcon,
				navigate: navigateToHistory,
			},
			{
				id: "settings",
				name: "Settings",
				tooltip: "Settings",
				icon: SettingsIcon,
				navigate: navigateToSettings,
			},
		],
		[navigateToChat, navigateToHistory, navigateToMarketplace, navigateToSettings, startNewTask],
	)

	return (
		<nav
			className="flex-none flex items-center justify-between w-full bg-transparent px-3 py-1.5 z-10 border-b border-[var(--vscode-panel-border)]/30"
			id="pacior-navbar-container">
			{/* Brand mark on left with quick return to chat */}
			<button
				aria-label="Pacior Home"
				className="flex items-center gap-1.5 bg-transparent border-0 p-0 m-0 cursor-pointer text-left focus:outline-none transition-opacity hover:opacity-85"
				onClick={() => navigateToChat()}
				type="button">
				<PaciorIcon className="w-5 h-5 shrink-0" variant="badge" />
				<PaciorWordmark className="h-3.5 w-auto max-w-[95px] shrink-0" showLabs={true} />
			</button>

			{/* Actions on right */}
			<div className="flex items-center gap-1 shrink-0">
				{SETTINGS_TABS.map((tab) => (
					<Tooltip key={`navbar-tooltip-${tab.id}`}>
						<TooltipContent side="bottom">{tab.tooltip}</TooltipContent>
						<TooltipTrigger asChild>
							<Button
								aria-label={tab.tooltip}
								className="p-0 h-7 w-7 text-[var(--vscode-foreground)] hover:text-[#B9E01E] transition-colors"
								data-testid={`tab-${tab.id}`}
								key={`navbar-button-${tab.id}`}
								onClick={() => tab.navigate()}
								size="icon"
								variant="icon">
								<tab.icon className="stroke-1 [svg]:size-4" size={17} />
							</Button>
						</TooltipTrigger>
					</Tooltip>
				))}
			</div>
		</nav>
	)
}
