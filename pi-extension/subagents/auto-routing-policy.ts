/**
 * Versioned domain vocabulary for automatic input routing through Jev, the
 * strict decoder of its evidence, and the deterministic `jev-auto-v1`
 * combination policy.
 *
 * The question set, combination policy, classifier pin, and disclosure are
 * immutable shipped constants: changing their meaning requires a new version.
 * Evidence is validated whole before any answer is consumed and is never
 * repaired. The policy's gates are conjunctive and separately reasoned; it
 * never multiplies probabilities, and it only ever selects an approved local
 * tuple by its opaque ID. Nothing here authorizes a launch or contacts a
 * classifier.
 */
import type {
	AutoCandidateApproval,
	AutoEffortLevel,
	AutoHarness,
	AutoModelTier,
	AutoRoleApproval,
	AutoRoutingThresholds,
} from "./auto-routing-config.ts";
import type {
	AutoExactModel,
	AutoRoutingRoleDefinition,
} from "./auto-routing-candidates.ts";
import type { JevBatch } from "./jev-questions.ts";
import { isFiniteNumber, isRecord, type JsonObject } from "./type-guards.ts";

export const AUTO_ROUTING_POLICY_VERSION = "jev-auto-v1";
export const AUTO_ROUTING_QUESTION_VERSION = "jev-auto-questions-v1";
export const AUTO_ROUTING_DISCLOSURE_VERSION = "jev-egress-v1";
export const AUTO_ROUTING_JEV_PROVIDER = "typesafe";
/** Exact classifier pin; never `jev-latest`, a wildcard, or a task selector. */
export const AUTO_ROUTING_JEV_MODEL = "jev-1.13.0";
/** Pi classifier API a pinned Jev result must report. */
export const AUTO_ROUTING_JEV_API = "typesafe-system-one";

export type AutoRoutingPolicyVersion = typeof AUTO_ROUTING_POLICY_VERSION;
export type AutoRoutingQuestionVersion = typeof AUTO_ROUTING_QUESTION_VERSION;
export type AutoRoutingDisclosureVersion =
	typeof AUTO_ROUTING_DISCLOSURE_VERSION;
export type AutoRoutingJevProvider = typeof AUTO_ROUTING_JEV_PROVIDER;
export type AutoRoutingJevModel = typeof AUTO_ROUTING_JEV_MODEL;

/** Conservative effort requirement derived from both Score distributions. */
export type AutoRequiredBand = 0 | 1 | 2 | 3;
/** Policy bucket of one exact approved effort; not a portable token budget. */
export type AutoEffortBand = AutoRequiredBand;

/**
 * Local eligibility failures. The input continues to the parent unchanged:
 * no classifier call, no child, and no replacement message.
 */
export const AUTO_BYPASS_REASONS = [
	"routing-off",
	"config-invalid",
	"config-drift",
	"unsupported-input-contract",
	/** A required current public host method is absent. */
	"unsupported-public-api",
	"unsupported-session-mode",
	/** RPC or extension-origin input. */
	"non-interactive-source",
	"not-fresh-prompt",
	"child-session",
	"no-session-file",
	"herdr-unavailable",
	"parent-busy",
	"auto-busy",
	"blank-prompt",
	"image-input",
	"command-input",
	"transformed-input",
	"prompt-too-large",
	"egress-screened",
	"user-opt-out",
	"no-feasible-candidate",
] as const;

/** Semantic or no-fit abstention after valid evidence; `failurePolicy` applies. */
export const AUTO_ABSTAIN_REASONS = [
	"clarification-required",
	"semantic-uncertainty",
	"delegation-prohibited",
	"manual-selection-requested",
	"prior-context-required",
	"multiple-children-required",
	"independent-review-required",
	"external-action-requested",
	"choice-uncertain",
	"no-role-fit",
	"role-fit-insufficient",
	"role-overlap",
	"mutation-uncertain",
	"intent-mismatch",
	"review-provenance-required",
	"no-sufficient-runtime",
	"no-runtime-fit",
	"no-model-fit",
] as const;

/**
 * Missing, invalid, or stale evidence and pre-resource launch rejection;
 * `failurePolicy` applies because no child process was dispatched.
 */
export const AUTO_UNAVAILABLE_REASONS = [
	"jev-timeout",
	"jev-auth-unavailable",
	"jev-model-unavailable",
	"jev-endpoint-rejected",
	"jev-request-too-large",
	"jev-response-too-large",
	"jev-http-error",
	"jev-invalid-response",
	"jev-adapter-incompatible",
	"request-record-failed",
	"stale-snapshot",
	"launch-rejected",
] as const;

/** Cancellation always holds: no parent continuation and no child. */
export const AUTO_CANCEL_REASONS = [
	"user-cancelled",
	"superseded",
	"session-changed",
	"shutdown",
	"parent-started",
	"pilot-declined",
	"pilot-timeout",
] as const;

/**
 * Outcomes that always hold regardless of `failurePolicy`: work may already
 * exist, or ownership was taken before an unexpected error.
 */
export const AUTO_HOLD_REASONS = [
	"dispatch-uncertain",
	"internal-error",
] as const;

export const AUTO_REASON_CODES = Object.freeze([
	...AUTO_BYPASS_REASONS,
	...AUTO_ABSTAIN_REASONS,
	...AUTO_UNAVAILABLE_REASONS,
	...AUTO_CANCEL_REASONS,
	...AUTO_HOLD_REASONS,
]);

export type AutoBypassReason = (typeof AUTO_BYPASS_REASONS)[number];
export type AutoAbstainReason = (typeof AUTO_ABSTAIN_REASONS)[number];
export type AutoUnavailableReason = (typeof AUTO_UNAVAILABLE_REASONS)[number];
export type AutoCancelReason = (typeof AUTO_CANCEL_REASONS)[number];
export type AutoHoldReason = (typeof AUTO_HOLD_REASONS)[number];
export type AutoReasonCode = (typeof AUTO_REASON_CODES)[number];

