/**
 * The public `jev_router` tool as registered by the real extension: parent-only
 * registration, conditional guidance, structured output, no launch, and
 * automatic-routing transport compatibility.
 */
import "./isolated-agent-dir.ts";
import "./jev-router-flow-config.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Value } from "@sinclair/typebox/value";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
	createBoundedObservingFetch,
	createJevDeadline,
	type JevBoundedObservingFetch,
	type JevBoundedObservingFetchBatchOptions,
	type JevBoundedObservingFetchOptions,
} from "../pi-extension/subagents/jev-client.ts";
import { runJevClassification } from "../pi-extension/subagents/jev-transport.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { FLOW_ROUTES } from "./jev-router-flow-config.ts";
import {
	createApi,
	ctxFor,
	testApi,
	useHerdr,
	writeRole,
} from "./native-flow-harness.ts";
import { scratch, waitFor } from "./native-fixtures.ts";
import {
	ROUTES,
	cooperativeWire,
	createFakeFetch,
	createFakeRegistry,
	enabledInputs,
	jsonResponse,
} from "./jev-router-fixtures.ts";
import { buildJevAdvisoryBatch } from "../pi-extension/subagents/jev-router-questions.ts";

function mockApi() {
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	const api: any = {
		events: createEventBus(),
		on(event: string, handler: Function) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: any) => tools.push(tool),
		registerCommand() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		sendUserMessage() {},
		sendMessage() {},
		getAllTools: () => [],
	};
	return { api, tools, handlers };
}

function install(
	options: Parameters<typeof subagentsModule.default>[1] = {},
	env: NodeJS.ProcessEnv = {},
) {
	const mock = mockApi();
	subagentsModule.default(mock.api, {
		...options,
		jevRouter: { env, ...options.jevRouter },
	});
	return mock;
}

const built = buildJevAdvisoryBatch({
	task: "Review the change",
	routes: ROUTES,
});

describe("jev_router registration", () => {
	it("is registered for a parent with no spawning or launch side effects", () => {
		const { tools } = install({
			jevRouter: { readInputs: () => enabledInputs() },
		});
		const tool = tools.find((candidate) => candidate.name === "jev_router");
		assert.ok(tool);
		assert.ok(Value.Check(tool.parameters, { task: "x" }));
		assert.ok(Value.Check(tool.parameters, { task: "x", context: "y" }));
		assert.equal(Value.Check(tool.parameters, { task: "x", extra: 1 }), false);
		assert.equal(Value.Check(tool.parameters, {}), false);
		assert.ok(tool.outputSchema);
	});

	it("adds tool-first guidance only when enabled with consent and routes", () => {
		const enabled = install({
			jevRouter: { readInputs: () => enabledInputs() },
		});
		const guidance = enabled.tools.find(
			(tool) => tool.name === "jev_router",
		).promptGuidelines;
		assert.equal(guidance.length, 1);
		assert.match(guidance[0], /call jev_router/);
		assert.match(guidance[0], /omitting agent, harness, model, and thinking/);
		const noRoutes = install({
			jevRouter: { readInputs: () => enabledInputs([]) },
		});
		assert.deepEqual(
			noRoutes.tools.find((tool) => tool.name === "jev_router")
				.promptGuidelines,
			[],
		);
		const off = install({
			jevRouter: {
				readInputs: () => ({
					config: {
						status: "off",
						source: "x",
						origin: "missing-file",
						config: { version: 1, enabled: false },
						digest: "d",
					},
					routes: ROUTES,
				}),
			},
		});
		assert.deepEqual(
			off.tools.find((tool) => tool.name === "jev_router").promptGuidelines,
			[],
		);
	});

	for (const marker of [
		"PI_SUBAGENT_ID",
		"PI_SUBAGENT_SESSION",
		"PI_SUBAGENT_PERSISTENT",
		"PI_SUBAGENT_AUTO_EXIT",
		"PI_HERDR_AUTO_ROUTING_DISABLED",
	])
		it(`is not registered when ${marker} marks a child or side session`, () => {
			const { tools } = install(
				{ jevRouter: { readInputs: () => enabledInputs() } },
				{ [marker]: "1" },
			);
			assert.equal(
				tools.some((tool) => tool.name === "jev_router"),
				false,
			);
		});

	it("honors a deny-tools entry", () => {
		const previous = process.env.PI_DENY_TOOLS;
		// deniedTools is read only for children; a parent keeps its tools.
		process.env.PI_DENY_TOOLS = "jev_router";
		try {
			const { tools } = install({
				jevRouter: { readInputs: () => enabledInputs() },
			});
			assert.ok(tools.some((tool) => tool.name === "jev_router"));
		} finally {
			if (previous === undefined) delete process.env.PI_DENY_TOOLS;
			else process.env.PI_DENY_TOOLS = previous;
		}
	});
});

