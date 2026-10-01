import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RuntimeResolutionError,
	buildAuthenticatedModelCatalog,
	getAuthenticatedTaskPreferences,
	resolveRuntimePlan,
	resolveRuntimePlans,
	wrapPiModelRegistry,
	type ParentRuntime,
	type RoutingModel,
	type RuntimeDefaults,
	type RuntimeRequest,
} from "../pi-extension/subagents/runtime-routing.ts";

const parent: ParentRuntime = {
	provider: "fake",
	modelId: "parent",
	thinking: "medium",
};

function model(
	provider: string,
	id: string,
	overrides: Partial<RoutingModel> = {},
) {
	return {
		provider,
		id,
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

function normalized(value: string) {
	return value.replace(/\s+/g, " ").trim();
}

const ordinaryReviewClauses = [
	"For ordinary review, prefer a different authenticated model family.",
	"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
	"Disclose that this review is context-isolated, not cross-family independent.",
	"Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
];

function registry(entries = [model("fake", "parent"), model("other", "fast")]) {
	const byRef = new Map(
		entries.map((entry) => [`${entry.provider}/${entry.id}`, entry]),
	);
	return wrapPiModelRegistry({
		find(provider: string, modelId: string) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return entries;
		},
		getAll() {
			return entries;
		},
		hasConfiguredAuth(candidate: { provider: string; id: string }) {
			return (
				byRef.has(`${candidate.provider}/${candidate.id}`) &&
				candidate.id !== "unauthed"
			);
		},
	});
}

function resolve(request: RuntimeRequest = {}, defaults: RuntimeDefaults = {}) {
	return resolveRuntimePlan(request, defaults, parent, registry());
}

describe("runtime routing", () => {
	it("inherits the parent model and thinking when no override is requested", () => {
		assert.deepEqual(resolve(), {
			provider: "fake",
			modelId: "parent",
			model: "fake/parent",
			thinking: "medium",
			modelSource: "parent",
			thinkingSource: "parent",
		});
	});

	it("resolves tool-call fields over agent defaults independently", () => {
		assert.deepEqual(
			resolve({ thinking: "high" }, { model: "other/fast", thinking: "low" }),
			{
				provider: "other",
				modelId: "fast",
				model: "other/fast",
				thinking: "high",
				modelSource: "agent",
				thinkingSource: "request",
				requestedModel: "other/fast",
				requestedThinking: "high",
			},
		);
	});

	it("parses exact model references at the first slash", () => {
		const nested = model("other", "family/reasoner");
		const plan = resolveRuntimePlan(
			{ model: "other/family/reasoner" },
			{},
			parent,
			registry([model("fake", "parent"), nested]),
		);
		assert.equal(plan.provider, "other");
		assert.equal(plan.modelId, "family/reasoner");
	});

	it("rejects fuzzy, unknown, and unauthenticated explicit models", () => {
		for (const request of [
			{ model: "fast" },
			{ model: "other/missing" },
			{ model: "other/unauthed" },
		]) {
			const entries = [model("fake", "parent"), model("other", "unauthed")];
			assert.throws(
				() => resolveRuntimePlan(request, {}, parent, registry(entries)),
				RuntimeResolutionError,
			);
		}
	});

	it("resolves trimmed fallback candidates in declaration order", () => {
		const plans = resolveRuntimePlans(
			{ model: " other/fast , fake/parent " },
			{},
			parent,
			registry(),
		);
		assert.deepEqual(
			plans.map((plan) => [plan.model, plan.modelSource]),
			[
				["other/fast", "request"],
				["fake/parent", "request"],
			],
		);
	});

	it("validates every fallback before launch", () => {
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "other/fast, other/missing" },
					{},
					parent,
					registry(),
				),
			/unknown model "other\/missing"/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans({ model: "other/fast," }, {}, parent, registry()),
			/cannot contain an empty candidate/,
		);
	});

	it("expands whole-value task references using authenticated configured order", () => {
		const entries = [
			model("fake", "parent"),
			model("other", "worker"),
			model("other", "backup"),
			model("other", "unauthed"),
		];
		const tasks = {
			coding: ["other/worker", "other/unauthed", "other/backup"],
		};
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: " task:CoDiNg " },
				{},
				parent,
				registry(entries),
				tasks,
			).map((plan) => plan.model),
			["other/worker", "other/backup"],
		);
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: "task:coding" },
				{},
				parent,
				registry(entries),
				tasks,
				true,
			).map((plan) => plan.model),
			["other/worker"],
		);
		for (const modelReference of [
			"task:coding, other/backup",
			"other/backup, task:coding",
		]) {
			assert.throws(
				() =>
					resolveRuntimePlans(
						{ model: modelReference },
						{},
						parent,
						registry(entries),
						tasks,
					),
				/must be the entire model value/,
			);
		}
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "task:qa" },
					{},
					parent,
					registry(entries),
					tasks,
				),
			/configured categories: coding/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans(
					{},
					{ model: "task:coding" },
					parent,
					registry(entries),
					tasks,
				),
			/only valid in the subagent tool's model parameter/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "task:coding" },
					{},
					parent,
					registry([model("fake", "parent"), model("other", "unauthed")]),
					{ coding: ["other/unauthed"] },
				),
			/task category "coding" has no authenticated candidates; authenticated alternatives: fake\/parent/,
		);
	});

	it("keeps the selected source when agent defaults provide fallbacks", () => {
		const plans = resolveRuntimePlans(
			{},
			{ model: "other/fast, fake/parent" },
			parent,
			registry(),
		);
		assert.deepEqual(
			plans.map((plan) => plan.modelSource),
			["agent", "agent"],
		);
	});

	it("rejects unsupported explicit thinking with supported alternatives", () => {
		const plain = model("other", "plain", { reasoning: false });
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "other/plain", thinking: "high" },
					{},
					parent,
					registry([model("fake", "parent"), plain]),
				),
			/thinking "high" is not supported.*supported: off/,
		);
	});

	it("uses agent-default thinking when the request omits it", () => {
		const plan = resolveRuntimePlan(
			{},
			{ thinking: "low" },
			parent,
			registry(),
		);
		assert.equal(plan.thinking, "low");
		assert.equal(plan.thinkingSource, "agent");
		assert.equal(plan.requestedThinking, "low");
	});

	it("clamps inherited thinking for a reasoning model with a sparse level map", () => {
		const sparse = model("other", "sparse", {
			thinkingLevelMap: {
				off: "off",
				minimal: "minimal",
				low: "low",
				medium: null,
				high: "high",
			},
		});
		const plan = resolveRuntimePlan(
			{ model: "other/sparse" },
			{},
			parent,
			registry([model("fake", "parent"), sparse]),
		);
		assert.equal(plan.thinking, "high");
		assert.deepEqual(plan.thinkingAdjustment, {
			from: "medium",
			to: "high",
			reason: "inherited-clamp",
		});
	});

	it("clamps inherited thinking for a non-reasoning selected model", () => {
		const plain = model("other", "plain", { reasoning: false });
		const plan = resolveRuntimePlan(
			{ model: "other/plain" },
			{},
			parent,
			registry([model("fake", "parent"), plain]),
		);
		assert.equal(plan.thinking, "off");
		assert.equal(plan.thinkingSource, "parent");
		assert.deepEqual(plan.thinkingAdjustment, {
			from: "medium",
			to: "off",
			reason: "non-reasoning",
		});
	});
});

