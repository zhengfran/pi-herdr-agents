/**
 * Local feasible-candidate snapshots for automatic input routing.
 *
 * A snapshot is built from a loaded enabled allowlist and the current parent
 * context before any classifier call. Each approved role is resolved once by
 * normal discovery precedence and pinned to its reviewed definition; each
 * approved tuple is prepared through the shared launch authority without
 * creating a pane, workspace, file, or lease. Unavailable tuples are filtered
 * with bounded local reasons and nothing replaces them. Everything here is
 * local: only toJevRoleProfiles' small opaque profiles may leave the machine,
 * and revalidation recomputes the whole relevant feasible set.
 */
import {
	AUTO_ROUTING_CONFIG_KEY,
	AUTO_ROUTING_LIMITS,
	autoRoutingConfigDigest,
	canonicalJson,
	parseAutoRoutingConfig,
	type AutoCandidateApproval,
	type AutoEffortLevel,
	type AutoHarness,
	type AutoModelTier,
	type AutoRoleApproval,
	type AutoRoleIntent,
	type AutoRoleSource,
	type EnabledAutoRoutingConfig,
	type EnabledAutoRoutingState,
	type LoadedAutoRoutingConfig,
} from "./auto-routing-config.ts";
import type {
	AutoEffortBand,
	AutoReasonCode,
	AutoRoutingJevModel,
	AutoRoutingPolicyVersion,
	AutoRoutingQuestionVersion,
} from "./auto-routing-policy.ts";
import {
	MAX_INITIAL_PROMPT_BYTES,
	materializeSkills,
	parseSkillNames,
	sha256,
	truncateUtf8,
	type InstalledSkill,
	type MaterializedSkill,
} from "./native-context.ts";
import type {
	NativeHarnessName,
	NativeHarnessOperations,
	NativeLaunchPlan,
} from "./native-harness.ts";
import {
	RuntimeResolutionError,
	VIRTUAL_MODEL_API,
	parseExactModelRef,
	type ModelRegistryAdapter,
	type ResolvedRuntimePlan,
	type RoutingModel,
	type RuntimeProvenance,
} from "./runtime-routing.ts";
import { isRecord } from "./type-guards.ts";

/**
 * Pinned v1 request bounds. A snapshot whose profiles cannot fit is
 * unavailable as a whole; candidates are never dropped to make it fit.
 */
export const AUTO_ROUTING_REQUEST_LIMITS = Object.freeze({
	maxPromptBytes: 8 * 1024,
	maxBatchBytes: 24 * 1024,
	maxStateAndQuestionBytes: 16 * 1024,
	maxChoiceOptions: 255,
	/** Local reason evidence for one filtered tuple. */
	maxDetailBytes: 256,
	/** Decision IDs are opaque package correlation keys. */
	maxBindingIdBytes: 256,
});

/** Why one approved tuple is not in the feasible set (local evidence only). */
export const AUTO_CANDIDATE_FILTER_REASONS = [
	"role-missing",
	"role-diagnostic",
	"role-hidden",
	"role-provenance-mismatch",
	"role-changed",
	"role-ineligible",
	"skill-invalid",
	"skill-changed",
	"projection-rejected",
	"pi-model-unknown",
	"pi-model-unauthenticated",
	"pi-model-not-physical",
	"pi-model-not-text",
	"runtime-rejected",
	"native-prerequisite-missing",
	"native-rejected",
	"native-prompt-too-large",
	"launch-rejected",
] as const;
export type AutoCandidateFilterReason =
	(typeof AUTO_CANDIDATE_FILTER_REASONS)[number];

/** Whole-snapshot failures; each is an existing routing reason code. */
export type AutoSnapshotFailureReason = Extract<
	AutoReasonCode,
	| "config-invalid"
	| "config-drift"
	| "blank-prompt"
	| "prompt-too-large"
	| "no-session-file"
	| "herdr-unavailable"
	| "no-feasible-candidate"
	| "jev-request-too-large"
>;

/** What changed between a snapshot and its immediate recomputation. */
export const AUTO_SNAPSHOT_DRIFTS = [
	"config",
	"context",
	"candidates",
	"role",
	"skill",
	"capability",
	"unverifiable",
] as const;
export type AutoSnapshotDrift = (typeof AUTO_SNAPSHOT_DRIFTS)[number];

/** A precedence-resolved role as discovery reports it; local only. */
export interface AutoRoutingRoleDefinition {
	readonly name: string;
	readonly source: AutoRoleSource;
	/** Local file location; neither fingerprinted nor sent. */
	readonly path: string;
	readonly provider?: string;
	readonly providerVersion?: string;
	readonly disableModelInvocation: boolean;
	readonly cli?: NativeHarnessName;
	readonly tools?: string;
	readonly denyTools?: string;
	readonly skills?: string;
}

/** A per-role discovery failure and the precedence layer that produced it. */
export type AutoRoleFailure = Readonly<{
	agentName: string;
	source: AutoRoleSource;
	code: string;
}>;

/** Role discovery as normal precedence resolves it, with layered failures. */
export interface AutoRoleCatalog {
	readonly agents: readonly AutoRoutingRoleDefinition[];
	/**
	 * Every diagnostic naming a role, and every definition without valid
	 * frontmatter (which ordinary discovery skips silently), by layer.
	 */
	readonly failures: readonly AutoRoleFailure[];
}

/** Effective harness selection of one prepared spawn. */
export interface AutoRunSelection {
	readonly harness: AutoHarness;
	readonly harnessSource: "request" | "role" | "default" | "auto";
	readonly projected: boolean;
	readonly role?: Readonly<{
		name: string;
		source: AutoRoleSource;
		provider?: string;
		providerVersion?: string;
		harness: AutoHarness;
	}>;
}

/** The checkout and parent session a preparation is bound to. */
export type AutoRunOrigin = Readonly<{
	cwd: string;
	discoveryCwd: string;
	sessionId: string;
	sessionFile: string;
	sessionDir: string;
}>;

/** A skill snapshot file as a snapshot holds it: identity, never bytes. */
export type AutoSkillFileView = Readonly<{
	path: string;
	sha256: string;
	executable: boolean;
	content?: never;
}>;

/** A materialized skill whose private snapshot keeps its hashes only. */
export type AutoSkillView = Readonly<
	Omit<MaterializedSkill, "snapshot"> & {
		snapshot?: Readonly<{
			dir: string;
			sha256: string;
			files: readonly AutoSkillFileView[];
		}>;
	}
>;

/**
 * A native launch plan as a snapshot holds it. Freezing cannot make a
 * Buffer immutable, so skill file bytes are absent: a launch re-reads them
 * privately and starts only if they hash identically.
 */
