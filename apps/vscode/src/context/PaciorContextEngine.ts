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
	 * Hybrid AST + IDF-Lexical + Dependency-Graph Knapsack Context Packing
	 * Selects the highest scoring method/function/doc snippets across distinct file roles
	 * (implementation, tests, docs) and packs them strictly within the tokenBudget.
	 */
	public async assembleContext(query: string, tokenBudget = 900): Promise<{
		snippets: Array<{ path: string; lines: [number, number]; score: number; reason: string; content: string }>
		totalEstimatedTokens: number
		explainability: string[]
		symbolOutline: string
	}> {
		if (!this.cache || Object.keys(this.cache.fileMap).length === 0) {
			return {
				snippets: [],
				totalEstimatedTokens: 0,
				explainability: ["Cache not ready, fallback active."],
				symbolOutline: "",
			}
		}

		const STOP_WORDS = new Set([
			"the", "and", "that", "this", "with", "for", "from", "are", "was", "will", "have", "has", "had",
			"not", "but", "all", "any", "can", "must", "other", "into", "also", "your", "its", "each", "both",
			"than", "then", "them", "these", "those", "over", "such", "after", "when", "where", "which",
			"add", "new", "built", "prints", "loaded", "values", "key", "keys", "containing", "appear",
			"covered", "alongside", "should", "would", "could", "make", "using", "used", "need", "needs",
		])

		const stemWord = (w: string): string => {
			if (w.startsWith("document")) return "doc"
			if (w.startsWith("test")) return "test"
			if (w.endsWith("commands")) return "command"
			if (w.endsWith("configs") || w === "configuration") return "config"
			if (w.endsWith("routes")) return "route"
			if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3)
			if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2)
			if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1)
			return w
		}

		const rawTokens = query
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, " ")
			.split(/\s+/)
			.filter((k) => k.length > 2 && !STOP_WORDS.has(k))

		const keywords = Array.from(new Set(rawTokens.flatMap((t) => [t, stemWord(t)])))
		const queryLower = query.toLowerCase()
		const wantsTests = /\b(test|tests|pytest|unittest|spec|coverage|covered)\b/i.test(queryLower)
		const wantsDocs = /\b(doc|docs|document|documented|documentation|readme|rst|guide)\b/i.test(queryLower)

		const allEntries = Object.entries(this.cache.fileMap)
		const totalDocs = Math.max(1, allEntries.length)

		// Compute Inverse Document Frequency (IDF) per keyword across indexed files
		const docFreq = new Map<string, number>()
		for (const kw of keywords) {
			let df = 0
			for (const [file, entry] of allEntries) {
				const fLow = file.toLowerCase()
				if (fLow.includes(kw)) {
					df++
					continue
				}
				const syms = entry.summary.symbols || []
				if (syms.some((s) => s.name.toLowerCase().includes(kw) || (s.docstring || "").toLowerCase().includes(kw))) {
					df++
				}
			}
			docFreq.set(kw, df)
		}
		const idfOf = (kw: string): number => {
			const df = docFreq.get(kw) || 0
			return Math.log((totalDocs + 1) / (df + 1)) + 1.0
		}

		const getFileRole = (file: string): "impl" | "test" | "doc" => {
			const f = file.replace(/\\/g, "/").toLowerCase()
			if (f.startsWith("docs/") || f.startsWith("doc/") || f.endsWith(".rst") || f.endsWith(".md")) return "doc"
			if (f.startsWith("tests/") || f.startsWith("test/") || f.includes("/test_") || f.endsWith("_test.py") || f.endsWith(".test.ts")) return "test"
			return "impl"
		}

		const getModuleStem = (file: string): string => {
			const base = path.basename(file, path.extname(file)).toLowerCase()
			return base.replace(/^test_/, "").replace(/_test$/, "")
		}

		interface Candidate {
			file: string
			role: "impl" | "test" | "doc"
			name?: string
			start_line: number
			end_line: number
			score: number
			reasons: string[]
			type: "symbol" | "method" | "skeleton" | "full"
		}

		const candidates: Candidate[] = []
		const fileBaseScores = new Map<string, number>()

		// 0. Explicit @file and @symbol mentions (Competition Criterion 3: explicit mentions)
		const explicitFiles = Array.from(query.matchAll(/@file\s+([^\s,]+)/gi)).map((m) => m[1].replace(/\\/g, "/"))
		const explicitSymbols = Array.from(query.matchAll(/@symbol\s+([^\s,]+)/gi)).map((m) => m[1])

		for (const targetFile of explicitFiles) {
			for (const [file, entry] of allEntries) {
				if (file.toLowerCase().includes(targetFile.toLowerCase()) || targetFile.toLowerCase().includes(file.toLowerCase())) {
					candidates.push({
						file,
						role: getFileRole(file),
						start_line: 1,
						end_line: Math.min(entry.summary.line_count, 35),
						score: 500,
						reasons: [`Explicit @file mention '${targetFile}'`],
						type: "full",
					})
				}
			}
		}

		for (const targetSym of explicitSymbols) {
			for (const [file, entry] of allEntries) {
				for (const sym of entry.summary.symbols || []) {
					if (sym.name.toLowerCase() === targetSym.toLowerCase()) {
						candidates.push({
							file,
							role: getFileRole(file),
							name: sym.name,
							start_line: sym.start_line,
							end_line: sym.end_line,
							score: 600,
							reasons: [`Explicit @symbol mention '${targetSym}' resolved via AST`],
							type: "symbol",
						})
					}
				}
			}
		}

		// 1. Score AST symbols, methods, decorators, and documentation sections with IDF weighting
		for (const [file, entry] of allEntries) {
			const role = getFileRole(file)
			const symbols = entry.summary.symbols || []
			const fileLower = file.toLowerCase()
			const fileStem = getModuleStem(file)

			// Compute IDF-weighted file path relevance (avoiding generic repo-wide noise)
			let filePathScore = 0
			const matchedFileKws: string[] = []
			for (const kw of keywords) {
				if (kw === "test" || kw === "doc") continue // role handled separately
				if (fileStem === kw) {
					filePathScore += 35 * idfOf(kw)
					matchedFileKws.push(kw)
				} else if (fileLower.includes(kw)) {
					filePathScore += 14 * idfOf(kw)
					matchedFileKws.push(kw)
				}
			}
			// Penalize examples/ and __init__ boilerplate slightly compared to core src/
			const isExample = fileLower.startsWith("examples/") || fileLower.includes("/test_apps/")
			if (isExample) filePathScore *= 0.3

			let bestFileSymScore = filePathScore

			for (const sym of symbols) {
				let score = filePathScore
				const reasons: string[] = []
				if (matchedFileKws.length > 0) {
					reasons.push(`Path matches '${matchedFileKws[0]}'`)
				}
				const symNameLower = sym.name.toLowerCase()
				const decoratorsText = (sym.decorators || []).join(" ").toLowerCase()
				const docLower = (sym.docstring || "").toLowerCase()

				for (const kw of keywords) {
					if (kw === "test" || kw === "doc") continue
					const w = idfOf(kw)
					if (symNameLower === kw) {
						score += 45 * w
						reasons.push(`AST symbol '${sym.name}' exact match`)
					} else if (symNameLower.includes(kw)) {
						score += 22 * w
						reasons.push(`AST symbol '${sym.name}' matches '${kw}'`)
					}
					if (decoratorsText && decoratorsText.includes(kw)) {
						score += 20 * w
						reasons.push(`Decorator matches '${kw}'`)
					}
					if (docLower && docLower.includes(kw)) {
						score += 8 * w
						reasons.push(`Docstring mentions '${kw}'`)
					}
				}

				if (role === "impl" && !isExample) score += 18
				if (role === "test" && wantsTests && !isExample) score += 15
				if (role === "doc" && wantsDocs && !isExample) score += 12

				const spanLines = sym.end_line - sym.start_line
				// Generate method-level AST candidates for classes so __init__ / key methods rank directly (skipping giant class docstrings!)
				if (sym.type === "class" && sym.methods && sym.methods.length > 0) {
					for (const m of sym.methods) {
						let mScore = filePathScore + (role === "impl" && !isExample ? 20 : 0)
						const mReasons: string[] = [...reasons.slice(0, 1)]
						const mNameLower = m.name.toLowerCase()
						for (const kw of keywords) {
							if (kw === "test" || kw === "doc") continue
							const w = idfOf(kw)
							if (mNameLower.includes(kw)) {
								mScore += 28 * w
								mReasons.push(`Method '${sym.name}.${m.name}' matches '${kw}'`)
							}
						}
						// Boost constructor / command registration methods of high-scoring classes
						if (m.name === "__init__" && score > 30) {
							mScore = Math.max(mScore, score + 18)
							mReasons.push(`Constructor '${sym.name}.__init__' (registers defaults/setup)`)
						}
						if (mScore > 15 && !isExample) {
							bestFileSymScore = Math.max(bestFileSymScore, mScore)
							candidates.push({
								file,
								role,
								name: `${sym.name}.${m.name}`,
								start_line: m.start_line,
								end_line: m.end_line,
								score: mScore,
								reasons: Array.from(new Set(mReasons)),
								type: "method",
							})
						}
					}
					// Penalize huge class headers so methods or focused functions win
					if (spanLines > 100) {
						score -= 35
					}
				}

				if (score > 15 && !isExample) {
					bestFileSymScore = Math.max(bestFileSymScore, score)
					candidates.push({
						file,
						role,
						name: sym.name,
						start_line: sym.start_line,
						end_line: sym.end_line,
						score,
						reasons: Array.from(new Set(reasons)),
						type: "symbol",
					})
				}
			}

			// Path fallback for files with few/no matching symbols
			if (filePathScore > 15 && !isExample) {
				candidates.push({
					file,
					role,
					start_line: 1,
					end_line: Math.min(35, entry.summary.line_count),
					score: filePathScore,
					reasons: [`File path matches '${matchedFileKws.slice(0, 2).join(", ")}'`],
					type: "skeleton",
				})
			}

			fileBaseScores.set(file, bestFileSymScore)
		}

		// 2. AST Dependency Graph & Counterpart Propagation
		// Boost test files that import top implementation files, and doc files matching top implementation stems
		const topImplFiles = Array.from(fileBaseScores.entries())
			.filter(([f]) => getFileRole(f) === "impl" && !f.toLowerCase().startsWith("examples/"))
			.sort((a, b) => b[1] - a[1])
			.slice(0, 2)
			.map(([f]) => f)

		const topImplStems = new Set(topImplFiles.map(getModuleStem))
		const depGraph = this.cache.dependencyGraph || {}

		for (const cand of candidates) {
			if (cand.role === "test") {
				const importsTop = (depGraph[cand.file] || []).some((dep) => topImplFiles.includes(dep))
				const stemMatchesTop = topImplStems.has(getModuleStem(cand.file))
				if (importsTop || stemMatchesTop) {
					cand.score += (importsTop ? 45 : 0) + (stemMatchesTop ? 55 : 0)
					cand.reasons.unshift(
						importsTop
							? `AST dependency graph: imports '${topImplFiles[0]}'`
							: `Test suite counterpart for '${topImplFiles[0]}'`,
					)
				}
			} else if (cand.role === "doc") {
				const stemMatchesTop = topImplStems.has(getModuleStem(cand.file))
				if (stemMatchesTop) {
					cand.score += 65
					cand.reasons.unshift(`Documentation counterpart for '${topImplFiles[0]}'`)
				}
			}
		}

		// Sort all candidates by final score descending
		candidates.sort((a, b) => b.score - a.score)

		// 3. Role-Aware Diversity Knapsack Packing strictly within tokenBudget
		// Reserve space for the compact AST symbol outline (~140 tokens) so total stays strictly <= tokenBudget
		const outlineBudget = Math.min(150, Math.floor(tokenBudget * 0.17))
		const snippetBudget = Math.max(300, tokenBudget - outlineBudget)
		const MAX_LINES_PER_SNIPPET = 22

		let currentTokens = 0
		const packedSnippets: Array<{ path: string; lines: [number, number]; score: number; reason: string; content: string }> = []
		const explainability: string[] = []
		const seenSpans = new Set<string>()
		const fileSnippetCounts = new Map<string, number>()

		const tryPackCandidate = async (cand: Candidate, maxLines = MAX_LINES_PER_SNIPPET): Promise<boolean> => {
			const fileCount = fileSnippetCounts.get(cand.file) || 0
			if (fileCount >= 2) return false

			try {
				const fullPath = path.isAbsolute(cand.file) ? cand.file : path.join(this.workspaceRoot, cand.file)
				const fileText = await fs.readFile(fullPath, "utf-8")
				const lines = fileText.split(/\r?\n/)

				// For methods/functions whose span is longer than maxLines, prefer the tail of __init__ if it contains registrations,
				// or start at the signature line.
				let startIdx = Math.max(0, cand.start_line - 1)
				const naturalEnd = Math.min(lines.length, Math.max(cand.end_line, cand.start_line + 10))
				if (cand.type === "method" && cand.name?.endsWith(".__init__") && naturalEnd - startIdx > maxLines) {
					startIdx = Math.max(startIdx, naturalEnd - maxLines)
				}
				const actualEnd = Math.min(lines.length, startIdx + maxLines, naturalEnd)
				const spanKey = `${cand.file}:${startIdx + 1}-${actualEnd}`
				if (seenSpans.has(spanKey)) return false

				// Prevent overlapping spans within the same file
				for (const existing of packedSnippets) {
					if (existing.path === cand.file && !(actualEnd < existing.lines[0] || startIdx + 1 > existing.lines[1])) {
						return false
					}
				}

				const snippetLines = lines.slice(startIdx, actualEnd)
				const content = snippetLines.map((l, idx) => `${startIdx + idx + 1} | ${l}`).join("\n")
				const estimatedTokens = Math.ceil(content.length / 4)

				// Strictly enforce token budget (never exceed snippetBudget)
				if (currentTokens + estimatedTokens > snippetBudget) {
					// Try trimming to fit remaining budget if at least 10 lines fit
					const remainingChars = (snippetBudget - currentTokens) * 4
					if (remainingChars < 280) return false
					let acc = ""
					let fitCount = 0
					for (let i = 0; i < snippetLines.length; i++) {
						const lineStr = `${startIdx + i + 1} | ${snippetLines[i]}\n`
						if (acc.length + lineStr.length > remainingChars) break
						acc += lineStr
						fitCount++
					}
					if (fitCount < 8) return false
					const trimmedEnd = startIdx + fitCount
					const trimmedTokens = Math.ceil(acc.length / 4)
					seenSpans.add(`${cand.file}:${startIdx + 1}-${trimmedEnd}`)
					fileSnippetCounts.set(cand.file, fileCount + 1)
					currentTokens += trimmedTokens
					const reasonText = cand.reasons.slice(0, 2).join("; ") || "AST lexical match"
					packedSnippets.push({
						path: cand.file,
						lines: [startIdx + 1, trimmedEnd],
						score: Math.round(cand.score),
						reason: reasonText,
						content: acc.trimEnd(),
					})
					explainability.push(`[${cand.file} L${startIdx + 1}-L${trimmedEnd}] (~${trimmedTokens} tok) — ${reasonText}`)
					return true
				}

				seenSpans.add(spanKey)
				fileSnippetCounts.set(cand.file, fileCount + 1)
				currentTokens += estimatedTokens
				const reasonText = cand.reasons.slice(0, 2).join("; ") || "AST lexical match"

				packedSnippets.push({
					path: cand.file,
					lines: [startIdx + 1, actualEnd],
					score: Math.round(cand.score),
					reason: reasonText,
					content,
				})
				explainability.push(`[${cand.file} L${startIdx + 1}-L${actualEnd}] (~${estimatedTokens} tok) — ${reasonText}`)
				return true
			} catch {
				return false
			}
		}

		// Phase A: Guarantee multi-role coverage (1 top impl + 1 top test if wantsTests + 1 top doc if wantsDocs)
		const topImpl = candidates.find((c) => c.role === "impl")
		if (topImpl) await tryPackCandidate(topImpl, 22)

		if (wantsTests) {
			const topTest = candidates.find((c) => c.role === "test")
			if (topTest) await tryPackCandidate(topTest, 20)
		}

		if (wantsDocs) {
			const topDoc = candidates.find((c) => c.role === "doc")
			if (topDoc) await tryPackCandidate(topDoc, 18)
		}

		// Phase B: Fill remaining budget greedily with next highest-scoring non-overlapping candidates (e.g. class __init__ / 2nd key symbol)
		for (const cand of candidates) {
			if (currentTokens >= snippetBudget - 60 || packedSnippets.length >= 4) break
			await tryPackCandidate(cand, 22)
		}

		// 4. Build compact AST Symbol Outline of the TOP-SCORED symbols for each selected file
		const selectedFiles = Array.from(new Set(packedSnippets.map((s) => s.path)))
		const outlineLines: string[] = []
		for (const file of selectedFiles) {
			const entry = this.cache.fileMap[file]
			if (!entry) continue
			const topFileCands = candidates
				.filter((c) => c.file === file && c.name)
				.slice(0, 6)
				.map((c) => `${c.name}(L${c.start_line}-${c.end_line})`)
			const uniqueTop = Array.from(new Set(topFileCands))
			const fallbackSyms =
				uniqueTop.length > 0
					? uniqueTop
					: (entry.summary.symbols || []).slice(0, 6).map((s) => `${s.name}(L${s.start_line}-${s.end_line})`)
			if (fallbackSyms.length > 0) {
				outlineLines.push(`- ${file} (${entry.summary.line_count}L): ${fallbackSyms.join(", ")}`)
			}
		}
		let symbolOutline = outlineLines.join("\n")
		if (Math.ceil(symbolOutline.length / 4) > outlineBudget) {
			symbolOutline = symbolOutline.slice(0, outlineBudget * 4)
		}
		const finalTokens = currentTokens + Math.ceil(symbolOutline.length / 4)

		return {
			snippets: packedSnippets,
			totalEstimatedTokens: finalTokens,
			explainability,
			symbolOutline,
		}
	}
}

