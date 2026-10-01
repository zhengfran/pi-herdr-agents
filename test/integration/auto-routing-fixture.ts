/** Public extension fixture for real TUI/RPC tests. Only classifier HTTP is
 * replaced; registry authentication, adapter, input, launch and watchers are real.
 * Pure catalog inspection builds the admin approval, never replaces a handler.
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import subagents, { __test__ } from "../../pi-extension/subagents/index.ts";
import { autoRoleDefinitionSha256 } from "../../pi-extension/subagents/auto-routing-candidates.ts";
import {
	createJevTransport,
	type JevFetch,
} from "../../pi-extension/subagents/jev-client.ts";
import {
	JEV_REASONING_LEVELS,
	JEV_CONSEQUENCE_LEVELS,
} from "../../pi-extension/subagents/jev-questions.ts";

import {
	isRecord,
	type JsonObject,
} from "../../pi-extension/subagents/type-guards.ts";

export interface RoutingScenario {
	mode?: "auto" | "pilot";
	harness?: "pi" | "claude" | "kiro";
	failurePolicy?: "parent" | "hold";
	timeoutMs?: number;
	transform?: boolean;
	delay?: boolean;
	unavailable?: boolean;
	abstain?: boolean;
}

export default function fixture(pi: ExtensionAPI) {
	const root = process.env.AUTO_INTEG_ROOT!;
	const options = JSON.parse(readFileSync(join(root, "scenario.json"), "utf8"));
	const journal = (kind: string, data: JsonObject = {}) =>
		appendFileSync(
			join(root, "journal.jsonl"),
			JSON.stringify({ kind, at: Date.now(), ...data }) + "\n",
		);
	const state = (ctx: ExtensionContext) => ({
		mode: ctx.mode,
		idle: ctx.isIdle(),
		pending: ctx.hasPendingMessages(),
		session: ctx.sessionManager.getSessionFile(),
		sessionId: ctx.sessionManager.getSessionId(),
	});
	const role = __test__
		.discoverAgentCatalog(pi)
		.agents.find((r) => r.name === "auto-reporter");
	if (!role) throw new Error("Missing real discovered auto-reporter role");
	const configPath = join(
		process.env.PI_CODING_AGENT_DIR!,
		"herdr-agents",
		"config.json",
	);
	mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "herdr-agents"), {
		recursive: true,
	});
	const config = {
		status: { enabled: true },
		autoRouting: {
			version: 1,
			mode: options.mode ?? "auto",
			policyVersion: "jev-auto-v1",
			questionVersion: "jev-auto-questions-v1",
			consent: {
				disclosureVersion: "jev-egress-v1",
				acknowledgedAt: "2026-09-30T00:00:00Z",
				sendCurrentPromptAndReviewedProfiles: true,
			},
			jev: {
				provider: "typesafe",
				model: "jev-1.13.0",
				timeoutMs: options.timeoutMs ?? 5000,
			},
			failurePolicy: options.failurePolicy ?? "parent",
			roles: [
				{
					id: "reporter",
					agent: role.name,
					source: role.source,
					definitionSha256: autoRoleDefinitionSha256(role),
					labelRole: "build",
					intent: "report",
					purpose: "task",
					responsibility: "Bounded repository inspection.",
					deliverable: "A report.",
					excludes: "Publication.",
				},
			],
			candidates: [
				{
					id: "reporter-tuple",
					roleId: "reporter",
					harness: options.harness ?? "pi",
					model:
						options.harness && options.harness !== "pi"
							? {
									namespace: options.harness,
									id: `${options.harness}-fixture-20260930`,
								}
							: { namespace: "pi", ref: "pi-integration/test" },
					effort: "high",
					tier: "mid",
					family: "fixture",
					taskStrengths: "Inspection.",
					limitations: "No publication.",
					capabilityEvidence: "Offline fixture v1.",
					preference: 1,
				},
			],
		},
	};
	// Reload does not silently undo test-induced revocation.
	if (!existsSync(configPath))
		writeFileSync(configPath, JSON.stringify(config));

	pi.on("input", (event, ctx) => {
		journal("before-input", {
			...state(ctx),
			text: event.text,
			source: event.source,
			streamingBehavior: event.streamingBehavior,
			images: event.images?.length ?? 0,
		});
		if (options.transform && event.text.startsWith("TRANSFORM:"))
			return {
				action: "transform",
				text: event.text.slice("TRANSFORM:".length),
			};
		if (options.transform && event.text.startsWith("IMAGE:"))
			return {
				action: "transform",
				text: event.text.slice("IMAGE:".length),
				images: [
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
					},
				],
			};
		return { action: "continue" };
	});
	const fetch: JevFetch = async (url, init) => {
		const body = JSON.parse(String(init?.body));
		const headers = new Headers(init?.headers);
		if (!headers.get("authorization")?.includes("offline-jev-token"))
			throw new Error("Classifier did not traverse authenticated adapter");
		if (body.model !== "jev-1.13.0") throw new Error("Wrong classifier pin");
		journal("classifier", {
			authenticated: true,
			url: String(url),
			model: body.model,
			body,
		});
		if (options.delay) {
			const deadline = Date.now() + 20000;
			while (!existsSync(join(root, "classifier-release"))) {
				if (Date.now() > deadline) throw new Error("classifier gate timeout");
				await new Promise((r) => setTimeout(r, 25));
			}
		}
		if (options.unavailable) return new Response("{}", { status: 400 });
		const answers: JsonObject = {};
		for (const [id, q] of Object.entries(body.questions)) {
			if (!isRecord(q)) throw new Error("Invalid fixture question");
			if (q.type === "choice") {
				if (!isRecord(q.criteria)) throw new Error("Invalid choice criteria");
				const values = Object.keys(q.criteria);
				const winner = options.abstain ? "none" : values[0];
				answers[id] = {
					type: "choice",
					choice: winner,
					confidence: 0.95,
					probabilities: Object.fromEntries(
						values.map((v: string) => [
							v,
							v === winner
								? 0.9
								: v === (winner === "none" ? values[0] : "none")
									? 0.1
									: 0,
						]),
					),
				};
			} else if (q.type === "score") {
				const levels =
					id === "reasoning" ? JEV_REASONING_LEVELS : JEV_CONSEQUENCE_LEVELS;
				const p =
					id === "reasoning" ? [0.05, 0.9, 0.05, 0] : [0.95, 0.05, 0, 0];
				answers[id] = {
					type: "score",
					score: p.reduce((s, v, i) => s + v * i, 0),
					confidence: 0.95,
					probabilities: Object.fromEntries(p.map((v, i) => [String(i), v])),
					legend: Object.fromEntries(levels.map((v, i) => [String(i), v])),
				};
			} else
				answers[id] = {
					type: "noul",
					noul: id.startsWith("role_fit_") ? 0.95 : 0.05,
				};
		}
		journal("classifier-response");
		return new Response(
			JSON.stringify({
				model: "jev-1.13.0",
				answers,
				usage: { input_tokens: 100, output_tokens: 10 },
			}),
			{ headers: { "content-type": "application/json" } },
		);
	};
	subagents(pi, {
		autoRouting: {
			transport: (ctx) =>
				createJevTransport({ registry: ctx.modelRegistry, fetch }),
		},
	});
	pi.on("input", (event, ctx) => {
		journal("after-input", {
			...state(ctx),
			text: event.text,
			images: event.images?.length ?? 0,
		});
		return { action: "continue" };
	});
	pi.on("session_start", (_, ctx) => journal("session_start", state(ctx)));
	pi.on("session_shutdown", (_, ctx) =>
		journal("session_shutdown", state(ctx)),
	);
	pi.on("agent_start", (_, ctx) => journal("agent_start", state(ctx)));
	pi.on("agent_settled", (_, ctx) => journal("agent_settled", state(ctx)));
	pi.registerCommand("integ-probe", {
		description: "Public idle observation",
		handler: async (_, ctx) => {
			journal("probe", state(ctx));
		},
	});
	pi.registerCommand("integ-new", {
		description: "Public replacement session",
		handler: async (_, ctx) => {
			await ctx.newSession();
		},
	});
}
