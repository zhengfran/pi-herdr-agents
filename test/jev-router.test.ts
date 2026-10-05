/**
 * The advisory router through the real installed Pi TypeSafe adapter with a
 * fake registry, fake host authentication, fake key source, and fake fetch.
 * `globalThis.fetch` is replaced by a throwing stub for the whole file.
 */
import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	createJevRouter,
	formatJevRouterResult,
	type JevRouterInputs,
} from "../pi-extension/subagents/jev-router.ts";
import {
	JEV_ADVISORY_QUESTION_IDS,
	buildJevAdvisoryBatch,
	type JevAdvisoryBatch,
} from "../pi-extension/subagents/jev-router-questions.ts";
import {
	ENABLED_RAW,
	FALLBACK_KEY,
	HOST_KEY,
	ROUTES,
	SECRET_TASK,
	authorizationOf,
	cooperativeWire,
	createFakeFetch,
	createFakeRegistry,
	enabledInputs,
	jsonResponse,
	type FakeRegistryOptions,
	type WireSpec,
} from "./jev-router-fixtures.ts";

const STAGES = JEV_ADVISORY_QUESTION_IDS.stages;
const realFetch = globalThis.fetch;
before(() => {
	globalThis.fetch = () => {
		throw new Error("These tests must never reach the network.");
	};
});
after(() => {
	globalThis.fetch = realFetch;
});

function batchFor(routes = ROUTES, task = SECRET_TASK): JevAdvisoryBatch {
	const built = buildJevAdvisoryBatch({ task, routes });
	assert.ok(built.ok);
	return built.batch;
}

type Harness = ReturnType<typeof setup>;

function setup(
	options: {
		inputs?: JevRouterInputs;
		current?: () => JevRouterInputs;
		wire?: WireSpec;
		respond?: Parameters<typeof createFakeFetch>[0];
		registry?: FakeRegistryOptions;
		key?: () => Promise<string | undefined>;
		parent?: () => boolean;
		generation?: AbortSignal;
	} = {},
) {
	const inputs = options.inputs ?? enabledInputs();
	const batch = batchFor(inputs.routes?.length ? inputs.routes : ROUTES);
	const network = createFakeFetch(
		options.respond ??
			(() => jsonResponse(cooperativeWire(batch, options.wire))),
	);
	const fake = createFakeRegistry(options.registry);
	const keyCalls: number[] = [];
	const router = createJevRouter({
		loaded: inputs,
		readCurrent: options.current ?? (() => inputs),
		parent: options.parent ?? (() => true),
		generation: options.generation,
		fetch: network.fetch,
		keySource: async () => {
			keyCalls.push(1);
			return options.key ? options.key() : FALLBACK_KEY;
		},
	});
	const invoke = (
		invocation: { task?: string; context?: string; signal?: AbortSignal } = {},
	) =>
		router.invoke({
			task: "task" in invocation ? invocation.task : SECRET_TASK,
			context: invocation.context,
			signal: invocation.signal,
			registry: fake.registry,
		});
	return { batch, network, fake, keyCalls, invoke, inputs };
}

/** Nothing was resolved, read, or sent. */
function assertNoEgress(h: Harness) {
	assert.equal(h.fake.classifyCalls.length, 0);
	assert.equal(h.network.requests.length, 0);
	assert.equal(h.keyCalls.length, 0);
}

describe("recommendations", () => {
	it("sends one exact request with host authentication and recommends a route", async () => {
		const h = setup();
		const result = await h.invoke();
		assert.equal(result.status, "recommendation");
		assert.equal(result.recommendedRoute, "build");
		assert.deepEqual(result.reasonCodes, []);
		assert.equal(result.advisory, true);
		assert.equal(result.calibration, "uncalibrated");
		assert.equal(h.network.requests.length, 1);
		const request = h.network.requests[0];
		assert.equal(request.body, h.batch.wireBody);
		assert.equal(authorizationOf(request), `Bearer ${HOST_KEY}`);
		assert.equal(request.redirect, "error");
		const options = h.fake.classifyCalls[0].options;
		assert.equal("apiKey" in options, false);
		assert.equal(options.maxRetries, 0);
		assert.equal(h.keyCalls.length, 0);
		assert.deepEqual(result.usage, {
			inputTokens: 900,
			outputTokens: 40,
			catalogCostUsd: result.usage?.catalogCostUsd ?? null,
		});
		assert.equal(result.evidence?.primaryRoute.route, "build");
		assert.deepEqual(
			result.evidence?.routeFits.map((fit) => fit.route),
			["build", "review", "scout"],
		);
		assert.match(result.routeSnapshotHash ?? "", /^[0-9a-f]{64}$/);
	});

	it("keeps a route literally named none distinct from the no-route answer", async () => {
		const routes = [
			{ name: "none", description: "A route named none" },
			{ name: "zed", description: "Other" },
		];
		const inputs = enabledInputs(routes);
		const named = await setup({ inputs }).invoke();
		assert.equal(named.recommendedRoute, "none");
		assert.equal(named.evidence?.primaryRoute.route, "none");
		const abstain = await setup({
			inputs,
			wire: { primary: { choice: "none" } },
		}).invoke();
		assert.equal(abstain.status, "uncertain");
		assert.equal(abstain.recommendedRoute, null);
		assert.equal(abstain.evidence?.primaryRoute.route, null);
		assert.deepEqual(abstain.reasonCodes, ["no-route-match"]);
	});

	it("includes the full distributions and never echoes the brief", async () => {
		const h = setup();
		const result = await h.invoke();
		const text = JSON.stringify(result) + formatJevRouterResult(result);
		assert.ok(!text.includes("SECRET-TENANT-77"));
		assert.ok(!text.includes(HOST_KEY));
		assert.equal(
			Object.keys(result.evidence!.taskStages.probabilities).length,
			3,
		);
	});
});

