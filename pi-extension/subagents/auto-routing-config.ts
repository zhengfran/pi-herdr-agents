/**
 * Strict durable configuration for automatic input routing (`autoRouting`).
 *
 * The section authorizes complete role/harness/model/effort tuples. It never
 * accepts credentials, endpoints, or launch capabilities, and it is read only
 * from the durable `$PI_CODING_AGENT_DIR/herdr-agents/config.json`. A missing
 * section is exactly `{version: 1, mode: "off"}`; an off configuration
 * exposes nothing that could reach the classifier. Invalid configuration is
 * reported as invalid, never hidden as off.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	AUTO_ROUTING_CONFIG_KEY,
	findDuplicateAutoRoutingMember,
} from "./auto-routing-json.ts";
import {
	AUTO_ROUTING_DISCLOSURE_VERSION,
	AUTO_ROUTING_JEV_MODEL,
	AUTO_ROUTING_JEV_PROVIDER,
	AUTO_ROUTING_POLICY_VERSION,
	AUTO_ROUTING_QUESTION_VERSION,
	type AutoRoutingDisclosureVersion,
	type AutoRoutingJevModel,
	type AutoRoutingJevProvider,
	type AutoRoutingPolicyVersion,
	type AutoRoutingQuestionVersion,
} from "./auto-routing-policy.ts";
import type { NATIVE_EFFORT_LEVELS } from "./claude.ts";
import { getSubagentsConfigPath } from "./config-path.ts";
import { NATIVE_MODEL_ID } from "./model-config.ts";
import type { ThinkingLevel } from "./runtime-routing.ts";
import {
	isFiniteNumber,
	isRecord,
	isString,
	type JsonObject,
} from "./type-guards.ts";

export { AUTO_ROUTING_CONFIG_KEY };

export const AUTO_ROUTING_MODES = ["off", "shadow", "pilot", "auto"] as const;
export type AutoRoutingMode = (typeof AUTO_ROUTING_MODES)[number];
/** Every non-off mode sends prompts to the classifier and needs consent. */
export type EnabledAutoRoutingMode = Exclude<AutoRoutingMode, "off">;

export const AUTO_FAILURE_POLICIES = ["parent", "hold"] as const;
export type AutoFailurePolicy = (typeof AUTO_FAILURE_POLICIES)[number];
export const DEFAULT_AUTO_FAILURE_POLICY: AutoFailurePolicy = "parent";

export const AUTO_ROLE_SOURCES = ["project", "global", "package"] as const;
export type AutoRoleSource = (typeof AUTO_ROLE_SOURCES)[number];
export const AUTO_LABEL_ROLES = [
	"plan",
	"research",
	"ui",
	"api",
	"build",
	"test",
	"review",
	"browser",
	"security",
	"perf",
	"merge",
] as const;
export type AutoLabelRole = (typeof AUTO_LABEL_ROLES)[number];
export const AUTO_ROLE_INTENTS = ["report", "modify"] as const;
export type AutoRoleIntent = (typeof AUTO_ROLE_INTENTS)[number];
export const AUTO_ROLE_PURPOSES = ["task", "review"] as const;
export type AutoRolePurpose = (typeof AUTO_ROLE_PURPOSES)[number];

export const AUTO_HARNESSES = ["pi", "claude", "kiro"] as const;
export type AutoHarness = (typeof AUTO_HARNESSES)[number];
/** Pi thinking vocabulary, in ascending order. */
export const AUTO_EFFORT_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];
export type AutoEffortLevel = (typeof AUTO_EFFORT_LEVELS)[number];
/** Native CLI efforts; `off` and `minimal` never map to native values. */
export const AUTO_NATIVE_EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly (typeof NATIVE_EFFORT_LEVELS)[number][];
export const AUTO_MODEL_TIERS = ["fast", "mid", "frontier"] as const;
export type AutoModelTier = (typeof AUTO_MODEL_TIERS)[number];

