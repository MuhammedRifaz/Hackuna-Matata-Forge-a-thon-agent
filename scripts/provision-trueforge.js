/**
 * Auto-provisions the Pacior agent and workspace MCP connector in TrueForge
 * on initial launch or fresh laptops.
 */

import "./patch-gemini-signature.js";

async function main() {
	const base = "http://localhost:8790/api/v1";

	try {
		// 1. Fetch available models configured in TrueForge
		let models = [];
		try {
			const modelsRes = await fetch(`${base}/models`);
			if (modelsRes.status === 200) {
				const modelsData = await modelsRes.json();
				models = modelsData.data || [];
			}
		} catch {}

		const preferredModel =
			models.find((m) => m.name.toLowerCase().includes("gemini")) ||
			models.find((m) => m.name.toLowerCase().includes("flash")) ||
			models[0] || { name: "gemini/gemini-3-5-flash-lite" };

		// 2. Provision / Sync pacior Agent in TrueForge
		const paciorManifest = {
			model: { name: preferredModel.name },
			instructions:
				"You are Pacior, an autonomous software engineering agent for VS Code. Follow instructions carefully, write clean minimal code, and verify with tests.",
			config: {
				iteration_limit: 25,
				sandbox: {
					enabled: false,
					file_downloads: false,
				},
				dynamic_sub_agents: {
					enabled: false,
				},
				context_management: {
					compaction: {
						enabled: true,
						trigger: {
							type: "input_tokens",
							value: 18000,
						},
					},
					large_tool_response: {
						enabled: true,
					},
				},
				generative_ui: {
					enabled: false,
				},
				ask_user_questions: {
					enabled: false,
				},
				web_search: {
					enabled: false,
				},
				memory: {
					enabled: false,
				},
			},
		};

		const agentsRes = await fetch(`${base}/agents`);
		const agentsData = await agentsRes.json();
		const agents = agentsData.data || [];
		const existingPacior = agents.find((a) => a.name.toLowerCase() === "pacior");

		if (existingPacior) {
			console.log(`[TrueForge Provisioner] Synchronizing Pacior agent (id: ${existingPacior.id})...`);
			// Preserve user-configured model if already set
			const activeModel = existingPacior.manifest?.model?.name ? existingPacior.manifest.model : { name: preferredModel.name };
			paciorManifest.model = activeModel;
			await fetch(`${base}/agents/${existingPacior.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ manifest: paciorManifest }),
			});
			console.log(`[TrueForge Provisioner] Successfully synchronized Pacior agent configuration (model: ${activeModel.name}).`);
		} else {
			console.log("[TrueForge Provisioner] Registering new Pacior agent in TrueForge...");
			await fetch(`${base}/agents`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "pacior",
					description: "Autonomous software engineering agent for VS Code",
					manifest: paciorManifest,
				}),
			});
			console.log("[TrueForge Provisioner] Pacior agent registered successfully.");
		}
	} catch (err) {
		console.log(`[TrueForge Provisioner] Note: TrueForge sync will complete when daemon boots (${err.message}).`);
	}
}

main();
