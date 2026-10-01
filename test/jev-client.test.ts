/**
 * The authenticated bounded Jev transport, exercised against the **real**
 * installed Pi TypeSafe System One classifier adapter with a fake registry,
 * fake host authentication, and a fake fetch. No network access occurs:
 * `globalThis.fetch` is replaced by a throwing stub for the whole file, so any
 * accidental egress fails the run.
 *
 * The adapter under test is Pi's own `typesafeProvider().classify`, reached the
 * way the host reaches it, so these tests cover the real payload
 * serialization, the public `bool` to wire `noul` mapping, the lossy
 * normalization the observer repairs, retry behavior, and error handling.
 */
import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { TYPESAFE_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/typesafe.models";
import { DEFAULT_AUTO_ROUTING_THRESHOLDS } from "../pi-extension/subagents/auto-routing-config.ts";
import {
	AUTO_ROUTING_JEV_MODEL,
	decideAfterBatchA,
	decideAfterBatchB,
	type AutoPolicyCandidate,
	type AutoPolicyRole,
	type AutoPolicySnapshot,
} from "../pi-extension/subagents/auto-routing-policy.ts";
import {
	JEV_CLASSIFIER_ALIAS_ID,
	JEV_CLASSIFIER_ENDPOINT,
	JEV_MAX_RESPONSE_BYTES,
	JEV_PINNED_DISPLAY_NAME,
	classifyJevBatch,
	createBoundedObservingFetch,
	createJevDeadline,
	createJevTransport,
	requireJevResponseBound,
	resolvePinnedJevClassifier,
	type JevClassifyResult,
	type JevFetch,
} from "../pi-extension/subagents/jev-client.ts";
import {
	buildBatchA,
	buildBatchB,
	type JevBatch,
} from "../pi-extension/subagents/jev-questions.ts";

const T = DEFAULT_AUTO_ROUTING_THRESHOLDS;
/** A distinctive prompt, so redaction can be asserted on every reason. */
const PROMPT =
	"Explain how the widget cache is invalidated for tenant ACME-CONFIDENTIAL-7.";
/** Never a real credential; it only proves the host supplies authentication. */
const HOST_API_KEY = "fake-typesafe-key-ACME-CONFIDENTIAL-7";
/** Failure texts that must never appear in a reported reason. */
const CANCEL_FAILURE = "cancel failed for ACME-CONFIDENTIAL-7";
const READ_FAILURE = "read failed for ACME-CONFIDENTIAL-7";
const BUDGET_MS = 500;

type Distribution = readonly [number, number, number, number];

// ---------------------------------------------------------------------------
// Zero network access
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

const refuseNetwork: typeof globalThis.fetch = () => {
	throw new Error("These tests must never reach the network.");
};

before(() => {
	globalThis.fetch = refuseNetwork;
});

after(() => {
	globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Local snapshot fixtures
// ---------------------------------------------------------------------------

function role(
	id: string,
	overrides: Partial<AutoPolicyRole["approval"]> = {},
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
		role: Object.freeze({}),
		roleFingerprint: `fingerprint-${id}`,
	});
}

function tuple(
	id: string,
	model: string,
	exactEffort: AutoPolicyCandidate["exactEffort"],
	tier: AutoPolicyCandidate["tier"],
	preference: number,
): AutoPolicyCandidate {
	const [provider, modelId] = model.split("/");
	return Object.freeze({
		id,
		roleId: "r00",
		harness: "pi",
		exactModel: Object.freeze({
			namespace: "pi",
			provider,
			id: modelId,
			ref: model,
		}),
		exactEffort,
		tier,
		roleFingerprint: "fingerprint-r00",
		profile: Object.freeze({
			preference,
			taskStrengths: `Strengths of ${model}.`,
			limitations: `Limitations of ${model}.`,
		}),
	});
}

const SNAPSHOT: AutoPolicySnapshot = Object.freeze({
	decisionId: "decision-t06",
	snapshotHash: "snapshot-t06",
	task: PROMPT,
	policyVersion: "jev-auto-v1",
	questionVersion: "jev-auto-questions-v1",
	roles: Object.freeze([role("r00")]),
	candidates: Object.freeze([
		tuple("c000", "fake/fast-1", "low", "fast", 1),
		tuple("c001", "fake/frontier-1", "xhigh", "frontier", 0),
	]),
});

function batchA(): JevBatch {
	const built = buildBatchA(SNAPSHOT);
	assert.equal(built.ok, true);
	if (!built.ok) throw new Error("unreachable");
	return built.batch;
}

const BATCH_A = batchA();

// ---------------------------------------------------------------------------
// Wire response fixtures
// ---------------------------------------------------------------------------

type ResponseSpec = Readonly<{
	choices?: Readonly<Record<string, string>>;
	scores?: Readonly<Record<string, Distribution>>;
	nouls?: Readonly<Record<string, number>>;
	model?: string;
	usage?: unknown;
}>;

/** A sharp Choice over exactly the offered options; it passes every gate. */
function choiceAnswer(options: readonly string[], winner: string) {
	const others = options.filter((option) => option !== winner);
	const share = others.length > 0 ? 0.04 / others.length : 0;
	const probabilities: Record<string, number> = {};
	let spent = 0;
	for (const option of others) {
		probabilities[option] = share;
		spent += share;
	}
	probabilities[winner] = 1 - spent;
	return {
		type: "choice",
		choice: winner,
		probabilities,
		confidence: 0.95,
	};
}

function scoreAnswer(legend: readonly string[], distribution: Distribution) {
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
			legend.map((text, level) => [String(level), text]),
		),
		confidence: 0.95,
	};
}