export const AUTO_ROUTING_LIMITS = Object.freeze({
	minTimeoutMs: 500,
	maxTimeoutMs: 15_000,
	maxRoles: 16,
	maxCandidates: 128,
	maxProfileBytes: 256,
	maxModelBytes: 200,
	maxFamilyBytes: 80,
	maxEvidenceBytes: 512,
	maxAgentBytes: 128,
	maxProviderBytes: 214,
	maxProviderVersionBytes: 128,
	maxPreference: 10_000,
});

export type AutoRoutingThresholds = Readonly<{
	choiceConfidence: number;
	choiceProbability: number;
	choiceMargin: number;
	absoluteFit: number;
	falseCeiling: number;
	trueFloor: number;
	scoreConfidence: number;
	effortQuantile: number;
}>;

/** Initial uncalibrated policy. v1 thresholds may only become more conservative. */
export const DEFAULT_AUTO_ROUTING_THRESHOLDS: AutoRoutingThresholds =
	Object.freeze({
		choiceConfidence: 0.8,
		choiceProbability: 0.7,
		choiceMargin: 0.2,
		absoluteFit: 0.8,
		falseCeiling: 0.2,
		trueFloor: 0.8,
		scoreConfidence: 0.8,
		effortQuantile: 0.9,
	});

const THRESHOLD_BOUNDS = {
	choiceConfidence: [0.8, 1],
	choiceProbability: [0.7, 1],
	choiceMargin: [0.2, 1],
	absoluteFit: [0.8, 1],
	falseCeiling: [0, 0.2],
	trueFloor: [0.8, 1],
	scoreConfidence: [0.8, 1],
	effortQuantile: [0.9, 0.99],
} as const satisfies Record<
	keyof AutoRoutingThresholds,
	readonly [number, number]
>;

export type AutoRoutingConsent = Readonly<{
	disclosureVersion: AutoRoutingDisclosureVersion;
	acknowledgedAt: string;
	sendCurrentPromptAndReviewedProfiles: true;
}>;

export type AutoRoutingJevConfig = Readonly<{
	provider: AutoRoutingJevProvider;
	model: AutoRoutingJevModel;
	timeoutMs: number;
}>;

export type AutoRoleApproval = Readonly<{
	id: string;
	agent: string;
	source: AutoRoleSource;
	/** Contributed package roles only, always together with providerVersion. */
	provider?: string;
	providerVersion?: string;
	definitionSha256: string;
	labelRole: AutoLabelRole;
	intent: AutoRoleIntent;
	purpose: AutoRolePurpose;
	responsibility: string;
	deliverable: string;
	excludes: string;
}>;

export type AutoCandidateModel =
	| Readonly<{ namespace: "pi"; ref: string }>
	| Readonly<{ namespace: "claude" | "kiro"; id: string }>;

export type AutoCandidateApproval = Readonly<{
	id: string;
	roleId: string;
	harness: AutoHarness;
	model: AutoCandidateModel;
	effort: AutoEffortLevel;
	tier: AutoModelTier;
	family: string;
	taskStrengths: string;
	limitations: string;
	capabilityEvidence: string;
	preference: number;
}>;

export type OffAutoRoutingConfig = Readonly<{ version: 1; mode: "off" }>;

export type EnabledAutoRoutingConfig = Readonly<{
	version: 1;
	mode: EnabledAutoRoutingMode;
	policyVersion: AutoRoutingPolicyVersion;
	questionVersion: AutoRoutingQuestionVersion;
	consent: AutoRoutingConsent;
	jev: AutoRoutingJevConfig;
	failurePolicy: AutoFailurePolicy;
	thresholds: AutoRoutingThresholds;
	roles: readonly AutoRoleApproval[];
	candidates: readonly AutoCandidateApproval[];
}>;

export type AutoRoutingConfig = OffAutoRoutingConfig | EnabledAutoRoutingConfig;

export const AUTO_ROUTING_OFF: OffAutoRoutingConfig = Object.freeze({
	version: 1,
	mode: "off",
});

export type AutoRoutingOffOrigin =
	| "missing-file"
	| "missing-section"
	| "configured";

