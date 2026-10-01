import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";
import type { TaskPreferences } from "./model-config.ts";
import { isFiniteNumber, isString } from "./type-guards.ts";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/**
 * Per-field source. `agent` flattens a role's own value and a configured
 * default; the additive `provenance` record tells them apart.
 */
export type RuntimeSource = "request" | "agent" | "parent" | "auto";

/** Canonical origin of one runtime field. */
export type RuntimeFieldSource =
	| "request"
	| "role"
	| "default"
	| "parent"
	| "auto";

/** Where a value below the request came from. */
export type RuntimeDefaultOrigin = (
	| { source: "role" }
	| { source: "default"; defaultKey: string }
) & {
	/** The harness the value belongs to, when another harness runs. */
	harness?: "pi" | "claude" | "kiro";
};

export interface RuntimeFieldProvenance {
	source: RuntimeFieldSource;
	/** The configured default that applied, such as `models.default`. */
	defaultKey?: string;
	/** Automatic selections only: the default the approved tuple replaced. */
	replaced?: { value: string } & RuntimeDefaultOrigin;
}

/** Versioned per-field provenance, additive to the legacy source fields. */
export interface RuntimeProvenance {
	version: 1;
	model: RuntimeFieldProvenance;
	thinking: RuntimeFieldProvenance;
}

export interface RuntimeRequest {
	model?: string;
	thinking?: ThinkingLevel;
	/**
	 * Who chose these fields; omitted means the caller's request. `auto` is
	 * an administrator-approved exact tuple set only by trusted internal
	 * callers: both fields are required and validated as explicit exact
	 * selections on a physical model, thinking is never clamped, and no
	 * default is a fallback: defaults are recorded only as `replaced`.
	 */
	source?: "request" | "auto";
}

/** Role and configured values below the request in precedence. */
export interface RuntimeDefaults {
	model?: string;
	thinking?: ThinkingLevel;
	/**
	 * Canonical origin of `model`, which the legacy `agent` source flattens,
	 * and of `thinking` (the role when omitted). Supplying it records
	 * per-field `provenance` on the plan.
	 */
	origin?: {
		model: RuntimeDefaultOrigin | undefined;
		thinking?: RuntimeDefaultOrigin;
	};
}

/**
 * API id of Pi's virtual catalog entries, which route each request to some
 * physical model; mirrors `VIRTUAL_MODEL_API` of pi-coding-agent.
 */
export const VIRTUAL_MODEL_API = "pi-virtual";

export interface ParentRuntime {
	provider: string;
	modelId: string;
	thinking: ThinkingLevel;
}

export interface RoutingModel {
	provider: string;
	id: string;
	/** Model API id; `pi-virtual` marks a routing (virtual) catalog entry. */
	api?: string;
	reasoning: boolean;
	thinkingLevelMap?: Model<any>["thinkingLevelMap"];
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface ModelRegistryAdapter {
	find(provider: string, modelId: string): RoutingModel | undefined;
	available(): RoutingModel[];
	hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

export interface ResolvedRuntimePlan {
	provider: string;
	modelId: string;
	model: string;
	thinking: ThinkingLevel;
	modelSource: RuntimeSource;
	thinkingSource: RuntimeSource;
	/** Set for caller and role/config selections, never automatic ones. */
	requestedModel?: string;
	requestedThinking?: ThinkingLevel;
	provenance?: RuntimeProvenance;
	thinkingAdjustment?: {
		from: ThinkingLevel;
		to: ThinkingLevel;
		reason: "non-reasoning" | "inherited-clamp";
	};
	observed?: {
		model?: string;
		thinking?: ThinkingLevel;
	};
	runtimeMismatch?: string;
}

export class RuntimeResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeResolutionError";
	}
}

export function parseExactModelRef(
	reference: string,
): { provider: string; modelId: string } | undefined {
	const trimmed = reference.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, separator).trim();
	const modelId = trimmed.slice(separator + 1).trim();
	return provider && modelId ? { provider, modelId } : undefined;
}

