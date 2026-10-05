/**
 * Offline fixtures for the advisory router: a fake host registry over the
 * **real** installed Pi TypeSafe classifier adapter, a recording fake fetch,
 * and a cooperative wire-response builder. No network access occurs.
 */
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { TYPESAFE_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/typesafe.models";
import type { JsonObject } from "../pi-extension/subagents/type-guards.ts";
import { AUTO_ROUTING_JEV_MODEL } from "../pi-extension/subagents/auto-routing-policy.ts";
import {
	JEV_ROUTER_DISCLOSURE_VERSION,
	JEV_ROUTER_POLICY_VERSION,
	JEV_ROUTER_QUESTION_VERSION,
	parseJevRouterConfig,
	jevRouterConfigDigest,
	type LoadedJevRouterConfig,
} from "../pi-extension/subagents/jev-router-config.ts";
import {
	JEV_ADVISORY_QUESTION_IDS,
	jevAdvisoryFitQuestionId,
	type JevAdvisoryBatch,
	type JevAdvisoryRoute,
} from "../pi-extension/subagents/jev-router-questions.ts";
import type { JevRouterInputs } from "../pi-extension/subagents/jev-router.ts";

export const HOST_KEY = "host-auth-key-FAKE-1";
export const FALLBACK_KEY = "fallback-file-key-FAKE-2";
export const SECRET_TASK = "Refactor the SECRET-TENANT-77 billing exporter.";

export const ROUTES: readonly JevAdvisoryRoute[] = Object.freeze([
	{ name: "review", description: "Code review of a finished change" },
	{ name: "build", description: "Implement a bounded code change" },
	{ name: "scout" },
]);

export const ENABLED_RAW = Object.freeze({
	version: 1,
	enabled: true,
	questionVersion: JEV_ROUTER_QUESTION_VERSION,
	policyVersion: JEV_ROUTER_POLICY_VERSION,
	consent: {
		disclosureVersion: JEV_ROUTER_DISCLOSURE_VERSION,
		acknowledgedAt: "2026-10-05T00:00:00Z",
		sendExplicitBriefAndRouteDescriptions: true,
	},
});

export function enabledInputs(
	routes: readonly JevAdvisoryRoute[] | undefined = ROUTES,
	raw: JsonObject = ENABLED_RAW,
): JevRouterInputs {
	const config = parseJevRouterConfig(raw);
	if (!config.enabled) throw new Error("fixture config must be enabled");
	const loaded: LoadedJevRouterConfig = {
		status: "enabled",
		source: "fixture",
		config,
		digest: jevRouterConfigDigest(config),
	};
	return { config: loaded, routes };
}

// ---------------------------------------------------------------------------
// Cooperative wire response
// ---------------------------------------------------------------------------

export type AnswerSpec = Readonly<{
	choice: string;
	/** Mass given to `choice`; the rest is spread evenly. */
	mass?: number;
	confidence?: number;
	probabilities?: Readonly<Record<string, number>>;
}>;

function answer(options: readonly string[], spec: AnswerSpec) {
	const mass = spec.mass ?? 0.96;
	const others = options.filter((option) => option !== spec.choice);
	const probabilities: Record<string, number> = {};
	for (const option of others)
		probabilities[option] = (1 - mass) / others.length;
	probabilities[spec.choice] = mass;
	return {
		type: "choice",
		choice: spec.choice,
		probabilities: spec.probabilities ?? probabilities,
		confidence: spec.confidence ?? 0.95,
	};
}

export type WireSpec = Readonly<{
	/** Wire option for primary_route (an opaque route id or `none`). */
	primary?: AnswerSpec;
	/** Overrides by question id. */
	answers?: Readonly<Record<string, AnswerSpec>>;
	model?: string;
	usage?: JsonObject;
	mutate?: (wire: any) => void;
}>;

/** A cooperative Jev: sharp primary on the first route and its fit, easy brief. */
export function cooperativeWire(batch: JevAdvisoryBatch, spec: WireSpec = {}) {
	const primary = spec.primary ?? { choice: batch.routes[0].id };
	const defaults = new Map<string, AnswerSpec>([
		[JEV_ADVISORY_QUESTION_IDS.primary, primary],
		[JEV_ADVISORY_QUESTION_IDS.stages, { choice: "single_step" }],
		[JEV_ADVISORY_QUESTION_IDS.context, { choice: "sufficient" }],
		[JEV_ADVISORY_QUESTION_IDS.difficulty, { choice: "localized" }],
		[JEV_ADVISORY_QUESTION_IDS.risk, { choice: "local" }],
	]);

	for (const route of batch.routes)
		defaults.set(jevAdvisoryFitQuestionId(route.id), {
			choice: route.id === primary.choice ? "yes" : "no",
		});
	const answers: JsonObject = {};
	for (const question of batch.expected)
		answers[question.id] = answer(
			question.options,
			spec.answers?.[question.id] ?? defaults.get(question.id)!,
		);
	const wire = {
		model: spec.model ?? AUTO_ROUTING_JEV_MODEL,
		answers,
		usage: spec.usage ?? { input_tokens: 900, output_tokens: 40 },
	};
	spec.mutate?.(wire);
	return wire;
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

export type RecordedRequest = Readonly<{
	input: any;
	method: any;
	redirect: any;
	headers: any;
	body: any;
}>;

export type FakeFetch = Readonly<{
	fetch: (input: any, init?: any) => Promise<any>;
	requests: RecordedRequest[];
}>;

export function createFakeFetch(
	respond: (request: RecordedRequest) => Promise<Response> | Response,
): FakeFetch {
	const requests: RecordedRequest[] = [];
	return {
		requests,
		fetch: async (input, init) => {
			const request = Object.freeze({
				input,
				method: init?.method,
				redirect: init?.redirect,
				headers: init?.headers,
				body: init?.body,
			});
			requests.push(request);
			return respond(request);
		},
	};
}

export const jsonResponse = (value: JsonObject, status = 200) =>
	new Response(JSON.stringify(value), { status });

// ---------------------------------------------------------------------------
// Fake registry over the real adapter
// ---------------------------------------------------------------------------

export type FakeRegistryOptions = Readonly<{
	configuredAuth?: boolean;
	/** Delay before the host resolves its own authentication. */
	authDelayMs?: number;
	onAuth?: () => void;
}>;

export function createFakeRegistry(options: FakeRegistryOptions = {}) {
	const provider = typesafeProvider();
	const classifyCalls: Array<{ options: any }> = [];
	const configured = options.configuredAuth ?? true;
	const registry = {
		findOfType: (_type: string, providerId: string, modelId: string) =>
			providerId === "typesafe"
				? // SAFETY: the fake catalog only ever serves the jev-latest alias.
					TYPESAFE_CLASSIFIER_MODELS[modelId as "jev-latest"]
				: undefined,
		hasConfiguredAuth: () => configured,
		async classify(model: any, context: any, callOptions: any) {
			classifyCalls.push({ options: callOptions });
			options.onAuth?.();
			if (options.authDelayMs !== undefined)
				await new Promise((resolve) =>
					setTimeout(resolve, options.authDelayMs),
				);
			// Request-local keys win inside Pi's own adapter; a configured host
			// supplies its key only when the caller gave none.
			const apiKey = callOptions.apiKey ?? (configured ? HOST_KEY : undefined);
			return provider.classify!(model, context, { ...callOptions, apiKey });
		},
		getApiKeyAndHeaders() {
			throw new Error("The router must never read host credentials.");
		},
	};
	return { registry, classifyCalls };
}

/** The Authorization header the real adapter sent. */
export const authorizationOf = (request: RecordedRequest): string | undefined =>
	request.headers?.authorization ?? request.headers?.Authorization;