describe("jev_router execution", () => {
	it("returns structured advisory output and launches nothing", async () => {
		assert.ok(built.ok);
		const batch = built.batch;
		const network = createFakeFetch(() => jsonResponse(cooperativeWire(batch)));
		const fake = createFakeRegistry();
		const { tools } = install({
			jevRouter: { readInputs: () => enabledInputs(), fetch: network.fetch },
		});
		const tool = tools.find((candidate) => candidate.name === "jev_router");
		const subagent = tools.find((candidate) => candidate.name === "subagent");
		assert.ok(subagent);
		const result = await tool.execute(
			"id",
			{ task: "Review the change" },
			undefined,
			undefined,
			{ modelRegistry: fake.registry },
		);
		assert.equal(result.isError, false);
		assert.equal(result.structuredContent.status, "recommendation");
		assert.equal(result.structuredContent.recommendedRoute, "build");
		assert.deepEqual(
			result.structuredContent,
			JSON.parse(JSON.stringify(result.details)),
		);
		assert.ok(Value.Check(tool.outputSchema, result.structuredContent));
		assert.match(
			result.content[0].text,
			/Advisory recommendation: route "build"/,
		);
		assert.equal(network.requests.length, 1);
	});

	it("rechecks the child markers at execution and sends nothing", async () => {
		const env: NodeJS.ProcessEnv = {};
		const network = createFakeFetch(() => jsonResponse({}));
		const fake = createFakeRegistry();
		const { tools } = install(
			{
				jevRouter: {
					readInputs: () => enabledInputs(),
					fetch: network.fetch,
					env,
				},
			},
			env,
		);
		env.PI_SUBAGENT_ID = "child";
		const result = await tools
			.find((tool) => tool.name === "jev_router")
			.execute("id", { task: "x" }, undefined, undefined, {
				modelRegistry: fake.registry,
			});
		assert.equal(result.isError, true);
		assert.deepEqual(result.structuredContent.reasonCodes, ["parent-only"]);
		assert.equal(fake.classifyCalls.length, 0);
	});

	it("returns a cheap local disabled result without resolving authentication", async () => {
		const fake = createFakeRegistry();
		const { tools } = install({
			jevRouter: {
				readInputs: () => ({
					config: {
						status: "off",
						source: "x",
						origin: "missing-file",
						config: { version: 1, enabled: false },
						digest: "d",
					},
					routes: ROUTES,
				}),
				keySource: async () => {
					throw new Error("must not read a key");
				},
			},
		});
		const result = await tools
			.find((tool) => tool.name === "jev_router")
			.execute("id", { task: "x" }, undefined, undefined, {
				modelRegistry: fake.registry,
			});
		assert.deepEqual(result.structuredContent.reasonCodes, ["disabled"]);
		assert.equal(fake.classifyCalls.length, 0);
	});

	it("aborts in-flight advisory work when the extension generation shuts down", async () => {
		const network = createFakeFetch(
			() => new Promise<Response>(() => undefined),
		);
		const fake = createFakeRegistry();
		const mock = install({
			jevRouter: { readInputs: () => enabledInputs(), fetch: network.fetch },
		});
		const tool = mock.tools.find(
			(candidate) => candidate.name === "jev_router",
		);
		const pending = tool.execute("id", { task: "x" }, undefined, undefined, {
			modelRegistry: fake.registry,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		for (const handler of mock.handlers.get("session_shutdown") ?? [])
			await handler({ reason: "reload" }, {});
		const result = await pending;
		assert.equal(result.structuredContent.status, "cancelled");
	});
});

describe("jev_router host usage and output schema", () => {
	const run = async (respond: Parameters<typeof createFakeFetch>[0]) => {
		const network = createFakeFetch(respond);
		const { tools } = install({
			jevRouter: { readInputs: () => enabledInputs(), fetch: network.fetch },
		});
		const tool = tools.find((candidate) => candidate.name === "jev_router");
		return {
			tool,
			network,
			execute: (registry: any) =>
				tool.execute(
					"id",
					{ task: "Review the change" },
					undefined,
					undefined,
					{
						modelRegistry: registry,
					},
				),
		};
	};

	it("returns validated classifier usage in Pi's host usage shape", async () => {
		assert.ok(built.ok);
		const wire = cooperativeWire(built.batch, {
			usage: { input_tokens: 321, output_tokens: 12 },
		});
		const { execute } = await run(() => jsonResponse(wire));
		const result = await execute(createFakeRegistry().registry);
		assert.equal(result.structuredContent.usage.inputTokens, 321);
		assert.equal(result.usage.input, 321);
		assert.equal(result.usage.output, 12);
		assert.equal(result.usage.totalTokens, 333);
		assert.equal(result.usage.cacheRead, 0);
		assert.equal(result.usage.cacheWrite, 0);
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"])
			assert.ok(Number.isFinite(result.usage.cost[field]), field);
	});

	it("omits host usage when nothing was sent", async () => {
		const { execute } = await run(() => jsonResponse({}));
		const result = await execute({
			...createFakeRegistry().registry,
			hasConfiguredAuth: () => {
				throw new Error("status failure");
			},
		});
		assert.equal(result.structuredContent.status, "unavailable");
		assert.equal("usage" in result, false);
	});

	it("accepts real successful, uncertain, and unavailable results", async () => {
		assert.ok(built.ok);
		const wire = (primary: string) =>
			cooperativeWire(built.batch, { primary: { choice: primary } });
		const ok = await run(() => jsonResponse(wire(built.batch.routes[0].id)));
		const none = await run(() => jsonResponse(wire("none")));
		const down = await run(() => jsonResponse({}, 500));
		for (const { tool, execute } of [ok, none, down]) {
			const result = await execute(createFakeRegistry().registry);
			assert.ok(
				Value.Check(tool.outputSchema, result.structuredContent),
				result.structuredContent.status,
			);
		}
		const evidence = (await ok.execute(createFakeRegistry().registry))
			.structuredContent;
		assert.ok(evidence.evidence);
		assert.equal(
			Value.Check(ok.tool.outputSchema, { ...evidence, evidence: 42 }),
			false,
		);
		assert.equal(
			Value.Check(ok.tool.outputSchema, { ...evidence, usage: "x" }),
			false,
		);
		assert.equal(
			Value.Check(ok.tool.outputSchema, {
				...evidence,
				evidence: { ...evidence.evidence, taskStages: { choice: 1 } },
			}),
			false,
		);
	});
});

describe("jev-client facade type exports", () => {
	it("keeps the batch-based observing fetch types", () => {
		// Compile-time contract: batch-based options, no raw wire body or label.
		const keys = [
			"batch",
			"fetch",
			"maxResponseBytes",
			"authorize",
		] as const satisfies readonly (keyof JevBoundedObservingFetchOptions)[];
		const noWireBody: "wireBody" extends keyof JevBoundedObservingFetchOptions
			? never
			: true = true;
		const alias = (
			options: JevBoundedObservingFetchOptions,
		): JevBoundedObservingFetchBatchOptions => options;
		const reverse = (
			options: JevBoundedObservingFetchBatchOptions,
		): JevBoundedObservingFetchOptions => options;
		const observing: (
			options: JevBoundedObservingFetchOptions,
		) => JevBoundedObservingFetch = createBoundedObservingFetch;
		assert.equal(keys.length, 4);
		assert.equal(noWireBody, true);
		assert.ok(alias instanceof Function);
		assert.ok(reverse instanceof Function);
		assert.ok(observing instanceof Function);
	});
});

describe("automatic routing compatibility", () => {
	it("never supplies a fallback credential for automatic batches", async () => {
		const fake = createFakeRegistry({ configuredAuth: false });
		const generic = await runJevClassification({
			registry: fake.registry,
			context: {},
			wireBody: "{}",
			label: "Batch A",
			deadline: createJevDeadline(500),
			validate: () => ({
				ok: false,
				reason: "jev-invalid-response",
				detail: "x",
			}),
		});
		assert.deepEqual(generic, {
			status: "unavailable",
			reason: "jev-auth-unavailable",
			detail: "The typesafe provider has no configured authentication.",
		});
		assert.equal(fake.classifyCalls.length, 0);
	});
});

describe("generation cancellation", () => {
	// Pi replaces the whole extension runtime on /new, /resume and /fork after
	// emitting session_shutdown with that reason, so one handler covers them.
	for (const reason of ["quit", "reload", "new", "resume", "fork"])
		it(`cancels in-flight advisory work on session_shutdown (${reason})`, async () => {
			const network = createFakeFetch(
				() => new Promise<Response>(() => undefined),
			);
			const fake = createFakeRegistry();
			const mock = install({
				jevRouter: { readInputs: () => enabledInputs(), fetch: network.fetch },
			});
			const tool = mock.tools.find(
				(candidate) => candidate.name === "jev_router",
			);
			const pending = tool.execute("id", { task: "x" }, undefined, undefined, {
				modelRegistry: fake.registry,
			});
			await waitFor(() => network.requests.length === 1);
			for (const handler of mock.handlers.get("session_shutdown") ?? [])
				await handler({ reason }, {});
			const result = await pending;
			assert.equal(result.structuredContent.status, "cancelled");
			assert.equal(result.isError, true);
			assert.equal(network.requests.length, 1);
		});

	it("sends nothing from a retired generation after shutdown", async () => {
		const network = createFakeFetch(() => jsonResponse({}));
		const fake = createFakeRegistry();
		const mock = install({
			jevRouter: { readInputs: () => enabledInputs(), fetch: network.fetch },
		});
		for (const handler of mock.handlers.get("session_shutdown") ?? [])
			await handler({ reason: "new" }, {});
		const result = await mock.tools
			.find((candidate) => candidate.name === "jev_router")
			.execute("id", { task: "x" }, undefined, undefined, {
				modelRegistry: fake.registry,
			});
		assert.equal(result.structuredContent.status, "cancelled");
		assert.equal(network.requests.length, 0);
		assert.equal(fake.classifyCalls.length, 0);
	});
});

describe("parent-only deny-tools guard", () => {
	const withEnv = <T>(values: Record<string, string>, body: () => T): T => {
		const previous = Object.fromEntries(
			Object.keys(values).map((key) => [key, process.env[key]]),
		);
		Object.assign(process.env, values);
		try {
			return body();
		} finally {
			for (const [key, value] of Object.entries(previous))
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
		}
	};

	it("does not register for a child that denies jev_router", () => {
		const { tools } = withEnv(
			{ PI_SUBAGENT_ID: "child", PI_DENY_TOOLS: "subagent, jev_router" },
			() => install({ jevRouter: { readInputs: () => enabledInputs() } }, {}),
		);
		assert.equal(
			tools.some((tool) => tool.name === "jev_router"),
			false,
		);
	});

	it("registers for the same environment without the deny entry, proving the deny list is what removed it", () => {
		const { tools } = withEnv(
			{ PI_SUBAGENT_ID: "child", PI_DENY_TOOLS: "subagent" },
			() => install({ jevRouter: { readInputs: () => enabledInputs() } }, {}),
		);
		assert.ok(tools.some((tool) => tool.name === "jev_router"));
	});

	it("gives a child no advisory tool and no advisory guidance anywhere", () => {
		const { tools } = install(
			{ jevRouter: { readInputs: () => enabledInputs() } },
			{ PI_SUBAGENT_ID: "child" },
		);
		assert.equal(
			tools.some((tool) => tool.name === "jev_router"),
			false,
		);
		for (const tool of tools)
			assert.doesNotMatch(
				(tool.promptGuidelines ?? []).join("\n"),
				/jev_router/,
			);
	});

	it("keeps the manual subagent guidance free of advisory requirements", () => {
		const { tools } = install({
			jevRouter: { readInputs: () => enabledInputs() },
		});
		const subagent = tools.find((tool) => tool.name === "subagent");
		assert.doesNotMatch(
			(subagent.promptGuidelines ?? []).join("\n"),
			/jev_router/,
		);
	});
});

// ---------------------------------------------------------------------------
// jev_router -> separate public subagent({route}) flow
// ---------------------------------------------------------------------------

writeRole("jf-pi", ["auto-exit: true", "tools: read, bash"]);
writeRole("jf-guarded", ["auto-exit: true", "tools: read"]);
writeRole("jf-claude", ["cli: claude", "auto-exit: true", "tools: read, bash"]);

const flowRoutes = Object.entries(FLOW_ROUTES).map(([name, route]) => ({
	name,
	description: "description" in route ? route.description : undefined,
}));
const flowBatch = (task: string) => {
	const built = buildJevAdvisoryBatch({ task, routes: flowRoutes });
	assert.ok(built.ok);
	return built.batch;
};
const flowModels = ["parent", "pi-a", "pi-b"].map((id) => ({
	provider: "fake",
	id,
	reasoning: true,
}));
const flowRegistry = {
	find: (provider: string, id: string) =>
		flowModels.find((m) => m.provider === provider && m.id === id),
	getAvailable: () => flowModels,
	hasConfiguredAuth: () => true,
};

/** A real extension instance with the real durable config and a fake transport. */
function flowInstall(respond: Parameters<typeof createFakeFetch>[0]) {
	const sink: any[] = [];
	const tools: any[] = [];
	const handlers = new Map<string, Function[]>();
	const network = createFakeFetch(respond);
	subagentsModule.default(createApi(sink, handlers, tools, new Map(), []), {
		jevRouter: { env: {}, fetch: network.fetch },
	});
	const byName = (name: string) => tools.find((tool) => tool.name === name);
	return {
		sink,
		handlers,
		network,
		advise: byName("jev_router"),
		subagent: byName("subagent"),
	};
}

/** Record Pi launches through the fake Herdr seam; each watch settles clean. */
function recordPiLaunches() {
	const launched: string[] = [];
	let panes = 0;
	testApi.setNativeTestSeam({
		operations: {
			createPane: () => `jf-pane-${++panes}`,
			createWorktree() {
				throw new Error("unexpected worktree creation");
			},
			async waitForShellReady() {},
			runScript(_surface: string, command: string, script: any) {
				launched.push(command);
				return script.scriptPath;
			},
			closePane() {},
		},
		terminalAvailable: true,
		piWatch: async (child: any) => ({
			name: child.name,
			task: child.task,
			summary: "Pi fixture result",
			exitCode: 0,
			elapsed: 0,
			sessionFile: child.sessionFile,
		}),
	});
	return launched;
}

function advisoryContext(project: string, registry: typeof flowRegistry) {
	return { ...ctxFor(project), modelRegistry: registry };
}

describe("jev_router then a separate public subagent route launch", () => {
	const instances: Array<ReturnType<typeof flowInstall>> = [];
	after(async () => {
		for (const instance of instances)
			for (const handler of instance.handlers.get("session_shutdown") ?? [])
				await handler({ reason: "reload" }, {});
	});
	const open = (respond: Parameters<typeof createFakeFetch>[0]) => {
		const instance = flowInstall(respond);
		instances.push(instance);
		return instance;
	};
	const settled = (instance: ReturnType<typeof flowInstall>, name: string) =>
		waitFor(() =>
			instance.sink.some(
				(message) =>
					message.customType === "subagent_result" &&
					message.details?.name === name,
			),
		);
	const recommend = (task: string, route: string) => {
		const batch = flowBatch(task);
		const id = batch.routes.find((entry) => entry.name === route)!.id;
		return cooperativeWire(batch, { primary: { choice: id } });
	};

	it("recommends from the real durable routes, launches nothing, and sends no candidate data", async () => {
		const task = "Implement the billing export change";
		const instance = open(() => jsonResponse(recommend(task, "alpha")));
		const launched = recordPiLaunches();
		const project = scratch("jf-advice");
		const fake = createFakeRegistry();
		const before = testApi.runningSubagents.size;
		const advice = await instance.advise.execute(
			"a",
			{ task },
			undefined,
			undefined,
			{
				modelRegistry: fake.registry,
			},
		);
		assert.equal(advice.structuredContent.recommendedRoute, "alpha");
		assert.equal(launched.length, 0);
		assert.equal(testApi.runningSubagents.size, before);
		assert.equal(instance.network.requests.length, 1);
		const wire = String(instance.network.requests[0].body);
		for (const leaked of [
			"jf-pi",
			"jf-missing",
			"jf-guarded",
			"fake/pi",
			"sonnet",
			"claude",
			"harness",
		])
			assert.equal(wire.includes(leaked), false, leaked);
		for (const route of Object.keys(FLOW_ROUTES))
			assert.ok(wire.includes(route), route);
		void project;
	});

	it("launches the recommended route in configured candidate order through the real subagent tool", async () => {
		const task = "Implement the billing export change";
		const instance = open(() => jsonResponse(recommend(task, "alpha")));
		const launched = recordPiLaunches();
		const project = scratch("jf-order");
		const fake = createFakeRegistry();
		const advice = await instance.advise.execute(
			"a",
			{ task },
			undefined,
			undefined,
			{
				modelRegistry: fake.registry,
			},
		);
		const route = advice.structuredContent.recommendedRoute;
		const started = await instance.subagent.execute(
			"b",
			{ name: "jf-order", task, route },
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(
			started.details.status,
			"started",
			JSON.stringify(started.content),
		);
		// The first candidate's role is missing, so the second candidate wins
		// over the later third one, exactly as configured.
		assert.equal(started.details.runtimePlan.model, "fake/pi-b");
		assert.equal(started.details.agent, "jf-pi");
		await settled(instance, "jf-order");
		assert.equal(launched.length, 1);
		assert.equal(instance.network.requests.length, 1);
	});

	it("launches a manual route with zero JEV calls", async () => {
		const instance = open(() => {
			throw new Error("manual routing must not contact JEV");
		});
		recordPiLaunches();
		const project = scratch("jf-manual");
		const started = await instance.subagent.execute(
			"b",
			{ name: "jf-manual", task: "Do it", route: "alpha" },
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(
			started.details.status,
			"started",
			JSON.stringify(started.content),
		);
		assert.equal(started.details.runtimePlan.model, "fake/pi-b");
		await settled(instance, "jf-manual");
		assert.equal(instance.network.requests.length, 0);
	});

	it("lets the parent override a recommendation with another route", async () => {
		const task = "Implement the billing export change";
		const instance = open(() => jsonResponse(recommend(task, "guarded")));
		recordPiLaunches();
		const project = scratch("jf-override");
		const fake = createFakeRegistry();
		const advice = await instance.advise.execute(
			"a",
			{ task },
			undefined,
			undefined,
			{
				modelRegistry: fake.registry,
			},
		);
		assert.equal(advice.structuredContent.recommendedRoute, "guarded");
		const started = await instance.subagent.execute(
			"b",
			{ name: "jf-override", task, route: "alpha" },
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(
			started.details.status,
			"started",
			JSON.stringify(started.content),
		);
		assert.equal(started.details.agent, "jf-pi");
		await settled(instance, "jf-override");
	});

	it("keeps manual routing available after an advisory transport failure", async () => {
		const instance = open(() => jsonResponse({}, 500));
		recordPiLaunches();
		const project = scratch("jf-failure");
		const fake = createFakeRegistry();
		const advice = await instance.advise.execute(
			"a",
			{ task: "Implement the billing export change" },
			undefined,
			undefined,
			{ modelRegistry: fake.registry },
		);
		assert.equal(advice.isError, true);
		assert.equal(advice.structuredContent.status, "unavailable");
		assert.equal(advice.structuredContent.recommendedRoute, null);
		assert.equal(instance.network.requests.length, 1);
		const started = await instance.subagent.execute(
			"b",
			{ name: "jf-failure", task: "Do it", route: "alpha" },
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(
			started.details.status,
			"started",
			JSON.stringify(started.content),
		);
		await settled(instance, "jf-failure");
		assert.equal(instance.network.requests.length, 1);
	});

	it("does not let a recommendation bypass required-route policy for a protected agent", async () => {
		const task = "Review the finished billing export change";
		const instance = open(() => jsonResponse(recommend(task, "guarded")));
		recordPiLaunches();
		const project = scratch("jf-policy");
		const fake = createFakeRegistry();
		const advice = await instance.advise.execute(
			"a",
			{ task },
			undefined,
			undefined,
			{
				modelRegistry: fake.registry,
			},
		);
		assert.equal(advice.structuredContent.recommendedRoute, "guarded");
		const before = testApi.runningSubagents.size;
		const direct = await instance.subagent.execute(
			"b",
			{
				name: "jf-direct",
				task,
				agent: "jf-guarded",
				harness: "pi",
				model: "fake/pi-a",
				thinking: "high",
			},
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(direct.details.error, "route-required");
		assert.equal(testApi.runningSubagents.size, before);
		const routed = await instance.subagent.execute(
			"c",
			{
				name: "jf-routed",
				task,
				route: advice.structuredContent.recommendedRoute,
			},
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(
			routed.details.status,
			"started",
			JSON.stringify(routed.content),
		);
		assert.equal(routed.details.agent, "jf-guarded");
		await settled(instance, "jf-routed");
	});

	it("rejects advisory route arguments that conflict with explicit runtime fields", async () => {
		const instance = open(() => jsonResponse({}));
		recordPiLaunches();
		const project = scratch("jf-conflict");
		const result = await instance.subagent.execute(
			"b",
			{
				name: "jf-conflict",
				task: "Do it",
				route: "alpha",
				model: "fake/pi-a",
			},
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(result.details.error, "route-conflict");
	});

	it("reports an unlaunchable recommended route without launching or retrying the advisory", async () => {
		const task = "Handle the dead route";
		const instance = open(() => jsonResponse(recommend(task, "dead")));
		const launched = recordPiLaunches();
		const project = scratch("jf-dead");
		const fake = createFakeRegistry();
		const advice = await instance.advise.execute(
			"a",
			{ task },
			undefined,
			undefined,
			{
				modelRegistry: fake.registry,
			},
		);
		assert.equal(advice.structuredContent.recommendedRoute, "dead");
		const result = await instance.subagent.execute(
			"b",
			{ name: "jf-dead", task, route: "dead" },
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(result.details.error, "route-unavailable");
		assert.equal(launched.length, 0);
		assert.equal(instance.network.requests.length, 1);
	});

	it("launches a recommended native route through the offline fixture CLI", async () => {
		const task = "Implement natively";
		const instance = open(() => jsonResponse(recommend(task, "native")));
		const project = scratch("jf-native");
		useHerdr({ log: `${project}/../jf-native.json` });
		const fake = createFakeRegistry();
		const advice = await instance.advise.execute(
			"a",
			{ task },
			undefined,
			undefined,
			{
				modelRegistry: fake.registry,
			},
		);
		assert.equal(advice.structuredContent.recommendedRoute, "native");
		const started = await instance.subagent.execute(
			"b",
			{ name: "jf-native", task, route: "native" },
			new AbortController().signal,
			() => {},
			advisoryContext(project, flowRegistry),
		);
		assert.equal(
			started.details.status,
			"started",
			JSON.stringify(started.content),
		);
		await settled(instance, "jf-native");
		const result = instance.sink.find(
			(message) =>
				message.details?.name === "jf-native" &&
				message.customType === "subagent_result",
		);
		assert.equal(result.details.exitCode, 0, JSON.stringify(result.content));
		assert.equal(result.details.native.model, "sonnet");
		assert.equal(instance.network.requests.length, 1);
	});
});
