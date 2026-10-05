/**
 * Generic bounded transport for the pinned `jev-1.13.0` classifier.
 *
 * Every call goes through Pi's own public classifier seam
 * (`modelRegistry.findOfType` plus `modelRegistry.classify`) with a per-call
 * observing fetch. The observer only ever inspects the request line, the exact
 * outgoing body its caller already knows, and a bounded response. It pins the
 * model, refuses any endpoint but the approved TypeSafe System One URL, sends
 * exactly one request per call with no retries, honors one monotonic deadline,
 * ignores a late settlement, and reports only sanitized stable reasons.
 *
 * It knows nothing about routes, roles, approvals, or launching: the caller
 * supplies the expected wire body and a synchronous validator that turns the
 * observed wire plus Pi's normalized result into a caller-owned value.
 * Automatic routing (`jev-client.ts`) never supplies a credential; only the
 * advisory router supplies a request-local credential reader, and only when
 * the host reports no configured authentication.
 */
import { createHash } from "node:crypto";
import { AUTO_ROUTING_LIMITS } from "./auto-routing-config.ts";
import {
	AUTO_ROUTING_JEV_API,
	AUTO_ROUTING_JEV_MODEL,
	AUTO_ROUTING_JEV_PROVIDER,
	type AutoRoutingJevModel,
	type AutoRoutingJevProvider,
	type AutoUnavailableReason,
} from "./auto-routing-policy.ts";
import {
	isBoolean,
	isRecord,
	isString,
	type JsonObject,
} from "./type-guards.ts";

/** The only endpoint a v1 Jev request may reach. There is no override. */
export const JEV_CLASSIFIER_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/**
 * The built-in direct TypeSafe catalog entry. It is used only as the
 * transport and authentication descriptor when the exact pin is absent; no
 * request is ever made to it.
 */
export const JEV_CLASSIFIER_ALIAS_ID = "jev-latest";
/** Accurate display name of the local pinned descriptor copy. */
export const JEV_PINNED_DISPLAY_NAME = "Jev 1.13.0";
/**
 * Decoded response bound; the reader is cancelled past it. A call may lower
 * this bound but never raise or disable it.
 */
export const JEV_MAX_RESPONSE_BYTES = 64 * 1024;

type JevApi = typeof AUTO_ROUTING_JEV_API;

/**
 * The pinned classifier descriptor handed to `classify`: an immutable local
 * copy of the host catalog entry whose ID is the exact pin. A catalog entry is
 * plain JSON metadata, so the host's own transport fields travel unchanged. It
 * carries no credential.
 */
export type JevClassifierDescriptor = Readonly<
	JsonObject & {
		type: "classifier";
		id: AutoRoutingJevModel;
		name: string;
		api: JevApi;
		provider: AutoRoutingJevProvider;
		baseUrl: string;
	}
>;

/** The `fetch` shape Pi's provider transport calls. */
export type JevFetch = (input: any, init?: any) => Promise<any>;

/**
 * The host classifier seam. Exactly Pi's public `ModelRegistry` surface this
 * transport needs; no authentication accessor is part of it, so a credential
 * cannot be read through it.
 */
export type JevClassifierRegistry = Readonly<{
	findOfType(type: "classifier", provider: string, modelId: string): any;
	/** Provider-level local check only; it performs no request. */
	hasConfiguredAuth(model: any): boolean;
	classify(model: any, context: any, options: any): Promise<any>;
}>;

/** One monotonic budget shared by Batch A and Batch B. */
export type JevDeadline = Readonly<{
	totalMs: number;
	/** Milliseconds left, never negative. */
	remainingMs(): number;
	expired(): boolean;
}>;

/** Why a completed or refused call yields no evidence. */
export type JevTransportFailure = Readonly<{
	status: "unavailable";
	reason: AutoUnavailableReason;
	/**
	 * A sanitized stable sentence. It never contains the prompt, a header, a
	 * request or response body, a credential, or a provider error echo.
	 */
	detail: string;
}>;