type WireAnswer =
	| ReturnType<typeof choiceAnswer>
	| ReturnType<typeof scoreAnswer>
	| Readonly<{ type: "noul"; noul: number }>;

/** The exact wire body a cooperative Jev would return for one batch. */
function wireBodyFor(batch: JevBatch, spec: ResponseSpec = {}): string {
	const answers: Record<string, WireAnswer> = {};
	for (const question of batch.expected) {
		if (question.type === "choice")
			answers[question.id] = choiceAnswer(
				question.options,
				spec.choices?.[question.id] ?? question.options[0],
			);
		else if (question.type === "score")
			answers[question.id] = scoreAnswer(
				question.legend,
				spec.scores?.[question.id] ?? [0.95, 0.05, 0, 0],
			);
		else
			answers[question.id] = {
				type: "noul",
				noul: spec.nouls?.[question.id] ?? 0.01,
			};
	}
	return JSON.stringify({
		model: spec.model ?? AUTO_ROUTING_JEV_MODEL,
		answers,
		usage: spec.usage ?? { input_tokens: 1234, output_tokens: 56 },
	});
}

/** Batch A answers that select role r00 and required band 0. */
const BATCH_A_SPEC: ResponseSpec = Object.freeze({
	choices: Object.freeze({ role: "r00" }),
	nouls: Object.freeze({ role_fit_r00: 0.99 }),
});

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

type RecordedRequest = Readonly<{
	input: any;
	method: any;
	redirect: any;
	headers: any;
	body: any;
	signal: any;
}>;

type FakeFetch = Readonly<{
	fetch: JevFetch;
	requests: RecordedRequest[];
	/** Bodies whose stream was cancelled instead of read. */
	cancelled: () => number;
}>;

type FakeFetchOptions = Readonly<{
	body?: string;
	status?: number;
	headers?: Record<string, string>;
	stream?: () => ReadableStream<Uint8Array>;
	/** Make the body's cancel algorithm reject. */
	rejectCancel?: boolean;
	/** Return this exact response object instead of building one. */
	response?: () => any;
}>;

function createFakeFetch(options: FakeFetchOptions = {}): FakeFetch {
	const requests: RecordedRequest[] = [];
	let cancelled = 0;
	const cancelCounter = () => {
		cancelled += 1;
	};
	const fetch: JevFetch = async (input, init) => {
		requests.push(
			Object.freeze({
				input,
				method: init?.method,
				redirect: init?.redirect,
				headers: init?.headers,
				body: init?.body,
				signal: init?.signal,
			}),
		);
		if (options.response) return options.response();
		// Every body is a tracked stream, so an unread error or oversized body
		// is observable as a cancellation.
		const source = options.stream
			? options.stream()
			: stringStream(options.body ?? "{}");
		const responseInit: ResponseInit = { status: options.status ?? 200 };
		if (options.headers) responseInit.headers = options.headers;
		return new Response(
			trackedStream(source, cancelCounter, options.rejectCancel === true),
			responseInit,
		);
	};
	return Object.freeze({ fetch, requests, cancelled: () => cancelled });
}

function stringStream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function chunkStream(chunk: number, count: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= count) {
				controller.close();
				return;
			}
			sent += 1;
			controller.enqueue(new Uint8Array(chunk).fill(97));
		},
	});
}

function trackedStream(
	stream: ReadableStream<Uint8Array>,
	onCancel: () => void,
	rejectCancel = false,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	return new ReadableStream({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel() {
			onCancel();
			void reader.cancel().catch(() => undefined);
			// A source whose cancel algorithm rejects must not hang the call or
			// leave an unhandled rejection behind.
			return rejectCancel
				? Promise.reject(new Error(CANCEL_FAILURE))
				: Promise.resolve();
		},
	});
}

/** A stream that fails while it is being read. */
function erroringStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		pull(controller) {
			controller.error(new Error(READ_FAILURE));
		},
	});
}

// ---------------------------------------------------------------------------
// Fake registry over the real Pi classifier adapter
// ---------------------------------------------------------------------------

/** The shape of a Pi classifier catalog entry these tests supply. */
type JevCatalogEntry = Readonly<{
	type: string;
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	input: readonly string[];
	cost: Readonly<{
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	}>;
	contextWindow: number;
}>;

const ALIAS_DESCRIPTOR: JevCatalogEntry = Object.freeze({
	...TYPESAFE_CLASSIFIER_MODELS[JEV_CLASSIFIER_ALIAS_ID],
});

type FakeRegistryOptions = Readonly<{
	catalog?: Readonly<Record<string, JevCatalogEntry | undefined>>;
	configuredAuth?: boolean;
	/** Host authentication latency, inside the one overall deadline. */
	authDelayMs?: number;
	/** Rewrite the descriptor the way request-time auth resolution can. */
	requestModel?: (model: any) => any;
	onPayload?: (payload: any) => any;
	/** Simulate an adapter that retries the same batch before its request. */
	duplicateRequest?: boolean;
	/** Simulate an adapter that repeats its request after a success. */
	duplicateAfterSuccess?: boolean;
	/** Replace the real adapter for transport-only cases. */
	classify?: (model: any, context: any, options: any) => Promise<any>;
}>;

