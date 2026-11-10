import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { TrueForgeError, TrueForgeTimeoutError } from "@truefoundry/trueforge-sdk"
import { describe, it } from "vitest"
import { formatTrueForgeError } from "../TrueForgeClient"
import { WorkspaceMcpServer } from "../WorkspaceMcpServer"

describe("TrueForge VS Code Bridge", () => {
	it("WorkspaceMcpServer serves JSON-RPC tools/list and enforces workspace path safety", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tf-mcp-unit-"))
		try {
			await fs.writeFile(path.join(tmpDir, "sample.py"), "def greet():\n    return 'hello'\n", "utf8")
			const server = new WorkspaceMcpServer({
				getWorkspaceRoot: async () => tmpDir,
			})
			const url = await server.ensureStarted()

			try {
				// Initialize handshake
				const initRes = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: { protocolVersion: "2024-11-05", capabilities: {} },
					}),
				})
				assert.equal(initRes.status, 200)
				const initJson = (await initRes.json()) as { result: { serverInfo: { name: string } } }
				assert.equal(initJson.result.serverInfo.name, "cline-vscode-workspace")

				// Tools discovery
				const listRes = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
				})
				const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } }
				const toolNames = listJson.result.tools.map((t) => t.name)
				assert.ok(toolNames.includes("read_files"))
				assert.ok(toolNames.includes("editor"))
				assert.ok(toolNames.includes("run_commands"))

				// Search tool
				const searchText = await server.executeTool("search_files", { regex: "def greet" })
				assert.ok(searchText.includes("sample.py:1: def greet():"))

				// Editor tool update
				await server.executeTool("editor", {
					path: "sample.py",
					old_text: "return 'hello'",
					new_text: "return 'trueforge'",
				})
				const updated = await fs.readFile(path.join(tmpDir, "sample.py"), "utf8")
				assert.ok(updated.includes("return 'trueforge'"))

				// Path traversal protection
				await assert.rejects(() => server.executeTool("read_files", { files: [{ path: "../outside.txt" }] }), /Access denied/)
			} finally {
				await server.dispose()
			}
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	it("formatTrueForgeError classifies unreachable, auth, rate-limit, and timeout failures cleanly", () => {
		const unreachable = formatTrueForgeError(new Error("connect ECONNREFUSED 127.0.0.1:8790"), "http://localhost:8790")
		assert.equal(unreachable.code, "TRUEFORGE_UNREACHABLE")
		assert.ok(unreachable.message.includes("http://localhost:8790"))

		const authErr = formatTrueForgeError(
			new TrueForgeError({ message: "Unauthorized", statusCode: 401, body: { error: "Invalid API key" } }),
			"http://localhost:8790",
		)
		assert.equal(authErr.code, "TRUEFORGE_AUTH_ERROR")
		assert.ok(authErr.message.includes("401"))

		const rateErr = formatTrueForgeError(
			new TrueForgeError({ message: "Too Many Requests", statusCode: 429, body: { error: "Rate limit" } }),
			"http://localhost:8790",
		)
		assert.equal(rateErr.code, "TRUEFORGE_RATE_LIMIT")

		const timeoutErr = formatTrueForgeError(new TrueForgeTimeoutError("Timed out"), "http://localhost:8790")
		assert.equal(timeoutErr.code, "TRUEFORGE_TIMEOUT")
	})
})