/**
 * Host routing decision. Jev supplies only evidence: a selected decision
 * names an opaque candidate ID that the host maps to its own approved tuple.
 */
export type AutoDecision =
	| Readonly<{
			kind: "selected";
			candidateId: string;
			requiredBand: AutoRequiredBand;
			decisionId: string;
			snapshotHash: string;
	  }>
	| Readonly<{ kind: "abstain"; reason: AutoAbstainReason }>
	| Readonly<{ kind: "unavailable"; reason: AutoUnavailableReason }>
	| Readonly<{ kind: "cancelled"; reason: AutoCancelReason }>;

export type AutoSelectedDecision = Extract<AutoDecision, { kind: "selected" }>;
export type AutoAbstainDecision = Extract<AutoDecision, { kind: "abstain" }>;

/**
 * Stable question IDs of `jev-auto-questions-v1`. They are local
 * correlation keys and are never visible to Jev.
 */
export const JEV_QUESTION_IDS = Object.freeze({
	role: "role",
	reasoning: "reasoning",
	consequence: "consequence",
	clarification: "clarification_needed",
	mutation: "mutation_requested",
	priorContext: "prior_context_needed",
	delegation: "delegation_prohibited",
	manualSelection: "manual_runtime_selection",
	multipleChildren: "multiple_children_required",
	independentReview: "independent_review_required",
	externalAction: "external_action_requested",
	runtime: "runtime",
});

/** The absolute-fit Noul of one opaque role. */
export function jevRoleFitQuestionId(roleId: string): string {
	return `role_fit_${roleId}`;
}

/** The model Choice of one surviving runtime. */
export function jevModelQuestionId(harness: AutoHarness): string {
	return `model_${harness}`;
}

/** Reserved Choice options; approved IDs can never use them. */
export const JEV_NONE_OPTION = "none";
export const JEV_EQUIVALENT_OPTION = "equivalent";

/**
 * Negative-polarity Batch A Nouls in gate order, each with the reason a
 * confident `true` gives. Any value above the false ceiling abstains.
 */
export const JEV_NEGATIVE_NOUL_GATES = Object.freeze([
	Object.freeze({
		id: JEV_QUESTION_IDS.clarification,
		reason: "clarification-required",
	}),
	Object.freeze({
		id: JEV_QUESTION_IDS.priorContext,
		reason: "prior-context-required",
	}),
	Object.freeze({
		id: JEV_QUESTION_IDS.delegation,
		reason: "delegation-prohibited",
	}),
	Object.freeze({
		id: JEV_QUESTION_IDS.manualSelection,
		reason: "manual-selection-requested",
	}),
	Object.freeze({
		id: JEV_QUESTION_IDS.multipleChildren,
		reason: "multiple-children-required",
	}),
	Object.freeze({
		id: JEV_QUESTION_IDS.independentReview,
		reason: "independent-review-required",
	}),
	Object.freeze({
		id: JEV_QUESTION_IDS.externalAction,
		reason: "external-action-requested",
	}),
] as const satisfies readonly Readonly<{
	id: string;
	reason: AutoAbstainReason;
}>[]);

/** Pinned tolerances of the v1 evidence decoder. */
export const JEV_EVIDENCE_TOLERANCES = Object.freeze({
	/** A distribution may sum to 1 within this. */
	distributionSum: 1e-6,
	/** `.choice` must be a maximum within this; so is a tied maximum. */
	choiceMaximum: 1e-6,
	/** A Score may differ from its distribution's mean by this (two-decimal serialization). */
	scoreMean: 0.0051,
});

/** Pinned level-3 mass in either Score that alone requires band 3. */
export const AUTO_EFFORT_TAIL_GUARD = 0.1;

/**
 * Binary rounding a sum or difference of decimal probabilities can carry,
 * so that one meeting a threshold or tolerance exactly still meets it. Far
 * below every evidence tolerance; single wire values are compared exactly.
 */
const ARITHMETIC_TOLERANCE = 1e-12;

function atLeast(value: number, threshold: number): boolean {
	return value >= threshold - ARITHMETIC_TOLERANCE;
}

/** An inclusive tolerance on a derived difference. */
function within(difference: number, tolerance: number): boolean {
	return Math.abs(difference) <= tolerance + ARITHMETIC_TOLERANCE;
}

/** Conservative policy buckets, not portable token budgets. */
const PI_EFFORT_BANDS = {
	off: 0,
	minimal: 0,
	low: 0,
	medium: 1,
	high: 2,
	xhigh: 3,
	max: 3,
} as const satisfies Readonly<Record<AutoEffortLevel, AutoEffortBand>>;
/** Native efforts; `off` and `minimal` never map to a native value. */
const NATIVE_EFFORT_BANDS = {
	low: 0,
	medium: 1,
	high: 2,
	xhigh: 3,
	max: 3,
} as const satisfies Readonly<
	Record<Exclude<AutoEffortLevel, "off" | "minimal">, AutoEffortBand>
>;
/** The ordered Pi/native effort vocabulary, lowest first. */
const EFFORT_ORDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly AutoEffortLevel[];
const TIER_RANK = {
	fast: 0,
	mid: 1,
	frontier: 2,
} as const satisfies Readonly<Record<AutoModelTier, number>>;
/** Minimum declared model tier and effort band for each required band. */
const BAND_MINIMUMS = [
	{ tier: "fast", effort: 0 },
	{ tier: "mid", effort: 1 },
	{ tier: "frontier", effort: 2 },
	{ tier: "frontier", effort: 3 },
] as const satisfies readonly Readonly<{
	tier: AutoModelTier;
	effort: AutoEffortBand;
}>[];
const HARNESS_ORDER = [
	"pi",
	"claude",
	"kiro",
] as const satisfies readonly AutoHarness[];

/**
 * The policy bucket of one exact effort on one harness, or undefined when
 * the harness cannot represent it (native `off`/`minimal`).
 */