/** Cancellation always holds; the caller owns its reason code. */
export type JevTransportCancelled = Readonly<{ status: "cancelled" }>;

export const CANCELLED: JevTransportCancelled = Object.freeze({
	status: "cancelled",
});

const defaultNow = () => performance.now();

/** Discards a settled value; used only where an outcome is irrelevant. */
const noop = () => undefined;

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

const fingerprint = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");

function unavailable(
	reason: AutoUnavailableReason,
	detail: string,
): JevTransportFailure {
	return Object.freeze({ status: "unavailable", reason, detail });
}

/** The expected outcome when the host failed before sending any request. */
const authUnavailable = () =>
	unavailable(
		"jev-auth-unavailable",
		`The host could not authenticate a ${AUTO_ROUTING_JEV_PROVIDER} classifier request; none was sent.`,
	);

/**
 * A refusal or observation this transport itself decided. Its reason and
 * detail are already sanitized, so they can be reported unchanged.
 */
class JevTransportError extends Error {
	reason: AutoUnavailableReason;

	constructor(reason: AutoUnavailableReason, detail: string) {
		super(detail);
		this.name = "JevTransportError";
		this.reason = reason;
	}
}

/** A sanitized refusal, thrown at the point that decided it. */
const refusal = (reason: AutoUnavailableReason, detail: string) =>
	new JevTransportError(reason, detail);

/**
 * The decoded response bound for one call. It defaults to the pinned 64 KiB
 * maximum and may only be lowered, so a caller or test can tighten the bound
 * but never widen or disable it.
 */
export function requireJevResponseBound(bound: number | undefined): number {
	if (bound === undefined) return JEV_MAX_RESPONSE_BYTES;
	if (
		!Number.isSafeInteger(bound) ||
		bound <= 0 ||
		bound > JEV_MAX_RESPONSE_BYTES
	)
		throw new TypeError(
			`A Jev response bound must be a safe integer from 1 to ${JEV_MAX_RESPONSE_BYTES} bytes.`,
		);
	return bound;
}

/**
 * The one monotonic overall deadline. `remainingMs` is what each batch may
 * still spend, including the host's own authentication resolution.
 */
export function createJevDeadline(
	totalMs: number,
	now: () => number = defaultNow,
): JevDeadline {
	if (
		!Number.isSafeInteger(totalMs) ||
		totalMs < AUTO_ROUTING_LIMITS.minTimeoutMs ||
		totalMs > AUTO_ROUTING_LIMITS.maxTimeoutMs
	)
		throw new TypeError(
			`A Jev deadline must be a safe integer from ${AUTO_ROUTING_LIMITS.minTimeoutMs} to ${AUTO_ROUTING_LIMITS.maxTimeoutMs} milliseconds.`,
		);
	const started = now();
	const spent = () => Math.max(0, now() - started);
	// Whole milliseconds: the host's own timeout signal rejects a fractional
	// delay, and rounding down never lends time the budget does not have.
	const remaining = () => Math.max(0, Math.floor(totalMs - spent()));
	return Object.freeze({
		totalMs,
		remainingMs: remaining,
		expired: () => remaining() <= 0,
	});
}

/** The request URL Pi's TypeSafe System One transport builds for a base URL. */
function classifierEndpoint(baseUrl: any): string | undefined {
	if (!isString(baseUrl) || baseUrl.trim() === "") return undefined;
	try {
		return new URL("systemone", `${baseUrl.replace(/\/+$/u, "")}/`).href;
	} catch {
		return undefined;
	}
}

/**
 * Why a catalog entry cannot carry the pin, or undefined when it can. It must
 * be the approved TypeSafe System One classifier reaching the approved
 * endpoint; anything else is unavailable evidence.
 */