describe("conservative uncertainty", () => {
	const cases: Array<[string, WireSpec, string[]]> = [
		[
			"weak primary",
			{ primary: { choice: "r00", mass: 0.6 } },
			["weak-primary"],
		],
		[
			"low primary confidence",
			{ primary: { choice: "r00", confidence: 0.5 } },
			["weak-primary"],
		],
		[
			"weak fit",
			{ answers: { route_fit_r00: { choice: "yes", mass: 0.6 } } },
			["weak-fit"],
		],
		[
			"conflicting fit",
			{ answers: { route_fit_r01: { choice: "yes" } } },
			["conflicting-fit"],
		],
		[
			"insufficient context",
			{ answers: { context_sufficiency: { choice: "insufficient" } } },
			["context-insufficient"],
		],
		[
			"unknown context",
			{ answers: { context_sufficiency: { choice: "unknown" } } },
			["context-unknown"],
		],
		[
			"multi stage",
			{ answers: { [STAGES]: { choice: "multi_stage" } } },
			["multi-stage"],
		],
		[
			"unknown stages",
			{ answers: { [STAGES]: { choice: "unknown" } } },
			["shape-unknown"],
		],
		[
			"missing description",
			{ primary: { choice: "r02" } },
			["missing-description"],
		],
	];
	for (const [label, wire, reasons] of cases)
		it(`abstains on ${label} but returns the evidence`, async () => {
			const result = await setup({ wire }).invoke();
			assert.equal(result.status, "uncertain");
			assert.equal(result.recommendedRoute, null);
			assert.deepEqual(result.reasonCodes, reasons);
			assert.ok(result.evidence);
			assert.ok(result.usage);
		});

	it("flags difficulty and risk uncertainty without changing the recommendation", async () => {
		const result = await setup({
			wire: {
				answers: {
					reasoning_difficulty: { choice: "unknown" },
					consequence_risk: { choice: "unknown" },
				},
			},
		}).invoke();
		assert.equal(result.status, "recommendation");
		assert.equal(result.recommendedRoute, "build");
		assert.deepEqual(result.reasonCodes, [
			"difficulty-unknown",
			"risk-unknown",
		]);
	});

	it("flags an elevated-risk tail even when the top label is low risk", async () => {
		const result = await setup({
			wire: {
				answers: {
					consequence_risk: {
						choice: "minor",
						probabilities: {
							minor: 0.7,
							local: 0.05,
							shared_sensitive: 0.15,
							severe: 0.1,
							unknown: 0,
						},
					},
				},
			},
		}).invoke();
		assert.equal(result.status, "recommendation");
		assert.deepEqual(result.reasonCodes, ["elevated-risk"]);
	});
});