export function autoEffortBand(
	harness: AutoHarness,
	effort: AutoEffortLevel,
): AutoEffortBand | undefined {
	if (harness === "pi") return PI_EFFORT_BANDS[effort];
	if (effort === "off" || effort === "minimal") return undefined;
	return NATIVE_EFFORT_BANDS[effort];
}

/** Why a completed classifier call yields no usable evidence. */
export type JevEvidenceFailureReason = Extract<
	AutoUnavailableReason,
	"jev-invalid-response" | "jev-model-unavailable" | "jev-adapter-incompatible"
>;

/**
 * What one completed classifier call observed. `wire` is the parsed success
 * body the bounded observing fetch captured for this call, or undefined when
 * nothing was observed; `result` is Pi's normalized result of the same call.
 * Transport errors and cancellation are classified by the caller first.
 */
export type JevObservation = Readonly<{ wire: any; result: any }>;

/** A validated Choice: the full distribution over exactly the offered options. */
export type JevChoiceEvidence = Readonly<{
	choice: string;
	probabilities: Readonly<Record<string, number>>;
	confidence: number;
}>;

/** A validated Score with its complete distribution over levels 0..3. */
export type JevScoreEvidence = Readonly<{
	/** Consistency check only; policy reads the distribution. */
	score: number;
	probabilities: readonly [number, number, number, number];
	confidence: number;
}>;

/**
 * Bounded evidence of one batch, bound to the batch it answers. It holds no
 * raw body: only host option keys, numbers, and token counts.
 */
export type JevBatchEvidence = Readonly<{
	batch: JevBatch;
	model: AutoRoutingJevModel;
	choices: Readonly<Record<string, JevChoiceEvidence>>;
	scores: Readonly<Record<string, JevScoreEvidence>>;
	/** Each Noul's value; Noul has no confidence. */
	nouls: Readonly<Record<string, number>>;
	/** Recorded as reported; a zero catalog price means unpriced, not free. */
	usage: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

export type JevEvidenceValidation =
	| Readonly<{ ok: true; evidence: JevBatchEvidence }>
	| Readonly<{
			ok: false;
			reason: JevEvidenceFailureReason;
			detail: string;
	  }>;

class JevEvidenceError extends Error {
	reason: JevEvidenceFailureReason;

	constructor(reason: JevEvidenceFailureReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

const invalidResponse = (detail: string) =>
	new JevEvidenceError("jev-invalid-response", detail);
const incompatibleAdapter = (detail: string) =>
	new JevEvidenceError("jev-adapter-incompatible", detail);

/** Evidence produced by validateJevEvidence; nothing else is consumed. */
const validatedEvidence = new WeakSet<JevBatchEvidence>();

/**
 * A JSON object without an inherited or forged prototype, checked without
 * reading any response property. A brand tag is never read, so a
 * `Symbol.toStringTag` accessor is not invoked before descriptor validation
 * and a forged tag can never make a foreign object look plain. Symbol
 * members are rejected here, so every later member read is descriptor-checked
 * own plain data. An ordinary `Object.prototype` or null-prototype JSON
 * record is unaffected.
 */
function isPlainRecord(value: any): value is JsonObject {
	// Object(value) === value holds for exactly the objects, and reads no
	// member, brand tag, or trap-visible key of the value.
	if (Object(value) !== value) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.getOwnPropertySymbols(value).length === 0;
}

/** Exactly these own enumerable data members: no extra, accessor, or symbol key. */
function hasExactlyKeys(value: JsonObject, keys: readonly string[]): boolean {
	if (
		Object.getOwnPropertySymbols(value).length > 0 ||
		Object.getOwnPropertyNames(value).length !== keys.length
	)
		return false;
	return keys.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			descriptor !== undefined &&
			descriptor.enumerable === true &&
			Object.hasOwn(descriptor, "value")
		);
	});
}