export type EnabledAutoRoutingState = Readonly<{
	status: "enabled";
	source: string;
	config: EnabledAutoRoutingConfig;
	digest: string;
}>;

export type LoadedAutoRoutingConfig =
	| Readonly<{
			status: "off";
			source: string;
			origin: AutoRoutingOffOrigin;
			config: OffAutoRoutingConfig;
			digest: string;
	  }>
	| EnabledAutoRoutingState
	| Readonly<{ status: "invalid"; source: string; diagnostic: string }>;

/** Only a valid enabled configuration may lead to classifier egress. */
export function isAutoRoutingEnabled(
	loaded: LoadedAutoRoutingConfig,
): loaded is EnabledAutoRoutingState {
	return loaded.status === "enabled";
}

class AutoRoutingConfigError extends Error {}

function fail(message: string): never {
	throw new AutoRoutingConfigError(message);
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const RESERVED_IDS = new Set([
	"none",
	"equivalent",
	"constructor",
	"prototype",
]);
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CREDENTIAL_OR_ENDPOINT_KEYS = new Set([
	"apikey",
	"api_key",
	"key",
	"token",
	"accesstoken",
	"secret",
	"password",
	"credential",
	"credentials",
	"auth",
	"authorization",
	"headers",
	"endpoint",
	"baseurl",
	"base_url",
	"url",
	"host",
	"proxy",
]);
const CAPABILITY_KEYS = new Set([
	"tools",
	"skills",
	"cwd",
	"worktree",
	"fork",
	"persistent",
	"interactive",
	"spawnagents",
	"spawn-agents",
	"systemprompt",
	"system-prompt",
	"env",
	"permissions",
	"capabilities",
	"args",
	"params",
	"options",
]);
/** Controls, lone surrogates, line separators, and bidirectional overrides. */
const UNSAFE_TEXT =
	/[\p{Cc}\p{Cs}\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MOVING_ALIAS_TOKENS = new Set(["latest", "default", "auto"]);
const ISO_TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

const SECTION_KEYS = [
	"version",
	"mode",
	"policyVersion",
	"questionVersion",
	"consent",
	"jev",
	"failurePolicy",
	"thresholds",
	"roles",
	"candidates",
];
const ROLE_KEYS = [
	"id",
	"agent",
	"source",
	"provider",
	"providerVersion",
	"definitionSha256",
	"labelRole",
	"intent",
	"purpose",
	"responsibility",
	"deliverable",
	"excludes",
];
const CANDIDATE_KEYS = [
	"id",
	"roleId",
	"harness",
	"model",
	"effort",
	"tier",
	"family",
	"taskStrengths",
	"limitations",
	"capabilityEvidence",
	"preference",
];

function memberPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$-]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;
}

function checkKeys(
	object: JsonObject,
	path: string,
	allowed: readonly string[],
): void {
	const unsupported: string[] = [];
	for (const key of Object.keys(object)) {
		if (RESERVED_KEYS.has(key))
			fail(`${path} has reserved key ${JSON.stringify(key)}`);
		if (allowed.includes(key)) continue;
		const normalized = key.toLowerCase();
		if (CREDENTIAL_OR_ENDPOINT_KEYS.has(normalized))
			fail(
				`${memberPath(path, key)} is not allowed: auto-routing config never accepts credentials or endpoints; the classifier uses Pi's typesafe provider authentication`,
			);
		if (CAPABILITY_KEYS.has(normalized))
			fail(
				`${memberPath(path, key)} is not allowed: launch capabilities are fixed v1 behavior or immutable role policy, never candidate settings`,
			);
		unsupported.push(JSON.stringify(key));
	}
	if (unsupported.length > 0)
		fail(`${path} has unsupported key(s): ${unsupported.join(", ")}`);
}

function requirePresent(object: JsonObject, key: string, path: string): void {
	if (!Object.hasOwn(object, key)) fail(`${memberPath(path, key)} is required`);
}

function isOneOf<const T extends string>(
	value: any,
	values: readonly T[],
): value is T {
	return isString(value) && values.some((candidate) => candidate === value);
}

