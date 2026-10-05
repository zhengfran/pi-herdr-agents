/**
 * The advisory `jev_router` invocation.
 *
 * It recommends configured route names from an explicit bounded brief and the
 * route names and descriptions, and nothing else. It never launches, selects a
 * model or effort, reads task files or history automatically, or changes any route. One call is
 * one classifier batch, one attempted request, zero retries, under one
 * deadline that starts before any asynchronous credential work. Configuration
 * and route drift, revocation, cancellation, generation change, and the
 * deadline are re-checked synchronously at the final forwarding boundary,
 * after Pi's own authentication, so a late completion sends and resurrects
 * nothing. Pi's configured authentication takes precedence; the fixed key file
 * is consulted only when it is absent and its value never leaves the
 * request-local `apiKey` option.
 */
import { isFiniteNumber } from "./type-guards.ts";
import type { AutoUnavailableReason } from "./auto-routing-policy.ts";
import type { LoadedJevRouterConfig } from "./jev-router-config.ts";
import {
	JEV_ROUTER_POLICY_VERSION,
	JEV_ROUTER_QUESTION_VERSION,
} from "./jev-router-config.ts";
import {
	validateJevAdvisoryEvidence,
	type JevAdvisoryEvidence,
	type JevAdvisoryEvidenceFailureReason,
} from "./jev-router-evidence.ts";
import {
	JEV_ROUTER_RESULT_SCHEMA,
	interpretJevAdvisoryEvidence,
	jevAdvisoryRouteSnapshotHash,
	type JevRouterReasonCode,
	type JevRouterResult,
} from "./jev-router-policy.ts";
import {
	JEV_ADVISORY_LIMITS,
	buildJevAdvisoryBatch,
	jevAdvisoryRouteStates,
	type JevAdvisoryBatch,
	type JevAdvisoryRoute,
} from "./jev-router-questions.ts";
import { readFallbackJevKey, type JevKeySource } from "./jev-router-auth.ts";
import {
	createJevDeadline,
	runJevClassification,
	type JevClassifierRegistry,
	type JevFetch,
} from "./jev-transport.ts";

/** What a load or a fresh read of the advisory inputs yields. */
export type JevRouterInputs = Readonly<{
	config: LoadedJevRouterConfig;
	/** Configured route names and descriptions; undefined when unreadable. */
	routes: readonly JevAdvisoryRoute[] | undefined;
}>;

export type JevRouterOptions = Readonly<{
	/** The inputs this extension generation loaded; they define consent. */
	loaded: JevRouterInputs;
	/** A fresh synchronous read of the durable inputs, for drift checks. */
	readCurrent: () => JevRouterInputs;
	/** Whether this process is an eligible top-level parent, asked per call. */
	parent: () => boolean;
	/** Aborted on shutdown, reload, or session replacement of this generation. */
	generation?: AbortSignal;
	fetch?: JevFetch;
	now?: () => number;
	/** Request-local key fallback; defaults to the fixed `~/.jev/JEV_KEY` reader. */
	keySource?: JevKeySource;
}>;

export type JevRouterInvocation = Readonly<{
	task: string | undefined;
	context?: string;
	signal?: AbortSignal;
	registry: JevClassifierRegistry;
}>;

export type JevRouter = Readonly<{
	invoke(invocation: JevRouterInvocation): Promise<JevRouterResult>;
}>;

// SAFETY: every key below is a literal member of JevRouterReasonCode.
const REASON_MESSAGES = new Map<JevRouterReasonCode, string>(
	Object.entries({
		disabled: "jev_router is disabled in the durable config; route manually.",
		"consent-missing":
			"jev_router has no valid egress consent; route manually.",
		"config-invalid":
			"The jevRouter config is invalid; fix it and reload, or route manually.",
		"config-changed":
			"The jevRouter config or configured routes changed since load; reload, or route manually.",
		"parent-only":
			"jev_router is available only to the top-level parent session.",
		"no-routes": "No routes are configured; there is nothing to recommend.",
		"invalid-input": "The task or context is not acceptable; nothing was sent.",
		"request-too-large":
			"The request does not fit the advisory size bounds; nothing was sent. Route manually.",
		busy: "Another jev_router call is in flight; nothing was sent. Route manually or retry later.",
		"auth-unavailable":
			"No usable TypeSafe authentication was available or it was rejected; no fallback was attempted. Route manually.",
		"model-unavailable":
			"The pinned classifier is unavailable. Route manually.",
		"endpoint-rejected":
			"The classifier endpoint check failed. Route manually.",
		timeout:
			"The classifier did not answer within its deadline. Route manually.",
		"http-error": "The classifier request failed. Route manually.",
		"response-too-large":
			"The classifier response exceeded its bound. Route manually.",
		"invalid-response":
			"The classifier response was not valid. Route manually.",
		"adapter-incompatible":
			"The host classifier adapter is incompatible. Route manually.",
		cancelled: "The advisory call was cancelled; nothing is launched.",
	}) as Array<[JevRouterReasonCode, string]>,
);