function isUnitInterval(value: any): value is number {
	return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/** A record keyed only by host-created IDs that no prototype member shadows. */
function hostRecord<T>(
	entries: Iterable<readonly [string, T]>,
): Record<string, T> {
	const record: Record<string, T> = Object.create(null);
	for (const [key, value] of entries) record[key] = value;
	return Object.freeze(record);
}

const sum = (values: readonly number[]) =>
	values.reduce((total, value) => total + value, 0);

/** Every and only the expected keys, each a finite probability, summing to 1. */
function decodeDistribution(
	at: string,
	value: any,
	keys: readonly string[],
): Record<string, number> {
	if (!isPlainRecord(value) || !hasExactlyKeys(value, keys))
		throw invalidResponse(
			`${at} probabilities must cover exactly the offered options.`,
		);
	const probabilities = keys.map((key) => value[key]);
	if (!probabilities.every(isUnitInterval))
		throw invalidResponse(
			`${at} probabilities must be finite numbers from 0 to 1.`,
		);
	if (!within(sum(probabilities) - 1, JEV_EVIDENCE_TOLERANCES.distributionSum))
		throw invalidResponse(`${at} probabilities must sum to 1.`);
	return hostRecord(keys.map((key, index) => [key, probabilities[index]]));
}

function decodeConfidence(at: string, value: any): number {
	if (!isUnitInterval(value))
		throw invalidResponse(
			`${at} confidence must be a finite number from 0 to 1.`,
		);
	return value;
}

function decodeChoice(
	id: string,
	answer: any,
	options: readonly string[],
): JevChoiceEvidence {
	const at = `Answer ${id}`;
	if (
		!isPlainRecord(answer) ||
		!hasExactlyKeys(answer, [
			"type",
			"choice",
			"probabilities",
			"confidence",
		]) ||
		answer.type !== "choice"
	)
		throw invalidResponse(
			`${at} must be a choice answer with exactly type, choice, probabilities, and confidence.`,
		);
	const probabilities = decodeDistribution(at, answer.probabilities, options);
	// The host's own option string; the wire string is only compared.
	const choice = options.find((option) => option === answer.choice);
	if (choice === undefined)
		throw invalidResponse(`${at} chose an option the question does not offer.`);
	const maximum = Math.max(...options.map((option) => probabilities[option]));
	if (
		!within(
			maximum - probabilities[choice],
			JEV_EVIDENCE_TOLERANCES.choiceMaximum,
		)
	)
		throw invalidResponse(
			`${at} chose an option without the largest probability.`,
		);
	return Object.freeze({
		choice,
		probabilities,
		confidence: decodeConfidence(at, answer.confidence),
	});
}

const SCORE_LEVELS = ["0", "1", "2", "3"] as const;

function decodeScore(
	id: string,
	answer: any,
	legend: readonly string[],
): JevScoreEvidence {
	const at = `Answer ${id}`;
	if (
		!isPlainRecord(answer) ||
		!hasExactlyKeys(answer, [
			"type",
			"score",
			"probabilities",
			"legend",
			"confidence",
		]) ||
		answer.type !== "score"
	)
		throw invalidResponse(
			`${at} must be a score answer with exactly type, score, probabilities, legend, and confidence.`,
		);
	const distribution = decodeDistribution(
		at,
		answer.probabilities,
		SCORE_LEVELS,
	);
	const probabilities: [number, number, number, number] = [
		distribution["0"],
		distribution["1"],
		distribution["2"],
		distribution["3"],
	];
	Object.freeze(probabilities);
	const wireLegend = answer.legend;
	if (
		legend.length !== SCORE_LEVELS.length ||
		!isPlainRecord(wireLegend) ||
		!hasExactlyKeys(wireLegend, SCORE_LEVELS) ||
		SCORE_LEVELS.some((level, index) => wireLegend[level] !== legend[index])
	)
		throw invalidResponse(
			`${at} legend must be exactly the shipped four-level rubric.`,
		);
	const score = answer.score;
	if (!isFiniteNumber(score) || score < 0 || score > 3)
		throw invalidResponse(`${at} score must be a finite number from 0 to 3.`);
	const mean = sum(
		probabilities.map((probability, level) => probability * level),
	);
	if (!within(score - mean, JEV_EVIDENCE_TOLERANCES.scoreMean))
		throw invalidResponse(
			`${at} score is inconsistent with its probability distribution.`,
		);
	return Object.freeze({
		score,
		probabilities,
		confidence: decodeConfidence(at, answer.confidence),
	});
}

function decodeNoul(id: string, answer: any): number {
	const at = `Answer ${id}`;
	if (
		!isPlainRecord(answer) ||
		!hasExactlyKeys(answer, ["type", "noul"]) ||
		answer.type !== "noul"
	)
		throw invalidResponse(
			`${at} must be a noul answer with exactly type and noul.`,
		);
	if (!isUnitInterval(answer.noul))
		throw invalidResponse(`${at} noul must be a finite number from 0 to 1.`);
	return answer.noul;
}

function decodeUsage(value: any): JevBatchEvidence["usage"] {
	if (
		!isPlainRecord(value) ||
		!hasExactlyKeys(value, ["input_tokens", "output_tokens"])
	)
		throw invalidResponse(
			"The classifier usage must have exactly input_tokens and output_tokens.",
		);
	const inputTokens = value.input_tokens;
	const outputTokens = value.output_tokens;
	if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens))
		throw invalidResponse(
			"The classifier token counts must be non-negative safe integers.",
		);
	return Object.freeze({ inputTokens, outputTokens });
}

function isTokenCount(value: any): value is number {
	return Number.isSafeInteger(value) && value >= 0;
}

/** Whether Pi's normalized answer carries exactly the decoded wire values. */
function normalizedAgrees(
	question: JevBatch["expected"][number],
	normalized: any,
	evidence: Omit<JevBatchEvidence, "model">,
): boolean {
	if (!isRecord(normalized)) return false;
	if (question.type === "choice") {
		const choice = evidence.choices[question.id];
		const probabilities = normalized.probabilities;
		return (
			normalized.type === "choice" &&
			normalized.choice === choice.choice &&
			normalized.confidence === choice.confidence &&
			isRecord(probabilities) &&
			hasExactlyKeys(probabilities, question.options) &&
			question.options.every(
				(option) => probabilities[option] === choice.probabilities[option],
			)
		);
	}
	if (question.type === "score") {
		const score = evidence.scores[question.id];
		return (
			normalized.type === "score" &&
			normalized.score === score.score &&
			normalized.confidence === score.confidence
		);
	}
	return (
		normalized.type === "bool" &&
		normalized.probability === evidence.nouls[question.id]
	);
}

/**
 * Pi's normalized result must be the completed pinned call and agree
 * exactly with the observed wire evidence; otherwise the adapter did not
 * parse what was observed, and nothing from either is trusted.
 */
function checkNormalized(
	result: any,
	evidence: Omit<JevBatchEvidence, "model">,
): void {
	if (!isRecord(result))
		throw incompatibleAdapter("Pi returned no classifier result.");
	if (result.stopReason !== "stop")
		throw incompatibleAdapter(
			"Pi did not complete the classification whose response was observed.",
		);
	if (
		result.api !== AUTO_ROUTING_JEV_API ||
		result.provider !== AUTO_ROUTING_JEV_PROVIDER ||
		result.model !== AUTO_ROUTING_JEV_MODEL
	)
		throw incompatibleAdapter(
			`Pi's result is not from ${AUTO_ROUTING_JEV_API} provider ${AUTO_ROUTING_JEV_PROVIDER} model ${AUTO_ROUTING_JEV_MODEL}.`,
		);
	const answers = result.answers;
	const expected = evidence.batch.expected;
	if (
		!isRecord(answers) ||
		!hasExactlyKeys(
			answers,
			expected.map((question) => question.id),
		)
	)
		throw incompatibleAdapter(
			"Pi's normalized answers do not cover exactly the batch's questions.",
		);
	for (const question of expected)
		if (!normalizedAgrees(question, answers[question.id], evidence))
			throw incompatibleAdapter(
				`Pi's normalized answer ${question.id} disagrees with the observed response.`,
			);
	const usage = result.usage;
	if (
		!isRecord(usage) ||
		usage.input !== evidence.usage.inputTokens ||
		usage.output !== evidence.usage.outputTokens
	)
		throw incompatibleAdapter(
			"Pi's normalized usage disagrees with the observed response.",
		);
}

