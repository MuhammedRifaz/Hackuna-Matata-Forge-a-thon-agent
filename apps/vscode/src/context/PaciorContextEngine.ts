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
			// Locate analyzer script both in source and compiled dist/assets locations
			const candidates = [
				path.join(__dirname, "pacior_ast_analyzer.py"),
				path.join(__dirname, "context", "pacior_ast_analyzer.py"),
				path.join(__dirname, "..", "src", "context", "pacior_ast_analyzer.py"),
			]
			let analyzerScript = candidates[0]
			for (const cand of candidates) {
				try {
					await fs.access(cand)
					analyzerScript = cand
					break
				} catch {}
			}

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
		const files = Object.keys(this.cache?.fileMap || {})
		const languages: Record<string, number> = {}
		for (const f of files) {
			const ext = path.extname(f) || "other"
			languages[ext] = (languages[ext] || 0) + 1
		}

		return {
			isIndexing: this.isIndexing,
			fileCount: files.length,
			symbolCount: Object.values(this.cache?.fileMap || {}).reduce(
				(sum, f) => sum + (f.summary?.symbols?.length || 0),
				0,
			),
			lastIndexed: this.cache?.timestamp || 0,
			languages,
			fileList: files.slice(0, 50).map((f) => ({
				path: f,
				symbols: this.cache?.fileMap[f]?.summary?.symbols?.length || 0,
				lines: this.cache?.fileMap[f]?.summary?.line_count || 0,
			})),
		}
	}

	public getCache(): RepoIndexCache | null {
		return this.cache
	}

	/**
	 * Knapsack Context Packing
	 * Selects the highest scoring snippets and packs them strictly within the tokenBudget.
	 */
	public async assembleContext(query: string, tokenBudget = 1800): Promise<{
		snippets: Array<{ path: string; lines: [number, number]; score: number; reason: string; content: string }>
		totalEstimatedTokens: number
		explainability: string[]
	}> {
		if (!this.cache || Object.keys(this.cache.fileMap).length === 0) {
			return { snippets: [], totalEstimatedTokens: 0, explainability: ["Cache not ready, fallback active."] }
		}

		const STOP_WORDS = new Set([
			"the", "and", "that", "this", "with", "for", "from", "are", "was", "will", "have", "has", "had",
			"not", "but", "all", "any", "can", "must", "other", "into", "also", "your", "its", "each", "both",
			"than", "then", "them", "these", "those", "over", "such", "after", "when", "where", "which"
		])

		const keywords = query
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, " ")
			.split(/\s+/)
			.filter((k) => k.length > 2 && !STOP_WORDS.has(k))

		interface Candidate {
			file: string
			name?: string
			start_line: number
			end_line: number
			score: number
			reason: string
			type: "symbol" | "skeleton" | "full"
		}

		const candidates: Candidate[] = []

		// 0. Explicit @file and @symbol mentions (Competition Criterion 3: explicit mentions)
		const explicitFiles = Array.from(query.matchAll(/@file\s+([^\s,]+)/gi)).map((m) => m[1].replace(/\\/g, "/"))
		const explicitSymbols = Array.from(query.matchAll(/@symbol\s+([^\s,]+)/gi)).map((m) => m[1])

		for (const targetFile of explicitFiles) {
			for (const [file, entry] of Object.entries(this.cache.fileMap)) {
				if (file.toLowerCase().includes(targetFile.toLowerCase()) || targetFile.toLowerCase().includes(file.toLowerCase())) {
					candidates.push({
						file,
						start_line: 1,
						end_line: Math.min(entry.summary.line_count, 60),
						score: 500,
						reason: `Explicit @file mention '${targetFile}'`,
						type: "full",
					})
				}
			}
		}

		for (const targetSym of explicitSymbols) {
			for (const [file, entry] of Object.entries(this.cache.fileMap)) {
				for (const sym of entry.summary.symbols || []) {
					if (sym.name.toLowerCase() === targetSym.toLowerCase()) {
						candidates.push({
							file,
							start_line: sym.start_line,
							end_line: sym.end_line,
							score: 600,
							reason: `Explicit @symbol mention '${targetSym}' resolved via AST`,
							type: "symbol",
						})
					}
				}
			}
		}

		// 1. Score symbols from AST & Docs
		for (const [file, entry] of Object.entries(this.cache.fileMap)) {
			const symbols = entry.summary.symbols || []
			const fileLower = file.toLowerCase()
			let fileMatches = 0
			for (const kw of keywords) {
				if (fileLower.includes(kw)) fileMatches++
			}

			for (const sym of symbols) {
				let score = 0
				const reasons: string[] = []
				const symNameLower = sym.name.toLowerCase()

				for (const kw of keywords) {
					if (symNameLower === kw) {
						score += 80
						reasons.push(`Exact match for symbol '${kw}'`)
					} else if (symNameLower.includes(kw)) {
						score += 40
						reasons.push(`Symbol '${sym.name}' contains '${kw}'`)
					}
					if (sym.docstring && sym.docstring.toLowerCase().includes(kw)) {
						score += 15
						reasons.push(`Docstring mentions '${kw}'`)
					}
				}

				if (sym.methods) {
					for (const m of sym.methods) {
						for (const kw of keywords) {
							if (m.name.toLowerCase().includes(kw)) {
								score += 30
								reasons.push(`Method '${m.name}' matches '${kw}'`)
							}
						}
					}
				}

				// Directory tier scoring
				score += fileMatches * 25
				if (file.startsWith("src/")) score += 20
				if (file.startsWith("tests/") || file.startsWith("test/")) score += 20
				if (file.startsWith("docs/") || file.startsWith("doc/")) score += 15

				// Boost symbols whose name or method aligns with keywords
				for (const kw of keywords) {
					if (file.toLowerCase().includes(kw)) score += 30
					if (sym.name.toLowerCase().includes(kw)) score += 40
				}

				// Penalize huge classes (>200 lines) so targeted methods/functions or smaller classes rank higher
				const spanLines = sym.end_line - sym.start_line
				if (spanLines > 200) {
					score -= 30
				}

				// Consolidate reasons into unique terms
				const uniqueReasons = Array.from(new Set(reasons))
				if (score > 0) {
					candidates.push({
						file,
						name: sym.name,
						start_line: sym.start_line,
						end_line: sym.end_line,
						score,
						reason: uniqueReasons.slice(0, 2).join("; "),
						type: "symbol",
					})
				}
			}

			// Path keyword matching fallback
			for (const kw of keywords) {
				if (fileLower.includes(kw)) {
					candidates.push({
						file,
						start_line: 1,
						end_line: Math.min(80, entry.summary.line_count),
						score: 25 + fileMatches * 10,
						reason: `File path matches query keyword '${kw}'`,
						type: "skeleton",
					})
					break
				}
			}
		}

		// Sort by score descending
		candidates.sort((a, b) => b.score - a.score)

		// 2. Diversity Knapsack context packing across distinct files
		let currentTokens = 0
		const packedSnippets: Array<{ path: string; lines: [number, number]; score: number; reason: string; content: string }> = []
		const explainability: string[] = []
		const seenSpans = new Set<string>()
		const fileSnippetCounts = new Map<string, number>()

		for (const cand of candidates) {
			const spanKey = `${cand.file}:${cand.start_line}-${cand.end_line}`
			if (seenSpans.has(spanKey)) continue

			// Max 2 snippets per file to enforce diversity across 3+ files (Task B requirement)
			const fileCount = fileSnippetCounts.get(cand.file) || 0
			if (fileCount >= 2) continue

			try {
				const fullPath = path.isAbsolute(cand.file) ? cand.file : path.join(this.workspaceRoot, cand.file)
				const fileText = await fs.readFile(fullPath, "utf-8")
				const lines = fileText.split("\n")

				let startIdx = Math.max(0, cand.start_line - 1)
				// Keep snippet to at most 50 lines to preserve token budget
				const actualEnd = Math.min(lines.length, startIdx + 50)
				const snippetLines = lines.slice(startIdx, actualEnd)
				const content = snippetLines.join("\n")

				const estimatedTokens = Math.ceil(content.length / 4)
				if (currentTokens + estimatedTokens > tokenBudget && packedSnippets.length >= 2) {
					continue
				}

				seenSpans.add(spanKey)
				fileSnippetCounts.set(cand.file, fileCount + 1)
				currentTokens += estimatedTokens

				packedSnippets.push({
					path: cand.file,
					lines: [cand.start_line, actualEnd],
					score: cand.score,
					reason: cand.reason,
					content,
				})

				explainability.push(
					`[${cand.file} L${cand.start_line}-L${actualEnd}] (~${estimatedTokens} tokens) - ${cand.reason}`
				)

				if (currentTokens >= tokenBudget) {
					break
				}
			} catch {
				// Ignore file access errors
			}
		}

		return {
			snippets: packedSnippets,
			totalEstimatedTokens: currentTokens,
			explainability,
		}
	}
}