describe("authenticated model catalog", () => {
	it("lists exact authenticated IDs with concise capability facts", () => {
		const available = [
			model("fake", "parent", {
				input: ["text", "image"],
				contextWindow: 200_000,
			}),
			model("other", "plain", {
				reasoning: false,
				cost: { input: 0, output: 0 },
			}),
		];
		const catalog = buildAuthenticatedModelCatalog(registry(available));
		assert.match(catalog, /fake\/parent/);
		assert.match(catalog, /reasoning \(off\/minimal\/low\/medium\/high\)/);
		assert.match(catalog, /text\+image/);
		assert.match(catalog, /200k context/);
		assert.match(catalog, /other\/plain/);
		assert.match(catalog, /non-reasoning/);
		assert.match(
			catalog,
			/explicitly select an exact authenticated provider\/model-id by task tier first/,
		);
		assert.match(
			catalog,
			/For ordinary review, prefer a different authenticated model family/,
		);
		assert.match(
			catalog,
			/context-isolated/,
			"generic catalog must describe context-isolated same-family fallback",
		);
		assert.match(
			catalog,
			/inherits the parent runtime as a discouraged fallback/,
		);
	});

	it("renders authenticated configured shortlists in order with review guidance", () => {
		const entries = [
			model("fake", "parent"),
			model("other", "first"),
			model("other", "second"),
			model("other", "unauthed"),
		];
		const tasks = {
			coding: ["other/second", "other/unauthed", "other/first"],
			review: ["fake/parent"],
		};
		assert.deepEqual(
			getAuthenticatedTaskPreferences(registry(entries), tasks),
			{
				coding: ["other/second", "other/first"],
				review: ["fake/parent"],
			},
		);
		const catalog = buildAuthenticatedModelCatalog(
			registry(entries),
			24,
			tasks,
		);
		assert.match(catalog, /- coding: other\/second, other\/first/);
		assert.match(catalog, /- review: fake\/parent/);
		assert.doesNotMatch(catalog, /other\/unauthed/);
		assert.match(catalog, /The extension does not enforce this/);
		assert.match(
			catalog,
			/context-isolated/,
			"shortlist catalog must describe context-isolated same-family fallback",
		);
	});

	it("keeps generic tier guidance when shortlists are empty or unconfigured", () => {
		for (const tasks of [undefined, {}]) {
			const catalog = buildAuthenticatedModelCatalog(registry(), 24, tasks);
			assert.match(
				catalog,
				/explicitly select an exact authenticated provider\/model-id by task tier first/,
			);
			assert.doesNotMatch(catalog, /Task-category shortlists/);
		}
	});

	it("caps large catalogs and reports omitted models", () => {
		const available = Array.from({ length: 30 }, (_, index) =>
			model("fake", `model-${index}`),
		);
		const catalog = buildAuthenticatedModelCatalog(registry(available), 5);
		assert.equal((catalog.match(/^- fake\//gm) ?? []).length, 5);
		assert.match(catalog, /25 more authenticated models omitted/);
	});

	it("keeps ordinary fallback separate from strict orchestration guidance in both catalog branches", () => {
		const catalogs = [
			[
				"shortlist",
				buildAuthenticatedModelCatalog(registry(), 24, {
					coding: ["other/fast"],
				}),
			],
			["generic", buildAuthenticatedModelCatalog(registry())],
		] as const;
		for (const [label, catalog] of catalogs) {
			const compact = normalized(catalog);
			for (const clause of ordinaryReviewClauses)
				assert.ok(
					compact.includes(clause),
					`${label} catalog must include: ${clause}`,
				);
			assert.match(
				compact,
				/exact authenticated provider\/model-id/,
				`${label} catalog must require an exact authenticated provider/model-id`,
			);
		}

		const genericLines = catalogs[1][1].split("\n");
		const orchestratedLine = genericLines.find((line) =>
			line.startsWith("For orchestrated children"),
		);
		assert.ok(
			orchestratedLine,
			"generic catalog must include an orchestrated line",
		);
		assert.doesNotMatch(
			orchestratedLine,
			/ordinary|same-family|context-isolated/i,
			"generic catalog's orchestrated line must not embed ordinary-review fallback",
		);
		assert.ok(
			genericLines.some((line) => line.startsWith("For ordinary review")),
			"generic catalog must put ordinary-review guidance on a separate line",
		);
	});
});

describe("automatic runtime selection", () => {
	/** A physical model with a known API, as Pi's registry reports it. */
	const physical = (
		provider: string,
		id: string,
		overrides: Partial<RoutingModel> = {},
	) => model(provider, id, { api: "openai-completions", ...overrides });
	const physicalRegistry = (
		entries = [physical("fake", "parent"), physical("other", "fast")],
	) => registry(entries);
	const roleDefaults: RuntimeDefaults = {
		model: "fake/parent",
		thinking: "low",
		origin: { model: { source: "role" } },
	};

	it("records an exact approved tuple as auto and never as a request", () => {
		assert.deepEqual(
			resolveRuntimePlan(
				{ model: "other/fast", thinking: "high", source: "auto" },
				roleDefaults,
				parent,
				physicalRegistry(),
			),
			{
				provider: "other",
				modelId: "fast",
				model: "other/fast",
				thinking: "high",
				modelSource: "auto",
				thinkingSource: "auto",
				provenance: {
					version: 1,
					model: {
						source: "auto",
						replaced: { value: "fake/parent", source: "role" },
					},
					thinking: {
						source: "auto",
						replaced: { value: "low", source: "role" },
					},
				},
			},
		);
	});

	it("never falls back to role, configured, or parent values", () => {
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ thinking: "high", source: "auto" },
					roleDefaults,
					parent,
					physicalRegistry(),
				),
			/automatic model "" must be one exact provider\/model-id/,
		);
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "other/fast", source: "auto" },
					roleDefaults,
					parent,
					physicalRegistry(),
				),
			/automatic thinking "" must be one exact level/,
		);
	});

	it("rejects lists, task references, fuzzy, unknown, and unauthenticated models", () => {
		const entries = [physical("fake", "parent"), physical("other", "unauthed")];
		for (const [reference, reason] of [
			["other/fast, fake/parent", /must be one exact provider\/model-id/],
			["task:coding", /must be one exact provider\/model-id/],
			[" other/fast", /must be one exact provider\/model-id/],
			["fast", /must be one exact provider\/model-id/],
			["other/missing", /unknown model "other\/missing"/],
			["other/unauthed", /has no configured authentication/],
		] as const)
			assert.throws(
				() =>
					resolveRuntimePlans(
						{ model: reference, thinking: "high", source: "auto" },
						{},
						parent,
						registry(entries),
						{ coding: ["other/unauthed"] },
					),
				reason,
				reference,
			);
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: "fake/parent", thinking: "high", source: "auto" },
				{ model: "other/fast, fake/parent" },
				parent,
				physicalRegistry(),
			).map((plan) => [plan.model, plan.modelSource]),
			[["fake/parent", "auto"]],
		);
	});

	it("validates exact thinking and never clamps it", () => {
		const plain = physical("other", "plain", { reasoning: false });
		const sparse = physical("other", "sparse", {
			thinkingLevelMap: {
				off: "off",
				minimal: "minimal",
				low: "low",
				medium: null,
				high: "high",
			},
		});
		const entries = [physical("fake", "parent"), plain, sparse];
		for (const [reference, thinking] of [
			["other/plain", "high"],
			["other/sparse", "medium"],
		] as const)
			assert.throws(
				() =>
					resolveRuntimePlan(
						{ model: reference, thinking, source: "auto" },
						{},
						parent,
						registry(entries),
					),
				new RegExp(`thinking "${thinking}" is not supported`),
			);
		const off = resolveRuntimePlan(
			{ model: "other/plain", thinking: "off", source: "auto" },
			{},
			parent,
			registry(entries),
		);
		assert.equal(off.thinking, "off");
		assert.equal(off.thinkingAdjustment, undefined);
	});

	it("requires an exact registry identity and text input", () => {
		const imageOnly = physical("other", "vision", { input: ["image"] });
		const aliasing = wrapPiModelRegistry({
			find: (provider: string, id: string) =>
				provider === "other" && id.toLowerCase() === "fast"
					? physical("other", "fast")
					: undefined,
			getAvailable: () => [physical("other", "fast")],
			hasConfiguredAuth: () => true,
		});
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "other/FAST", thinking: "high", source: "auto" },
					{},
					parent,
					aliasing,
				),
			/an exact registry identity is required/,
		);
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "other/vision", thinking: "high", source: "auto" },
					{},
					parent,
					registry([physical("fake", "parent"), imageOnly]),
				),
			/does not accept text input/,
		);
	});

	it("rejects virtual routing and unknown-API models while manual routing keeps them", () => {
		const entries = [
			physical("fake", "parent"),
			model("router", "auto-1", { api: "pi-virtual" }),
			model("other", "bare"),
		];
		const pi = registry(entries);
		assert.equal(pi.find("router", "auto-1")?.api, "pi-virtual");
		assert.equal(pi.find("other", "bare")?.api, undefined);
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "router/auto-1", thinking: "high", source: "auto" },
					{},
					parent,
					pi,
				),
			/"router\/auto-1" is a virtual routing model; an exact physical model is required/,
		);
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "other/bare", thinking: "high", source: "auto" },
					{},
					parent,
					pi,
				),
			/"other\/bare" has no known model API/,
		);
		// Manual selections keep routing through virtual models unchanged.
		const manual = resolveRuntimePlan(
			{ model: "router/auto-1", thinking: "high" },
			{},
			parent,
			pi,
		);
		assert.equal(manual.model, "router/auto-1");
		assert.equal(manual.modelSource, "request");
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: "router/auto-1, other/bare" },
				{},
				parent,
				pi,
			).map((plan) => plan.model),
			["router/auto-1", "other/bare"],
		);
	});

	it("tags a replaced value with its harness when another harness runs", () => {
		const plan = resolveRuntimePlan(
			{ model: "other/fast", thinking: "high", source: "auto" },
			{
				model: "opus",
				thinking: "low",
				origin: {
					model: { source: "role", harness: "claude" },
					thinking: { source: "role", harness: "claude" },
				},
			},
			parent,
			physicalRegistry(),
		);
		assert.equal(plan.model, "other/fast");
		assert.deepEqual(plan.provenance, {
			version: 1,
			model: {
				source: "auto",
				replaced: { value: "opus", source: "role", harness: "claude" },
			},
			thinking: {
				source: "auto",
				replaced: { value: "low", source: "role", harness: "claude" },
			},
		});
	});
});