function descriptorProblem(entry: any): string | undefined {
	if (!isRecord(entry)) return "the catalog entry is not a model descriptor";
	if (entry.type !== "classifier") return "it is not a classifier model";
	if (entry.api !== AUTO_ROUTING_JEV_API)
		return `its API is not ${AUTO_ROUTING_JEV_API}`;
	if (entry.provider !== AUTO_ROUTING_JEV_PROVIDER)
		return `its provider is not ${AUTO_ROUTING_JEV_PROVIDER}`;
	if (classifierEndpoint(entry.baseUrl) !== JEV_CLASSIFIER_ENDPOINT)
		return `it does not reach ${JEV_CLASSIFIER_ENDPOINT}`;
	return undefined;
}

export type JevDescriptorResolution =
	| Readonly<{
			ok: true;
			descriptor: JevClassifierDescriptor;
			/** Whether the exact pin was itself in the catalog. */
			pinned: boolean;
	  }>
	| Readonly<{ ok: false; reason: AutoUnavailableReason; detail: string }>;

/**
 * The exact authenticated pinned classifier descriptor.
 *
 * `jev-1.13.0` is looked up first. Only its complete absence permits using
 * the built-in `jev-latest` entry as the transport and authentication
 * descriptor, and then only as an immutable local copy whose ID is the pin: no
 * catalog is mutated and no request is made to the alias. A present but
 * unsuitable pin is unavailable evidence, never permission to use the alias.
 */
export function resolvePinnedJevClassifier(
	registry: JevClassifierRegistry,
): JevDescriptorResolution {
	let pinned: any;
	let alias: any;
	try {
		pinned = registry.findOfType(
			"classifier",
			AUTO_ROUTING_JEV_PROVIDER,
			AUTO_ROUTING_JEV_MODEL,
		);
		if (pinned === undefined || pinned === null)
			alias = registry.findOfType(
				"classifier",
				AUTO_ROUTING_JEV_PROVIDER,
				JEV_CLASSIFIER_ALIAS_ID,
			);
	} catch {
		return Object.freeze({
			ok: false,
			reason: "jev-adapter-incompatible",
			detail: "The host classifier registry could not be queried.",
		});
	}
	const found = pinned ?? alias;
	if (found === undefined || found === null)
		return Object.freeze({
			ok: false,
			reason: "jev-model-unavailable",
			detail: `No ${AUTO_ROUTING_JEV_PROVIDER} classifier is available for ${AUTO_ROUTING_JEV_MODEL}.`,
		});
	const problem = descriptorProblem(found);
	if (problem)
		return Object.freeze({
			ok: false,
			reason: "jev-model-unavailable",
			detail: `The ${AUTO_ROUTING_JEV_PROVIDER} classifier cannot carry ${AUTO_ROUTING_JEV_MODEL} because ${problem}.`,
		});
	// An own-property copy keeps the host's transport metadata and replaces
	// only the identity, so the request is for the pin and nothing else.
	const copy: JsonObject = {};
	for (const [key, value] of Object.entries(found)) {
		// SAFETY: Pi's public classifier catalog contract defines model entries as
		// JSON metadata; `found` is that host-owned entry after record validation.
		copy[key] = value as JsonObject[string];
	}
	copy.id = AUTO_ROUTING_JEV_MODEL;
	copy.name = JEV_PINNED_DISPLAY_NAME;
	// SAFETY: descriptorProblem checked type, api, provider, and the endpoint
	// of `found`, and the two identity fields were just written, so the frozen
	// copy satisfies every field of the descriptor contract.
	const descriptor = Object.freeze(copy) as JevClassifierDescriptor;
	return Object.freeze({
		ok: true,
		descriptor,
		pinned: pinned !== undefined && pinned !== null,
	});
}

/** What one bounded observing fetch saw for one batch. */
export type JevFetchObservation = Readonly<{
	/** Attempted requests; more than one breaks the one-request contract. */
	requests: number;
	/** The observed HTTP status, when a response arrived. */
	status?: number;
	/** The parsed success body of this call, released by `close`. */
	wire?: any;
	/** The redirect mode this observer forwarded. */
	redirect?: string;
	/** Why the observer refused, when it did. */
	rejection?: Readonly<{ reason: AutoUnavailableReason; detail: string }>;
	/** The caller withdrew authorization before anything was forwarded. */
	withdrawn?: true;
}>;