export type AutoNativePlanView = Readonly<
	Omit<NativeLaunchPlan, "skills"> & { skills: readonly AutoSkillView[] }
>;

/** What a snapshot relies on from one pre-resource spawn preparation. */
export interface AutoPreparedRun {
	readonly params: Readonly<{
		name: string;
		task: string;
		agent?: string;
		cwd?: string;
	}>;
	readonly role: AutoRoutingRoleDefinition | null;
	readonly selection: AutoRunSelection;
	/** The role as the effective harness sees it. */
	readonly agentDefs: Readonly<{
		tools?: string;
		denyTools?: string;
		skills?: string;
	}> | null;
	readonly persistent: boolean;
	readonly forceLeaf: boolean;
	readonly runtimePlans: readonly ResolvedRuntimePlan[];
	readonly nativePlan?: AutoNativePlanView;
	readonly provenance: RuntimeProvenance;
	readonly origin: AutoRunOrigin;
}

export type AutoParentRuntime = Readonly<{
	provider: string;
	modelId: string;
	thinking: string;
}>;

/** The current parent context, read once per snapshot. */
export type AutoRoutingContext = Readonly<{
	origin: AutoRunOrigin;
	herdrAvailable: boolean;
	/** Absent when the parent has no resolved model. */
	parentRuntime: AutoParentRuntime | null;
}>;

/** The parameters of one automatic spawn: its approved role and the prompt. */
export type AutoSpawnParams = Readonly<{
	name: string;
	task: string;
	agent: string;
}>;

/** Reads shared by every preparation of one snapshot, never across prompts. */
export type AutoPreparationReads<C extends AutoRoleCatalog> = Readonly<{
	catalog: C;
	installedSkills: () => InstalledSkill[];
	nativeOperations: NativeHarnessOperations;
}>;

export type AutoPreparation<P extends AutoPreparedRun> =
	| Readonly<{ ok: true; prepared: P }>
	| Readonly<{ ok: false; error: string; message: string }>;

/**
 * The existing launch authority, injected by the extension. Every member is
 * read-only: none creates a Herdr resource, file, lease, or network request.
 * `prepare` mints the authorization for one approved tuple from the loaded
 * allowlist and runs the shared pre-resource preparation; it may throw for a
 * runtime or prerequisite rejection. The prepared run it returns is plain
 * data without skill file bytes, pending exactly one launch.
 */
export interface AutoRoutingAuthority<
	P extends AutoPreparedRun,
	C extends AutoRoleCatalog,
> {
	context(): AutoRoutingContext;
	discoverRoles(): C;
	installedSkills(): InstalledSkill[];
	/** Private root skill snapshots would use; nothing is written there. */
	skillSnapshotRoot(): string | undefined;
	nativeOperations(): NativeHarnessOperations;
	piModels(): ModelRegistryAdapter;
	prepare(
		state: EnabledAutoRoutingState,
		candidateId: string,
		params: AutoSpawnParams,
		reads: AutoPreparationReads<C>,
	): AutoPreparation<P>;
}

export type AutoExactModel =
	| Readonly<{ namespace: "pi"; provider: string; id: string; ref: string }>
	| Readonly<{ namespace: NativeHarnessName; id: string }>;

/** One approved role with at least one feasible tuple. */
export type AutoSnapshotRole = Readonly<{
	/** Opaque `rNN`, deterministic within the snapshot. */
	id: string;
	approval: AutoRoleApproval;
	role: AutoRoutingRoleDefinition;
	roleFingerprint: string;
	skillFingerprints: readonly string[];
}>;

/** One feasible approved tuple and its local launch preparation. */
export type AutoCandidate<P extends AutoPreparedRun> = Readonly<{
	/** Opaque `cNNN`, deterministic within the snapshot. */
	id: string;
	/** Opaque `rNN` of the candidate's role. */
	roleId: string;
	role: AutoRoutingRoleDefinition;
	roleFingerprint: string;
	selection: AutoRunSelection;
	harness: AutoHarness;
	exactModel: AutoExactModel;
	exactEffort: AutoEffortLevel;
	tier: AutoModelTier;
	effortBand: AutoEffortBand;
	profile: AutoCandidateApproval;
	/** In-memory preflight only: never a pane, workspace, file, or lease. */
	prepared: P;
	capabilityFingerprint: string;
	skillFingerprints: readonly string[];
}>;

export type AutoFilteredCandidate = Readonly<{
	/** Configured candidate and role IDs; local evidence, never sent. */
	approvalId: string;
	roleApprovalId: string;
	reason: AutoCandidateFilterReason;
	detail: string;
}>;

/** A deeply immutable local snapshot bound to one decision and context. */
export type AutoRoutingSnapshot<P extends AutoPreparedRun> = Readonly<{
	/** Package attempt correlation, never a host submission identity. */
	decisionId: string;
	parentSessionId: string;
	sessionFile: string;
	branchAnchor: string | null;
	sessionGeneration: number;
	/** Canonical `ctx.cwd`, local only; the child runs here. */
	cwd: string;
	/** Canonical `process.cwd()` that project roles resolve from. */
	discoveryCwd: string;
	configHash: string;
	candidateSetHash: string;
	/** Binds the candidate set to this decision and context. */
	snapshotHash: string;
	policyVersion: AutoRoutingPolicyVersion;
	questionVersion: AutoRoutingQuestionVersion;
	jevModel: AutoRoutingJevModel;
	parentRuntime: AutoParentRuntime | null;
	/** The exact captured handler-visible request: local only, never hashed or logged. */
	task: string;
	roles: readonly AutoSnapshotRole[];
	candidates: readonly AutoCandidate<P>[];
	filtered: readonly AutoFilteredCandidate[];
}>;

export type AutoRoutingSnapshotInput = Readonly<{
	config: EnabledAutoRoutingState;
	/** The exact captured handler-visible request the child would receive. */
	task: string;
	decisionId: string;
	branchAnchor: string | null;
	sessionGeneration: number;
}>;

export type AutoRoutingSnapshotResult<P extends AutoPreparedRun> =
	| Readonly<{ ok: true; snapshot: AutoRoutingSnapshot<P> }>
	| Readonly<{
			ok: false;
			reason: AutoSnapshotFailureReason;
			detail: string;
			filtered: readonly AutoFilteredCandidate[];
	  }>;

export type AutoRoutingRevalidationInput = Readonly<{
	/** The configuration as currently loaded from the durable file. */
	config: LoadedAutoRoutingConfig;
	branchAnchor: string | null;
	sessionGeneration: number;
}>;