function enumField<const T extends string>(
	object: JsonObject,
	key: string,
	path: string,
	values: readonly T[],
): T {
	requirePresent(object, key, path);
	const value = object[key];
	if (!isOneOf(value, values))
		fail(
			`${memberPath(path, key)} must be one of: ${values.map((item) => JSON.stringify(item)).join(", ")}`,
		);
	return value;
}

function literalField<const T extends string>(
	object: JsonObject,
	key: string,
	path: string,
	expected: T,
): T {
	requirePresent(object, key, path);
	const value = object[key];
	if (value !== expected)
		fail(`${memberPath(path, key)} must be ${JSON.stringify(expected)}`);
	return expected;
}

function objectField(
	object: JsonObject,
	key: string,
	path: string,
): JsonObject {
	requirePresent(object, key, path);
	const value = object[key];
	if (!isRecord(value)) fail(`${memberPath(path, key)} must be an object`);
	return value;
}

function arrayField(
	object: JsonObject,
	key: string,
	path: string,
	max: number,
): readonly any[] {
	requirePresent(object, key, path);
	const value = object[key];
	if (!Array.isArray(value) || value.length < 1 || value.length > max)
		fail(`${memberPath(path, key)} must be a list of 1 to ${max} entries`);
	return value;
}

function stringField(object: JsonObject, key: string, path: string): string {
	requirePresent(object, key, path);
	const value = object[key];
	if (!isString(value)) fail(`${memberPath(path, key)} must be a string`);
	if (UNSAFE_TEXT.test(value))
		fail(`${memberPath(path, key)} must not contain control characters`);
	return value;
}

/** Nonblank, control-free text within a UTF-8 byte budget. */
function textField(
	object: JsonObject,
	key: string,
	path: string,
	maxBytes: number,
): string {
	const value = stringField(object, key, path);
	if (value.trim() === "")
		fail(`${memberPath(path, key)} must be a non-empty string`);
	if (Buffer.byteLength(value, "utf8") > maxBytes)
		fail(`${memberPath(path, key)} must be at most ${maxBytes} UTF-8 bytes`);
	return value;
}

/** Text matched exactly against a discovered identity; no surrounding space. */
function exactTextField(
	object: JsonObject,
	key: string,
	path: string,
	maxBytes: number,
): string {
	const value = textField(object, key, path, maxBytes);
	if (value !== value.trim())
		fail(
			`${memberPath(path, key)} must not have leading or trailing whitespace`,
		);
	return value;
}

function idField(object: JsonObject, key: string, path: string): string {
	requirePresent(object, key, path);
	const value = object[key];
	if (!isString(value) || !ID.test(value))
		fail(`${memberPath(path, key)} must match ${ID.source}`);
	if (RESERVED_IDS.has(value))
		fail(`${memberPath(path, key)} cannot use reserved ID "${value}"`);
	return value;
}