const TRANSPORT_REASONS = {
	"jev-timeout": "timeout",
	"jev-auth-unavailable": "auth-unavailable",
	"jev-model-unavailable": "model-unavailable",
	"jev-endpoint-rejected": "endpoint-rejected",
	"jev-request-too-large": "request-too-large",
	"jev-response-too-large": "response-too-large",
	"jev-http-error": "http-error",
	"jev-invalid-response": "invalid-response",
	"jev-adapter-incompatible": "adapter-incompatible",
	"request-record-failed": "adapter-incompatible",
	"stale-snapshot": "config-changed",
	"launch-rejected": "adapter-incompatible",
} as const satisfies Record<AutoUnavailableReason, JevRouterReasonCode>;

const EVIDENCE_REASONS = {
	"invalid-response": "jev-invalid-response",
	"model-unavailable": "jev-model-unavailable",
	"adapter-incompatible": "jev-adapter-incompatible",
} as const satisfies Record<
	JevAdvisoryEvidenceFailureReason,
	AutoUnavailableReason
>;

/** The route projection a drift comparison uses. */
function routeSnapshot(routes: readonly JevAdvisoryRoute[] | undefined) {
	return routes === undefined
		? undefined
		: jevAdvisoryRouteSnapshotHash(jevAdvisoryRouteStates(routes));
}

/** Pi's reported catalog cost for the call, only when it is a finite number. */
function reportedCost(result: any): number | null {
	const total = result?.usage?.cost?.total;
	return isFiniteNumber(total) && total >= 0 ? total : null;
}

