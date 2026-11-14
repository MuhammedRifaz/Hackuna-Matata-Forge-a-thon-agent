import * as fs from "node:fs/promises"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { Logger } from "@/shared/services/Logger"

export interface AstSymbol {
	type: "function" | "class"
	name: string
	start_line: number
	end_line: number
	args?: string[]
	methods?: { name: string; start_line: number; end_line: number; args?: string[] }[]
	bases?: string[]
	docstring?: string | null
	decorators?: string[]
}

export interface AstImport {
	module: string
	name?: string | null
	asname?: string | null
	is_from: boolean
	line: number
}

export interface FileAstSummary {
	file: string
	line_count: number
	symbols: AstSymbol[]
	imports: AstImport[]
}

export interface RepoIndexCache {
	version: number
	timestamp: number
	workspaceRoot: string
	fileMap: Record<string, { mtime: number; summary: FileAstSummary }>
	dependencyGraph: Record<string, string[]> // file -> list of imported files
}

export class PaciorContextEngine {
	private static instance: PaciorContextEngine | null = null
	private cache: RepoIndexCache | null = null
	private isIndexing = false
	private workspaceRoot: string = ""
	private progressListeners: Array<(status: { isIndexing: boolean; progress: number; message: string }) => void> = []

	public static getInstance(): PaciorContextEngine {
		if (!PaciorContextEngine.instance) {
			PaciorContextEngine.instance = new PaciorContextEngine()
		}
		return PaciorContextEngine.instance
	}

	public onProgress(listener: (status: { isIndexing: boolean; progress: number; message: string }) => void) {
		this.progressListeners.push(listener)
	}

	private notifyProgress(progress: number, message: string) {
		for (const listener of this.progressListeners) {
			listener({ isIndexing: this.isIndexing, progress, message })
		}
	}

	public async initWorkspace(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot
		await this.loadCache()
		// Start background indexing non-blocking
		this.startIndexingInBackground(workspaceRoot).catch((err) => {
			Logger.error("[PaciorContextEngine] Indexing error:", err)
		})
	}

	private getCachePath(): string {
		return path.join(this.workspaceRoot, ".pacior", "context_cache.json")
	}

	private async loadCache(): Promise<void> {
		try {
			const cacheFile = this.getCachePath()
			const data = await fs.readFile(cacheFile, "utf-8")
			this.cache = JSON.parse(data)
			Logger.log(`[PaciorContextEngine] Loaded cache with ${Object.keys(this.cache?.fileMap || {}).length} files.`)
		} catch {
			this.cache = {
				version: 1,
				timestamp: Date.now(),
				workspaceRoot: this.workspaceRoot,
				fileMap: {},
				dependencyGraph: {},
			}
		}
	}

	private async saveCache(): Promise<void> {
		if (!this.cache) return
		try {
			const cacheDir = path.join(this.workspaceRoot, ".pacior")
			await fs.mkdir(cacheDir, { recursive: true })
			await fs.writeFile(this.getCachePath(), JSON.stringify(this.cache, null, 2), "utf-8")
		} catch (err) {
			Logger.error("[PaciorContextEngine] Failed to save cache:", err)
		}
	}