export type AutoRoutingRevalidation<P extends AutoPreparedRun> =
	| Readonly<{ ok: true; snapshot: AutoRoutingSnapshot<P> }>
	| Readonly<{
			ok: false;
			reason: "stale-snapshot";
			drift: readonly AutoSnapshotDrift[];
	  }>;

/** The only role data that may leave the machine. */
export type JevRoleProfile = Readonly<{
	id: string;
	responsibility: string;
	deliverable: string;
	excludes: string;
	intent: AutoRoleIntent;
}>;

/** The only tuple data that may leave the machine. */
export type JevCandidateProfile = Readonly<{
	id: string;
	roleId: string;
	harness: AutoHarness;
	exactModel: string;
	exactEffort: AutoEffortLevel;
	taskStrengths: string;
	limitations: string;
}>;

export type JevRoutingProfiles = Readonly<{
	roles: readonly JevRoleProfile[];
	candidates: readonly JevCandidateProfile[];
}>;

/** Discovery precedence: a higher layer overrides a lower one. */
const SOURCE_PRECEDENCE = {
	package: 0,
	global: 1,
	project: 2,
} as const satisfies Readonly<Record<AutoRoleSource, number>>;

/** Conservative policy bucket of each exact effort; not a token budget. */
const EFFORT_BANDS = {
	off: 0,
	minimal: 0,
	low: 0,
	medium: 1,
	high: 2,
	xhigh: 3,
	max: 3,
} as const satisfies Readonly<Record<AutoEffortLevel, AutoEffortBand>>;

const BATCH_A_EXECUTION = {
	childCount: 1,
	mode: "autonomous",
	context: "standalone-current-prompt-only",
	workspace: "current-checkout-ordinary-pane",
	delegation: "leaf-only",
} as const;

/** Mirrors the bounded Pi projection errors of resolveRoleProjection. */
const PROJECTION_ERRORS = new Set([
	"harness-projection-unsupported",
	"harness-switch-requires-model",
]);

function versionedSha256(domain: string, value: any): string {
	return sha256(`pi-herdr-agents/${domain}/v1\n${canonicalJson(value)}`);
}

/**
 * Versioned canonical fingerprint of a complete resolved role: every
 * resolved field (body, tools, deny policy, skills, modes, cwd, model and
 * thinking defaults) and its source/package identity. The local file path
 * is excluded, and key order and absent fields never change it.
 * Administrators approve this value as `definitionSha256`.
 */
export function autoRoleDefinitionSha256(
	role: AutoRoutingRoleDefinition,
): string {
	const { path: _path, ...definition } = role;
	return versionedSha256("auto-role-definition", definition);
}

/**
 * Freeze plain data deeply. Freezing cannot make binary data or keyed
 * collections immutable, so a snapshot never holds one.
 */
function deepFreeze<T>(value: T, seen = new Set<any>()): T {
	if (!Array.isArray(value) && !isRecord(value)) {
		// Primitives are immutable; any other object is not plain data.
		if (Object(value) === value)
			throw new TypeError(
				`Automatic routing snapshots hold only plain data, not ${Object.prototype.toString.call(value)}.`,
			);
		return value;
	}
	if (seen.has(value)) return value;
	seen.add(value);
	for (const item of Object.values(value)) deepFreeze(item, seen);
	Object.freeze(value);
	return value;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** Bounded, control-free local evidence. */
function boundedDetail(text: string): string {
	return truncateUtf8(
		text.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim(),
		AUTO_ROUTING_REQUEST_LIMITS.maxDetailBytes,
	);
}

function errorText(error: any): string {
	return error instanceof Error ? error.message : String(error);
}

function requireBindingId(value: string, label: string): void {
	if (
		value.trim() === "" ||
		/\p{Cc}/u.test(value) ||
		byteLength(value) > AUTO_ROUTING_REQUEST_LIMITS.maxBindingIdBytes
	)
		throw new TypeError(
			`Automatic routing ${label} must be a non-empty control-free string of at most ${AUTO_ROUTING_REQUEST_LIMITS.maxBindingIdBytes} bytes.`,
		);
}

function requireBinding(
	branchAnchor: string | null,
	sessionGeneration: number,
): void {
	if (branchAnchor !== null && /\p{Cc}/u.test(branchAnchor))
		throw new TypeError(
			"Automatic routing branch anchor must be control-free or null.",
		);
	if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0)
		throw new TypeError(
			"Automatic routing session generation must be a non-negative safe integer.",
		);
}

type VerifiedConfig =
	| { ok: true; config: EnabledAutoRoutingConfig }
	| { ok: false; reason: "config-invalid" | "config-drift"; detail: string };

/**
 * The allowlist exactly as loaded: it must re-parse strictly, as a whole, to
 * the recorded digest. A structurally invalid or modified configuration
 * fails the whole snapshot; no tuple is ever judged individually against it.
 */
function verifyConfig(state: EnabledAutoRoutingState): VerifiedConfig {
	let config;
	try {
		config = parseAutoRoutingConfig({
			[AUTO_ROUTING_CONFIG_KEY]: state.config,
		});
	} catch (error) {
		return {
			ok: false,
			reason: "config-invalid",
			detail: boundedDetail(errorText(error)),
		};
	}
	if (state.status !== "enabled" || config.mode === "off")
		return {
			ok: false,
			reason: "config-invalid",
			detail: "Automatic routing is not enabled by this configuration.",
		};
	if (autoRoutingConfigDigest(config) !== state.digest)
		return {
			ok: false,
			reason: "config-drift",
			detail:
				"The automatic routing configuration differs from its loaded digest.",
		};
	return { ok: true, config };
}

type RoleStatus =
	| {
			ok: true;
			role: AutoRoutingRoleDefinition;
			fingerprint: string;
			skills: readonly MaterializedSkill[];
			skillFingerprints: readonly string[];
	  }
	| { ok: false; reason: AutoCandidateFilterReason; detail: string };

function roleOrigin(
	role: Pick<AutoRoleApproval, "source" | "provider" | "providerVersion">,
): string {
	return role.provider
		? `package:${role.provider}@${role.providerVersion ?? "?"}`
		: role.source;
}

function skillFingerprint(skill: MaterializedSkill): string {
	return versionedSha256("auto-skill", {
		name: skill.name,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		content: skill.snapshot?.sha256 ?? `block:${skill.sha256}`,
		supportingFiles: skill.supportingFiles,
		hasScripts: skill.hasScripts,
	});
}

/**
 * The approved role exactly as normal precedence resolves it. A missing,
 * diagnosed, hidden, differently sourced, or changed resolution makes the
 * role unavailable; a lower-priority definition never stands in for it.
 * A discovery failure at or above the resolved role's layer, including a
 * malformed override, prevents or supersedes that role; a failure strictly
 * below it is overridden and cannot veto it. Inherited skills must be
 * installed, bounded, and usable with the role's own tools, and are
 * fingerprinted with their supporting files.
 */