function decodeEvidence(
	batch: JevBatch,
	observation: JevObservation,
): JevBatchEvidence {
	if (!isRecord(observation) || observation.wire === undefined)
		throw incompatibleAdapter(
			"No classifier response was observed for this call; the adapter bypassed the observing fetch.",
		);
	const wire = observation.wire;
	if (
		!isPlainRecord(wire) ||
		!hasExactlyKeys(wire, ["model", "answers", "usage"])
	)
		throw invalidResponse(
			"The classifier response must be a JSON object with exactly model, answers, and usage.",
		);
	if (wire.model !== AUTO_ROUTING_JEV_MODEL)
		throw new JevEvidenceError(
			"jev-model-unavailable",
			`The classifier did not answer with the pinned model ${AUTO_ROUTING_JEV_MODEL}.`,
		);
	if (
		batch.model !== AUTO_ROUTING_JEV_MODEL ||
		batch.questionVersion !== AUTO_ROUTING_QUESTION_VERSION
	)
		throw invalidResponse(
			`The batch is not a ${AUTO_ROUTING_QUESTION_VERSION} request to ${AUTO_ROUTING_JEV_MODEL}.`,
		);
	const answers = wire.answers;
	if (
		!isPlainRecord(answers) ||
		!hasExactlyKeys(
			answers,
			batch.expected.map((question) => question.id),
		)
	)
		throw invalidResponse(
			"The classifier answers must cover exactly the batch's questions.",
		);
	const choices: Array<[string, JevChoiceEvidence]> = [];
	const scores: Array<[string, JevScoreEvidence]> = [];
	const nouls: Array<[string, number]> = [];
	for (const question of batch.expected) {
		const answer = answers[question.id];
		if (question.type === "choice")
			choices.push([
				question.id,
				decodeChoice(question.id, answer, question.options),
			]);
		else if (question.type === "score")
			scores.push([
				question.id,
				decodeScore(question.id, answer, question.legend),
			]);
		else nouls.push([question.id, decodeNoul(question.id, answer)]);
	}
	const decoded = {
		batch,
		choices: hostRecord(choices),
		scores: hostRecord(scores),
		nouls: hostRecord(nouls),
		usage: decodeUsage(wire.usage),
	};
	checkNormalized(observation.result, decoded);
	return Object.freeze({ ...decoded, model: AUTO_ROUTING_JEV_MODEL });
}

/**
 * Validate one completed classifier call for its batch as a whole before
 * any answer is consumed. The raw wire object must be exactly the pinned
 * contract, and Pi's normalized result must agree with it; a missing
 * observation means an incompatible adapter. Nothing is filled, clamped,
 * renormalized, or repaired, and details never echo response content.
 */
export function validateJevEvidence(
	batch: JevBatch,
	observation: JevObservation,
): JevEvidenceValidation {
	try {
		const evidence = decodeEvidence(batch, observation);
		validatedEvidence.add(evidence);
		return Object.freeze({ ok: true, evidence });
	} catch (error) {
		if (error instanceof JevEvidenceError)
			return Object.freeze({
				ok: false,
				reason: error.reason,
				detail: error.message,
			});
		// A response that cannot even be inspected is still only invalid.
		return Object.freeze({
			ok: false,
			reason: "jev-invalid-response",
			detail: "The classifier response could not be decoded.",
		});
	}
}

/** What the policy reads of one approved role in a local snapshot. */
export type AutoPolicyRole = Readonly<{
	/** Opaque `rNN`. */
	id: string;
	approval: Readonly<
		Pick<
			AutoRoleApproval,
			| "agent"
			| "intent"
			| "purpose"
			| "responsibility"
			| "deliverable"
			| "excludes"
		>
	>;
	/** The resolved role; its own harness is its `cli`, or Pi. */
	role: Readonly<Pick<AutoRoutingRoleDefinition, "cli">>;
	roleFingerprint: string;
}>;

/** What the policy reads of one feasible approved tuple. */
export type AutoPolicyCandidate = Readonly<{
	/** Opaque `cNNN`. */
	id: string;
	/** Opaque `rNN` of its role. */
	roleId: string;
	harness: AutoHarness;
	exactModel: AutoExactModel;
	exactEffort: AutoEffortLevel;
	tier: AutoModelTier;
	roleFingerprint: string;
	profile: Readonly<
		Pick<AutoCandidateApproval, "preference" | "taskStrengths" | "limitations">
	>;
}>;

/** What the policy reads of a local snapshot; a full snapshot satisfies it. */
export type AutoPolicySnapshot<
	C extends AutoPolicyCandidate = AutoPolicyCandidate,
> = Readonly<{
	decisionId: string;
	snapshotHash: string;
	/** The exact original prompt. */
	task: string;
	policyVersion: AutoRoutingPolicyVersion;
	questionVersion: AutoRoutingQuestionVersion;
	roles: readonly AutoPolicyRole[];
	candidates: readonly C[];
}>;

/** One surviving runtime of a Batch B plan. */
export type AutoBatchBRuntime<C extends AutoPolicyCandidate> = Readonly<{
	harness: AutoHarness;
	/** One approved effort per exact model, in snapshot order. */
	candidates: readonly C[];
}>;

/**
 * The host conclusion after Batch A and the only valid input of Batch B:
 * the selected role, the required band, and the tuples that meet it. The
 * band changes candidates, never the task or its permissions.
 */
export type AutoBatchBPlan<
	C extends AutoPolicyCandidate = AutoPolicyCandidate,