type FakeRegistry = Readonly<{
	registry: any;
	lookups: Array<readonly [string, string, string]>;
	classifyCalls: Array<Readonly<{ model: any; options: any }>>;
}>;

function createFakeRegistry(options: FakeRegistryOptions = {}): FakeRegistry {
	const catalog = options.catalog ?? {
		[JEV_CLASSIFIER_ALIAS_ID]: ALIAS_DESCRIPTOR,
	};
	const provider = typesafeProvider();
	const lookups: Array<readonly [string, string, string]> = [];
	const classifyCalls: Array<Readonly<{ model: any; options: any }>> = [];
	const forbidden = (name: string) => () => {
		throw new Error(`The transport must never call ${name}.`);
	};
	const registry = {
		findOfType(type: string, providerId: string, modelId: string) {
			lookups.push(Object.freeze([type, providerId, modelId] as const));
			return providerId === "typesafe" && type === "classifier"
				? catalog[modelId]
				: undefined;
		},
		hasConfiguredAuth(model: any) {
			return (options.configuredAuth ?? true) && model.provider === "typesafe";
		},
		async classify(model: any, context: any, callOptions: any) {
			classifyCalls.push(Object.freeze({ model, options: callOptions }));
			if (options.authDelayMs !== undefined)
				// Deliberately ignores the signal: only the transport's own race
				// can bound host authentication.
				await new Promise((resolve) =>
					setTimeout(resolve, options.authDelayMs),
				);
			if (options.classify)
				return options.classify(model, context, callOptions);
			const requestModel = options.requestModel
				? options.requestModel(model)
				: model;
			// Authentication is resolved and supplied by the host, never by
			// the transport.
			const hostOptions = { ...callOptions, apiKey: HOST_API_KEY };
			if (options.onPayload) hostOptions.onPayload = options.onPayload;
			const probe = () =>
				callOptions
					.fetch(new URL(JEV_CLASSIFIER_ENDPOINT), {
						method: "POST",
						body: "{}",
					})
					.catch(() => undefined);
			if (options.duplicateRequest) await probe();
			const result = await provider.classify!(
				requestModel,
				context,
				hostOptions,
			);
			if (options.duplicateAfterSuccess) await probe();
			return result;
		},
		// Credential accessors exist on the host registry; the transport must
		// never reach for one.
		getApiKeyAndHeaders: forbidden("getApiKeyAndHeaders"),
		getProviderAuth: forbidden("getProviderAuth"),
		getApiKeyForProvider: forbidden("getApiKeyForProvider"),
		getProviderAuthStatus: forbidden("getProviderAuthStatus"),
	};
	return Object.freeze({ registry, lookups, classifyCalls });
}

type TestClock = Readonly<{ now: () => number; advance: (ms: number) => void }>;

function clock(): TestClock {
	let value = 0;
	return {
		now: () => value,
		advance: (ms: number) => {
			value += ms;
		},
	};
}

function failureOf(result: JevClassifyResult) {
	assert.equal(result.status, "unavailable");
	if (result.status !== "unavailable") throw new Error("unreachable");
	return result;
}

/**
 * Run one call and prove it left no unhandled rejection behind. Cancelling a
 * body is fire and forget, so a rejecting or already errored cancel algorithm
 * must be handled at the point it is abandoned.
 */
async function withoutUnhandledRejections<T>(
	run: () => Promise<T>,
): Promise<T> {
	const seen: string[] = [];
	const capture = (reason: any) => {
		seen.push(String(reason));
	};
	process.on("unhandledRejection", capture);
	try {
		const value = await run();
		// An unhandled rejection is reported after the microtask queue drains.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(seen, []);
		return value;
	} finally {
		process.off("unhandledRejection", capture);
	}
}

/** Nothing the transport reports may echo the prompt or a credential. */
function assertRedacted(detail: string): void {
	assert.ok(!detail.includes("ACME-CONFIDENTIAL-7"), detail);
	assert.ok(!detail.includes("widget cache"), detail);
	assert.ok(!detail.includes("Bearer"), detail);
}

// ---------------------------------------------------------------------------