/** The observation under construction; only `observe` ever exposes it. */
type MutableFetchObservation = {
	requests: number;
	status?: number;
	wire?: any;
	redirect?: string;
	rejection?: Readonly<{ reason: AutoUnavailableReason; detail: string }>;
	withdrawn?: true;
};

export type JevBoundedObservingFetch = Readonly<{
	/** Pass this to `classify`; it is bound to one batch and one call. */
	fetch: JevFetch;
	observe(): JevFetchObservation;
	/** Release the raw body and refuse any later observation. */
	close(): void;
}>;

export type JevBoundedObservingFetchOptions = Readonly<{
	/** The exact serialized request body this call may forward. */
	wireBody: string;
	/** Names the request in a sanitized refusal, e.g. `Batch A`. */
	label: string;
	fetch?: JevFetch;
	/** A lower decoded response bound; it may never exceed 64 KiB. */
	maxResponseBytes?: number;
	/** Asked synchronously right before forwarding; false forwards nothing. */
	authorize?: () => boolean;
}>;

/** Cancel a response body without reading it, ignoring cancellation errors. */
function discardBody(response: any): void {
	try {
		const body = response?.body;
		if (body instanceof ReadableStream) ignoreOutcome(body.cancel());
	} catch {
		// A body that cannot be cancelled is released with the response.
	}
}

/**
 * Discard a cancellation outcome without awaiting it. A stream that is already
 * errored, or whose source rejects its cancel algorithm, must not hang this
 * call or surface as an unhandled rejection. `Promise.resolve` adopts a
 * thenable from any realm, so a rejection handler is attached immediately.
 */
function ignoreOutcome(result: any): void {
	try {
		void Promise.resolve(result).then(noop, noop);
	} catch {
		// Nothing about a cancellation outcome can affect this call.
	}
}

