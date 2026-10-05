/**
 * Strict durable configuration for the advisory `jev_router` tool
 * (`jevRouter`).
 *
 * The section is independent of `autoRouting`: it authorizes only sending an
 * explicit task brief plus configured route names and descriptions to the
 * pinned classifier when the parent calls the tool. It accepts no credential,
 * key path, endpoint, model pin, candidate override, or threshold, and it is
 * read only from the durable `$PI_CODING_AGENT_DIR/herdr-agents/config.json`.
 * A missing file or section is exactly `{version: 1, enabled: false}`; an
 * invalid section disables only this tool's egress. Loading never resolves
 * authentication, reads a key, or invokes the classifier.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	JEV_ROUTER_CONFIG_KEY,
	findDuplicateJevRouterMember,
} from "./auto-routing-json.ts";
import { isStrictIsoTimestamp } from "./auto-routing-config.ts";
import { getSubagentsConfigPath } from "./config-path.ts";
import {
	isFiniteNumber,
	isRecord,
	isString,
	type JsonObject,
} from "./type-guards.ts";

export { JEV_ROUTER_CONFIG_KEY };

export const JEV_ROUTER_QUESTION_VERSION = "jev-advisory-questions-v1";
export const JEV_ROUTER_POLICY_VERSION = "jev-advisory-policy-v1";
export const JEV_ROUTER_DISCLOSURE_VERSION = "jev-advisory-egress-v1";

export const JEV_ROUTER_LIMITS = Object.freeze({
	defaultTimeoutMs: 5_000,
	minTimeoutMs: 500,
	maxTimeoutMs: 15_000,
});

export type JevRouterConfig =
	| Readonly<{ version: 1; enabled: false }>
	| Readonly<{
			version: 1;
			enabled: true;
			questionVersion: typeof JEV_ROUTER_QUESTION_VERSION;
			policyVersion: typeof JEV_ROUTER_POLICY_VERSION;
			timeoutMs: number;
			consent: Readonly<{
				disclosureVersion: typeof JEV_ROUTER_DISCLOSURE_VERSION;
				acknowledgedAt: string;
				sendExplicitBriefAndRouteDescriptions: true;
			}>;
	  }>;

export const JEV_ROUTER_OFF: JevRouterConfig = Object.freeze({
	version: 1,
	enabled: false,
});

export type LoadedJevRouterConfig =
	| Readonly<{
			status: "off";
			source: string;
			origin: "missing-file" | "missing-section" | "configured";
			config: JevRouterConfig;
			digest: string;
	  }>
	| Readonly<{
			status: "enabled";
			source: string;
			config: Extract<JevRouterConfig, { enabled: true }>;
			digest: string;
	  }>
	| Readonly<{ status: "invalid"; source: string; diagnostic: string }>;

function fail(message: string): never {
	throw new Error(`Invalid subagent jevRouter config: ${message}`);
}

function rejectUnknown(
	value: JsonObject,
	allowed: readonly string[],
	path: string,
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0)
		fail(`${path} has unsupported key(s): ${unknown.join(", ")}`);
}

/** Parse the raw `jevRouter` member; undefined is the shipped default. */
export function parseJevRouterConfig(value: any): JevRouterConfig {
	if (value === undefined) return JEV_ROUTER_OFF;
	if (!isRecord(value)) fail("jevRouter must be an object");
	if (value.version !== 1) fail("jevRouter.version must be 1");
	if (value.enabled === false) {
		rejectUnknown(value, ["version", "enabled"], "jevRouter");
		return JEV_ROUTER_OFF;
	}
	if (value.enabled !== true) fail("jevRouter.enabled must be a boolean");
	rejectUnknown(
		value,
		[
			"version",
			"enabled",
			"questionVersion",
			"policyVersion",
			"timeoutMs",
			"consent",
		],
		"jevRouter",
	);
	if (value.questionVersion !== JEV_ROUTER_QUESTION_VERSION)
		fail(`jevRouter.questionVersion must be ${JEV_ROUTER_QUESTION_VERSION}`);
	if (value.policyVersion !== JEV_ROUTER_POLICY_VERSION)
		fail(`jevRouter.policyVersion must be ${JEV_ROUTER_POLICY_VERSION}`);
	let timeoutMs: number = JEV_ROUTER_LIMITS.defaultTimeoutMs;
	if (value.timeoutMs !== undefined) {
		const candidate = value.timeoutMs;
		if (
			!isFiniteNumber(candidate) ||
			!Number.isSafeInteger(candidate) ||
			candidate < JEV_ROUTER_LIMITS.minTimeoutMs ||
			candidate > JEV_ROUTER_LIMITS.maxTimeoutMs
		)
			fail(
				`jevRouter.timeoutMs must be an integer from ${JEV_ROUTER_LIMITS.minTimeoutMs} to ${JEV_ROUTER_LIMITS.maxTimeoutMs}`,
			);
		timeoutMs = candidate;
	}
	const consent = value.consent;
	if (!isRecord(consent)) fail("jevRouter.consent must be an object");
	rejectUnknown(
		consent,
		[
			"disclosureVersion",
			"acknowledgedAt",
			"sendExplicitBriefAndRouteDescriptions",
		],
		"jevRouter.consent",
	);
	if (consent.disclosureVersion !== JEV_ROUTER_DISCLOSURE_VERSION)
		fail(
			`jevRouter.consent.disclosureVersion must be ${JEV_ROUTER_DISCLOSURE_VERSION}`,
		);
	if (
		!isString(consent.acknowledgedAt) ||
		!isStrictIsoTimestamp(consent.acknowledgedAt)
	)
		fail(
			"jevRouter.consent.acknowledgedAt must be a strict ISO-8601 timestamp",
		);
	if (consent.sendExplicitBriefAndRouteDescriptions !== true)
		fail(
			"jevRouter.consent.sendExplicitBriefAndRouteDescriptions must be true",
		);
	return Object.freeze({
		version: 1,
		enabled: true,
		questionVersion: JEV_ROUTER_QUESTION_VERSION,
		policyVersion: JEV_ROUTER_POLICY_VERSION,
		timeoutMs,
		consent: Object.freeze({
			disclosureVersion: JEV_ROUTER_DISCLOSURE_VERSION,
			acknowledgedAt: consent.acknowledgedAt,
			sendExplicitBriefAndRouteDescriptions: true,
		}),
	});
}