function integerField(
	object: JsonObject,
	key: string,
	path: string,
	min: number,
	max: number,
): number {
	requirePresent(object, key, path);
	const value = object[key];
	if (
		!isFiniteNumber(value) ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		fail(`${memberPath(path, key)} must be an integer from ${min} to ${max}`);
	return value;
}

function numberField(
	object: JsonObject,
	key: string,
	path: string,
	[min, max]: readonly [number, number],
): number {
	requirePresent(object, key, path);
	const value = object[key];
	if (!isFiniteNumber(value) || value < min || value > max)
		fail(
			`${memberPath(path, key)} must be a finite number from ${min} to ${max}`,
		);
	return value;
}

function isStrictIsoTimestamp(value: string): boolean {
	const match = ISO_TIMESTAMP.exec(value);
	if (!match) return false;
	const [year, month, day, hour, minute, second] = match
		.slice(1, 7)
		.map(Number);
	const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
	const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const monthDays = [
		31,
		leap ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= monthDays[month - 1] &&
		hour <= 23 &&
		minute <= 59 &&
		second <= 59 &&
		offsetHour <= 23 &&
		offsetMinute <= 59
	);
}

function hasMovingAliasToken(modelId: string): boolean {
	return modelId
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.some((token) => MOVING_ALIAS_TOKENS.has(token));
}

function parsePiModelRef(object: JsonObject, path: string): string {
	const at = memberPath(path, "ref");
	const ref = textField(object, "ref", path, AUTO_ROUTING_LIMITS.maxModelBytes);
	if (/^task:/i.test(ref))
		fail(`${at} cannot use task: references; approve one exact model`);
	if (/[\s,]/u.test(ref))
		fail(`${at} must be one exact Pi provider/model reference, not a list`);
	const separator = ref.indexOf("/");
	if (separator <= 0 || ref.endsWith("/"))
		fail(`${at} must be an exact Pi provider/model-id reference`);
	if (hasMovingAliasToken(ref.slice(separator + 1)))
		fail(`${at} must name an exact pinned model, not a moving alias`);
	return ref;
}

function parseNativeModelId(object: JsonObject, path: string): string {
	const at = memberPath(path, "id");
	const id = textField(object, "id", path, AUTO_ROUTING_LIMITS.maxModelBytes);
	if (/^task:/i.test(id))
		fail(`${at} cannot use task: references; approve one exact model`);
	if (!NATIVE_MODEL_ID.test(id)) fail(`${at} must be one native CLI model ID`);
	// Bracketed suffixes such as `sonnet[1m]` select a context variant, not a version.
	const versioned = /\d/.test(id.replace(/\[[^\]]*\]$/, ""));
	if (!versioned || hasMovingAliasToken(id))
		fail(
			`${at} must be an administrator-verified exact versioned native model ID, not a moving alias such as opus, sonnet, auto, default, or latest`,
		);
	return id;
}

function parseCandidateModel(
	object: JsonObject,
	path: string,
	harness: AutoHarness,
): AutoCandidateModel {
	const namespace = enumField(object, "namespace", path, AUTO_HARNESSES);
	if (namespace !== harness)
		fail(
			`${memberPath(path, "namespace")} must equal the candidate harness "${harness}"`,
		);
	if (namespace === "pi") {
		checkKeys(object, path, ["namespace", "ref"]);
		return { namespace, ref: parsePiModelRef(object, path) };
	}
	checkKeys(object, path, ["namespace", "id"]);
	return { namespace, id: parseNativeModelId(object, path) };
}

function candidateModelKey(model: AutoCandidateModel): string {
	return model.namespace === "pi"
		? `pi\u0000${model.ref}`
		: `${model.namespace}\u0000${model.id}`;
}

function parseRole(value: any, path: string): AutoRoleApproval {
	if (!isRecord(value)) fail(`${path} must be an object`);
	checkKeys(value, path, ROLE_KEYS);
	const limits = AUTO_ROUTING_LIMITS;
	const id = idField(value, "id", path);
	const agent = exactTextField(value, "agent", path, limits.maxAgentBytes);
	if (RESERVED_KEYS.has(agent))
		fail(`${memberPath(path, "agent")} cannot use reserved name "${agent}"`);
	const source = enumField(value, "source", path, AUTO_ROLE_SOURCES);
	const hasProvider = Object.hasOwn(value, "provider");
	if (hasProvider !== Object.hasOwn(value, "providerVersion"))
		fail(`${path}.provider and ${path}.providerVersion must be set together`);
	if (hasProvider && source !== "package")
		fail(`${path}.provider is only valid for a package role`);
	const definitionSha256 = stringField(value, "definitionSha256", path);
	if (!SHA256_HEX.test(definitionSha256))
		fail(`${path}.definitionSha256 must be 64 lower-case hexadecimal digits`);
	const labelRole = enumField(value, "labelRole", path, AUTO_LABEL_ROLES);
	const purpose = enumField(value, "purpose", path, AUTO_ROLE_PURPOSES);
	if (labelRole === "review" && purpose !== "review")
		fail(`${path}.purpose must be "review" for a review responsibility`);
	const role = {
		id,
		agent,
		source,
		definitionSha256,
		labelRole,
		intent: enumField(value, "intent", path, AUTO_ROLE_INTENTS),
		purpose,
		responsibility: textField(
			value,
			"responsibility",
			path,
			limits.maxProfileBytes,
		),
		deliverable: textField(value, "deliverable", path, limits.maxProfileBytes),
		excludes: textField(value, "excludes", path, limits.maxProfileBytes),
	};
	if (!hasProvider) return role;
	return {
		...role,
		provider: exactTextField(value, "provider", path, limits.maxProviderBytes),
		providerVersion: exactTextField(
			value,
			"providerVersion",
			path,
			limits.maxProviderVersionBytes,
		),
	};
}