describe("local gates send nothing", () => {
	const off = parseOff();
	function parseOff(): JevRouterInputs {
		return {
			config: {
				status: "off",
				source: "fixture",
				origin: "missing-section",
				config: { version: 1, enabled: false },
				digest: "d",
			},
			routes: ROUTES,
		};
	}
	const invalidInputs: JevRouterInputs = {
		config: { status: "invalid", source: "fixture", diagnostic: "bad" },
		routes: ROUTES,
	};
	const cases: Array<
		[
			string,
			Parameters<typeof setup>[0],
			{ task?: string; context?: string },
			string,
		]
	> = [
		["disabled", { inputs: off }, {}, "disabled"],
		["invalid config", { inputs: invalidInputs }, {}, "config-invalid"],
		["no routes", { inputs: enabledInputs([]) }, {}, "no-routes"],
		[
			"unreadable routes",
			{ inputs: { ...enabledInputs(), routes: undefined } },
			{},
			"config-invalid",
		],
		["child session", { parent: () => false }, {}, "parent-only"],
		["blank task", {}, { task: "  " }, "invalid-input"],
		["oversized task", {}, { task: "x".repeat(5000) }, "invalid-input"],
		["oversized context", {}, { context: "y".repeat(5000) }, "invalid-input"],
		["ill-formed text", {}, { task: "bad \ud800" }, "invalid-input"],
	];
	for (const [label, options, input, reason] of cases)
		it(`${label}`, async () => {
			const h = setup(options);
			const result = await h.invoke(input);
			assert.equal(result.status, "unavailable");
			assert.deepEqual(result.reasonCodes, [reason]);
			assertNoEgress(h);
		});

	it("refuses a request that cannot fit without pruning", async () => {
		const many = Array.from({ length: 32 }, (_, i) => ({
			name: `route-${String(i).padStart(2, "0")}`,
			description: "d".repeat(256),
		}));
		const inputs = enabledInputs(many);
		const network = createFakeFetch(() => jsonResponse({}));
		const fake = createFakeRegistry();
		const router = createJevRouter({
			loaded: inputs,
			readCurrent: () => inputs,
			parent: () => true,
			fetch: network.fetch,
			keySource: async () => FALLBACK_KEY,
		});
		const result = await router.invoke({
			task: "do it",
			registry: fake.registry,
		});
		assert.deepEqual(result.reasonCodes, ["request-too-large"]);
		assert.equal(fake.classifyCalls.length, 0);
	});

	it("is cancelled before anything starts when already aborted", async () => {
		const h = setup();
		const result = await h.invoke({ signal: AbortSignal.abort() });
		assert.equal(result.status, "cancelled");
		assertNoEgress(h);
	});

	it("is cancelled when its extension generation already ended", async () => {
		const h = setup({ generation: AbortSignal.abort() });
		assert.equal((await h.invoke()).status, "cancelled");
		assertNoEgress(h);
	});
});

describe("authentication", () => {
	it("uses the request-local fallback key only when Pi has no configured auth", async () => {
		const h = setup({ registry: { configuredAuth: false } });
		const result = await h.invoke();
		assert.equal(result.status, "recommendation");
		assert.equal(h.keyCalls.length, 1);
		assert.equal(
			authorizationOf(h.network.requests[0]),
			`Bearer ${FALLBACK_KEY}`,
		);
		assert.equal(h.fake.classifyCalls[0].options.apiKey, FALLBACK_KEY);
		assert.ok(!JSON.stringify(result).includes(FALLBACK_KEY));
		assert.ok(!formatJevRouterResult(result).includes(FALLBACK_KEY));
	});

	it("never reads the key when Pi auth is configured, even if the request fails", async () => {
		const h = setup({ respond: () => jsonResponse({ error: "no" }, 401) });
		const result = await h.invoke();
		assert.deepEqual(result.reasonCodes, ["http-error"]);
		assert.equal(h.keyCalls.length, 0);
		assert.equal(h.network.requests.length, 1);
	});

	it("does not retry or fall back after an HTTP auth failure with the fallback key", async () => {
		const h = setup({
			registry: { configuredAuth: false },
			respond: () => jsonResponse({ error: "FALLBACK-ERROR-BODY" }, 403),
		});
		const result = await h.invoke();
		assert.equal(result.status, "unavailable");
		assert.equal(h.network.requests.length, 1);
		assert.equal(h.keyCalls.length, 1);
		assert.ok(!JSON.stringify(result).includes("FALLBACK-ERROR-BODY"));
		assert.match(result.detail ?? "", /403/);
	});

	for (const [label, key] of [
		["no key", async () => undefined],
		[
			"a throwing reader",
			async () => {
				throw new Error("EACCES /home/user/.jev/JEV_KEY");
			},
		],
	] as const)
		it(`reports auth-unavailable without detail for ${label}`, async () => {
			const h = setup({ registry: { configuredAuth: false }, key });
			const result = await h.invoke();
			assert.deepEqual(result.reasonCodes, ["auth-unavailable"]);
			assert.equal(h.network.requests.length, 0);
			assert.equal(h.fake.classifyCalls.length, 0);
			assert.ok(!JSON.stringify(result).includes("EACCES"));
		});

	it("does not mutate the environment", async () => {
		const before = JSON.stringify(process.env);
		await setup({ registry: { configuredAuth: false } }).invoke();
		assert.equal(JSON.stringify(process.env), before);
	});
});