describe("pinned descriptor resolution", () => {
	it("copies the built-in alias into the exact pin without requesting it", () => {
		const fake = createFakeRegistry();
		const resolution = resolvePinnedJevClassifier(fake.registry);
		assert.equal(resolution.ok, true);
		if (!resolution.ok) return;
		assert.equal(resolution.pinned, false);
		assert.equal(resolution.descriptor.id, AUTO_ROUTING_JEV_MODEL);
		assert.equal(resolution.descriptor.name, JEV_PINNED_DISPLAY_NAME);
		assert.equal(resolution.descriptor.api, "typesafe-system-one");
		assert.equal(resolution.descriptor.provider, "typesafe");
		assert.equal(resolution.descriptor.baseUrl, ALIAS_DESCRIPTOR.baseUrl);
		assert.equal(resolution.descriptor.contextWindow, 64000);
		assert.equal(Object.isFrozen(resolution.descriptor), true);
		// The catalog entry itself is untouched.
		assert.equal(
			TYPESAFE_CLASSIFIER_MODELS[JEV_CLASSIFIER_ALIAS_ID].id,
			JEV_CLASSIFIER_ALIAS_ID,
		);
		assert.deepEqual(fake.lookups, [
			["classifier", "typesafe", AUTO_ROUTING_JEV_MODEL],
			["classifier", "typesafe", JEV_CLASSIFIER_ALIAS_ID],
		]);
	});

	it("uses an exact pinned catalog entry directly", () => {
		const fake = createFakeRegistry({
			catalog: {
				[AUTO_ROUTING_JEV_MODEL]: {
					...ALIAS_DESCRIPTOR,
					id: AUTO_ROUTING_JEV_MODEL,
					name: "Jev 1.13.0",
				},
			},
		});
		const resolution = resolvePinnedJevClassifier(fake.registry);
		assert.equal(resolution.ok, true);
		if (!resolution.ok) return;
		assert.equal(resolution.pinned, true);
		assert.equal(resolution.descriptor.id, AUTO_ROUTING_JEV_MODEL);
		assert.equal(fake.lookups.length, 1);
	});

	it("never falls back to the alias when a present pin is unsuitable", () => {
		const fake = createFakeRegistry({
			catalog: {
				[AUTO_ROUTING_JEV_MODEL]: {
					...ALIAS_DESCRIPTOR,
					id: AUTO_ROUTING_JEV_MODEL,
					api: "cloudflare-workers-ai-system-one",
				},
				[JEV_CLASSIFIER_ALIAS_ID]: ALIAS_DESCRIPTOR,
			},
		});
		const resolution = resolvePinnedJevClassifier(fake.registry);
		assert.equal(resolution.ok, false);
		if (resolution.ok) return;
		assert.equal(resolution.reason, "jev-model-unavailable");
		assert.equal(fake.lookups.length, 1);
	});

	it("rejects a descriptor that does not reach the approved endpoint", () => {
		for (const baseUrl of [
			"https://classifier.internal.example/v1/",
			"http://api.typesafe.ai/v1/",
			"",
		]) {
			const resolution = resolvePinnedJevClassifier(
				createFakeRegistry({
					catalog: {
						[JEV_CLASSIFIER_ALIAS_ID]: { ...ALIAS_DESCRIPTOR, baseUrl },
					},
				}).registry,
			);
			assert.equal(resolution.ok, false);
			if (resolution.ok) return;
			assert.equal(resolution.reason, "jev-model-unavailable");
		}
	});

	it("reports an empty classifier catalog as unavailable", () => {
		const resolution = resolvePinnedJevClassifier(
			createFakeRegistry({ catalog: {} }).registry,
		);
		assert.equal(resolution.ok, false);
		if (resolution.ok) return;
		assert.equal(resolution.reason, "jev-model-unavailable");
	});
});

describe("one successful call through the real Pi adapter", () => {
	it("sends the pinned batch body once and recovers the full wire evidence", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, {
				...BATCH_A_SPEC,
				scores: {
					reasoning: [0.5, 0, 0, 0.5],
					consequence: [0.2, 0.7, 0.1, 0],
				},
			}),
		});
		const fake = createFakeRegistry();
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: fake.registry,
			fetch: network.fetch,
		});
		assert.equal(result.status, "ok");
		if (result.status !== "ok") return;

		// Exactly one request, to the approved endpoint, refusing redirects.
		assert.equal(network.requests.length, 1);
		const request = network.requests[0];
		assert.equal(String(request.input), JEV_CLASSIFIER_ENDPOINT);
		assert.equal(request.method, "POST");
		assert.equal(request.redirect, "error");

		// The body is the batch's own serialized request, byte for byte.
		assert.equal(request.body, BATCH_A.wireBody);
		const payload = JSON.parse(request.body);
		assert.equal(payload.model, AUTO_ROUTING_JEV_MODEL);
		assert.ok(!request.body.includes(JEV_CLASSIFIER_ALIAS_ID));
		assert.equal(payload.state.prompt, PROMPT);

		// Public `bool` questions travel as wire `noul` questions.
		const types = Object.values<any>(payload.questions).map(
			(question) => question.type,
		);
		assert.equal(
			types.filter((type) => type === "noul").length,
			BATCH_A.expected.filter((question) => question.type === "noul").length,
		);
		assert.equal(
			types.some((type) => type === "bool"),
			false,
		);

		// Host-supplied authentication, never transport-supplied.
		assert.equal(request.headers.authorization, `Bearer ${HOST_API_KEY}`);
		assert.equal(request.headers["content-type"], "application/json");
		const passed = fake.classifyCalls[0].options;
		assert.equal(passed.apiKey, undefined);
		assert.equal(passed.headers, undefined);
		assert.equal(passed.maxRetries, 0);
		assert.equal(passed.maxRetryDelayMs, 0);
		assert.ok(passed.timeoutMs > 0 && passed.timeoutMs <= BUDGET_MS);
		assert.deepEqual(Object.keys(passed).sort(), [
			"fetch",
			"maxRetries",
			"maxRetryDelayMs",
			"signal",
			"timeoutMs",
		]);

		// Score distributions and the returned model come from the observed
		// wire body, which Pi's normalized answer discards.
		const evidence = result.evidence;
		assert.equal(evidence.model, AUTO_ROUTING_JEV_MODEL);
		assert.deepEqual(evidence.scores.reasoning.probabilities, [0.5, 0, 0, 0.5]);
		assert.deepEqual(
			evidence.scores.consequence.probabilities,
			[0.2, 0.7, 0.1, 0],
		);
		assert.equal(evidence.nouls.role_fit_r00, 0.99);
		assert.equal(evidence.nouls.clarification_needed, 0.01);
		assert.equal(evidence.choices.role.choice, "r00");
		assert.deepEqual(evidence.usage, { inputTokens: 1234, outputTokens: 56 });
	});

	it("drives Batch A and Batch B on one monotonic overall deadline", async () => {
		const time = clock();
		// Replaced by the real Batch B once the host decides after Batch A.
		let batchB: JevBatch = BATCH_A;
		const transport = createJevTransport({
			registry: createFakeRegistry().registry,
			fetch: (input, init) => {
				// Every request spends part of the one shared budget.
				time.advance(100);
				const schema = JSON.parse(init.body).state.schema;
				const body =
					schema === "jev-auto-A-v1"
						? wireBodyFor(BATCH_A, BATCH_A_SPEC)
						: wireBodyFor(batchB, {
								choices: { runtime: "pi", model_pi: "c001" },
							});
				return createFakeFetch({ body }).fetch(input, init);
			},
			now: time.now,
		});
		const deadline = transport.createDeadline(BUDGET_MS);

		const first = await transport.classify({ batch: BATCH_A, deadline });
		assert.equal(first.status, "ok");
		if (first.status !== "ok") return;
		const decision = decideAfterBatchA(SNAPSHOT, first.evidence, T);
		assert.equal(decision.kind, "continue");
		if (decision.kind !== "continue") return;
		assert.equal(decision.plan.requiredBand, 0);
		const builtB = buildBatchB(decision.plan);
		assert.equal(builtB.ok, true);
		if (!builtB.ok) return;
		batchB = builtB.batch;

		const second = await transport.classify({ batch: batchB, deadline });
		assert.equal(second.status, "ok");
		if (second.status !== "ok") return;
		const route = decideAfterBatchB(decision.plan, second.evidence, T);
		assert.equal(route.kind, "selected");
		if (route.kind !== "selected") return;
		assert.equal(route.route.candidateId, "c001");
		assert.equal(route.route.exactEffort, "xhigh");
		// The second batch got only what the first left of the one budget.
		assert.equal(deadline.remainingMs(), BUDGET_MS - 200);
	});
});