> = Readonly<{
	decisionId: string;
	snapshotHash: string;
	policyVersion: AutoRoutingPolicyVersion;
	questionVersion: AutoRoutingQuestionVersion;
	prompt: string;
	role: AutoPolicyRole;
	requiredBand: AutoRequiredBand;
	/** Surviving runtimes in `pi`, `claude`, `kiro` order. */
	runtimes: readonly AutoBatchBRuntime<C>[];
}>;

/** Evidence that is not bound to this decision is unusable, never guessed. */
export type AutoPolicyUnavailable = Readonly<{
	kind: "unavailable";
	reason: "jev-invalid-response";
	detail: string;
}>;

export type AutoBatchAOutcome<C extends AutoPolicyCandidate> =
	| Readonly<{ kind: "continue"; plan: AutoBatchBPlan<C> }>
	| AutoAbstainDecision
	| AutoPolicyUnavailable;

/**
 * The approved route, taken entirely from the immutable local record. The
 * launch also fixes an autonomous standalone non-persistent leaf in the
 * captured cwd; none of that is classifier output.
 */
export type AutoSelectedRoute = Readonly<{
	agent: string;
	harness: AutoHarness;
	exactModel: AutoExactModel;
	exactEffort: AutoEffortLevel;
	candidateId: string;
	roleFingerprint: string;
	policyVersion: AutoRoutingPolicyVersion;
	questionVersion: AutoRoutingQuestionVersion;
	decisionId: string;
}>;

export type AutoBatchBOutcome<C extends AutoPolicyCandidate> =
	| Readonly<{
			kind: "selected";
			decision: AutoSelectedDecision;
			route: AutoSelectedRoute;
			/** The snapshot's own approved tuple. */
			candidate: C;
	  }>
	| AutoAbstainDecision
	| AutoPolicyUnavailable;

/** Plans produced by decideAfterBatchA; Batch B accepts nothing else. */
const batchBPlans = new WeakSet<AutoBatchBPlan>();

/** Whether a Batch B plan came from the host's own Batch A decision. */
export function isAutoBatchBPlan(plan: AutoBatchBPlan): boolean {
	return batchBPlans.has(plan);
}

const abstain = (reason: AutoAbstainReason): AutoAbstainDecision =>
	Object.freeze({ kind: "abstain", reason });

const unusable = (detail: string): AutoPolicyUnavailable =>
	Object.freeze({
		kind: "unavailable",
		reason: "jev-invalid-response",
		detail,
	});

function sameKeys<T>(
	actual: Readonly<Record<string, T>>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(actual);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(actual, key))
	);
}

/** Exactly these option keys, in this order. */
function offersExactly(
	choice: JevChoiceEvidence | undefined,
	options: readonly string[],
): choice is JevChoiceEvidence {
	if (choice === undefined) return false;
	const keys = Object.keys(choice.probabilities);
	return (
		keys.length === options.length &&
		keys.every((key, index) => key === options[index])
	);
}

/**
 * The confident winner of one Choice, or undefined. The winner must be the
 * unique maximum and meet the confidence, probability, and margin gates;
 * a tie is never broken here.
 */
function confidentChoice(
	answer: JevChoiceEvidence,
	thresholds: AutoRoutingThresholds,
): string | undefined {
	const winner = answer.choice;
	const probability = answer.probabilities[winner];
	let runnerUp = 0;
	for (const option of Object.keys(answer.probabilities))
		if (option !== winner)
			runnerUp = Math.max(runnerUp, answer.probabilities[option]);
	// A runner-up within the maximum tolerance is a tie: no unique winner.
	if (within(probability - runnerUp, JEV_EVIDENCE_TOLERANCES.choiceMaximum))
		return undefined;
	if (
		answer.confidence < thresholds.choiceConfidence ||
		probability < thresholds.choiceProbability ||
		!atLeast(probability - runnerUp, thresholds.choiceMargin)
	)
		return undefined;
	return winner;
}

/** Smallest level whose cumulative probability reaches the quantile. */
function quantileLevel(
	probabilities: JevScoreEvidence["probabilities"],
	quantile: number,
): AutoRequiredBand {
	let cumulative = 0;
	for (const level of [0, 1, 2] as const) {
		cumulative += probabilities[level];
		if (atLeast(cumulative, quantile)) return level;
	}
	return 3;
}

/**
 * The conservative effort requirement from both complete Score
 * distributions, never either mean: the higher effort quantile, raised to
 * band 3 by low confidence in either Score or a level-3 tail of at least
 * the pinned 0.10 in either.
 */
export function deriveRequiredBand(
	reasoning: JevScoreEvidence,
	consequence: JevScoreEvidence,
	thresholds: Pick<AutoRoutingThresholds, "effortQuantile" | "scoreConfidence">,
): AutoRequiredBand {
	if (
		reasoning.confidence < thresholds.scoreConfidence ||
		consequence.confidence < thresholds.scoreConfidence
	)
		return 3;
	if (
		reasoning.probabilities[3] >= AUTO_EFFORT_TAIL_GUARD ||
		consequence.probabilities[3] >= AUTO_EFFORT_TAIL_GUARD
	)
		return 3;
	const reasoningBand = quantileLevel(
		reasoning.probabilities,
		thresholds.effortQuantile,
	);
	const consequenceBand = quantileLevel(
		consequence.probabilities,
		thresholds.effortQuantile,
	);
	return reasoningBand > consequenceBand ? reasoningBand : consequenceBand;
}

const exactModelKey = (candidate: AutoPolicyCandidate) =>
	`${candidate.harness}\u0000${
		candidate.exactModel.namespace === "pi"
			? candidate.exactModel.ref
			: candidate.exactModel.id
	}`;

/** Lowest effort in the ordered vocabulary, then preference, then tuple ID. */
function preferredEffort(
	left: AutoPolicyCandidate,
	right: AutoPolicyCandidate,
): number {
	return (
		EFFORT_ORDER.indexOf(left.exactEffort) -
			EFFORT_ORDER.indexOf(right.exactEffort) ||
		left.profile.preference - right.profile.preference ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
	);
}