export function createJevRouter(options: JevRouterOptions): JevRouter {
	const now = options.now ?? (() => performance.now());
	const keySource = options.keySource ?? readFallbackJevKey;
	let inFlight = false;

	const invoke = async (
		invocation: JevRouterInvocation,
	): Promise<JevRouterResult> => {
		const started = now();
		const finish = (
			status: JevRouterResult["status"],
			fields: Partial<JevRouterResult>,
		): JevRouterResult =>
			Object.freeze({
				schema: JEV_ROUTER_RESULT_SCHEMA,
				advisory: true,
				questionVersion: JEV_ROUTER_QUESTION_VERSION,
				policyVersion: JEV_ROUTER_POLICY_VERSION,
				calibration: "uncalibrated",
				status,
				recommendedRoute: null,
				reasonCodes: [],
				detail: null,
				routeSnapshotHash: null,
				evidence: null,
				usage: null,
				...fields,
				elapsedMs: Math.max(0, Math.round(now() - started)),
			});
		const refuse = (
			reason: JevRouterReasonCode,
			detail?: string,
			fields: Partial<JevRouterResult> = {},
		) =>
			finish(reason === "cancelled" ? "cancelled" : "unavailable", {
				reasonCodes: [reason],
				detail: detail ?? REASON_MESSAGES.get(reason) ?? null,
				...fields,
			});

		// Local gates first: none of these resolves authentication or reads a key.
		if (!options.parent()) return refuse("parent-only");
		const loaded = options.loaded;
		if (loaded.config.status === "invalid") return refuse("config-invalid");
		if (loaded.config.status === "off") return refuse("disabled");
		const config = loaded.config.config;
		const loadedDigest = loaded.config.digest;
		const routes = loaded.routes;
		if (routes === undefined) return refuse("config-invalid");
		if (routes.length === 0) return refuse("no-routes");
		if (inFlight) return refuse("busy");
		const built = buildJevAdvisoryBatch({
			task: invocation.task,
			context: invocation.context,
			routes,
		});
		if (!built.ok) return refuse(built.reason, built.detail);
		const batch: JevAdvisoryBatch = built.batch;
		const snapshotHash = jevAdvisoryRouteSnapshotHash(batch.routes);

		const signals = [invocation.signal, options.generation];
		const aborted = () =>
			signals.some((signal) => signal !== undefined && signal.aborted);
		if (aborted()) return refuse("cancelled");

		/** Whether the durable consent, settings, and routes still match the load. */
		const unchanged = (): boolean => {
			try {
				const current = options.readCurrent();
				return (
					current.config.status === "enabled" &&
					current.config.digest === loadedDigest &&
					routeSnapshot(current.routes) === snapshotHash
				);
			} catch {
				return false;
			}
		};
		if (!unchanged()) return refuse("config-changed");

		inFlight = true;
		try {
			const deadline = createJevDeadline(config.timeoutMs, now);
			let drifted = false;
			let cost: number | null = null;
			const outcome = await runJevClassification<JevAdvisoryEvidence>({
				registry: invocation.registry,
				fetch: options.fetch,
				now,
				maxResponseBytes: JEV_ADVISORY_LIMITS.maxResponseBytes,
				context: batch.context,
				wireBody: batch.wireBody,
				label: "advisory",
				deadline,
				signals,
				credential: keySource,
				authorize: () => {
					if (aborted() || deadline.expired()) return false;
					if (unchanged()) return true;
					drifted = true;
					return false;
				},
				validate: (observation) => {
					const validation = validateJevAdvisoryEvidence(batch, observation);
					if (!validation.ok)
						return {
							ok: false,
							reason: EVIDENCE_REASONS[validation.reason],
							detail: validation.detail,
						};
					cost = reportedCost(observation.result);
					return { ok: true, value: validation.evidence };
				},
			});
			if (drifted)
				return refuse("config-changed", undefined, {
					routeSnapshotHash: snapshotHash,
				});
			if (outcome.status === "cancelled")
				return refuse("cancelled", undefined, {
					routeSnapshotHash: snapshotHash,
				});
			if (outcome.status === "unavailable")
				return refuse(TRANSPORT_REASONS[outcome.reason], outcome.detail, {
					routeSnapshotHash: snapshotHash,
				});
			const interpretation = interpretJevAdvisoryEvidence(batch, outcome.value);
			return finish(interpretation.status, {
				recommendedRoute: interpretation.recommendedRoute,
				reasonCodes: interpretation.reasonCodes,
				routeSnapshotHash: snapshotHash,
				evidence: interpretation.evidence,
				usage: Object.freeze({
					inputTokens: outcome.value.usage.inputTokens,
					outputTokens: outcome.value.usage.outputTokens,
					catalogCostUsd: cost,
				}),
			});
		} finally {
			inFlight = false;
		}
	};
	return Object.freeze({ invoke });
}

/** Bounded model-facing text; it never echoes the task, context, or provider text. */
export function formatJevRouterResult(result: JevRouterResult): string {
	const lines: string[] = [];
	if (result.status === "recommendation")
		lines.push(
			`Advisory recommendation: route "${result.recommendedRoute}". This is uncalibrated evidence, not permission or model selection; you may override it. Call subagent with route set to it, and preserve existing author-family, permission, workspace, and verification requirements.`,
		);
	else if (result.status === "uncertain")
		lines.push(
			"Advisory result: uncertain; no route is recommended. Choose manually, decompose multi-stage work yourself, or gather missing context first.",
		);
	else
		lines.push(
			`Advisory result: ${result.status}. ${result.detail ?? ""}`.trim(),
			"Nothing was launched; continue with manual routing.",
		);
	if (result.reasonCodes.length > 0)
		lines.push(`Reasons: ${result.reasonCodes.join(", ")}.`);
	const evidence = result.evidence;
	if (evidence) {
		const fits = evidence.routeFits
			.map((fit) => `${fit.route}=${fit.answer.probabilities.yes.toFixed(2)}`)
			.join(", ");
		lines.push(
			`Primary: ${evidence.primaryRoute.route ?? "none"} (confidence ${evidence.primaryRoute.confidence.toFixed(2)}). Route fit P(yes): ${fits}.`,
			`Shape: ${evidence.taskStages.choice}; context: ${evidence.contextSufficiency.choice}; difficulty: ${evidence.reasoningDifficulty.choice}; risk: ${evidence.consequenceRisk.choice} (informational only; never changes candidate models or effort).`,
		);
	}
	lines.push(`Elapsed ${result.elapsedMs} ms.`);
	return lines.join("\n");
}
