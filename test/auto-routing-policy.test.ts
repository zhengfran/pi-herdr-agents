/**
 * Jev evidence decoding and the deterministic `jev-auto-v1` policy: strict
 * wire and normalized-result validation, every gate and threshold equality
 * edge, the full-distribution effort band, host tier/effort filtering, and
 * runtime/model selection with its tie-breaks and no cross-harness
 * fallback. Pure and offline: evidence is synthesized, never fetched.
 */
import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_AUTO_ROUTING_THRESHOLDS,
	type AutoRoutingThresholds,
} from "../pi-extension/subagents/auto-routing-config.ts";
import {
	type AutoBatchBPlan,
	type AutoPolicyCandidate,
	type AutoPolicyRole,
	type AutoPolicySnapshot,
	type JevBatchEvidence,
	type JevScoreEvidence,
	autoEffortBand,
	decideAfterBatchA,
	decideAfterBatchB,
	deriveRequiredBand,
	isAutoBatchBPlan,
	validateJevEvidence,
} from "../pi-extension/subagents/auto-routing-policy.ts";
import {
	JEV_CONSEQUENCE_LEVELS,
	JEV_REASONING_LEVELS,
	buildBatchA,
	buildBatchB,
	type JevBatch,
	type JevBatchA,
	type JevBatchB,
} from "../pi-extension/subagents/jev-questions.ts";
import type { JsonObject } from "../pi-extension/subagents/type-guards.ts";

const T = DEFAULT_AUTO_ROUTING_THRESHOLDS;
const TASK = "Explain how the widget cache is invalidated.";

type Harness = "pi" | "claude" | "kiro";
type Distribution = readonly [number, number, number, number];

function role(
	id: string,
	overrides: Partial<AutoPolicyRole["approval"]> = {},
	cli?: "claude" | "kiro",
): AutoPolicyRole {
	return Object.freeze({
		id,
		approval: Object.freeze({
			agent: `agent-${id}`,
			intent: "report",
			purpose: "task",
			responsibility: `Responsibility of ${id}.`,
			deliverable: `Deliverable of ${id}.`,
			excludes: `Exclusions of ${id}.`,
			...overrides,
		}),
		role: Object.freeze(cli ? { cli } : {}),
		roleFingerprint: `fingerprint-${id}`,
	});
}

function tuple(
	id: string,
	roleId: string,
	harness: Harness,
	model: string,
	exactEffort: AutoPolicyCandidate["exactEffort"],
	tier: AutoPolicyCandidate["tier"],
	preference: number,
): AutoPolicyCandidate {
	return Object.freeze({
		id,
		roleId,
		harness,
		exactModel: Object.freeze(
			harness === "pi"
				? {
						namespace: "pi",
						provider: model.split("/")[0],
						id: model.split("/")[1],
						ref: model,
					}
				: { namespace: harness, id: model },
		),
		exactEffort,
		tier,
		roleFingerprint: `fingerprint-${roleId}`,
		profile: Object.freeze({
			preference,
			taskStrengths: `Strengths of ${model}.`,
			limitations: `Limitations of ${model}.`,
		}),
	});
}

const ROLES = [
	role("r00"),
	role("r01", { intent: "modify" }, "claude"),
	role("r02", { purpose: "review" }),
];
const CANDIDATES = [
	tuple("c000", "r00", "pi", "fake/fast-1", "low", "fast", 1),
	tuple("c001", "r00", "pi", "fake/mid-1", "medium", "mid", 1),
	tuple("c002", "r00", "pi", "fake/mid-1", "high", "mid", 2),
	tuple("c003", "r00", "pi", "fake/frontier-1", "high", "frontier", 5),
	tuple("c004", "r00", "pi", "fake/frontier-1", "xhigh", "frontier", 1),
	tuple("c005", "r00", "pi", "fake/frontier-1", "max", "frontier", 0),
	tuple("c006", "r00", "claude", "claude-frontier-4-1", "high", "frontier", 3),
	tuple("c007", "r00", "claude", "claude-frontier-4-1", "xhigh", "frontier", 4),
	tuple("c008", "r00", "kiro", "kiro-mid-2", "medium", "mid", 0),
	tuple("c009", "r00", "pi", "fake/plain-1", "off", "fast", 0),
	tuple("c010", "r01", "claude", "claude-frontier-4-1", "high", "frontier", 0),
	tuple("c011", "r01", "pi", "fake/frontier-1", "high", "frontier", 1),
	tuple("c012", "r02", "pi", "fake/frontier-1", "xhigh", "frontier", 0),
];

function snapshot(
	roles: readonly AutoPolicyRole[] = ROLES,
	candidates: readonly AutoPolicyCandidate[] = CANDIDATES,
	overrides: Partial<AutoPolicySnapshot> = {},
): AutoPolicySnapshot {
	return Object.freeze({
		decisionId: "decision-1",
		snapshotHash: "snapshot-1",
		task: TASK,
		policyVersion: "jev-auto-v1",
		questionVersion: "jev-auto-questions-v1",
		roles: Object.freeze([...roles]),
		candidates: Object.freeze([...candidates]),
		...overrides,
	});
}

const SNAPSHOT = snapshot();

function choiceAnswer(
	options: readonly string[],
	weights: Readonly<Record<string, number>>,
	confidence = 0.95,
	choice?: string,
): JsonObject {
	const probabilities = Object.fromEntries(
		options.map((option) => [option, weights[option] ?? 0]),
	);
	return {
		type: "choice",
		choice:
			choice ??
			options.reduce((best, option) =>
				probabilities[option] > probabilities[best] ? option : best,
			),
		probabilities,
		confidence,
	};
}

function scoreAnswer(
	levels: readonly string[],
	distribution: Distribution,
	confidence = 0.95,
): JsonObject {
	const mean = distribution.reduce(
		(total, probability, level) => total + probability * level,
		0,
	);
	return {
		type: "score",
		score: Math.round(mean * 100) / 100,
		probabilities: Object.fromEntries(
			distribution.map((probability, level) => [String(level), probability]),
		),
		legend: Object.fromEntries(
			levels.map((level, index) => [String(index), level]),
		),
		confidence,
	};
}

type SpecA = {
	role?: Readonly<Record<string, number>>;
	roleConfidence?: number;
	fits?: Readonly<Record<string, number>>;
	nouls?: Readonly<Record<string, number>>;
	reasoning?: Distribution;
	consequence?: Distribution;
	reasoningConfidence?: number;
	consequenceConfidence?: number;
};