function resolveApprovedRole(
	approval: AutoRoleApproval,
	catalog: AutoRoleCatalog,
	installedSkills: () => InstalledSkill[],
	snapshotRoot: string | undefined,
): RoleStatus {
	const name = JSON.stringify(approval.agent);
	const role = catalog.agents.find((agent) => agent.name === approval.agent);
	const floor = role ? SOURCE_PRECEDENCE[role.source] : -1;
	const failure = catalog.failures.find(
		(entry) =>
			entry.agentName === approval.agent &&
			SOURCE_PRECEDENCE[entry.source] >= floor,
	);
	if (failure)
		return {
			ok: false,
			reason: "role-diagnostic",
			detail: `Role ${name} has a ${failure.source} discovery diagnostic (${failure.code}); it is unavailable until the diagnostic is resolved.`,
		};
	if (!role)
		return {
			ok: false,
			reason: "role-missing",
			detail: `Approved role ${name} was not discovered.`,
		};
	if (role.disableModelInvocation)
		return {
			ok: false,
			reason: "role-hidden",
			detail: `Role ${name} resolves to a hidden ${roleOrigin(role)} definition, which never runs automatically.`,
		};
	if (
		role.source !== approval.source ||
		role.provider !== approval.provider ||
		role.providerVersion !== approval.providerVersion
	)
		return {
			ok: false,
			reason: "role-provenance-mismatch",
			detail: `Role ${name} resolves to ${roleOrigin(role)}, not the approved ${roleOrigin(approval)}; reapprove it deliberately.`,
		};
	const fingerprint = autoRoleDefinitionSha256(role);
	if (fingerprint !== approval.definitionSha256)
		return {
			ok: false,
			reason: "role-changed",
			detail: `Role ${name} changed since approval (definition ${fingerprint}); reapprove it deliberately.`,
		};
	const names = parseSkillNames(role.skills);
	let skills: MaterializedSkill[] = [];
	if (names.length > 0) {
		const tools = new Set(
			(role.tools ?? "")
				.split(",")
				.map((tool) => tool.trim())
				.filter(Boolean),
		);
		try {
			skills = materializeSkills(names, installedSkills(), tools, snapshotRoot);
		} catch (error) {
			return {
				ok: false,
				reason: "skill-invalid",
				detail: `Role ${name} cannot carry its skills: ${errorText(error)}`,
			};
		}
	}
	return {
		ok: true,
		role,
		fingerprint,
		skills,
		skillFingerprints: skills.map(skillFingerprint),
	};
}

type Rejection = { reason: AutoCandidateFilterReason; detail: string };

/** One exact, authenticated, physical text model in Pi's registry. */
function resolvePiModel(
	ref: string,
	registry: ModelRegistryAdapter,
): RoutingModel | Rejection {
	const parsed = parseExactModelRef(ref);
	let found: RoutingModel | undefined;
	try {
		found = parsed && registry.find(parsed.provider, parsed.modelId);
	} catch {
		found = undefined;
	}
	if (
		!parsed ||
		!found ||
		found.provider !== parsed.provider ||
		found.id !== parsed.modelId
	)
		return {
			reason: "pi-model-unknown",
			detail: `Pi model ${JSON.stringify(ref)} has no exact registry entry.`,
		};
	if (!registry.hasConfiguredAuth(found))
		return {
			reason: "pi-model-unauthenticated",
			detail: `Pi model ${JSON.stringify(ref)} has no configured authentication.`,
		};
	if (!found.api || found.api === VIRTUAL_MODEL_API)
		return {
			reason: "pi-model-not-physical",
			detail: `Pi model ${JSON.stringify(ref)} is not a known physical model.`,
		};
	if (!found.input?.includes("text"))
		return {
			reason: "pi-model-not-text",
			detail: `Pi model ${JSON.stringify(ref)} does not declare text input.`,
		};
	return found;
}

function isRejection(value: RoutingModel | Rejection): value is Rejection {
	return "reason" in value;
}

function preparationRejection(error: string): AutoCandidateFilterReason {
	if (error === "auto-launch-ineligible") return "role-ineligible";
	if (error === "native-harness-unsupported") return "native-rejected";
	if (PROJECTION_ERRORS.has(error)) return "projection-rejected";
	return "launch-rejected";
}

/** Native prerequisite checks run at most once per harness per snapshot. */
function memoizedNativeOperations(
	operations: NativeHarnessOperations,
): NativeHarnessOperations {
	const results = new Map<NativeHarnessName, string | null>();
	return {
		assertAvailable(harness) {
			if (!results.has(harness)) {
				try {
					operations.assertAvailable(harness);
					results.set(harness, null);
				} catch (error) {
					results.set(harness, errorText(error));
				}
			}
			const failure = results.get(harness);
			if (failure) throw new Error(failure);
		},
		validate: (run) => operations.validate(run),
	};
}

interface Feasible<P extends AutoPreparedRun> {
	approval: AutoCandidateApproval;
	role: Extract<RoleStatus, { ok: true }>;
	roleApproval: AutoRoleApproval;
	exactModel: AutoExactModel;
	prepared: P;
	capabilityFingerprint: string;
}

/**
 * The prepared run must be exactly the approved tuple on the verified role
 * snapshot: an autonomous standalone leaf in the parent's checkout whose
 * tool, deny, and skill policies are the role's own.
 */
