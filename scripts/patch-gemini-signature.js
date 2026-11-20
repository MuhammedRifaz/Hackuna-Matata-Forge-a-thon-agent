/**
 * Automatically patches @ai-sdk/google and @truefoundry/trueforge-core in npm/npx caches
 * to prevent the Google Gemini API 400 error:
 * "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly..."
 *
 * It ensures that when Gemini executes a tool call, Google's documented sentinel
 * "skip_thought_signature_validator" is provided whenever thoughtSignature is absent.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function patchAiSdkGoogle(filePath) {
	if (!fs.existsSync(filePath)) return;
	try {
		let content = fs.readFileSync(filePath, "utf8");
		let modified = false;

		// 1. Patch effectiveThoughtSignature in convertToGoogleMessages
		const targetPattern = /const effectiveThoughtSignature\s*=\s*thoughtSignature\s*\?\?\s*\(isGemini3Model[^;]+\);/g;
		const replacement = 'const effectiveThoughtSignature = thoughtSignature ?? (typeof injectSkipSignature === "function" ? injectSkipSignature(part.toolName) : "skip_thought_signature_validator");';

		if (targetPattern.test(content)) {
			content = content.replace(targetPattern, replacement);
			modified = true;
		}

		if (modified) {
			fs.writeFileSync(filePath, content, "utf8");
			console.log(`[Gemini Patch] Successfully patched @ai-sdk/google: ${filePath}`);
		} else if (content.includes('injectSkipSignature === "function"')) {
			console.log(`[Gemini Patch] Already patched @ai-sdk/google: ${filePath}`);
		}
	} catch (err) {
		console.warn(`[Gemini Patch] Warning patching ${filePath}:`, err.message);
	}
}

function patchVercelAILLM(filePath) {
	if (!fs.existsSync(filePath)) return;
	try {
		let content = fs.readFileSync(filePath, "utf8");
		let modified = false;

		// 1. Only default thoughtSignature to sentinel for Google/Gemini models to avoid breaking OpenRouter/OpenAI/Claude
		const oldThoughtSig = 'const thoughtSignature = isPlainObject(rawProviderFields) && typeof rawProviderFields["thought_signature"] === "string" ? rawProviderFields["thought_signature"] : void 0;';
		const oldPatchedThoughtSig = 'const thoughtSignature = isPlainObject(rawProviderFields) && typeof rawProviderFields["thought_signature"] === "string" ? rawProviderFields["thought_signature"] : "skip_thought_signature_validator";';
		const safeThoughtSig = 'const isGoogleProvider = (typeof provider === "string" && (provider.includes("google") || provider.includes("gemini"))) || (typeof providerName === "string" && providerName.includes("gemini"));\n      const thoughtSignature = isPlainObject(rawProviderFields) && typeof rawProviderFields["thought_signature"] === "string" ? rawProviderFields["thought_signature"] : (isGoogleProvider ? "skip_thought_signature_validator" : void 0);';

		if (content.includes(oldPatchedThoughtSig)) {
			content = content.replace(oldPatchedThoughtSig, safeThoughtSig);
			modified = true;
		} else if (content.includes(oldThoughtSig)) {
			content = content.replace(oldThoughtSig, safeThoughtSig);
			modified = true;
		}

		// 2. Ensure providerOptions.google includes thoughtSignature when replaying tool call parts
		const oldToolCallSpread = '...thoughtSignature !== void 0 ? {\n          providerOptions: {\n            google: { thoughtSignature },';
		const newToolCallSpread = '...{\n          providerOptions: {\n            google: { thoughtSignature: thoughtSignature || "skip_thought_signature_validator" },';
		if (content.includes(oldToolCallSpread)) {
			content = content.replace(oldToolCallSpread, newToolCallSpread);
			modified = true;
		}

		if (modified) {
			fs.writeFileSync(filePath, content, "utf8");
			console.log(`[Gemini Patch] Successfully patched VercelAILLM: ${filePath}`);
		} else if (content.includes('isGoogleProvider')) {
			console.log(`[Gemini Patch] Already safely patched VercelAILLM: ${filePath}`);
		}
	} catch (err) {
		console.warn(`[Gemini Patch] Warning patching ${filePath}:`, err.message);
	}
}

export function runPatch() {
	const candidateBaseDirs = [];

	if (process.env.LOCALAPPDATA) {
		const npxRoot = path.join(process.env.LOCALAPPDATA, "npm-cache", "_npx");
		if (fs.existsSync(npxRoot)) {
			try {
				for (const item of fs.readdirSync(npxRoot)) {
					candidateBaseDirs.push(path.join(npxRoot, item));
				}
			} catch {}
		}
	}

	if (process.env.APPDATA) {
		candidateBaseDirs.push(path.join(process.env.APPDATA, "npm"));
	}

	candidateBaseDirs.push(path.join(__dirname, ".."));
	candidateBaseDirs.push(path.join(__dirname, "..", "apps", "vscode"));

	for (const baseDir of candidateBaseDirs) {
		const nodeModules = path.join(baseDir, "node_modules");
		if (!fs.existsSync(nodeModules)) continue;

		// 1. Check @ai-sdk/google
		const googleDist = path.join(nodeModules, "@ai-sdk", "google", "dist", "index.js");
		const googleInternal = path.join(nodeModules, "@ai-sdk", "google", "dist", "internal", "index.js");
		patchAiSdkGoogle(googleDist);
		patchAiSdkGoogle(googleInternal);

		// 2. Check @truefoundry/trueforge-core VercelAILLM
		const vercelLlm = path.join(nodeModules, "@truefoundry", "trueforge-core", "dist", "core", "llm", "VercelAILLM.js");
		patchVercelAILLM(vercelLlm);
	}
}

runPatch();
