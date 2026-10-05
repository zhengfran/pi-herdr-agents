/**
 * Strict Choice-only decoder for one advisory classifier call.
 *
 * The whole response is validated before any answer is consumed: exactly the
 * expected question and option keys, own plain-data members, finite
 * probabilities and confidence, distributions summing to one, a returned
 * choice with the maximal probability, the exact pinned wire model, and Pi's
 * normalized answers and usage agreeing with the observed wire. Nothing is
 * filled, clamped, renormalized, or accepted partially, and failure details
 * never echo response content. The numeric tolerances are the automatic v1
 * decoder's; this module leaves that decoder untouched.
 */
import {
	AUTO_ROUTING_JEV_API,
	AUTO_ROUTING_JEV_MODEL,
	AUTO_ROUTING_JEV_PROVIDER,
	JEV_EVIDENCE_TOLERANCES,
} from "./auto-routing-policy.ts";
import type { JevAdvisoryBatch } from "./jev-router-questions.ts";
import type { JevTransportObservation } from "./jev-transport.ts";
import { isFiniteNumber, isRecord, type JsonObject } from "./type-guards.ts";

export type JevAdvisoryChoiceEvidence = Readonly<{
	choice: string;
	probabilities: Readonly<Record<string, number>>;
	confidence: number;
}>;