function parseCandidate(
	value: any,
	path: string,
	roleIds: ReadonlySet<string>,
): AutoCandidateApproval {
	if (!isRecord(value)) fail(`${path} must be an object`);
	checkKeys(value, path, CANDIDATE_KEYS);
	const limits = AUTO_ROUTING_LIMITS;
	const id = idField(value, "id", path);
	const roleId = idField(value, "roleId", path);
	if (!roleIds.has(roleId))
		fail(`${path}.roleId references unknown role "${roleId}"`);
	const harness = enumField(value, "harness", path, AUTO_HARNESSES);
	const model = parseCandidateModel(
		objectField(value, "model", path),
		`${path}.model`,
		harness,
	);
	const effort = enumField(value, "effort", path, AUTO_EFFORT_LEVELS);
	if (harness !== "pi" && !isOneOf(effort, AUTO_NATIVE_EFFORT_LEVELS))
		fail(
			`${path}.effort "${effort}" cannot be represented by native ${harness}; supported: ${AUTO_NATIVE_EFFORT_LEVELS.join(", ")}`,
		);
	return {
		id,
		roleId,
		harness,
		model,
		effort,
		tier: enumField(value, "tier", path, AUTO_MODEL_TIERS),
		family: textField(value, "family", path, limits.maxFamilyBytes),
		taskStrengths: textField(
			value,
			"taskStrengths",
			path,
			limits.maxProfileBytes,
		),
		limitations: textField(value, "limitations", path, limits.maxProfileBytes),
		capabilityEvidence: textField(
			value,
			"capabilityEvidence",
			path,
			limits.maxEvidenceBytes,
		),
		preference: integerField(
			value,
			"preference",
			path,
			0,
			limits.maxPreference,
		),
	};
}

function parseConsent(object: JsonObject, path: string): AutoRoutingConsent {
	checkKeys(object, path, [
		"disclosureVersion",
		"acknowledgedAt",
		"sendCurrentPromptAndReviewedProfiles",
	]);
	const disclosureVersion = literalField(
		object,
		"disclosureVersion",
		path,
		AUTO_ROUTING_DISCLOSURE_VERSION,
	);
	const acknowledgedAt = stringField(object, "acknowledgedAt", path);
	if (!isStrictIsoTimestamp(acknowledgedAt))
		fail(`${path}.acknowledgedAt must be a strict ISO-8601 timestamp`);
	requirePresent(object, "sendCurrentPromptAndReviewedProfiles", path);
	if (object.sendCurrentPromptAndReviewedProfiles !== true)
		fail(`${path}.sendCurrentPromptAndReviewedProfiles must be true`);
	return {
		disclosureVersion,
		acknowledgedAt,
		sendCurrentPromptAndReviewedProfiles: true,
	};
}

function parseJev(object: JsonObject, path: string): AutoRoutingJevConfig {
	checkKeys(object, path, ["provider", "model", "timeoutMs"]);
	return {
		provider: literalField(object, "provider", path, AUTO_ROUTING_JEV_PROVIDER),
		model: literalField(object, "model", path, AUTO_ROUTING_JEV_MODEL),
		timeoutMs: integerField(
			object,
			"timeoutMs",
			path,
			AUTO_ROUTING_LIMITS.minTimeoutMs,
			AUTO_ROUTING_LIMITS.maxTimeoutMs,
		),
	};
}