function toRoutingModel(value: any): RoutingModel | undefined {
	if (!value || !isString(value.provider) || !isString(value.id)) {
		return undefined;
	}
	const model: RoutingModel = {
		provider: value.provider,
		id: value.id,
		reasoning: value.reasoning ?? false,
		thinkingLevelMap: value.thinkingLevelMap,
		input: Array.isArray(value.input) ? value.input : undefined,
		contextWindow: isFiniteNumber(value.contextWindow)
			? value.contextWindow
			: undefined,
		maxTokens: isFiniteNumber(value.maxTokens) ? value.maxTokens : undefined,
		cost: value.cost,
	};
	if (isString(value.api)) model.api = value.api;
	return model;
}

export function wrapPiModelRegistry(registry: {
	find(provider: string, modelId: string): any;
	getAvailable?: () => any[];
	getAll?: () => any[];
	hasConfiguredAuth?: (model: any) => boolean;
}): ModelRegistryAdapter {
	return {
		find(provider, modelId) {
			return toRoutingModel(registry.find(provider, modelId));
		},
		available() {
			const direct = registry.getAvailable?.() ?? [];
			const source = direct.length > 0 ? direct : (registry.getAll?.() ?? []);
			const models: RoutingModel[] = [];
			const seen = new Set<string>();
			for (const raw of source) {
				const candidate = toRoutingModel(raw);
				if (!candidate) continue;
				if (
					direct.length === 0 &&
					registry.hasConfiguredAuth &&
					!registry.hasConfiguredAuth(raw)
				) {
					continue;
				}
				const ref = `${candidate.provider}/${candidate.id}`;
				if (seen.has(ref)) continue;
				seen.add(ref);
				models.push(candidate);
			}
			return models;
		},
		hasConfiguredAuth(model) {
			if (!registry.hasConfiguredAuth) {
				return (registry.getAvailable?.() ?? []).some(
					(candidate) =>
						candidate.provider === model.provider && candidate.id === model.id,
				);
			}
			const original = registry.find(model.provider, model.id);
			return !!original && registry.hasConfiguredAuth(original);
		},
	};
}

function asPiModel(model: RoutingModel): Model<any> {
	return {
		provider: model.provider,
		id: model.id,
		name: model.id,
		api: "openai-completions",
		baseUrl: "",
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input?.filter(
			(entry): entry is "text" | "image" =>
				entry === "text" || entry === "image",
		) ?? ["text"],
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0,
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cacheRead ?? 0,
			cacheWrite: model.cost?.cacheWrite ?? 0,
		},
	};
}

function formatSupported(model: RoutingModel): string {
	const levels = getSupportedThinkingLevels(asPiModel(model));
	return levels.length > 0 ? levels.join(", ") : "(none)";
}

interface FieldSelection {
	value?: string;
	source: RuntimeSource;
}

function selectField(
	requestValue: string | undefined,
	agentValue: string | undefined,
	requestSource: RuntimeRequest["source"] = "request",
): FieldSelection {
	// An automatic tuple supplies every field; no default is a fallback.
	if (requestSource === "auto") return { value: requestValue, source: "auto" };
	if (requestValue != null && requestValue !== "") {
		return { value: requestValue, source: "request" };
	}
	if (agentValue != null && agentValue !== "") {
		return { value: agentValue, source: "agent" };
	}
	return { source: "parent" };
}

export function parseModelFallbacks(reference: string): string[] {
	const candidates = reference.split(",").map((candidate) => candidate.trim());
	if (candidates.some((candidate) => candidate === "")) {
		throw new RuntimeResolutionError(
			`model fallback list ${JSON.stringify(reference)} cannot contain an empty candidate`,
		);
	}
	return candidates;
}

/** An automatic tuple names one exact model and one exact thinking level. */
function assertAutomaticRequest(request: RuntimeRequest): void {
	const model = request.model ?? "";
	if (
		/^task:/i.test(model) ||
		/[\s,]/u.test(model) ||
		!parseExactModelRef(model)
	)
		throw new RuntimeResolutionError(
			`automatic model ${JSON.stringify(model)} must be one exact provider/model-id; lists, task: references, and defaults are never automatic selections`,
		);
	if (!request.thinking || !isThinkingLevel(request.thinking))
		throw new RuntimeResolutionError(
			`automatic thinking ${JSON.stringify(request.thinking ?? "")} must be one exact level: ${THINKING_LEVELS.join(", ")}`,
		);
}