function preparedRejection(
	prepared: AutoPreparedRun,
	approval: AutoCandidateApproval,
	role: Extract<RoleStatus, { ok: true }>,
	context: AutoRoutingContext,
): Rejection | undefined {
	if (
		!prepared.role ||
		autoRoleDefinitionSha256(prepared.role) !== role.fingerprint
	)
		return {
			reason: "role-changed",
			detail: "The role changed while its tuples were being prepared.",
		};
	const defs = prepared.agentDefs;
	if (
		prepared.selection.harness !== approval.harness ||
		prepared.selection.harnessSource !== "auto" ||
		!prepared.forceLeaf ||
		prepared.persistent ||
		prepared.params.cwd !== undefined ||
		!defs ||
		defs.tools !== role.role.tools ||
		defs.denyTools !== role.role.denyTools ||
		defs.skills !== role.role.skills ||
		canonicalJson(prepared.origin) !== canonicalJson(context.origin)
	)
		return {
			reason: "launch-rejected",
			detail:
				"The preparation is not the approved tuple as an automatic leaf in the parent's checkout.",
		};
	if (approval.model.namespace === "pi") {
		const [plan, ...fallbacks] = prepared.runtimePlans;
		if (
			prepared.nativePlan ||
			!plan ||
			fallbacks.length > 0 ||
			plan.model !== approval.model.ref ||
			plan.thinking !== approval.effort ||
			plan.modelSource !== "auto" ||
			plan.thinkingSource !== "auto" ||
			plan.thinkingAdjustment
		)
			return {
				reason: "runtime-rejected",
				detail: `Pi cannot run ${approval.model.ref} at ${approval.effort} exactly.`,
			};
		return undefined;
	}
	const native = prepared.nativePlan;
	if (
		!native ||
		prepared.runtimePlans.length > 0 ||
		native.spec.harness !== approval.harness ||
		canonicalJson(native.models) !== canonicalJson([approval.model.id]) ||
		native.spec.thinking !== approval.effort ||
		native.spec.mode !== "autonomous" ||
		native.spec.sessionMode !== "standalone" ||
		native.spec.spawnAgents !== null ||
		native.lineage
	)
		return {
			reason: "native-rejected",
			detail: `Native ${approval.harness} cannot run ${approval.model.id} at ${approval.effort} as an autonomous standalone leaf.`,
		};
	// The full initial delivery: the initial turn (skills, and a role body
	// folded into it), plus a role body the harness delivers separately
	// (Kiro, or Claude with a system-prompt mode), each counted once.
	const delivered =
		byteLength(native.initialText) +
		(native.spec.identity ? byteLength(native.spec.identity) : 0);
	if (delivered > MAX_INITIAL_PROMPT_BYTES)
		return {
			reason: "native-prompt-too-large",
			detail: `Native ${approval.harness} would initially deliver ${delivered} bytes including the role body; the limit is ${MAX_INITIAL_PROMPT_BYTES} bytes.`,
		};
	const planned = native.skills.map((skill) => skill.snapshot?.sha256);
	const verified = role.skills.map((skill) => skill.snapshot?.sha256);
	if (canonicalJson(planned) !== canonicalJson(verified))
		return {
			reason: "skill-changed",
			detail: "A skill changed while its tuples were being prepared.",
		};
	return undefined;
}

/** Runtime facts a tuple depends on; never the prompt or a file body. */
function capabilityFingerprint(
	prepared: AutoPreparedRun,
	piModel: RoutingModel | undefined,
): string {
	const common = {
		selection: prepared.selection,
		provenance: prepared.provenance,
		forceLeaf: prepared.forceLeaf,
		persistent: prepared.persistent,
	};
	const native = prepared.nativePlan;
	if (!native) {
		const plan = prepared.runtimePlans[0];
		return versionedSha256("auto-capability", {
			...common,
			harness: "pi",
			model: piModel && {
				provider: piModel.provider,
				id: piModel.id,
				api: piModel.api,
				reasoning: piModel.reasoning,
				thinkingLevelMap: piModel.thinkingLevelMap,
				input: piModel.input,
				contextWindow: piModel.contextWindow,
				maxTokens: piModel.maxTokens,
			},
			authenticated: true,
			runtime: {
				model: plan?.model,
				thinking: plan?.thinking,
				modelSource: plan?.modelSource,
				thinkingSource: plan?.thinkingSource,
			},
		});
	}
	const { spec } = native;
	return versionedSha256("auto-capability", {
		...common,
		harness: spec.harness,
		prerequisites: "available",
		spec: {
			tools: spec.tools,
			nativeTools: spec.nativeTools,
			modelRequest: spec.modelRequest,
			thinking: spec.thinking,
			promptMode: spec.promptMode,
			mode: spec.mode,
			sessionMode: spec.sessionMode,
			skills: spec.skills,
			spawnAgents: spec.spawnAgents,
		},
		models: native.models,
	});
}

function exactModelOf(approval: AutoCandidateApproval): AutoExactModel {
	if (approval.model.namespace !== "pi")
		return { namespace: approval.model.namespace, id: approval.model.id };
	const parsed = parseExactModelRef(approval.model.ref);
	return {
		namespace: "pi",
		provider: parsed?.provider ?? "",
		id: parsed?.modelId ?? "",
		ref: approval.model.ref,
	};
}

function exactModelText(model: AutoExactModel): string {
	return model.namespace === "pi" ? model.ref : model.id;
}

function roleDescriptor(profile: JevRoleProfile): string {
	return JSON.stringify({
		responsibility: profile.responsibility,
		deliverable: profile.deliverable,
		excludes: profile.excludes,
		intent: profile.intent,
	});
}

function candidateDescriptor(profile: JevCandidateProfile): string {
	return JSON.stringify({
		exactModel: profile.exactModel,
		exactEffort: profile.exactEffort,
		taskStrengths: profile.taskStrengths,
		limitations: profile.limitations,
	});
}

/** Wire bytes of one descriptor carried as a criterion or instruction string. */
const descriptorBytes = (descriptor: string) =>
	byteLength(JSON.stringify(descriptor));

/**
 * Upper bounds, in serialized UTF-8 JSON bytes, of the fixed text around the
 * profiles in every pinned `jev-auto-questions-v1` request: the batch
 * envelope; each question's envelope, ID, and shared instruction prefix; the
 * fixed instructions and criteria, including the reserved `none` and
 * `equivalent` options; criterion and state keys; and the Batch B workflow
 * strings. Each is the pinned wording measured and rounded up, so a snapshot
 * that passes preparation never needs more; the candidate tests prove this
 * against a reference serialization of that wording. The question builder's
 * exact serialized check stays as a second defense.
 */
export const AUTO_ROUTING_REQUEST_RESERVE = Object.freeze({
	/** `{"model":…,"state":…,"questions":{…}}` around one batch. */
	envelope: 64,
	/** One question's longest ID, type, and shared instruction prefix. */
	question: 448,
	/** One key with its separators, in a criteria record or state object. */
	field: 16,
	/** A1 role Choice wording and its `none` option. */
	roleChoice: 368,
	/** A2 fit wording and `true`/`false` criteria, without the profile. */
	roleFit: 368,
	/** Number of fixed Batch A questions: two Scores and eight Nouls. */
	fixedQuestionsA: 10,
	/** Wording and criteria of all fixed Batch A questions together. */
	fixedTextA: 3840,
	/** Wording and criteria of the largest fixed Batch A question. */
	largestFixedTextA: 576,
	/** The longest fixed runtime workflow string (Pi, Claude, or Kiro). */
	workflow: 256,
	/** B1 runtime Choice wording with its `equivalent` and `none` options. */
	runtimeChoice: 512,
	/** B2 model Choice wording and options, without workflow or profiles. */
	modelChoice: 720,
});

