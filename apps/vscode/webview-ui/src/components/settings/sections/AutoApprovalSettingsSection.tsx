import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import Section from "../Section"
import SectionHeader from "../SectionHeader"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { ACTION_METADATA } from "@/components/chat/auto-approve-menu/constants"

interface AutoApprovalSettingsSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
}

const AutoApprovalSettingsSection = ({ renderSectionHeader }: AutoApprovalSettingsSectionProps) => {
	const { isChecked, updateAction } = useAutoApproveActions()

	return (
		<div>
			{renderSectionHeader ? (
				renderSectionHeader("auto-approval")
			) : (
				<SectionHeader>
					<div className="flex items-center gap-2">
						<i className="codicon codicon-check-all" />
						<div>Auto-Approval Permissions</div>
					</div>
				</SectionHeader>
			)}
			<Section>
				<p className="text-sm text-description mb-3">
					Control which actions the agent can perform automatically without prompting for approval.
					For judge evaluation and safety, all actions default to <strong>OFF</strong> on startup.
				</p>
				<div className="flex flex-col gap-2.5">
					{ACTION_METADATA.map((action) => {
						const checked = isChecked(action)
						return (
							<div key={action.id} className="flex flex-col">
								<div className="flex items-center gap-2">
									<VSCodeCheckbox
										checked={checked}
										onChange={(e: any) => {
											const val = e.target.checked === true
											void updateAction(action, val)
										}}>
										<span className="flex items-center gap-1.5 font-medium">
											<i className={`codicon ${action.icon}`} />
											{action.label}
										</span>
									</VSCodeCheckbox>
								</div>
							</div>
						)
					})}
				</div>
			</Section>
		</div>
	)
}

export default AutoApprovalSettingsSection