describe("model pin", () => {
	it("reports a response from another model as unavailable", async () => {
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: createFakeFetch({
				body: wireBodyFor(BATCH_A, {
					...BATCH_A_SPEC,
					model: JEV_CLASSIFIER_ALIAS_ID,
				}),
			}).fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-model-unavailable");
		assertRedacted(failure.detail);
	});

	it("refuses a host that rewrites the pinned model before the request", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({
				requestModel: (model) => ({ ...model, id: JEV_CLASSIFIER_ALIAS_ID }),
			}).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-adapter-incompatible");
		assert.equal(network.requests.length, 0);
		assertRedacted(failure.detail);
	});
});

describe("request bounds", () => {
	it("refuses a transformed outgoing body before it is forwarded", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({
				onPayload: (payload) => ({ ...payload, telemetry: "on" }),
			}).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-adapter-incompatible");
		assert.equal(network.requests.length, 0);
		assertRedacted(failure.detail);
	});

	it("refuses a changed endpoint before any body or header is forwarded", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({
				requestModel: (model) => ({
					...model,
					baseUrl: "https://classifier.internal.example/v1/",
				}),
			}).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-endpoint-rejected");
		assert.equal(network.requests.length, 0);
		assertRedacted(failure.detail);
	});

	it("sends one request per batch and refuses an adapter that repeats it", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({ duplicateRequest: true }).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-adapter-incompatible");
		// The first attempt was the duplicate probe, which never reached the
		// network; the real request is refused as the second attempt.
		assert.equal(network.requests.length, 0);
	});

	it("never retries a retryable status", async () => {
		const network = createFakeFetch({ status: 429, body: "slow down" });
		const fake = createFakeRegistry();
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: fake.registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-http-error");
		assert.ok(failure.detail.includes("429"));
		assert.equal(network.requests.length, 1);
		assert.equal(fake.classifyCalls[0].options.maxRetries, 0);
		assert.equal(fake.classifyCalls[0].options.maxRetryDelayMs, 0);
	});
});