/** Upper bounds of one batch against the pinned request limits. */
export type AutoRequestBatchBytes = Readonly<{
	/** The serialized batch body. */
	bodyBytes: number;
	/** The serialized state plus its longest question. */
	stateAndQuestionBytes: number;
	/** The options of its largest Choice question. */
	choiceOptions: number;
}>;

export type AutoRequestEstimate = Readonly<{
	batchA: AutoRequestBatchBytes;
	/** For each role, a bound of every Batch B its tuples can produce. */
	batchB: readonly Readonly<AutoRequestBatchBytes & { roleId: string }>[];
}>;

const sum = (values: readonly number[]) =>
	values.reduce((total, value) => total + value, 0);

/**
 * Wire bytes of one tuple ID as a criteria key with its separators, never
 * less than the reserve a fixed key has.
 */
const candidateKeyBytes = (id: string) =>
	Math.max(AUTO_ROUTING_REQUEST_RESERVE.field, descriptorBytes(id) + 2);

/**
 * Upper bounds of the requests one snapshot's profiles can produce for a
 * prompt: the exact serialized state and profile descriptors plus the fixed
 * request reserve. Batch A carries every role profile in its state, its role
 * Choice, and one fit question each. Batch B, for any selected role, carries
 * at most one approved effort per exact model, and the required band decides
 * which. A tuple's single-encoded state entry and its double-encoded
 * criterion grow differently with escaped text, so no one tuple need be
 * largest in both: each exact model counts with its largest state entry and,
 * independently, its largest criterion across all its approved efforts, on
 * every runtime that has one.
 */
export function estimateAutoRoutingRequests(
	task: string,
	profiles: JevRoutingProfiles,
): AutoRequestEstimate {
	const reserve = AUTO_ROUTING_REQUEST_RESERVE;
	const stateA = byteLength(
		JSON.stringify({
			schema: "jev-auto-A-v1",
			prompt: task,
			roles: profiles.roles,
			execution: BATCH_A_EXECUTION,
		}),
	);
	const roles = profiles.roles.map((role) =>
		descriptorBytes(roleDescriptor(role)),
	);
	const questionsA = [
		reserve.question +
			reserve.roleChoice +
			sum(roles.map((bytes) => reserve.field + bytes)),
		...roles.map((bytes) => reserve.question + reserve.roleFit + bytes),
	];
	const batchA: AutoRequestBatchBytes = {
		bodyBytes:
			reserve.envelope +
			stateA +
			sum(questionsA) +
			reserve.fixedQuestionsA * reserve.question +
			reserve.fixedTextA,
		stateAndQuestionBytes:
			stateA +
			Math.max(reserve.question + reserve.largestFixedTextA, ...questionsA),
		choiceOptions: profiles.roles.length + 1,
	};
	const batchB = profiles.roles.map((role) => {
		const largest = new Map<
			string,
			{ harness: AutoHarness; entry: number; criterion: number }
		>();
		for (const candidate of profiles.candidates) {
			if (candidate.roleId !== role.id) continue;
			const key = `${candidate.harness}\u0000${candidate.exactModel}`;
			const current = largest.get(key);
			const entry = byteLength(
				JSON.stringify({
					id: candidate.id,
					exactModel: candidate.exactModel,
					exactEffort: candidate.exactEffort,
					taskStrengths: candidate.taskStrengths,
					limitations: candidate.limitations,
				}),
			);
			const criterion =
				candidateKeyBytes(candidate.id) +
				descriptorBytes(candidateDescriptor(candidate));
			largest.set(key, {
				harness: candidate.harness,
				entry: Math.max(entry, current?.entry ?? 0),
				criterion: Math.max(criterion, current?.criterion ?? 0),
			});
		}
		const runtimes = (["pi", "claude", "kiro"] as const)
			.map((harness) => ({
				id: harness,
				models: [...largest.values()].filter(
					(model) => model.harness === harness,
				),
			}))
			.filter((runtime) => runtime.models.length > 0);
		// Each runtime's workflow string is in the state, in the runtime
		// Choice, and in the runtime's model Choice instructions.
		const workflows = runtimes.length * (reserve.field + reserve.workflow);
		// Model entries fill each runtime's empty list, comma-separated.
		const stateB =
			byteLength(
				JSON.stringify({
					schema: "jev-auto-B-v1",
					prompt: task,
					role,
					requiredBand: 3,
					runtimes: runtimes.map((runtime) => ({
						id: runtime.id,
						models: [],
					})),
				}),
			) +
			sum(
				runtimes.map(
					(runtime) =>
						sum(runtime.models.map((model) => model.entry)) +
						runtime.models.length -
						1,
				),
			) +
			workflows;
		const questionsB = [
			reserve.question + reserve.runtimeChoice + workflows,
			...runtimes.map(
				(runtime) =>
					reserve.question +
					reserve.modelChoice +
					reserve.workflow +
					sum(runtime.models.map((model) => model.criterion)),
			),
		];
		return {
			roleId: role.id,
			bodyBytes: reserve.envelope + stateB + sum(questionsB),
			stateAndQuestionBytes: stateB + Math.max(...questionsB),
			choiceOptions: Math.max(
				runtimes.length + 2,
				...runtimes.map((runtime) => runtime.models.length + 2),
			),
		};
	});
	return { batchA, batchB };
}

/**
 * Why the requests this snapshot can produce cannot fit the pinned bounds.
 * Nothing is truncated or dropped: an unfit snapshot is unavailable whole.
 */
function requestBoundsViolation(
	task: string,
	profiles: JevRoutingProfiles,
): string | undefined {
	const limits = AUTO_ROUTING_REQUEST_LIMITS;
	if (
		profiles.roles.length > AUTO_ROUTING_LIMITS.maxRoles ||
		profiles.candidates.length > AUTO_ROUTING_LIMITS.maxCandidates
	)
		return "The feasible catalog exceeds the pinned role or tuple bounds.";
	const { batchA, batchB } = estimateAutoRoutingRequests(task, profiles);
	const batches: Array<[string, AutoRequestBatchBytes]> = [
		["Batch A", batchA],
		...batchB.map((batch): [string, AutoRequestBatchBytes] => [
			`Batch B for role ${batch.roleId}`,
			batch,
		]),
	];
	for (const [label, batch] of batches)
		if (
			batch.choiceOptions > limits.maxChoiceOptions ||
			batch.stateAndQuestionBytes > limits.maxStateAndQuestionBytes ||
			batch.bodyBytes > limits.maxBatchBytes
		)
			return `${label} needs up to ${batch.bodyBytes} bytes, ${batch.stateAndQuestionBytes} for its state and longest question, and ${batch.choiceOptions} options; the limits are ${limits.maxBatchBytes}, ${limits.maxStateAndQuestionBytes}, and ${limits.maxChoiceOptions}.`;
	return undefined;
}