/** The advertised decoded length, when the response states a usable one. */
function advertisedLength(response: any): number | undefined {
	const headers = response?.headers;
	if (!(headers instanceof Headers)) return undefined;
	let raw: string | null;
	try {
		raw = headers.get("content-length");
	} catch {
		return undefined;
	}
	if (raw === null || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The response body, refused as soon as it passes the bound.
 *
 * Only a readable byte stream of this realm can be bounded chunk by chunk, so
 * anything else fails closed: there is no buffering fallback that would read a
 * whole body of unknown size.
 */
async function readBounded(
	response: any,
	maxBytes: number,
): Promise<Uint8Array> {
	const tooLarge = () =>
		refusal(
			"jev-response-too-large",
			`The classifier response exceeds the ${maxBytes}-byte bound.`,
		);
	const advertised = advertisedLength(response);
	if (advertised !== undefined && advertised > maxBytes) {
		discardBody(response);
		throw tooLarge();
	}
	const stream = response?.body;
	if (!(stream instanceof ReadableStream))
		throw refusal(
			"jev-adapter-incompatible",
			"The classifier response carries no readable byte stream to bound.",
		);
	let reader: ReadableStreamDefaultReader<any>;
	try {
		reader = stream.getReader();
	} catch {
		throw refusal(
			"jev-adapter-incompatible",
			"The classifier response body is not available for bounded reading.",
		);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let chunk: ReadableStreamReadResult<any>;
			try {
				chunk = await reader.read();
			} catch {
				throw refusal(
					"jev-invalid-response",
					"The classifier response body could not be read.",
				);
			}
			if (chunk.done) break;
			const value = chunk.value;
			if (value === undefined || value === null) continue;
			if (!(value instanceof Uint8Array))
				throw refusal(
					"jev-adapter-incompatible",
					"The classifier response stream did not yield bytes.",
				);
			total += value.byteLength;
			if (total > maxBytes) throw tooLarge();
			chunks.push(value);
		}
	} finally {
		// Never awaited: a rejecting cancel algorithm cannot hang or escape.
		try {
			ignoreOutcome(reader.cancel());
		} catch {
			// The reader is released with the response.
		}
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * A bounded observing fetch for exactly one batch and one call.
 *
 * It accepts only `POST` to the approved HTTPS endpoint with no userinfo and
 * no query, and it decides that from the request line alone, before any body
 * or header is forwarded. The final transformed outgoing body must be the
 * batch's own serialized request byte for byte, so a provider transform, a
 * widened payload, or another pinned model cannot leave the machine. The
 * response is captured within the decoded bound, the raw success object stays
 * in this call, and an error body is never propagated: it is dropped and only
 * its status is recorded.
 */
export function createBoundedObservingFetch(
	options: JevBoundedObservingFetchOptions,
): JevBoundedObservingFetch {
	const base: JevFetch | undefined = options.fetch ?? globalThis.fetch;
	const maxResponseBytes = requireJevResponseBound(options.maxResponseBytes);
	const expectedBody = options.wireBody;
	const expectedFingerprint = fingerprint(expectedBody);
	const expectedBytes = byteLength(expectedBody);

	let requests = 0;
	let status: number | undefined;
	let wire: any;
	let redirect: string | undefined;
	let rejection: JevFetchObservation["rejection"];
	let withdrawn = false;
	let closed = false;

	/** The caller's synchronous answer; a throwing hook withdraws. */
	const authorized = (): boolean => {
		if (options.authorize === undefined) return true;
		try {
			return options.authorize() === true;
		} catch {
			return false;
		}
	};

	/** The request line, checked before any body or header is forwarded. */
	const approvedTarget = (input: any, init: any): void => {
		const target = isString(input)
			? input
			: input instanceof URL
				? input.href
				: undefined;
		if (target === undefined)
			throw refusal(
				"jev-adapter-incompatible",
				"The classifier request target is not a URL.",
			);
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			throw refusal(
				"jev-endpoint-rejected",
				"The classifier request target is not a valid URL.",
			);
		}
		if (url.protocol !== "https:")
			throw refusal(
				"jev-endpoint-rejected",
				"The classifier endpoint is not HTTPS.",
			);
		if (url.username !== "" || url.password !== "")
			throw refusal(
				"jev-endpoint-rejected",
				"The classifier endpoint carries URL userinfo.",
			);
		if (url.search !== "")
			throw refusal(
				"jev-endpoint-rejected",
				"The classifier endpoint carries a query string.",
			);
		if (url.href !== JEV_CLASSIFIER_ENDPOINT)
			throw refusal(
				"jev-endpoint-rejected",
				`The classifier endpoint is not ${JEV_CLASSIFIER_ENDPOINT}.`,
			);
		const method = init?.method;
		if (!isString(method) || method.toUpperCase() !== "POST")
			throw refusal(
				"jev-endpoint-rejected",
				"The classifier request is not a POST.",
			);
		const requested = init?.redirect;
		if (requested !== undefined && requested !== "error")
			throw refusal(
				"jev-endpoint-rejected",
				"The classifier request does not refuse redirects.",
			);
	};

	/** The already-known batch body, compared byte for byte and by digest. */
	const approvedBody = (init: any): string => {
		const body = init?.body;
		if (!isString(body))
			throw refusal(
				"jev-adapter-incompatible",
				"The classifier request body is not serialized JSON text.",
			);
		if (
			body.length !== expectedBody.length ||
			body !== expectedBody ||
			byteLength(body) !== expectedBytes ||
			fingerprint(body) !== expectedFingerprint
		)
			throw refusal(
				"jev-adapter-incompatible",
				`The outgoing request is not this ${options.label} request for ${AUTO_ROUTING_JEV_MODEL}.`,
			);
		return body;
	};

	const runRequest: JevFetch = async (input, init) => {
		if (closed)
			throw refusal(
				"jev-adapter-incompatible",
				"The classifier attempted a request after its call settled.",
			);
		requests += 1;
		if (requests > 1)
			throw refusal(
				"jev-adapter-incompatible",
				`The classifier attempted ${requests} requests for one batch.`,
			);
		if (base === undefined)
			throw refusal(
				"jev-adapter-incompatible",
				"No fetch implementation is available for the classifier.",
			);
		approvedTarget(input, init);
		const body = approvedBody(init);
		// The last check before anything leaves: a revocation, drift, or
		// cancellation observed while the host authenticated sends nothing.
		if (!authorized()) {
			withdrawn = true;
			throw new Error("The classifier request was withdrawn by its caller.");
		}
		redirect = "error";
		const response = await base(input, { ...init, body, redirect: "error" });
		const code = response?.status;
		if (!Number.isInteger(code) || !isBoolean(response?.ok))
			throw refusal(
				"jev-adapter-incompatible",
				"The classifier transport returned no HTTP response.",
			);
		status = code;
		if (closed) {
			// A response that arrives after the call settled is discarded
			// unread, so a late body never reaches memory or a second result.
			discardBody(response);
			throw refusal(
				"jev-adapter-incompatible",
				"The classifier response arrived after its call settled.",
			);
		}
		if (code >= 300 && code < 400) {
			discardBody(response);
			throw refusal(
				"jev-endpoint-rejected",
				`The classifier endpoint answered with redirect status ${code}.`,
			);
		}
		if (response.ok !== true) {
			// The error body is dropped here so no provider text can reach a
			// result, a reason, or a log.
			discardBody(response);
			throw refusal(
				"jev-http-error",
				`The classifier request failed with HTTP status ${code}.`,
			);
		}
		const bytes = await readBounded(response, maxResponseBytes);
		let parsed: any;
		try {
			parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
		} catch {
			throw refusal(
				"jev-invalid-response",
				"The classifier response is not valid JSON.",
			);
		}
		if (closed)
			throw refusal(
				"jev-adapter-incompatible",
				"The classifier response arrived after its call settled.",
			);
		wire = parsed;
		// Pi's adapter parses exactly the bytes that were observed. Copy into a
		// concrete ArrayBuffer because DOM BodyInit excludes SharedArrayBuffer.
		const responseBody = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(responseBody).set(bytes);
		return new Response(responseBody, {
			status: code,
			statusText: response.statusText,
			headers: response.headers,
		});
	};

	/**
	 * Every refusal this observer decided, including one raised while reading
	 * the response, is recorded before it propagates, so the caller reports the
	 * exact sanitized reason instead of inferring one.
	 */
	const observingFetch: JevFetch = async (input, init) => {
		try {
			return await runRequest(input, init);
		} catch (error) {
			if (error instanceof JevTransportError)
				rejection ??= Object.freeze({
					reason: error.reason,
					detail: error.message,
				});
			throw error;
		}
	};

	const snapshot = (): JevFetchObservation => {
		const observation: MutableFetchObservation = { requests };
		if (status !== undefined) observation.status = status;
		if (wire !== undefined) observation.wire = wire;
		if (redirect !== undefined) observation.redirect = redirect;
		if (rejection !== undefined) observation.rejection = rejection;
		if (withdrawn) observation.withdrawn = true;
		return Object.freeze(observation);
	};

	return Object.freeze({
		fetch: observingFetch,
		observe: snapshot,
		close: () => {
			closed = true;
			wire = undefined;
		},
	});
}

/** Never rejects, so an abandoned classification cannot go unhandled. */
type Settlement =
	| Readonly<{ kind: "result"; result: any }>
	| Readonly<{ kind: "threw" }>
	| Readonly<{ kind: "aborted" }>;

/** What one completed call observed: the parsed wire and Pi's normalized result. */
export type JevTransportObservation = Readonly<{ wire: any; result: any }>;

export type JevTransportValidation<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; reason: AutoUnavailableReason; detail: string }>;

export type JevTransportOutcome<T> =
	| Readonly<{ status: "ok"; value: T }>
	| JevTransportFailure
	| JevTransportCancelled;

/**
 * Reads a request-local credential. It is asked at most once per call, only
 * when the host reports no configured authentication, and its value is passed
 * to `classify` as the request-local `apiKey` and nowhere else. A throw or an
 * undefined answer is an authentication failure.
 */
export type JevCredentialReader = () => Promise<string | undefined>;

export type JevRunOptions<T> = JevTransportOptions &
	Readonly<{
		/** Pi classifier context whose serialization is `wireBody`. */
		context: any;
		wireBody: string;
		label: string;
		deadline: JevDeadline;
		signals?: readonly (AbortSignal | undefined)[];
		authorize?: () => boolean;
		/** Advisory only: used when the host has no configured authentication. */
		credential?: JevCredentialReader;
		validate(observation: JevTransportObservation): JevTransportValidation<T>;
	}>;

export type JevTransportOptions = Readonly<{
	registry: JevClassifierRegistry;
	/** Underlying fetch the bounded observer wraps; defaults to `globalThis.fetch`. */
	fetch?: JevFetch;
	/** Monotonic clock; defaults to `performance.now`. */
	now?: () => number;
	/** A lower decoded response bound; it may never exceed 64 KiB. */
	maxResponseBytes?: number;
}>;

/**
 * One classifier call.
 *
 * It resolves the pinned descriptor, checks the host's configured provider
 * authentication locally, then races the whole call — including the host's own
 * authentication resolution and any credential read — against the remaining
 * overall deadline combined with the caller's cancellation. Exactly one
 * request may be sent, with no retries. Cancellation is decided first, the
 * observer's own refusal outranks any captured response, and the overall
 * budget is re-checked on its own clock before success is accepted, so a late
 * settlement is discarded. Only the caller's `validate` can turn an observed
 * result into a value, and the raw body is released before returning. An
 * out-of-range response bound is a programming error and throws a `TypeError`
 * before anything is resolved.
 */
export async function runJevClassification<T>(
	options: JevRunOptions<T>,
): Promise<JevTransportOutcome<T>> {
	const { deadline, registry } = options;
	const maxResponseBytes = requireJevResponseBound(options.maxResponseBytes);
	const signals = (options.signals ?? []).filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const cancelled = () => signals.some((signal) => signal.aborted);
	if (cancelled()) return CANCELLED;

	const resolution = resolvePinnedJevClassifier(registry);
	if (!resolution.ok) return unavailable(resolution.reason, resolution.detail);
	const descriptor = resolution.descriptor;

	// Only an explicit boolean `false` proves the host has no authentication;
	// a throw or any other answer is an unknown state and never authorizes the
	// credential fallback.
	let status: unknown;
	try {
		status = registry.hasConfiguredAuth(descriptor);
	} catch {
		status = undefined;
	}
	const configured = status === true;
	// Host authentication always wins; a credential reader is consulted only
	// when it is explicitly absent.
	const readCredential = status === false ? options.credential : undefined;
	if (!configured && readCredential === undefined)
		return unavailable(
			"jev-auth-unavailable",
			`The ${AUTO_ROUTING_JEV_PROVIDER} provider has no configured authentication.`,
		);

	const remainingMs = deadline.remainingMs();
	if (remainingMs <= 0)
		return unavailable(
			"jev-timeout",
			`The overall ${deadline.totalMs}-millisecond classifier budget is exhausted.`,
		);

	const observer = createBoundedObservingFetch({
		wireBody: options.wireBody,
		label: options.label,
		fetch: options.fetch,
		maxResponseBytes,
		authorize: options.authorize,
	});
	const controller = new AbortController();
	let timedOut = false;
	const abort = (reason: "timeout" | "cancel") => {
		if (controller.signal.aborted) return;
		if (reason === "timeout") timedOut = true;
		controller.abort();
	};
	const onCancel = () => abort("cancel");
	const timer = setTimeout(() => abort("timeout"), remainingMs);
	timer.unref?.();
	for (const signal of signals)
		signal.addEventListener("abort", onCancel, { once: true });

	try {
		if (cancelled()) return CANCELLED;
		const attempt: Promise<Settlement> = (async () => {
			try {
				let apiKey: string | undefined;
				if (readCredential !== undefined) {
					try {
						apiKey = await readCredential();
					} catch {
						apiKey = undefined;
					}
					// A credential that arrives late or empty sends nothing.
					if (apiKey === undefined || controller.signal.aborted)
						return Object.freeze({ kind: "threw" });
				}
				const hostOptions = {
					signal: controller.signal,
					fetch: observer.fetch,
					timeoutMs: remainingMs,
					maxRetries: 0,
					maxRetryDelayMs: 0,
				};
				// Request-local only; absent whenever the host authenticates.
				const classifyOptions =
					apiKey === undefined ? hostOptions : { ...hostOptions, apiKey };
				const result = await registry.classify(
					descriptor,
					options.context,
					classifyOptions,
				);
				return Object.freeze({ kind: "result", result });
			} catch {
				// A seam that throws is reported from the observation instead.
				return Object.freeze({ kind: "threw" });
			}
		})();
		const aborted: Promise<Settlement> = new Promise((resolve) => {
			if (controller.signal.aborted) {
				resolve(Object.freeze({ kind: "aborted" }));
				return;
			}
			controller.signal.addEventListener(
				"abort",
				() => resolve(Object.freeze({ kind: "aborted" })),
				{ once: true },
			);
		});
		const settled = await Promise.race([attempt, aborted]);
		const observation = observer.observe();

		// Cancellation holds unconditionally, so it is decided first: a
		// settlement that arrives after the deadline or a cancellation is
		// discarded and nothing can settle this decision twice.
		if (settled.kind === "aborted" || controller.signal.aborted)
			return timedOut
				? unavailable(
						"jev-timeout",
						`The classifier did not answer within the overall ${deadline.totalMs}-millisecond budget.`,
					)
				: CANCELLED;

		// A withdrawn authorization forwarded nothing; the caller owns why.
		if (observation.withdrawn) return CANCELLED;

		// The observer's own refusal is authoritative. It outranks a response
		// this call may also have captured, so an adapter that sent a second
		// request, or reached a changed endpoint, can never be reported as a
		// success.
		if (observation.rejection)
			return unavailable(
				observation.rejection.reason,
				observation.rejection.detail,
			);

		// The one overall budget is re-checked on its own clock, independent of
		// the timer callback, before any success is accepted: a call that
		// answered after its deadline is a timeout, not evidence.
		if (deadline.expired())
			return unavailable(
				"jev-timeout",
				`The classifier did not answer within the overall ${deadline.totalMs}-millisecond budget.`,
			);

		if (settled.kind === "result") {
			if (observation.wire !== undefined) {
				const validation = options.validate({
					wire: observation.wire,
					result: settled.result,
				});
				if (validation.ok)
					return Object.freeze({ status: "ok", value: validation.value });
				return unavailable(validation.reason, validation.detail);
			}
			if (observation.requests === 0)
				// A classification that completed without reaching the observer
				// bypassed the bounded fetch, so its answer is unobserved and is
				// not evidence. Only a failed result before any request is the
				// expected authentication outcome.
				return isRecord(settled.result) && settled.result.stopReason === "stop"
					? unavailable(
							"jev-adapter-incompatible",
							"The host answered without sending the observed classifier request.",
						)
					: authUnavailable();
			return unavailable(
				"jev-invalid-response",
				"The classifier request completed without a usable response.",
			);
		}
		if (observation.requests === 0) return authUnavailable();
		if (observation.wire !== undefined)
			return unavailable(
				"jev-adapter-incompatible",
				"The host returned no classifier result for the observed response.",
			);
		return unavailable(
			"jev-invalid-response",
			"The classifier request completed without a usable response.",
		);
	} finally {
		clearTimeout(timer);
		for (const signal of signals) signal.removeEventListener("abort", onCancel);
		abort("cancel");
		// The raw response object never outlives its call.
		observer.close();
	}
}