describe("bounded observing fetch", () => {
	const observer = (
		options: Parameters<typeof createBoundedObservingFetch>[0],
	) => createBoundedObservingFetch(options);

	it("accepts only POST to the approved HTTPS endpoint", async () => {
		const cases: Array<readonly [any, any, string]> = [
			[
				new URL("http://api.typesafe.ai/v1/systemone"),
				{ method: "POST" },
				"HTTPS",
			],
			[
				new URL("https://user:secret@api.typesafe.ai/v1/systemone"),
				{ method: "POST" },
				"userinfo",
			],
			[
				new URL("https://api.typesafe.ai/v1/systemone?trace=1"),
				{ method: "POST" },
				"query",
			],
			[
				new URL("https://api.typesafe.ai/v1/other"),
				{ method: "POST" },
				"endpoint",
			],
			[new URL(JEV_CLASSIFIER_ENDPOINT), { method: "GET" }, "POST"],
			[
				new URL(JEV_CLASSIFIER_ENDPOINT),
				{ method: "POST", redirect: "follow" },
				"redirects",
			],
		];
		for (const [input, init, expected] of cases) {
			const network = createFakeFetch({ body: "{}" });
			const bounded = observer({ batch: BATCH_A, fetch: network.fetch });
			await assert.rejects(() =>
				bounded.fetch(input, { ...init, body: BATCH_A.wireBody }),
			);
			const observation = bounded.observe();
			assert.equal(observation.rejection?.reason, "jev-endpoint-rejected");
			assert.ok(
				observation.rejection?.detail.includes(expected) === true,
				expected,
			);
			assert.equal(network.requests.length, 0);
		}
	});

	it("refuses a second request and a request after the call settled", async () => {
		const network = createFakeFetch({ body: "{}" });
		const bounded = observer({ batch: BATCH_A, fetch: network.fetch });
		const call = () =>
			bounded.fetch(new URL(JEV_CLASSIFIER_ENDPOINT), {
				method: "POST",
				body: BATCH_A.wireBody,
			});
		await call();
		assert.equal(network.requests.length, 1);
		await assert.rejects(call);
		assert.equal(
			bounded.observe().rejection?.reason,
			"jev-adapter-incompatible",
		);
		assert.equal(network.requests.length, 1);
		bounded.close();
		await assert.rejects(call);
		assert.equal(network.requests.length, 1);
	});

	it("releases the observed body when the call is closed", async () => {
		const network = createFakeFetch({ body: '{"model":"jev-1.13.0"}' });
		const bounded = observer({ batch: BATCH_A, fetch: network.fetch });
		await bounded.fetch(new URL(JEV_CLASSIFIER_ENDPOINT), {
			method: "POST",
			body: BATCH_A.wireBody,
		});
		assert.deepEqual(bounded.observe().wire, { model: "jev-1.13.0" });
		bounded.close();
		assert.equal(bounded.observe().wire, undefined);
	});
});

describe("caller authorization at the forwarding boundary", () => {
	it("forwards nothing when the synchronous hook refuses or throws", async () => {
		for (const authorize of [
			() => false,
			() => {
				throw new Error("hook failed");
			},
		]) {
			const network = createFakeFetch({ body: "{}" });
			let asked = 0;
			const bounded = createBoundedObservingFetch({
				batch: BATCH_A,
				fetch: network.fetch,
				authorize: () => {
					asked++;
					return authorize();
				},
			});
			await assert.rejects(() =>
				bounded.fetch(new URL(JEV_CLASSIFIER_ENDPOINT), {
					method: "POST",
					body: BATCH_A.wireBody,
				}),
			);
			assert.equal(asked, 1);
			assert.equal(network.requests.length, 0);
			const observation = bounded.observe();
			assert.equal(observation.withdrawn, true);
			assert.equal(observation.rejection, undefined);
		}
	});

	it("asks only after the request line and body are approved", async () => {
		const network = createFakeFetch({ body: "{}" });
		let asked = 0;
		const bounded = createBoundedObservingFetch({
			batch: BATCH_A,
			fetch: network.fetch,
			authorize: () => {
				asked++;
				return true;
			},
		});
		await assert.rejects(() =>
			bounded.fetch(new URL(JEV_CLASSIFIER_ENDPOINT), {
				method: "POST",
				body: "{}",
			}),
		);
		assert.equal(asked, 0);
		assert.equal(bounded.observe().withdrawn, undefined);
	});

	it("checks after asynchronous host authentication and reports cancellation", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		let allowed = true;
		let asked = 0;
		const transport = createJevTransport({
			registry: createFakeRegistry({ authDelayMs: 20 }).registry,
			fetch: network.fetch,
		});
		const pending = transport.classify({
			batch: BATCH_A,
			deadline: transport.createDeadline(BUDGET_MS),
			authorize: () => {
				asked++;
				return allowed;
			},
		});
		// Revoked while the host is still authenticating.
		allowed = false;
		const result = await withoutUnhandledRejections(() => pending);
		assert.equal(result.status, "cancelled");
		assert.equal(asked, 1);
		assert.equal(network.requests.length, 0);
	});

	it("forwards once and still validates evidence when the hook allows it", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		let asked = 0;
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: network.fetch,
			authorize: () => {
				asked++;
				return true;
			},
		});
		assert.equal(result.status, "ok");
		assert.equal(asked, 1);
		assert.equal(network.requests.length, 1);
	});
});

