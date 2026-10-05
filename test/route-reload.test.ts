import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { scratch } from "./native-fixtures.ts";
import {
	createApi,
	ctxFor,
	testApi,
	writeRole,
} from "./native-flow-harness.ts";

writeRole("reload-delegator", [
	"cli: claude",
	"auto-exit: true",
	"tools: read, bash",
	"spawn-agents: reload-scout",
]);
writeRole("reload-scout", ["cli: claude", "auto-exit: true", "tools: read"]);

describe("route policy after /reload", () => {
	it("applies a newly configured policy to nested requests served by a surviving watcher", async () => {
		const project = scratch("route-reload");
		const requester: any = {
			id: "reload-req",
			name: "reload-req",
			agent: "reload-delegator",
			task: "t",
			surface: "p",
			startTime: Date.now(),
			sessionFile: "/x",
			interactive: false,
			lifecycle: createLifecycle(Date.now()),
			native: { driver: { outstandingNested: 0 } },
			nativeDelegation: {
				ctx: ctxFor(project),
				parentThinking: "medium",
				tools: new Set(["read", "bash"]),
				agents: ["reload-scout"],
				cwd: project,
				children: new Map(),
				total: 0,
				queue: Promise.resolve(),
			},
		};
		const request = () => ({
			nonce: randomUUID().replace(/-/g, ""),
			pid: 1,
			createdAt: Date.now(),
			agent: "reload-scout",
			name: "probe",
			task: "t",
		});
		// Keep this policy test resource-free even when its parent runs in Herdr.
		testApi.setNativeTestSeam({ terminalAvailable: false });
		// The first module's handler is what a surviving native watcher retains.
		const survivingHandler = testApi.handleNestedSpawnRequest;
		testApi.runningSubagents.set(requester.id, requester);
		try {
			const before = await survivingHandler(requester, request());
			assert.equal(before.accepted, false);
			assert.match(before.text, /require herdr/i);
			assert.doesNotMatch(before.text, /configured route/);

			// Add the policy and reload: a fresh module evaluates the new config.
			mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "herdr-agents"), {
				recursive: true,
			});
			writeFileSync(
				join(process.env.PI_CODING_AGENT_DIR!, "herdr-agents", "config.json"),
				JSON.stringify({
					routes: {
						scout: {
							candidates: [
								{
									agent: "reload-scout",
									harness: "claude",
									model: "opus",
									thinking: "high",
								},
							],
						},
					},
					routePolicy: { requiredForAgents: { "reload-scout": ["scout"] } },
				}),
			);
			const reloaded: any = await import(
				new URL(
					"../pi-extension/subagents/index.ts?route-reload",
					import.meta.url,
				).href
			);
			const reloadedHandlers = new Map<string, Function[]>();
			reloaded.default(createApi([], reloadedHandlers, [], new Map(), []));

			const after = await survivingHandler(requester, request());
			assert.equal(after.accepted, false);
			assert.match(after.text, /configured route/);
			assert.match(after.text, /Nothing was launched/);

			// Once the current module generation shuts down, an old watcher's
			// forwarder must fail closed instead of falling back to stale policy.
			for (const handler of reloadedHandlers.get("session_shutdown") ?? [])
				await handler({ reason: "reload" }, {});
			const unavailable = await survivingHandler(requester, request());
			assert.equal(unavailable.accepted, false);
			assert.match(unavailable.text, /no current extension runtime/);
		} finally {
			testApi.runningSubagents.delete(requester.id);
		}
	});
});