function parseThresholds(
	object: JsonObject,
	path: string,
): AutoRoutingThresholds {
	checkKeys(object, path, Object.keys(THRESHOLD_BOUNDS));
	const field = (key: keyof AutoRoutingThresholds) =>
		numberField(object, key, path, THRESHOLD_BOUNDS[key]);
	const thresholds = {
		choiceConfidence: field("choiceConfidence"),
		choiceProbability: field("choiceProbability"),
		choiceMargin: field("choiceMargin"),
		absoluteFit: field("absoluteFit"),
		falseCeiling: field("falseCeiling"),
		trueFloor: field("trueFloor"),
		scoreConfidence: field("scoreConfidence"),
		effortQuantile: field("effortQuantile"),
	};
	if (thresholds.falseCeiling >= thresholds.trueFloor)
		fail(`${path}.falseCeiling must be below ${path}.trueFloor`);
	return thresholds;
}

function parseApprovals(
	section: JsonObject,
	path: string,
): Pick<EnabledAutoRoutingConfig, "roles" | "candidates"> {
	const limits = AUTO_ROUTING_LIMITS;
	const roleIds = new Set<string>();
	const roles = arrayField(section, "roles", path, limits.maxRoles).map(
		(value, index) => {
			const role = parseRole(value, `${path}.roles[${index}]`);
			if (roleIds.has(role.id))
				fail(`${path}.roles has duplicate id "${role.id}"`);
			roleIds.add(role.id);
			return role;
		},
	);
	const candidateIds = new Set<string>();
	const tuples = new Set<string>();
	const preferences = new Set<string>();
	const coveredRoles = new Set<string>();
	const candidates = arrayField(
		section,
		"candidates",
		path,
		limits.maxCandidates,
	).map((value, index) => {
		const at = `${path}.candidates[${index}]`;
		const candidate = parseCandidate(value, at, roleIds);
		if (candidateIds.has(candidate.id))
			fail(`${path}.candidates has duplicate id "${candidate.id}"`);
		candidateIds.add(candidate.id);
		const runtime = `${candidate.roleId}\u0000${candidate.harness}\u0000${candidateModelKey(candidate.model)}`;
		const tuple = `${runtime}\u0000${candidate.effort}`;
		if (tuples.has(tuple))
			fail(
				`${at} duplicates an approved role, harness, model, and effort tuple`,
			);
		tuples.add(tuple);
		const preference = `${runtime}\u0000${candidate.preference}`;
		if (preferences.has(preference))
			fail(
				`${at}.preference must be unique within one role, harness, and model`,
			);
		preferences.add(preference);
		coveredRoles.add(candidate.roleId);
		return candidate;
	});
	for (const role of roles)
		if (!coveredRoles.has(role.id))
			fail(`${path}.roles role "${role.id}" has no approved candidate`);
	return { roles, candidates };
}

function parseSection(section: any): AutoRoutingConfig {
	const path = AUTO_ROUTING_CONFIG_KEY;
	if (!isRecord(section)) fail(`${path} must be an object`);
	checkKeys(section, path, SECTION_KEYS);
	requirePresent(section, "version", path);
	if (section.version !== 1) fail(`${path}.version must be 1`);
	const mode = enumField(section, "mode", path, AUTO_ROUTING_MODES);
	if (mode === "off" && Object.keys(section).length === 2)
		return AUTO_ROUTING_OFF;
	// Off may retain a complete configuration, never a partial one.
	for (const key of [
		"policyVersion",
		"questionVersion",
		"consent",
		"jev",
		"roles",
		"candidates",
	])
		if (!Object.hasOwn(section, key))
			fail(
				mode === "off"
					? `${path}.${key} is required to retain an off configuration beyond version and mode`
					: `${path}.${key} is required for ${mode} mode`,
			);
	const policyVersion = literalField(
		section,
		"policyVersion",
		path,
		AUTO_ROUTING_POLICY_VERSION,
	);
	const questionVersion = literalField(
		section,
		"questionVersion",
		path,
		AUTO_ROUTING_QUESTION_VERSION,
	);
	const consent = parseConsent(
		objectField(section, "consent", path),
		`${path}.consent`,
	);
	const jev = parseJev(objectField(section, "jev", path), `${path}.jev`);
	const failurePolicy = Object.hasOwn(section, "failurePolicy")
		? enumField(section, "failurePolicy", path, AUTO_FAILURE_POLICIES)
		: DEFAULT_AUTO_FAILURE_POLICY;
	const thresholds = Object.hasOwn(section, "thresholds")
		? parseThresholds(
				objectField(section, "thresholds", path),
				`${path}.thresholds`,
			)
		: DEFAULT_AUTO_ROUTING_THRESHOLDS;
	const { roles, candidates } = parseApprovals(section, path);
	if (mode === "off") return AUTO_ROUTING_OFF;
	return {
		version: 1,
		mode,
		policyVersion,
		questionVersion,
		consent,
		jev,
		failurePolicy,
		thresholds,
		roles,
		candidates,
	};
}

