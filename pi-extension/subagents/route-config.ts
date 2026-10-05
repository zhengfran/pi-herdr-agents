import { readFileSync } from "node:fs";
import { getSubagentsConfigPath } from "./config-path.ts";
import { NATIVE_MODEL_ID } from "./model-config.ts";
import { isThinkingLevel, type ThinkingLevel } from "./runtime-routing.ts";
import { isPlainObject, isString } from "./type-guards.ts";

/** One complete launch choice: which role runs where, on what, how hard. */
export interface RouteCandidate {
	agent: string;
	harness: "pi" | "claude" | "kiro";
	model: string;
	thinking: ThinkingLevel;
}

export interface Route {
	description?: string;
	candidates: RouteCandidate[];
}

/** Opt-in enforcement: a protected agent launches only through listed routes. */
export interface RoutePolicy {
	requiredForAgents: Record<string, string[]>;
}

export interface RouteConfig {
	routes: Record<string, Route>;
	routePolicy?: RoutePolicy;
}

const ROUTE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_ROUTES = 32;
const MAX_CANDIDATES = 16;
const MAX_DESCRIPTION_LENGTH = 256;
const ROUTE_KEYS = new Set(["description", "candidates"]);
const POLICY_KEYS = new Set(["requiredForAgents"]);
const CANDIDATE_KEYS = new Set(["agent", "harness", "model", "thinking"]);

function invalidRouteConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent route config in ${source}: ${message}`);
}

function rejectUnsupportedKeys(
	value: any,
	allowed: Set<string>,
	field: string,
	source: string,
): void {
	const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
	if (unsupported.length > 0)
		invalidRouteConfig(
			source,
			`${field} has unsupported key(s): ${unsupported.join(", ")}`,
		);
}

function parseCandidate(
	value: any,
	field: string,
	source: string,
): RouteCandidate {
	if (!isPlainObject(value))
		invalidRouteConfig(source, `${field} must be an object`);
	rejectUnsupportedKeys(value, CANDIDATE_KEYS, field, source);
	const { agent, harness, model, thinking } = value;
	if (!isString(agent) || agent.trim() === "")
		invalidRouteConfig(source, `${field}.agent must be a non-empty string`);
	if (harness !== "pi" && harness !== "claude" && harness !== "kiro")
		invalidRouteConfig(source, `${field}.harness must be pi, claude, or kiro`);
	if (!isString(model) || model.trim() === "")
		invalidRouteConfig(source, `${field}.model must be a non-empty string`);
	const exactModel = model.trim();
	// A candidate is one exact runtime; lists and task aliases belong elsewhere.
	if (exactModel.includes(",") || /^task:/i.test(exactModel))
		invalidRouteConfig(
			source,
			`${field}.model must be one exact model, not a list or task: alias`,
		);
	if (harness === "pi" && !exactModel.includes("/"))
		invalidRouteConfig(
			source,
			`${field}.model must be a Pi provider/model-id for harness pi`,
		);
	if (harness !== "pi" && !NATIVE_MODEL_ID.test(exactModel))
		invalidRouteConfig(
			source,
			`${field}.model must be a native ${harness} CLI model ID`,
		);
	if (!isString(thinking) || !isThinkingLevel(thinking))
		invalidRouteConfig(
			source,
			`${field}.thinking must be one of off, minimal, low, medium, high, xhigh, max`,
		);
	if (harness !== "pi" && (thinking === "off" || thinking === "minimal"))
		invalidRouteConfig(
			source,
			`${field}.thinking must be low through max for native harness ${harness}`,
		);
	return { agent: agent.trim(), harness, model: exactModel, thinking };
}

function parseRoutePolicy(
	value: any,
	routes: Record<string, Route>,
	source: string,
): RoutePolicy {
	if (!isPlainObject(value))
		invalidRouteConfig(source, "routePolicy must be an object");
	rejectUnsupportedKeys(value, POLICY_KEYS, "routePolicy", source);
	const mapping = value.requiredForAgents;
	if (!isPlainObject(mapping))
		invalidRouteConfig(
			source,
			"routePolicy.requiredForAgents must be an object mapping agent names to route name arrays",
		);
	const requiredForAgents: Record<string, string[]> = {};
	for (const [agent, names] of Object.entries(mapping)) {
		const field = `routePolicy.requiredForAgents[${JSON.stringify(agent)}]`;
		if (agent.trim() === "" || agent !== agent.trim())
			invalidRouteConfig(
				source,
				"routePolicy.requiredForAgents agent names must be non-blank and untrimmed",
			);
		if (!Array.isArray(names) || names.length === 0)
			invalidRouteConfig(source, `${field} must be a non-empty array`);
		const seen = new Set<string>();
		for (const name of names) {
			if (!isString(name) || name === "")
				invalidRouteConfig(
					source,
					`${field} entries must be route name strings`,
				);
			if (seen.has(name))
				invalidRouteConfig(source, `${field} repeats route "${name}"`);
			seen.add(name);
			if (!Object.hasOwn(routes, name))
				invalidRouteConfig(source, `${field} names unknown route "${name}"`);
			if (!routes[name].candidates.some((entry) => entry.agent === agent))
				invalidRouteConfig(
					source,
					`${field} route "${name}" has no candidate for agent "${agent}"`,
				);
		}
		Object.defineProperty(requiredForAgents, agent, {
			value: [...names],
			enumerable: true,
		});
	}
	return { requiredForAgents };
}

/** Routes through which `agent` may launch, or undefined when unprotected. */
export function requiredRoutesForAgent(
	config: RouteConfig,
	agent: string | undefined,
): string[] | undefined {
	const mapping = config.routePolicy?.requiredForAgents;
	const name = agent?.trim();
	return mapping && name && Object.hasOwn(mapping, name)
		? mapping[name]
		: undefined;
}

export function parseRouteConfig(
	rawConfig: any,
	source = "config.json",
): RouteConfig {
	if (!isPlainObject(rawConfig))
		invalidRouteConfig(source, "root must be an object");
	const hasPolicy = Object.hasOwn(rawConfig, "routePolicy");
	if (!Object.hasOwn(rawConfig, "routes")) {
		if (hasPolicy) parseRoutePolicy(rawConfig.routePolicy, {}, source);
		return { routes: {} };
	}
	const routes = rawConfig.routes;
	if (!isPlainObject(routes))
		invalidRouteConfig(source, "routes must be an object");
	const names = Object.keys(routes);
	if (names.length > MAX_ROUTES)
		invalidRouteConfig(
			source,
			`routes may define at most ${MAX_ROUTES} routes`,
		);
	const parsedRoutes: Record<string, Route> = {};
	for (const name of names) {
		const field = `routes.${name}`;
		if (!ROUTE_NAME.test(name))
			invalidRouteConfig(
				source,
				`${field} name must match ${ROUTE_NAME.source}`,
			);
		const route = routes[name];
		if (!isPlainObject(route))
			invalidRouteConfig(source, `${field} must be an object`);
		rejectUnsupportedKeys(route, ROUTE_KEYS, field, source);
		let description: string | undefined;
		if (route.description !== undefined) {
			if (
				!isString(route.description) ||
				route.description.trim() === "" ||
				route.description.length > MAX_DESCRIPTION_LENGTH
			)
				invalidRouteConfig(
					source,
					`${field}.description must be a non-empty string of at most ${MAX_DESCRIPTION_LENGTH} characters`,
				);
			description = route.description.trim();
		}
		const candidates = route.candidates;
		if (
			!Array.isArray(candidates) ||
			candidates.length === 0 ||
			candidates.length > MAX_CANDIDATES
		)
			invalidRouteConfig(
				source,
				`${field}.candidates must be an array of 1-${MAX_CANDIDATES} candidates`,
			);
		const parsed = candidates.map((candidate, index) =>
			parseCandidate(candidate, `${field}.candidates[${index}]`, source),
		);
		const seen = new Set<string>();
		for (const [index, candidate] of parsed.entries()) {
			const key = JSON.stringify(candidate);
			if (seen.has(key))
				invalidRouteConfig(
					source,
					`${field}.candidates[${index}] duplicates an earlier candidate`,
				);
			seen.add(key);
		}
		Object.defineProperty(parsedRoutes, name, {
			value: description
				? { description, candidates: parsed }
				: { candidates: parsed },
			enumerable: true,
		});
	}
	if (!hasPolicy) return { routes: parsedRoutes };
	return {
		routes: parsedRoutes,
		routePolicy: parseRoutePolicy(rawConfig.routePolicy, parsedRoutes, source),
	};
}

export function loadRouteConfig(
	configPath = getSubagentsConfigPath(),
): RouteConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error) {
		// SAFETY: readFileSync errors expose the Node errno code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { routes: {} };
		throw error;
	}
	try {
		return parseRouteConfig(JSON.parse(raw), configPath);
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error(
				`Invalid JSON in subagent route config ${configPath}: ${error.message}`,
			);
		throw error;
	}
}

export function formatRouteCandidate(candidate: RouteCandidate): string {
	return `${candidate.agent} on ${candidate.harness} ${candidate.model} (${candidate.thinking})`;
}

export interface RouteSelection<T> {
	candidate: RouteCandidate;
	index: number;
	value: T;
	skipped: { candidate: RouteCandidate; reason: string }[];
}

/**
 * Try candidates in configured order and keep the first one `prepare`
 * accepts. `prepare` must be resource-free; it reports a rejection by
 * returning `{ ok: false, reason }` or by throwing.
 */
export function selectRouteCandidate<T>(
	route: Route,
	prepare: (
		candidate: RouteCandidate,
	) => { ok: true; value: T } | { ok: false; reason: string },
):
	| RouteSelection<T>
	| { skipped: { candidate: RouteCandidate; reason: string }[] } {
	const skipped: { candidate: RouteCandidate; reason: string }[] = [];
	for (const [index, candidate] of route.candidates.entries()) {
		let outcome: { ok: true; value: T } | { ok: false; reason: string };
		try {
			outcome = prepare(candidate);
		} catch (error) {
			outcome = {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		if (outcome.ok) return { candidate, index, value: outcome.value, skipped };
		skipped.push({ candidate, reason: outcome.reason });
	}
	return { skipped };
}
