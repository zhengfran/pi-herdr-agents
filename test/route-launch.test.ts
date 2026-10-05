import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Configuration is read while the extension module evaluates, so the
// isolated agent directory and its routes must exist before the import.
const agentDir = mkdtempSync(join(tmpdir(), "route-launch-agent-"));
mkdirSync(join(agentDir, "herdr-agents"));
writeFileSync(
	join(agentDir, "herdr-agents", "config.json"),
	JSON.stringify({
		routes: {
			review: {
				description: "Code review of a finished change",
				candidates: [
					{
						agent: "no-such-role",
						harness: "pi",
						model: "fake/strong",
						thinking: "high",
					},
					{
						agent: "reviewer",
						harness: "pi",
						model: "fake/strong",
						thinking: "high",
					},
				],
			},
			open: {
				candidates: [
					{
						agent: "reviewer",
						harness: "pi",
						model: "fake/strong",
						thinking: "high",
					},
				],
			},
		},
		routePolicy: { requiredForAgents: { reviewer: ["review"] } },
	}),
);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHerdr = process.env.HERDR_ENV;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.HERDR_ENV;
const subagents = await import("../pi-extension/subagents/index.ts");

function registerSubagentTool() {
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	// SAFETY: this fixture implements only the ExtensionAPI members that
	// registration and route preparation use.
	subagents.default({
		events: { on() {}, emit() {} },
		on(event: string, handler: Function) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: any) {
			tools.push(tool);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		sendUserMessage() {},
		sendMessage() {},
		getAllTools: () => [],
		getThinkingLevel: () => "medium",
	} as any);
	return { tool: tools.find((tool) => tool.name === "subagent"), handlers };
}

const ctx = {
	cwd: agentDir,
	hasUI: false,
	sessionManager: { getSessionFile: () => join(agentDir, "session.jsonl") },
	modelRegistry: {
		find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
		getAvailable: () => [],
		hasConfiguredAuth: () => true,
	},
};

async function run(params: {
	route?: string;
	agent?: string;
	harness?: "pi";
	model?: string;
	thinking?: "high";
}) {
	const { tool } = registerSubagentTool();
	return tool.execute(
		"call",
		{ name: "r", task: "t", ...params },
		undefined,
		undefined,
		ctx,
	);
}

describe("subagent route launch", () => {
	before(() => {
		assert.ok(registerSubagentTool().tool);
	});
	after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHerdr !== undefined) process.env.HERDR_ENV = previousHerdr;
		rmSync(agentDir, { recursive: true, force: true });
	});

	const explicit = {
		agent: "worker",
		harness: "pi" as const,
		model: "fake/other",
		thinking: "high" as const,
	};

	for (const route of ["", " \t\n "]) {
		it(`treats blank route ${JSON.stringify(route)} exactly like omission with explicit runtime fields`, async () => {
			const omitted = await run(explicit);
			const blank = await run({ route, ...explicit });
			assert.notEqual(blank.details.error, "route-conflict");
			assert.deepEqual(blank, omitted);
			// Ordinary preparation resolves the role/runtime and reaches the Herdr check.
			assert.match(blank.content[0].text, /[Hh]erdr/);
		});
	}

	for (const field of ["agent", "harness", "model", "thinking"] as const) {
		it(`rejects a real route combined with explicit ${field}`, async () => {
			const result = await run({ route: "review", [field]: explicit[field] });
			assert.equal(result.details.error, "route-conflict");
			assert.match(result.content[0].text, new RegExp(`remove ${field}`));
		});
	}

	it("names the configured routes when the route is unknown", async () => {
		const result = await run({ route: "deploy" });
		assert.equal(result.details.error, "route-not-found");
		assert.match(result.content[0].text, /Configured routes: review/);
	});

	it("tries each candidate through ordinary preparation and reports every rejection", async () => {
		const result = await run({ route: "review" });
		assert.equal(result.details.error, "route-unavailable");
		const text = result.content[0].text;
		assert.match(text, /no-such-role on pi fake\/strong \(high\): .*not found/);
		// The second candidate resolved its role and stopped only at the Herdr check.
		assert.match(text, /reviewer on pi fake\/strong \(high\): .*[Hh]erdr/);
	});

	it("rejects a direct launch of a protected agent before any resource", async () => {
		const result = await run({ ...explicit, agent: "reviewer" });
		assert.equal(result.details.error, "route-required");
		assert.match(result.content[0].text, /allowed: review/);
		assert.match(result.content[0].text, /Nothing was launched/);
	});

	it("leaves unprotected agents' direct launches unchanged", async () => {
		const result = await run(explicit);
		assert.notEqual(result.details.error, "route-required");
		assert.match(result.content[0].text, /[Hh]erdr/);
	});

	it("skips candidates whose agent the route is not authorized for", async () => {
		const result = await run({ route: "open" });
		assert.equal(result.details.error, "route-unavailable");
		assert.match(
			result.content[0].text,
			/route policy allows agent "reviewer" only through route review/,
		);
	});

	it("launches a protected agent through its allowed route up to the Herdr check", async () => {
		const result = await run({ route: "review" });
		assert.match(
			result.content[0].text,
			/reviewer on pi fake\/strong \(high\): .*[Hh]erdr/,
		);
	});

	it("states enforced mappings in the parent guidelines", () => {
		const { tool, handlers } = registerSubagentTool();
		handlers.get("session_start")?.[0]({}, ctx);
		assert.match(
			tool.promptGuidelines.join("\n"),
			/agent "reviewer" launches only through route review.*route-required/,
		);
	});

	it("lists configured routes in the parent guidelines", () => {
		const { tool, handlers } = registerSubagentTool();
		handlers.get("session_start")?.[0]({}, ctx);
		const guidelines = tool.promptGuidelines.join("\n");
		assert.match(guidelines, /call subagent with route set to the route/);
		assert.match(
			guidelines,
			/review — Code review of a finished change \[no-such-role on pi fake\/strong \(high\); reviewer on pi/,
		);
	});
});