/** An automatic field, with the value it replaced when one would apply. */
export function automaticFieldProvenance(
	replacedValue: string | undefined,
	replacedOrigin: RuntimeDefaultOrigin | undefined,
): RuntimeFieldProvenance {
	return replacedValue && replacedOrigin
		? { source: "auto", replaced: { value: replacedValue, ...replacedOrigin } }
		: { source: "auto" };
}

function fieldProvenance(
	source: RuntimeSource,
	defaultValue: string | undefined,
	defaultOrigin: RuntimeDefaultOrigin | undefined,
): RuntimeFieldProvenance | undefined {
	switch (source) {
		case "request":
		case "parent":
			return { source };
		case "agent":
			return defaultOrigin && { ...defaultOrigin };
		case "auto":
			return automaticFieldProvenance(defaultValue, defaultOrigin);
	}
}

export function resolveRuntimePlan(
	request: RuntimeRequest,
	agentDefaults: RuntimeDefaults,
	parent: ParentRuntime,
	registry: ModelRegistryAdapter,
): ResolvedRuntimePlan {
	const automatic = request.source === "auto";
	if (automatic) assertAutomaticRequest(request);
	const modelSelection = selectField(
		request.model,
		agentDefaults.model,
		request.source,
	);
	let provider = parent.provider;
	let modelId = parent.modelId;
	let selectedModel = registry.find(provider, modelId);

	if (modelSelection.value) {
		const parsed = parseExactModelRef(modelSelection.value);
		if (!parsed) {
			throw new RuntimeResolutionError(
				`model ${JSON.stringify(modelSelection.value)} must be an exact authenticated provider/model-id`,
			);
		}
		const found = registry.find(parsed.provider, parsed.modelId);
		if (!found) {
			const alternatives = registry
				.available()
				.map((model) => `${model.provider}/${model.id}`);
			throw new RuntimeResolutionError(
				`unknown model ${JSON.stringify(modelSelection.value)}; exact registry match required. Available: ${alternatives.join(", ") || "(none)"}`,
			);
		}
		if (!registry.hasConfiguredAuth(found)) {
			throw new RuntimeResolutionError(
				`model ${JSON.stringify(modelSelection.value)} has no configured authentication`,
			);
		}
		if (
			automatic &&
			(found.provider !== parsed.provider || found.id !== parsed.modelId)
		)
			throw new RuntimeResolutionError(
				`automatic model ${JSON.stringify(modelSelection.value)} resolved to ${JSON.stringify(`${found.provider}/${found.id}`)}; an exact registry identity is required`,
			);
		// A virtual entry routes each request elsewhere, and an unknown API
		// cannot prove otherwise: automatic tuples need a physical model.
		if (automatic && found.api === VIRTUAL_MODEL_API)
			throw new RuntimeResolutionError(
				`automatic model ${JSON.stringify(modelSelection.value)} is a virtual routing model; an exact physical model is required`,
			);
		if (automatic && !found.api)
			throw new RuntimeResolutionError(
				`automatic model ${JSON.stringify(modelSelection.value)} has no known model API; an exact physical model is required`,
			);
		if (automatic && found.input && !found.input.includes("text"))
			throw new RuntimeResolutionError(
				`automatic model ${JSON.stringify(modelSelection.value)} does not accept text input`,
			);
		provider = found.provider;
		modelId = found.id;
		selectedModel = found;
	}

	const thinkingSelection = selectField(
		request.thinking,
		agentDefaults.thinking,
		request.source,
	);
	const preferredThinking = thinkingSelection.value ?? parent.thinking;
	if (!isThinkingLevel(preferredThinking)) {
		throw new RuntimeResolutionError(
			`thinking ${JSON.stringify(preferredThinking)} must be one of: ${THINKING_LEVELS.join(", ")}`,
		);
	}

	let thinking = preferredThinking;
	let thinkingAdjustment: ResolvedRuntimePlan["thinkingAdjustment"];
	if (thinkingSelection.source !== "parent") {
		if (!selectedModel) {
			throw new RuntimeResolutionError(
				`model capability information is unavailable; cannot validate explicit thinking ${JSON.stringify(preferredThinking)}`,
			);
		}
		const supported = getSupportedThinkingLevels(asPiModel(selectedModel));
		if (!supported.includes(preferredThinking)) {
			throw new RuntimeResolutionError(
				`thinking ${JSON.stringify(preferredThinking)} is not supported by ${JSON.stringify(`${provider}/${modelId}`)}; supported: ${formatSupported(selectedModel)}`,
			);
		}
	} else if (selectedModel) {
		thinking = clampThinkingLevel(asPiModel(selectedModel), preferredThinking);
		if (thinking !== preferredThinking) {
			thinkingAdjustment = {
				from: preferredThinking,
				to: thinking,
				reason: selectedModel.reasoning ? "inherited-clamp" : "non-reasoning",
			};
		}
	}

	const plan: ResolvedRuntimePlan = {
		provider,
		modelId,
		model: `${provider}/${modelId}`,
		thinking,
		modelSource: modelSelection.source,
		thinkingSource: thinkingSelection.source,
	};
	// An automatic choice is recorded as `auto`, never as a caller request.
	if (modelSelection.value && !automatic)
		plan.requestedModel = modelSelection.value;
	if (thinkingSelection.value && !automatic)
		plan.requestedThinking = preferredThinking;
	if (automatic || agentDefaults.origin) {
		const model = fieldProvenance(
			modelSelection.source,
			agentDefaults.model,
			agentDefaults.origin?.model,
		);
		// Thinking below the request only ever comes from the role.
		const thinking = fieldProvenance(
			thinkingSelection.source,
			agentDefaults.thinking,
			agentDefaults.origin?.thinking ?? { source: "role" },
		);
		if (model && thinking) plan.provenance = { version: 1, model, thinking };
	}
	if (thinkingAdjustment) plan.thinkingAdjustment = thinkingAdjustment;
	return plan;
}

