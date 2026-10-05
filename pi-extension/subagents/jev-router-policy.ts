/**
 * Conservative interpretation `jev-advisory-policy-v1` and the public result
 * schema `jev-advisory-result-v1`.
 *
 * The thresholds are unvalidated heuristics, not measured accuracy. A route is
 * recommended only when the whole brief is established as a single bounded
 * assignment with sufficient context, the primary Choice is decisive, the
 * chosen route's independent fit is strong, and no other route also claims
 * coverage. Anything else is a valid abstention that still carries the full
 * evidence. Difficulty and risk are informational: they never select, change,
 * or filter candidate models or effort.
 */
import { createHash } from "node:crypto";
import type {
	JevAdvisoryChoiceEvidence,
	JevAdvisoryEvidence,
} from "./jev-router-evidence.ts";
import {
	JEV_ROUTER_POLICY_VERSION,
	JEV_ROUTER_QUESTION_VERSION,
} from "./jev-router-config.ts";
import {
	JEV_ADVISORY_NONE_OPTION,
	JEV_ADVISORY_QUESTION_IDS,
	jevAdvisoryFitQuestionId,
	type JevAdvisoryBatch,
	type JevAdvisoryRouteState,
} from "./jev-router-questions.ts";

export const JEV_ROUTER_RESULT_SCHEMA = "jev-advisory-result-v1";

export const JEV_ROUTER_THRESHOLDS = Object.freeze({
	primaryConfidence: 0.8,
	primaryProbability: 0.7,
	primaryMargin: 0.2,
	fitYes: 0.8,
	contextSufficient: 0.8,
	contextConfidence: 0.8,
	singleStep: 0.8,
	stagesConfidence: 0.8,
	informationalConfidence: 0.8,
	unknownMass: 0.2,
	elevatedRiskMass: 0.2,
});

export const JEV_ROUTER_REASON_CODES = [
	"disabled",
	"consent-missing",
	"config-invalid",
	"config-changed",
	"parent-only",
	"no-routes",
	"invalid-input",
	"request-too-large",
	"busy",
	"auth-unavailable",
	"model-unavailable",
	"endpoint-rejected",
	"timeout",
	"http-error",
	"response-too-large",
	"invalid-response",
	"adapter-incompatible",
	"cancelled",
	"no-route-match",
	"weak-primary",
	"weak-fit",
	"conflicting-fit",
	"context-insufficient",
	"context-unknown",
	"multi-stage",
	"shape-unknown",
	"missing-description",
	"difficulty-unknown",
	"risk-unknown",
	"elevated-risk",
] as const;
export type JevRouterReasonCode = (typeof JEV_ROUTER_REASON_CODES)[number];

export type JevRouterChoiceEvidence = Readonly<{
	choice: string;
	probabilities: Readonly<Record<string, number>>;
	confidence: number;
}>;

export type JevRouterPublicEvidence = Readonly<{
	/** `route: null` is the wire `none`, distinct from a route named `none`. */
	primaryRoute: Readonly<{
		route: string | null;
		probabilities: ReadonlyArray<
			Readonly<{ route: string | null; probability: number }>
		>;
		confidence: number;
	}>;
	routeFits: ReadonlyArray<
		Readonly<{ route: string; answer: JevRouterChoiceEvidence }>
	>;
	taskStages: JevRouterChoiceEvidence;
	contextSufficiency: JevRouterChoiceEvidence;
	reasoningDifficulty: JevRouterChoiceEvidence;
	consequenceRisk: JevRouterChoiceEvidence;
}>;

export type JevRouterResult = Readonly<{
	schema: typeof JEV_ROUTER_RESULT_SCHEMA;
	advisory: true;
	questionVersion: typeof JEV_ROUTER_QUESTION_VERSION;
	policyVersion: typeof JEV_ROUTER_POLICY_VERSION;
	calibration: "uncalibrated";
	status: "recommendation" | "uncertain" | "unavailable" | "cancelled";
	/** An exact host-owned route name, never classifier text. */
	recommendedRoute: string | null;
	reasonCodes: readonly JevRouterReasonCode[];
	/** A fixed sanitized sentence for an unavailable outcome; never provider text. */
	detail: string | null;
	routeSnapshotHash: string | null;
	evidence: JevRouterPublicEvidence | null;
	usage: Readonly<{
		inputTokens: number;
		outputTokens: number;
		catalogCostUsd: number | null;
	}> | null;
	elapsedMs: number;
}>;

/** A digest of the names and descriptions the classifier would see. */
export function jevAdvisoryRouteSnapshotHash(
	routes: readonly Pick<JevAdvisoryRouteState, "name" | "description">[],
): string {
	return createHash("sha256")
		.update(
			`pi-herdr-agents/jevRouter/routes/v1\n${JSON.stringify(
				routes.map((route) => [route.name, route.description]),
			)}`,
		)
		.digest("hex");
}