function deepFreeze<T>(value: T): T {
	if (Array.isArray(value) || isRecord(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

/**
 * Parse the top-level `autoRouting` section into a new deeply immutable
 * value. Unrelated top-level sections are ignored and never rewritten.
 */
export function parseAutoRoutingConfig(
	rawConfig: any,
	source = "config.json",
): AutoRoutingConfig {
	try {
		if (!isRecord(rawConfig)) fail("root must be an object");
		if (!Object.hasOwn(rawConfig, AUTO_ROUTING_CONFIG_KEY))
			return AUTO_ROUTING_OFF;
		return deepFreeze(parseSection(rawConfig[AUTO_ROUTING_CONFIG_KEY]));
	} catch (error) {
		if (error instanceof AutoRoutingConfigError)
			throw new Error(
				`Invalid subagent auto-routing config in ${source}: ${error.message}`,
			);
		throw error;
	}
}

/** Deterministic JSON with sorted object keys; list order is significant. */
export function canonicalJson(value: any): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.filter((key) => value[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

/**
 * Versioned digest of the parsed semantics: key order, formatting, and
 * explicitly written defaults do not change it; any approval change does.
 */
export function autoRoutingConfigDigest(config: AutoRoutingConfig): string {
	return createHash("sha256")
		.update(`pi-herdr-agents/autoRouting/v1\n${canonicalJson(config)}`)
		.digest("hex");
}

/**
 * Load the routing section from the durable user config only: never the
 * packaged example. A missing file or section is off; every read, JSON,
 * duplicate-member, or schema failure is invalid and disables routing without
 * affecting manual launches.
 */
export function loadAutoRoutingConfig(): LoadedAutoRoutingConfig {
	const source = getSubagentsConfigPath();
	const invalid = (diagnostic: string): LoadedAutoRoutingConfig =>
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
				config: AUTO_ROUTING_OFF,
				digest: autoRoutingConfigDigest(AUTO_ROUTING_OFF),
			});
		const detail = error instanceof Error ? error.message : String(error);
		return invalid(`Cannot read subagent config ${source}: ${detail}`);
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return invalid(`Invalid JSON in subagent config ${source}: ${detail}`);
	}
	let duplicate: string | undefined;
	try {
		duplicate = findDuplicateAutoRoutingMember(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return invalid(
			`Cannot check subagent auto-routing config in ${source} for duplicate JSON members: ${detail}`,
		);
	}
	if (duplicate !== undefined)
		return invalid(
			`Invalid subagent auto-routing config in ${source}: ${duplicate} is a duplicate JSON member`,
		);
	let config: AutoRoutingConfig;
	try {
		config = parseAutoRoutingConfig(parsed, source);
	} catch (error) {
		return invalid(error instanceof Error ? error.message : String(error));
	}
	const digest = autoRoutingConfigDigest(config);
	if (config.mode !== "off")
		return Object.freeze({ status: "enabled", source, config, digest });
	return Object.freeze({
		status: "off",
		source,
		origin: Object.hasOwn(parsed, AUTO_ROUTING_CONFIG_KEY)
			? "configured"
			: "missing-section",
		config,
		digest,
	});
}