describe("response bounds and redaction", () => {
	it("reports a malformed response without echoing it", async () => {
		const secret = '{"model": "jev-1.13.0", "leak": "ACME-CONFIDENTIAL-7"';
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: createFakeFetch({ body: secret }).fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-invalid-response");
		assertRedacted(failure.detail);
		assert.ok(!failure.detail.includes("leak"));
	});

	it("reports an HTTP error by status only and never reads its body", async () => {
		const network = createFakeFetch({
			status: 500,
			body: "internal error: key sk-ACME-CONFIDENTIAL-7 for widget cache",
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-http-error");
		assert.ok(failure.detail.includes("500"));
		assertRedacted(failure.detail);
		assert.ok(!failure.detail.includes("sk-"));
		assert.equal(network.cancelled(), 1);
	});

	it("reports a redirect as a rejected endpoint", async () => {
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: createFakeFetch({
				status: 302,
				headers: {
					location: "https://classifier.internal.example/v1/systemone",
				},
				body: "redirecting",
			}).fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-endpoint-rejected");
		assert.ok(!failure.detail.includes("internal.example"));
	});

	it("refuses an advertised length over the decoded bound without reading it", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
			headers: { "content-length": String(JEV_MAX_RESPONSE_BYTES + 1) },
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-response-too-large");
		assert.equal(network.cancelled(), 1);
		assertRedacted(failure.detail);
	});

	it("cancels an unbounded stream past the decoded bound", async () => {
		const network = createFakeFetch({
			stream: () => chunkStream(8 * 1024, 16),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: network.fetch,
			maxResponseBytes: 32 * 1024,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-response-too-large");
		assert.equal(network.cancelled(), 1);
	});
});

describe("authentication, deadline, and cancellation", () => {
	it("reports unconfigured provider authentication before any egress", async () => {
		const fake = createFakeRegistry({ configuredAuth: false });
		const network = createFakeFetch({ body: "{}" });
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: fake.registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-auth-unavailable");
		assert.equal(fake.classifyCalls.length, 0);
		assert.equal(network.requests.length, 0);
	});

	it("reports a host error before any request as unavailable authentication", async () => {
		const network = createFakeFetch({ body: "{}" });
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({
				classify: async () => {
					throw new Error(`Provider is not configured: ${HOST_API_KEY}`);
				},
			}).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-auth-unavailable");
		assert.equal(network.requests.length, 0);
		assertRedacted(failure.detail);
	});

	it("counts host authentication latency inside the one overall deadline", async () => {
		const time = clock();
		const deadline = createJevDeadline(BUDGET_MS, time.now);
		// Batch A already spent most of the shared budget.
		time.advance(BUDGET_MS - 40);
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline,
			registry: createFakeRegistry({ authDelayMs: 400 }).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-timeout");
		assert.equal(network.requests.length, 0);
		assertRedacted(failure.detail);
	});

	it("reports an exhausted budget without calling the classifier", async () => {
		const time = clock();
		const deadline = createJevDeadline(BUDGET_MS, time.now);
		time.advance(BUDGET_MS);
		const fake = createFakeRegistry();
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline,
			registry: fake.registry,
			fetch: createFakeFetch({ body: "{}" }).fetch,
		});
		assert.equal(failureOf(result).reason, "jev-timeout");
		assert.equal(fake.classifyCalls.length, 0);
	});

	it("holds an already cancelled input without resolving a descriptor", async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = createFakeRegistry();
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: fake.registry,
			fetch: createFakeFetch({ body: "{}" }).fetch,
			signals: [controller.signal, undefined],
		});
		assert.equal(result.status, "cancelled");
		assert.equal(fake.lookups.length, 0);
		assert.equal(fake.classifyCalls.length, 0);
	});

	it("ignores a response that settles after cancellation", async () => {
		let release: ((body: string) => void) | undefined;
		const controller = new AbortController();
		const requests: any[] = [];
		const pending: JevFetch = (input, init) => {
			requests.push(init.body);
			return new Promise((resolve) => {
				release = (body: string) =>
					resolve(new Response(body, { status: 200 }));
			});
		};
		const promise = classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: pending,
			signals: [controller.signal],
		});
		// Let the request reach the pending fetch, then cancel.
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(requests.length, 1);
		controller.abort();
		const result = await promise;
		assert.equal(result.status, "cancelled");
		// A late success cannot settle the decision a second time.
		release?.(wireBodyFor(BATCH_A, BATCH_A_SPEC));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(result.status, "cancelled");
	});

	it("rejects a budget outside the configured bounds", () => {
		for (const invalid of [0, 100, 20_000, 1.5, Number.NaN]) {
			assert.throws(() => createJevDeadline(invalid), TypeError);
		}
	});
});

describe("cancelling a body never hangs or rejects unhandled", () => {
	it("keeps the oversized reason when the cancel algorithm rejects", async () => {
		const network = createFakeFetch({
			stream: () => chunkStream(8 * 1024, 16),
			rejectCancel: true,
		});
		const result = await withoutUnhandledRejections(() =>
			classifyJevBatch({
				batch: BATCH_A,
				deadline: createJevDeadline(BUDGET_MS),
				registry: createFakeRegistry().registry,
				fetch: network.fetch,
				maxResponseBytes: 32 * 1024,
			}),
		);
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-response-too-large");
		assert.equal(network.cancelled(), 1);
		assert.ok(!failure.detail.includes(CANCEL_FAILURE));
		assertRedacted(failure.detail);
	});

	it("keeps the HTTP status when an error body's cancel rejects", async () => {
		const network = createFakeFetch({
			status: 503,
			body: "unavailable",
			rejectCancel: true,
		});
		const result = await withoutUnhandledRejections(() =>
			classifyJevBatch({
				batch: BATCH_A,
				deadline: createJevDeadline(BUDGET_MS),
				registry: createFakeRegistry().registry,
				fetch: network.fetch,
			}),
		);
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-http-error");
		assert.ok(failure.detail.includes("503"));
		assert.equal(network.cancelled(), 1);
		assert.ok(!failure.detail.includes(CANCEL_FAILURE));
	});

	it("reports an errored response body without echoing the failure", async () => {
		const network = createFakeFetch({
			stream: erroringStream,
			rejectCancel: true,
		});
		const result = await withoutUnhandledRejections(() =>
			classifyJevBatch({
				batch: BATCH_A,
				deadline: createJevDeadline(BUDGET_MS),
				registry: createFakeRegistry().registry,
				fetch: network.fetch,
			}),
		);
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-invalid-response");
		assert.ok(!failure.detail.includes(READ_FAILURE));
		assertRedacted(failure.detail);
	});
});