	public async startIndexingInBackground(workspaceRoot: string): Promise<void> {
		if (this.isIndexing) return
		this.isIndexing = true
		this.notifyProgress(10, "Scanning files for AST parsing...")

		try {
			const analyzerScript = path.join(__dirname, "pacior_ast_analyzer.py")
			const pythonCmd = process.platform === "win32" ? "python" : "python3"

			const pyProc = spawn(pythonCmd, [analyzerScript, workspaceRoot])
			let stdout = ""
			let stderr = ""

			pyProc.stdout.on("data", (d) => {
				stdout += d.toString()
			})
			pyProc.stderr.on("data", (d) => {
				stderr += d.toString()
			})

			await new Promise<void>((resolve, reject) => {
				pyProc.on("close", (code) => {
					if (code === 0) resolve()
					else reject(new Error(`Analyzer exited with ${code}: ${stderr}`))
				})
				pyProc.on("error", reject)
			})

			const rawResults: Record<string, FileAstSummary> = JSON.parse(stdout)
			const fileCount = Object.keys(rawResults).length

			if (!this.cache) {
				this.cache = {
					version: 1,
					timestamp: Date.now(),
					workspaceRoot,
					fileMap: {},
					dependencyGraph: {},
				}
			}

			const depGraph: Record<string, string[]> = {}

			for (const [relPath, summary] of Object.entries(rawResults)) {
				this.cache.fileMap[relPath] = {
					mtime: Date.now(),
					summary,
				}

				// Build dependency edges
				const dependencies: string[] = []
				for (const imp of summary.imports) {
					// Approximate module mapping: e.g. .cli -> flask/cli.py
					const cleanMod = imp.module.replace(/^\.+/, "")
					for (const candidate of Object.keys(rawResults)) {
						if (candidate.includes(cleanMod) && candidate !== relPath) {
							dependencies.push(candidate)
						}
					}
				}
				depGraph[relPath] = Array.from(new Set(dependencies))
			}

			this.cache.dependencyGraph = depGraph
			this.cache.timestamp = Date.now()
			await this.saveCache()

			this.notifyProgress(100, `Indexed ${fileCount} files & symbols successfully.`)
		} catch (err) {
			Logger.error("[PaciorContextEngine] Background indexing failed:", err)
			this.notifyProgress(0, `Indexing failed: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			this.isIndexing = false
		}
	}

	public getStatus() {
		return {
			isIndexing: this.isIndexing,
			fileCount: Object.keys(this.cache?.fileMap || {}).length,
			symbolCount: Object.values(this.cache?.fileMap || {}).reduce(
				(sum, f) => sum + (f.summary?.symbols?.length || 0),
				0,
			),
			lastIndexed: this.cache?.timestamp || 0,
		}
	}

	public getCache(): RepoIndexCache | null {
		return this.cache
	}

	/**
	 * Knapsack Context Packing
	 * Selects the highest scoring snippets and packs them strictly within the tokenBudget.
	 */
	public async assembleContext(query: string, tokenBudget = 3500): Promise<{
		snippets: Array<{ path: string; lines: [number, number]; score: number; reason: string; content: string }>
		totalEstimatedTokens: number
		explainability: string[]
	}> {
		if (!this.cache || Object.keys(this.cache.fileMap).length === 0) {
			return { snippets: [], totalEstimatedTokens: 0, explainability: ["Cache not ready, fallback active."] }
		}

		const keywords = query
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, " ")
			.split(/\s+/)
			.filter((k) => k.length > 2)

		interface Candidate {
			file: string
			start_line: number
			end_line: number
			score: number
			reason: string
			type: "symbol" | "skeleton" | "full"
		}

		const candidates: Candidate[] = []

		// 1. Score symbols from AST
		for (const [file, entry] of Object.entries(this.cache.fileMap)) {
			const symbols = entry.summary.symbols || []
			for (const sym of symbols) {
				let score = 0
				const reasons: string[] = []
				const symNameLower = sym.name.toLowerCase()

				for (const kw of keywords) {
					if (symNameLower === kw) {
						score += 50
						reasons.push(`Exact match for symbol '${kw}'`)
					} else if (symNameLower.includes(kw)) {
						score += 25
						reasons.push(`Symbol '${sym.name}' contains '${kw}'`)
					}
					if (sym.docstring && sym.docstring.toLowerCase().includes(kw)) {
						score += 15
						reasons.push(`Docstring mentions '${kw}'`)
					}
				}

				if (score > 0) {
					candidates.push({
						file,
						start_line: sym.start_line,
						end_line: sym.end_line,
						score,
						reason: reasons.join("; "),
						type: "symbol",
					})
				}
			}

			// Path matching
			for (const kw of keywords) {
				if (file.toLowerCase().includes(kw)) {
					candidates.push({
						file,
						start_line: 1,
						end_line: Math.min(100, entry.summary.line_count),
						score: 20,
						reason: `File path matches query keyword '${kw}'`,
						type: "skeleton",
					})
					break
				}
			}
		}

		// 2. Add 1-hop dependencies with moderate score
		const topFiles = new Set(candidates.slice(0, 5).map((c) => c.file))
		for (const topFile of topFiles) {
			const deps = this.cache.dependencyGraph[topFile] || []
			for (const dep of deps.slice(0, 3)) {
				candidates.push({
					file: dep,
					start_line: 1,
					end_line: Math.min(60, this.cache.fileMap[dep]?.summary?.line_count || 60),
					score: 15,
					reason: `Direct dependency of top hit '${topFile}'`,
					type: "skeleton",
				})
			}
		}

		// Sort by score descending
		candidates.sort((a, b) => b.score - a.score)

		// 3. Knapsack packing up to tokenBudget
		let currentTokens = 0
		const packedSnippets: Array<{ path: string; lines: [number, number]; score: number; reason: string; content: string }> = []
		const explainability: string[] = []
		const seenSpans = new Set<string>()

		for (const cand of candidates) {
			const spanKey = `${cand.file}:${cand.start_line}-${cand.end_line}`
			if (seenSpans.has(spanKey)) continue
			seenSpans.add(spanKey)

			try {
				const fullPath = path.isAbsolute(cand.file) ? cand.file : path.join(this.workspaceRoot, cand.file)
				const fileText = await fs.readFile(fullPath, "utf-8")
				const lines = fileText.split("\n")
				const snippetLines = lines.slice(Math.max(0, cand.start_line - 1), cand.end_line)
				const content = snippetLines.join("\n")
				
				// Rough token estimate: ~4 chars per token
				const estimatedTokens = Math.ceil(content.length / 4)

				if (currentTokens + estimatedTokens > tokenBudget) {
					// Stop when token ceiling is reached
					continue
				}

				currentTokens += estimatedTokens
				packedSnippets.push({
					path: cand.file,
					lines: [cand.start_line, cand.end_line],
					score: cand.score,
					reason: cand.reason,
					content,
				})

				explainability.push(
					`[${cand.file} L${cand.start_line}-L${cand.end_line}] (~${estimatedTokens} tokens) - ${cand.reason}`
				)
			} catch {
				// Ignore missing files or read errors
			}
		}

		return {
			snippets: packedSnippets,
			totalEstimatedTokens: currentTokens,
			explainability,
		}
	}
}