/** Resolve every configured fallback before launching the first child. */
export function resolveRuntimePlans(
	request: RuntimeRequest,
	agentDefaults: RuntimeDefaults,
	parent: ParentRuntime,
	registry: ModelRegistryAdapter,
	taskPreferences?: TaskPreferences,
	worktree = false,
): ResolvedRuntimePlan[] {
	const selection = selectField(
		request.model,
		agentDefaults.model,
		request.source,
	);
	// An automatic tuple is one exact plan: no list, task expansion, or fallback.
	if (!selection.value || selection.source === "auto")
		return [resolveRuntimePlan(request, agentDefaults, parent, registry)];

	let references: string[];
	const trimmed = selection.value.trim();
	if (
		selection.value
			.split(",")
			.some((candidate) =>
				candidate.trim().toLowerCase().startsWith("task:"),
			) &&
		trimmed.includes(",")
	) {
		throw new RuntimeResolutionError(
			"task: references must be the entire model value, not part of a fallback list",
		);
	}
	if (trimmed.toLowerCase().startsWith("task:")) {
		if (selection.source !== "request") {
			throw new RuntimeResolutionError(
				"task: references are only valid in the subagent tool's model parameter",
			);
		}
		const category = trimmed.slice("task:".length).trim().toLowerCase();
		const configuredCategories = Object.keys(taskPreferences ?? {});
		if (
			!category ||
			!taskPreferences ||
			!Object.hasOwn(taskPreferences, category)
		) {
			throw new RuntimeResolutionError(
				`task category ${JSON.stringify(category)} is not configured; configured categories: ${configuredCategories.join(", ") || "(none)"}`,
			);
		}
		// SAFETY: Object.hasOwn above confirms this lower-cased category is a configured key.
		const candidates = taskPreferences[category as keyof TaskPreferences] ?? [];
		references = candidates.filter((candidate) => {
			const parsed = parseExactModelRef(candidate);
			const model = parsed && registry.find(parsed.provider, parsed.modelId);
			return !!model && registry.hasConfiguredAuth(model);
		});
		if (references.length === 0) {
			const alternatives = registry
				.available()
				.filter((model) => registry.hasConfiguredAuth(model))
				.map((model) => `${model.provider}/${model.id}`);
			throw new RuntimeResolutionError(
				`task category ${JSON.stringify(category)} has no authenticated candidates; authenticated alternatives: ${alternatives.join(", ") || "(none)"}`,
			);
		}
		if (worktree) references = [references[0]];
	} else {
		references = parseModelFallbacks(selection.value);
	}

	return references.map((model) =>
		resolveRuntimePlan(
			selection.source === "request"
				? { ...request, model }
				: { ...request, model: undefined },
			selection.source === "agent"
				? { ...agentDefaults, model }
				: agentDefaults,
			parent,
			registry,
		),
	);
}