describe("only a bounded readable stream is accepted", () => {
	it("fails closed when a success response carries no body", async () => {
		const network = createFakeFetch({
			response: () => new Response(null, { status: 200 }),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-adapter-incompatible");
		assert.equal(network.requests.length, 1);
		assertRedacted(failure.detail);
	});

	it("never buffers a foreign body through arrayBuffer", async () => {
		let buffered = 0;
		const foreign = {
			status: 200,
			ok: true,
			statusText: "OK",
			headers: new Headers(),
			// Not a ReadableStream of this realm, so it cannot be bounded.
			body: { getReader: () => ({ read: async () => ({ done: true }) }) },
			arrayBuffer: async () => {
				buffered += 1;
				return new TextEncoder().encode("x".repeat(1_000_000)).buffer;
			},
		};
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: createFakeFetch({ response: () => foreign }).fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-adapter-incompatible");
		assert.equal(buffered, 0);
	});

	it("fails closed when the body cannot be read as a stream", async () => {
		const locked = new Response("{}", { status: 200 });
		// A body another consumer already locked cannot be bounded here.
		locked.body?.getReader();
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry().registry,
			fetch: createFakeFetch({ response: () => locked }).fetch,
		});
		assert.equal(failureOf(result).reason, "jev-adapter-incompatible");
	});
});

describe("response bound validation", () => {
	it("accepts only a positive safe integer up to the pinned maximum", () => {
		for (const bound of [1, 1024, 32 * 1024, JEV_MAX_RESPONSE_BYTES])
			assert.equal(requireJevResponseBound(bound), bound);
		assert.equal(requireJevResponseBound(undefined), JEV_MAX_RESPONSE_BYTES);
		for (const invalid of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			JEV_MAX_RESPONSE_BYTES + 1,
			Number.MAX_SAFE_INTEGER,
		])
			assert.throws(() => requireJevResponseBound(invalid), TypeError);
	});

	it("rejects an out-of-range bound before creating an observer", () => {
		for (const invalid of [0, Number.NaN, JEV_MAX_RESPONSE_BYTES + 1])
			assert.throws(
				() =>
					createBoundedObservingFetch({
						batch: BATCH_A,
						maxResponseBytes: invalid,
					}),
				TypeError,
			);
	});

	it("rejects an out-of-range bound before any lookup or egress", async () => {
		const fake = createFakeRegistry();
		const network = createFakeFetch({ body: "{}" });
		await assert.rejects(
			() =>
				classifyJevBatch({
					batch: BATCH_A,
					deadline: createJevDeadline(BUDGET_MS),
					registry: fake.registry,
					fetch: network.fetch,
					maxResponseBytes: Number.POSITIVE_INFINITY,
				}),
			TypeError,
		);
		assert.equal(fake.lookups.length, 0);
		assert.equal(fake.classifyCalls.length, 0);
		assert.equal(network.requests.length, 0);
	});
});

describe("the overall budget is re-checked on its own clock", () => {
	it("refuses evidence whose call answered after the deadline", async () => {
		const time = clock();
		const deadline = createJevDeadline(BUDGET_MS, time.now);
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline,
			registry: createFakeRegistry().registry,
			// A valid answer that nonetheless consumed more than the budget;
			// the real timer has not fired yet.
			fetch: (input, init) => {
				time.advance(BUDGET_MS + 100);
				return network.fetch(input, init);
			},
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-timeout");
		// The request really was sent and really did answer.
		assert.equal(network.requests.length, 1);
		assert.equal(deadline.remainingMs(), 0);
		assertRedacted(failure.detail);
	});

	it("still accepts evidence that answered inside the budget", async () => {
		const time = clock();
		const deadline = createJevDeadline(BUDGET_MS, time.now);
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline,
			registry: createFakeRegistry().registry,
			fetch: (input, init) => {
				time.advance(BUDGET_MS - 1);
				return network.fetch(input, init);
			},
		});
		assert.equal(result.status, "ok");
	});
});

describe("an unobserved answer is never evidence", () => {
	const successWithoutRequest = async (model: any) => ({
		api: "typesafe-system-one",
		provider: "typesafe",
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: 0,
	});

	it("reports a completed classification that bypassed the observer", async () => {
		const network = createFakeFetch({ body: "{}" });
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({ classify: successWithoutRequest })
				.registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-adapter-incompatible");
		assert.equal(network.requests.length, 0);
		assertRedacted(failure.detail);
	});

	it("reports a failed classification before any request as authentication", async () => {
		const network = createFakeFetch({ body: "{}" });
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({
				classify: async (model: any) => ({
					api: "typesafe-system-one",
					provider: "typesafe",
					model: model.id,
					answers: {},
					stopReason: "error",
					errorMessage: `System One API error: no key for ${HOST_API_KEY}`,
					timestamp: 0,
				}),
			}).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		assert.equal(failure.reason, "jev-auth-unavailable");
		assert.equal(network.requests.length, 0);
		assertRedacted(failure.detail);
	});

	it("keeps an observer refusal authoritative over a captured success", async () => {
		const network = createFakeFetch({
			body: wireBodyFor(BATCH_A, BATCH_A_SPEC),
		});
		const result = await classifyJevBatch({
			batch: BATCH_A,
			deadline: createJevDeadline(BUDGET_MS),
			registry: createFakeRegistry({ duplicateAfterSuccess: true }).registry,
			fetch: network.fetch,
		});
		const failure = failureOf(result);
		// The first request answered correctly, but the adapter sent a second.
		assert.equal(network.requests.length, 1);
		assert.equal(failure.reason, "jev-adapter-incompatible");
	});
});
