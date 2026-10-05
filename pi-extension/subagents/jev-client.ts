/**
 * Authenticated bounded transport for automatic routing's pinned `jev-1.13.0`
 * batches.
 *
 * This is the automatic-v1 compatibility facade over the generic bounded
 * transport in `jev-transport.ts`. It never reads, stores, or forwards a
 * credential and never supplies a fallback reader: authentication stays
 * entirely inside the host. A successful call is handed to `validateJevEvidence`,
 * which remains the only producer of usable automatic evidence, and Batch A and
 * Batch B share the one monotonic deadline the caller supplies.
 */
import {
	validateJevEvidence,
	type JevBatchEvidence,
} from "./auto-routing-policy.ts";
import type { JevBatch } from "./jev-questions.ts";
import {
	createBoundedObservingFetch as createTransportObservingFetch,
	createJevDeadline,
	runJevClassification,
	type JevBoundedObservingFetch,
	type JevBoundedObservingFetchOptions as JevTransportObservingFetchOptions,
	type JevDeadline,
	type JevTransportCancelled,
	type JevTransportFailure,
	type JevTransportOptions,
} from "./jev-transport.ts";

export {
	JEV_CLASSIFIER_ALIAS_ID,
	JEV_CLASSIFIER_ENDPOINT,
	JEV_MAX_RESPONSE_BYTES,
	JEV_PINNED_DISPLAY_NAME,
	createJevDeadline,
	requireJevResponseBound,
	resolvePinnedJevClassifier,
	type JevClassifierDescriptor,
	type JevClassifierRegistry,
	type JevDeadline,
	type JevDescriptorResolution,
	type JevFetch,
	type JevFetchObservation,
	type JevTransportCancelled,
	type JevTransportFailure,
	type JevTransportOptions,
} from "./jev-transport.ts";

export type { JevBoundedObservingFetch };

/** The automatic-v1 options: one batch instead of a raw body and label. */
export type JevBoundedObservingFetchOptions = Omit<
	JevTransportObservingFetchOptions,
	"wireBody" | "label"
> &
	Readonly<{ batch: JevBatch }>;

/** Compatibility alias for the batch-based options name. */
export type JevBoundedObservingFetchBatchOptions =
	JevBoundedObservingFetchOptions;

/** A bounded observing fetch for exactly one automatic batch and one call. */
export function createBoundedObservingFetch(
	options: JevBoundedObservingFetchOptions,
): JevBoundedObservingFetch {
	return createTransportObservingFetch({
		...options,
		wireBody: options.batch.wireBody,
		label: `Batch ${options.batch.batch}`,
	});
}

export type JevClassifyResult =
	| Readonly<{ status: "ok"; evidence: JevBatchEvidence }>
	| JevTransportFailure
	| JevTransportCancelled;

export type JevClassifyRequest = Readonly<{
	batch: JevBatch;
	/** The caller's one overall A+B deadline. */
	deadline: JevDeadline;
	/** Input, session-generation, and any other caller cancellation. */
	signals?: readonly (AbortSignal | undefined)[];
	/**
	 * Synchronous caller authorization, asked inside the observing fetch
	 * immediately before the request is forwarded, so after the host's own
	 * asynchronous authentication. A false or throwing answer forwards
	 * nothing and the call reports cancellation.
	 */
	authorize?: () => boolean;
}>;

export type JevTransport = Readonly<{
	/** Start the one overall budget, on this transport's clock. */
	createDeadline(totalMs: number): JevDeadline;
	classify(request: JevClassifyRequest): Promise<JevClassifyResult>;
}>;

export type JevClassifyOptions = JevClassifyRequest & JevTransportOptions;

/**
 * One classifier call for one automatic batch. It supplies no credential
 * reader, so a host without configured authentication is unavailable evidence.
 */
export async function classifyJevBatch(
	options: JevClassifyOptions,
): Promise<JevClassifyResult> {
	const { batch } = options;
	const outcome = await runJevClassification<JevBatchEvidence>({
		registry: options.registry,
		fetch: options.fetch,
		now: options.now,
		maxResponseBytes: options.maxResponseBytes,
		context: batch.context,
		wireBody: batch.wireBody,
		label: `Batch ${batch.batch}`,
		deadline: options.deadline,
		signals: options.signals,
		authorize: options.authorize,
		validate: (observation) => {
			const validation = validateJevEvidence(batch, observation);
			return validation.ok
				? { ok: true, value: validation.evidence }
				: validation;
		},
	});
	return outcome.status === "ok"
		? Object.freeze({ status: "ok", evidence: outcome.value })
		: outcome;
}

/**
 * A transport bound to the host registry, a fetch implementation, and one
 * monotonic clock. It is injected so tests and shadow evaluation can supply a
 * fake registry and fetch; there is no production endpoint or credential
 * setting to change.
 */
export function createJevTransport(options: JevTransportOptions): JevTransport {
	const now = options.now ?? (() => performance.now());
	return Object.freeze({
		createDeadline: (totalMs: number) => createJevDeadline(totalMs, now),
		classify: (request: JevClassifyRequest) =>
			classifyJevBatch({ ...options, ...request, now }),
	});
}
