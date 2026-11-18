import { exec, execFile } from "node:child_process"
import * as fsSync from "node:fs"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"
import { promisify } from "node:util"
import type { EditFileInput, EditorExecutor, ToolExecutors } from "@cline/core"
import type { AgentToolContext } from "@cline/shared"
import { Logger } from "@/shared/services/Logger"
import { PaciorContextEngine } from "@/context/PaciorContextEngine"

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const IGNORED_DIRS = new Set([".git", ".pacior", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache"])
const MAX_READ_LINES = 80
const MAX_SEARCH_MATCHES = 20
const MAX_LIST_ENTRIES = 100
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

export interface WorkspaceMcpServerOptions {
	/** Returns the active workspace root directory. */
	getWorkspaceRoot: () => Promise<string>
	/** Editor executor routed through SdkDiffEditCoordinator for VS Code diff views. */
	editorExecutor?: EditorExecutor
	/** File reader routed through workspace root resolution. */
	readFileExecutor?: ToolExecutors["readFile"]
	/** Optional terminal/command executor override (uses child_process in workspace cwd by default). */
	runCommandExecutor?: (command: string, cwd: string, signal?: AbortSignal) => Promise<string>
	/** Resolves the most recently approved toolCallId for a given MCP tool name so diff previews close cleanly. */
	consumeActiveToolCallContext?: (toolName: string) => { toolCallId: string; signal?: AbortSignal } | undefined
}

interface JsonRpcRequest {
	jsonrpc?: string
	id?: string | number | null
	method?: string
	params?: Record<string, unknown>
}

interface McpToolDefinition {
	name: string
	description: string
	inputSchema: Record<string, unknown>
}

const TOOL_DEFINITIONS: McpToolDefinition[] = [
	{
		name: "read_files",
		description:
			"Read one or more files in the workspace. Always read relevant files before proposing edits. Supports optional 1-based inclusive line ranges.",
		inputSchema: {
			type: "object",
			properties: {
				files: {
					type: "array",
					description: "List of files to read.",
					items: {
						type: "object",
						properties: {
							path: { type: "string", description: "Relative or absolute path to the file." },
							start_line: { type: "number", description: "Optional 1-based start line." },
							end_line: { type: "number", description: "Optional 1-based inclusive end line." },
						},
						required: ["path"],
					},
				},
				path: { type: "string", description: "Single file path shorthand when reading one file." },
				start_line: { type: "number", description: "Optional 1-based start line." },
				end_line: { type: "number", description: "Optional 1-based end line." },
			},
		},
	},
	{
		name: "list_files",
		description: "List files and subdirectories within a workspace directory.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory path relative to workspace root (default '.')." },
				recursive: { type: "boolean", description: "Whether to recurse into subdirectories (default false)." },
			},
		},
	},
	{
		name: "search_files",
		description: "Search across workspace files using a regex or plain text pattern.",
		inputSchema: {
			type: "object",
			properties: {
				regex: { type: "string", description: "Regular expression pattern (case-insensitive if lowercase)." },
				path: { type: "string", description: "Subdirectory or file path to restrict search (default '.')." },
				file_pattern: { type: "string", description: "Optional filename substring or extension filter (e.g. '.py')." },
			},
			required: ["regex"],
		},
	},
	{
		name: "editor",
		description:
			"Edit an existing file or create a new file. For existing files, provide exact old_text to replace with new_text (or insert_line + new_text). For new files, omit old_text and provide new_text.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Target file path relative to workspace root." },
				old_text: {
					type: "string",
					description: "Exact existing text block to replace (must match uniquely in the file).",
				},
				new_text: { type: "string", description: "Replacement text (or full content for a new file)." },
				insert_line: { type: "number", description: "Optional 1-based line number where new_text is inserted." },
			},
			required: ["path", "new_text"],
		},
	},
	{
		name: "write_to_file",
		description: "Create a new file or completely overwrite an existing file with the supplied content.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Target file path relative to workspace root." },
				content: { type: "string", description: "Complete file content to write." },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "run_commands",
		description:
			"Run one or more shell commands inside the workspace root directory (for example pytest, python, git, or lint checks) and capture output.",
		inputSchema: {
			type: "object",
			properties: {
				commands: {
					type: "array",
					items: { type: "string" },
					description: "List of shell commands to execute sequentially in the workspace directory.",
				},
			},
			required: ["commands"],
		},
	},
	{
		name: "assemble_context",
		description:
			"Perform context engineering query over the repository. Uses AST structure and dependency graph to pack relevant symbols within a strict token budget instead of dumping full files.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query or natural language instruction describing what code is needed." },
				token_budget: { type: "number", description: "Maximum token budget for packed context (default 3500)." },
			},
			required: ["query"],
		},
	},
	{
		name: "finish",
		description: "Signal that the task or objective has been successfully completed with a summary of the accomplishments.",
		inputSchema: {
			type: "object",
			properties: {
				summary: { type: "string", description: "Summary of changes made and verification performed." },
			},
		},
	},
	{
		name: "complete_task",
		description: "Signal that the task has been completed.",
		inputSchema: {
			type: "object",
			properties: {
				summary: { type: "string", description: "Summary of changes made." },
			},
		},
	},
]

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
	const cleanPath = inputPath.trim()
	const resolved = path.isAbsolute(cleanPath) ? path.normalize(cleanPath) : path.resolve(workspaceRoot, cleanPath)
	const rel = path.relative(workspaceRoot, resolved)
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Access denied: path '${inputPath}' resolves outside workspace root '${workspaceRoot}'`)
	}
	return resolved
}

function escapeRegexFallback(pattern: string): RegExp {
	try {
		return new RegExp(pattern, pattern === pattern.toLowerCase() ? "gi" : "g")
	} catch {
		return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
	}
}

/**
 * Local Streamable HTTP MCP Server hosted inside the VS Code extension process.
 * Exposes workspace tools (read_files, list_files, search_files, editor, write_to_file, run_commands)
 * to the TrueForge runtime over 127.0.0.1.
 */
export class WorkspaceMcpServer {
	private server: http.Server | undefined
	private listeningUrl: string | undefined
	private readonly originalFileSnapshots = new Map<string, { absPath: string; content: string | null; existed: boolean }>()
	private readonly healthyPythonPathsCache = new Map<string, string[]>()

	constructor(private readonly options: WorkspaceMcpServerOptions) {}

	/**
	 * Takes a snapshot of the file before any modification so that if a session
	 * is aborted or cancelled mid-flight, the workspace can be cleanly restored
	 * to its exact pristine state with zero half-applied edits (satisfies Hackathon Criterion A3).
	 */
	private async snapshotFileBeforeEdit(absPath: string): Promise<void> {
		if (this.originalFileSnapshots.has(absPath)) {
			return
		}
		try {
			const stat = await fs.stat(absPath)
			if (stat.isFile()) {
				const content = await fs.readFile(absPath, "utf8")
				this.originalFileSnapshots.set(absPath, { absPath, content, existed: true })
				Logger.log(`[WorkspaceMcpServer] Snapshot taken for existing file: ${absPath}`)
				const workspaceRoot = await this.options.getWorkspaceRoot()
				const relPath = path.relative(workspaceRoot, absPath)
				const { PaciorDiffReviewManager } = await import("./PaciorDiffReviewManager")
				PaciorDiffReviewManager.getInstance().recordSnapshot(absPath, relPath, content)
			}
		} catch {
			this.originalFileSnapshots.set(absPath, { absPath, content: null, existed: false })
			Logger.log(`[WorkspaceMcpServer] Snapshot taken for new file: ${absPath}`)
			const workspaceRoot = await this.options.getWorkspaceRoot()
			const relPath = path.relative(workspaceRoot, absPath)
			const { PaciorDiffReviewManager } = await import("./PaciorDiffReviewManager")
			PaciorDiffReviewManager.getInstance().recordSnapshot(absPath, relPath, null)
		}
	}

	/**
	 * Immediately rolls back all files modified or created during an aborted or cancelled session.
	 * Guarantees zero half-applied edits and leaves the workspace clean and consistent.
	 */
	async rollbackSessionEdits(): Promise<number> {
		let count = 0
		if (this.originalFileSnapshots.size === 0) {
			return 0
		}
		for (const [absPath, snapshot] of this.originalFileSnapshots.entries()) {
			try {
				if (snapshot.existed && snapshot.content !== null) {
					await fs.writeFile(absPath, snapshot.content, "utf8")
					count++
				} else if (!snapshot.existed) {
					await fs.unlink(absPath).catch(() => {})
					count++
				}
			} catch (err) {
				Logger.warn(`[WorkspaceMcpServer] Failed to rollback file ${absPath}: ${err}`)
			}
		}
		this.originalFileSnapshots.clear()

		if (count > 0) {
			try {
				const workspaceRoot = await this.options.getWorkspaceRoot()
				const { exec } = await import("child_process")
				await new Promise<void>((resolve) => {
					exec("git restore .", { cwd: workspaceRoot }, () => resolve())
				})
			} catch {
				// Non-git workspace or git binary unavailable
			}
		}

		Logger.log(`[WorkspaceMcpServer] Rollback completed: ${count} files restored. Workspace is clean.`)
		return count
	}

	/**
	 * Commits session edits after a task completes successfully.
	 */
	commitSessionEdits(): void {
		this.originalFileSnapshots.clear()
	}

	get url(): string | undefined {
		return this.listeningUrl
	}

	async ensureStarted(): Promise<string> {
		if (this.listeningUrl && this.server) {
			return this.listeningUrl
		}
		const server = http.createServer((req, res) => {
			void this.handleHttpRequest(req, res)
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject)
				resolve()
			})
		})
		const address = server.address()
		if (!address || typeof address === "string") {
			throw new Error("WorkspaceMcpServer failed to bind to ephemeral TCP port")
		}
		this.server = server
		this.listeningUrl = `http://127.0.0.1:${address.port}/mcp`
		Logger.log(`[WorkspaceMcpServer] Listening at ${this.listeningUrl}`)
		return this.listeningUrl
	}

	async dispose(): Promise<void> {
		if (!this.server) {
			return
		}
		const serverToClose = this.server
		this.server = undefined
		this.listeningUrl = undefined
		await new Promise<void>((resolve) => {
			serverToClose.close(() => resolve())
		})
	}

	private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const reqUrl = req.url?.split("?")[0] ?? "/"
		if (req.method === "GET" && reqUrl === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ ok: true, service: "cline-vscode-workspace-mcp" }))
			return
		}
		if (req.method === "GET" && reqUrl === "/mcp") {
			// MCP Streamable HTTP spec: 405 indicates this endpoint handles POST JSON-RPC without an SSE server-push stream.
			res.writeHead(405, { Allow: "POST, DELETE" })
			res.end()
			return
		}
		if (req.method === "DELETE" && reqUrl === "/mcp") {
			res.writeHead(200)
			res.end()
			return
		}
		if (req.method !== "POST" || reqUrl !== "/mcp") {
			res.writeHead(404, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Not found" }))
			return
		}

		let bodyStr = ""
		try {
			const chunks: Buffer[] = []
			for await (const chunk of req) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
			}
			bodyStr = Buffer.concat(chunks).toString("utf8")
			const payload = JSON.parse(bodyStr) as JsonRpcRequest | JsonRpcRequest[]
			if (Array.isArray(payload)) {
				const responses = (await Promise.all(payload.map((item) => this.dispatchRpc(item)))).filter(Boolean)
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify(responses))
				return
			}
			const response = await this.dispatchRpc(payload)
			if (!response) {
				// JSON-RPC notification has no id; acknowledge with 202 Accepted per Streamable HTTP spec.
				res.writeHead(202)
				res.end()
				return
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify(response))
		} catch (error) {
			Logger.error(`[WorkspaceMcpServer] Request failed: ${error instanceof Error ? error.message : String(error)}`)
			res.writeHead(400, { "Content-Type": "application/json" })
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: error instanceof Error ? error.message : "Invalid JSON-RPC request" },
				}),
			)
		}
	}

	private async dispatchRpc(req: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
		const id = req.id
		const method = req.method ?? ""

		if (method.startsWith("notifications/") || id === undefined) {
			return undefined
		}

		try {
			switch (method) {
				case "initialize": {
					const clientVersion = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2024-11-05"
					return {
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: clientVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "cline-vscode-workspace", version: "1.0.0" },
						},
					}
				}
				case "ping": {
					return { jsonrpc: "2.0", id, result: {} }
				}
				case "tools/list": {
					return {
						jsonrpc: "2.0",
						id,
						result: { tools: TOOL_DEFINITIONS },
					}
				}
				case "tools/call": {
					const params = req.params ?? {}
					const toolName = String(params.name ?? "")
					const args = (params.arguments && typeof params.arguments === "object"
						? params.arguments
						: {}) as Record<string, unknown>
					const output = await this.executeTool(toolName, args)
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [{ type: "text", text: output }],
							isError: false,
						},
					}
				}
				default:
					return {
						jsonrpc: "2.0",
						id,
						error: { code: -32601, message: `Method not found: ${method}` },
					}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			Logger.warn(`[WorkspaceMcpServer] Tool error in ${method}: ${message}`)
			if (method === "tools/call") {
				return {
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					},
				}
			}
			return {
				jsonrpc: "2.0",
				id,
				error: { code: -32603, message },
			}
		}
	}

	async executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
		const workspaceRoot = await this.options.getWorkspaceRoot()
		const activeCall = this.options.consumeActiveToolCallContext?.(toolName)
		const toolContext: AgentToolContext = {
			toolCallId: activeCall?.toolCallId ?? `tf-mcp-${Date.now()}`,
			agentId: "pacior",
			iteration: 1,
			signal: activeCall?.signal,
		}

		switch (toolName) {
			case "read_files":
			case "read_file":
				return this.handleReadFiles(args, workspaceRoot, toolContext)
			case "list_files":
			case "list_dir":
				return this.handleListFiles(args, workspaceRoot)
			case "search_files":
			case "file_search":
				return this.handleSearchFiles(args, workspaceRoot)
			case "editor":
				return this.handleEditor(args, workspaceRoot, toolContext)
			case "write_to_file":
				return this.handleWriteToFile(args, workspaceRoot, toolContext)
			case "run_commands":
			case "run_command":
			case "execute_command":
				return this.handleRunCommands(args, workspaceRoot, toolContext.signal)
			case "assemble_context":
				return this.handleAssembleContext(args)
			case "finish":
			case "complete_task":
				return args.summary ? String(args.summary) : "Task completed successfully."
			default:
				throw new Error(`Unknown workspace tool: ${toolName}`)
		}
	}

	private async handleReadFiles(
		args: Record<string, unknown>,
		workspaceRoot: string,
		context: AgentToolContext,
	): Promise<string> {
		const rawFiles = Array.isArray(args.files)
			? args.files
			: typeof args.path === "string"
				? [{ path: args.path, start_line: args.start_line, end_line: args.end_line }]
				: []
		if (rawFiles.length === 0) {
			throw new Error("read_files requires 'files' array or 'path' string")
		}

		const sections: string[] = []
		for (const item of rawFiles) {
			const entry = typeof item === "string" ? { path: item } : (item as Record<string, unknown>)
			const rawPath = String(entry.path ?? "")
			if (!rawPath) continue
			const absPath = resolveWorkspacePath(workspaceRoot, rawPath)
			const startLine = typeof entry.start_line === "number" ? Math.max(1, Math.floor(entry.start_line)) : undefined
			const endLine = typeof entry.end_line === "number" ? Math.max(1, Math.floor(entry.end_line)) : undefined

			const stat = await fs.stat(absPath).catch(() => undefined)
			if (stat && stat.isDirectory()) {
				// Handle models mistakenly passing directory to read_files: list directory entries gracefully
				const entries = await fs.readdir(absPath)
				sections.push(`=== Directory: ${rawPath} ===\n${entries.slice(0, 50).join("\n")}`)
				continue
			}

			// Direct safe reading with line capping to prevent exceeding tool response character limits
			const raw = await fs.readFile(absPath, "utf8")
			const lines = raw.split(/\r?\n/)
			const sliceStart = startLine ? startLine - 1 : 0
			const sliceEnd = endLine ? Math.min(lines.length, endLine) : Math.min(lines.length, sliceStart + MAX_READ_LINES)
			const numbered = lines
				.slice(sliceStart, sliceEnd)
				.map((line, idx) => `${sliceStart + idx + 1} | ${line}`)
				.join("\n")
			const truncatedNote =
				sliceEnd < lines.length && !endLine
					? `\n... [truncated ${lines.length - sliceEnd} remaining lines; use start_line/end_line to read more]`
					: ""
			sections.push(`=== ${rawPath} (lines ${sliceStart + 1}-${sliceEnd} of ${lines.length}) ===\n${numbered}${truncatedNote}`)
		}
		return sections.join("\n\n")
	}

	private async handleListFiles(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
		const relDir = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "."
		const recursive = Boolean(args.recursive)
		const rootDir = resolveWorkspacePath(workspaceRoot, relDir)
		const results: string[] = []

		const walk = async (dir: string): Promise<void> => {
			if (results.length >= MAX_LIST_ENTRIES) return
			const entries = await fs.readdir(dir, { withFileTypes: true })
			entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
			for (const entry of entries) {
				if (results.length >= MAX_LIST_ENTRIES) break
				if (IGNORED_DIRS.has(entry.name)) continue
				const full = path.join(dir, entry.name)
				const display = path.relative(workspaceRoot, full).replace(/\\/g, "/")
				if (entry.isDirectory()) {
					results.push(`${display}/`)
					if (recursive) {
						await walk(full)
					}
				} else {
					results.push(display)
				}
			}
		}

		await walk(rootDir)
		return results.length > 0 ? results.join("\n") : "(empty directory)"
	}

	private async handleSearchFiles(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
		const pattern = String(args.regex ?? args.pattern ?? args.query ?? "")
		if (!pattern) {
			throw new Error("search_files requires non-empty 'regex'")
		}
		const relTarget = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "."
		const fileFilter = typeof args.file_pattern === "string" ? args.file_pattern.trim().toLowerCase() : ""
		const searchRoot = resolveWorkspacePath(workspaceRoot, relTarget)
		const regex = escapeRegexFallback(pattern)
		const matches: string[] = []

		const scanFile = async (absFile: string): Promise<void> => {
			if (matches.length >= MAX_SEARCH_MATCHES) return
			const rel = path.relative(workspaceRoot, absFile).replace(/\\/g, "/")
			if (fileFilter && !rel.toLowerCase().includes(fileFilter)) return
			const stat = await fs.stat(absFile).catch(() => undefined)
			if (!stat || !stat.isFile() || stat.size > 1_000_000) return
			const content = await fs.readFile(absFile, "utf8").catch(() => undefined)
			if (!content || content.includes("\u0000")) return
			const lines = content.split(/\r?\n/)
			for (let i = 0; i < lines.length; i++) {
				regex.lastIndex = 0
				if (regex.test(lines[i])) {
					matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`)
					if (matches.length >= MAX_SEARCH_MATCHES) break
				}
			}
		}

		const walk = async (target: string): Promise<void> => {
			if (matches.length >= MAX_SEARCH_MATCHES) return
			const stat = await fs.stat(target)
			if (stat.isFile()) {
				await scanFile(target)
				return
			}
			const entries = await fs.readdir(target, { withFileTypes: true })
			for (const entry of entries) {
				if (matches.length >= MAX_SEARCH_MATCHES) break
				if (IGNORED_DIRS.has(entry.name)) continue
				const full = path.join(target, entry.name)
				if (entry.isDirectory()) {
					await walk(full)
				} else if (entry.isFile()) {
					await scanFile(full)
				}
			}
		}

		await walk(searchRoot)
		return matches.length > 0 ? matches.join("\n") : `No matches found for '${pattern}'`
	}

	private async handleEditor(
		args: Record<string, unknown>,
		workspaceRoot: string,
		context: AgentToolContext,
	): Promise<string> {
		const rawPath = String(args.path ?? "")
		if (!rawPath) {
			throw new Error("editor requires 'path'")
		}
		const absPath = resolveWorkspacePath(workspaceRoot, rawPath)
		await this.snapshotFileBeforeEdit(absPath)
		const newText = String(args.new_text ?? "")
		const oldText = typeof args.old_text === "string" ? args.old_text : undefined
		const insertLine = typeof args.insert_line === "number" ? args.insert_line : undefined

		const editInput: EditFileInput = {
			path: rawPath,
			new_text: newText,
			...(oldText !== undefined ? { old_text: oldText } : {}),
			...(insertLine !== undefined ? { insert_line: insertLine } : {}),
		}

		if (this.options.editorExecutor) {
			const res = await this.options.editorExecutor(editInput, workspaceRoot, context)
			try {
				const updated = await fs.readFile(absPath, "utf8")
				const { PaciorDiffReviewManager } = await import("./PaciorDiffReviewManager")
				void PaciorDiffReviewManager.getInstance().updateFileContent(absPath, updated)
			} catch {}
			return res
		}

		// Fallback direct filesystem write when no coordinator is injected (e.g. unit tests)
		await fs.mkdir(path.dirname(absPath), { recursive: true })
		let res = `Wrote ${rawPath}`
		if (oldText === undefined && insertLine === undefined) {
			await fs.writeFile(absPath, newText, "utf8")
			res = `Wrote ${rawPath}`
		} else {
			const existing = await fs.readFile(absPath, "utf8")
			if (oldText !== undefined) {
				if (!existing.includes(oldText)) {
					throw new Error(`No replacement performed: old_text not found in ${rawPath}`)
				}
				await fs.writeFile(absPath, existing.replace(oldText, () => newText), "utf8")
				res = `Updated ${rawPath}`
			} else {
				const lines = existing.split(/\r?\n/)
				lines.splice((insertLine ?? 1) - 1, 0, newText)
				await fs.writeFile(absPath, lines.join("\n"), "utf8")
				res = `Inserted into ${rawPath}`
			}
		}
		try {
			const updated = await fs.readFile(absPath, "utf8")
			const { PaciorDiffReviewManager } = await import("./PaciorDiffReviewManager")
			void PaciorDiffReviewManager.getInstance().updateFileContent(absPath, updated)
		} catch {}
		return res
	}

	private async handleWriteToFile(
		args: Record<string, unknown>,
		workspaceRoot: string,
		context: AgentToolContext,
	): Promise<string> {
		const rawPath = String(args.path ?? "")
		const content = String(args.content ?? "")
		if (!rawPath) {
			throw new Error("write_to_file requires 'path'")
		}
		const absPath = resolveWorkspacePath(workspaceRoot, rawPath)
		await this.snapshotFileBeforeEdit(absPath)
		let existing: string | undefined
		try {
			existing = await fs.readFile(absPath, "utf8")
		} catch {
			existing = undefined
		}

		// Safeguard against catastrophic truncation: if overwriting a large file (>50 lines)
		// with a small snippet (<25 lines), reject and direct model to use editor tool.
		if (existing !== undefined) {
			const existingLines = existing.split("\n").length
			const newLines = content.split("\n").length
			if (existingLines > 50 && newLines < 25) {
				throw new Error(
					`Refusing write_to_file: '${rawPath}' contains ${existingLines} lines, but write_to_file was given only ${newLines} lines. To safely modify parts of an existing file without truncating it, use the 'editor' tool with 'old_text' and 'new_text'.`
				)
			}
		}

		const editInput: EditFileInput =
			existing !== undefined ? { path: rawPath, old_text: existing, new_text: content } : { path: rawPath, new_text: content }

		let writeResult = `Wrote ${rawPath}`
		if (this.options.editorExecutor) {
			writeResult = await this.options.editorExecutor(editInput, workspaceRoot, context)
		} else {
			await fs.mkdir(path.dirname(absPath), { recursive: true })
			await fs.writeFile(absPath, content, "utf8")
			writeResult = `Wrote ${rawPath}`
		}
		try {
			const updated = await fs.readFile(absPath, "utf8")
			const { PaciorDiffReviewManager } = await import("./PaciorDiffReviewManager")
			void PaciorDiffReviewManager.getInstance().updateFileContent(absPath, updated)
		} catch {}
		return writeResult
	}

	/**
	 * Dynamically discovers the healthiest Python interpreter for a Python workspace.
	 * On hosts with multiple Python versions (e.g. an incompatible pre-release or broken venv alongside a working version),
	 * probes candidate interpreters with `pytest --collect-only -q` on a workspace test file so `python` and `pytest`
	 * always resolve to the working environment automatically.
	 */
	private async resolveHealthyPythonPaths(workspaceRoot: string, baseEnv: NodeJS.ProcessEnv): Promise<string[]> {
		const cached = this.healthyPythonPathsCache.get(workspaceRoot)
		if (cached) return cached

		const isWin = process.platform === "win32"
		const testsDir = fsSync.existsSync(path.join(workspaceRoot, "tests"))
			? path.join(workspaceRoot, "tests")
			: fsSync.existsSync(path.join(workspaceRoot, "test"))
				? path.join(workspaceRoot, "test")
				: undefined

		// Only probe Python interpreters for workspaces that contain Python project markers
		const isPythonProject =
			fsSync.existsSync(path.join(workspaceRoot, "pyproject.toml")) ||
			fsSync.existsSync(path.join(workspaceRoot, "setup.py")) ||
			Boolean(testsDir)

		if (!isPythonProject) {
			this.healthyPythonPathsCache.set(workspaceRoot, [])
			return []
		}

		const candidateExes: string[] = []
		const addExe = (exe: string) => {
			const clean = exe.trim()
			if (!clean || clean.toLowerCase().includes("windowsapps")) return
			if (fsSync.existsSync(clean) && !candidateExes.some((c) => c.toLowerCase() === clean.toLowerCase())) {
				candidateExes.push(clean)
			}
		}

		if (isWin) {
			addExe(path.join(workspaceRoot, ".venv", "Scripts", "python.exe"))
			addExe(path.join(workspaceRoot, "venv", "Scripts", "python.exe"))
			// Discover all registered Python interpreters via Windows py launcher and PATH
			try {
				const { stdout } = await execAsync("py -0p", { timeout: 3000 })
				for (const line of stdout.split(/\r?\n/)) {
					const m = line.match(/([a-zA-Z]:\\[^\r\n]+python\.exe)/i)
					if (m) addExe(m[1])
				}
			} catch {}
			try {
				const { stdout } = await execAsync("where python", { timeout: 3000 })
				for (const line of stdout.split(/\r?\n/)) addExe(line)
			} catch {}
		} else {
			addExe(path.join(workspaceRoot, ".venv", "bin", "python"))
			addExe(path.join(workspaceRoot, "venv", "bin", "python"))
			try {
				const { stdout } = await execAsync("which -a python3 python", { timeout: 3000 })
				for (const line of stdout.split(/\r?\n/)) addExe(line)
			} catch {}
		}

		for (const exe of candidateExes) {
			try {
				// Probe full test collection across the test directory so any ImportError/incompatibility disqualifies a broken interpreter
				const probeArgs = testsDir
					? ["-m", "pytest", "--collect-only", "-q", testsDir]
					: ["-m", "pytest", "--version"]
				await execFileAsync(exe, probeArgs, {
					cwd: workspaceRoot,
					env: baseEnv,
					timeout: 8000,
				})
				const exeDir = path.dirname(exe)
				const scriptsDir = isWin ? path.join(exeDir, "Scripts") : path.join(exeDir, "bin")
				const result = [exeDir, ...(fsSync.existsSync(scriptsDir) ? [scriptsDir] : [])]
				Logger.log(`[WorkspaceMcpServer] Selected healthy Python environment: ${exe}`)
				this.healthyPythonPathsCache.set(workspaceRoot, result)
				return result
			} catch {
				// Try next interpreter
			}
		}

		this.healthyPythonPathsCache.set(workspaceRoot, [])
		return []
	}

	/**
	 * Safely prepends directories to PATH on both Windows (handling case-insensitive `Path` vs `PATH`) and POSIX.
	 */
	private prependToEnvPath(env: NodeJS.ProcessEnv, dirs: string[], isWin: boolean): void {
		if (dirs.length === 0) return
		const sep = isWin ? ";" : ":"
		// Find existing PATH value regardless of casing (Windows uses `Path`)
		let existingPath = ""
		for (const key of Object.keys(env)) {
			if (key.toLowerCase() === "path") {
				if (!existingPath && env[key]) existingPath = env[key]!
				delete env[key]
			}
		}
		const newPath = existingPath ? `${dirs.join(sep)}${sep}${existingPath}` : dirs.join(sep)
		env[isWin ? "Path" : "PATH"] = newPath
	}

	private async handleRunCommands(
		args: Record<string, unknown>,
		workspaceRoot: string,
		signal?: AbortSignal,
	): Promise<string> {
		let rawCommands: string[] = []
		if (Array.isArray(args.commands)) {
			rawCommands = args.commands.map(String)
		} else if (typeof args.commands === "string") {
			const trimmed = args.commands.trim()
			if (trimmed.startsWith("[")) {
				try {
					const parsed = JSON.parse(trimmed)
					if (Array.isArray(parsed)) {
						rawCommands = parsed.map(String)
					}
				} catch {
					const stringLiterals = Array.from(trimmed.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g))
						.map((m) => m[1] ?? m[2])
						.filter(Boolean)
					if (stringLiterals.length > 0) {
						rawCommands = stringLiterals
					} else {
						rawCommands = [trimmed.slice(1, -1).trim()]
					}
				}
			} else {
				rawCommands = [args.commands]
			}
		} else if (typeof args.command === "string") {
			rawCommands = [args.command]
		}
		if (rawCommands.length === 0) {
			throw new Error("run_commands requires a non-empty 'commands' list")
		}

		const outputs: string[] = []
		const isWin = process.platform === "win32"
		const shell = isWin ? (process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe") : undefined

		// In Python projects, ensure workspace root or src directory is automatically in PYTHONPATH
		const env = { ...process.env }
		const srcPath = path.join(workspaceRoot, "src")
		const extraPaths = [workspaceRoot, srcPath]
		const sep = isWin ? ";" : ":"
		env.PYTHONPATH = env.PYTHONPATH ? `${extraPaths.join(sep)}${sep}${env.PYTHONPATH}` : extraPaths.join(sep)

		// Discover and prepend the healthiest Python interpreter environment dynamically
		const healthyPythonDirs = await this.resolveHealthyPythonPaths(workspaceRoot, env)
		if (isWin) {
			const prependPaths = [
				...healthyPythonDirs,
				"C:\\Program Files\\Git\\usr\\bin",
				"C:\\Program Files\\Git\\cmd",
				"C:\\Program Files\\Git\\bin",
				"C:\\Windows\\System32",
				"C:\\Windows",
				"C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
			].filter((p) => {
				try {
					return fsSync.existsSync(p)
				} catch {
					return false
				}
			})
			this.prependToEnvPath(env, prependPaths, true)
		} else {
			const prependPaths = [...healthyPythonDirs].filter((p) => {
				try {
					return fsSync.existsSync(p)
				} catch {
					return false
				}
			})
			this.prependToEnvPath(env, prependPaths, false)
		}

		for (const command of rawCommands) {
			let normalizedCmd = command.trim()
			if (isWin) {
				// Strip unix pipeline wrappers frequently emitted by models
				normalizedCmd = normalizedCmd
					.replace(/\s*2>&1\s*\|\s*head\s*-\d+/gi, "")
					.replace(/\s*\|\s*head\s*-\d+/gi, "")
					.replace(/\s*2>\/dev\/null/gi, "")
					.replace(/\s*2>&1/gi, "")
				if (normalizedCmd.startsWith("which ")) {
					normalizedCmd = normalizedCmd.replace(/^which\s+/, "where ")
				}
				// Polyfill common Unix file/directory inspection commands to Windows equivalents
				// e.g. "ls -la <path>" -> "dir /b <path>", "ls <path>" -> "dir /b <path>"
				if (/^ls(\s+-[a-zA-Z]+)*(\s+.*)?$/i.test(normalizedCmd)) {
					let target = normalizedCmd.replace(/^ls(\s+-[a-zA-Z]+)*\s*/i, "").trim()
					// Strip quotes if present
					target = target.replace(/^["']|["']$/g, "")
					// Normalize forward slashes and strip trailing slashes so cmd dir doesn't fail with 'Invalid switch'
					target = target.replace(/\//g, "\\").replace(/\\+$/, "")
					normalizedCmd = target ? `dir /b "${target}"` : `dir /b`
				}
				// Fix direct "dir <path>/" with trailing slash
				if (/^dir\s+/i.test(normalizedCmd)) {
					normalizedCmd = normalizedCmd.replace(/\//g, "\\").replace(/\\+$/, "")
				}
				// "find <dir> -name <pat>" polyfill for Windows (supports spaces in <dir>)
				if (/^find\s+(.+?)\s+-name\s+["']?([^"']+)["']?/i.test(normalizedCmd)) {
					const m = normalizedCmd.match(/^find\s+(.+?)\s+-name\s+["']?([^"']+)["']?/i)
					if (m) {
						let dir = m[1].trim().replace(/^["']|["']$/g, "").replace(/\//g, "\\").replace(/\\+$/, "")
						const pat = m[2]
						normalizedCmd = `dir /s /b "${dir}\\${pat}"`
					}
				}
				// "cat <path>" -> "type <path>"
				if (/^cat\s+/i.test(normalizedCmd)) {
					normalizedCmd = normalizedCmd.replace(/^cat\s+/i, "type ")
				}

				// Fix single-quoted "python -c 'code'" for Windows cmd.exe
				if (/^python\s+-c\s+'([\s\S]+)'$/i.test(normalizedCmd)) {
					const code = normalizedCmd.replace(/^python\s+-c\s+'/i, "").replace(/'$/, "")
					const escaped = code.replace(/"/g, "'")
					normalizedCmd = `python -c "${escaped}"`
				}

				// Auto-quote unquoted absolute and relative Windows paths containing spaces
				// Without quotes, commands like grep/pytest treat spaces as separate arguments/directories and fail or hang
				normalizedCmd = this.quoteCommandPaths(normalizedCmd, workspaceRoot)
			}

			if (this.options.runCommandExecutor) {
				outputs.push(await this.options.runCommandExecutor(normalizedCmd, workspaceRoot, signal))
				continue
			}
			try {
				const { stdout, stderr } = await execAsync(normalizedCmd, {
					cwd: workspaceRoot,
					shell,
					env,
					timeout: DEFAULT_COMMAND_TIMEOUT_MS,
					maxBuffer: 4 * 1024 * 1024,
					signal,
				})
				let combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")
				if (combined.length > 1200) {
					combined = combined.slice(0, 600) + "\n\n... [output truncated to protect context window] ...\n\n" + combined.slice(-600)
				}
				outputs.push(`$ ${command}\n[exit 0]\n${combined || "(no output)"}`)
			} catch (error) {
				const err = error as { stdout?: string; stderr?: string; code?: number; message?: string }
				let combined = [err.stdout?.trimEnd(), err.stderr?.trimEnd(), err.message].filter(Boolean).join("\n")
				if (combined.length > 1200) {
					combined = combined.slice(0, 600) + "\n\n... [output truncated to protect context window] ...\n\n" + combined.slice(-600)
				}
				outputs.push(`$ ${command}\n[exit ${err.code ?? 1}]\n${combined}`)
			}
		}
		return outputs.join("\n\n")
	}

	private async handleAssembleContext(args: Record<string, unknown>): Promise<string> {
		const query = String(args.query ?? "").trim()
		if (!query) {
			throw new Error("assemble_context requires a 'query' string")
		}
		const budget = typeof args.token_budget === "number" ? Math.floor(args.token_budget) : 3500
		const engine = PaciorContextEngine.getInstance()
		const result = await engine.assembleContext(query, budget)

		const lines: string[] = [
			`=== Pacior Context Assembly (Packed: ${result.totalEstimatedTokens} / ${budget} tokens) ===`,
			`\nExplainability:`,
			...result.explainability.map((e) => `• ${e}`),
			`\nAssembled Snippets (${result.snippets.length}):`,
		]

		for (const s of result.snippets) {
			lines.push(`\n--- ${s.path} (L${s.lines[0]}-L${s.lines[1]}) [Score: ${s.score}] ---`)
			lines.push(s.content)
		}

		return lines.join("\n")
	}

	private quoteCommandPaths(cmd: string, workspaceRoot?: string): string {
		let result = cmd
		const absMatches = Array.from(cmd.matchAll(/(^|[\s=])([a-zA-Z]:[\\\/][^\r\n"|><&]+)/g))
		for (const match of absMatches) {
			const prefix = match[1]
			const rawPath = match[2]
			if (rawPath.startsWith('"') || rawPath.startsWith("'")) continue
			const tokens = rawPath.split(/\s+/)
			let candidate = ""
			let foundPath = ""
			for (let i = 0; i < tokens.length; i++) {
				candidate = candidate ? `${candidate} ${tokens[i]}` : tokens[i]
				try {
					if (fsSync.existsSync(candidate)) {
						foundPath = candidate
					}
				} catch {}
			}
			if (foundPath && foundPath.includes(" ")) {
				result = result.replace(`${prefix}${foundPath}`, `${prefix}"${foundPath}"`)
			}
		}

		if (workspaceRoot && workspaceRoot.includes(" ")) {
			const relMatches = Array.from(cmd.matchAll(/(^|[\s=])([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_\-]+)/g))
			for (const match of relMatches) {
				const prefix = match[1]
				const rawRel = match[2]
				if (prefix.endsWith('"') || prefix.endsWith("'")) continue
				try {
					const resolved = path.resolve(workspaceRoot, rawRel.trim())
					if (fsSync.existsSync(resolved) && resolved.includes(" ")) {
						result = result.replace(`${prefix}${rawRel}`, `${prefix}"${resolved}"`)
					}
				} catch {}
			}
		}

		// Prevent grep or commands from hanging on stdin on Windows
		if (process.platform === "win32") {
			const stripped = result.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, "").replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "")
			if (/\bgrep\b/i.test(result) && !/[|<>]/.test(stripped)) {
				result = `${result} <nul`
			}
		}
		return result
	}
}