/**
 * The selected role's tuples that meet the band's minimum tier and effort,
 * keeping one approved effort per exact model: the lowest sufficient one.
 * Every surviving model and harness stays; nothing is invented.
 */
function sufficientRuntimes<C extends AutoPolicyCandidate>(
	candidates: readonly C[],
	roleId: string,
	band: AutoRequiredBand,
): AutoBatchBRuntime<C>[] {
	const minimum = BAND_MINIMUMS[band];
	const retained = new Map<string, C>();
	for (const candidate of candidates) {
		const effort = autoEffortBand(candidate.harness, candidate.exactEffort);
		if (
			candidate.roleId !== roleId ||
			TIER_RANK[candidate.tier] < TIER_RANK[minimum.tier] ||
			effort === undefined ||
			effort < minimum.effort
		)
			continue;
		const key = exactModelKey(candidate);
		const current = retained.get(key);
		if (!current || preferredEffort(candidate, current) < 0)
			retained.set(key, candidate);
	}
	const kept = new Set(retained.values());
	return HARNESS_ORDER.flatMap((harness) => {
		const survivors = candidates.filter(
			(candidate) => kept.has(candidate) && candidate.harness === harness,
		);
		return survivors.length > 0
			? [Object.freeze({ harness, candidates: Object.freeze(survivors) })]
			: [];
	});
}

/** Why Batch A evidence cannot be consumed for this snapshot, if it cannot. */
function batchABindingProblem(
	snapshot: AutoPolicySnapshot<AutoPolicyCandidate>,
	evidence: JevBatchEvidence,
): string | undefined {
	if (!validatedEvidence.has(evidence))
		return "Batch A evidence was not produced by validateJevEvidence.";
	const batch = evidence.batch;
	if (
		batch.batch !== "A" ||
		batch.decisionId !== snapshot.decisionId ||
		batch.snapshotHash !== snapshot.snapshotHash
	)
		return "The evidence does not answer this decision's Batch A.";
	if (
		snapshot.policyVersion !== AUTO_ROUTING_POLICY_VERSION ||
		snapshot.questionVersion !== AUTO_ROUTING_QUESTION_VERSION
	)
		return `The snapshot is not bound to ${AUTO_ROUTING_POLICY_VERSION} and ${AUTO_ROUTING_QUESTION_VERSION}.`;
	const roleIds = snapshot.roles.map((role) => role.id);
	const ids = JEV_QUESTION_IDS;
	if (
		!sameKeys(evidence.choices, [ids.role]) ||
		!offersExactly(evidence.choices[ids.role], [...roleIds, JEV_NONE_OPTION]) ||
		!sameKeys(evidence.scores, [ids.reasoning, ids.consequence]) ||
		!sameKeys(evidence.nouls, [
			...roleIds.map(jevRoleFitQuestionId),
			ids.mutation,
			...JEV_NEGATIVE_NOUL_GATES.map((gate) => gate.id),
		])
	)
		return "Batch A evidence does not answer exactly this snapshot's questions.";
	return undefined;
}

/**
 * The deterministic `jev-auto-v1` decision after Batch A (§5.4): negative
 * Noul gates, the role Choice with absolute fit and overlap, mutation
 * intent, review provenance, the required band, and host effort filtering.
 * It returns the plan that is the only valid Batch B input, or a reasoned
 * abstention. The winner is never replaced by its runner-up.
 */
export function decideAfterBatchA<C extends AutoPolicyCandidate>(
	snapshot: AutoPolicySnapshot<C>,
	evidence: JevBatchEvidence,
	thresholds: AutoRoutingThresholds,
): AutoBatchAOutcome<C> {
	const problem = batchABindingProblem(snapshot, evidence);
	if (problem) return unusable(problem);
	const { nouls } = evidence;
	for (const gate of JEV_NEGATIVE_NOUL_GATES)
		if (nouls[gate.id] >= thresholds.trueFloor) return abstain(gate.reason);
	if (
		JEV_NEGATIVE_NOUL_GATES.some(
			(gate) => nouls[gate.id] > thresholds.falseCeiling,
		)
	)
		return abstain("semantic-uncertainty");

	const winner = confidentChoice(
		evidence.choices[JEV_QUESTION_IDS.role],
		thresholds,
	);
	if (winner === undefined) return abstain("choice-uncertain");
	if (winner === JEV_NONE_OPTION) return abstain("no-role-fit");
	const role = snapshot.roles.find((entry) => entry.id === winner);
	if (!role) return unusable("The chosen role is not in the snapshot.");
	const fit = nouls[jevRoleFitQuestionId(role.id)];
	if (fit < thresholds.absoluteFit) return abstain("role-fit-insufficient");
	for (const other of snapshot.roles) {
		if (other.id === role.id) continue;
		const otherFit = nouls[jevRoleFitQuestionId(other.id)];
		if (
			otherFit >= thresholds.trueFloor &&
			!atLeast(fit - otherFit, thresholds.choiceMargin)
		)
			return abstain("role-overlap");
	}

	const mutation = nouls[JEV_QUESTION_IDS.mutation];
	if (mutation <= thresholds.falseCeiling) {
		if (role.approval.intent !== "report") return abstain("intent-mismatch");
	} else if (mutation >= thresholds.trueFloor) {
		if (role.approval.intent !== "modify") return abstain("intent-mismatch");
	} else return abstain("mutation-uncertain");

	if (role.approval.purpose === "review")
		return abstain("review-provenance-required");

	const requiredBand = deriveRequiredBand(
		evidence.scores[JEV_QUESTION_IDS.reasoning],
		evidence.scores[JEV_QUESTION_IDS.consequence],
		thresholds,
	);
	const runtimes = sufficientRuntimes(
		snapshot.candidates,
		role.id,
		requiredBand,
	);
	if (runtimes.length === 0) return abstain("no-sufficient-runtime");
	const plan: AutoBatchBPlan<C> = Object.freeze({
		decisionId: snapshot.decisionId,
		snapshotHash: snapshot.snapshotHash,
		policyVersion: snapshot.policyVersion,
		questionVersion: snapshot.questionVersion,
		prompt: snapshot.task,
		role,
		requiredBand,
		runtimes: Object.freeze(runtimes),
	});
	batchBPlans.add(plan);
	return Object.freeze({ kind: "continue", plan });
}

