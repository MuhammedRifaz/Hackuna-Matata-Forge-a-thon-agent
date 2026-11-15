import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect } from "react"
import ChatErrorBoundary from "./components/chat/ChatErrorBoundary"
import AccountView from "./components/account/AccountView"
import ChatView from "./components/chat/ChatView"
import HistoryView from "./components/history/HistoryView"
import MarketplaceView from "./components/marketplace/MarketplaceView"
import McpView from "./components/mcp/configuration/McpConfigurationView"
import { openClinePassSubscriptionIfPending } from "./components/onboarding/clinePassSubscribe"
import OnboardingView from "./components/onboarding/OnboardingView"
import SettingsView from "./components/settings/SettingsView"
import WorktreesView from "./components/worktrees/WorktreesView"
import ContextView from "./components/context/ContextView"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpc-client"

const AppContent = () => {
	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		showMarketplace,
		showMcp,
		mcpTab,
		showSettings,
		settingsNavigationRequest,
		showHistory,
		showAccount,
		showWorktrees,
		showContext,
		showAnnouncement,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		closeMcpView,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		hideContext,
		navigateToContext,
		closeMarketplaceView,
		hideAnnouncement,
	} = useExtensionState()

	const { clineUser, organizations, activeOrganization, accountSwitch, accountSwitchError } = useClineAuth()

	const showUpdateAnnouncementModal = useCallback(() => {
		setShowAnnouncement(true)
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error) => {
				console.error("Failed to acknowledge announcement:", error)
			})
	}, [setShouldShowAnnouncement, setShowAnnouncement])

	useEffect(() => {
		if (!didHydrateState || showWelcome || !shouldShowAnnouncement || showAnnouncement) {
			return
		}
		showUpdateAnnouncementModal()
	}, [didHydrateState, showWelcome, shouldShowAnnouncement, showAnnouncement, showUpdateAnnouncementModal])

	// Open the ClinePass subscription page once auth completes. Lives here (not in OnboardingView)
	// because handleAuthCallback unmounts onboarding before the clineUser update arrives.
	useEffect(() => {
		if (clineUser?.uid) {
			openClinePassSubscriptionIfPending(clineUser.appBaseUrl)
		}
	}, [clineUser?.uid, clineUser?.appBaseUrl])

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === "pacior_context_open") {
				navigateToContext()
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [navigateToContext])

	if (!didHydrateState) {
		return (
			<div className="flex h-screen w-full items-center justify-center p-4 text-center text-vscode-descriptionForeground">
				<div className="flex flex-col items-center gap-2">
					<div className="animate-spin text-xl">⏳</div>
					<div className="text-sm">Connecting to workspace...</div>
				</div>
			</div>
		)
	}

	if (showWelcome) {
		return <OnboardingView />
	}

	return (
		<div className="flex h-screen w-full flex-col">
			{(accountSwitch || accountSwitchError) && !showAccount && (
				<div className="z-50 bg-editor-background p-2 text-xs" role="status">
					{accountSwitch
						? accountSwitch.slow
							? "Account switch is still pending. You can navigate while it finishes."
							: "Switching account…"
						: `Could not confirm account switch: ${accountSwitchError}`}
				</div>
			)}
			{showSettings && <SettingsView navigationRequest={settingsNavigationRequest} onDone={hideSettings} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showMarketplace && <MarketplaceView initialType={mcpTab ? "mcp" : undefined} onDone={closeMarketplaceView} />}
			{showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
			{showAccount && (
				<AccountView
					activeOrganization={activeOrganization}
					clineUser={clineUser}
					onDone={hideAccount}
					organizations={organizations}
				/>
			)}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
			{showContext && <ContextView onDone={hideContext} />}
			{/* Do not conditionally load ChatView, it's expensive and there's state we don't want to lose (user input, disableInput, askResponse promise, etc.) */}
			<ChatView
				hideAnnouncement={hideAnnouncement}
				isHidden={showSettings || showHistory || showMarketplace || showMcp || showAccount || showWorktrees || showContext}
				showAnnouncement={showAnnouncement}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

const App = () => {
	return (
		<Providers>
			<ChatErrorBoundary errorTitle="TrueForge Agent View Error" errorBody="An unexpected rendering issue occurred. Reload the window or start a new task.">
				<AppContent />
			</ChatErrorBoundary>
		</Providers>
	)
}

export default App