function formatTokenCount(value: number | undefined): string | undefined {
	if (!value || value <= 0) return undefined;
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

export function getAuthenticatedTaskPreferences(
	registry: ModelRegistryAdapter,
	taskPreferences?: TaskPreferences,
): TaskPreferences {
	const authenticated: TaskPreferences = {};
	for (const [category, candidates] of Object.entries(taskPreferences ?? {})) {
		const available = candidates.filter((candidate) => {
			const parsed = parseExactModelRef(candidate);
			const model = parsed && registry.find(parsed.provider, parsed.modelId);
			return !!model && registry.hasConfiguredAuth(model);
		});
		if (available.length > 0) {
			// SAFETY: parsed task preferences can only contain supported category keys.
			authenticated[category as keyof TaskPreferences] = available;
		}
	}
	return authenticated;
}

export function buildAuthenticatedModelCatalog(
	registry: ModelRegistryAdapter,
	limit = 24,
	taskPreferences?: TaskPreferences,
): string {
	const models = registry
		.available()
		.filter((model) => registry.hasConfiguredAuth(model))
		.sort((a, b) =>
			`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
		);
	const visibleModels = models.slice(0, limit);
	const lines = [
		"Authenticated subagent models (use exact provider/model-id only):",
	];
	for (const model of visibleModels) {
		const supportedThinking = getSupportedThinkingLevels(asPiModel(model));
		const facts = [
			model.reasoning
				? `reasoning (${supportedThinking.join("/") || "no thinking levels"})`
				: "non-reasoning",
			model.input?.includes("image") ? "text+image" : "text",
			formatTokenCount(model.contextWindow)
				? `${formatTokenCount(model.contextWindow)} context`
				: undefined,
			formatTokenCount(model.maxTokens)
				? `${formatTokenCount(model.maxTokens)} max output`
				: undefined,
		].filter(Boolean);
		lines.push(`- ${model.provider}/${model.id} — ${facts.join(", ")}`);
	}
	if (models.length === 0)
		lines.push(
			"- none discovered; omitting model still inherits the parent runtime",
		);
	if (models.length > visibleModels.length) {
		lines.push(
			`- … ${models.length - visibleModels.length} more authenticated models omitted`,
		);
	}
	const configured = Object.entries(
		getAuthenticatedTaskPreferences(registry, taskPreferences),
	);
	if (configured.length > 0) {
		lines.push(
			"Task-category shortlists (use task:<category> only as the entire model value):",
		);
		for (const [category, candidates] of configured)
			lines.push(`- ${category}: ${candidates.join(", ")}`);
		lines.push(
			"For ordinary review, prefer a different authenticated model family. Use an exact authenticated provider/model-id from the shortlist when the authoring family is known. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback. The extension does not enforce this.",
		);
	} else {
		lines.push(
			"For orchestrated children, explicitly select an exact authenticated provider/model-id by task tier first (fast for bounded mechanical work and recon, mid for implementation and review, frontier for architecture, security, hard diagnosis, or adversarial review), then set supported thinking.",
		);
		lines.push(
			"For ordinary review, prefer a different authenticated model family. Use an exact authenticated provider/model-id from the catalog when the authoring family is known. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback.",
		);
	}
	lines.push(
		"Omitting model and thinking inherits the parent runtime as a discouraged fallback.",
	);
	return lines.join("\n");
}
