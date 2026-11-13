import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import PaciorIcon from "@/assets/PaciorIcon"
import PaciorWordmark from "@/assets/PaciorWordmark"
import { ClineAuthStatus } from "@/components/account/ClineAuthStatus"
import { useClineSignIn } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ClinePassWelcomeCallout } from "./ClinePassCard"

export const AccountWelcomeView = () => {
	const { environment } = useExtensionState()
	const { isLoginLoading, authStatusMessage, handleSignIn } = useClineSignIn()

	return (
		<div className="flex flex-col items-center gap-2.5">
			<div className="flex flex-col items-center gap-2 mb-3">
				<PaciorIcon className="w-20 h-20" />
				<PaciorWordmark className="h-7 w-auto max-w-[220px]" showLabs={true} />
			</div>

			<p>
				Sign up for an account to get access to the latest models, billing dashboard to view usage and credits, and more
				upcoming features.
			</p>

			<ClinePassWelcomeCallout />

			<VSCodeButton className="w-full mb-4" disabled={isLoginLoading} onClick={handleSignIn}>
				Sign up with Cline
				{isLoginLoading && (
					<span className="ml-1 animate-spin">
						<span className="codicon codicon-refresh" />
					</span>
				)}
			</VSCodeButton>

			<ClineAuthStatus message={authStatusMessage} />

			<p className="text-(--vscode-descriptionForeground) text-xs text-center m-0">
				By continuing, you agree to the <VSCodeLink href="https://cline.bot/tos">Terms of Service</VSCodeLink> and{" "}
				<VSCodeLink href="https://cline.bot/privacy">Privacy Policy.</VSCodeLink>
			</p>
		</div>
	)
}