export type JevAdvisoryEvidence = Readonly<{
	choices: Readonly<Record<string, JevAdvisoryChoiceEvidence>>;
	usage: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

export type JevAdvisoryEvidenceFailureReason =
	| "invalid-response"
	| "model-unavailable"
	| "adapter-incompatible";

export type JevAdvisoryEvidenceValidation =
	| Readonly<{ ok: true; evidence: JevAdvisoryEvidence }>
	| Readonly<{
			ok: false;
			reason: JevAdvisoryEvidenceFailureReason;
			detail: string;
	  }>;

class EvidenceError extends Error {
	reason: JevAdvisoryEvidenceFailureReason;
	constructor(reason: JevAdvisoryEvidenceFailureReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

const invalid = (detail: string) =>
	new EvidenceError("invalid-response", detail);
const incompatible = (detail: string) =>
	new EvidenceError("adapter-incompatible", detail);

/** Binary rounding slack, as in the automatic decoder. */
const ARITHMETIC_TOLERANCE = 1e-12;
const within = (difference: number, tolerance: number) =>
	Math.abs(difference) <= tolerance + ARITHMETIC_TOLERANCE;

/** A JSON object without a forged prototype or symbol members; reads no member. */
function isPlainRecord(value: any): value is JsonObject {
	if (Object(value) !== value) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.getOwnPropertySymbols(value).length === 0;
}

/** Exactly these own enumerable data members. */
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

const isUnit = (value: any): value is number =>
	isFiniteNumber(value) && value >= 0 && value <= 1;
const isTokenCount = (value: any): value is number =>
	Number.isSafeInteger(value) && value >= 0;

function hostRecord<T>(entries: Iterable<readonly [string, T]>) {
	const record: Record<string, T> = Object.create(null);
	for (const [key, value] of entries) record[key] = value;
	return Object.freeze(record);
}

function decodeChoice(
	id: string,
	answer: any,
	options: readonly string[],
): JevAdvisoryChoiceEvidence {
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
		throw invalid(
			`${at} must be a choice answer with exactly type, choice, probabilities, and confidence.`,
		);
	const wire = answer.probabilities;
	if (!isPlainRecord(wire) || !hasExactlyKeys(wire, options))
		throw invalid(
			`${at} probabilities must cover exactly the offered options.`,
		);
	const values = options.map((option) => wire[option]);
	if (!values.every(isUnit))
		throw invalid(`${at} probabilities must be finite numbers from 0 to 1.`);
	const total = values.reduce((sum: number, value: number) => sum + value, 0);
	if (!within(total - 1, JEV_EVIDENCE_TOLERANCES.distributionSum))
		throw invalid(`${at} probabilities must sum to 1.`);
	const probabilities = hostRecord(
		options.map((option, index) => [option, values[index]] as const),
	);
	// The host's own option string; the wire string is only compared.
	const choice = options.find((option) => option === answer.choice);
	if (choice === undefined)
		throw invalid(`${at} chose an option the question does not offer.`);
	if (
		!within(
			Math.max(...values) - probabilities[choice],
			JEV_EVIDENCE_TOLERANCES.choiceMaximum,
		)
	)
		throw invalid(`${at} chose an option without the largest probability.`);
	if (!isUnit(answer.confidence))
		throw invalid(`${at} confidence must be a finite number from 0 to 1.`);
	return Object.freeze({
		choice,
		probabilities,
		confidence: answer.confidence,
	});
}

function decodeUsage(value: any): JevAdvisoryEvidence["usage"] {
	if (
		!isPlainRecord(value) ||
		!hasExactlyKeys(value, ["input_tokens", "output_tokens"])
	)
		throw invalid(
			"The classifier usage must have exactly input_tokens and output_tokens.",
		);
	if (!isTokenCount(value.input_tokens) || !isTokenCount(value.output_tokens))
		throw invalid(
			"The classifier token counts must be non-negative safe integers.",
		);
	return Object.freeze({
		inputTokens: value.input_tokens,
		outputTokens: value.output_tokens,
	});
}

/** Pi's normalized result must be the completed pinned call and agree with the wire. */
function checkNormalized(
	batch: JevAdvisoryBatch,
	result: any,
	evidence: JevAdvisoryEvidence,
): void {
	if (!isRecord(result))
		throw incompatible("Pi returned no classifier result.");
	if (result.stopReason !== "stop")
		throw incompatible(
			"Pi did not complete the classification whose response was observed.",
		);
	if (
		result.api !== AUTO_ROUTING_JEV_API ||
		result.provider !== AUTO_ROUTING_JEV_PROVIDER ||
		result.model !== AUTO_ROUTING_JEV_MODEL
	)
		throw incompatible(
			`Pi's result is not from ${AUTO_ROUTING_JEV_API} provider ${AUTO_ROUTING_JEV_PROVIDER} model ${AUTO_ROUTING_JEV_MODEL}.`,
		);
	const answers = result.answers;
	if (
		!isRecord(answers) ||
		!hasExactlyKeys(
			answers,
			batch.expected.map((question) => question.id),
		)
	)
		throw incompatible(
			"Pi's normalized answers do not cover exactly the batch's questions.",
		);
	for (const question of batch.expected) {
		const normalized = answers[question.id];
		const choice = evidence.choices[question.id];
		const probabilities = isRecord(normalized)
			? normalized.probabilities
			: undefined;
		if (
			!isRecord(normalized) ||
			normalized.type !== "choice" ||
			normalized.choice !== choice.choice ||
			normalized.confidence !== choice.confidence ||
			!isRecord(probabilities) ||
			!hasExactlyKeys(probabilities, question.options) ||
			!question.options.every(
				(option) => probabilities[option] === choice.probabilities[option],
			)
		)
			throw incompatible(
				`Pi's normalized answer ${question.id} disagrees with the observed response.`,
			);
	}
	const usage = result.usage;
	if (
		!isRecord(usage) ||
		usage.input !== evidence.usage.inputTokens ||
		usage.output !== evidence.usage.outputTokens
	)
		throw incompatible(
			"Pi's normalized usage disagrees with the observed response.",
		);
}

function decode(
	batch: JevAdvisoryBatch,
	observation: JevTransportObservation,
): JevAdvisoryEvidence {
	if (!isRecord(observation) || observation.wire === undefined)
		throw incompatible(
			"No classifier response was observed for this call; the adapter bypassed the observing fetch.",
		);
	const wire = observation.wire;
	if (
		!isPlainRecord(wire) ||
		!hasExactlyKeys(wire, ["model", "answers", "usage"])
	)
		throw invalid(
			"The classifier response must be a JSON object with exactly model, answers, and usage.",
		);
	if (wire.model !== AUTO_ROUTING_JEV_MODEL)
		throw new EvidenceError(
			"model-unavailable",
			`The classifier did not answer with the pinned model ${AUTO_ROUTING_JEV_MODEL}.`,
		);
	const answers = wire.answers;
	if (
		!isPlainRecord(answers) ||
		!hasExactlyKeys(
			answers,
			batch.expected.map((question) => question.id),
		)
	)
		throw invalid(
			"The classifier answers must cover exactly the batch's questions.",
		);
	const choices = hostRecord(
		batch.expected.map(
			(question) =>
				[
					question.id,
					decodeChoice(question.id, answers[question.id], question.options),
				] as const,
		),
	);
	const evidence = Object.freeze({ choices, usage: decodeUsage(wire.usage) });
	checkNormalized(batch, observation.result, evidence);
	return evidence;
}

/** Validate one completed call for its batch as a whole. */
export function validateJevAdvisoryEvidence(
	batch: JevAdvisoryBatch,
	observation: JevTransportObservation,
): JevAdvisoryEvidenceValidation {
	try {
		return Object.freeze({ ok: true, evidence: decode(batch, observation) });
	} catch (error) {
		if (error instanceof EvidenceError)
			return Object.freeze({
				ok: false,
				reason: error.reason,
				detail: error.message,
			});
		return Object.freeze({
			ok: false,
			reason: "invalid-response",
			detail: "The classifier response could not be decoded.",
		});
	}
}