/**
 * Build the immutable feasible-candidate snapshot for one eligible prompt.
 * Every approved tuple is checked through the shared launch authority with
 * the real prompt; unavailable tuples are filtered with bounded reasons.
 * Nothing is launched, written, leased, or sent.
 */
export function buildAutoRoutingSnapshot<
	P extends AutoPreparedRun,
	C extends AutoRoleCatalog,
>(
	input: AutoRoutingSnapshotInput,
	authority: AutoRoutingAuthority<P, C>,
): AutoRoutingSnapshotResult<P> {
	requireBindingId(input.decisionId, "decision ID");
	requireBinding(input.branchAnchor, input.sessionGeneration);
	const filtered: AutoFilteredCandidate[] = [];
	const fail = (
		reason: AutoSnapshotFailureReason,
		detail: string,
	): AutoRoutingSnapshotResult<P> =>
		deepFreeze({ ok: false, reason, detail: boundedDetail(detail), filtered });

	const verified = verifyConfig(input.config);
	if (!verified.ok) return fail(verified.reason, verified.detail);
	const { config } = verified;
	if (input.task.trim() === "")
		return fail("blank-prompt", "The prompt is blank.");
	if (byteLength(input.task) > AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes)
		return fail(
			"prompt-too-large",
			`The prompt exceeds ${AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes} UTF-8 bytes.`,
		);
	const context = authority.context();
	if (!context.origin.sessionFile)
		return fail("no-session-file", "The parent has no persisted session.");
	if (!context.herdrAvailable)
		return fail("herdr-unavailable", "Herdr is not available.");

	// Role precedence is resolved once; every tuple uses this catalog.
	const catalog = authority.discoverRoles();
	let installed: InstalledSkill[] | undefined;
	const installedSkills = () => {
		installed ??= authority.installedSkills();
		return [...installed];
	};
	const reads: AutoPreparationReads<C> = {
		catalog,
		installedSkills,
		nativeOperations: memoizedNativeOperations(authority.nativeOperations()),
	};
	const snapshotRoot = authority.skillSnapshotRoot();
	const registry = authority.piModels();
	const roleStatuses = new Map<string, RoleStatus>();
	const feasible: Feasible<P>[] = [];

	for (const approval of config.candidates) {
		const reject = (reason: AutoCandidateFilterReason, detail: string) => {
			filtered.push({
				approvalId: approval.id,
				roleApprovalId: approval.roleId,
				reason,
				detail: boundedDetail(detail),
			});
		};
		// SAFETY: the strict parse guarantees every roleId names an approved role.
		const roleApproval = config.roles.find(
			(role) => role.id === approval.roleId,
		)!;
		let role = roleStatuses.get(roleApproval.id);
		if (!role) {
			role = resolveApprovedRole(
				roleApproval,
				catalog,
				installedSkills,
				snapshotRoot,
			);
			roleStatuses.set(roleApproval.id, role);
		}
		if (!role.ok) {
			reject(role.reason, role.detail);
			continue;
		}

		let piModel: RoutingModel | undefined;
		if (approval.model.namespace === "pi") {
			const resolved = resolvePiModel(approval.model.ref, registry);
			if (isRejection(resolved)) {
				reject(resolved.reason, resolved.detail);
				continue;
			}
			piModel = resolved;
		} else {
			try {
				reads.nativeOperations.assertAvailable(approval.model.namespace);
			} catch (error) {
				reject("native-prerequisite-missing", errorText(error));
				continue;
			}
		}

		let preparation: AutoPreparation<P>;
		try {
			preparation = authority.prepare(
				input.config,
				approval.id,
				{
					name: `auto-${roleApproval.id}`,
					task: input.task,
					agent: roleApproval.agent,
				},
				reads,
			);
		} catch (error) {
			reject(
				error instanceof RuntimeResolutionError
					? "runtime-rejected"
					: "launch-rejected",
				errorText(error),
			);
			continue;
		}
		if (!preparation.ok) {
			reject(preparationRejection(preparation.error), preparation.message);
			continue;
		}
		const rejection = preparedRejection(
			preparation.prepared,
			approval,
			role,
			context,
		);
		if (rejection) {
			reject(rejection.reason, rejection.detail);
			continue;
		}
		feasible.push({
			approval,
			role,
			roleApproval,
			exactModel: exactModelOf(approval),
			prepared: preparation.prepared,
			capabilityFingerprint: capabilityFingerprint(
				preparation.prepared,
				piModel,
			),
		});
	}

	if (feasible.length === 0)
		return fail(
			"no-feasible-candidate",
			"No approved tuple is feasible in the current context.",
		);

	// Opaque IDs follow configuration order over the feasible set only.
	const roleIds = new Map<string, string>();
	for (const roleApproval of config.roles)
		if (feasible.some((entry) => entry.roleApproval.id === roleApproval.id))
			roleIds.set(roleApproval.id, `r${String(roleIds.size).padStart(2, "0")}`);
	const roles: AutoSnapshotRole[] = config.roles.flatMap((approval) => {
		const id = roleIds.get(approval.id);
		const status = roleStatuses.get(approval.id);
		return id && status?.ok
			? [
					{
						id,
						approval,
						role: status.role,
						roleFingerprint: status.fingerprint,
						skillFingerprints: status.skillFingerprints,
					},
				]
			: [];
	});
	const candidates: AutoCandidate<P>[] = feasible.map((entry, index) => ({
		id: `c${String(index).padStart(3, "0")}`,
		// SAFETY: every feasible tuple's role received an ID above.
		roleId: roleIds.get(entry.roleApproval.id)!,
		role: entry.role.role,
		roleFingerprint: entry.role.fingerprint,
		selection: entry.prepared.selection,
		harness: entry.approval.harness,
		exactModel: entry.exactModel,
		exactEffort: entry.approval.effort,
		tier: entry.approval.tier,
		effortBand: EFFORT_BANDS[entry.approval.effort],
		profile: entry.approval,
		prepared: entry.prepared,
		capabilityFingerprint: entry.capabilityFingerprint,
		skillFingerprints: entry.role.skillFingerprints,
	}));

	const violation = requestBoundsViolation(
		input.task,
		profilesOf(roles, candidates),
	);
	if (violation) return fail("jev-request-too-large", violation);

	const candidateSetHash = versionedSha256("auto-candidates", {
		roles: roles.map((role) => ({
			id: role.id,
			approvalId: role.approval.id,
			roleFingerprint: role.roleFingerprint,
			skillFingerprints: role.skillFingerprints,
		})),
		candidates: candidates.map((candidate) => ({
			id: candidate.id,
			roleId: candidate.roleId,
			approvalId: candidate.profile.id,
			harness: candidate.harness,
			exactModel: candidate.exactModel,
			exactEffort: candidate.exactEffort,
			roleFingerprint: candidate.roleFingerprint,
			capabilityFingerprint: candidate.capabilityFingerprint,
			skillFingerprints: candidate.skillFingerprints,
		})),
	});
	const binding = {
		decisionId: input.decisionId,
		parentSessionId: context.origin.sessionId,
		sessionFile: context.origin.sessionFile,
		branchAnchor: input.branchAnchor,
		sessionGeneration: input.sessionGeneration,
		cwd: context.origin.cwd,
		discoveryCwd: context.origin.discoveryCwd,
		configHash: input.config.digest,
		candidateSetHash,
		policyVersion: config.policyVersion,
		questionVersion: config.questionVersion,
		jevModel: config.jev.model,
		parentRuntime: context.parentRuntime && { ...context.parentRuntime },
	};
	return deepFreeze({
		ok: true,
		snapshot: {
			...binding,
			snapshotHash: versionedSha256("auto-snapshot", binding),
			task: input.task,
			roles,
			candidates,
			filtered,
		},
	});
}

