import { VSCodeButton, VSCodeDropdown, VSCodeOption, VSCodeTextArea, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { CheckCircle2, ExternalLink, RefreshCw, Server, XCircle } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import Section from "../Section"

interface TrueForgeModelItem {
	name: string
	model_id?: string
	provider?: { name?: string }
	properties?: {
		context_length?: number
		max_output_tokens?: number
		reasoning_efforts?: string[]
	}
}

interface TrueForgeAgentItem {
	id: string
	name: string
	description?: string
	manifest: {
		model?: {
			name?: string
			params?: {
				max_tokens?: number
				reasoning_effort?: string
			}
		}
		instructions?: string
		config?: Record<string, unknown>
	}
}

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

const DEFAULT_BASE_URL = "http://localhost:8790"
const DEFAULT_AGENT_NAME = "pacior"

const ApiConfigurationSection = ({ renderSectionHeader }: ApiConfigurationSectionProps) => {
	const [baseUrl, setBaseUrl] = useState<string>(() => {
		try {
			return localStorage.getItem("trueforge.baseUrl") || DEFAULT_BASE_URL
		} catch {
			return DEFAULT_BASE_URL
		}
	})
	const [agents, setAgents] = useState<TrueForgeAgentItem[]>([])
	const [models, setModels] = useState<TrueForgeModelItem[]>([])
	const [selectedAgentId, setSelectedAgentId] = useState<string>("")
	const [selectedModel, setSelectedModel] = useState<string>("")
	const [reasoningEffort, setReasoningEffort] = useState<string>("off")
	const [maxTokens, setMaxTokens] = useState<string>("4096")
	const [instructions, setInstructions] = useState<string>("")
	const [connected, setConnected] = useState<boolean | null>(null)
	const [loading, setLoading] = useState<boolean>(false)
	const [saving, setSaving] = useState<boolean>(false)
	const [statusMessage, setStatusMessage] = useState<string>("")
	const [errorMessage, setErrorMessage] = useState<string>("")

	const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL

	const applyAgentToForm = useCallback((agent: TrueForgeAgentItem) => {
		setSelectedAgentId(agent.id)
		const modelName = agent.manifest?.model?.name ?? ""
		setSelectedModel(modelName)
		setReasoningEffort(agent.manifest?.model?.params?.reasoning_effort ?? "off")
		setMaxTokens(String(agent.manifest?.model?.params?.max_tokens ?? 4096))
		setInstructions(agent.manifest?.instructions ?? "")
		try {
			localStorage.setItem("trueforge.agentName", agent.name)
			if (modelName) {
				localStorage.setItem("trueforge.activeModel", modelName)
			}
		} catch {
			// ignore storage errors
		}
	}, [])

	const loadFromTrueForge = useCallback(async () => {
		setLoading(true)
		setErrorMessage("")
		setStatusMessage("")
		try {
			const [agentsRes, modelsRes] = await Promise.all([
				fetch(`${cleanBaseUrl}/api/v1/agents?limit=50`),
				fetch(`${cleanBaseUrl}/api/v1/models`),
			])
			if (!agentsRes.ok || !modelsRes.ok) {
				throw new Error(`TrueForge returned HTTP ${!agentsRes.ok ? agentsRes.status : modelsRes.status}`)
			}
			const agentsJson = (await agentsRes.json()) as { data?: TrueForgeAgentItem[] }
			const modelsJson = (await modelsRes.json()) as { data?: TrueForgeModelItem[] }
			const loadedAgents = agentsJson.data ?? []
			const loadedModels = modelsJson.data ?? []

			setAgents(loadedAgents)
			setModels(loadedModels)
			setConnected(true)

			const preferredName = (() => {
				try {
					return localStorage.getItem("trueforge.agentName") || DEFAULT_AGENT_NAME
				} catch {
					return DEFAULT_AGENT_NAME
				}
			})()
			const target =
				loadedAgents.find((a) => a.name.toLowerCase() === preferredName.toLowerCase()) ??
				loadedAgents[0]
			if (target) {
				applyAgentToForm(target)
			}
		} catch (err) {
			setConnected(false)
			setErrorMessage(
				err instanceof Error
					? `Cannot reach TrueForge at ${cleanBaseUrl}: ${err.message}`
					: `Cannot reach TrueForge at ${cleanBaseUrl}`,
			)
		} finally {
			setLoading(false)
		}
	}, [applyAgentToForm, cleanBaseUrl])

	useEffect(() => {
		void loadFromTrueForge()
	}, [loadFromTrueForge])

	const handleAgentChange = (agentId: string) => {
		const found = agents.find((a) => a.id === agentId)
		if (found) {
			applyAgentToForm(found)
		}
	}

	const handleSaveSync = async () => {
		const activeAgent = agents.find((a) => a.id === selectedAgentId)
		if (!activeAgent) {
			setErrorMessage("No TrueForge agent selected.")
			return
		}
		setSaving(true)
		setErrorMessage("")
		setStatusMessage("")
		try {
			localStorage.setItem("trueforge.baseUrl", cleanBaseUrl)
			localStorage.setItem("trueforge.agentName", activeAgent.name)
			if (selectedModel) {
				localStorage.setItem("trueforge.activeModel", selectedModel)
			}

			const parsedMaxTokens = Math.max(256, Number.parseInt(maxTokens, 10) || 4096)
			const modelParams: Record<string, unknown> = {
				max_tokens: parsedMaxTokens,
			}
			if (reasoningEffort && reasoningEffort !== "off") {
				modelParams.reasoning_effort = reasoningEffort
			}

			const updatedManifest = {
				...activeAgent.manifest,
				model: {
					name: selectedModel || activeAgent.manifest?.model?.name,
					params: modelParams,
				},
				instructions,
			}

			const res = await fetch(`${cleanBaseUrl}/api/v1/agents/${activeAgent.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ manifest: updatedManifest }),
			})
			if (!res.ok) {
				const errText = await res.text()
				throw new Error(`HTTP ${res.status}: ${errText}`)
			}
			setStatusMessage(`Synced "${activeAgent.name}" (${selectedModel}) to TrueForge!`)
			await loadFromTrueForge()
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Failed to sync settings to TrueForge")
		} finally {
			setSaving(false)
		}
	}

	const activeModelMeta = models.find((m) => m.name === selectedModel)

	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				<div className="flex flex-col gap-4">
					{/* Connection Status Header */}
					<div className="flex items-center justify-between gap-2 p-2.5 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)]">
						<div className="flex items-center gap-2 text-xs">
							<Server className="w-4 h-4 shrink-0" />
							<span className="font-medium">TrueForge Runtime</span>
							{connected === true && (
								<span className="inline-flex items-center gap-1 text-[var(--vscode-testing-iconPassed)]">
									<CheckCircle2 className="w-3.5 h-3.5" />
									Connected
								</span>
							)}
							{connected === false && (
								<span className="inline-flex items-center gap-1 text-[var(--vscode-errorForeground)]">
									<XCircle className="w-3.5 h-3.5" />
									Disconnected
								</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							<VSCodeButton appearance="secondary" disabled={loading} onClick={() => void loadFromTrueForge()}>
								<span className="inline-flex items-center gap-1 text-xs">
									<RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
									Refresh
								</span>
							</VSCodeButton>
							<a
								className="inline-flex items-center gap-1 text-xs text-[var(--vscode-textLink-foreground)] hover:underline"
								href={cleanBaseUrl}
								rel="noreferrer"
								target="_blank">
								Dashboard <ExternalLink className="w-3 h-3" />
							</a>
						</div>
					</div>

					{/* Server URL */}
					<div className="flex flex-col gap-1">
						<label className="text-xs font-medium" htmlFor="tf-base-url">
							TrueForge Server URL
						</label>
						<VSCodeTextField
							id="tf-base-url"
							onInput={(e: any) => setBaseUrl((e.target as HTMLInputElement).value)}
							placeholder="http://localhost:8790"
							value={baseUrl}
						/>
					</div>

					{/* Agent Selector */}
					<div className="flex flex-col gap-1">
						<label className="text-xs font-medium" htmlFor="tf-agent-select">
							Synced Agent
						</label>
						<VSCodeDropdown
							id="tf-agent-select"
							onChange={(e: any) => handleAgentChange((e.target as HTMLSelectElement).value)}
							value={selectedAgentId}>
							{agents.length === 0 ? (
								<VSCodeOption value="">No agents found</VSCodeOption>
							) : (
								agents.map((agent) => (
									<VSCodeOption key={agent.id} value={agent.id}>
										{agent.name}
									</VSCodeOption>
								))
							)}
						</VSCodeDropdown>
					</div>

					{/* Model Provider & Model Selector */}
					<div className="flex flex-col gap-1">
						<label className="text-xs font-medium" htmlFor="tf-model-select">
							TrueForge Model (Provider / Model)
						</label>
						<VSCodeDropdown
							id="tf-model-select"
							onChange={(e: any) => setSelectedModel((e.target as HTMLSelectElement).value)}
							value={selectedModel}>
							{models.length === 0 ? (
								<VSCodeOption value={selectedModel}>{selectedModel || "No models configured"}</VSCodeOption>
							) : (
								models.map((m) => (
									<VSCodeOption key={m.name} value={m.name}>
										{m.name}
									</VSCodeOption>
								))
							)}
						</VSCodeDropdown>
						{activeModelMeta && (
							<div className="text-[11px] text-[var(--vscode-descriptionForeground)]">
								Provider: {activeModelMeta.provider?.name ?? "configured"} · Context:{" "}
								{activeModelMeta.properties?.context_length?.toLocaleString() ?? "128,000"} tokens
							</div>
						)}
					</div>

					{/* Reasoning Effort & Max Tokens */}
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<label className="text-xs font-medium" htmlFor="tf-reasoning">
								Reasoning Effort
							</label>
							<VSCodeDropdown
								id="tf-reasoning"
								onChange={(e: any) => setReasoningEffort((e.target as HTMLSelectElement).value)}
								value={reasoningEffort}>
								<VSCodeOption value="off">Off (disabled)</VSCodeOption>
								<VSCodeOption value="minimal">Minimal</VSCodeOption>
								<VSCodeOption value="low">Low</VSCodeOption>
								<VSCodeOption value="medium">Medium</VSCodeOption>
								<VSCodeOption value="high">High</VSCodeOption>
								<VSCodeOption value="max">Max</VSCodeOption>
							</VSCodeDropdown>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-xs font-medium" htmlFor="tf-max-tokens">
								Max Output Tokens
							</label>
							<VSCodeTextField
								id="tf-max-tokens"
								onInput={(e: any) => setMaxTokens((e.target as HTMLInputElement).value)}
								value={maxTokens}
							/>
						</div>
					</div>

					{/* System Instructions */}
					<div className="flex flex-col gap-1">
						<label className="text-xs font-medium" htmlFor="tf-instructions">
							Agent Instructions (Synced with TrueForge)
						</label>
						<VSCodeTextArea
							id="tf-instructions"
							onInput={(e: any) => setInstructions((e.target as HTMLTextAreaElement).value)}
							rows={5}
							value={instructions}
						/>
					</div>

					{errorMessage && (
						<div className="text-xs text-[var(--vscode-errorForeground)] p-2 rounded border border-[var(--vscode-errorForeground)]/30">
							{errorMessage}
						</div>
					)}
					{statusMessage && (
						<div className="text-xs text-[var(--vscode-testing-iconPassed)] p-2 rounded border border-[var(--vscode-testing-iconPassed)]/30">
							{statusMessage}
						</div>
					)}

					<div className="flex items-center justify-end gap-2">
						<VSCodeButton disabled={saving || !selectedAgentId} onClick={() => void handleSaveSync()}>
							{saving ? "Syncing..." : "Save & Sync to TrueForge"}
						</VSCodeButton>
					</div>
				</div>
			</Section>
		</div>
	)
}

export default ApiConfigurationSection