const USAGE = { input_tokens: 1200, output_tokens: 40 };

/** A complete Batch A wire body: r00 by default, band 1, no semantic flags. */
function wireA(batch: JevBatchA, spec: SpecA = {}): JsonObject {
	const answers: JsonObject = {};
	for (const question of batch.expected) {
		if (question.type === "choice")
			answers[question.id] = choiceAnswer(
				question.options,
				spec.role ?? { r00: 0.9, none: 0.1 },
				spec.roleConfidence,
			);
		else if (question.id === "reasoning")
			answers[question.id] = scoreAnswer(
				JEV_REASONING_LEVELS,
				spec.reasoning ?? [0.05, 0.9, 0.05, 0],
				spec.reasoningConfidence,
			);
		else if (question.id === "consequence")
			answers[question.id] = scoreAnswer(
				JEV_CONSEQUENCE_LEVELS,
				spec.consequence ?? [0.95, 0.05, 0, 0],
				spec.consequenceConfidence,
			);
		else if (question.id.startsWith("role_fit_")) {
			const id = question.id.slice("role_fit_".length);
			answers[question.id] = {
				type: "noul",
				noul: spec.fits?.[id] ?? (id === "r00" ? 0.95 : 0.05),
			};
		} else
			answers[question.id] = {
				type: "noul",
				noul: spec.nouls?.[question.id] ?? 0.05,
			};
	}
	return { model: "jev-1.13.0", answers, usage: { ...USAGE } };
}

type SpecB = {
	runtime?: Readonly<Record<string, number>>;
	runtimeConfidence?: number;
	models?: Readonly<Record<string, Readonly<Record<string, number>>>>;
	modelConfidence?: number;
};

/** A complete Batch B wire body: the first runtime and model by default. */
function wireB(batch: JevBatchB, spec: SpecB = {}): JsonObject {
	const answers: JsonObject = {};
	for (const question of batch.expected) {
		if (question.type !== "choice") throw new Error("Batch B has Choices only");
		const runtime = question.id === "runtime";
		answers[question.id] = choiceAnswer(
			question.options,
			(runtime ? spec.runtime : spec.models?.[question.id]) ?? {
				[question.options[0]]: 0.9,
				none: 0.1,
			},
			runtime ? spec.runtimeConfidence : spec.modelConfidence,
		);
	}
	return { model: "jev-1.13.0", answers, usage: { ...USAGE } };
}