function profilesOf(
	roles: readonly AutoSnapshotRole[],
	candidates: readonly AutoCandidate<AutoPreparedRun>[],
): JevRoutingProfiles {
	return {
		roles: roles.map((role) => ({
			id: role.id,
			responsibility: role.approval.responsibility,
			deliverable: role.approval.deliverable,
			excludes: role.approval.excludes,
			intent: role.approval.intent,
		})),
		candidates: candidates.map((candidate) => ({
			id: candidate.id,
			roleId: candidate.roleId,
			harness: candidate.harness,
			exactModel: exactModelText(candidate.exactModel),
			exactEffort: candidate.exactEffort,
			taskStrengths: candidate.profile.taskStrengths,
			limitations: candidate.profile.limitations,
		})),
	};
}

/**
 * The administrator-reviewed profiles that may be sent to the classifier,
 * under opaque snapshot IDs. They never carry role or configuration names,
 * paths, role or skill bodies, tools, authentication, or file contents.
 */
export function toJevRoleProfiles(
	snapshot: AutoRoutingSnapshot<AutoPreparedRun>,
): JevRoutingProfiles {
	return deepFreeze(profilesOf(snapshot.roles, snapshot.candidates));
}

function contextKey(snapshot: AutoRoutingSnapshot<AutoPreparedRun>): string {
	return canonicalJson({
		decisionId: snapshot.decisionId,
		parentSessionId: snapshot.parentSessionId,
		sessionFile: snapshot.sessionFile,
		branchAnchor: snapshot.branchAnchor,
		sessionGeneration: snapshot.sessionGeneration,
		cwd: snapshot.cwd,
		discoveryCwd: snapshot.discoveryCwd,
		parentRuntime: snapshot.parentRuntime,
	});
}

/** Every way two snapshots of the same decision differ. */
function snapshotDrift(
	original: AutoRoutingSnapshot<AutoPreparedRun>,
	current: AutoRoutingSnapshot<AutoPreparedRun>,
): AutoSnapshotDrift[] {
	const drift = new Set<AutoSnapshotDrift>();
	if (
		current.configHash !== original.configHash ||
		current.policyVersion !== original.policyVersion ||
		current.questionVersion !== original.questionVersion ||
		current.jevModel !== original.jevModel
	)
		drift.add("config");
	if (contextKey(current) !== contextKey(original)) drift.add("context");
	const now = new Map(
		current.candidates.map((candidate) => [candidate.profile.id, candidate]),
	);
	if (
		now.size !== original.candidates.length ||
		original.candidates.some(
			(candidate) =>
				now.get(candidate.profile.id)?.id !== candidate.id ||
				now.get(candidate.profile.id)?.roleId !== candidate.roleId,
		)
	)
		drift.add("candidates");
	for (const candidate of original.candidates) {
		const other = now.get(candidate.profile.id);
		if (!other) continue;
		if (other.roleFingerprint !== candidate.roleFingerprint) drift.add("role");
		if (
			canonicalJson(other.skillFingerprints) !==
			canonicalJson(candidate.skillFingerprints)
		)
			drift.add("skill");
		if (other.capabilityFingerprint !== candidate.capabilityFingerprint)
			drift.add("capability");
	}
	if (
		drift.size === 0 &&
		current.candidateSetHash !== original.candidateSetHash
	)
		drift.add("candidates");
	return AUTO_SNAPSHOT_DRIFTS.filter((kind) => drift.has(kind));
}

function stale<P extends AutoPreparedRun>(
	drift: readonly AutoSnapshotDrift[],
): AutoRoutingRevalidation<P> {
	return deepFreeze({ ok: false, reason: "stale-snapshot", drift: [...drift] });
}

/**
 * Immediately recompute the complete relevant feasible approved set for the
 * snapshot's decision and prompt and require it to equal the snapshot: the
 * same configuration, parent context, roles, skills, runtime capabilities,
 * and tuples, not merely a surviving winner. Models outside the allowlist
 * never enter the comparison. A stale snapshot is never repaired.
 */
export function revalidateAutoRoutingSnapshot<
	P extends AutoPreparedRun,
	C extends AutoRoleCatalog,
>(
	snapshot: AutoRoutingSnapshot<P>,
	current: AutoRoutingRevalidationInput,
	authority: AutoRoutingAuthority<P, C>,
): AutoRoutingRevalidation<P> {
	const config = current.config;
	if (config.status !== "enabled" || config.digest !== snapshot.configHash)
		return stale(["config"]);
	let rebuilt: AutoRoutingSnapshotResult<P>;
	try {
		rebuilt = buildAutoRoutingSnapshot(
			{
				config,
				task: snapshot.task,
				decisionId: snapshot.decisionId,
				branchAnchor: current.branchAnchor,
				sessionGeneration: current.sessionGeneration,
			},
			authority,
		);
	} catch {
		return stale(["unverifiable"]);
	}
	if (!rebuilt.ok)
		return stale([
			rebuilt.reason === "config-invalid" || rebuilt.reason === "config-drift"
				? "config"
				: rebuilt.reason === "no-session-file" ||
						rebuilt.reason === "herdr-unavailable"
					? "context"
					: "candidates",
		]);
	const drift = snapshotDrift(snapshot, rebuilt.snapshot);
	return drift.length > 0
		? stale(drift)
		: deepFreeze({ ok: true, snapshot: rebuilt.snapshot });
}