/** A stable digest of the normalized settings, for drift comparison. */
export function jevRouterConfigDigest(config: JevRouterConfig): string {
	return createHash("sha256")
		.update(`pi-herdr-agents/jevRouter/v1\n${JSON.stringify(config)}`)
		.digest("hex");
}

/**
 * Load the section from the durable user config only, never the packaged
 * example. Missing is off; every read, JSON, duplicate-member, or schema
 * failure is invalid.
 */
export function loadJevRouterConfig(
	source: string = getSubagentsConfigPath(),
): LoadedJevRouterConfig {
	const invalid = (diagnostic: string): LoadedJevRouterConfig =>
		Object.freeze({ status: "invalid", source, diagnostic });
	let raw: string;
	try {
		raw = readFileSync(source, "utf8");
	} catch (error) {
		// SAFETY: readFileSync only throws Node fs errors here, which carry code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return Object.freeze({
				status: "off",
				source,
				origin: "missing-file",
				config: JEV_ROUTER_OFF,
				digest: jevRouterConfigDigest(JEV_ROUTER_OFF),
			});
		return invalid(`Cannot read subagent config ${source}.`);
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return invalid(`Invalid JSON in subagent config ${source}.`);
	}
	let duplicate: string | undefined;
	try {
		duplicate = findDuplicateJevRouterMember(raw);
	} catch {
		return invalid(
			`Cannot check subagent jevRouter config in ${source} for duplicate JSON members.`,
		);
	}
	if (duplicate !== undefined)
		return invalid(
			`Invalid subagent jevRouter config in ${source}: ${duplicate} is a duplicate JSON member`,
		);
	if (!isRecord(parsed))
		return invalid(`Subagent config ${source} is not an object.`);
	let config: JevRouterConfig;
	try {
		config = parseJevRouterConfig(
			Object.hasOwn(parsed, JEV_ROUTER_CONFIG_KEY)
				? parsed[JEV_ROUTER_CONFIG_KEY]
				: undefined,
		);
	} catch (error) {
		return invalid(error instanceof Error ? error.message : String(error));
	}
	const digest = jevRouterConfigDigest(config);
	if (config.enabled)
		return Object.freeze({ status: "enabled", source, config, digest });
	return Object.freeze({
		status: "off",
		source,
		origin: Object.hasOwn(parsed, JEV_ROUTER_CONFIG_KEY)
			? "configured"
			: "missing-section",
		config,
		digest,
	});
}