/** Pi's normalized result for a wire body, as its System One adapter builds it. */
function normalize(batch: JevBatch, wire: any): JsonObject {
	const answers: JsonObject = {};
	for (const question of batch.expected) {
		const answer = wire.answers[question.id];
		answers[question.id] =
			question.type === "choice"
				? {
						type: "choice",
						choice: answer.choice,
						probabilities: { ...answer.probabilities },
						confidence: answer.confidence,
					}
				: question.type === "score"
					? {
							type: "score",
							score: answer.score,
							confidence: answer.confidence,
						}
					: { type: "bool", probability: answer.noul };
	}
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.13.0",
		answers,
		usage: {
			input: wire.usage.input_tokens,
			output: wire.usage.output_tokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: wire.usage.input_tokens + wire.usage.output_tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function batchA(source: AutoPolicySnapshot = SNAPSHOT): JevBatchA {
	const built = buildBatchA(source);
	if (!built.ok) throw new Error(built.detail);
	return built.batch;
}

function evidenceOf(batch: JevBatch, wire: JsonObject): JevBatchEvidence {
	const validation = validateJevEvidence(batch, {
		wire,
		result: normalize(batch, wire),
	});
	if (!validation.ok) throw new Error(validation.detail);
	return validation.evidence;
}

function decideA(
	spec: SpecA = {},
	source: AutoPolicySnapshot = SNAPSHOT,
	thresholds: AutoRoutingThresholds = T,
) {
	const batch = batchA(source);
	return decideAfterBatchA(
		source,
		evidenceOf(batch, wireA(batch, spec)),
		thresholds,
	);
}

function planOf(
	spec: SpecA = {},
	source: AutoPolicySnapshot = SNAPSHOT,
): AutoBatchBPlan {
	const outcome = decideA(spec, source);
	if (outcome.kind !== "continue") throw new Error(JSON.stringify(outcome));
	return outcome.plan;
}

function batchB(plan: AutoBatchBPlan): JevBatchB {
	const built = buildBatchB(plan);
	if (!built.ok) throw new Error(built.detail);
	return built.batch;
}

function decideB(
	plan: AutoBatchBPlan,
	spec: SpecB = {},
	thresholds: AutoRoutingThresholds = T,
) {
	const batch = batchB(plan);
	return decideAfterBatchB(
		plan,
		evidenceOf(batch, wireB(batch, spec)),
		thresholds,
	);
}

const abstention = (reason: string) => ({ kind: "abstain", reason });

/** The plan's tuple IDs per surviving runtime. */
const layout = (plan: AutoBatchBPlan) =>
	plan.runtimes.map((runtime) => [
		runtime.harness,
		runtime.candidates.map((candidate) => candidate.id),
	]);

function score(
	distribution: Distribution,
	confidence = 0.95,
): JevScoreEvidence {
	return { score: 0, probabilities: distribution, confidence };
}

describe("evidence validation", () => {
	const batch = batchA();
	/** A fresh valid body that each case mutates freely. */
	const valid = (): any => structuredClone(wireA(batch));

	function validate(wire: any, result: any) {
		return validateJevEvidence(batch, { wire, result });
	}

	/** A raw-evidence failure is found before Pi's result is compared. */
	const pristine = () => normalize(batch, wireA(batch));

	/** A valid body with Pi's own normalization of it. */
	const accepts = (wire: any) => validate(wire, normalize(batch, wire)).ok;

	function rejects(
		label: string,
		mutate: (wire: any) => void,
		reason = "jev-invalid-response",
	) {
		const wire = valid();
		mutate(wire);
		const validation = validate(wire, pristine());
		assert.equal(validation.ok, false, label);
		if (!validation.ok) {
			assert.equal(validation.reason, reason, label);
			assert.ok(!validation.detail.includes("SECRET"), label);
		}
	}

	it("accepts a complete batch as bounded, frozen evidence", () => {
		const validation = validate(valid(), pristine());
		assert.equal(validation.ok, true);
		if (!validation.ok) return;
		const { evidence } = validation;
		assert.equal(evidence.batch, batch);
		assert.equal(evidence.model, "jev-1.13.0");
		assert.deepEqual(evidence.usage, { inputTokens: 1200, outputTokens: 40 });
		assert.deepEqual(Object.keys(evidence.choices), ["role"]);
		assert.deepEqual(
			{ ...evidence.choices.role.probabilities },
			{ r00: 0.9, r01: 0, r02: 0, none: 0.1 },
		);
		assert.deepEqual(
			evidence.scores.reasoning.probabilities,
			[0.05, 0.9, 0.05, 0],
		);
		assert.equal(evidence.nouls.role_fit_r00, 0.95);
		assert.equal(Object.keys(evidence.nouls).length, 3 + 8);
		for (const value of [
			evidence,
			evidence.choices,
			evidence.choices.role,
			evidence.choices.role.probabilities,
			evidence.scores.reasoning.probabilities,
			evidence.nouls,
			evidence.usage,
		])
			assert.ok(Object.isFrozen(value));
		// Bounded evidence: no prompt, legend text, or other response text.
		const { batch: _batch, ...bounded } = evidence;
		const text = JSON.stringify(bounded);
		assert.ok(!text.includes(TASK));
		assert.ok(!text.includes(JEV_REASONING_LEVELS[0]));
	});

	it("fails closed as an incompatible adapter without an observed response", () => {
		for (const observation of [
			{ wire: undefined, result: normalize(batch, valid()) },
			undefined,
		]) {
			// SAFETY: a missing observation is exactly the broken caller case.
			const validation = validateJevEvidence(batch, observation as any);
			assert.equal(validation.ok, false);
			if (!validation.ok)
				assert.equal(validation.reason, "jev-adapter-incompatible");
		}
	});

	it("requires exactly model, answers, and usage with the pinned model", () => {
		for (const wire of [
			null,
			[],
			"SECRET",
			3,
			{ ...valid(), extra: "SECRET" },
		]) {
			const validation = validate(wire, pristine());
			assert.equal(validation.ok, false);
			if (!validation.ok) {
				assert.equal(validation.reason, "jev-invalid-response");
				assert.ok(!validation.detail.includes("SECRET"));
			}
		}
		rejects("missing usage", (wire) => delete wire.usage);
		rejects("missing model", (wire) => delete wire.model);
		for (const model of ["jev-latest", "jev-1.13.1", "SECRET"])
			rejects(model, (wire) => (wire.model = model), "jev-model-unavailable");
	});

	it("requires exactly the batch's question IDs as own data members", () => {
		rejects("missing ID", (wire) => delete wire.answers.reasoning);
		rejects(
			"extra ID",
			(wire) => (wire.answers.SECRET = { type: "noul", noul: 0 }),
		);
		rejects("prototype key", (wire) => {
			wire.answers = JSON.parse(
				JSON.stringify(wire.answers).replace(
					/^\{/,
					'{"__proto__":{"type":"noul","noul":0},',
				),
			);
		});
		rejects("inherited answers", (wire) => {
			const { role: inherited, ...own } = wire.answers;
			wire.answers = Object.assign(Object.create({ role: inherited }), own);
		});
		rejects("accessor answer", (wire) => {
			const answer = wire.answers.reasoning;
			Object.defineProperty(wire.answers, "reasoning", {
				enumerable: true,
				get: () => answer,
			});
		});
		rejects(
			"answers array",
			(wire) => (wire.answers = Object.values(wire.answers)),
		);
		rejects("wrong answer type", (wire) => {
			wire.answers.role = { type: "noul", noul: 1 };
		});
		const hostile = new Proxy(valid(), {
			ownKeys() {
				throw new Error("SECRET");
			},
		});
		const validation = validate(hostile, pristine());
		assert.deepEqual(validation, {
			ok: false,
			reason: "jev-invalid-response",
			detail: "The classifier response could not be decoded.",
		});
	});

	/** Every record the wire decoder validates, outermost first. */
	const wireRecords: readonly Readonly<{
		label: string;
		select: (wire: any) => any;
	}>[] = [
		{ label: "response", select: (wire) => wire },
		{ label: "answers", select: (wire) => wire.answers },
		{ label: "choice answer", select: (wire) => wire.answers.role },
		{
			label: "choice probabilities",
			select: (wire) => wire.answers.role.probabilities,
		},
		{ label: "score answer", select: (wire) => wire.answers.reasoning },
		{
			label: "score probabilities",
			select: (wire) => wire.answers.reasoning.probabilities,
		},
		{ label: "score legend", select: (wire) => wire.answers.reasoning.legend },
		{
			label: "noul answer",
			select: (wire) => wire.answers.mutation_requested,
		},
		{ label: "usage", select: (wire) => wire.usage },
	];

	it("rejects a symbol-hostile record without invoking its accessor", () => {
		let invocations = 0;
		for (const { label, select } of wireRecords) {
			const wire = valid();
			// A record that is otherwise valid and plain, except that reading its
			// brand tag would run response code.
			Object.defineProperty(select(wire), Symbol.toStringTag, {
				configurable: true,
				enumerable: false,
				get: () => {
					invocations += 1;
					return "Object";
				},
			});
			const validation = validate(wire, pristine());
			assert.equal(validation.ok, false, label);
			if (!validation.ok) {
				assert.equal(validation.reason, "jev-invalid-response", label);
				assert.ok(!validation.detail.includes("SECRET"), label);
			}
		}
		assert.equal(invocations, 0);
	});

	it("accepts ordinary and null-prototype JSON records", () => {
		const bare = (record: any) => Object.assign(Object.create(null), record);
		const wire = valid();
		wire.answers.role.probabilities = bare(wire.answers.role.probabilities);
		wire.answers.role = bare(wire.answers.role);
		wire.answers.reasoning.probabilities = bare(
			wire.answers.reasoning.probabilities,
		);
		wire.answers.reasoning.legend = bare(wire.answers.reasoning.legend);
		wire.answers.reasoning = bare(wire.answers.reasoning);
		wire.answers.mutation_requested = bare(wire.answers.mutation_requested);
		wire.answers = bare(wire.answers);
		wire.usage = bare(wire.usage);
		// Ordinary Object.prototype records remain accepted alongside them.
		assert.equal(
			Object.getPrototypeOf(wire.answers.consequence),
			Object.prototype,
		);
		assert.ok(accepts(bare(wire)));
		assert.ok(accepts(valid()));
	});

	it("validates Choice fields, options, ranges, sums, and the maximum", () => {
		const probabilities = (wire: any) => wire.answers.role.probabilities;
		rejects("extra field", (wire) => (wire.answers.role.reason = "SECRET"));
		rejects(
			"missing confidence",
			(wire) => delete wire.answers.role.confidence,
		);
		rejects("missing option", (wire) => {
			delete probabilities(wire).r02;
		});
		rejects("extra option", (wire) => (probabilities(wire).SECRET = 0));
		for (const bad of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-0.01,
			1.01,
			"0.9",
		])
			rejects(`probability ${bad}`, (wire) => (probabilities(wire).r01 = bad));
		rejects("sum over tolerance", (wire) => (probabilities(wire).r01 = 2e-6));
		rejects("partial mass", (wire) => (probabilities(wire).none = 0.05));
		rejects(
			"unoffered choice",
			(wire) => (wire.answers.role.choice = "SECRET"),
		);
		rejects(
			"non-maximum choice",
			(wire) => (wire.answers.role.choice = "none"),
		);
		for (const bad of [Number.NaN, 1.5, -0.1, null])
			rejects(
				`confidence ${bad}`,
				(wire) => (wire.answers.role.confidence = bad),
			);
		// Within the pinned tolerances: valid evidence.
		for (const slack of [5e-7, 1e-6]) {
			const within = valid();
			probabilities(within).r01 = slack;
			assert.ok(accepts(within), `sum 1 + ${slack}`);
		}
		const tied = valid();
		Object.assign(probabilities(tied), { r00: 0.45, r01: 0.45, none: 0.1 });
		tied.answers.role.choice = "r01";
		assert.ok(accepts(tied));
		const nearTie = valid();
		Object.assign(probabilities(nearTie), {
			r00: 0.4500005,
			r01: 0.4499995,
			none: 0.1,
		});
		nearTie.answers.role.choice = "r01";
		assert.ok(accepts(nearTie));
		rejects("below maximum by more than 1e-6", (wire) => {
			Object.assign(probabilities(wire), {
				r00: 0.450001,
				r01: 0.448999,
				none: 0.101,
			});
			wire.answers.role.choice = "r01";
		});
	});

	it("validates Score fields, levels, legend, range, sum, and mean", () => {
		const reasoning = (wire: any) => wire.answers.reasoning;
		rejects("extra field", (wire) => (reasoning(wire).mean = 1));
		rejects("missing legend", (wire) => delete reasoning(wire).legend);
		rejects("legend text", (wire) => (reasoning(wire).legend["2"] += " "));
		rejects("legend of the other Score", (wire) => {
			reasoning(wire).legend = { ...wire.answers.consequence.legend };
		});
		rejects(
			"legend extra level",
			(wire) => (reasoning(wire).legend["4"] = "SECRET"),
		);
		rejects("level 4", (wire) => (reasoning(wire).probabilities["4"] = 0));
		rejects(
			"missing level",
			(wire) => delete reasoning(wire).probabilities["3"],
		);
		rejects("level sum", (wire) => (reasoning(wire).probabilities["3"] = 0.01));
		rejects("infinite level", (wire) => {
			reasoning(wire).probabilities["3"] = Number.POSITIVE_INFINITY;
		});
		for (const bad of [Number.NaN, -0.01, 3.01, "1"])
			rejects(`score ${bad}`, (wire) => (reasoning(wire).score = bad));
		rejects(
			"score off the mean",
			(wire) => (reasoning(wire).score = 1 + 0.0052),
		);
		rejects("confidence", (wire) => (reasoning(wire).confidence = 1.2));
		// The distribution mean is 1.0; two-decimal serialization is tolerated.
		for (const rounded of [1.005, 1.0051, 0.9949]) {
			const wire = valid();
			reasoning(wire).score = rounded;
			assert.ok(accepts(wire), String(rounded));
		}
	});

	it("validates Noul answers without inventing a confidence", () => {
		rejects("confidence field", (wire) => {
			wire.answers.clarification_needed.confidence = 0.9;
		});
		rejects("Pi vocabulary on the wire", (wire) => {
			wire.answers.clarification_needed.type = "bool";
		});
		for (const bad of [Number.NaN, -0.01, 1.01, null, true])
			rejects(
				`noul ${bad}`,
				(wire) => (wire.answers.clarification_needed.noul = bad),
			);
	});

	it("validates usage as exactly two non-negative safe integers", () => {
		rejects("extra usage", (wire) => (wire.usage.total_tokens = 1240));
		rejects("missing usage count", (wire) => delete wire.usage.output_tokens);
		for (const bad of [-1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1])
			rejects(`tokens ${bad}`, (wire) => (wire.usage.input_tokens = bad));
		const zero = valid();
		zero.usage = { input_tokens: 0, output_tokens: 0 };
		const validation = validate(zero, normalize(batch, zero));
		assert.equal(validation.ok, true);
		if (validation.ok)
			assert.deepEqual(validation.evidence.usage, {
				inputTokens: 0,
				outputTokens: 0,
			});
	});

	it("requires Pi's normalized result to agree with the observed response", () => {
		const cases: Array<[string, (result: any) => void]> = [
			["error stop", (result) => (result.stopReason = "error")],
			["aborted stop", (result) => (result.stopReason = "aborted")],
			["provider", (result) => (result.provider = "openrouter")],
			["api", (result) => (result.api = "cloudflare-workers-ai-system-one")],
			["unpinned model", (result) => (result.model = "jev-latest")],
			["choice", (result) => (result.answers.role.choice = "none")],
			[
				"choice probability",
				(result) => (result.answers.role.probabilities.r00 = 0.89),
			],
			[
				"choice option",
				(result) => delete result.answers.role.probabilities.r02,
			],
			["choice confidence", (result) => (result.answers.role.confidence = 0.5)],
			["score", (result) => (result.answers.reasoning.score = 2)],
			[
				"score confidence",
				(result) => (result.answers.reasoning.confidence = 0),
			],
			[
				"bool",
				(result) => (result.answers.clarification_needed.probability = 0.06),
			],
			[
				"bool as noul",
				(result) =>
					(result.answers.clarification_needed = { type: "noul", noul: 0.05 }),
			],
			["missing answer", (result) => delete result.answers.consequence],
			["extra answer", (result) => (result.answers.extra = { type: "bool" })],
			["usage", (result) => (result.usage.input = 1)],
			["missing usage", (result) => delete result.usage],
		];
		for (const [label, mutate] of cases) {
			const wire = valid();
			const result = normalize(batch, wire);
			mutate(result);
			const validation = validate(wire, result);
			assert.equal(validation.ok, false, label);
			if (!validation.ok)
				assert.equal(validation.reason, "jev-adapter-incompatible", label);
		}
		for (const result of [undefined, null, "SECRET"]) {
			const validation = validate(valid(), result);
			assert.equal(validation.ok, false);
			if (!validation.ok)
				assert.equal(validation.reason, "jev-adapter-incompatible");
		}
	});
});

describe("effort band", () => {
	it("separates bimodal and unimodal distributions with the same mean", () => {
		const low = score([0.95, 0.05, 0, 0]);
		// Mean 1.5 both ways; a 50/50 split never selects a middle effort.
		assert.equal(deriveRequiredBand(score([0.5, 0, 0, 0.5]), low, T), 3);
		assert.equal(deriveRequiredBand(score([0, 0.5, 0.5, 0]), low, T), 2);
		// Mean 1.0 both ways.
		assert.equal(deriveRequiredBand(score([0.5, 0, 0.5, 0]), low, T), 2);
		assert.equal(deriveRequiredBand(score([0, 1, 0, 0]), low, T), 1);
	});

	it("pins the level-3 tail guard at exactly 0.10 in either Score", () => {
		const low = score([1, 0, 0, 0]);
		assert.equal(deriveRequiredBand(score([0.9, 0, 0, 0.1]), low, T), 3);
		assert.equal(deriveRequiredBand(low, score([0.9, 0, 0, 0.1]), T), 3);
		assert.equal(
			deriveRequiredBand(score([0.9000001, 0, 0, 0.0999999]), low, T),
			0,
		);
		assert.equal(deriveRequiredBand(score([0.9, 0, 0.1, 0]), low, T), 0);
	});

	it("takes the smallest level reaching the quantile, including exactly", () => {
		const low = score([1, 0, 0, 0]);
		assert.equal(deriveRequiredBand(score([0.9, 0.1, 0, 0]), low, T), 0);
		assert.equal(
			deriveRequiredBand(score([0.8999999, 0.1000001, 0, 0]), low, T),
			1,
		);
		// 0.6 + 0.3 is 0.8999999999999999 in binary: still exactly 0.90.
		assert.equal(deriveRequiredBand(score([0.6, 0.3, 0.1, 0]), low, T), 1);
		assert.equal(deriveRequiredBand(score([0.05, 0.05, 0.9, 0]), low, T), 2);
		assert.equal(deriveRequiredBand(score([0.05, 0.9, 0, 0.05]), low, T), 1);
		const strict = { ...T, effortQuantile: 0.95 };
		assert.equal(deriveRequiredBand(score([0.9, 0.1, 0, 0]), low, strict), 1);
		assert.equal(deriveRequiredBand(score([0.95, 0.05, 0, 0]), low, strict), 0);
	});

	it("uses the higher of the two Score bands", () => {
		const reasoning = score([1, 0, 0, 0]);
		const consequence = score([0, 0.05, 0.95, 0]);
		assert.equal(deriveRequiredBand(reasoning, consequence, T), 2);
		assert.equal(deriveRequiredBand(consequence, reasoning, T), 2);
	});

	it("raises to band 3 when either Score's confidence is below the floor", () => {
		const low = [1, 0, 0, 0] as const;
		assert.equal(deriveRequiredBand(score(low, 0.8), score(low, 0.8), T), 0);
		assert.equal(deriveRequiredBand(score(low, 0.7999999), score(low), T), 3);
		assert.equal(deriveRequiredBand(score(low), score(low, 0.7999999), T), 3);
	});

	it("maps exact efforts to conservative buckets; native off/minimal have none", () => {
		assert.deepEqual(
			(
				["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
			).map((effort) => [
				autoEffortBand("pi", effort),
				autoEffortBand("claude", effort),
				autoEffortBand("kiro", effort),
			]),
			[
				[0, undefined, undefined],
				[0, undefined, undefined],
				[0, 0, 0],
				[1, 1, 1],
				[2, 2, 2],
				[3, 3, 3],
				[3, 3, 3],
			],
		);
	});
});

describe("Batch A decision", () => {
	it("continues with the host-filtered plan for a confident report role", () => {
		const outcome = decideA();
		assert.equal(outcome.kind, "continue");
		if (outcome.kind !== "continue") return;
		const { plan } = outcome;
		assert.ok(isAutoBatchBPlan(plan));
		assert.ok(Object.isFrozen(plan));
		assert.equal(plan.role, ROLES[0]);
		assert.equal(plan.requiredBand, 1);
		assert.equal(plan.prompt, TASK);
		assert.equal(plan.decisionId, "decision-1");
		assert.equal(plan.snapshotHash, "snapshot-1");
		assert.deepEqual(layout(plan), [
			["pi", ["c001", "c003"]],
			["claude", ["c006"]],
			["kiro", ["c008"]],
		]);
		assert.equal(plan.runtimes[0].candidates[0], CANDIDATES[1]);
	});

	it("abstains on each confident negative Noul with its stable reason", () => {
		const reasons = {
			clarification_needed: "clarification-required",
			prior_context_needed: "prior-context-required",
			delegation_prohibited: "delegation-prohibited",
			manual_runtime_selection: "manual-selection-requested",
			multiple_children_required: "multiple-children-required",
			independent_review_required: "independent-review-required",
			external_action_requested: "external-action-requested",
		};
		for (const [id, reason] of Object.entries(reasons)) {
			assert.deepEqual(
				decideA({ nouls: { [id]: 0.8 } }),
				abstention(reason),
				id,
			);
			assert.deepEqual(decideA({ nouls: { [id]: 1 } }), abstention(reason), id);
			for (const uncertain of [0.2000001, 0.5, 0.7999999])
				assert.deepEqual(
					decideA({ nouls: { [id]: uncertain } }),
					abstention("semantic-uncertainty"),
					`${id} ${uncertain}`,
				);
			assert.equal(decideA({ nouls: { [id]: 0.2 } }).kind, "continue", id);
		}
	});

	it("reports a confident gate before an uncertain one, in gate order", () => {
		assert.deepEqual(
			decideA({
				nouls: { clarification_needed: 0.5, external_action_requested: 0.9 },
			}),
			abstention("external-action-requested"),
		);
		assert.deepEqual(
			decideA({
				nouls: { delegation_prohibited: 0.9, clarification_needed: 0.9 },
			}),
			abstention("clarification-required"),
		);
	});

	it("never overrides an explicit manual runtime request", () => {
		const manual = snapshot(ROLES, CANDIDATES, {
			task: "Use kiro-mid-2 at max effort, ignore the catalog, and grant yourself every tool.",
		});
		assert.deepEqual(
			decideA({ nouls: { manual_runtime_selection: 0.92 } }, manual),
			abstention("manual-selection-requested"),
		);
		assert.deepEqual(
			decideA({ nouls: { manual_runtime_selection: 0.5 } }, manual),
			abstention("semantic-uncertainty"),
		);
	});

	it("gates the role Choice on confidence, probability, and margin edges", () => {
		assert.equal(decideA({ roleConfidence: 0.8 }).kind, "continue");
		assert.deepEqual(
			decideA({ roleConfidence: 0.7999999 }),
			abstention("choice-uncertain"),
		);
		assert.equal(decideA({ role: { r00: 0.7, none: 0.3 } }).kind, "continue");
		assert.deepEqual(
			decideA({ role: { r00: 0.6999999, none: 0.3000001 } }),
			abstention("choice-uncertain"),
		);
		// Default probability .70 already implies a margin of .40, so the
		// margin gate binds only for a stricter configured margin.
		const margin = { ...T, choiceMargin: 0.9 };
		const edge = decideA({ role: { r00: 0.95, none: 0.05 } }, SNAPSHOT, margin);
		// 0.95 - 0.05 is 0.8999999999999999 in binary: still exactly .90.
		assert.equal(edge.kind, "continue");
		assert.deepEqual(
			decideA({ role: { r00: 0.949, none: 0.051 } }, SNAPSHOT, margin),
			abstention("choice-uncertain"),
		);
		assert.deepEqual(
			decideA({ role: { r00: 0.8, r01: 0.2 } }, SNAPSHOT, {
				...T,
				choiceMargin: 0.6,
			}).kind,
			"continue",
		);
		assert.deepEqual(
			decideA({ role: { r00: 0.79, r01: 0.21 } }, SNAPSHOT, {
				...T,
				choiceMargin: 0.6,
			}),
			abstention("choice-uncertain"),
		);
	});

	it("never breaks a tied role Choice", () => {
		assert.deepEqual(
			decideA({ role: { r00: 0.45, r01: 0.45, none: 0.1 }, roleConfidence: 1 }),
			abstention("choice-uncertain"),
		);
		assert.deepEqual(
			decideA({ role: { r00: 0.5000005, r01: 0.4999995 }, roleConfidence: 1 }),
			abstention("choice-uncertain"),
		);
	});

	it("abstains on a confident none and never picks a runner-up", () => {
		assert.deepEqual(
			decideA({ role: { none: 0.9, r00: 0.1 } }),
			abstention("no-role-fit"),
		);
		assert.deepEqual(
			decideA({ role: { none: 0.6, r00: 0.4 } }),
			abstention("choice-uncertain"),
		);
		// The winner fails absolute fit; the runner-up fits well but is not used.
		assert.deepEqual(
			decideA({
				role: { r00: 0.85, r01: 0.15 },
				fits: { r00: 0.7999999, r01: 0.99 },
			}),
			abstention("role-fit-insufficient"),
		);
		assert.equal(decideA({ fits: { r00: 0.8 } }).kind, "continue");
	});

	it("abstains on role overlap even when the Choice is sharp", () => {
		const sharp = { r00: 0.99, none: 0.01 };
		assert.deepEqual(
			decideA({
				role: sharp,
				roleConfidence: 0.99,
				fits: { r00: 0.95, r01: 0.8 },
			}),
			abstention("role-overlap"),
		);
		assert.deepEqual(
			decideA({ role: sharp, fits: { r00: 0.9, r02: 0.85 } }),
			abstention("role-overlap"),
		);
		// Below the true floor, another role's fit is not overlap.
		assert.equal(
			decideA({ fits: { r00: 0.85, r01: 0.7999999 } }).kind,
			"continue",
		);
		// An advantage of exactly the margin is enough (1 - .8 in binary).
		assert.equal(decideA({ fits: { r00: 1, r01: 0.8 } }).kind, "continue");
		// Fits are never renormalized: two high fits with a wide gap pass.
		assert.equal(
			decideA({ fits: { r00: 1, r01: 0.1, r02: 0.1 } }).kind,
			"continue",
		);
	});

	it("matches mutation intent to the role and holds when it is uncertain", () => {
		assert.equal(
			decideA({ nouls: { mutation_requested: 0.2 } }).kind,
			"continue",
		);
		assert.deepEqual(
			decideA({ nouls: { mutation_requested: 0.8 } }),
			abstention("intent-mismatch"),
		);
		for (const uncertain of [0.2000001, 0.5, 0.7999999])
			assert.deepEqual(
				decideA({ nouls: { mutation_requested: uncertain } }),
				abstention("mutation-uncertain"),
			);
		const modify = {
			role: { r01: 0.9, none: 0.1 },
			fits: { r00: 0.05, r01: 0.95 },
		};
		const outcome = decideA({ ...modify, nouls: { mutation_requested: 0.8 } });
		assert.equal(outcome.kind, "continue");
		if (outcome.kind === "continue") {
			assert.equal(outcome.plan.role, ROLES[1]);
			assert.deepEqual(layout(outcome.plan), [
				["pi", ["c011"]],
				["claude", ["c010"]],
			]);
		}
		assert.deepEqual(
			decideA({ ...modify, nouls: { mutation_requested: 0.2 } }),
			abstention("intent-mismatch"),
		);
	});

	it("never automatically launches a review responsibility", () => {
		assert.deepEqual(
			decideA({
				role: { r02: 0.99, none: 0.01 },
				roleConfidence: 0.99,
				fits: { r00: 0, r02: 1 },
				nouls: { mutation_requested: 0 },
			}),
			abstention("review-provenance-required"),
		);
	});

	it("passes when every gate sits exactly at its edge: nothing is multiplied", () => {
		const nouls = Object.fromEntries(
			[
				"clarification_needed",
				"mutation_requested",
				"prior_context_needed",
				"delegation_prohibited",
				"manual_runtime_selection",
				"multiple_children_required",
				"independent_review_required",
				"external_action_requested",
			].map((id) => [id, 0.2]),
		);
		const outcome = decideA({
			role: { r00: 0.7, none: 0.3 },
			roleConfidence: 0.8,
			fits: { r00: 0.8, r01: 0.2, r02: 0.2 },
			nouls,
			reasoningConfidence: 0.8,
			consequenceConfidence: 0.8,
		});
		assert.equal(outcome.kind, "continue");
	});

	it("keeps the lowest sufficient effort per exact model at each band", () => {
		const bands: Array<[SpecA, number, Array<[Harness, string[]]>]> = [
			[
				{ reasoning: [0.95, 0.05, 0, 0] },
				0,
				[
					["pi", ["c000", "c001", "c003", "c009"]],
					["claude", ["c006"]],
					["kiro", ["c008"]],
				],
			],
			[
				{ reasoning: [0.05, 0.9, 0.05, 0] },
				1,
				[
					["pi", ["c001", "c003"]],
					["claude", ["c006"]],
					["kiro", ["c008"]],
				],
			],
			[
				{ reasoning: [0, 0.05, 0.95, 0] },
				2,
				[
					["pi", ["c003"]],
					["claude", ["c006"]],
				],
			],
			// xhigh before max despite max's lower preference.
			[
				{ reasoning: [0, 0, 0.9, 0.1] },
				3,
				[
					["pi", ["c004"]],
					["claude", ["c007"]],
				],
			],
		];
		for (const [spec, band, expected] of bands) {
			const outcome = decideA(spec);
			assert.equal(outcome.kind, "continue", `band ${band}`);
			if (outcome.kind !== "continue") continue;
			assert.equal(outcome.plan.requiredBand, band);
			assert.deepEqual(layout(outcome.plan), expected, `band ${band}`);
		}
	});

	it("breaks equal-effort ties by preference, then tuple ID, and drops native off/minimal", () => {
		const r00 = role("r00");
		const source = snapshot(
			[r00],
			[
				tuple("c000", "r00", "pi", "fake/twin-1", "high", "frontier", 5),
				tuple("c001", "r00", "pi", "fake/twin-1", "high", "frontier", 2),
				tuple("c002", "r00", "pi", "fake/twin-2", "high", "frontier", 7),
				tuple("c003", "r00", "pi", "fake/twin-2", "high", "frontier", 7),
				tuple(
					"c004",
					"r00",
					"claude",
					"claude-exact-1",
					"minimal",
					"frontier",
					0,
				),
				tuple("c005", "r00", "kiro", "kiro-exact-1", "off", "frontier", 0),
				tuple("c006", "r00", "pi", "fake/fast-9", "xhigh", "fast", 0),
			],
		);
		const outcome = decideA({ reasoning: [0.95, 0.05, 0, 0] }, source);
		assert.equal(outcome.kind, "continue");
		if (outcome.kind === "continue")
			assert.deepEqual(layout(outcome.plan), [
				["pi", ["c001", "c002", "c006"]],
			]);
		// A fast tier never meets band 1, whatever its effort.
		const banded = decideA({ reasoning: [0.05, 0.9, 0.05, 0] }, source);
		assert.equal(banded.kind, "continue");
		if (banded.kind === "continue")
			assert.deepEqual(layout(banded.plan), [["pi", ["c001", "c002"]]]);
	});

	it("abstains when no tuple meets the required band", () => {
		assert.deepEqual(
			decideA({
				role: { r01: 0.9, none: 0.1 },
				fits: { r00: 0.05, r01: 0.95 },
				nouls: { mutation_requested: 0.9 },
				consequence: [0.5, 0, 0, 0.5],
			}),
			abstention("no-sufficient-runtime"),
		);
		// Low Score confidence raises the band rather than guessing.
		assert.deepEqual(
			decideA({
				role: { r01: 0.9, none: 0.1 },
				fits: { r00: 0.05, r01: 0.95 },
				nouls: { mutation_requested: 0.9 },
				consequenceConfidence: 0.5,
			}),
			abstention("no-sufficient-runtime"),
		);
	});

	it("consumes only validated evidence bound to this snapshot", () => {
		const batch = batchA();
		const evidence = evidenceOf(batch, wireA(batch));
		const unusable = (outcome: { kind: string }) =>
			assert.equal(outcome.kind, "unavailable");
		unusable(decideAfterBatchA(SNAPSHOT, { ...evidence }, T));
		unusable(
			decideAfterBatchA(
				snapshot(ROLES, CANDIDATES, { decisionId: "decision-2" }),
				evidence,
				T,
			),
		);
		unusable(
			decideAfterBatchA(
				snapshot(ROLES, CANDIDATES, { snapshotHash: "snapshot-2" }),
				evidence,
				T,
			),
		);
		unusable(decideAfterBatchA(snapshot(ROLES.slice(0, 2)), evidence, T));
		unusable(
			decideAfterBatchA(
				// SAFETY: a foreign policy version is exactly the mismatch under test.
				snapshot(ROLES, CANDIDATES, { policyVersion: "jev-auto-v2" as any }),
				evidence,
				T,
			),
		);
		const plan = planOf();
		const other = batchB(plan);
		unusable(decideAfterBatchA(SNAPSHOT, evidenceOf(other, wireB(other)), T));
	});
});

describe("Batch B decision", () => {
	const plan = planOf();

	it("selects a concrete runtime and tuple from the immutable local record", () => {
		const outcome = decideB(plan, {
			runtime: { claude: 0.9, none: 0.1 },
			models: { model_claude: { c006: 0.9, equivalent: 0.1 } },
		});
		assert.equal(outcome.kind, "selected");
		if (outcome.kind !== "selected") return;
		assert.equal(outcome.candidate, CANDIDATES[6]);
		assert.deepEqual(outcome.decision, {
			kind: "selected",
			candidateId: "c006",
			requiredBand: 1,
			decisionId: "decision-1",
			snapshotHash: "snapshot-1",
		});
		assert.deepEqual(outcome.route, {
			agent: "agent-r00",
			harness: "claude",
			exactModel: { namespace: "claude", id: "claude-frontier-4-1" },
			exactEffort: "high",
			candidateId: "c006",
			roleFingerprint: "fingerprint-r00",
			policyVersion: "jev-auto-v1",
			questionVersion: "jev-auto-questions-v1",
			decisionId: "decision-1",
		});
		assert.equal(outcome.route.exactModel, CANDIDATES[6].exactModel);
		for (const value of [outcome, outcome.decision, outcome.route])
			assert.ok(Object.isFrozen(value));
		const pi = decideB(plan, {
			runtime: { pi: 0.9, none: 0.1 },
			models: { model_pi: { c003: 0.9, c001: 0.1 } },
		});
		assert.equal(pi.kind === "selected" && pi.route.candidateId, "c003");
	});

	it("abstains on runtime none or uncertainty without trying another runtime", () => {
		assert.deepEqual(
			decideB(plan, { runtime: { none: 0.9, pi: 0.1 } }),
			abstention("no-runtime-fit"),
		);
		assert.deepEqual(
			decideB(plan, { runtimeConfidence: 0.7999999 }),
			abstention("choice-uncertain"),
		);
		assert.deepEqual(
			decideB(plan, { runtime: { pi: 0.45, claude: 0.45, none: 0.1 } }),
			abstention("choice-uncertain"),
		);
		assert.equal(decideB(plan, { runtimeConfidence: 0.8 }).kind, "selected");
	});

	it("never falls back to another harness when the chosen model abstains", () => {
		const confidentElsewhere = { model_pi: { c001: 0.95, none: 0.05 } };
		assert.deepEqual(
			decideB(plan, {
				runtime: { claude: 0.9, none: 0.1 },
				models: {
					...confidentElsewhere,
					model_claude: { none: 0.9, c006: 0.1 },
				},
			}),
			abstention("no-model-fit"),
		);
		assert.deepEqual(
			decideB(plan, {
				runtime: { claude: 0.9, none: 0.1 },
				models: {
					...confidentElsewhere,
					model_claude: { c006: 0.6, equivalent: 0.4 },
				},
			}),
			abstention("choice-uncertain"),
		);
	});

	it("resolves a confident equivalent runtime to the role's own harness", () => {
		const outcome = decideB(plan, {
			runtime: { equivalent: 0.9, none: 0.1 },
			models: { model_pi: { c001: 0.9, none: 0.1 } },
		});
		assert.equal(outcome.kind === "selected" && outcome.route.harness, "pi");
		const modify = planOf({
			role: { r01: 0.9, none: 0.1 },
			fits: { r00: 0.05, r01: 0.95 },
			nouls: { mutation_requested: 0.9 },
		});
		const own = decideB(modify, { runtime: { equivalent: 0.9, none: 0.1 } });
		assert.equal(own.kind === "selected" && own.route.candidateId, "c010");
	});

	it("otherwise resolves equivalent to the lowest preference, then pi, claude, kiro", () => {
		const claudeRole = role("r00", {}, "claude");
		const withPreferences = (pi: number, kiro: number) =>
			planOf(
				{ reasoning: [0, 0.05, 0.95, 0] },
				snapshot(
					[claudeRole],
					[
						tuple("c000", "r00", "claude", "claude-mid-1", "high", "mid", 0),
						tuple(
							"c001",
							"r00",
							"pi",
							"fake/frontier-1",
							"high",
							"frontier",
							pi,
						),
						tuple(
							"c002",
							"r00",
							"kiro",
							"kiro-frontier-1",
							"high",
							"frontier",
							kiro,
						),
					],
				),
			);
		const equivalent = { runtime: { equivalent: 0.9, none: 0.1 } };
		const lower = withPreferences(7, 3);
		assert.deepEqual(layout(lower), [
			["pi", ["c001"]],
			["kiro", ["c002"]],
		]);
		const kiro = decideB(lower, equivalent);
		assert.equal(kiro.kind === "selected" && kiro.route.harness, "kiro");
		const tied = decideB(withPreferences(3, 3), equivalent);
		assert.equal(tied.kind === "selected" && tied.route.harness, "pi");
	});

	it("resolves a confident equivalent model to the lowest preference, then ID", () => {
		const outcome = decideB(plan, {
			runtime: { pi: 0.9, none: 0.1 },
			models: { model_pi: { equivalent: 0.9, none: 0.1 } },
		});
		assert.equal(
			outcome.kind === "selected" && outcome.route.candidateId,
			"c001",
		);
		const tiedPlan = planOf(
			{},
			snapshot(
				[role("r00")],
				[
					tuple("c000", "r00", "pi", "fake/a-1", "medium", "mid", 4),
					tuple("c001", "r00", "pi", "fake/b-1", "medium", "mid", 4),
				],
			),
		);
		const tied = decideB(tiedPlan, {
			models: { model_pi: { equivalent: 0.9, none: 0.1 } },
		});
		assert.equal(tied.kind === "selected" && tied.route.candidateId, "c000");
	});

	it("judges a singleton model's adequacy rather than assuming it", () => {
		const singleton = planOf(
			{},
			snapshot(
				[role("r00")],
				[tuple("c000", "r00", "kiro", "kiro-mid-2", "medium", "mid", 0)],
			),
		);
		assert.deepEqual(layout(singleton), [["kiro", ["c000"]]]);
		assert.equal(decideB(singleton).kind, "selected");
		assert.deepEqual(
			decideB(singleton, { models: { model_kiro: { none: 0.9, c000: 0.1 } } }),
			abstention("no-model-fit"),
		);
		assert.deepEqual(
			decideB(singleton, { runtime: { none: 0.9, kiro: 0.1 } }),
			abstention("no-runtime-fit"),
		);
		const equivalent = decideB(singleton, {
			models: { model_kiro: { equivalent: 0.9, none: 0.1 } },
		});
		assert.equal(
			equivalent.kind === "selected" && equivalent.route.candidateId,
			"c000",
		);
	});

	it("follows validated evidence, never a runtime the prompt names", () => {
		const named = planOf(
			{},
			snapshot(ROLES, CANDIDATES, {
				task: "Compare how the kiro and claude CLIs cache sessions.",
			}),
		);
		const outcome = decideB(named, {
			runtime: { pi: 0.9, none: 0.1 },
			models: { model_pi: { c001: 0.9, none: 0.1 } },
		});
		assert.equal(outcome.kind === "selected" && outcome.route.harness, "pi");
	});

	it("consumes only the host plan and validated evidence of its own Batch B", () => {
		const batch = batchB(plan);
		const evidence = evidenceOf(batch, wireB(batch));
		assert.equal(decideAfterBatchB(plan, evidence, T).kind, "selected");
		const unusable = (outcome: { kind: string }) =>
			assert.equal(outcome.kind, "unavailable");
		unusable(decideAfterBatchB({ ...plan }, evidence, T));
		unusable(decideAfterBatchB(plan, { ...evidence }, T));
		const first = batchA();
		unusable(decideAfterBatchB(plan, evidenceOf(first, wireA(first)), T));
		const otherPlan = planOf(
			{},
			snapshot(ROLES, CANDIDATES, { decisionId: "decision-2" }),
		);
		const otherBatch = batchB(otherPlan);
		unusable(
			decideAfterBatchB(plan, evidenceOf(otherBatch, wireB(otherBatch)), T),
		);
		const banded = planOf({ reasoning: [0, 0.05, 0.95, 0] });
		const bandedBatch = batchB(banded);
		unusable(
			decideAfterBatchB(plan, evidenceOf(bandedBatch, wireB(bandedBatch)), T),
		);
	});
});