/** Why Batch B evidence cannot be consumed for this plan, if it cannot. */
function batchBBindingProblem(
	plan: AutoBatchBPlan<AutoPolicyCandidate>,
	evidence: JevBatchEvidence,
): string | undefined {
	if (!batchBPlans.has(plan))
		return "The Batch B plan was not produced by decideAfterBatchA.";
	if (!validatedEvidence.has(evidence))
		return "Batch B evidence was not produced by validateJevEvidence.";
	const batch = evidence.batch;
	if (
		batch.batch !== "B" ||
		batch.decisionId !== plan.decisionId ||
		batch.snapshotHash !== plan.snapshotHash ||
		batch.roleId !== plan.role.id ||
		batch.requiredBand !== plan.requiredBand
	)
		return "The evidence does not answer this plan's Batch B.";
	const models = plan.runtimes.map((runtime) =>
		jevModelQuestionId(runtime.harness),
	);
	if (
		!sameKeys(evidence.scores, []) ||
		!sameKeys(evidence.nouls, []) ||
		!sameKeys(evidence.choices, [JEV_QUESTION_IDS.runtime, ...models]) ||
		!offersExactly(evidence.choices[JEV_QUESTION_IDS.runtime], [
			...plan.runtimes.map((runtime) => runtime.harness),
			JEV_EQUIVALENT_OPTION,
			JEV_NONE_OPTION,
		]) ||
		plan.runtimes.some(
			(runtime) =>
				!offersExactly(evidence.choices[jevModelQuestionId(runtime.harness)], [
					...runtime.candidates.map((candidate) => candidate.id),
					JEV_EQUIVALENT_OPTION,
					JEV_NONE_OPTION,
				]),
		)
	)
		return "Batch B evidence does not answer exactly this plan's questions.";
	return undefined;
}

const byPreference = (left: AutoPolicyCandidate, right: AutoPolicyCandidate) =>
	left.profile.preference - right.profile.preference ||
	(left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * Host tie-break for a confident `equivalent` runtime: the role's own
 * harness when it survives, else the harness holding the lowest
 * administrator preference, then `pi`, `claude`, `kiro`. It is policy, not
 * evidence that the default is better.
 */
function equivalentRuntime<C extends AutoPolicyCandidate>(
	plan: AutoBatchBPlan<C>,
): AutoBatchBRuntime<C> {
	const own = plan.role.role.cli ?? "pi";
	const owned = plan.runtimes.find((runtime) => runtime.harness === own);
	if (owned) return owned;
	let best = plan.runtimes[0];
	let lowest = Math.min(
		...best.candidates.map((candidate) => candidate.profile.preference),
	);
	for (const runtime of plan.runtimes.slice(1)) {
		const preference = Math.min(
			...runtime.candidates.map((candidate) => candidate.profile.preference),
		);
		if (preference < lowest) {
			best = runtime;
			lowest = preference;
		}
	}
	return best;
}

/**
 * The deterministic `jev-auto-v1` route after Batch B (§5.7): gate the
 * runtime Choice, then only the chosen runtime's model Choice. `none`
 * abstains; a confident `equivalent` uses the host tie-breaks. A model
 * abstention never falls back to another harness. The result is one
 * approved local tuple, never classifier-supplied launch parameters.
 */
export function decideAfterBatchB<C extends AutoPolicyCandidate>(
	plan: AutoBatchBPlan<C>,
	evidence: JevBatchEvidence,
	thresholds: AutoRoutingThresholds,
): AutoBatchBOutcome<C> {
	const problem = batchBBindingProblem(plan, evidence);
	if (problem) return unusable(problem);
	const runtimeChoice = confidentChoice(
		evidence.choices[JEV_QUESTION_IDS.runtime],
		thresholds,
	);
	if (runtimeChoice === undefined) return abstain("choice-uncertain");
	if (runtimeChoice === JEV_NONE_OPTION) return abstain("no-runtime-fit");
	const runtime =
		runtimeChoice === JEV_EQUIVALENT_OPTION
			? equivalentRuntime(plan)
			: plan.runtimes.find((entry) => entry.harness === runtimeChoice);
	if (!runtime) return unusable("The chosen runtime is not in the plan.");

	const modelChoice = confidentChoice(
		evidence.choices[jevModelQuestionId(runtime.harness)],
		thresholds,
	);
	if (modelChoice === undefined) return abstain("choice-uncertain");
	if (modelChoice === JEV_NONE_OPTION) return abstain("no-model-fit");
	const candidate =
		modelChoice === JEV_EQUIVALENT_OPTION
			? [...runtime.candidates].sort(byPreference)[0]
			: runtime.candidates.find((entry) => entry.id === modelChoice);
	if (!candidate) return unusable("The chosen tuple is not in the plan.");

	return Object.freeze({
		kind: "selected",
		decision: Object.freeze({
			kind: "selected",
			candidateId: candidate.id,
			requiredBand: plan.requiredBand,
			decisionId: plan.decisionId,
			snapshotHash: plan.snapshotHash,
		}),
		route: Object.freeze({
			agent: plan.role.approval.agent,
			harness: candidate.harness,
			exactModel: candidate.exactModel,
			exactEffort: candidate.exactEffort,
			candidateId: candidate.id,
			roleFingerprint: candidate.roleFingerprint,
			policyVersion: plan.policyVersion,
			questionVersion: plan.questionVersion,
			decisionId: plan.decisionId,
		}),
		candidate,
	});
}