describe("drift, cancellation, and deadline", () => {
	it("returns config-changed before any work when consent was revoked", async () => {
		const loaded = enabledInputs();
		const h = setup({
			inputs: loaded,
			current: () => ({
				...loaded,
				config: { status: "invalid", source: "x", diagnostic: "y" },
			}),
		});
		const result = await h.invoke();
		assert.deepEqual(result.reasonCodes, ["config-changed"]);
		assertNoEgress(h);
	});

	it("detects changed settings and changed routes", async () => {
		const loaded = enabledInputs();
		const changed = enabledInputs(ROUTES, { ...ENABLED_RAW, timeoutMs: 9000 });
		const settings = setup({ inputs: loaded, current: () => changed });
		assert.deepEqual((await settings.invoke()).reasonCodes, ["config-changed"]);
		const routes = setup({
			inputs: loaded,
			current: () => enabledInputs([...ROUTES, { name: "extra" }]),
		});
		assert.deepEqual((await routes.invoke()).reasonCodes, ["config-changed"]);
		const unreadable = setup({
			inputs: loaded,
			current: () => {
				throw new Error("boom");
			},
		});
		assert.deepEqual((await unreadable.invoke()).reasonCodes, [
			"config-changed",
		]);
	});

	it("rechecks drift at the forwarding boundary after asynchronous auth", async () => {
		const loaded = enabledInputs();
		let revoked = false;
		const h = setup({
			inputs: loaded,
			registry: {
				authDelayMs: 20,
				onAuth: () => {
					revoked = true;
				},
			},
			current: () => (revoked ? enabledInputs([{ name: "other" }]) : loaded),
		});
		const result = await h.invoke();
		assert.deepEqual(result.reasonCodes, ["config-changed"]);
		assert.equal(h.network.requests.length, 0);
	});

	it("sends nothing when cancelled during host authentication", async () => {
		const controller = new AbortController();
		const h = setup({
			registry: { authDelayMs: 30, onAuth: () => controller.abort() },
		});
		const result = await h.invoke({ signal: controller.signal });
		assert.equal(result.status, "cancelled");
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(h.network.requests.length, 0);
	});

	it("sends nothing when cancelled during the key read, even if it later resolves", async () => {
		const controller = new AbortController();
		let release: (value: string) => void = () => undefined;
		const h = setup({
			registry: { configuredAuth: false },
			key: () =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		});
		const pending = h.invoke({ signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		const result = await pending;
		assert.equal(result.status, "cancelled");
		release(FALLBACK_KEY);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(h.fake.classifyCalls.length, 0);
		assert.equal(h.network.requests.length, 0);
	});

	it("honors the generation signal after dispatch without a late result", async () => {
		const generation = new AbortController();
		const h = setup({
			generation: generation.signal,
			respond: () => new Promise<Response>(() => undefined),
		});
		const pending = h.invoke();
		await new Promise((resolve) => setTimeout(resolve, 20));
		generation.abort();
		assert.equal((await pending).status, "cancelled");
		assert.equal(h.network.requests.length, 1);
	});

	it("times out under the configured deadline including key and auth waits", async () => {
		const inputs = enabledInputs(ROUTES, { ...ENABLED_RAW, timeoutMs: 500 });
		const h = setup({
			inputs,
			registry: { configuredAuth: false },
			key: () => new Promise(() => undefined),
		});
		const result = await h.invoke();
		assert.deepEqual(result.reasonCodes, ["timeout"]);
		assert.ok(
			result.elapsedMs >= 450 && result.elapsedMs < 2000,
			String(result.elapsedMs),
		);
		assert.equal(h.network.requests.length, 0);
	});

	it("returns busy for a concurrent call without queueing or sending a second request", async () => {
		let release: () => void = () => undefined;
		const h = setup({
			respond: async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return jsonResponse(cooperativeWire(batchFor()));
			},
		});
		const first = h.invoke();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = await h.invoke();
		assert.deepEqual(second.reasonCodes, ["busy"]);
		release();
		assert.equal((await first).status, "recommendation");
		assert.equal(h.network.requests.length, 1);
		// The slot is released afterwards.
		assert.equal((await h.invoke()).reasonCodes.includes("busy"), false);
	});
});

describe("strict evidence validation", () => {
	const bad: Array<[string, WireSpec, string]> = [
		["a wrong model", { model: "jev-latest" }, "model-unavailable"],
		[
			"a missing answer",
			{
				mutate: (w) => {
					delete w.answers[STAGES];
				},
			},
			"invalid-response",
		],
		[
			"an extra answer",
			{
				mutate: (w) => {
					w.answers.extra = w.answers[STAGES];
				},
			},
			"invalid-response",
		],
		[
			"a missing option",
			{
				mutate: (w) => {
					delete w.answers[STAGES].probabilities.unknown;
				},
			},
			"invalid-response",
		],
		[
			"an extra option",
			{
				mutate: (w) => {
					w.answers[STAGES].probabilities.extra = 0;
				},
			},
			"invalid-response",
		],
		[
			"a distribution not summing to one",
			{
				mutate: (w) => {
					w.answers[STAGES].probabilities.single_step = 0.5;
				},
			},
			"invalid-response",
		],
		[
			"a negative probability",
			{
				mutate: (w) => {
					w.answers[STAGES].probabilities.unknown = -0.01;
					w.answers[STAGES].probabilities.multi_stage += 0.01;
				},
			},
			"invalid-response",
		],
		[
			"a non-maximal choice",
			{
				mutate: (w) => {
					w.answers[STAGES].choice = "unknown";
				},
			},
			"invalid-response",
		],
		[
			"an impossible choice",
			{
				mutate: (w) => {
					w.answers[STAGES].choice = "maybe";
				},
			},
			"invalid-response",
		],
		[
			"a bad confidence",
			{
				mutate: (w) => {
					w.answers[STAGES].confidence = 1.5;
				},
			},
			"invalid-response",
		],
		[
			"an extra answer field",
			{
				mutate: (w) => {
					w.answers[STAGES].legend = {};
				},
			},
			"invalid-response",
		],
		[
			"a bad usage",
			{
				mutate: (w) => {
					w.usage = { input_tokens: -1, output_tokens: 1 };
				},
			},
			"invalid-response",
		],
		[
			"an extra top-level field",
			{
				mutate: (w) => {
					w.extra = 1;
				},
			},
			"invalid-response",
		],
	];
	for (const [label, wire, reason] of bad)
		it(`rejects ${label} as a whole`, async () => {
			const result = await setup({ wire }).invoke();
			assert.equal(result.status, "unavailable");
			assert.deepEqual(result.reasonCodes, [reason]);
			assert.equal(result.evidence, null);
			assert.equal(result.recommendedRoute, null);
		});

	it("rejects malformed JSON and oversized bodies", async () => {
		const malformed = await setup({
			respond: () => new Response("{nope", { status: 200 }),
		}).invoke();
		assert.deepEqual(malformed.reasonCodes, ["invalid-response"]);
		const huge = await setup({
			respond: () => new Response("x".repeat(70 * 1024), { status: 200 }),
		}).invoke();
		assert.deepEqual(huge.reasonCodes, ["response-too-large"]);
	});

	it("never echoes provider error text or the brief in an error", async () => {
		const h = setup({
			respond: () =>
				jsonResponse({ message: "PROVIDER-SECRET-TEXT SECRET-TENANT-77" }, 500),
		});
		const result = await h.invoke();
		const text = JSON.stringify(result) + formatJevRouterResult(result);
		assert.ok(!text.includes("PROVIDER-SECRET-TEXT"));
		assert.ok(!text.includes("SECRET-TENANT-77"));
		assert.equal(h.network.requests.length, 1);
	});
});

describe("host authentication status", () => {
	for (const [label, status] of [
		["throws", "throw"],
		["returns undefined", undefined],
		["returns a string", "false"],
		["returns a number", 0],
	] as const)
		it(`is auth-unavailable with no key read when hasConfiguredAuth ${label}`, async () => {
			const h = setup();
			// Deliberately violates the boolean contract.
			const probe = (): boolean | string | number | undefined => {
				if (status === "throw") throw new Error("auth status failure");
				return status;
			};
			const registry = Object.assign({}, h.fake.registry, {
				hasConfiguredAuth: probe,
			});
			const result = await createJevRouter({
				loaded: h.inputs,
				readCurrent: () => h.inputs,
				parent: () => true,
				fetch: h.network.fetch,
				keySource: async () => {
					h.keyCalls.push(1);
					return FALLBACK_KEY;
				},
			}).invoke({ task: SECRET_TASK, registry });
			assert.equal(result.status, "unavailable");
			assert.deepEqual(result.reasonCodes, ["auth-unavailable"]);
			assertNoEgress(h);
		});

	it("reads the fallback key only for an explicit false", async () => {
		const h = setup({ registry: { configuredAuth: false } });
		const result = await h.invoke();
		assert.equal(result.status, "recommendation");
		assert.equal(h.keyCalls.length, 1);
		assert.equal(h.network.requests.length, 1);
	});
});