describe("canonical runtime provenance", () => {
	it("omits provenance when the caller cannot tell role and configured defaults apart", () => {
		assert.equal(resolve().provenance, undefined);
		assert.equal(resolve({}, { model: "other/fast" }).provenance, undefined);
	});

	it("distinguishes a role value from a configured default behind the legacy agent source", () => {
		const fromRole = resolve(
			{},
			{
				model: "other/fast",
				thinking: "low",
				origin: { model: { source: "role" } },
			},
		);
		assert.equal(fromRole.modelSource, "agent");
		assert.equal(fromRole.thinkingSource, "agent");
		assert.equal(fromRole.requestedModel, "other/fast");
		assert.equal(fromRole.requestedThinking, "low");
		assert.deepEqual(fromRole.provenance, {
			version: 1,
			model: { source: "role" },
			thinking: { source: "role" },
		});

		const fromConfig = resolve(
			{},
			{
				model: "other/fast",
				origin: {
					model: { source: "default", defaultKey: "models.agents.scout" },
				},
			},
		);
		assert.equal(fromConfig.modelSource, "agent");
		assert.deepEqual(fromConfig.provenance, {
			version: 1,
			model: { source: "default", defaultKey: "models.agents.scout" },
			thinking: { source: "parent" },
		});
	});

	it("records request and parent origins and keeps them on every fallback", () => {
		assert.deepEqual(
			resolve(
				{ model: "other/fast", thinking: "high" },
				{
					model: "fake/parent",
					origin: { model: { source: "role" } },
				},
			).provenance,
			{
				version: 1,
				model: { source: "request" },
				thinking: { source: "request" },
			},
		);
		assert.deepEqual(resolve({}, { origin: { model: undefined } }).provenance, {
			version: 1,
			model: { source: "parent" },
			thinking: { source: "parent" },
		});
		const configured: RuntimeDefaults = {
			model: "other/fast, fake/parent",
			origin: { model: { source: "default", defaultKey: "models.default" } },
		};
		assert.deepEqual(
			resolveRuntimePlans({}, configured, parent, registry()).map(
				(plan) => plan.provenance?.model,
			),
			[
				{ source: "default", defaultKey: "models.default" },
				{ source: "default", defaultKey: "models.default" },
			],
		);
	});
});