const publicChoice = (
	choice: JevAdvisoryChoiceEvidence,
): JevRouterChoiceEvidence =>
	Object.freeze({
		choice: choice.choice,
		probabilities: Object.freeze({ ...choice.probabilities }),
		confidence: choice.confidence,
	});

/** A tolerance for decimal sums so a value meeting a threshold exactly passes. */
const atLeast = (value: number, threshold: number) =>
	value >= threshold - 1e-12;

export type JevAdvisoryInterpretation = Readonly<{
	status: "recommendation" | "uncertain";
	recommendedRoute: string | null;
	reasonCodes: readonly JevRouterReasonCode[];
	evidence: JevRouterPublicEvidence;
}>;

/** Interpret complete validated evidence. Pure and deterministic. */
export function interpretJevAdvisoryEvidence(
	batch: JevAdvisoryBatch,
	evidence: JevAdvisoryEvidence,
): JevAdvisoryInterpretation {
	const t = JEV_ROUTER_THRESHOLDS;
	const ids = JEV_ADVISORY_QUESTION_IDS;
	const primary = evidence.choices[ids.primary];
	const routeByOption = new Map(batch.routes.map((route) => [route.id, route]));
	const nameOf = (option: string) =>
		option === JEV_ADVISORY_NONE_OPTION
			? null
			: (routeByOption.get(option)?.name ?? null);
	const stages = evidence.choices[ids.stages];
	const context = evidence.choices[ids.context];
	const difficulty = evidence.choices[ids.difficulty];
	const risk = evidence.choices[ids.risk];
	const fits = batch.routes.map((route) => ({
		route,
		answer: evidence.choices[jevAdvisoryFitQuestionId(route.id)],
	}));

	const publicEvidence: JevRouterPublicEvidence = Object.freeze({
		primaryRoute: Object.freeze({
			route: nameOf(primary.choice),
			probabilities: Object.freeze(
				Object.keys(primary.probabilities).map((option) =>
					Object.freeze({
						route: nameOf(option),
						probability: primary.probabilities[option],
					}),
				),
			),
			confidence: primary.confidence,
		}),
		routeFits: Object.freeze(
			fits.map(({ route, answer }) =>
				Object.freeze({ route: route.name, answer: publicChoice(answer) }),
			),
		),
		taskStages: publicChoice(stages),
		contextSufficiency: publicChoice(context),
		reasoningDifficulty: publicChoice(difficulty),
		consequenceRisk: publicChoice(risk),
	});

	const reasons: JevRouterReasonCode[] = [];
	const chosen = routeByOption.get(primary.choice);
	if (primary.choice === JEV_ADVISORY_NONE_OPTION || chosen === undefined)
		reasons.push("no-route-match");
	else {
		const chosenProbability = primary.probabilities[primary.choice];
		const runnerUp = Math.max(
			...Object.keys(primary.probabilities)
				.filter((option) => option !== primary.choice)
				.map((option) => primary.probabilities[option]),
		);
		if (
			!atLeast(primary.confidence, t.primaryConfidence) ||
			!atLeast(chosenProbability, t.primaryProbability) ||
			!atLeast(chosenProbability - runnerUp, t.primaryMargin)
		)
			reasons.push("weak-primary");
		const own = fits.find((fit) => fit.route.id === chosen.id);
		if (!own || !atLeast(own.answer.probabilities.yes, t.fitYes))
			reasons.push("weak-fit");
		if (
			fits.some(
				(fit) =>
					fit.route.id !== chosen.id &&
					atLeast(fit.answer.probabilities.yes, t.fitYes),
			)
		)
			reasons.push("conflicting-fit");
		if (chosen.description === null) reasons.push("missing-description");
	}
	if (
		!atLeast(context.probabilities.sufficient, t.contextSufficient) ||
		!atLeast(context.confidence, t.contextConfidence)
	)
		reasons.push(
			context.choice === "insufficient"
				? "context-insufficient"
				: "context-unknown",
		);
	if (
		!atLeast(stages.probabilities.single_step, t.singleStep) ||
		!atLeast(stages.confidence, t.stagesConfidence)
	)
		reasons.push(
			stages.choice === "multi_stage" ? "multi-stage" : "shape-unknown",
		);

	const recommended = reasons.length === 0 && chosen !== undefined;

	const uncertain = (answer: JevAdvisoryChoiceEvidence) =>
		answer.choice === "unknown" ||
		!atLeast(answer.confidence, t.informationalConfidence) ||
		atLeast(answer.probabilities.unknown, t.unknownMass);
	if (uncertain(difficulty)) reasons.push("difficulty-unknown");
	if (uncertain(risk)) reasons.push("risk-unknown");
	if (
		atLeast(
			risk.probabilities.shared_sensitive + risk.probabilities.severe,
			t.elevatedRiskMass,
		)
	)
		reasons.push("elevated-risk");

	return Object.freeze({
		status: recommended ? "recommendation" : "uncertain",
		recommendedRoute: recommended && chosen ? chosen.name : null,
		reasonCodes: Object.freeze(reasons),
		evidence: publicEvidence,
	});
}
