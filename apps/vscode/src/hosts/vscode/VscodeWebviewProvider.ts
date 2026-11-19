import { sendShowWebviewEvent } from "@core/controller/ui/subscribeToShowWebview"
import { WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { telemetryService } from "@/services/telemetry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"
import { PaciorContextEngine } from "@/context/PaciorContextEngine"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class VscodeWebviewProvider extends WebviewProvider implements vscode.WebviewViewProvider {
	// Used in package.json as the view's id. This value cannot be changed due to how vscode caches
	// views based on their id, and updating the id would break existing instances of the extension.
	public static readonly SIDEBAR_ID = ExtensionRegistryInfo.views.Sidebar

	private webview?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []
	private hasResolvedView = false

	override getWebviewUrl(path: string) {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		const uri = this.webview.webview.asWebviewUri(vscode.Uri.file(path))
		return uri.toString()
	}

	override getCspSource() {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		return this.webview.webview.cspSource
	}

	override isVisible() {
		return this.webview?.visible || false
	}

	public getWebview(): vscode.WebviewView | undefined {
		return this.webview
	}

	/**
	 * Initializes and sets up the webview when it's first created.
	 *
	 * @param webviewView - The sidebar webview view instance to be resolved
	 * @returns A promise that resolves when the webview has been fully initialized
	 */
	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		// A newer view supersedes any previous one (VS Code re-resolves this same
		// provider when the view is moved between sidebars). Release the previous
		// view's listeners up front in case its onDidDispose fired late or not at all.
		this.disposeView()
		this.webview = webviewView

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent()
				: this.getHtmlContent()

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received
		this.setWebviewMessageListener(webviewView.webview)
		telemetryService.capturePanelOpened("sidebar_resolved")

		// Hook up context engine progress notifications to webview
		const engine = PaciorContextEngine.getInstance()
		engine.onProgress((status) => {
			this.postMessageToWebview({
				type: "pacior_context_update",
				pacior_context_update: {
					status: {
						...engine.getStatus(),
						message: status.message,
					},
				},
			}).catch(() => {})
		})

		// Logs show up in bottom panel > Debug Console
		//Logger.log("registering listener")

		// Listen for when the sidebar becomes visible
		// https://github.com/microsoft/vscode-discussions/discussions/840

		// onDidChangeVisibility is only available on the sidebar webview
		// Otherwise WebviewView and WebviewPanel have all the same properties except for this visibility listener
		// WebviewPanel is not currently used in the extension
		webviewView.onDidChangeVisibility(
			async () => {
				if (this.webview?.visible) {
					telemetryService.capturePanelOpened("sidebar_visible")
					// View becoming visible should not steal editor focus.
					await sendShowWebviewEvent(true)
				}
			},
			null,
			this.disposables,
		)

		// Listen for when the view is disposed. This happens when the user moves the
		// view between the primary and secondary sidebars: VS Code destroys the old
		// WebviewView and calls resolveWebviewView again on this same provider with a
		// new one. Only release view-scoped resources here — the controller must stay
		// alive so the re-resolved view keeps working. The controller is disposed on
		// extension deactivation (tearDown -> WebviewProvider.disposeAllInstances).
		webviewView.onDidDispose(
			() => {
				// resolveWebviewView awaits HTML generation, so an old view's dispose
				// event can arrive after a newer view has already been resolved. Only
				// tear down if this view is still the active one.
				if (this.webview === webviewView) {
					this.disposeView()
				}
			},
			null,
			this.disposables,
		)

		// Clear stale task state only when the view first loads after activation.
		// Re-resolves (e.g. the view moved between sidebars) must not terminate an
		// active task.
		if (!this.hasResolvedView) {
			this.hasResolvedView = true
			this.controller.clearTask()
		}

		Logger.log("[VscodeWebviewProvider] Webview view resolved")

		// Title setting logic removed to allow VSCode to use the container title primarily.
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * IMPORTANT: When passing methods as callbacks in JavaScript/TypeScript, the method's
	 * 'this' context can be lost. This happens because the method is passed as a
	 * standalone function reference, detached from its original object.
	 *
	 * The Problem:
	 * Doing: webview.onDidReceiveMessage(this.controller.handleWebviewMessage)
	 * Would cause 'this' inside handleWebviewMessage to be undefined or wrong,
	 * leading to "TypeError: this.setUserInfo is not a function"
	 *
	 * The Solution:
	 * We wrap the method call in an arrow function, which:
	 * 1. Preserves the lexical scope's 'this' binding
	 * 2. Ensures handleWebviewMessage is called as a method on the controller instance
	 * 3. Maintains access to all controller methods and properties
	 *
	 * Alternative solutions could use .bind() or making handleWebviewMessage an arrow
	 * function property, but this approach is clean and explicit.
	 *
	 * @param webview The webview instance to attach the message listener to
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			(message) => {
				this.handleWebviewMessage(message)
			},
			null,
			this.disposables,
		)
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	async handleWebviewMessage(message: WebviewMessage) {
		const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)

		switch (message.type) {
			case "grpc_request": {
				if (message.grpc_request) {
					await handleGrpcRequest(this.controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			case "trueforge_proxy": {
				const req = message.trueforge_proxy
				if (!req) break
				try {
					const parsed = new URL(req.url)
					if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
						throw new Error("TrueForge proxy only allows localhost or 127.0.0.1")
					}
					const res = await fetch(req.url, {
						method: req.method || "GET",
						headers: req.body ? { "Content-Type": "application/json" } : undefined,
						body: req.body,
					})
					const body = await res.text()
					await postMessageToWebview({
						type: "trueforge_proxy_response",
						trueforge_proxy_response: {
							request_id: req.request_id,
							ok: res.ok,
							status: res.status,
							body,
						},
					})
				} catch (error) {
					await postMessageToWebview({
						type: "trueforge_proxy_response",
						trueforge_proxy_response: {
							request_id: req.request_id,
							ok: false,
							status: 0,
							body: "",
							error: error instanceof Error ? error.message : String(error),
						},
					})
				}
				break
			}
			case "pacior_context_action": {
				const actionData = message.pacior_context_action
				if (!actionData) break
				const engine = PaciorContextEngine.getInstance()

				if (actionData.action === "reindex") {
					const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
					await engine.startIndexingInBackground(root)
				} else if (actionData.action === "assemble" && actionData.query) {
					const assembly = await engine.assembleContext(actionData.query, actionData.tokenBudget || 3500)
					await postMessageToWebview({
						type: "pacior_context_update",
						pacior_context_update: {
							status: engine.getStatus(),
							latestAssembly: {
								query: actionData.query,
								totalEstimatedTokens: assembly.totalEstimatedTokens,
								tokenBudget: actionData.tokenBudget || 3500,
								snippets: assembly.snippets,
								explainability: assembly.explainability,
							},
						},
					})
					break
				}

				await postMessageToWebview({
					type: "pacior_context_update",
					pacior_context_update: {
						status: engine.getStatus(),
					},
				})
				break
			}
			case "pacior_diff_action": {
				const diffAction = message.pacior_diff_action
				if (!diffAction) break
				const { PaciorDiffReviewManager } = await import("../../trueforge/PaciorDiffReviewManager")
				const manager = PaciorDiffReviewManager.getInstance()
				if (diffAction.action === "accept_all") {
					await manager.acceptAll()
				} else if (diffAction.action === "reject_all") {
					await manager.rejectAll()
				} else if (diffAction.action === "open_file" && diffAction.path) {
					await manager.openFile(diffAction.path)
				} else if (diffAction.action === "accept_file" && diffAction.path) {
					await manager.acceptFile(diffAction.path)
				} else if (diffAction.action === "reject_file" && diffAction.path) {
					await manager.rejectFile(diffAction.path)
				}
				break
			}
			default: {
				Logger.error("Received unhandled WebviewMessage type:", JSON.stringify(message))
			}
		}
	}

	/**
	 * Sends a message from the extension to the webview.
	 *
	 * @param message - The message to send to the webview
	 * @returns A thenable that resolves to a boolean indicating success, or undefined if the webview is not available
	 */
	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		return this.webview?.webview.postMessage(message)
	}

	/**
	 * Releases resources tied to the current WebviewView without tearing down the
	 * controller, so this provider can be re-resolved with a new WebviewView (e.g.
	 * when the user moves the view to the other sidebar).
	 */
	private disposeView() {
		// WebviewView doesn't have a dispose method, it's managed by VSCode
		// We just need to clean up our disposables
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		this.webview = undefined
	}

	override async dispose() {
		this.disposeView()
		await super.dispose()
	}
}
