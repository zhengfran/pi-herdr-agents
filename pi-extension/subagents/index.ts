import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { keyHint, loadSkills } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
	Box,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	existsSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
	isTerminalAvailable,
	terminalSetupHint,
	createSubagentPane,
	runScriptInPane,
	closePane,
	interruptPane,
	runInPane,
	shellQuote,
	readPaneAsync,
	inspectPane,
	listPanes,
	waitForShellReady,
} from "./terminal.ts";
import { listHerdrWorktrees } from "./herdr.ts";
import { waitForCompletion } from "./completion.ts";
import {
	SupervisionCoordinator,
	type SupervisionRegistration,
} from "./supervision.ts";
import { loadSupervisionConfig } from "./supervision-config.ts";
import {
	buildAuthenticatedModelCatalog,
	getAuthenticatedTaskPreferences,
	parseExactModelRef,
	resolveRuntimePlan,
	resolveRuntimePlans,
	wrapPiModelRegistry,
	THINKING_LEVELS,
	automaticFieldProvenance,
	isThinkingLevel,
	type ResolvedRuntimePlan,
	type RuntimeDefaults,
	type RuntimeFieldProvenance,
	type RuntimeProvenance,
	type ThinkingLevel,
} from "./runtime-routing.ts";
import {
	AUTO_ROUTING_CONFIG_KEY,
	autoRoutingConfigDigest,
	loadAutoRoutingConfig,
	parseAutoRoutingConfig,
	type AutoCandidateApproval,
	type AutoRoleApproval,
	type AutoRoutingConfig,
	type EnabledAutoRoutingState,
} from "./auto-routing-config.ts";
import type {
	AutoNativePlanView,
	AutoRoutingAuthority,
} from "./auto-routing-candidates.ts";
import {
	AUTO_REQUEST_CUSTOM_TYPE,
	AUTO_ROUTING_DISABLED_ENV,
	AUTO_STATUS_CUSTOM_TYPE,
	autoRequestView,
	autoStatusView,
	AutoLaunchStoppedError,
	autoRunBindingAuthorizes,
	createAutoRoutingCoordinator,
	formatAutoRoutingStatus,
	type AutoLaunchHandoff,
	type AutoLaunchOutcome,
	type AutoMessageView,
	type AutoRetainedWork,
	type AutoRoutingCoordinatorOptions,
	type AutoRunBinding,
	type AutoRunReceipt,
} from "./auto-routing-input.ts";
import { createJevTransport } from "./jev-client.ts";
import {
	loadModelConfig,
	resolveModelDefault,
	writeTaskModelConfig,
	TASK_CATEGORIES,
	TASK_CATEGORY_DESCRIPTIONS,
	type TaskPreferences,
	type TaskPreferencesMeta,
} from "./model-config.ts";
import {
	getAgentConfigDir,
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "./config-path.ts";
import { loadRoleConfig, type RoleConfig } from "./role-config.ts";
import {
	buildTaskModelBrief,
	buildTaskModelInitPrompt,
} from "./task-model-init.ts";
import {
	loadPersistentConfig,
	type PersistentConfig,
} from "./persistent-config.ts";
import {
	appendPersistentDeliveryLedger,
	findLastAssistantMessage,
	findObservedSessionRuntime,
	inspectNoProgressSessionTail,
	type NoProgressClassification,
	type NoProgressSessionTail,
	getNewEntries,
	createBtwSessionSnapshot,
	getPersistentDeliveryLedgerFile,
	type PersistentDeliveryLedgerEntry,
	readPersistentDeliveryLedger,
	readPersistentTaskEvents,
	readSubagentSessionPolicy,
	writePersistentTaskInbox,
} from "./session.ts";
import {
	type SubagentStatusState,
	capStatusLines,
	formatElapsedDuration,
	formatStatusAggregate,
	normalizeStatusName,
	loadStatusConfig,
} from "./status.ts";
import {
	readSubagentActivityFile,
	isSubagentActivityScope,
	type ActivityReadResult,
	type SubagentActivityState,
} from "./activity.ts";
import { isFiniteNumber, isPlainObject, isString } from "./type-guards.ts";
import {
	createLifecycle,
	formatLifecycleTransitionLine,
	lifecycleTransition,
	markCompleted,
	markCompletionDetected,
	markDelivery,
	markFailed,
	markInterruptRequested,
	markProcessRunning,
	observeActivity,
	observePaneInspection,
	projectLifecycle,
	type LifecycleProjection,
	type SubagentLifecycle,
	type PaneInspection,
} from "./lifecycle.ts";
import {
	createWorktreeCleanupOperations,
	listContainedWorktrees,
	removeContainedWorktree,
	formatWorktreeInventory,
	type WorktreeCleanupOperations,
} from "./worktree-cleanup.ts";
import {
	captureWorktreeHandoff,
	readWorktreeManifest,
	launchNativeSubagent,
	nativeSessionMarkerPath,
	NativeLaunchUnresolvedError,
	retainUnresolvedWorktree,
	unknownWorktreeHandoff,
	type AutomaticLaunch,
	type PiLaunchOperations,
	launchPiSubagent,
	launchPiWorktreeHandoff,
	persistWorktreeResult,
	runSubagentScript,
	writeWorktreeManifest,
	buildSubagentToolAllowlist,
	type WorktreeHandoff,
	type WorktreeLaunch,
} from "./launch.ts";
import {
	checkNativeResume,
	createNativeHarnessOperations,
	isNativeHarnessName,
	nativeHarnessLabel,
	nativeOutcome,
	nativeSessionId,
	nativeTurnAdapter,
	planNativeLaunch,
	readNativeSessionMarker,
	releaseNativeRun,
	resolveNativeLaunchSpec,
	retainedNativeEvidence,
	waitForNativeCompletion,
	type NativeHarnessName,
	type NativeLaunchPlan,
	type NativeLaunchSpec,
	type NativeRoleDefinition,
	type NativeRun,
	type NativeSessionMarker,
	type NativeHarnessOperations,
} from "./native-harness.ts";
import {
	enqueueNativeTurn,
	isNativeDriverIdle,
	requestNativeInterrupt,
	type NativeRunOutcome,
	type NativeTurn,
} from "./native-turns.ts";
import {
	collectBridgeRequests,
	writeBridgeResponse,
	type BridgeRequest,
	type BridgeResponse,
} from "./native-bridge.ts";
import {
	inspectRunLease,
	nativeWorktreeLeaseFile,
	releaseReservedLease,
} from "./native-session.ts";
import {
	sanitizeArtifactText,
	truncateUtf8,
	wrapUntrustedData,
	type InstalledSkill,
} from "./native-context.ts";
import {
	confirmProcessExit,
	defaultProcessInspector,
	readProcessRunState,
	terminateProcessRun,
	writeCancelMarker,
	type ExitConfirmation,
	type ProcessRun,
	type TerminationResult,
} from "./process-run.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");

function readGlobalSlot<T>(key: symbol): T | undefined {
	// SAFETY: `globalThis` has no index signature for our extension-private
	// symbol keys; only this module ever writes the values read back here.
	return (globalThis as Record<symbol, T | undefined>)[key];
}

function writeGlobalSlot<T>(key: symbol, value: T): void {
	// SAFETY: see readGlobalSlot above; this module is the sole writer.
	(globalThis as Record<symbol, T | undefined>)[key] = value;
}

const BTW_BOUNDARY = `You are answering an ephemeral BTW side question.
Treat inherited conversation history only as reference context. Do not resume or complete an
earlier task. Answer only the question after this boundary. Do not modify the workspace unless
that side question explicitly requests a mutation.

BTW question:
`;

interface BtwChild {
	surface: string;
	sessionFile: string;
	launchScriptFile: string;
}

function getFirstText(
	content: readonly { type: string; text?: string }[],
): string {
	const first = content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

{
	const prevInterval =
		readGlobalSlot<ReturnType<typeof setInterval>>(WIDGET_INTERVAL_KEY);
	if (prevInterval) {
		clearInterval(prevInterval);
		writeGlobalSlot<ReturnType<typeof setInterval> | null>(
			WIDGET_INTERVAL_KEY,
			null,
		);
	}
	const prevStatusInterval =
		readGlobalSlot<ReturnType<typeof setInterval>>(STATUS_INTERVAL_KEY);
	if (prevStatusInterval) {
		clearInterval(prevStatusInterval);
		writeGlobalSlot<ReturnType<typeof setInterval> | null>(
			STATUS_INTERVAL_KEY,
			null,
		);
	}
}

function buildSubagentRoutingGuidelines(
	catalog?: string,
	authenticatedTaskPreferences?: TaskPreferences,
): string[] {
	return [
		"Act as the coordinator: decompose the work, give each child one bounded outcome — goal, allowed files, verification, and whether to commit — and keep dependent writes sequential; parallelize only independent tasks.",
		"Children are leaves by default: they do not push, merge, deploy, or orchestrate further agents unless their task explicitly authorizes it. The parent inspects each result or worktree handoff (diff against the reported base, run relevant tests) and owns integration, verification, and cleanup.",
		...(Object.keys(authenticatedTaskPreferences ?? {}).length > 0
			? [
					"For non-review work, prefer the configured task-category shortlists below and use task:<category> only as the entire model value. Use exact IDs for reviews when the authoring family is known.",
				]
			: [
					"For orchestrated subagent work, explicitly set both model and thinking for every child: first choose a fast, mid, or frontier provider-family tier matched to task complexity, then set thinking within that model's supported range.",
					"Use fast tier for bounded mechanical work and recon, mid tier for ordinary implementation or review, and frontier tier for architecture, security, hard diagnosis, or adversarial review. Use minimal/low thinking for mechanical work, medium for ordinary work, and high+ for hard work.",
				]),
		"For ordinary review, prefer a different authenticated model family. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback. Use an exact authenticated provider/model-id from the live catalog below, never an alias or fuzzy name.",
		"Omitting model and thinking still inherits the parent runtime, but this is a discouraged fallback for orchestrated children.",
		"Before launching a new group of subagents, choose a short task slug and name each new child <task>-<role>[-n], for example login-api or login-test2. Use only plan, research, ui, api, build, test, review, browser, security, perf, or merge as roles; leave existing names unchanged. After the final launch, print name | agent kind | role | model | worktree (if any), then use each name in prompts, handoffs, and results.",
		catalog ??
			"Authenticated subagent model catalog becomes available after session start.",
	];
}

const subagentRoutingGuidelines = buildSubagentRoutingGuidelines();

const ThinkingLevelSchema = Type.Union(
	THINKING_LEVELS.map((level) => Type.Literal(level)),
	{
		description:
			"Pi thinking level. Pick the model tier first, then set thinking within that model's range: minimal/low for bounded mechanical work, medium for ordinary implementation or review, high+ for architecture, security, or hard diagnosis. Omitting still inherits the parent level; do not omit on orchestrated child work.",
	},
);

const SubagentParams = Type.Object({
	name: Type.String({
		description:
			"Short stable label for the subagent; for a new coordinated group use <task>-<role>[-n] (shown in the widget and pane title)",
	}),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	agent: Type.Optional(
		Type.String({
			description:
				"Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Discovery precedence is project .pi/agents, global ~/.pi/agent/agents, then package-bundled agents.",
		}),
	),
	harness: Type.Optional(
		Type.Union(
			[Type.Literal("pi"), Type.Literal("claude"), Type.Literal("kiro")],
			{
				description:
					"Runtime harness for a named role (requires agent). Effective harness: this value, else the role's cli frontmatter, else pi. Selecting a harness other than the role's own is a strict validated projection, not a conversion: incompatible tools, thinking, skills, prompt mode, or delegation are rejected before any pane exists; a role-pinned model belongs to its own harness, so switching requires an explicit destination model. pi takes Pi provider/model refs; claude and kiro take native CLI model IDs or task:<category> from models.native.<cli>.tasks. Omit to keep the role's own harness.",
			},
		),
	),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Role/system-prompt text for a bare spawn. Named agents keep their definition body.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Explicitly pick an exact authenticated provider/model-id, an ordered comma-separated fallback list, or task:<category> as the entire value. task: categories are case-insensitive and expand configured authenticated candidates; worktrees use only the first. For ordinary review, prefer a different authenticated model family. When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session. Disclose that this review is context-isolated, not cross-family independent. Cross-family verification, `/skill:orchestrate`, and `adversarial-reviewer` must not use this fallback. Omitting still inherits the parent model; do not omit for orchestrated children. Fallback lists cannot be used with worktrees. When the effective harness is claude or kiro (role cli or the harness parameter), model instead takes native CLI model IDs, an ordered native fallback list, or task:<category> resolved from models.native.<cli>.tasks, never Pi provider/model refs.",
		}),
	),
	thinking: Type.Optional(ThinkingLevelSchema),
	skills: Type.Optional(
		Type.String({
			description:
				"Comma-separated installed Pi skills (overrides agent default). Native roles receive bounded skill instructions in their first turn and reject skills whose tools or scripts they cannot use.",
		}),
	),
	tools: Type.Optional(
		Type.String({
			description: "Comma-separated tools (overrides agent default)",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the sub-agent. Without worktree, the agent starts in this folder. With worktree, this selects the source Git repository and the agent starts at the created worktree root.",
		}),
	),
	worktree: Type.Optional(
		Type.Union(
			[
				Type.Object({
					branch: Type.String({
						minLength: 1,
						description:
							"New branch name for an isolated Herdr-managed Git worktree",
					}),
					base: Type.Optional(
						Type.String({
							description:
								"Git revision to branch from. Defaults to the source checkout's committed HEAD.",
						}),
					),
				}),
				Type.Null(),
			],
			{
				description:
					"Optional isolated Herdr-managed Git worktree. Omit or pass null to use an ordinary pane in cwd.",
			},
		),
	),
	fork: Type.Optional(
		Type.Boolean({
			description:
				"Override the child session mode for this spawn. `true` forces full-context fork; `false` forces standalone. Omit to inherit the agent frontmatter session-mode.",
		}),
	),
	persistent: Type.Optional(
		Type.Boolean({
			description:
				"Keep this stable specialist session alive between turn-based tasks. Persistent agents accept follow-up work only through subagent_send.",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
		}),
	),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
	/** Native harness; omitted for Pi-backed roles. */
	cli?: NativeHarnessName;
	model?: string;
	tools?: string;
	skills?: string;
	thinking?: ThinkingLevel;
	denyTools?: string;
	spawning?: boolean;
	/** Native roles only: comma-separated roles this child may delegate to. */
	spawnAgents?: string;
	persistent?: boolean;
	autoExit?: boolean;
	interactive?: boolean;
	systemPromptMode?: "append" | "replace";
	sessionMode?: SubagentSessionMode;
	cwd?: string;
	body?: string;
	disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
	name: string;
	description?: string;
	disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
	source: AgentSource;
	path: string;
	provider?: string;
	providerVersion?: string;
}

interface AgentDiagnostic {
	code: string;
	message: string;
	path?: string;
	agentName?: string;
	provider?: string;
}

interface AgentCatalog {
	agents: ListedAgentDefinition[];
	diagnostics: AgentDiagnostic[];
}

/**
 * A per-role discovery failure and the precedence layer that produced it:
 * every diagnostic naming a role, and every definition without valid
 * frontmatter, which ordinary discovery skips silently. Only automatic
 * routing collects these; manual discovery and launch never consult them.
 */
interface AgentLayerFailure {
	agentName: string;
	source: AgentSource;
	code: string;
}

/** A catalog with the precedence evidence automatic routing requires. */
interface AutoAgentCatalog extends AgentCatalog {
	failures: AgentLayerFailure[];
}

const ROLE_PACK_DISCOVERY_EVENT = "pi-herdr-subagents:roles:discover:v1";

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
	"subagent",
	"subagent_interrupt",
	"subagents_list",
	"subagent_resume",
	"subagent_send",
	"subagent_stop",
	"subagents_write_task_models",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
	const denied = new Set<string>();
	if (!agentDefs) return denied;

	// spawning: false → deny all spawning tools
	if (agentDefs.spawning === false) {
		for (const t of SPAWNING_TOOLS) denied.add(t);
	}

	// deny-tools: explicit list
	if (agentDefs.denyTools) {
		for (const t of agentDefs.denyTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			denied.add(t);
		}
	}

	return denied;
}

/** Runtime harness of one spawn: Pi, or a native CLI. */
type SubagentHarness = "pi" | NativeHarnessName;

const SUBAGENT_HARNESSES: readonly SubagentHarness[] = ["pi", "claude", "kiro"];

function isSubagentHarness(value: string): value is SubagentHarness {
	return SUBAGENT_HARNESSES.some((harness) => harness === value);
}

/**
 * Effective harness selection for one fresh spawn. It is resolved once,
 * before any Herdr resource, and carried unchanged through the launch
 * acknowledgement, every model fallback attempt, persistent task results,
 * and completion. Resume never re-resolves it: a native marker's recorded
 * loadout governs, and Pi resume restores its recorded launch policy.
 * Selected model and thinking stay in the existing runtime/native fields.
 */
interface SubagentSelection {
	harness: SubagentHarness;
	/**
	 * `request`: the spawn's `harness`; `role`: the role's `cli`; `default`:
	 * Pi; `auto`: a verified administrator-approved automatic tuple.
	 */
	harnessSource: "request" | "role" | "default" | "auto";
	/** A named role running outside the harness it declares. */
	projected: boolean;
	/** Named roles only: the resolved definition's provenance. */
	role?: {
		name: string;
		source: AgentSource;
		provider?: string;
		providerVersion?: string;
		/** The harness the role declares: its `cli`, otherwise Pi. */
		harness: SubagentHarness;
	};
}

type RoleProjection =
	| {
			ok: true;
			selection: SubagentSelection;
			/** The role as the effective harness sees it; null for bare spawns. */
			agentDefs: ListedAgentDefinition | null;
	  }
	| { ok: false; error: string; message: string };

/**
 * Administrator authorization for one automatic spawn: one exact approved
 * role/harness/model/effort tuple of a loaded `autoRouting` configuration.
 * Only createAutoLaunchAuthorization mints one. Structurally identical
 * objects, including anything parsed from tool or command arguments, are
 * rejected; no public parameter can carry one.
 */
interface AutoLaunchAuthorization {
	readonly configDigest: string;
	readonly role: AutoRoleApproval;
	readonly candidate: AutoCandidateApproval;
	readonly harness: SubagentHarness;
	/** Exact Pi provider/model-id or exact native model ID, per harness. */
	readonly model: string;
	readonly effort: ThinkingLevel;
}

const mintedAutoAuthorizations = new WeakSet<AutoLaunchAuthorization>();

/**
 * Mint the authorization for one approved candidate. The configuration must
 * re-parse strictly to its recorded digest, and the tuple is copied from that
 * immutable parse, so a modified approval can never authorize a launch.
 */
function createAutoLaunchAuthorization(
	state: EnabledAutoRoutingState,
	candidateId: string,
): AutoLaunchAuthorization {
	let config: AutoRoutingConfig;
	try {
		config = parseAutoRoutingConfig({
			[AUTO_ROUTING_CONFIG_KEY]: state.config,
		});
	} catch (error) {
		throw new Error(
			`Automatic launch authorization requires a valid autoRouting configuration: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		state.status !== "enabled" ||
		config.mode === "off" ||
		autoRoutingConfigDigest(config) !== state.digest
	)
		throw new Error(
			"Automatic launch authorization requires the loaded, unmodified enabled autoRouting configuration.",
		);
	const candidate = config.candidates.find((entry) => entry.id === candidateId);
	const role =
		candidate && config.roles.find((entry) => entry.id === candidate.roleId);
	if (!candidate || !role)
		throw new Error(
			`Automatic launch authorization: candidate ${JSON.stringify(candidateId)} is not approved.`,
		);
	const authorization: AutoLaunchAuthorization = Object.freeze({
		configDigest: state.digest,
		role,
		candidate,
		harness: candidate.harness,
		model:
			candidate.model.namespace === "pi"
				? candidate.model.ref
				: candidate.model.id,
		effort: candidate.effort,
	});
	mintedAutoAuthorizations.add(authorization);
	return authorization;
}

/**
 * An automatic spawn runs exactly its approved role, resolved by ordinary
 * precedence. Its harness and model come only from a verified authorization,
 * never from spawn parameters.
 */
function autoAuthorizationRejection(
	params: Pick<Static<typeof SubagentParams>, "agent" | "harness" | "model">,
	role: ListedAgentDefinition | null,
	auto: AutoLaunchAuthorization,
): string | undefined {
	if (!mintedAutoAuthorizations.has(auto))
		return "Automatic launch authorization is not a verified administrator approval.";
	if (params.harness !== undefined || params.model !== undefined)
		return "An automatic spawn takes its harness and model only from its approved tuple.";
	const approved = auto.role;
	if (
		!role ||
		params.agent !== approved.agent ||
		role.name !== approved.agent ||
		role.source !== approved.source ||
		role.provider !== approved.provider ||
		role.providerVersion !== approved.providerVersion
	)
		return `Approved role "${approved.agent}" (${approved.provider ? `package:${approved.provider}@${approved.providerVersion}` : approved.source}) is not the role this spawn resolves.`;
	return undefined;
}

/**
 * Resolve the effective harness (explicit request → role `cli` → Pi, or a
 * verified automatic tuple) and project a named role onto it. Projection is
 * a strict validated view, not a conversion: a role's frontmatter `model`
 * belongs to the harness the role declares and is dropped when the role runs
 * elsewhere, so a pinned model requires an explicit destination model, which
 * an approved automatic tuple supplies. Native `spawn-agents` has no bounded
 * Pi equivalent and cannot be projected to Pi. The destination harness then
 * validates every remaining capability before any resource.
 */
function resolveRoleProjection(
	params: Pick<Static<typeof SubagentParams>, "agent" | "harness" | "model">,
	role: ListedAgentDefinition | null,
	auto?: AutoLaunchAuthorization,
): RoleProjection {
	const autoRejection =
		auto === undefined
			? undefined
			: autoAuthorizationRejection(params, role, auto);
	if (autoRejection)
		return {
			ok: false,
			error: "auto-authorization-invalid",
			message: autoRejection,
		};
	if (params.harness && !params.agent)
		return {
			ok: false,
			error: "harness-requires-agent",
			message:
				"harness selects the runtime for a named role and requires agent. Remove harness for a bare Pi spawn, or supply agent.",
		};
	if (params.agent && !role)
		return {
			ok: false,
			error: "agent-not-found",
			message: `Agent "${params.agent}" was not found.`,
		};
	const roleHarness: SubagentHarness | undefined = role
		? (role.cli ?? "pi")
		: undefined;
	const harness: SubagentHarness =
		auto?.harness ?? params.harness ?? role?.cli ?? "pi";
	const selection: SubagentSelection = {
		harness,
		harnessSource: auto
			? "auto"
			: params.harness
				? "request"
				: role?.cli
					? "role"
					: "default",
		projected: !!roleHarness && roleHarness !== harness,
	};
	if (!role || !roleHarness) return { ok: true, selection, agentDefs: null };
	selection.role = {
		name: role.name,
		source: role.source,
		harness: roleHarness,
	};
	if (role.provider) selection.role.provider = role.provider;
	if (role.providerVersion)
		selection.role.providerVersion = role.providerVersion;
	if (!selection.projected) return { ok: true, selection, agentDefs: role };

	// A verified automatic tuple is the administrator's explicit destination.
	if (role.model && !(auto?.model ?? params.model)?.trim())
		return {
			ok: false,
			error: "harness-switch-requires-model",
			message: `Role "${role.name}" pins model ${JSON.stringify(role.model)} for its ${roleHarness} harness; running it on ${harness} requires an explicit ${harness === "pi" ? "Pi provider/model-id" : `native ${harness} model ID`} in model. A pinned model is never reused across harnesses.`,
		};
	if (harness === "pi" && role.spawnAgents)
		return {
			ok: false,
			error: "harness-projection-unsupported",
			message: `Role "${role.name}" declares spawn-agents (native nested delegation), which has no equivalent bounded Pi policy. Run it on its ${roleHarness} harness, or use a role without spawn-agents.`,
		};
	const projected: ListedAgentDefinition = { ...role, model: undefined };
	if (harness === "pi") delete projected.cli;
	else projected.cli = harness;
	return { ok: true, selection, agentDefs: projected };
}

/** One-line model-facing disclosure of an explicitly requested harness. */
function formatSubagentSelection(selection: SubagentSelection): string {
	const role = selection.role;
	if (!role)
		return `Harness: ${selection.harness} (${selection.harnessSource}).`;
	const origin = role.provider ? `package:${role.provider}` : role.source;
	return `Harness: ${selection.harness} (${selection.harnessSource}; role ${role.name} from ${origin} declares ${role.harness}${selection.projected ? ", projected" : ""}).`;
}

function getBundledAgentsDir(): string {
	return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterLines(frontmatter: string, key: string): string[] {
	const prefix = `${key}:`;
	return frontmatter
		.split("\n")
		.filter((candidate) => candidate.startsWith(prefix));
}

function getFrontmatterValue(
	frontmatter: string,
	key: string,
): string | undefined {
	const line = getFrontmatterLines(frontmatter, key)[0];
	return line?.slice(`${key}:`.length).trim() || undefined;
}

interface CapabilityDeclarations {
	canonical: string[];
	hasNoncanonical: boolean;
}

type CapabilityField =
	| "tools"
	| "deny-tools"
	| "spawning"
	| "persistent"
	| "spawn-agents";

function isCapabilityDeclaration(
	line: string,
	field: CapabilityField,
): boolean {
	const trimmed = line.trimStart();
	const colon = trimmed.indexOf(":");
	if (colon === -1) return false;
	const key = trimmed.slice(0, colon).trim();
	return key === field || key === `"${field}"` || key === `'${field}'`;
}

function getCapabilityDeclarations(
	frontmatter: string,
	field: CapabilityField,
): CapabilityDeclarations {
	const canonicalPrefix = `${field}:`;
	const lines = frontmatter.split("\n");
	return {
		canonical: lines.filter((line) => line.startsWith(canonicalPrefix)),
		hasNoncanonical: lines.some(
			(line) =>
				isCapabilityDeclaration(line, field) &&
				!line.startsWith(canonicalPrefix),
		),
	};
}

function validateCapabilityDeclarations(
	frontmatter: string,
): string | undefined {
	for (const field of [
		"tools",
		"deny-tools",
		"spawning",
		"persistent",
		"spawn-agents",
	] as const) {
		const declarations = getCapabilityDeclarations(frontmatter, field);
		if (declarations.hasNoncanonical) {
			return `${field} must use an unquoted, unindented key written exactly as ${field}:`;
		}
		if (declarations.canonical.length > 1) {
			return `${field} may be declared only once.`;
		}
		if (declarations.canonical.length === 0) continue;

		const value = declarations.canonical[0].slice(`${field}:`.length).trim();
		if (field === "spawning" || field === "persistent") {
			if (value !== "true" && value !== "false") {
				return `${field} must be true or false.`;
			}
			continue;
		}

		if (
			!value ||
			value.startsWith("[") ||
			value.startsWith("{") ||
			value.startsWith("|") ||
			value.startsWith(">") ||
			value.includes("#") ||
			value.includes('"') ||
			value.includes("'") ||
			value.split(",").some((entry) => !entry.trim())
		) {
			return `${field} must use a non-empty comma-separated scalar; YAML lists and containers, comments and quotes are unsupported.`;
		}
	}
	return undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
	return value == null ? undefined : value === "true";
}

function parseSessionMode(
	value: string | undefined,
): SubagentSessionMode | undefined {
	if (value === "standalone" || value === "lineage-only" || value === "fork") {
		return value;
	}
	return undefined;
}

function parseAgentDefinition(
	content: string,
	fallbackName: string,
): AgentDefinition | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const frontmatter = match[1];
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");
	const thinking = getFrontmatterValue(frontmatter, "thinking");
	const cli = getFrontmatterValue(frontmatter, "cli");

	const definition: AgentDefinition = {
		name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
		description: getFrontmatterValue(frontmatter, "description"),
		model: getFrontmatterValue(frontmatter, "model"),
		tools: getFrontmatterValue(frontmatter, "tools"),
		systemPromptMode:
			systemPromptMode === "replace"
				? "replace"
				: systemPromptMode === "append"
					? "append"
					: undefined,
		skills:
			getFrontmatterValue(frontmatter, "skills") ??
			getFrontmatterValue(frontmatter, "skill"),
		thinking: thinking && isThinkingLevel(thinking) ? thinking : undefined,
		denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
		spawning: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "spawning"),
		),
		spawnAgents: getFrontmatterValue(frontmatter, "spawn-agents"),
		persistent: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "persistent"),
		),
		autoExit: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "auto-exit"),
		),
		interactive: parseOptionalBoolean(
			getFrontmatterValue(frontmatter, "interactive"),
		),
		sessionMode: parseSessionMode(
			getFrontmatterValue(frontmatter, "session-mode"),
		),
		cwd: getFrontmatterValue(frontmatter, "cwd"),
		body: body || undefined,
		disableModelInvocation:
			getFrontmatterValue(
				frontmatter,
				"disable-model-invocation",
			)?.toLowerCase() === "true",
	};
	if (isNativeHarnessName(cli)) definition.cli = cli;
	return definition;
}

function invalidCapabilityDeclarationDiagnostic(
	content: string,
	agentName: string,
	path: string,
): AgentDiagnostic | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const resolvedAgentName = getFrontmatterValue(match[1], "name") ?? agentName;
	const error = validateCapabilityDeclarations(match[1]);
	if (!error) return null;
	return {
		code: "invalid-capability-declaration",
		message: `Role "${resolvedAgentName}" has an invalid capability declaration in ${path}: ${error} Use documented comma-separated tools or deny-tools values, true or false for spawning, or omit the field.`,
		path,
		agentName: resolvedAgentName,
	};
}

/**
 * Validate `cli` frontmatter. Omitted means Pi-backed. `claude` and `kiro`
 * select a native harness whose static capabilities are checked here, so an
 * unsupported role fails closed during discovery, before any Herdr resource.
 */
function nativeCliDiagnostic(
	content: string,
	agentName: string,
	path: string,
): AgentDiagnostic | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const frontmatter = match[1];
	const cli = getFrontmatterValue(frontmatter, "cli");
	const cliModel = getFrontmatterValue(frontmatter, "cli-model");
	const resolvedAgentName =
		getFrontmatterValue(frontmatter, "name") ?? agentName;
	if (!cli && !cliModel) {
		// Pi-backed roles delegate with Pi's own tools and spawning policy.
		return getFrontmatterValue(frontmatter, "spawn-agents")
			? {
					code: "native-harness-unsupported",
					message: `Role "${resolvedAgentName}" declares spawn-agents in ${path}, which applies only to native roles (cli: claude or cli: kiro). Pi-backed roles use spawning and deny-tools.`,
					path,
					agentName: resolvedAgentName,
				}
			: null;
	}
	if (!isNativeHarnessName(cli)) {
		return {
			code: "external-cli-unsupported",
			message: cli
				? `Role "${resolvedAgentName}" requests unsupported external CLI "${cli}" in ${path}. Supported native harnesses are cli: claude and cli: kiro; omit cli (and cli-model) for a Pi-backed role that selects Claude through an authenticated Pi provider/model ID.`
				: `Role "${resolvedAgentName}" declares cli-model without cli in ${path}. Remove cli-model; Pi-backed roles use model with an authenticated Pi provider/model ID.`,
			path,
			agentName: resolvedAgentName,
		};
	}
	if (cliModel) {
		return {
			code: "native-harness-unsupported",
			message: `Role "${resolvedAgentName}" in ${path} uses cli-model, which is not supported. Put the native ${cli} model ID in model instead.`,
			path,
			agentName: resolvedAgentName,
		};
	}
	const parsed = parseAgentDefinition(content, agentName);
	if (!parsed) return null;
	try {
		resolveNativeLaunchSpec({
			...toNativeRoleDefinition({ ...parsed, cli }),
			thinking: getFrontmatterValue(frontmatter, "thinking"),
			sessionMode:
				getFrontmatterValue(frontmatter, "session-mode") ?? parsed.sessionMode,
		});
	} catch (error) {
		return {
			code: "native-harness-unsupported",
			message: `${error instanceof Error ? error.message : String(error)} (${path})`,
			path,
			agentName: resolvedAgentName,
		};
	}
	return null;
}

function toNativeRoleDefinition(
	agent: AgentDefaults & { name: string; cli: NativeHarnessName },
): NativeRoleDefinition {
	return {
		name: agent.name,
		cli: agent.cli,
		model: agent.model,
		tools: agent.tools,
		skills: agent.skills,
		thinking: agent.thinking,
		spawning: agent.spawning,
		spawnAgents: agent.spawnAgents,
		persistent: agent.persistent,
		autoExit: agent.autoExit,
		interactive: agent.interactive,
		sessionMode: agent.sessionMode,
		systemPromptMode: agent.systemPromptMode,
		body: agent.body,
	};
}

function listMarkdownFiles(path: string): string[] {
	const stat = statSync(path);
	if (stat.isFile()) return path.endsWith(".md") ? [path] : [];
	if (!stat.isDirectory()) return [];
	return readdirSync(path)
		.filter((entry) => entry.endsWith(".md"))
		.sort((left, right) => left.localeCompare(right))
		.map((entry) => join(path, entry));
}

interface PackageMetadata {
	provider?: string;
	providerVersion?: string;
}

function findPackageMetadata(path: string): PackageMetadata {
	let current = statSync(path).isDirectory() ? path : dirname(path);
	while (true) {
		const packagePath = join(current, "package.json");
		if (existsSync(packagePath)) {
			try {
				const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
				return {
					provider: isString(pkg.name) ? pkg.name : undefined,
					providerVersion: isString(pkg.version) ? pkg.version : undefined,
				};
			} catch {
				return {};
			}
		}
		const parent = dirname(current);
		if (parent === current) return {};
		current = parent;
	}
}

interface RolePackDiscoveryResult {
	paths: string[];
	diagnostics: AgentDiagnostic[];
}

function discoverRolePackPaths(
	pi?: Pick<ExtensionAPI, "events">,
): RolePackDiscoveryResult {
	const paths = new Set<string>();
	const diagnostics: AgentDiagnostic[] = [];
	if (!pi?.events) return { paths: [], diagnostics };

	try {
		pi.events.emit(ROLE_PACK_DISCOVERY_EVENT, {
			apiVersion: 1,
			register(path: any) {
				if (!isString(path) || !isAbsolute(path)) {
					diagnostics.push({
						code: "invalid-role-pack-path",
						message:
							"Role packs must register an absolute file or directory path.",
					});
					return;
				}
				paths.add(resolve(path));
			},
		});
	} catch (error) {
		diagnostics.push({
			code: "role-pack-discovery-failed",
			message: `Role-pack discovery failed: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	return { paths: [...paths], diagnostics };
}

/**
 * The role names a definition without valid frontmatter may have meant to
 * override: its file name, and any `name:` in a CRLF, BOM-prefixed, or
 * unterminated frontmatter block.
 */
function malformedRoleNames(content: string, fallbackName: string): string[] {
	const block = content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.match(/^---\n([\s\S]*?)(?:\n---|$)/);
	const name = block ? getFrontmatterValue(block[1], "name") : undefined;
	return name && name !== fallbackName ? [fallbackName, name] : [fallbackName];
}

/**
 * Discover roles by precedence (package < global < project). When `failures`
 * is supplied, every per-role failure is also recorded there with its layer;
 * the returned catalog is identical either way.
 */
function discoverAgentCatalog(
	pi?: Pick<ExtensionAPI, "events">,
	roleConfig: RoleConfig = bundledRoleConfig,
	failures?: AgentLayerFailure[],
): AgentCatalog {
	const agents = new Map<string, ListedAgentDefinition>();
	const diagnostics: AgentDiagnostic[] = [];
	// Diagnostics are recorded per layer after each layer is discovered.
	let recorded = 0;
	const recordLayer = (source: AgentSource) => {
		for (const diagnostic of diagnostics.slice(recorded))
			if (diagnostic.agentName)
				failures?.push({
					agentName: diagnostic.agentName,
					source,
					code: diagnostic.code,
				});
		recorded = diagnostics.length;
	};

	const addDirectory = (path: string, source: AgentSource) => {
		if (!existsSync(path)) return;
		for (const filePath of listMarkdownFiles(path)) {
			const fallbackName = basename(filePath, ".md");
			const content = readFileSync(filePath, "utf8");
			const capabilityDiagnostic = invalidCapabilityDeclarationDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (capabilityDiagnostic) {
				diagnostics.push(capabilityDiagnostic);
				agents.delete(capabilityDiagnostic.agentName ?? fallbackName);
				continue;
			}
			const cliDiagnostic = nativeCliDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (cliDiagnostic) {
				diagnostics.push(cliDiagnostic);
				agents.delete(cliDiagnostic.agentName ?? fallbackName);
				continue;
			}
			const parsed = parseAgentDefinition(content, fallbackName);
			if (parsed)
				agents.set(parsed.name, { ...parsed, source, path: filePath });
			// Ordinary discovery skips it; automatic routing never lets a
			// lower-precedence definition stand in for a failed override.
			else
				for (const agentName of malformedRoleNames(content, fallbackName))
					failures?.push({
						agentName,
						source,
						code: "invalid-role-definition",
					});
		}
	};

	if (roleConfig.bundled) addDirectory(getBundledAgentsDir(), "package");

	const discovered = discoverRolePackPaths(pi);
	diagnostics.push(...discovered.diagnostics);
	const contributed = new Map<string, ListedAgentDefinition[]>();
	for (const registeredPath of discovered.paths) {
		if (!existsSync(registeredPath)) {
			diagnostics.push({
				code: "missing-role-pack-path",
				message: `Registered role-pack path does not exist: ${registeredPath}`,
				path: registeredPath,
			});
			continue;
		}

		let metadata: ReturnType<typeof findPackageMetadata>;
		let roleFiles: string[];
		try {
			metadata = findPackageMetadata(registeredPath);
			roleFiles = listMarkdownFiles(registeredPath);
		} catch (error) {
			diagnostics.push({
				code: "unreadable-role-pack-path",
				message: `Cannot read registered role-pack path ${registeredPath}: ${error instanceof Error ? error.message : String(error)}`,
				path: registeredPath,
			});
			continue;
		}
		if (roleFiles.length === 0 && statSync(registeredPath).isFile()) {
			diagnostics.push({
				code: "invalid-role-pack-file",
				message: `Registered role-pack file must use the .md extension: ${registeredPath}`,
				path: registeredPath,
				provider: metadata.provider,
			});
			continue;
		}

		for (const filePath of roleFiles) {
			const fallbackName = basename(filePath, ".md");
			let content: string;
			try {
				content = readFileSync(filePath, "utf8");
			} catch (error) {
				diagnostics.push({
					code: "unreadable-role-definition",
					message: `Cannot read role definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
					path: filePath,
					agentName: fallbackName,
					provider: metadata.provider,
				});
				continue;
			}
			const capabilityDiagnostic = invalidCapabilityDeclarationDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (capabilityDiagnostic) {
				diagnostics.push({
					...capabilityDiagnostic,
					provider: metadata.provider,
				});
				continue;
			}
			const cliDiagnostic = nativeCliDiagnostic(
				content,
				fallbackName,
				filePath,
			);
			if (cliDiagnostic) {
				diagnostics.push({ ...cliDiagnostic, provider: metadata.provider });
				continue;
			}
			const parsed = parseAgentDefinition(content, fallbackName);
			if (!parsed) {
				diagnostics.push({
					code: "invalid-role-definition",
					message: `Role definition must start with frontmatter: ${filePath}`,
					path: filePath,
					agentName: fallbackName,
					provider: metadata.provider,
				});
				continue;
			}
			if (parsed.name !== fallbackName) {
				diagnostics.push({
					code: "role-name-mismatch",
					message: `Role name "${parsed.name}" must match filename "${fallbackName}" in ${filePath}`,
					path: filePath,
					agentName: fallbackName,
					provider: metadata.provider,
				});
				continue;
			}
			if (!parsed.description) {
				diagnostics.push({
					code: "missing-role-description",
					message: `Role "${parsed.name}" must declare a description in ${filePath}`,
					path: filePath,
					agentName: parsed.name,
					provider: metadata.provider,
				});
				continue;
			}
			const definitions = contributed.get(parsed.name) ?? [];
			definitions.push({
				...parsed,
				source: "package",
				path: filePath,
				...metadata,
			});
			contributed.set(parsed.name, definitions);
		}
	}

	for (const [name, definitions] of contributed) {
		if (agents.has(name)) {
			diagnostics.push({
				code: "bundled-role-collision",
				message: `Role pack cannot replace bundled role "${name}"; use a global or project override instead.`,
				agentName: name,
			});
			continue;
		}
		if (definitions.length > 1) {
			const providers = definitions
				.map((definition) => definition.provider ?? definition.path)
				.sort((left, right) => left.localeCompare(right))
				.join(", ");
			diagnostics.push({
				code: "duplicate-package-role",
				message: `Role "${name}" is contributed by multiple role packs: ${providers}`,
				agentName: name,
			});
			continue;
		}
		agents.set(name, definitions[0]);
	}
	recordLayer("package");

	addDirectory(join(getAgentConfigDir(), "agents"), "global");
	recordLayer("global");
	addDirectory(join(process.cwd(), ".pi", "agents"), "project");
	recordLayer("project");

	return { agents: [...agents.values()], diagnostics };
}

function discoverAgentDefinitions(
	pi?: Pick<ExtensionAPI, "events">,
): ListedAgentDefinition[] {
	return discoverAgentCatalog(pi).agents;
}

function formatAgentSource(agent: ListedAgentDefinition): string {
	return agent.source === "package" && agent.provider
		? `package:${agent.provider}`
		: agent.source;
}

function formatVisibleAgentDefinitions(
	agents: ListedAgentDefinition[],
): string[] {
	return agents
		.filter((agent) => !agent.disableModelInvocation)
		.map((agent) => {
			const badge = ` (${formatAgentSource(agent)})`;
			const desc = agent.description ? ` — ${agent.description}` : "";
			const model = agent.model ? ` [${agent.model}]` : "";
			const harness = agent.cli ? ` [cli: ${agent.cli}]` : "";
			return `• ${agent.name}${badge}${harness}${model}${desc}`;
		});
}

function formatLivePersistentSpecialists(): string[] {
	const specialists = Array.from(runningSubagents.values()).filter(
		(running) => running.persistent,
	);
	if (specialists.length === 0) return [];
	return [
		"Live persistent specialists:",
		...specialists.map((running) => {
			const allowlist = running.policyTools?.join(",") ?? "unrestricted";
			return `• ${running.name} | ${running.logicalId} | ${running.generationId} | ${running.agent ?? "bare"} | ${persistentSpecialistState(running)} | ${running.tasksCompleted ?? 0} completed | tools: ${allowlist}; denied: ${running.policyDeniedTools?.join(",") || "none"}; persistent: true`;
		}),
	];
}

function formatSupervisionDiagnostics(): string[] {
	const diagnostics = runtime.supervision?.diagnostics() ?? {
		mode: supervisionConfig.forcePolling ? "polling(forced)" : "wake+batch",
		watcherCount: 0,
	};
	return [
		`Supervision: ${diagnostics.mode}; ${diagnostics.watcherCount} watcher${diagnostics.watcherCount === 1 ? "" : "s"}`,
	];
}

function formatAgentDiagnostics(diagnostics: AgentDiagnostic[]): string[] {
	return diagnostics.map((diagnostic) => `! ${diagnostic.message}`);
}

function resolveEffectiveSessionMode(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	if (params.fork === true) return "fork";
	if (params.fork === false) return "standalone";
	return agentDefs?.sessionMode ?? "standalone";
}

interface LaunchBehavior {
	sessionMode: SubagentSessionMode;
	seededSessionMode: "lineage-only" | "fork" | null;
	inheritsConversationContext: boolean;
	taskDelivery: "direct" | "artifact";
}

function resolveLaunchBehavior(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): LaunchBehavior {
	const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
	const inheritsConversationContext = sessionMode === "fork";
	return {
		sessionMode,
		seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
		inheritsConversationContext,
		taskDelivery: inheritsConversationContext ? "direct" : "artifact",
	};
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectivePersistent(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	return params.persistent ?? agentDefs?.persistent ?? false;
}

function resolveEffectiveAutoExit(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	if (resolveEffectivePersistent(params, agentDefs)) return false;
	// Named agents preserve their declared behavior. Bare tool calls are
	// autonomous by default, including full-context forks: `fork` controls
	// context inheritance, not whether the child should remain open. Interactive
	// flows such as /iterate opt out explicitly with `interactive: true`.
	if (agentDefs) return agentDefs.autoExit ?? false;
	return params.interactive !== true;
}

function resolveEffectiveInteractive(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults | null,
): boolean {
	if (params.interactive != null) return params.interactive;
	if (resolveEffectivePersistent(params, agentDefs)) return false;
	if (agentDefs?.interactive != null) return agentDefs.interactive;
	return !resolveEffectiveAutoExit(params, agentDefs);
}

function loadAgentDefaults(
	agentName: string,
	pi?: Pick<ExtensionAPI, "events">,
	roleConfig?: RoleConfig,
): ListedAgentDefinition | null {
	return (
		discoverAgentCatalog(pi, roleConfig).agents.find(
			(agent) => agent.name === agentName,
		) ?? null
	);
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

function muxUnavailableResult() {
	return {
		content: [
			{
				type: "text" as const,
				text: `Subagents require herdr. ${terminalSetupHint()}`,
			},
		],
		details: { error: "herdr not available" },
	};
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
	return join(sessionDir, "artifacts", sessionId);
}

function shouldRetainSubagentSurface(
	running: Pick<RunningSubagent, "worktree"> | { worktree?: unknown },
): boolean {
	return !!running.worktree;
}

const BUNDLED_WORKTREE_WARNINGS = {
	scout:
		"The bundled scout role is read-only and normally does not need a new worktree. " +
		"Use an ordinary pane instead; to inspect an existing worker result, start it in the retained worktree path. " +
		"Herdr worktree workspaces persist until explicitly removed.",
	reviewer:
		"The bundled reviewer role is read-only and normally does not need a new worktree. " +
		"Use an ordinary pane instead; to review an existing worker result, start it in the retained worktree path. " +
		"Herdr worktree workspaces persist until explicitly removed.",
	"adversarial-reviewer":
		"The bundled adversarial-reviewer coordinates read-only reviewers and does not write artifacts in the reviewed checkout. " +
		"It normally uses an ordinary pane, not a new worktree. " +
		"Herdr worktree workspaces persist until explicitly removed.",
} satisfies Readonly<Record<string, string>>;

function resolveWorktreeLaunchWarning(
	params: Pick<Static<typeof SubagentParams>, "agent" | "worktree">,
	pi?: Pick<ExtensionAPI, "events">,
	roleConfig?: RoleConfig,
): string | undefined {
	if (!params.worktree || !params.agent) return undefined;
	const warning = Object.entries(BUNDLED_WORKTREE_WARNINGS).find(
		([agent]) => agent === params.agent,
	)?.[1];
	const definition = loadAgentDefaults(params.agent, pi, roleConfig);
	return warning && dirname(definition?.path ?? "") === getBundledAgentsDir()
		? warning
		: undefined;
}

function finalizeSubagentWorktree(
	running: RunningSubagent,
	state: "ready_for_review" | "failed" | "needs_help",
): WorktreeHandoff | undefined {
	if (running.worktree) {
		let handoff = captureWorktreeHandoff(running.worktree);
		try {
			persistWorktreeResult(running.worktree, state, handoff);
		} catch (error: any) {
			handoff = {
				...handoff,
				gitError: [
					handoff.gitError,
					`Manifest update failed: ${error?.message ?? String(error)}`,
				]
					.filter(Boolean)
					.join("; "),
			};
		}
		return handoff;
	}

	return undefined;
}

function terminalReady(): boolean {
	return runtime.nativeTestSeam?.terminalAvailable ?? isTerminalAvailable();
}

function closeCompletedPanes(panes: Iterable<string>): void {
	const close = runtime.nativeTestSeam?.operations?.closePane ?? closePane;
	for (const pane of panes) {
		try {
			close(pane);
		} catch {
			/* Result delivery remains authoritative. */
		}
	}
}

const statusConfig = loadStatusConfig();
const modelConfig = loadModelConfig();
const bundledRoleConfig = loadRoleConfig();
const persistentConfig = loadPersistentConfig();
const supervisionConfig = loadSupervisionConfig();

const MAX_RESULT_PRESENTATION_CHARS = 16_000;
const MAX_SESSION_REFERENCE_CHARS = 10_000;
const RESULT_CONTINUATION_PROMPT =
	"Parent action: Continue the parent task using this result; do not return an empty response.";

function abbreviateMiddle(
	value: string,
	maxChars: number,
	marker: string,
): string {
	if (value.length <= maxChars) return value;

	const retainedChars = maxChars - marker.length;
	const headChars = Math.ceil(retainedChars / 2);
	const tailChars = Math.floor(retainedChars / 2);
	return (
		value.slice(0, headChars) +
		marker +
		(tailChars ? value.slice(-tailChars) : "")
	);
}

function boundResultPresentation(body: string, sessionRef: string): string {
	const boundedSessionRef = abbreviateMiddle(
		sessionRef,
		MAX_SESSION_REFERENCE_CHARS,
		"\n[... session reference abbreviated ...]\n",
	);
	if (body.length + boundedSessionRef.length <= MAX_RESULT_PRESENTATION_CHARS) {
		return body + boundedSessionRef;
	}

	const marker = boundedSessionRef
		? "\n\n[... result abbreviated; full output remains in the child session below ...]\n\n"
		: "\n\n[... result abbreviated ...]\n\n";
	const retainedChars =
		MAX_RESULT_PRESENTATION_CHARS - marker.length - boundedSessionRef.length;
	return (
		abbreviateMiddle(body, retainedChars + marker.length, marker) +
		boundedSessionRef
	);
}

function formatSessionReference(sessionFile?: string): string {
	return sessionFile
		? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}`
		: "";
}

interface NativeTurnRecord {
	id: string;
	kind: string;
	outcome: string;
	error?: string;
}

interface NativeResultReference {
	harness: NativeHarnessName;
	sessionId?: string;
	markerFile: string;
	/** `unconfirmed`: an owned native process may still be running. */
	processExit: "confirmed" | "unconfirmed";
	/** Owned files and surfaces retained while exit is unconfirmed. */
	retained?: string[];
	/** Herdr pane of a run whose exit is unconfirmed (retained). */
	surface?: string;
	warning?: string;
	mode?: "autonomous" | "interactive" | "persistent";
	model?: string | null;
	/** Whether subagent_resume may reopen this native session. */
	resume?: { available: true } | { available: false; reason: string };
	/** Every orchestrator-tagged turn in order. */
	turns?: NativeTurnRecord[];
	interrupted?: boolean;
	/** Human-driven turns are disclosed, never presented as the task result. */
	humanTurns?: number;
	lastHumanSummary?: string;
	nested?: Array<{ name: string; agent: string; outcome: string }>;
}

const MAX_HUMAN_SUMMARY_CHARS = 2_000;

function formatNativeSessionReference(native: NativeResultReference): string {
	let text =
		`\n\nNative harness: ${nativeHarnessLabel(native.harness)} (cli: ${native.harness})` +
		`\nNative session: ${native.sessionId ?? "unknown"}` +
		`\nNative marker: ${native.markerFile}`;
	if (native.turns?.length)
		text += `\nNative turns: ${native.turns
			.map(
				(turn) =>
					`${turn.kind}${turn.kind === "initial" || turn.kind === "resume" ? "" : ` ${turn.id}`}=${turn.outcome}`,
			)
			.join(", ")}`;
	if (native.nested?.length)
		text += `\nNested subagents: ${native.nested
			.map((child) => `${child.name} (${child.agent})=${child.outcome}`)
			.join(", ")}`;
	if (native.humanTurns) {
		text += `\nHuman-driven turns: ${native.humanTurns} (not part of the orchestrator's result)`;
		if (native.lastHumanSummary)
			text += `\nLast human-driven turn text (disclosure only, not a task result): ${abbreviateMiddle(native.lastHumanSummary, MAX_HUMAN_SUMMARY_CHARS, " [...] ")}`;
	}
	if (native.resume?.available)
		text += `\nResume: subagent_resume({ sessionPath: ${JSON.stringify(native.markerFile)}, message: "<next task>" })`;
	else
		text += `\nNative resume unavailable: ${native.resume?.reason ?? "spawn a new subagent for further work"}.`;
	if (native.warning) text += `\nWarning: ${native.warning}`;
	if (native.surface) text += `\nNative pane: ${native.surface}`;
	if (native.retained?.length)
		text += `\nRetained for inspection: ${native.retained.join(", ")}`;
	return text;
}

function resolveUnexpectedErrorPresentation(
	prefix: string,
	error: any,
	sessionFile?: string,
): string {
	const message = error instanceof Error ? error.message : String(error);
	return boundResultPresentation(
		`${prefix}: ${message}`,
		formatSessionReference(sessionFile),
	);
}

interface ModelFailure {
	model: string;
	error: string;
}

interface SubagentResultDetails {
	name: string;
	task?: string;
	agent?: string;
	exitCode?: number;
	elapsed?: number;
	sessionFile?: string;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	error?: string;
	errorMessage?: string;
	fallbackAttempts?: string[];
	fallbackFailures?: ModelFailure[];
	worktree?: WorktreeHandoff;
	runtimePlan?: ResolvedRuntimePlan;
	native?: NativeResultReference;
	/** Effective harness selection and role provenance (fresh spawns). */
	selection?: SubagentSelection;
	/** Canonical origin of the model and thinking (fresh spawns). */
	runtimeProvenance?: RuntimeProvenance;
	/** Decision-only correlation of an automatic spawn; never identity. */
	autoRouting?: AutoRunReceipt;
}

interface SubagentPingDetails {
	name: string;
	message: string;
	agent?: string;
	sessionFile: string;
	worktree?: WorktreeHandoff;
	selection?: SubagentSelection;
	runtimeProvenance?: RuntimeProvenance;
	autoRouting?: AutoRunReceipt;
}

interface SubagentStartedDetails {
	id: string;
	name: string;
	task: string;
	agent?: string;
	sessionFile: string;
	launchScriptFile?: string;
	model?: string;
	thinking?: ThinkingLevel;
	runtimePlan?: ResolvedRuntimePlan;
	worktree?: WorktreeLaunch;
	warning?: string;
	harness?: NativeHarnessName;
	nativeThinking?: string;
	nativeModels?: string[];
	nativeMode?: "autonomous" | "interactive" | "persistent";
	/** Effective harness selection and role provenance. */
	selection?: SubagentSelection;
	/** Canonical origin of the model and thinking, for every harness. */
	runtimeProvenance?: RuntimeProvenance;
	/** Decision-only correlation of an automatic spawn; never identity. */
	autoRouting?: AutoRunReceipt;
	status: "started";
}

interface PartialWorktreeArgs {
	branch?: unknown;
}

interface PartialSubagentArgs {
	name?: unknown;
	task?: unknown;
	agent?: unknown;
	cwd?: unknown;
	worktree?: PartialWorktreeArgs | null;
}

function sendSubagentResult(
	api: Pick<ExtensionAPI, "sendMessage">,
	content: string,
	details: SubagentResultDetails,
): void {
	const resultContent = boundResultPresentation(content, "");
	const promptContent = boundResultPresentation(
		`${resultContent}\n\n${RESULT_CONTINUATION_PROMPT}`,
		"",
	);
	api.sendMessage(
		{
			customType: "subagent_result",
			content: promptContent,
			display: true,
			details: { ...details, resultContent },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function formatWorktreeHandoff(worktree: WorktreeHandoff): string {
	const state = worktree.gitError
		? "inspection unknown"
		: worktree.conflicted
			? "conflicted"
			: worktree.clean
				? "clean"
				: "dirty";
	const ahead =
		worktree.commitsAhead == null
			? "commits ahead unknown"
			: `${worktree.commitsAhead} commit${worktree.commitsAhead === 1 ? "" : "s"} ahead`;
	const lines = [
		"Worktree result retained for review:",
		`Worktree: ${worktree.path}`,
		`Workspace: ${worktree.workspaceId}`,
		`Branch: ${worktree.branch}`,
		`Base/head: ${worktree.baseSha} -> ${worktree.headSha ?? "unknown"}`,
		`State: ${state} · ${ahead}`,
	];
	if (worktree.changedFiles?.length)
		lines.push(`Changed: ${worktree.changedFiles.join(", ")}`);
	if (worktree.untrackedFiles?.length)
		lines.push(`Untracked: ${worktree.untrackedFiles.join(", ")}`);
	if (worktree.gitError)
		lines.push(`Git inspection warning: ${worktree.gitError}`);
	lines.push(
		"After review and preservation, explicitly remove (branch retained):",
		`  /worktree remove ${worktree.workspaceId}`,
		`  worktree_remove({ target: ${JSON.stringify(worktree.path)} })`,
		"Operator override after independent safety checks:",
		`  herdr worktree remove --workspace ${worktree.workspaceId}`,
	);
	return lines.join("\n");
}

function resolveResultPresentation(
	result: Pick<
		SubagentResult,
		| "exitCode"
		| "elapsed"
		| "summary"
		| "sessionFile"
		| "errorMessage"
		| "fallbackAttempts"
		| "fallbackFailures"
		| "runtimePlan"
		| "worktree"
		| "native"
	>,
	name: string,
	runtimeMismatch?: string,
	selection?: SubagentSelection,
): string {
	const sessionRef = result.native
		? formatNativeSessionReference(result.native)
		: formatSessionReference(result.sessionFile);
	let body: string;
	const attempted = result.fallbackAttempts ?? [];
	const requestedModel =
		attempted[0] ??
		result.runtimePlan?.requestedModel ??
		result.runtimePlan?.model;
	const usedModel =
		result.runtimePlan?.observed?.model ??
		result.runtimePlan?.model ??
		(result.native && result.native.model !== undefined
			? (result.native.model ?? "(native CLI default)")
			: undefined);

	if (result.errorMessage && result.native) {
		// Native completion failed closed: no correlated turn evidence plus exit.
		const next = result.native.resume?.available
			? "resume the native session with subagent_resume (it restores the recorded loadout exactly), or spawn a new subagent"
			: "spawn a new subagent";
		body =
			`Sub-agent "${name}" ${result.native.interrupted ? "was interrupted" : "failed"} after ${formatElapsed(result.elapsed)} ` +
			`(native ${nativeHarnessLabel(result.native.harness)} harness).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a verified result. Next action: inspect the ` +
			`native marker and pane evidence, resolve the cause, and ${next}.`;
	} else if (result.errorMessage) {
		// Pi owns provider retry policy and exposes the settled error as text. Do
		// not infer retry counts or permanence from that text; preserve it as-is.
		body =
			`Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
			`(provider/agent error).\n\n` +
			`Error: ${result.errorMessage}\n\n` +
			`The subagent did not produce a result. Next action: check the raw ` +
			`provider reason and verify model access for this account. Spawn a new ` +
			`subagent with a supported model or configured fallback; use ` +
			`subagent_resume only after resolving access for this session's stored ` +
			`model because resume does not select a model.`;
	} else {
		body =
			result.exitCode === 0
				? `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}`
				: `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}`;
	}

	// An automatic choice is an approved tuple, never a caller's request.
	const requestedLabel =
		selection?.harnessSource === "auto"
			? "Automatically selected model"
			: "Requested model";
	if (requestedModel) body += `\n\n${requestedLabel}: ${requestedModel}`;
	if (attempted.length > 1)
		body += `\nModels attempted: ${attempted.join(", ")}`;
	if (usedModel) body += `\nModel used: ${usedModel}`;
	if (result.fallbackFailures?.length) {
		body +=
			"\nModel failures (raw errors, in attempt order):" +
			result.fallbackFailures
				.map(({ model, error }) => `\n- ${model}: ${error}`)
				.join("");
	}
	if (result.worktree) body += `\n\n${formatWorktreeHandoff(result.worktree)}`;
	const runtimeWarning = runtimeMismatch
		? `\n\nRuntime warning: ${runtimeMismatch}`
		: "";
	return boundResultPresentation(body, sessionRef + runtimeWarning);
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
	name: string;
	task: string;
	summary: string;
	sessionFile?: string;
	exitCode: number;
	elapsed: number;
	error?: string;
	/** Settled provider/agent error text from the child, preserved verbatim. */
	errorMessage?: string;
	/** Ordered models launched for this run, including failed fallback attempts. */
	fallbackAttempts?: string[];
	/** Ordered raw errors associated with failed model attempts. */
	fallbackFailures?: ModelFailure[];
	ping?: { name: string; message: string };
	worktree?: WorktreeHandoff;
	runtimePlan?: ResolvedRuntimePlan;
	native?: NativeResultReference;
	/** Correlated native turn outcome, used for fallback eligibility. */
	nativeOutcome?: NativeRunOutcome;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile?: string;
	activityFile?: string;
	activity?: SubagentActivityState;
	activityRead?: {
		ok: boolean;
		reason?: "missing" | "invalid" | "wrong-id";
		error?: string;
	};
	abortController?: AbortController;
	/**
	 * Optional legacy status snapshot retained only for hydrating pre-lifecycle
	 * runtime entries after /reload. Live observation uses `lifecycle` only.
	 */
	statusState?: SubagentStatusState;
	lifecycle: SubagentLifecycle;
	/** Last projected kind used to detect stalled/recovered transitions. */
	lastProjectedKind?: LifecycleProjection["kind"];
	/** One active no-progress warning episode, reset when durable progress resumes. */
	noProgressEpisode?: {
		active: true;
		progressAt: number;
		idleMs: number;
		classification: NoProgressClassification;
		lastEntryKind: NoProgressSessionTail["lastEntryKind"];
	};
	/**
	 * When true, status transitions (stalled/recovered) do not wake the parent
	 * session via a steer message. The widget still updates locally. Used for
	 * long-running agents where the user drives the conversation in the
	 * subagent's pane (e.g. planner).
	 */
	interactive: boolean;
	/** Parent-resolved model/thinking selection and provenance. */
	runtimePlan: ResolvedRuntimePlan | undefined;
	/**
	 * Effective harness selection, fixed at the fresh spawn and copied to
	 * every fallback attempt; absent for resumed sessions.
	 */
	selection?: SubagentSelection;
	/**
	 * Canonical origin of the model and thinking for every harness, fixed
	 * with the selection; absent for resumed sessions.
	 */
	runtimeProvenance?: RuntimeProvenance;
	/**
	 * Decision-only correlation of an automatic spawn, fixed with the
	 * selection and copied to every attempt; never a submission identity.
	 */
	autoRouting?: AutoRunReceipt;
	worktree?: WorktreeLaunch;
	persistent?: boolean;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	policyTools?: string[] | null;
	policyDeniedTools?: string[];
	tasksCompleted?: number;
	taskId?: string;
	inboxSequence?: number;
	observedTaskEvents?: number;
	stopState?: "requested" | "pending" | "failed";
	stopFailure?: string;
	/** The durable `stopped` ledger entry was attempted (never twice). */
	stopRecorded?: boolean;
	stopTimeout?: ReturnType<typeof setTimeout>;
	stopTimeoutMs?: number;
	crashNotified?: boolean;
	supervisionRegistration?: SupervisionRegistration;
	/** Native harness run; absent for Pi-backed children. */
	native?: NativeRun;
	/** Launch context a native child needs to serve nested-spawn requests. */
	nativeDelegation?: NativeDelegation;
	/** Set when this child was launched for a native child's bridge request. */
	nestedOf?: NestedOrigin;
	/** A native resume opened this ordinary pane; close it after delivery. */
	resumedNative?: boolean;
	/** Keep the durable worktree lease at settlement for a fallback handoff. */
	nativeHoldWorktreeLease?: boolean;
	/** Why the first task's durable dispatch record could not be committed. */
	dispatchWarning?: string;
	/**
	 * Persistent native tasks this parent settled from correlated receipts,
	 * in order and unique by task ID: the only source of task deliveries.
	 */
	nativeSettledTasks?: NativeSettledTask[];
	/** Persistent native tasks already delivered in this process. */
	nativeDeliveredTasks?: Set<string>;
}

interface NativeDelegation {
	ctx: Parameters<typeof launchSubagent>[1];
	parentThinking: ThinkingLevel;
	/** Pi-vocabulary tool ceiling for nested children. */
	tools: Set<string>;
	agents: string[];
	cwd: string;
	children: Map<string, { name: string; agent: string; outcome: string }>;
	total: number;
	queue: Promise<void>;
}

interface NestedOrigin {
	requesterId: string;
	requesterName: string;
	nonce: string;
	agent: string;
	name: string;
}

/** A native run whose owned process exit could not be confirmed. */
interface UnresolvedNativeRun {
	run: NativeRun;
	worktreePath?: string;
	/**
	 * Ordinary pane this parent created for an autonomous run whose result
	 * the parent accepted; closed once exit is confirmed late.
	 */
	closePaneOnExit?: string;
}

/**
 * Offline test seam for native launches: fixture CLIs, fake Herdr surfaces,
 * and shorter deadlines. Never set outside tests.
 */
interface NativeTestSeam {
	operations?: PiLaunchOperations;
	nativeOperations?: NativeHarnessOperations;
	watch?: Partial<NativeWatchDependencies>;
	terminalAvailable?: boolean;
	interruptGraceMs?: number;
	/** Runs between native fallback attempts, before the next launch. */
	onFallbackTransition?: (previous: RunningSubagent) => void | Promise<void>;
	/** Retry interval for final persistent task delivery. */
	deliveryRetryMs?: number;
	/** Final persistent delivery attempts before the notice carries results. */
	deliveryAttempts?: number;
	/** First delay of the late native exit re-check. */
	lateExitRecheckMs?: number;
	/** Replaces Herdr/session supervision of Pi-backed children. */
	piWatch?: (
		running: RunningSubagent,
		signal: AbortSignal,
	) => Promise<SubagentResult>;
}

interface SubagentRuntime {
	nativeTestSeam?: NativeTestSeam;
	runningSubagents: Map<string, RunningSubagent>;
	/** Retained until exit is confirmed; blocks cleanup of their worktrees. */
	unresolvedNativeRuns?: Map<string, UnresolvedNativeRun>;
	/** Pending re-check of unresolved runs that retain a closable pane. */
	lateExitRecheck?: ReturnType<typeof setTimeout>;
	/** Unresolved runs a re-check released before any pane was marked. */
	lateReleasedNativeRuns?: WeakSet<NativeRun>;
	/** Aborted by a non-preserving parent shutdown: in-flight native launches. */
	nativeLaunchAbort?: AbortController;
	/** Persistent first tasks planned in the ledger whose launch is in flight. */
	plannedNativeDispatches?: Set<string>;
	supervision?: SupervisionCoordinator;
	pi?: ExtensionAPI;
	latestCtx?: ExtensionContext;
	modelCatalog?: string;
	/** Automatic-routing work dispatched or possibly dispatched; kept busy. */
	autoRoutingRetained?: AutoRetainedWork;
	/** Automatic decisions this process resolved; recovery defers to them. */
	autoRoutingResolved?: Set<string>;
}

function createSubagentRuntime(): SubagentRuntime {
	return {
		runningSubagents: new Map<string, RunningSubagent>(),
	};
}

/** Runtime state preserved across /reload. */
const runtime: SubagentRuntime =
	readGlobalSlot<SubagentRuntime>(RUNTIME_KEY) ?? createSubagentRuntime();
writeGlobalSlot(RUNTIME_KEY, runtime);
const runningSubagents = runtime.runningSubagents;

export function shouldPreserveSubagentsOnShutdown(
	reason: SessionShutdownEvent["reason"] | undefined,
): boolean {
	return (
		reason === "reload" ||
		reason === "new" ||
		reason === "resume" ||
		reason === "fork"
	);
}

export function cleanupSubagentsForShutdown(
	reason: SessionShutdownEvent["reason"] | undefined,
	agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
	if (shouldPreserveSubagentsOnShutdown(reason)) return;

	for (const agent of agents.values()) {
		if (agent.lifecycle) {
			agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
		}
		agent.abortController?.abort();
	}
	agents.clear();
}

export function shouldDeliverSubagentCompletion(
	running: Pick<RunningSubagent, "lifecycle">,
): boolean {
	// Authoritative gate: only pending deliveries may be sent.
	// Missing lifecycle (pre-migration fixtures) defaults to pending/true.
	return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
	return current ?? previous;
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
	const seconds = Math.floor((endTime - startTime) / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(
	left: string,
	right: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}│${RST}`;

	// width = total visible chars for the whole line including │ and │
	const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
	const rightVis = visibleWidth(right);

	// If the status chunk alone is too wide, prefer preserving it in compact form
	// rather than overflowing the terminal.
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
	}

	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(
	title: string,
	info: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╭${RST}`;

	// ╭─ Title ───...─── info ─╮
	// overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
	const inner = Math.max(0, width - 2); // inside ╭ and ╮
	const titlePart = `─ ${title} `;
	const infoPart = ` ${info} ─`;
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`
		.slice(0, inner)
		.padEnd(inner, "─");
	return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╰${RST}`;

	const inner = Math.max(0, width - 2);
	return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
	projection: ReturnType<typeof projectLifecycle>,
	now: number,
): string {
	const duration =
		projection.stateDurationSince == null
			? ""
			: ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
	if (projection.kind === "active")
		return projection.label
			? ` active · ${projection.label}${duration} `
			: ` active${duration} `;
	if (projection.kind === "blocked") return ` blocked${duration} `;
	if (projection.kind === "running") return " running… ";
	if (projection.kind === "waiting") return ` waiting${duration} `;
	if (projection.kind === "interrupted") return ` interrupted${duration} `;
	if (projection.kind === "stalled") return ` stalled${duration} `;
	// completed/failed exist as lifecycle projections for delivery bookkeeping,
	// but the row is removed immediately after result delivery — so the only
	// visible terminal handoff label is finalizing.
	if (
		projection.kind === "finalizing" ||
		projection.kind === "completed" ||
		projection.kind === "failed"
	) {
		return " finalizing… ";
	}
	return " starting… ";
}

function renderSubagentWidgetLines(
	agents: RunningSubagent[],
	width: number,
): string[] {
	const now = Date.now();
	const rendered = agents.map((agent) => ({
		agent,
		projection: projectLifecycle(ensureLifecycle(agent), now),
	}));
	const activeCount = rendered.filter(
		({ projection }) =>
			projection.kind === "active" ||
			projection.kind === "starting" ||
			projection.kind === "running" ||
			projection.kind === "blocked",
	).length;
	const openCount = agents.length - activeCount;
	const info =
		activeCount > 0
			? openCount > 0
				? `${activeCount} active · ${openCount} open`
				: `${activeCount} active`
			: `${openCount} open`;
	const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

	const lines: string[] = [borderTop("Subagents", info, width, accent)];

	for (const { agent, projection } of rendered) {
		const elapsed = formatElapsedMMSS(
			agent.startTime,
			projection.runtimeEndedAt ?? now,
		);
		const agentTag = agent.agent ? ` (${agent.agent})` : "";
		const left = ` ${elapsed}  ${agent.name}${agentTag} `;
		const runtimeTag = agent.runtimePlan
			? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
			: "";
		const right = statusConfig.enabled
			? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
			: ` ${runtimeTag}starting… `;

		lines.push(borderLine(left, right, width, accent));
	}

	lines.push(borderBottom(width, accent));
	return lines;
}

function updateWidget() {
	const latestCtx = runtime.latestCtx;
	if (!latestCtx?.hasUI) return;

	if (runningSubagents.size === 0) {
		latestCtx.ui.setWidget("subagent-status", undefined);
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				WIDGET_INTERVAL_KEY,
				null,
			);
		}
		return;
	}

	latestCtx.ui.setWidget(
		"subagent-status",
		(_tui: any, _theme: any) => {
			return {
				invalidate() {},
				render(width: number) {
					return renderSubagentWidgetLines(
						Array.from(runningSubagents.values()),
						width,
					);
				},
			};
		},
		{ placement: "aboveEditor" },
	);
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
function buildPiPromptArgs(params: {
	effectiveSkills?: string;
	taskDelivery: "direct" | "artifact";
	taskArg: string;
}): string[] {
	const skillPrompts = (params.effectiveSkills ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);

	const needsSeparator =
		params.taskDelivery === "artifact" && skillPrompts.length > 0;

	return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
	if (running.lifecycle) return running.lifecycle;
	let lifecycle = createLifecycle(running.startTime);
	const state = running.statusState;
	if (
		state?.activityLabel === "interrupted" &&
		state.localOverrideAtMs != null
	) {
		lifecycle = markInterruptRequested(lifecycle, state.localOverrideAtMs);
	} else if (state?.phase === "done") {
		// Legacy activity "done" means the turn ended, not that completion
		// evidence was recorded. Hydrate as Herdr-style waiting and let the
		// preserved watcher consume sidecar/sentinel evidence.
		const observedAt = state.lastActivityAtMs ?? running.startTime;
		lifecycle = observePaneInspection(
			lifecycle,
			{ kind: "present", observedAt, agentStatus: "done" },
			observedAt,
		);
	} else if (
		state?.phase === "active" ||
		state?.phase === "waiting" ||
		state?.phase === "starting"
	) {
		const activity: SubagentActivityState = {
			version: 1,
			runningChildId: running.id,
			createdAt: running.startTime,
			updatedAt: state.lastActivityAtMs ?? running.startTime,
			sequence: state.lastActivitySequence ?? 0,
			latestEvent:
				state.latestEvent === "agent_end" ? "agent_end" : "agent_start",
			phase: state.phase,
			agentActive: state.phase === "active",
			turnActive: state.phase === "active",
			providerActive: false,
			toolActive: state.activeScope === "tool",
		};
		if (isSubagentActivityScope(state.activeScope)) {
			activity.activeScope = state.activeScope;
		}
		if (state.activeSinceMs != null) activity.activeSince = state.activeSinceMs;
		if (state.waitingSinceMs != null)
			activity.waitingSince = state.waitingSinceMs;
		if (state.activityLabel && state.activeScope === "tool") {
			activity.toolName = state.activityLabel;
		}
		lifecycle = observeActivity(
			lifecycle,
			{ ok: true, activity },
			state.lastActivityAtMs ?? running.startTime,
		);
	} else if (running.startTime) {
		// Pre-lifecycle Pi agents without a known phase still get a running process.
		lifecycle = markProcessRunning(lifecycle, running.startTime);
	}
	running.lifecycle = lifecycle;
	return lifecycle;
}

function observeRunningSubagent(
	running: RunningSubagent,
	observedAt = Date.now(),
) {
	ensureLifecycle(running);

	const activityFile = running.activityFile;
	const read: ActivityReadResult = activityFile
		? readSubagentActivityFile(activityFile, running.id)
		: { ok: false, reason: "missing" };

	running.activityRead = read.ok
		? { ok: true }
		: { ok: false, reason: read.reason, error: read.error };

	if (read.ok) running.activity = read.activity;
	running.lifecycle = observeActivity(
		ensureLifecycle(running),
		read,
		observedAt,
	);
}

type NoProgressAdvisoryEvent =
	| {
			kind: "warning";
			idleMs: number;
			classification: NoProgressClassification;
			lastEntryKind: NoProgressSessionTail["lastEntryKind"];
			notify: boolean;
	  }
	| {
			kind: "recovered";
			idleMs: number;
			classification: NoProgressClassification;
			lastEntryKind: NoProgressSessionTail["lastEntryKind"];
			notify: boolean;
	  };

function evaluateNoProgressAdvisory(
	running: RunningSubagent,
	projection: LifecycleProjection,
	now: number,
	hangWarningMinutes: number,
): NoProgressAdvisoryEvent | undefined {
	// Native markers are not transcripts; their progress cannot be read from mtime.
	if (hangWarningMinutes === 0 || running.native) {
		delete running.noProgressEpisode;
		return;
	}
	if (projection.kind !== "active" && projection.kind !== "blocked") {
		delete running.noProgressEpisode;
		return;
	}

	let sessionMtime: number;
	try {
		sessionMtime = statSync(running.sessionFile).mtimeMs;
	} catch {
		// Session evidence is unavailable; do not turn that I/O problem into a hang.
		return;
	}
	const progressAt = Math.min(
		now,
		Math.max(
			sessionMtime,
			running.activity?.updatedAt ?? Number.NEGATIVE_INFINITY,
		),
	);
	const idleMs = Math.max(0, now - progressAt);
	if (idleMs <= hangWarningMinutes * 60_000) {
		const previous = running.noProgressEpisode;
		delete running.noProgressEpisode;
		return previous
			? {
					kind: "recovered",
					idleMs: Math.max(0, now - previous.progressAt),
					classification: previous.classification,
					lastEntryKind: previous.lastEntryKind,
					notify: !running.interactive,
				}
			: undefined;
	}
	if (running.noProgressEpisode) return;

	let tail: NoProgressSessionTail = {
		classification: "generic-no-progress",
		lastEntryKind: "other",
	};
	try {
		// The bounded reader is deliberately cold-path only: mtime/snapshot checks
		// above run on every refresh, but JSONL parsing happens once per episode.
		tail = inspectNoProgressSessionTail(running.sessionFile);
	} catch {
		// A session can disappear between stat and read; preserve a facts-only
		// generic advisory rather than failing the status loop.
	}
	running.noProgressEpisode = { active: true, progressAt, idleMs, ...tail };
	return { kind: "warning", idleMs, ...tail, notify: !running.interactive };
}

function formatNoProgressAdvisoryLine(
	running: RunningSubagent,
	event: NoProgressAdvisoryEvent,
): string {
	const name = normalizeStatusName(running.name);
	const persistentIds = running.persistent
		? ` Logical ID: ${running.logicalId ?? "unknown"}; generation ID: ${running.generationId ?? "unknown"}.`
		: "";
	if (event.kind === "recovered") {
		return `${name} no-progress advisory recovered after ${formatElapsedDuration(event.idleMs)}.${persistentIds}`;
	}
	const classification =
		event.classification === "blocked-tool"
			? "blocked-tool; the outstanding tool may still complete"
			: event.classification === "truncated-turn"
				? "truncated-turn; observed toolUse stop with no tool call; cause unknown"
				: "generic no-progress";
	const options = running.worktree
		? "interrupt, or retain the workspace and continue there after confirming the previous process exited"
		: running.persistent
			? "interrupt, or use subagent_stop then replace with a new persistent specialist"
			: "interrupt, or after manual termination use subagent_resume or a new spawn";
	return `${name} no-progress advisory: ${formatElapsedDuration(event.idleMs)} idle while active. Classification: ${classification}. Last entry: ${event.lastEntryKind}. Session: ${running.sessionFile}. Recovery options: ${options}.${persistentIds}`;
}

function resolveInterruptTarget(params: {
	id?: string;
	name?: string;
}): { running: RunningSubagent } | { error: string } {
	const requestedId = params.id?.trim();
	if (requestedId) {
		const running = runningSubagents.get(requestedId);
		return running
			? { running }
			: { error: `No running subagent with id "${requestedId}".` };
	}

	const requestedName = params.name?.trim();
	if (!requestedName) {
		return { error: "Provide a running subagent id or exact display name." };
	}

	const matches = Array.from(runningSubagents.values()).filter(
		(running) => running.name === requestedName,
	);
	if (matches.length === 1) return { running: matches[0] };
	if (matches.length === 0) {
		return { error: `No running subagent named "${requestedName}".` };
	}

	const candidates = matches
		.map((running) => `${running.name} [${running.id}]`)
		.join(", ");
	return {
		error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
	};
}

function resolvePersistentTarget(params: { id?: string; name?: string }) {
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) return resolved;
	if (!resolved.running.persistent) {
		return { error: `Subagent "${resolved.running.name}" is not persistent.` };
	}
	return resolved;
}

function persistentSpecialistState(
	running: RunningSubagent,
): "idle" | "working" | "stalled" | "stopped" {
	const projection = projectLifecycle(
		ensureLifecycle(running),
		Date.now(),
	).kind;
	if (running.stopState === "failed") return "stalled";
	if (running.stopState)
		return projection === "stalled" ? "stalled" : "working";
	if (running.taskId) return projection === "stalled" ? "stalled" : "working";
	// Persistent task completion is authoritative for logical specialist state.
	// Herdr can continue reporting the long-lived Pi pane as working while the
	// process remains open between turns.
	if (running.persistent && running.tasksCompleted != null) return "idle";
	if (projection === "stalled") return "stalled";
	if (
		projection === "active" ||
		projection === "blocked" ||
		projection === "starting" ||
		projection === "running"
	)
		return "working";
	if (
		projection === "completed" ||
		projection === "failed" ||
		projection === "finalizing"
	)
		return "stopped";
	return "idle";
}

interface SubagentSendDetails {
	error?: string;
	id?: string;
	task?: string;
	inbox?: string;
	outcome?: "dispatched" | "rejected-busy" | "queued" | "rejected";
	position?: number;
	truncated?: boolean;
}

interface PersistentSpecialistFacts {
	logicalId: string;
	generationId: string;
	policyHash: string;
	tasks: Array<{ task: string; outcome: string }>;
	/** Why task outcomes are unknown (the delivery ledger was unreadable). */
	tasksUnknown?: string;
	sessionFile: string;
	worktree?: WorktreeHandoff;
	lastObservedPhase: string;
}

/** Ledger task outcomes; an unreadable ledger never blocks a notice. */
function readPersistentTaskOutcomes(
	sessionFile: string,
): Pick<PersistentSpecialistFacts, "tasks" | "tasksUnknown"> {
	try {
		return {
			tasks: readPersistentDeliveryLedger(sessionFile).map((entry) => ({
				task: entry.task,
				outcome: entry.outcome,
			})),
		};
	} catch (error) {
		return {
			tasks: [],
			tasksUnknown: error instanceof Error ? error.message : String(error),
		};
	}
}

function persistentSpecialistFacts(
	running: RunningSubagent,
): PersistentSpecialistFacts {
	const facts: PersistentSpecialistFacts = {
		logicalId: running.logicalId!,
		generationId: running.generationId!,
		policyHash: running.policyHash!,
		...readPersistentTaskOutcomes(running.sessionFile),
		sessionFile: running.sessionFile,
		lastObservedPhase: projectLifecycle(ensureLifecycle(running), Date.now())
			.kind,
	};
	if (running.worktree)
		facts.worktree = captureWorktreeHandoff(running.worktree);
	return facts;
}

function formatPersistentSpecialistFacts(
	facts: PersistentSpecialistFacts,
): string {
	const lines = [
		`Logical ID: ${facts.logicalId}`,
		`Generation ID: ${facts.generationId}`,
		`Policy hash: ${facts.policyHash}`,
		`Task outcomes: ${facts.tasksUnknown ? `unknown (the delivery ledger could not be read: ${facts.tasksUnknown})` : facts.tasks.map((task) => `${task.task}=${task.outcome}`).join(", ") || "none"}`,
		`Session: ${facts.sessionFile}`,
		`Last observed phase: ${facts.lastObservedPhase}`,
	];
	if (facts.worktree)
		lines.push(
			`Worktree Git state: ${facts.worktree.gitError ? "unknown" : facts.worktree.conflicted ? "conflicted" : facts.worktree.clean ? "clean" : "dirty"}`,
		);
	return lines.join("\n");
}

function persistentCapacityError(
	config: PersistentConfig = persistentConfig,
): string | undefined {
	const specialists = Array.from(runningSubagents.values()).filter(
		(running) => running.persistent,
	);
	if (specialists.length < config.maxAgents) return undefined;
	return `Persistent specialist cap (${config.maxAgents}) reached. Current specialists: ${specialists.map((running) => `${running.name} (${persistentSpecialistState(running)}, ${running.tasksCompleted ?? 0} completed)`).join(", ")}.`;
}

/** Help-request details for a persistent specialist's task. */
interface PersistentHelpDetails {
	name: string;
	task: string;
	sessionFile: string;
	/** The fresh spawn's immutable harness selection, when it has one. */
	selection?: SubagentSelection;
	runtimeProvenance?: RuntimeProvenance;
}

/** Terminal notice details for a persistent specialist. */
interface PersistentNoticeDetails {
	status?: "failed" | "stopped";
	error?: "persistent-crash";
	facts: PersistentSpecialistFacts;
	/** The fresh spawn's immutable harness selection, when it has one. */
	selection?: SubagentSelection;
	runtimeProvenance?: RuntimeProvenance;
}

function persistentNoticeDetails(
	running: RunningSubagent,
	base: Omit<PersistentNoticeDetails, "selection" | "runtimeProvenance">,
): PersistentNoticeDetails {
	const details: PersistentNoticeDetails = { ...base };
	if (running.selection) details.selection = running.selection;
	if (running.runtimeProvenance)
		details.runtimeProvenance = running.runtimeProvenance;
	return details;
}

function sendPersistentStopFailure(
	api: Pick<ExtensionAPI, "sendMessage">,
	running: RunningSubagent,
): void {
	const facts = persistentSpecialistFacts(running);
	api.sendMessage(
		{
			customType: "subagent_stop",
			content: `Persistent specialist stop failed: process exit was not confirmed. Evidence is retained.\n\n${formatPersistentSpecialistFacts(facts)}`,
			display: true,
			details: persistentNoticeDetails(running, { status: "failed", facts }),
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function startPersistentStopTimeout(
	running: RunningSubagent,
	api: Pick<ExtensionAPI, "sendMessage">,
	stopTimeoutMs = 15_000,
): void {
	if (
		running.stopTimeout ||
		(running.stopState !== "requested" && running.stopState !== "pending")
	)
		return;
	running.stopTimeout = setTimeout(() => {
		running.stopTimeout = undefined;
		if (!runningSubagents.has(running.id)) return;
		if (running.stopState === "requested" || running.stopState === "pending") {
			running.stopState = "failed";
			running.stopFailure =
				"process exit was not confirmed within the bounded stop wait";
			sendPersistentStopFailure(api, running);
		}
	}, stopTimeoutMs);
	running.stopTimeout.unref();
}

interface SubagentStopDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "stop_requested" | "stop_pending";
}

function handleSubagentStop(
	params: { id?: string; name?: string },
	api: Pick<ExtensionAPI, "sendMessage">,
	stopTimeoutMs = 15_000,
): AgentToolResult<SubagentStopDetails> {
	const resolved = resolvePersistentTarget(params);
	if ("error" in resolved) {
		return {
			content: [{ type: "text", text: resolved.error }],
			details: { error: resolved.error },
		};
	}
	const running = resolved.running;
	if (running.stopState === "requested" || running.stopState === "pending") {
		const error = `Stop is already requested for persistent specialist "${running.name}".`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, id: running.id, name: running.name },
		};
	}
	const state = persistentSpecialistState(running);
	if (state === "stopped") {
		const error = `Persistent specialist "${running.name}" is already stopped.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, id: running.id, name: running.name },
		};
	}
	const task = running.taskId ?? "stop";
	const pending = running.taskId != null;
	running.stopState = pending ? "pending" : "requested";
	running.stopTimeoutMs = stopTimeoutMs;
	if (pending) {
		appendPersistentDeliveryLedger(running.sessionFile, {
			task,
			outcome: "stop-pending",
			generation: running.generationId!,
			logicalId: running.logicalId!,
			policyHash: running.policyHash!,
		});
	}
	if (running.native) {
		// The driver types the graceful exit command only at a verified idle
		// point, after any active task's correlated Stop. Exit confirmation is
		// bounded by the driver's exit deadline and verified termination.
		running.native.driver.stopRequested = true;
	} else {
		writePersistentTaskInbox(
			running.sessionFile,
			(running.inboxSequence = (running.inboxSequence ?? 0) + 1),
			{ type: "stop", task, message: "" },
		);
		if (!pending) startPersistentStopTimeout(running, api, stopTimeoutMs);
	}
	return {
		content: [
			{
				type: "text",
				text: pending
					? `Stop pending for persistent specialist "${running.name}"; its active task will settle first.`
					: `Stop requested for persistent specialist "${running.name}".`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			status: pending ? "stop_pending" : "stop_requested",
		},
	};
}

/**
 * Queue one correlated follow-up turn for a running native child. It is typed
 * only at the next verified idle point (the current tagged turn's correlated
 * Stop), exactly once, and its outcome is reported in the final result.
 */
function handleNativeFollowUp(
	running: RunningSubagent,
	message: string,
): AgentToolResult<SubagentSendDetails> {
	const run = running.native!;
	const id = randomUUID();
	const queued = enqueueNativeTurn(
		run.driver,
		{ id, kind: "follow-up", text: message },
		nativeTurnAdapter(run),
	);
	if (!queued.ok) {
		const error = `Follow-up for native subagent "${running.name}" was rejected: ${queued.error}. Nothing was typed.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, task: id, outcome: "rejected" },
		};
	}
	const text =
		`Follow-up ${id} queued for native subagent "${running.name}" (position ${queued.position}). ` +
		"It is typed only after the current tagged turn's correlated Stop receipt, never into a busy session, and its outcome is reported with the final result." +
		(queued.truncated
			? " The message was flattened to one line and truncated to the native typed-input bound."
			: "");
	return {
		content: [{ type: "text", text }],
		details: {
			id: running.id,
			task: id,
			outcome: "queued",
			position: queued.position,
			truncated: queued.truncated,
		},
	};
}

function handleSubagentSend(params: {
	id?: string;
	name?: string;
	message: string;
}): AgentToolResult<SubagentSendDetails> {
	const target = resolveInterruptTarget(params);
	if (
		!("error" in target) &&
		target.running.native &&
		!target.running.persistent
	)
		return handleNativeFollowUp(target.running, params.message);
	const resolved = resolvePersistentTarget(params);
	if ("error" in resolved)
		return {
			content: [{ type: "text", text: resolved.error }],
			details: { error: resolved.error },
		};
	const running = resolved.running;
	const task = randomUUID();
	if (running.stopState === "failed") {
		appendPersistentDeliveryLedger(running.sessionFile, {
			task,
			outcome: "rejected-busy",
			generation: running.generationId!,
			logicalId: running.logicalId!,
			policyHash: running.policyHash!,
		});
		const error = `Persistent specialist "${running.name}" is in an unconfirmed-stop state; task ${task} was rejected-busy. Process exit is unconfirmed and evidence is retained at session ${running.sessionFile}. Request subagent_stop again or spawn a new specialist.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, task, outcome: "rejected-busy" },
		};
	}
	const state =
		running.native && !isNativeDriverIdle(running.native.driver)
			? "working"
			: persistentSpecialistState(running);
	if (state !== "idle") {
		appendPersistentDeliveryLedger(running.sessionFile, {
			task,
			outcome: "rejected-busy",
			generation: running.generationId!,
			logicalId: running.logicalId!,
			policyHash: running.policyHash!,
		});
		const error = `Persistent specialist "${running.name}" is ${state}; task ${task} was rejected-busy. Resend after the pending result.`;
		return {
			content: [{ type: "text", text: error }],
			details: { error, task, outcome: "rejected-busy" },
		};
	}
	let inbox: string | undefined;
	if (running.native) {
		const queued = enqueueNativeTurn(
			running.native.driver,
			{ id: task, kind: "task", text: params.message },
			nativeTurnAdapter(running.native),
		);
		if (!queued.ok) {
			appendPersistentDeliveryLedger(running.sessionFile, {
				task,
				outcome: "rejected-busy",
				generation: running.generationId!,
				logicalId: running.logicalId!,
				policyHash: running.policyHash!,
			});
			const error = `Persistent specialist "${running.name}" cannot accept task ${task} (${queued.error}); it was rejected-busy.`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, task, outcome: "rejected-busy" },
			};
		}
		// Typed once by the watcher at the verified idle point that exists now;
		// native specialists have no inbox file. Only a recorded dispatch is
		// typed: nothing is typed before the next watcher tick, so a task whose
		// record fails is withdrawn and never reaches the specialist.
		try {
			appendPersistentDeliveryLedger(running.sessionFile, {
				task,
				outcome: "dispatched",
				generation: running.generationId!,
				logicalId: running.logicalId!,
				policyHash: running.policyHash!,
			});
		} catch (cause) {
			const queue = running.native.driver.queue;
			queue.splice(queue.indexOf(queued.turn), 1);
			const error = `Persistent specialist "${running.name}" did not receive task ${task}: its dispatch could not be recorded (${cause instanceof Error ? cause.message : String(cause)}). Nothing was typed; it is still idle.`;
			return {
				content: [{ type: "text", text: error }],
				details: { error, task },
			};
		}
		running.taskId = task;
	} else {
		inbox = writePersistentTaskInbox(
			running.sessionFile,
			(running.inboxSequence = (running.inboxSequence ?? 0) + 1),
			{ task, message: params.message },
		);
		running.taskId = task;
		appendPersistentDeliveryLedger(running.sessionFile, {
			task,
			outcome: "dispatched",
			generation: running.generationId!,
			logicalId: running.logicalId!,
			policyHash: running.policyHash!,
		});
	}
	return {
		content: [
			{
				type: "text",
				text: `Task ${task} dispatched to persistent specialist "${running.name}".`,
			},
		],
		details: { id: running.id, task, inbox, outcome: "dispatched" },
	};
}

function requestSubagentInterrupt(
	running: RunningSubagent,
	interruptPaneKey: (surface: string) => void = interruptPane,
): { ok: true } | { error: string } {
	try {
		interruptPaneKey(running.surface);
		return { ok: true };
	} catch (error: any) {
		return {
			error:
				`Failed to send Escape to subagent "${running.name}" via herdr: ` +
				`${error?.message ?? String(error)}`,
		};
	}
}

interface SubagentInterruptDetails {
	error?: string;
	id?: string;
	name?: string;
	status?: "interrupt_requested";
}

/**
 * Interrupt only a verified owned, live native run whose tagged turn a
 * correlated receipt shows in progress. The interrupt is recorded before the
 * key is sent, so the turn can never settle as a success.
 */
function handleNativeInterrupt(
	running: RunningSubagent,
	interruptPaneKey: (surface: string) => void,
	inspector = defaultProcessInspector,
): AgentToolResult<SubagentInterruptDetails> {
	const run = running.native!;
	const label = nativeHarnessLabel(run.harness);
	const reject = (reason: string) => {
		const error = `Interrupt refused for native ${label} subagent "${running.name}": ${reason}. Nothing was sent.`;
		return {
			content: [{ type: "text" as const, text: error }],
			details: { error, id: running.id, name: running.name },
		};
	};
	const owned = readProcessRunState(run.processRun, inspector);
	if (owned.kind !== "running")
		return reject("its owned native process is not running");
	if (!owned.verified)
		return reject(
			"ownership of its native process cannot be verified on this platform",
		);
	const now = Date.now();
	const request = requestNativeInterrupt(
		run.driver,
		nativeTurnAdapter(run).readState(),
		now,
		runtime.nativeTestSeam?.interruptGraceMs,
	);
	if (!request.ok) return reject(request.error);
	try {
		interruptPaneKey(running.surface);
	} catch (error: any) {
		// No key reached the TUI: the turn continues and may still complete.
		run.driver.interrupt = undefined;
		return reject(`sending Escape failed (${error?.message ?? String(error)})`);
	}
	running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
	updateWidget();
	const after =
		run.driver.mode === "interactive"
			? "The session stays open for the human; queued parent input waits for the next verified Stop."
			: run.driver.mode === "persistent"
				? "The task is reported as interrupted. The specialist accepts tasks again only after a native Stop receipt proves it idle; otherwise it is ended with verified termination."
				: "If a native Stop receipt proves the turn ended, the run exits gracefully; otherwise its owned process is terminated. The result reports the interruption and remains resumable when the CLI persisted the session.";
	return {
		content: [
			{
				type: "text" as const,
				text: `Interrupt requested for native ${label} subagent "${running.name}". Its tagged turn is recorded as interrupted, never as a success. ${after}`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			status: "interrupt_requested",
		},
	};
}

function handleSubagentInterrupt(
	params: { id?: string; name?: string },
	interruptPaneKey: (surface: string) => void = interruptPane,
	inspector = defaultProcessInspector,
): AgentToolResult<SubagentInterruptDetails> {
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) {
		return {
			content: [{ type: "text" as const, text: resolved.error }],
			details: { error: resolved.error },
		};
	}

	const running = resolved.running;
	if (running.native)
		return handleNativeInterrupt(running, interruptPaneKey, inspector);
	const now = Date.now();
	observeRunningSubagent(running, now);

	const interruption = requestSubagentInterrupt(running, interruptPaneKey);
	if ("error" in interruption) {
		return {
			content: [{ type: "text" as const, text: interruption.error }],
			details: {
				error: interruption.error,
				id: running.id,
				name: running.name,
			},
		};
	}

	running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
	updateWidget();

	return {
		content: [
			{
				type: "text" as const,
				text: `Interrupt requested for subagent "${running.name}".`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			status: "interrupt_requested",
		},
	};
}

function startStatusRefresh(pi: ExtensionAPI) {
	if (!statusConfig.enabled || statusInterval) return;

	statusInterval = setInterval(() => {
		if (runningSubagents.size === 0) {
			if (statusInterval) {
				clearInterval(statusInterval);
				statusInterval = null;
				writeGlobalSlot<ReturnType<typeof setInterval> | null>(
					STATUS_INTERVAL_KEY,
					null,
				);
			}
			return;
		}

		const transitionLines: string[] = [];
		const now = Date.now();
		let shouldRefreshWidget = false;

		for (const running of runningSubagents.values()) {
			// Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
			// Native children have no Pi activity snapshot; their watcher owns observation.
			if (!running.native) observeRunningSubagent(running, now);
			const projection = projectLifecycle(ensureLifecycle(running), now);
			const transition = lifecycleTransition(
				running.lastProjectedKind,
				projection.kind,
			);
			if (running.lastProjectedKind !== projection.kind) {
				shouldRefreshWidget = true;
			}
			running.lastProjectedKind = projection.kind;

			// Interactive subagents (long-running, user-driven) intentionally don't
			// wake the parent session on stalled/recovered transitions — the user is
			// working in the subagent's pane, and a steer message here would burn an
			// orchestrator turn on a no-op "still waiting" ping. Widget still updates.
			if (transition && !running.interactive) {
				transitionLines.push(
					formatLifecycleTransitionLine(
						normalizeStatusName(running.name),
						projection,
						transition,
						now,
						running.startTime,
						formatElapsedDuration,
					),
				);
			}

			const noProgress = evaluateNoProgressAdvisory(
				running,
				projection,
				now,
				supervisionConfig.hangWarningMinutes,
			);
			if (noProgress?.notify) {
				transitionLines.push(formatNoProgressAdvisoryLine(running, noProgress));
			}
		}

		if (shouldRefreshWidget) updateWidget();

		if (transitionLines.length > 0) {
			const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
			pi.sendMessage(
				{
					customType: "subagent_status",
					content: formatStatusAggregate(
						transitionLines,
						statusConfig.lineLimit,
					),
					display: true,
					details: { lines: capped.visibleLines, overflow: capped.overflow },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		}
	}, 1000);

	writeGlobalSlot(STATUS_INTERVAL_KEY, statusInterval);
}

function buildBtwLaunchCommand(params: {
	cwd: string;
	sessionFile: string;
	question: string;
	model: string;
	thinking: string;
	agentDir?: string;
}): string {
	const parts = [
		"pi",
		"--session",
		shellQuote(params.sessionFile),
		"--no-extensions",
		"--model",
		shellQuote(params.model),
		"--thinking",
		shellQuote(params.thinking),
		shellQuote(BTW_BOUNDARY + params.question),
	];
	const envPrefix = params.agentDir
		? `PI_CODING_AGENT_DIR=${shellQuote(params.agentDir)} `
		: "";
	// A side session is never a routing parent: recursion guard only.
	return `cd ${shellQuote(params.cwd)} && ${envPrefix}${AUTO_ROUTING_DISABLED_ENV}=1 ${parts.join(" ")}`;
}

const SUBAGENT_COMMAND_USAGE =
	"Usage: /subagent <agent> [--harness pi|claude|kiro] [--model <value>] [--thinking <level>] [--] [task] | /subagent list";

interface ParsedSubagentCommand {
	ok: true;
	agent: string;
	/** Verbatim task text; empty when none was given. */
	task: string;
	harness?: SubagentHarness;
	model?: string;
	thinking?: ThinkingLevel;
}

/**
 * Parse `/subagent <agent> [--harness h] [--model v] [--thinking t] [--] [task]`.
 *
 * Options precede the task. An option value is one whitespace-free word, or
 * a single- or double-quoted string (single quotes are literal; in double
 * quotes only `\"` and `\\` are escapes), so a fallback list with spaces
 * can be quoted. Empty, unclosed, missing, duplicate, and unknown options
 * are rejected. Task mode begins at the first word that does not start with
 * `--`, or after a lone `--`; from there the text is returned verbatim,
 * including quotes, backslashes, tabs, newlines, and later `--` words.
 */
function parseSubagentCommand(
	args: string,
): ParsedSubagentCommand | { ok: false; error: string } {
	const input = args.trim();
	const isSpace = (char: string | undefined) =>
		char !== undefined && /\s/.test(char);
	let i = 0;
	const skipSpace = () => {
		while (isSpace(input[i])) i++;
	};
	const readWord = () => {
		const begin = i;
		while (i < input.length && !isSpace(input[i])) i++;
		return input.slice(begin, i);
	};
	const fail = (error: string) => ({ ok: false as const, error });

	const agent = readWord();
	if (!agent) return fail(SUBAGENT_COMMAND_USAGE);
	if (agent.startsWith("-"))
		return fail(`The agent name must come first. ${SUBAGENT_COMMAND_USAGE}`);

	const readValue = (flag: string): { value: string } | { error: string } => {
		skipSpace();
		const open = input[i];
		if (open === undefined) return { error: `${flag} requires a value.` };
		let value = "";
		if (open === '"' || open === "'") {
			i++;
			let closed = false;
			while (i < input.length) {
				const char = input[i];
				if (char === open) {
					closed = true;
					i++;
					break;
				}
				if (
					open === '"' &&
					char === "\\" &&
					(input[i + 1] === '"' || input[i + 1] === "\\")
				) {
					value += input[i + 1];
					i += 2;
					continue;
				}
				value += char;
				i++;
			}
			if (!closed) return { error: `${flag} has an unclosed ${open} quote.` };
			if (i < input.length && !isSpace(input[i]))
				return {
					error: `${flag} value must be followed by whitespace after its closing quote.`,
				};
		} else {
			value = readWord();
			if (value.startsWith("--")) return { error: `${flag} requires a value.` };
			if (/["']/.test(value))
				return {
					error: `${flag} value must be quoted as a whole; quotes inside a bare word are not allowed.`,
				};
		}
		if (!value.trim()) return { error: `${flag} value cannot be empty.` };
		return { value };
	};

	const options: Omit<ParsedSubagentCommand, "ok" | "agent" | "task"> = {};
	const seen = new Set<string>();
	let task = "";
	for (;;) {
		skipSpace();
		if (i >= input.length) break;
		if (!input.startsWith("--", i)) {
			task = input.slice(i);
			break;
		}
		const flag = readWord();
		if (flag === "--") {
			skipSpace();
			task = input.slice(i);
			break;
		}
		if (flag !== "--harness" && flag !== "--model" && flag !== "--thinking")
			return fail(
				`Unknown option ${flag}; use -- before a task that starts with --. ${SUBAGENT_COMMAND_USAGE}`,
			);
		if (seen.has(flag)) return fail(`Duplicate option ${flag}.`);
		seen.add(flag);
		const parsed = readValue(flag);
		if ("error" in parsed) return fail(parsed.error);
		const { value } = parsed;
		if (flag === "--harness") {
			if (!isSubagentHarness(value))
				return fail(
					`--harness must be one of ${SUBAGENT_HARNESSES.join(", ")}; got ${JSON.stringify(value)}.`,
				);
			options.harness = value;
		} else if (flag === "--thinking") {
			if (!isThinkingLevel(value))
				return fail(
					`--thinking must be one of ${THINKING_LEVELS.join(", ")}; got ${JSON.stringify(value)}.`,
				);
			options.thinking = value;
		} else options.model = value;
	}
	return { ok: true, agent, task, ...options };
}

/**
 * The model-facing instruction a `/subagent` command dispatches: every
 * parsed argument JSON-serialized exactly, with the legacy default task.
 */
function buildSubagentCommandMessage(command: ParsedSubagentCommand): string {
	const displayName = command.agent[0].toUpperCase() + command.agent.slice(1);
	const task =
		command.task ||
		`You are the ${command.agent} agent. Wait for instructions.`;
	const parts = [
		`agent: ${JSON.stringify(command.agent)}`,
		`name: ${JSON.stringify(displayName)}`,
		`task: ${JSON.stringify(task)}`,
	];
	if (command.harness)
		parts.push(`harness: ${JSON.stringify(command.harness)}`);
	if (command.model) parts.push(`model: ${JSON.stringify(command.model)}`);
	if (command.thinking)
		parts.push(`thinking: ${JSON.stringify(command.thinking)}`);
	return `Use subagent with ${parts.join(", ")}`;
}

export const __test__ = {
	borderLine,
	renderSubagentWidgetLines,
	loadAgentDefaults,
	discoverAgentDefinitions,
	discoverAgentCatalog,
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	resolveEffectiveAutoExit,
	resolveEffectiveInteractive,
	buildSubagentToolAllowlist,
	buildPiPromptArgs,
	buildBtwLaunchCommand,
	resolveEffectivePersistent,
	observeRunningSubagent,
	evaluateNoProgressAdvisory,
	formatNoProgressAdvisoryLine,
	resolveDenyTools,
	resolveRoleProjection,
	parseSubagentCommand,
	buildSubagentCommandMessage,
	buildSubagentRoutingGuidelines,
	resolveInterruptTarget,
	requestSubagentInterrupt,
	handleSubagentInterrupt,
	handleSubagentSend,
	handleSubagentStop,
	persistentSpecialistState,
	persistentCapacityError,
	resolveResultPresentation,
	resolveUnexpectedErrorPresentation,
	shouldAdvanceToFallback,
	deliverPersistentTaskEvent,
	drainPersistentTaskEvents,
	notifyPersistentCrash,
	sendSubagentResult,
	shouldRetainSubagentSurface,
	resolveWorktreeLaunchWarning,
	formatLivePersistentSpecialists,
	captureWorktreeHandoff,
	runSubagentScript,
	writeWorktreeManifest,
	runningSubagents,
	formatElapsed,
	watchNativeSubagent,
	resolveNativeSpecForParams,
	reconcileUnresolvedNativeRuns,
	closePaneAfterLateExit,
	lateReleasedNativeRuns,
	recoverPlannedPersistentDispatches,
	unresolvedNativeRuns,
	handleNativeFollowUp,
	handleNativeInterrupt,
	shouldAdvanceNativeFallback,
	serviceNativeBridge,
	deliverNestedResult,
	flushNativePersistentDeliveries,
	handleNestedSpawnRequest,
	discoverInstalledSkills,
	verifyResumeWorktree,
	resumeNativeSession,
	launchNativeFromParams,
	prepareSubagentRun,
	createAutoLaunchAuthorization,
	createAutoRoutingAuthority,
	launchAutoRoutedRun,
	startSubagentRun,
	watchNativeWithFallbacks,
	setNativeTestSeam(seam: NativeTestSeam | undefined) {
		runtime.nativeTestSeam = seam;
	},
};

function startWidgetRefresh() {
	if (widgetInterval) return;
	updateWidget(); // immediate first render
	widgetInterval = setInterval(() => {
		updateWidget();
	}, 1000);
	writeGlobalSlot(WIDGET_INTERVAL_KEY, widgetInterval);
}

/**
 * A Pi role's runtime defaults (role model → `models.agents[role]` →
 * `models.default`; role thinking) with the canonical origin of the model,
 * which the legacy `agent` source flattens.
 */
function resolveRuntimeDefaults(
	agentName: string | undefined,
	agentDefs: AgentDefaults | null,
): RuntimeDefaults {
	const origin: RuntimeDefaults["origin"] = agentDefs?.model
		? { model: { source: "role" } }
		: agentName && Object.hasOwn(modelConfig.agents, agentName)
			? {
					model: {
						source: "default",
						defaultKey: `models.agents.${agentName}`,
					},
				}
			: {
					model: modelConfig.default
						? { source: "default", defaultKey: "models.default" }
						: undefined,
				};
	return {
		model: resolveModelDefault(agentName, agentDefs?.model, modelConfig),
		thinking: agentDefs?.thinking,
		origin,
	};
}

/**
 * The role definition a Pi launch uses: the snapshot resolved (and projected)
 * once by startSubagentRun, or a fresh lookup when none was supplied.
 */
function resolveLaunchAgentDefs(
	params: Pick<typeof SubagentParams.static, "agent">,
	supplied: AgentDefaults | null | undefined,
): AgentDefaults | null {
	if (supplied !== undefined) return supplied;
	const agentDefs = params.agent
		? loadAgentDefaults(params.agent, runtime.pi)
		: null;
	if (params.agent && !agentDefs) {
		const diagnostic = discoverAgentCatalog(runtime.pi).diagnostics.find(
			(candidate) => candidate.agentName === params.agent,
		);
		throw new Error(
			diagnostic?.message ?? `Agent "${params.agent}" was not found.`,
		);
	}
	return agentDefs;
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
	params: typeof SubagentParams.static,
	ctx: {
		sessionManager: {
			getSessionFile(): string | null | undefined;
			getSessionId(): string;
			getSessionDir(): string;
		};
		cwd: string;
		model?: { provider: string; id: string };
		modelRegistry: {
			find(provider: string, modelId: string): any;
			getAvailable?: () => any[];
			getAll?: () => any[];
			hasConfiguredAuth?: (model: any) => boolean;
		};
	},
	parentThinking: ThinkingLevel,
	options?: {
		surface?: string;
		runtimePlan?: ResolvedRuntimePlan;
		id?: string;
		/** Deny every spawning tool regardless of the role (nested leaves). */
		forceLeaf?: boolean;
		/** The role as resolved and projected once for this spawn. */
		agentDefs?: AgentDefaults | null;
		/** An automatic launch: its guards and child environment hygiene. */
		automatic?: AutomaticLaunch;
		/** Package-owned cancellation of an automatic launch. */
		signal?: AbortSignal;
	},
): Promise<RunningSubagent> {
	const agentDefs = resolveLaunchAgentDefs(params, options?.agentDefs);
	if (!ctx.model)
		throw new Error("Subagent launch requires a resolved parent model");
	const runtimePlan =
		options?.runtimePlan ??
		resolveRuntimePlan(
			{ model: params.model, thinking: params.thinking },
			resolveRuntimeDefaults(params.agent, agentDefs),
			{
				provider: ctx.model.provider,
				modelId: ctx.model.id,
				thinking: parentThinking,
			},
			wrapPiModelRegistry(ctx.modelRegistry),
		);
	const effectiveTools = params.tools ?? agentDefs?.tools;
	const effectiveSkills = params.skills ?? agentDefs?.skills;
	const persistent = resolveEffectivePersistent(params, agentDefs);
	const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
	const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
	const logicalId = options?.id ?? randomUUID();
	const generationId = randomUUID();
	const taskId = randomUUID();
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) throw new Error("No session file");

	const running = await launchPiSubagent(
		{
			kind: "fresh",
			id: logicalId,
			name: params.name,
			task: params.task,
			agent: params.agent,
			cwd: params.cwd,
			worktree: params.worktree,
			fork: params.fork,
			surface: options?.surface,
			parent: {
				cwd: ctx.cwd,
				invocationCwd: process.cwd(),
				sessionFile: parentSessionFile,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionDir: ctx.sessionManager.getSessionDir(),
				agentDir: getAgentConfigDir(),
			},
			runtimePlan,
			behavior: {
				tools: effectiveTools,
				skills: effectiveSkills,
				deniedTools: [
					...new Set([
						...resolveDenyTools(agentDefs),
						...(options?.forceLeaf ? SPAWNING_TOOLS : []),
					]),
				],
				autoExit: effectiveAutoExit,
				interactive: effectiveInteractive,
				persistent,
				logicalId,
				generationId,
				taskId,
				identity: agentDefs?.body ?? params.systemPrompt,
				systemPromptMode: agentDefs?.systemPromptMode,
				sessionMode: resolveEffectiveSessionMode(params, agentDefs),
				cwd: agentDefs?.cwd,
			},
			automatic: options?.automatic,
			signal: options?.signal,
		},
		runtime.nativeTestSeam?.operations,
	);
	if (persistent) {
		const policy = readSubagentSessionPolicy(running.sessionFile);
		if (policy.version !== 2)
			throw new Error("Persistent launch policy was not written as v2.");
		running.persistent = true;
		running.logicalId = policy.logicalId;
		running.generationId = policy.generationId;
		running.policyHash = policy.policyHash;
		running.policyTools = policy.tools;
		running.policyDeniedTools = policy.deniedTools;
		running.tasksCompleted = 0;
		running.taskId = taskId;
		running.inboxSequence = 0;
		running.observedTaskEvents = 0;
		try {
			appendPersistentDeliveryLedger(running.sessionFile, {
				task: taskId,
				outcome: "dispatched",
				generation: policy.generationId,
				logicalId: policy.logicalId,
				policyHash: policy.policyHash,
			});
		} catch (error) {
			// The child is live: it is registered and supervised below, never
			// left untracked, and knows its first task from its launch
			// environment.
			running.dispatchWarning = `the first task's dispatch could not be recorded in the delivery ledger (${error instanceof Error ? error.message : String(error)}); the specialist is supervised and its results are still delivered.`;
		}
	}
	runningSubagents.set(logicalId, running);
	return running;
}

/** Validate a native role together with per-call overrides; throws before resources. */
function resolveNativeSpecForParams(
	params: Static<typeof SubagentParams>,
	agentDefs: AgentDefaults & { name: string; cli: NativeHarnessName },
): NativeLaunchSpec {
	return resolveNativeLaunchSpec(toNativeRoleDefinition(agentDefs), {
		model: params.model,
		thinking: params.thinking,
		tools: params.tools,
		skills: params.skills,
		fork: params.fork,
		persistent: params.persistent,
		interactive: params.interactive,
	});
}

/** Installed Pi skills from the live session, else Pi's own loader. */
function discoverInstalledSkills(
	pi: Pick<ExtensionAPI, "getCommands"> | undefined,
	cwd: string,
): InstalledSkill[] {
	try {
		const commands = pi?.getCommands?.();
		if (commands)
			return commands.flatMap((command) =>
				command.source === "skill" && command.name.startsWith("skill:")
					? [
							{
								name: command.name.slice("skill:".length),
								filePath: command.sourceInfo.path,
								baseDir: dirname(command.sourceInfo.path),
							},
						]
					: [],
			);
	} catch {
		// Fall back to Pi's default skill discovery below.
	}
	return loadSkills({
		cwd,
		agentDir: getAgentConfigDir(),
		skillPaths: [],
		includeDefaults: true,
	}).skills.map((skill) => ({
		name: skill.name,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
	}));
}

/** Private, content-addressed skill snapshots for this parent session. */
function nativeSkillSnapshotRoot(
	ctx: Parameters<typeof launchSubagent>[1],
): string | undefined {
	const sessionDir = ctx.sessionManager?.getSessionDir?.();
	const sessionId = ctx.sessionManager?.getSessionId?.();
	return sessionDir && sessionId
		? join(getArtifactDir(sessionDir, sessionId), "native-skills")
		: undefined;
}

/** Whether a value names a model in Pi's provider/model registry. */
function isPiModelRef(
	registry: Parameters<typeof launchSubagent>[1]["modelRegistry"],
	value: string,
): boolean {
	const parsed = parseExactModelRef(value);
	if (!parsed || !registry?.find) return false;
	try {
		return !!registry.find(parsed.provider, parsed.modelId);
	} catch {
		return false;
	}
}

/**
 * Fail before any resource exists if a persistent specialist's delivery
 * ledger cannot be written. Creates at most an empty ledger file (never a
 * record); returns whether it created that file.
 */
function preflightDispatchLedger(markerFile: string): boolean {
	const ledger = getPersistentDeliveryLedgerFile(markerFile);
	mkdirSync(dirname(markerFile), { recursive: true, mode: 0o700 });
	const existed = existsSync(ledger);
	appendFileSync(ledger, "", { mode: 0o600 });
	return !existed;
}

function removeEmptyLedger(markerFile: string): void {
	const ledger = getPersistentDeliveryLedgerFile(markerFile);
	try {
		if (statSync(ledger).size === 0) unlinkSync(ledger);
	} catch {
		// An empty ledger file is never read as a task record.
	}
}

/** Best effort: a missing record leaves the plan to restart recovery. */
function recordPlannedOutcome(
	planned: PersistentDeliveryLedgerEntry,
	outcome: "abandoned" | "dispatched",
	markerFile: string,
): boolean {
	try {
		appendPersistentDeliveryLedger(markerFile, {
			task: planned.task,
			outcome,
			generation: planned.generation,
			logicalId: planned.logicalId,
			policyHash: planned.policyHash,
		});
		return true;
	} catch {
		return false;
	}
}

/** A persistent first task left `planned` and resolved by restart recovery. */
interface RecoveredDispatch {
	markerFile: string;
	task: string;
	outcome: "abandoned" | "dispatched";
}

/**
 * Resolve persistent first tasks left `planned` by a parent that crashed
 * between the plan and its commit. The run's cancel marker is written first,
 * so a wrapper that has not started can never start the CLI; then a run with
 * no start receipt provably never started (`abandoned`), and one with a
 * receipt was dispatched (`dispatched`; its unsupervised process remains
 * covered by the durable leases). Launches still in flight, unresolved, or
 * supervised in this process (including across /reload) are never touched.
 */
function recoverPlannedPersistentDispatches(
	artifactDir: string,
	writeCancel: (run: ProcessRun) => boolean = writeCancelMarker,
): RecoveredDispatch[] {
	const sessions = join(artifactDir, "native-sessions");
	let names: string[];
	try {
		names = readdirSync(sessions);
	} catch {
		return [];
	}
	const inFlight = runtime.plannedNativeDispatches ?? new Set<string>();
	const tracked = new Set([
		...[...runningSubagents.values()].flatMap((child) =>
			child.native ? [child.native.processRun.id] : [],
		),
		...[...unresolvedNativeRuns().values()].map(
			(entry) => entry.run.processRun.id,
		),
	]);
	const recovered: RecoveredDispatch[] = [];
	for (const name of names) {
		if (!name.endsWith(".json.ledger")) continue;
		const markerFile = join(sessions, name.slice(0, -".ledger".length));
		let entries: PersistentDeliveryLedgerEntry[];
		try {
			entries = readPersistentDeliveryLedger(markerFile);
		} catch {
			continue;
		}
		for (const plan of entries) {
			if (plan.outcome !== "planned") continue;
			if (inFlight.has(plan.task) || tracked.has(plan.generation)) continue;
			if (
				entries.some(
					(entry) => entry.task === plan.task && entry.outcome !== "planned",
				)
			)
				continue;
			const receiptFile = join(
				artifactDir,
				"native-runs",
				plan.generation,
				"process.json",
			);
			// Written before the receipt check: after a confirmed marker write,
			// either the wrapper already published its start receipt or it must
			// observe the marker before launching the native CLI. A failed marker
			// write leaves the late-start window open, so absence of a receipt is
			// not proof that the plan was abandoned.
			const cancelled = writeCancel({
				id: plan.generation,
				receiptFile,
				ownerToken: "",
			});
			const started = existsSync(receiptFile);
			if (!started && !cancelled) continue;
			const outcome = started ? "dispatched" : "abandoned";
			if (recordPlannedOutcome(plan, outcome, markerFile))
				recovered.push({ markerFile, task: plan.task, outcome });
		}
	}
	return recovered;
}

/** Launch a pre-planned native child through the common Herdr seams. */
async function launchNativeFromParams(
	params: Static<typeof SubagentParams>,
	ctx: Parameters<typeof launchSubagent>[1],
	plan: NativeLaunchPlan,
	options: {
		agentDefs: AgentDefaults | null;
		parentThinking: ThinkingLevel;
		model?: string | null;
		id?: string;
		reuseWorktree?: WorktreeLaunch;
		worktreeLeaseFrom?: string;
		signal?: AbortSignal;
		/** An automatic fresh launch: its guards and child hygiene. */
		automatic?: AutomaticLaunch;
	},
): Promise<RunningSubagent> {
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) throw new Error("No session file");
	const id = options.id ?? randomUUID();
	const persistent = plan.spec.mode === "persistent";
	// A persistent specialist's first task is durable before its process
	// exists: preflight the ledger before any resource, record `planned` just
	// before dispatch, and commit `dispatched` after it. A failed ledger never
	// leaves a live untracked child, and a failed launch never leaves an
	// active task.
	const taskId = randomUUID();
	const markerPath = nativeSessionMarkerPath(
		{
			sessionDir: ctx.sessionManager.getSessionDir(),
			sessionId: ctx.sessionManager.getSessionId(),
		},
		id,
	);
	const createdLedger = persistent && preflightDispatchLedger(markerPath);
	const inFlight = (runtime.plannedNativeDispatches ??= new Set());
	let planned: PersistentDeliveryLedgerEntry | undefined;
	let running: RunningSubagent;
	try {
		running = await launchNativeTracked({
			kind: "native",
			id,
			name: params.name,
			task: params.task,
			agent: params.agent,
			cwd: params.cwd,
			worktree: options.reuseWorktree ? undefined : params.worktree,
			parent: {
				cwd: ctx.cwd,
				invocationCwd: process.cwd(),
				sessionFile: parentSessionFile,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionDir: ctx.sessionManager.getSessionDir(),
				agentDir: getAgentConfigDir(),
			},
			behavior: {
				interactive: resolveEffectiveInteractive(params, options.agentDefs),
				cwd: options.agentDefs?.cwd,
			},
			plan,
			model: options.model ?? plan.models[0] ?? null,
			reuseWorktree: options.reuseWorktree,
			worktreeLeaseFrom: options.worktreeLeaseFrom,
			signal: options.signal,
			automatic: options.automatic,
			beforeDispatch: persistent
				? (prepared) => {
						// The first tagged turn is the specialist's first task.
						prepared.driver.turns[0].id = taskId;
						inFlight.add(taskId);
						planned = appendPersistentDeliveryLedger(prepared.markerFile, {
							task: taskId,
							outcome: "planned",
							generation: prepared.processRun.id,
							logicalId: id,
							policyHash: prepared.loadoutSha256,
						});
					}
				: undefined,
		});
	} catch (error) {
		if (planned && !(error instanceof NativeLaunchUnresolvedError))
			// Planned, then provably never started: never an active task. If
			// this record fails too, restart recovery resolves the plan.
			recordPlannedOutcome(planned, "abandoned", markerPath);
		else if (!planned && createdLedger) removeEmptyLedger(markerPath);
		throw error;
	} finally {
		inFlight.delete(taskId);
	}
	const run = running.native!;
	if (persistent) {
		running.persistent = true;
		running.logicalId = running.id;
		running.generationId = run.processRun.id;
		running.policyHash = run.loadoutSha256;
		running.policyTools = plan.spec.tools.split(",").filter(Boolean);
		running.policyDeniedTools = [];
		running.tasksCompleted = 0;
		running.taskId = taskId;
		try {
			appendPersistentDeliveryLedger(running.sessionFile, {
				task: taskId,
				outcome: "dispatched",
				generation: running.generationId,
				logicalId: running.logicalId,
				policyHash: running.policyHash,
			});
		} catch (error) {
			// The process is live: it is registered and supervised below, never
			// left untracked. The durable record stays `planned`.
			running.dispatchWarning = `the first task's dispatch could not be committed to the delivery ledger (${error instanceof Error ? error.message : String(error)}); the specialist is supervised and its results are still delivered, but the ledger records the task only as planned.`;
		}
	}
	if (plan.spec.spawnAgents)
		running.nativeDelegation = {
			ctx,
			parentThinking: options.parentThinking,
			tools: new Set(plan.spec.tools.split(",").filter(Boolean)),
			agents: [...plan.spec.spawnAgents],
			cwd: run.claude?.cwd ?? run.kiro!.cwd,
			children: new Map(),
			total: 0,
			queue: Promise.resolve(),
		};
	runningSubagents.set(running.id, running);
	return running;
}

/**
 * Native model fallback is allowed only with positive evidence that the
 * failed attempt did no task work: its exit (every owned descendant
 * included) is confirmed, and its own correlated session receipt shows the
 * hooks were active while no prompt-submit receipt was ever recorded. A
 * failed or StopFailure outcome is never evidence of no work; a completed
 * result, even a negative one, is never retried. Worktree attempts also
 * require verifiably pristine Git state.
 */
export function shouldAdvanceNativeFallback(
	result: Pick<
		SubagentResult,
		"errorMessage" | "native" | "nativeOutcome" | "worktree" | "error"
	>,
	remaining: number,
): { advance: true } | { advance: false; reason: string } {
	if (remaining <= 0) return { advance: false, reason: "no candidates remain" };
	if (!result.errorMessage || result.error === "cancelled")
		return { advance: false, reason: "the attempt did not fail" };
	if (result.native?.mode === "persistent")
		return {
			advance: false,
			reason: "persistent specialists never advance after launch",
		};
	if (result.native?.processExit !== "confirmed")
		return { advance: false, reason: "the attempt's exit is unconfirmed" };
	const outcome = result.nativeOutcome;
	if (!outcome) return { advance: false, reason: "no correlated outcome" };
	if (outcome.interrupted)
		return { advance: false, reason: "the attempt was interrupted" };
	if (!outcome.neverStarted)
		return {
			advance: false,
			reason:
				"there is no positive evidence that the first tagged turn never started (it may have done task work)",
		};
	if (result.worktree) {
		const tree = result.worktree;
		if (
			tree.gitError ||
			tree.clean !== true ||
			tree.conflicted !== false ||
			(tree.untrackedFiles?.length ?? 1) > 0 ||
			tree.headSha !== tree.baseSha
		)
			return {
				advance: false,
				reason: "the retained worktree is not verifiably pristine",
			};
	}
	return { advance: true };
}

/**
 * A native watcher failure tagged with the attempt it belongs to: after a
 * fallback the caller must re-check and release that attempt's run and
 * leases, never the first attempt's.
 */
class NativeAttemptWatchError extends Error {
	readonly attempt: RunningSubagent;
	constructor(cause: Error, attempt: RunningSubagent) {
		super(cause.message, { cause });
		this.name = "NativeAttemptWatchError";
		this.attempt = attempt;
	}
}

/** Watch native attempts in model order under the fallback rules above. */
async function watchNativeWithFallbacks(
	initial: RunningSubagent,
	params: Static<typeof SubagentParams>,
	ctx: Parameters<typeof launchSubagent>[1],
	plan: NativeLaunchPlan,
	signal: AbortSignal,
	completedPanes: Set<string>,
	options: { agentDefs: AgentDefaults | null; parentThinking: ThinkingLevel },
): Promise<{ running: RunningSubagent; result: SubagentResult }> {
	let running = initial;
	const models = plan.models;
	const label = (model: string | null) => model ?? "(native CLI default)";
	const attempts = [label(running.native?.model ?? null)];
	const failures: ModelFailure[] = [];
	let next = 1;
	for (;;) {
		// While another candidate may follow, the settled attempt keeps the
		// parent-reserved durable worktree lease for an atomic handoff.
		running.nativeHoldWorktreeLease =
			!!running.worktree && models.length - next > 0;
		let result: SubagentResult;
		try {
			result = await watchSubagent(running, signal);
		} catch (error) {
			throw new NativeAttemptWatchError(
				error instanceof Error ? error : new Error(String(error)),
				running,
			);
		}
		// Retain the pane as evidence while native exit is unconfirmed.
		if (!running.worktree && result.native?.processExit !== "unconfirmed")
			completedPanes.add(running.surface);
		if (result.errorMessage)
			failures.push({
				model: attempts[attempts.length - 1],
				error: `${result.errorMessage} (marker ${running.sessionFile})`,
			});
		const decision = shouldAdvanceNativeFallback(result, models.length - next);
		const finish = (extra: Partial<SubagentResult> = {}) => ({
			running,
			result: {
				...result,
				...extra,
				fallbackAttempts: attempts,
				fallbackFailures: failures,
			},
		});
		// Final settlement releases the reservation only once the run it names
		// is provably gone; an unresolved run keeps it until reconciliation.
		const settleReservation = (holder: RunningSubagent) => {
			const lease = holder.native?.worktreeLease;
			if (lease && holder.nativeHoldWorktreeLease) releaseReservedLease(lease);
		};
		if (!decision.advance) {
			settleReservation(running);
			if (models.length - next > 0 && result.errorMessage)
				return finish({
					errorMessage: `${result.errorMessage}\n\nNo native model fallback: ${decision.reason}.`,
				});
			return finish();
		}
		const model = models[next++];
		attempts.push(label(model));
		// The failed attempt stays registered until the next one is, and its
		// durable lease is handed over atomically, so the worktree is never
		// unleased between attempts, in this parent or any other.
		const previous = running;
		try {
			await runtime.nativeTestSeam?.onFallbackTransition?.(previous);
			// Parent shutdown between attempts never launches another child.
			if (signal.aborted) throw new Error("Subagent cancelled.");
			running = await launchNativeFromParams(params, ctx, plan, {
				...options,
				model,
				reuseWorktree: previous.worktree,
				worktreeLeaseFrom: previous.native?.worktreeLease
					? previous.native.processRun.id
					: undefined,
				signal,
			});
			running.abortController = initial.abortController;
			// Every attempt keeps the logical child's routing: a nested child's
			// result is owed to its requester, never to the ordinary parent.
			if (previous.nestedOf) running.nestedOf = previous.nestedOf;
			running.selection = previous.selection;
			running.runtimeProvenance = previous.runtimeProvenance;
			if (previous.autoRouting) running.autoRouting = previous.autoRouting;
			startWidgetRefresh();
			if (runtime.pi) startStatusRefresh(runtime.pi);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			// The reservation names the previous run or a never-started attempt;
			// an unresolved attempt keeps it until its exit is confirmed.
			if (!(error instanceof NativeLaunchUnresolvedError)) {
				failures.push({ model: label(model), error: text });
				settleReservation(previous);
			}
			if (error instanceof NativeLaunchUnresolvedError) {
				// The failed attempt's process may be live, so the result is about
				// that attempt: its marker, model, and pane are primary, recovery
				// targets it, and earlier attempts remain only as history. Its
				// pane and worktree are retained and no stale Git state is shown.
				const unresolved = error.run;
				failures.push({
					model: label(model),
					error: `${text} (marker ${unresolved.markerFile})`,
				});
				const native: NativeResultReference = {
					harness: unresolved.harness,
					sessionId: nativeSessionId(unresolved),
					markerFile: unresolved.markerFile,
					processExit: "unconfirmed",
					mode: unresolved.driver.mode,
					model: unresolved.model,
					surface: error.surface,
					resume: {
						available: false,
						reason:
							"this fallback attempt's process exit is unconfirmed, so its leases are retained",
					},
					warning: `fallback attempt ${unresolved.processRun.id} (${label(model)}) failed after dispatch and its process exit is unconfirmed; the run is unresolved and treated as failed.`,
					retained: [
						...retainedNativeEvidence(unresolved),
						...(error.worktree ? [error.worktree.path] : []),
						`pane ${error.surface}`,
					],
				};
				const extra: Partial<SubagentResult> = {
					sessionFile: unresolved.markerFile,
					summary: `Native fallback attempt ${label(model)} failed after dispatch; its process exit is unconfirmed.`,
					errorMessage: `Native fallback attempt ${label(model)} failed after dispatch and its process exit is unconfirmed: ${text}\n\nEarlier attempt ${attempts[attempts.length - 2]} failed: ${result.errorMessage}`,
					native,
					nativeOutcome: undefined,
				};
				if (error.worktree)
					extra.worktree = unknownWorktreeHandoff(
						error.worktree,
						"a fallback attempt failed after dispatch",
					);
				return finish(extra);
			}
			return finish({
				errorMessage: `${result.errorMessage}\n\nNative fallback launch failed: ${text}`,
			});
		} finally {
			if (running !== previous) runningSubagents.delete(previous.id);
			updateWidget();
		}
	}
}

const MAX_NESTED_CONCURRENT = 4;
const MAX_NESTED_TOTAL = 16;
const MAX_NESTED_RESULT_BYTES = 6_000;

/**
 * Parent-side policy for one authenticated nested-spawn request. The
 * requested role must be on the native child's spawn-agents allowlist, have
 * an explicit tools allowlist within the child's own tools, run autonomously
 * as an ordinary standalone leaf, and never be persistent or a worktree.
 */
async function handleNestedSpawnRequest(
	requester: RunningSubagent,
	request: BridgeRequest,
): Promise<BridgeResponse> {
	const delegation = requester.nativeDelegation;
	const pi = runtime.pi;
	const reject = (reason: string) => ({
		accepted: false,
		text: `Rejected by the parent: ${reason}`,
	});
	if (!delegation || !pi || !requester.native)
		return reject("this native run cannot delegate.");
	if (!runningSubagents.has(requester.id))
		return reject("the requesting native run has ended.");
	if (!delegation.agents.includes(request.agent))
		return reject(
			`agent "${request.agent}" is not in spawn-agents (${delegation.agents.join(", ")}).`,
		);
	if (request.agent === requester.agent)
		return reject("a native child cannot spawn its own role.");
	const active = [...delegation.children.values()].filter(
		(child) => child.outcome === "running",
	).length;
	if (active >= MAX_NESTED_CONCURRENT)
		return reject(
			`${active} nested subagents are already running (limit ${MAX_NESTED_CONCURRENT}).`,
		);
	if (delegation.total >= MAX_NESTED_TOTAL)
		return reject(
			`the per-run limit of ${MAX_NESTED_TOTAL} nested subagents is reached.`,
		);
	const role = loadAgentDefaults(request.agent, pi);
	if (!role) return reject(`agent "${request.agent}" is not available.`);
	const tools = (role.tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (tools.length === 0)
		return reject(
			`agent "${request.agent}" has no explicit tools allowlist, so it could exceed the requester's tools.`,
		);
	const wider = tools.filter((tool) => !delegation.tools.has(tool));
	if (wider.length)
		return reject(
			`agent "${request.agent}" would receive tools the requester lacks (${wider.join(", ")}).`,
		);
	if (role.persistent) return reject("persistent roles cannot be nested.");
	if (role.autoExit !== true)
		return reject("only autonomous (auto-exit: true) roles can be nested.");
	delegation.total++;
	const name = `${requester.name}/${request.name}`;
	const result = await startSubagentRun(
		pi,
		{
			name,
			task: request.task,
			agent: request.agent,
			cwd: delegation.cwd,
			fork: false,
			persistent: false,
			worktree: null,
		},
		delegation.ctx,
		{
			forceLeaf: true,
			nestedOf: {
				requesterId: requester.id,
				requesterName: requester.name,
				nonce: request.nonce,
				agent: request.agent,
				name,
			},
			// The requester's watcher abort (parent shutdown) stops the launch.
			signal: requester.abortController?.signal,
		},
	);
	// SAFETY: startSubagentRun returns SubagentStartedDetails when it launches
	// and an error-details object otherwise; `status` distinguishes them.
	const details = result.details as SubagentStartedDetails | { error?: string };
	if (!("status" in details) || details.status !== "started")
		return reject(getFirstText(result.content) || "launch failed.");
	delegation.children.set(request.nonce, {
		name,
		agent: request.agent,
		outcome: "running",
	});
	return {
		accepted: true,
		text: `Launched nested subagent "${name}" (agent ${request.agent}, id ${details.id}). Its result arrives later as a new message beginning with "Nested subagent result". End your turn now; do not poll.`,
	};
}

/**
 * Deliver a nested child's result to its requesting native child as one
 * correlated follow-up turn, marked as untrusted data. When the requester is
 * gone or cannot accept input, the parent receives the result instead.
 */
function deliverNestedResult(
	pi: ExtensionAPI,
	child: RunningSubagent,
	result: SubagentResult,
): void {
	const origin = child.nestedOf!;
	const requester = runningSubagents.get(origin.requesterId);
	// A nested Pi child's caller_ping ends its run with a help request; the
	// requester receives it as that, never as a completed result.
	const outcome = result.ping
		? "needs-help"
		: result.errorMessage
			? "failed"
			: result.exitCode === 0
				? "completed"
				: "failed";
	const delegation = requester?.nativeDelegation;
	const entry = delegation?.children.get(origin.nonce);
	if (entry) entry.outcome = outcome;
	const body = truncateUtf8(
		sanitizeArtifactText(
			result.ping?.message ?? result.errorMessage ?? result.summary,
		),
		MAX_NESTED_RESULT_BYTES,
	);
	const run = requester?.native;
	if (run) {
		run.driver.outstandingNested = Math.max(
			0,
			run.driver.outstandingNested - 1,
		);
		const queued = enqueueNativeTurn(
			run.driver,
			{
				id: origin.nonce,
				kind: "nested-result",
				text: `Nested subagent result for "${origin.name}" (agent ${origin.agent}, ${outcome}). ${wrapUntrustedData("Nested subagent output", "It was produced by another agent.", body)}`,
			},
			nativeTurnAdapter(run),
		);
		if (queued.ok) return;
	}
	const details: SubagentResultDetails = {
		name: child.name,
		task: child.task,
		agent: child.agent,
		exitCode: result.exitCode,
		elapsed: result.elapsed,
		sessionFile: result.sessionFile,
	};
	if (result.errorMessage) details.errorMessage = result.errorMessage;
	if (child.selection) details.selection = child.selection;
	if (child.runtimeProvenance)
		details.runtimeProvenance = child.runtimeProvenance;
	sendSubagentResult(
		selectCompletionApi(pi, runtime.pi),
		`Nested subagent "${origin.name}" (${origin.agent}) ${outcome}; its requesting native child "${origin.requesterName}" could not accept the result, so it is delivered here.\n\n${resolveResultPresentation(result, child.name)}`,
		details,
	);
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file. Temporary panes close only after parent
 * delivery; worktree workspaces remain retained for review.
 */
function resolveSubagentRuntimePlans(
	params: typeof SubagentParams.static,
	ctx: Parameters<typeof launchSubagent>[1],
	parentThinking: ThinkingLevel,
	suppliedAgentDefs?: AgentDefaults | null,
	/** An automatic tuple and, for provenance only, what it replaces. */
	automatic?: {
		authorization: AutoLaunchAuthorization;
		replaced: RuntimeDefaults;
	},
): ResolvedRuntimePlan[] {
	const agentDefs = resolveLaunchAgentDefs(params, suppliedAgentDefs);
	if (!ctx.model)
		throw new Error("Subagent launch requires a resolved parent model");
	const plans = resolveRuntimePlans(
		automatic
			? {
					model: automatic.authorization.model,
					thinking: automatic.authorization.effort,
					source: "auto",
				}
			: { model: params.model, thinking: params.thinking },
		automatic?.replaced ?? resolveRuntimeDefaults(params.agent, agentDefs),
		{
			provider: ctx.model.provider,
			modelId: ctx.model.id,
			thinking: parentThinking,
		},
		wrapPiModelRegistry(ctx.modelRegistry),
		modelConfig.tasks,
		!!params.worktree,
	);
	if (params.worktree && plans.length > 1) {
		throw new Error(
			"Model fallbacks are not supported for worktree subagents.",
		);
	}
	return plans;
}

async function launchSubagentWithFallbacks(
	params: typeof SubagentParams.static,
	ctx: Parameters<typeof launchSubagent>[1],
	parentThinking: ThinkingLevel,
	plans: ResolvedRuntimePlan[],
	extra: {
		forceLeaf?: boolean;
		agentDefs?: AgentDefaults | null;
		automatic?: AutomaticLaunch;
		signal?: AbortSignal;
	} = {},
): Promise<{
	running: RunningSubagent;
	index: number;
	launchFailures: ModelFailure[];
}> {
	const launchFailures: ModelFailure[] = [];
	// An automatic tuple is one exact plan with no model fallback: its one
	// launch error, with the dispatch latch it left, is never aggregated.
	if (extra.automatic) {
		if (plans.length !== 1)
			throw new Error("An automatic launch has exactly one runtime plan.");
		return {
			running: await launchSubagent(params, ctx, parentThinking, {
				runtimePlan: plans[0],
				forceLeaf: extra.forceLeaf,
				agentDefs: extra.agentDefs,
				automatic: extra.automatic,
				signal: extra.signal,
			}),
			index: 0,
			launchFailures,
		};
	}
	for (const [index, plan] of plans.entries()) {
		try {
			return {
				running: await launchSubagent(params, ctx, parentThinking, {
					runtimePlan: plan,
					forceLeaf: extra.forceLeaf,
					agentDefs: extra.agentDefs,
				}),
				index,
				launchFailures,
			};
		} catch (error) {
			launchFailures.push({
				model: plan.model,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	throw new Error(
		`Subagent could not launch with any configured model. Attempted: ${plans.map((plan) => plan.model).join(", ")}. ${launchFailures.map(({ model, error }) => `${model}: ${error}`).join("; ")}`,
	);
}

const inFlightPersistentTaskDeliveries = new Set<string>();

function deliverPersistentTaskEvent(
	running: RunningSubagent,
	event: ReturnType<typeof readPersistentTaskEvents>[number],
	api: Pick<ExtensionAPI, "sendMessage">,
	ledgerSnapshot?: ReturnType<typeof readPersistentDeliveryLedger>,
): void {
	if (!running.persistent || event.generation !== running.generationId) return;
	const deliveryKey = `${running.id}:${event.type}:${event.task}`;
	if (inFlightPersistentTaskDeliveries.has(deliveryKey)) return;
	const ledger =
		ledgerSnapshot ?? readPersistentDeliveryLedger(running.sessionFile);
	if (event.type === "help-request") {
		if (
			ledger.some(
				(entry) =>
					entry.task === event.task && entry.outcome === "help-requested",
			)
		)
			return;
		inFlightPersistentTaskDeliveries.add(deliveryKey);
		const details: PersistentHelpDetails = {
			name: running.name,
			task: event.task,
			sessionFile: running.sessionFile,
		};
		if (running.selection) details.selection = running.selection;
		if (running.runtimeProvenance)
			details.runtimeProvenance = running.runtimeProvenance;
		try {
			api.sendMessage(
				{
					customType: "subagent_ping",
					content: `Persistent specialist "${running.name}" requests help for task ${event.task}:\n\n${event.message ?? ""}\n\nReply with subagent_send to ${running.name}.`,
					display: true,
					details,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			ledger.push(
				appendPersistentDeliveryLedger(running.sessionFile, {
					task: event.task,
					outcome: "help-requested",
					generation: running.generationId!,
					logicalId: running.logicalId!,
					policyHash: running.policyHash!,
				}),
			);
			if (running.taskId === event.task) running.taskId = undefined;
		} finally {
			inFlightPersistentTaskDeliveries.delete(deliveryKey);
		}
		return;
	}
	if (
		ledger.some(
			(entry) => entry.task === event.task && entry.outcome === "delivered",
		)
	)
		return;
	inFlightPersistentTaskDeliveries.add(deliveryKey);
	try {
		const completed = (running.tasksCompleted ?? 0) + 1;
		const summary = existsSync(running.sessionFile)
			? (findLastAssistantMessage(getNewEntries(running.sessionFile, 0)) ??
				"Persistent specialist completed without output.")
			: "Persistent specialist session is unavailable.";
		const details: SubagentResultDetails = {
			name: running.name,
			task: event.task,
			agent: running.agent,
			sessionFile: running.sessionFile,
			logicalId: running.logicalId!,
			generationId: running.generationId!,
			policyHash: running.policyHash!,
		};
		if (running.selection) details.selection = running.selection;
		if (running.runtimeProvenance)
			details.runtimeProvenance = running.runtimeProvenance;
		sendSubagentResult(
			api,
			`Persistent specialist "${running.name}" completed task ${event.task} (${completed} tasks completed) and is idle and accepting subagent_send.\n\n${summary}`,
			details,
		);
		ledger.push(
			appendPersistentDeliveryLedger(running.sessionFile, {
				task: event.task,
				outcome: "delivered",
				generation: running.generationId!,
				logicalId: running.logicalId!,
				policyHash: running.policyHash!,
			}),
		);
		running.tasksCompleted = completed;
		if (running.taskId === event.task) running.taskId = undefined;
		if (running.stopState === "pending")
			startPersistentStopTimeout(running, api, running.stopTimeoutMs);
	} finally {
		inFlightPersistentTaskDeliveries.delete(deliveryKey);
	}
}

function drainPersistentTaskEvents(
	running: RunningSubagent,
	api: Pick<ExtensionAPI, "sendMessage">,
	readLedger = readPersistentDeliveryLedger,
): void {
	const events = readPersistentTaskEvents(running.sessionFile);
	let ledger: ReturnType<typeof readPersistentDeliveryLedger> | undefined;
	for (const event of events.slice(running.observedTaskEvents ?? 0)) {
		if (!running.persistent || event.generation !== running.generationId)
			continue;
		if (
			inFlightPersistentTaskDeliveries.has(
				`${running.id}:${event.type}:${event.task}`,
			)
		)
			continue;
		ledger ??= readLedger(running.sessionFile);
		deliverPersistentTaskEvent(
			running,
			event,
			selectCompletionApi(api, runtime.pi),
			ledger,
		);
	}
	running.observedTaskEvents = events.length;
}

function notifyPersistentCrash(
	running: RunningSubagent,
	api: Pick<ExtensionAPI, "sendMessage">,
	undelivered: NativeSettledTask[] = [],
	reason?: string,
): void {
	try {
		drainPersistentTaskEvents(running, api);
	} catch (error) {
		// A native specialist writes no task events; its notice still goes out.
		if (!running.native) throw error;
	}
	if (running.crashNotified) return;
	const facts = persistentSpecialistFacts(running);
	// A native specialist's settled results are delivered before this notice,
	// so it reports how the process ended, not a lost task.
	const ended = reason
		? ` Reason: ${abbreviateMiddle(reason, 2_000, " [...] ")}`
		: "";
	const headline = running.native
		? `Persistent specialist exited without a stop request (${running.tasksCompleted ?? 0} settled task result(s) delivered before this notice).${ended}${formatUndeliveredTasks(undelivered)}`
		: "Persistent specialist crashed.";
	api.sendMessage(
		{
			customType: "subagent_result",
			content: `${headline} Evidence is retained. Persistent sessions cannot be resumed in v1; spawn a new specialist.\n\n${formatPersistentSpecialistFacts(facts)}`,
			display: true,
			details: persistentNoticeDetails(running, {
				error: "persistent-crash",
				facts,
			}),
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
	// Only a sent notice counts: a failed send may be retried.
	running.crashNotified = true;
}

function getSupervisionCoordinator(): SupervisionCoordinator {
	if (runtime.supervision) return runtime.supervision;
	runtime.supervision = new SupervisionCoordinator(
		async () => {
			const panes = await listPanes();
			if (!panes) return { complete: false, panes: [] };
			return { complete: true, panes };
		},
		inspectPane,
		supervisionConfig.forcePolling,
	);
	return runtime.supervision;
}

function drainPersistentEventsSafely(running: RunningSubagent): void {
	if (!running.persistent || !runtime.pi) return;
	try {
		drainPersistentTaskEvents(running, runtime.pi);
	} catch {
		// Leave an unread task event for the next file wake-up or reconciliation.
	}
}

async function watchSubagent(
	running: RunningSubagent,
	signal: AbortSignal,
): Promise<SubagentResult> {
	if (running.native)
		return watchNativeSubagent(running, signal, {
			...defaultNativeWatchDependencies,
			...runtime.nativeTestSeam?.watch,
		});
	if (runtime.nativeTestSeam?.piWatch)
		return runtime.nativeTestSeam.piWatch(running, signal);
	const { name, task, surface, startTime, sessionFile } = running;
	const supervision = getSupervisionCoordinator().register(
		sessionFile,
		surface,
	);
	running.supervisionRegistration = supervision;

	try {
		const result = await waitForCompletion(signal, {
			intervalMs: 1000,
			sessionFile,
			waitForNextCheck: supervision.wait,
			readTerminalTail: () => readPaneAsync(surface, 5),
			inspectPane: supervision.inspectPane,
			onLocalEvidence: () => drainPersistentEventsSafely(running),
			onPaneInspection: (inspection: PaneInspection, observedAt: number) => {
				ensureLifecycle(running);
				running.lifecycle = observePaneInspection(
					running.lifecycle,
					inspection,
					observedAt,
				);
				updateWidget();
			},
			onTick() {
				observeRunningSubagent(running);
			},
		});

		const detectedAt = Date.now();
		running.lifecycle = markCompletionDetected(
			running.lifecycle,
			result,
			detectedAt,
		);
		updateWidget();
		const elapsed = Math.floor((detectedAt - startTime) / 1000);

		let summary: string;
		if (existsSync(sessionFile)) {
			const allEntries = getNewEntries(sessionFile, 0);
			const observed = findObservedSessionRuntime(allEntries);
			if (running.runtimePlan && observed.provider && observed.modelId) {
				const observedModel = `${observed.provider}/${observed.modelId}`;
				const observedThinking =
					observed.thinking === "off" ||
					observed.thinking === "minimal" ||
					observed.thinking === "low" ||
					observed.thinking === "medium" ||
					observed.thinking === "high" ||
					observed.thinking === "xhigh" ||
					observed.thinking === "max"
						? observed.thinking
						: undefined;
				const mismatch =
					observedModel === running.runtimePlan.model
						? undefined
						: `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`;
				const updatedPlan: ResolvedRuntimePlan = { ...running.runtimePlan };
				if (observedThinking) updatedPlan.thinking = observedThinking;
				updatedPlan.observed = { model: observedModel };
				if (observedThinking) updatedPlan.observed.thinking = observedThinking;
				if (mismatch) updatedPlan.runtimeMismatch = mismatch;
				running.runtimePlan = updatedPlan;
			}
			summary =
				findLastAssistantMessage(allEntries) ??
				(result.errorMessage
					? `Subagent error: ${result.errorMessage}`
					: result.exitCode === 0
						? "Sub-agent exited without output"
						: `Sub-agent exited with code ${result.exitCode}`);
		} else {
			summary = result.errorMessage
				? `Subagent error: ${result.errorMessage}`
				: result.exitCode === 0
					? "Sub-agent exited without output"
					: `Sub-agent exited with code ${result.exitCode}`;
		}

		const worktreeHandoff = finalizeSubagentWorktree(
			running,
			result.ping
				? "needs_help"
				: result.exitCode === 0
					? "ready_for_review"
					: "failed",
		);
		running.lifecycle =
			result.exitCode === 0
				? markCompleted(running.lifecycle, Date.now())
				: markFailed(
						running.lifecycle,
						result.errorMessage ?? summary,
						Date.now(),
						result.exitCode,
					);

		const watchResult: SubagentResult = {
			name,
			task,
			summary,
			sessionFile,
			exitCode: result.exitCode,
			elapsed,
			ping: result.ping,
			runtimePlan: running.runtimePlan,
		};
		if (result.errorMessage) watchResult.errorMessage = result.errorMessage;
		if (worktreeHandoff) watchResult.worktree = worktreeHandoff;
		return watchResult;
	} catch (err: any) {
		const worktreeHandoff = finalizeSubagentWorktree(running, "failed");
		running.lifecycle = markFailed(
			running.lifecycle,
			signal.aborted ? "Subagent cancelled." : (err?.message ?? String(err)),
			Date.now(),
			1,
		);
		updateWidget();

		if (signal.aborted) {
			const cancelledResult: SubagentResult = {
				name,
				task,
				summary: "Subagent cancelled.",
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				error: "cancelled",
				sessionFile,
			};
			if (worktreeHandoff) cancelledResult.worktree = worktreeHandoff;
			return cancelledResult;
		}
		const errorResult: SubagentResult = {
			name,
			task,
			summary: `Subagent error: ${err?.message ?? String(err)}`,
			exitCode: 1,
			elapsed: Math.floor((Date.now() - startTime) / 1000),
			error: err?.message ?? String(err),
		};
		if (worktreeHandoff) errorResult.worktree = worktreeHandoff;
		return errorResult;
	} finally {
		supervision.unregister();
		if (running.supervisionRegistration === supervision) {
			running.supervisionRegistration = undefined;
		}
	}
}

interface NativeWatchDependencies {
	send(surface: string, text: string): void;
	inspectPane(surface: string): Promise<PaneInspection>;
	terminate(run: NativeRun["processRun"]): TerminationResult | void;
	confirmExit?(run: NativeRun["processRun"]): ExitConfirmation;
	intervalMs?: number;
	terminationGraceMs?: number;
	/** Serve one authenticated nested-spawn request (tests may replace it). */
	handleBridgeRequest?(
		running: RunningSubagent,
		request: BridgeRequest,
	): Promise<BridgeResponse>;
	onTurnSettled?(turn: NativeTurn): void;
}

const defaultNativeWatchDependencies: NativeWatchDependencies = {
	send: runInPane,
	inspectPane,
	terminate: (processRun) => terminateProcessRun(processRun),
};

function unresolvedNativeRuns(): Map<string, UnresolvedNativeRun> {
	runtime.unresolvedNativeRuns ??= new Map();
	return runtime.unresolvedNativeRuns;
}

/**
 * Re-check retained native runs. A run whose exit is now confirmed releases
 * its owned files and session lease and stops blocking worktree cleanup; the
 * ordinary pane of an accepted autonomous result is then closed.
 */
function reconcileUnresolvedNativeRuns(
	confirm: (run: NativeRun["processRun"]) => ExitConfirmation = (run) =>
		confirmProcessExit(run),
): UnresolvedNativeRun[] {
	const unresolved = unresolvedNativeRuns();
	for (const [id, entry] of unresolved) {
		const exit = confirm(entry.run.processRun);
		if (exit.kind === "confirmed") {
			releaseNativeRun(entry.run, exit, "exit-confirmed-late");
			unresolved.delete(id);
			if (entry.closePaneOnExit) closeCompletedPanes([entry.closePaneOnExit]);
			// Its result may still be in flight: delivery decides the pane.
			else lateReleasedNativeRuns().add(entry.run);
		}
	}
	return [...unresolved.values()];
}

function lateReleasedNativeRuns(): WeakSet<NativeRun> {
	runtime.lateReleasedNativeRuns ??= new WeakSet();
	return runtime.lateReleasedNativeRuns;
}

const LATE_EXIT_RECHECK_MS = 2_000;
const MAX_LATE_EXIT_RECHECK_MS = 60_000;

/**
 * After the parent accepted an autonomous run's result while its exit was
 * unconfirmed, mark the ordinary pane it created for closing at confirmed
 * exit. If a re-check already released this exact run before delivery, the
 * pane closes now, but only after its exit is confirmed again. Worktree
 * roots, persistent, interactive and nested runs keep theirs.
 */
function closePaneAfterLateExit(
	running: RunningSubagent,
	native: NativeResultReference | undefined,
): void {
	const run = running.native;
	if (!run || !native) return;
	if (running.worktree || running.persistent || running.nestedOf) return;
	if (run.driver.mode !== "autonomous") return;
	if (native.surface !== undefined && native.surface !== running.surface)
		return;
	const entry = unresolvedNativeRuns().get(running.id);
	if (entry) {
		if (entry.run !== run || native.processExit !== "unconfirmed") return;
		entry.closePaneOnExit = running.surface;
		scheduleLateExitRecheck();
		return;
	}
	if (!lateReleasedNativeRuns().delete(run)) return;
	const confirm =
		runtime.nativeTestSeam?.watch?.confirmExit ?? confirmProcessExit;
	let exit: ExitConfirmation;
	try {
		exit = confirm(run.processRun);
	} catch {
		return;
	}
	if (exit.kind === "confirmed") closeCompletedPanes([running.surface]);
}

/**
 * Re-check unresolved runs with backoff while any retains a closable pane.
 * The timer is unreferenced and survives /reload with the runtime.
 */
function scheduleLateExitRecheck(
	delayMs = runtime.nativeTestSeam?.lateExitRecheckMs ?? LATE_EXIT_RECHECK_MS,
): void {
	if (runtime.lateExitRecheck) return;
	const timer = setTimeout(() => {
		runtime.lateExitRecheck = undefined;
		const confirm = runtime.nativeTestSeam?.watch?.confirmExit;
		let pending = true;
		try {
			pending = reconcileUnresolvedNativeRuns(confirm).some(
				(entry) => entry.closePaneOnExit,
			);
		} catch {
			// Release I/O failed; the entry stays unresolved and is retried.
		}
		if (pending)
			scheduleLateExitRecheck(Math.min(delayMs * 2, MAX_LATE_EXIT_RECHECK_MS));
	}, delayMs);
	timer.unref?.();
	runtime.lateExitRecheck = timer;
}

/** Git state is never captured while an owned process may still write it. */
function retainUnconfirmedNativeWorktree(
	running: RunningSubagent,
	reason: string,
): WorktreeHandoff | undefined {
	return running.worktree
		? retainUnresolvedWorktree(running.worktree, reason)
		: undefined;
}

/** Evidence for a native run whose watcher threw. */
interface ThrownNativeSettlement {
	native: NativeResultReference;
	worktree?: WorktreeHandoff;
}

/**
 * A native watcher threw. Never trust an earlier outcome: re-check owned
 * process exit (descendants included) before any Git capture or release,
 * and retain an unconfirmed run until reconciliation confirms its exit.
 */
function settleThrownNativeWatcher(
	running: RunningSubagent,
	run: NativeRun,
): ThrownNativeSettlement {
	const exit = confirmProcessExit(run.processRun);
	const unresolved =
		unresolvedNativeRuns().has(running.id) || exit.kind !== "confirmed";
	if (unresolved)
		unresolvedNativeRuns().set(running.id, {
			run,
			worktreePath: running.worktree?.path,
		});
	else {
		// A confirmed settlement hands its pane to the caller's close path.
		lateReleasedNativeRuns().delete(run);
		try {
			releaseNativeRun(run, exit, "failed");
		} catch {
			// Leases are released before the run record; evidence stays on disk.
		}
	}
	const settlement: ThrownNativeSettlement = {
		native: {
			harness: run.harness,
			sessionId: nativeSessionId(run),
			markerFile: run.markerFile,
			processExit: unresolved ? "unconfirmed" : "confirmed",
		},
	};
	if (running.worktree)
		settlement.worktree = unresolved
			? retainUnconfirmedNativeWorktree(
					running,
					"the watcher failed before confirming exit",
				)
			: captureWorktreeHandoff(running.worktree);
	return settlement;
}

/**
 * Launch a native child; when the launch fails after its process may have
 * been dispatched, track the run as unresolved so its leases hold until the
 * owned process exit is confirmed.
 */
async function launchNativeTracked(
	request: Parameters<typeof launchNativeSubagent>[0],
): Promise<RunningSubagent> {
	// A parent shutdown aborts every in-flight native launch before dispatch.
	runtime.nativeLaunchAbort ??= new AbortController();
	const signals = [runtime.nativeLaunchAbort.signal];
	if (request.signal) signals.push(request.signal);
	try {
		return await launchNativeSubagent(
			{ ...request, signal: AbortSignal.any(signals) },
			runtime.nativeTestSeam?.operations,
			runtime.nativeTestSeam?.nativeOperations,
		);
	} catch (error) {
		if (error instanceof NativeLaunchUnresolvedError)
			unresolvedNativeRuns().set(error.run.processRun.id, {
				run: error.run,
				worktreePath: error.worktree?.path,
			});
		throw error;
	}
}

/** A settled persistent native task awaiting (or past) parent delivery. */
interface NativeSettledTask {
	task: string;
	outcome: string;
	summary?: string;
	error?: string;
	at: string;
}

const MAX_SETTLED_TEXT_BYTES = 16 * 1024;

function nativeSettledLogFile(running: RunningSubagent): string {
	return `${running.sessionFile}.settled.jsonl`;
}

/**
 * Queue a settled persistent native task exactly once per task ID, before
 * any delivery attempt, so a result settled by the final outcome after a
 * fast exit is never lost or queued twice. The queue lives with the running
 * specialist (which survives /reload); the append-only 0600 settled log is a
 * durable record only. Delivery never reads it, so a line another process
 * writes there is never delivered as a task result.
 */
function queueNativePersistentTask(
	running: RunningSubagent,
	turn: NativeTurn,
): void {
	if (!running.persistent) return;
	if (turn.kind !== "initial" && turn.kind !== "task") return;
	const settled = (running.nativeSettledTasks ??= []);
	if (settled.some((entry) => entry.task === turn.id)) return;
	const entry: NativeSettledTask = {
		task: turn.id,
		outcome: turn.outcome ?? "failed",
		at: new Date().toISOString(),
	};
	if (turn.summary)
		entry.summary = truncateUtf8(turn.summary, MAX_SETTLED_TEXT_BYTES);
	if (turn.error)
		entry.error = truncateUtf8(turn.error, MAX_SETTLED_TEXT_BYTES);
	settled.push(entry);
	try {
		appendFileSync(
			nativeSettledLogFile(running),
			`${JSON.stringify(entry)}\n`,
			{
				mode: 0o600,
			},
		);
	} catch {
		// The queue still owes the task; only the durable record is missing.
	}
}

/**
 * Settled tasks not proven delivered, in settlement order. The in-memory
 * record proves this process's deliveries (so a result is never sent twice);
 * the durable ledger adds proof only when it can be read. An unreadable or
 * failing ledger (for example EACCES or EIO) proves nothing, so the tasks it
 * might have covered stay owed and retryable. Never throws.
 */
function pendingNativePersistentTasks(
	running: RunningSubagent,
): NativeSettledTask[] {
	const delivered = new Set(running.nativeDeliveredTasks ?? []);
	try {
		for (const entry of readPersistentDeliveryLedger(running.sessionFile))
			if (entry.outcome === "delivered") delivered.add(entry.task);
	} catch {
		// Only the in-memory record proves delivery until the ledger reads.
	}
	return (running.nativeSettledTasks ?? []).filter(
		(entry) => !delivered.has(entry.task),
	);
}

/**
 * Deliver settled persistent native tasks in order, exactly once. A failed
 * parent send leaves the task owed (and the specialist busy) for the next
 * attempt, including from a reloaded module; the durable ledger and an
 * in-memory record both suppress duplicates, even when the ledger append
 * itself fails.
 */
function flushNativePersistentDeliveries(
	running: RunningSubagent,
	api: Pick<ExtensionAPI, "sendMessage"> | undefined,
): void {
	if (!running.persistent || !api) return;
	running.nativeDeliveredTasks ??= new Set();
	const delivered = running.nativeDeliveredTasks;
	for (const entry of pendingNativePersistentTasks(running)) {
		const settled = (running.tasksCompleted ?? 0) + 1;
		const completed = entry.outcome === "completed";
		const state =
			entry.outcome === "interrupted"
				? "It accepts subagent_send again only after a native Stop receipt proves it idle."
				: "It is idle and accepting subagent_send.";
		const body = completed
			? (entry.summary ?? "Persistent specialist completed without output.")
			: `Task ${entry.outcome}: ${entry.error ?? "no correlated Stop receipt"}`;
		const details: SubagentResultDetails = {
			name: running.name,
			task: entry.task,
			agent: running.agent,
			sessionFile: running.sessionFile,
			logicalId: running.logicalId!,
			generationId: running.generationId!,
			policyHash: running.policyHash!,
		};
		if (running.selection) details.selection = running.selection;
		if (running.runtimeProvenance)
			details.runtimeProvenance = running.runtimeProvenance;
		try {
			sendSubagentResult(
				api,
				`Persistent specialist "${running.name}" ${completed ? "completed" : `settled (${entry.outcome})`} task ${entry.task} (${settled} tasks settled). ${state}\n\n${body}`,
				details,
			);
		} catch {
			// Retry later; the task stays owed and the specialist busy.
			return;
		}
		delivered.add(entry.task);
		try {
			appendPersistentDeliveryLedger(running.sessionFile, {
				task: entry.task,
				outcome: "delivered",
				generation: running.generationId!,
				logicalId: running.logicalId!,
				policyHash: running.policyHash!,
			});
		} catch {
			// The in-memory record still prevents a duplicate delivery.
		}
		running.tasksCompleted = settled;
		if (running.taskId === entry.task) running.taskId = undefined;
		updateWidget();
	}
}

const NATIVE_FINAL_DELIVERY_ATTEMPTS = 120;

/**
 * After a persistent native specialist's process ends, deliver every owed
 * task result before its stop or exit notice. Transient send failures and
 * unreadable delivery state are retried (using the current, possibly
 * reloaded, parent API) for a bounded time; results still undelivered then
 * travel inside the notice itself. A notice that fails to send is retried
 * until the same deadline. No failure here escapes or ends the retries.
 */
function afterNativePersistentDeliveries(
	running: RunningSubagent,
	finish: (undelivered: NativeSettledTask[]) => void,
	attempt = 0,
): void {
	try {
		flushNativePersistentDeliveries(running, runtime.pi);
	} catch {
		// Ledger, log, or send-path failure: the tasks stay owed and retry.
	}
	const pending = pendingNativePersistentTasks(running);
	const exhausted =
		attempt >=
		(runtime.nativeTestSeam?.deliveryAttempts ??
			NATIVE_FINAL_DELIVERY_ATTEMPTS);
	if (pending.length === 0 || exhausted) {
		try {
			finish(pending);
			return;
		} catch {
			// The notice was not sent. After the deadline, evidence stays on disk.
			if (exhausted) return;
		}
	}
	setTimeout(
		() => afterNativePersistentDeliveries(running, finish, attempt + 1),
		runtime.nativeTestSeam?.deliveryRetryMs ?? 1_000,
	).unref();
}

/** Claim, authenticate, and serve pending nested-spawn requests serially. */
function serviceNativeBridge(
	running: RunningSubagent,
	deps: NativeWatchDependencies,
): void {
	const run = running.native;
	const delegation = running.nativeDelegation;
	if (!run?.bridge || !delegation) return;
	const { requests, rejected } = collectBridgeRequests(
		run.bridge,
		run.processRun,
	);
	for (const rejection of rejected)
		if (rejection.nonce)
			writeBridgeResponse(run.bridge, rejection.nonce, {
				accepted: false,
				text: `Rejected by the parent: ${rejection.reason}.`,
			});
	const handle = deps.handleBridgeRequest ?? handleNestedSpawnRequest;
	for (const request of requests) {
		// Reserve the result slot before any await so the child cannot exit
		// while the parent is still launching its nested subagent.
		run.driver.outstandingNested++;
		delegation.queue = delegation.queue.then(async () => {
			let response: BridgeResponse;
			try {
				response = await handle(running, request);
			} catch (error) {
				response = {
					accepted: false,
					text: `Rejected by the parent: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (!response.accepted)
				run.driver.outstandingNested = Math.max(
					0,
					run.driver.outstandingNested - 1,
				);
			try {
				writeBridgeResponse(run.bridge!, request.nonce, response);
			} catch {
				// The server times out and reports the request as unacknowledged.
			}
		});
	}
}

function nativeResumeAvailability(
	run: NativeRun,
	exit: ExitConfirmation,
): NativeResultReference["resume"] {
	if (exit.kind !== "confirmed")
		return {
			available: false,
			reason:
				"process exit is unconfirmed, so the session lease is retained until exit is confirmed",
		};
	if (run.driver.mode === "persistent")
		return {
			available: false,
			reason: "persistent specialists do not revive; spawn a new specialist",
		};
	if (!nativeSessionId(run))
		return {
			available: false,
			reason: "the native session identity was never published",
		};
	return { available: true };
}

function nativeTurnRecords(outcome: NativeRunOutcome): NativeTurnRecord[] {
	return outcome.turns.map((turn) => {
		const record: NativeTurnRecord = {
			id: turn.id,
			kind: turn.kind,
			outcome: turn.outcome ?? "unknown",
		};
		if (turn.error) record.error = turn.error;
		return record;
	});
}

/**
 * Watch a native harness child. Success requires correlated native hook/turn
 * evidence plus durable process exit; Herdr status only updates the widget.
 * Owned transient files and the session lease are released, and Git state is
 * captured, only after the owned process exit is confirmed. Otherwise the run
 * fails with a warning and its pane, Kiro profile, run files, lease, and
 * worktree lease are retained.
 */
async function watchNativeSubagent(
	running: RunningSubagent,
	signal: AbortSignal,
	deps: NativeWatchDependencies = defaultNativeWatchDependencies,
): Promise<SubagentResult> {
	const run = running.native;
	if (!run) throw new Error("Native watcher requires a native run.");
	const { name, task, surface, startTime, sessionFile } = running;
	const confirmExit =
		deps.confirmExit ?? ((processRun) => confirmProcessExit(processRun));
	// Every settlement path (ticks, the final outcome, watcher errors) feeds
	// one durable, deduplicated queue before any delivery attempt.
	const onTurnSettled = (turn: NativeTurn) => {
		queueNativePersistentTask(running, turn);
		try {
			flushNativePersistentDeliveries(running, runtime.pi);
		} catch {
			// Ledger I/O failure: the queued task is retried next tick.
		}
		deps.onTurnSettled?.(turn);
	};

	const settle = (
		exit: ExitConfirmation,
		outcome: NativeRunOutcome | { completed: false; summary: string },
		exitCode: number,
		detectedAt: number,
		extra: Partial<SubagentResult> = {},
	): SubagentResult => {
		const native: NativeResultReference = {
			harness: run.harness,
			sessionId: nativeSessionId(run),
			markerFile: run.markerFile,
			processExit: exit.kind,
			mode: run.driver.mode,
			model: run.model,
			resume: nativeResumeAvailability(run, exit),
		};
		if ("turns" in outcome) {
			native.turns = nativeTurnRecords(outcome);
			if (outcome.interrupted) native.interrupted = true;
			if (outcome.humanTurns) {
				native.humanTurns = outcome.humanTurns;
				if (outcome.lastHumanSummary)
					native.lastHumanSummary = outcome.lastHumanSummary;
			}
		}
		if (running.nativeDelegation?.children.size)
			native.nested = [...running.nativeDelegation.children.values()];
		let worktreeHandoff: WorktreeHandoff | undefined;
		let summary = outcome.summary;
		let completed = outcome.completed;
		if (exit.kind === "confirmed") {
			releaseNativeRun(
				run,
				exit,
				completed ? "completed" : native.interrupted ? "interrupted" : "failed",
				{ keepWorktreeLease: running.nativeHoldWorktreeLease },
			);
			const warnings: string[] = [];
			if (exit.unreadableCount > 0)
				warnings.push(
					`exit was confirmed by an owned-process scan that could not inspect ${exit.unreadableCount} same-user process(es)`,
				);
			if (warnings.length) native.warning = `${warnings.join("; ")}.`;
			worktreeHandoff = finalizeSubagentWorktree(
				running,
				completed ? "ready_for_review" : "failed",
			);
		} else {
			completed = false;
			native.warning = `native process exit is unconfirmed (${exit.reason}); the run is unresolved and treated as failed.`;
			native.surface = surface;
			native.retained = [
				...retainedNativeEvidence(run),
				...(running.worktree ? [running.worktree.path] : [`pane ${surface}`]),
			];
			if (!summary.includes("exit is unconfirmed"))
				summary = `${summary} Native process exit is unconfirmed: ${exit.reason}.`;
			unresolvedNativeRuns().set(running.id, {
				run,
				worktreePath: running.worktree?.path,
			});
			worktreeHandoff = retainUnconfirmedNativeWorktree(running, exit.reason);
		}
		const code = completed ? 0 : exitCode || 1;
		running.lifecycle = markCompletionDetected(
			ensureLifecycle(running),
			completed
				? { reason: "done", exitCode: 0 }
				: { reason: "error", exitCode: code, errorMessage: summary },
			detectedAt,
		);
		running.lifecycle = completed
			? markCompleted(running.lifecycle, Date.now())
			: markFailed(running.lifecycle, summary, Date.now(), code);
		updateWidget();
		const result: SubagentResult = {
			name,
			task,
			summary,
			sessionFile,
			exitCode: code,
			elapsed: Math.floor((detectedAt - startTime) / 1000),
			runtimePlan: undefined,
			native,
			...extra,
		};
		if ("turns" in outcome) result.nativeOutcome = outcome;
		if (!completed && !extra.error) result.errorMessage = summary;
		if (worktreeHandoff) result.worktree = worktreeHandoff;
		return result;
	};

	try {
		const exit = await waitForNativeCompletion(run, signal, {
			intervalMs: deps.intervalMs,
			terminationGraceMs: deps.terminationGraceMs,
			send: (text) => deps.send(surface, text),
			terminate: () => deps.terminate(run.processRun),
			inspectPane: () => deps.inspectPane(surface),
			onPaneInspection: (inspection, observedAt) => {
				running.lifecycle = observePaneInspection(
					ensureLifecycle(running),
					inspection,
					observedAt,
				);
				updateWidget();
			},
			onStarted: (observedAt) => {
				running.lifecycle = markProcessRunning(
					ensureLifecycle(running),
					observedAt,
				);
			},
			onTick: () => {
				try {
					serviceNativeBridge(running, deps);
				} catch {
					// A bridge I/O failure leaves requests for the next tick.
				}
				try {
					flushNativePersistentDeliveries(running, runtime.pi);
				} catch {
					// Ledger I/O failure: the queued task is retried next tick.
				}
			},
			onTurnSettled,
		});
		const detectedAt = Date.now();
		// Turns settled only now (a Stop written just before a fast exit)
		// reach the same durable queue as turns settled during ticks.
		const outcome = nativeOutcome(run, exit, onTurnSettled);
		if (exit.interrupted) outcome.interrupted = true;
		return settle(exit.exit, outcome, exit.exitCode, detectedAt);
	} catch (err: any) {
		// Parent shutdown aborts the watcher without terminating the child,
		// matching Pi children. Release only an already-confirmed exit.
		const message = signal.aborted
			? "Subagent cancelled."
			: (err?.message ?? String(err));
		const summary = signal.aborted ? message : `Subagent error: ${message}`;
		if (!signal.aborted)
			try {
				// Record any turn a receipt already settled; never guess others.
				nativeOutcome(
					run,
					{ reason: "error", exitCode: 1, errorMessage: summary },
					onTurnSettled,
				);
			} catch {
				// Settlement evidence stays in the run directory.
			}
		return settle(
			confirmExit(run.processRun),
			{ completed: false, summary },
			1,
			Date.now(),
			{ error: signal.aborted ? "cancelled" : message },
		);
	}
}

export function shouldAdvanceToFallback(
	result: Pick<SubagentResult, "errorMessage">,
	remainingPlans: number,
	persistent = false,
): boolean {
	return !persistent && result.errorMessage !== undefined && remainingPlans > 0;
}

async function watchSubagentWithFallbacks(
	initial: RunningSubagent,
	initialPlanIndex: number,
	params: typeof SubagentParams.static,
	ctx: Parameters<typeof launchSubagent>[1],
	parentThinking: ThinkingLevel,
	plans: ResolvedRuntimePlan[],
	signal: AbortSignal,
	completedPanes: Set<string>,
	initialLaunchFailures: ModelFailure[] = [],
	extra: { forceLeaf?: boolean; agentDefs?: AgentDefaults | null } = {},
): Promise<{ running: RunningSubagent; result: SubagentResult }> {
	let running = initial;
	let nextPlan = initialPlanIndex + 1;
	const attempts = plans
		.slice(0, initialPlanIndex + 1)
		.map((plan) => plan.model);
	const modelFailures = [...initialLaunchFailures];

	for (;;) {
		const result = await watchSubagent(running, signal);
		if (!running.worktree) completedPanes.add(running.surface);
		// An automatic child never retries another model: it may have worked.
		const shouldRetry =
			!running.autoRouting &&
			shouldAdvanceToFallback(
				result,
				plans.length - nextPlan,
				running.persistent,
			);
		if (result.errorMessage) {
			modelFailures.push({
				model: running.runtimePlan?.model ?? attempts[attempts.length - 1],
				error: result.errorMessage,
			});
		}
		if (!shouldRetry) {
			return {
				running,
				result: {
					...result,
					fallbackAttempts: attempts,
					fallbackFailures: modelFailures,
				},
			};
		}

		runningSubagents.delete(running.id);
		updateWidget();
		const launchFailures: ModelFailure[] = [];
		let launchedFallback = false;
		while (nextPlan < plans.length) {
			const plan = plans[nextPlan++];
			attempts.push(plan.model);
			try {
				running = await launchSubagent(params, ctx, parentThinking, {
					runtimePlan: plan,
					id: initial.id,
					forceLeaf: extra.forceLeaf,
					agentDefs: extra.agentDefs,
				});
				if (initial.nestedOf) running.nestedOf = initial.nestedOf;
				// Every attempt keeps the spawn's one immutable selection.
				running.selection = initial.selection;
				running.runtimeProvenance = initial.runtimeProvenance;
				if (initial.autoRouting) running.autoRouting = initial.autoRouting;
				running.abortController = initial.abortController;
				launchedFallback = true;
				startWidgetRefresh();
				startStatusRefresh(runtime.pi!);
				break;
			} catch (error) {
				launchFailures.push({
					model: plan.model,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		modelFailures.push(...launchFailures);
		if (!launchedFallback) {
			return {
				running,
				result: {
					...result,
					errorMessage: `${result.errorMessage}\n\nFallback launch failures: ${launchFailures.map(({ model, error }) => `${model}: ${error}`).join("; ")}`,
					fallbackAttempts: attempts,
					fallbackFailures: modelFailures,
				},
			};
		}
	}
}

/**
 * Verify a worktree-bound native session's retained checkout before resume:
 * same path, branch, and workspace as recorded, still registered in Git, not
 * removed, and not leased by any live or unresolved child.
 */
function verifyResumeWorktree(
	binding: NonNullable<NativeSessionMarker["loadout"]["worktree"]>,
	cwd: string,
	markerFile: string,
): { worktree: WorktreeLaunch } | { error: string } {
	if (binding.path !== cwd)
		return { error: "its worktree binding does not match its cwd" };
	if (!binding.manifestFile)
		return { error: "its worktree ownership manifest is not recorded" };
	const manifest = readWorktreeManifest(binding.manifestFile);
	if (!manifest)
		return {
			error: `its worktree manifest ${binding.manifestFile} is missing`,
		};
	if (manifest.state === "removed")
		return { error: "its managed worktree was removed" };
	if (
		manifest.path !== binding.path ||
		manifest.branch !== binding.branch ||
		manifest.workspaceId !== binding.workspaceId
	)
		return {
			error: "its worktree manifest disagrees with the recorded binding",
		};
	const git = (args: string[]) =>
		execFileSync("git", ["-C", binding.path, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	try {
		if (
			realpathSync(git(["rev-parse", "--show-toplevel"])) !==
			realpathSync(binding.path)
		)
			return { error: "its worktree path is no longer a checkout root" };
		if (git(["symbolic-ref", "--short", "HEAD"]) !== binding.branch)
			return { error: `its worktree is no longer on branch ${binding.branch}` };
	} catch (error) {
		return {
			error: `its worktree could not be verified (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	for (const running of runningSubagents.values())
		if (running.worktree?.path === binding.path)
			return {
				error: `its worktree is leased by live child "${running.name}"`,
			};
	for (const entry of reconcileUnresolvedNativeRuns())
		if (entry.worktreePath === binding.path)
			return {
				error:
					"its worktree is leased by a native run whose exit is unconfirmed",
			};
	// In-memory holders vanish when a parent crashes; the durable lease names
	// the last native driver, which must be provably gone (descendants too).
	const lease = inspectRunLease(nativeWorktreeLeaseFile(binding.manifestFile));
	if (lease.kind === "held" || lease.kind === "invalid")
		return {
			error: `its worktree is still leased by a native run: ${lease.reason}`,
		};
	return {
		worktree: {
			path: binding.path,
			workspaceId: binding.workspaceId,
			paneId: isString(manifest.paneId) ? manifest.paneId : "",
			branch: binding.branch,
			baseRef: isString(manifest.baseRef) ? manifest.baseRef : binding.baseSha,
			baseSha: binding.baseSha,
			manifestFile: binding.manifestFile,
			sessionFile: markerFile,
		},
	};
}

/**
 * Resume a native session with exactly its recorded loadout: tools, model,
 * thinking, identity, skills already in its history, nested-spawn grant, and
 * cwd/worktree binding. Nothing in the call can widen them.
 */
async function resumeNativeSession(
	pi: ExtensionAPI,
	params: {
		sessionPath: string;
		name?: string;
		message?: string;
		autoExit?: boolean;
	},
	ctx: Parameters<typeof launchSubagent>[1],
	signal?: AbortSignal,
): Promise<AgentToolResult<any>> {
	const markerFile = resolve(params.sessionPath);
	// SAFETY: the caller checked the marker parses.
	const marker = readNativeSessionMarker(markerFile)!;
	const label = nativeHarnessLabel(marker.harness);
	const fail = (reason: string, code = "native-resume-rejected") => ({
		content: [
			{
				type: "text" as const,
				text: `Error: cannot resume native ${label} session ${markerFile}: ${reason}. Nothing was launched.`,
			},
		],
		details: { error: code },
	});
	const check = checkNativeResume(marker, markerFile);
	if (!check.ok) return fail(check.error);
	const message = params.message?.trim();
	if (!message)
		return fail(
			"a non-empty message is required; it becomes the resumed run's correlated tagged turn",
		);
	for (const running of runningSubagents.values())
		if (running.native?.markerFile === markerFile)
			return fail(`it is still driven by running subagent "${running.name}"`);
	for (const entry of reconcileUnresolvedNativeRuns())
		if (entry.run.markerFile === markerFile)
			return fail("an earlier run's process exit is still unconfirmed");
	let boundWorktree: WorktreeLaunch | undefined;
	if (check.marker.loadout.worktree) {
		const verified = verifyResumeWorktree(
			check.marker.loadout.worktree,
			check.marker.cwd,
			markerFile,
		);
		if ("error" in verified) return fail(verified.error);
		boundWorktree = verified.worktree;
	} else if (!existsSync(check.marker.cwd))
		return fail("its working directory no longer exists");
	if (!terminalReady()) return muxUnavailableResult();
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) return fail("the parent has no session file");
	// Resume replays the recorded mode exactly; autoExit may only restate it.
	const recordedMode = check.marker.loadout.mode;
	if (recordedMode !== "autonomous" && recordedMode !== "interactive")
		return fail(`its recorded mode ${recordedMode} is not resumable`);
	if (
		params.autoExit !== undefined &&
		params.autoExit !== (recordedMode === "autonomous")
	)
		return fail(
			`autoExit: ${params.autoExit} would change its recorded ${recordedMode} mode; omit autoExit to resume in the recorded mode`,
		);
	const mode = recordedMode;
	const id = randomUUID();
	const name = params.name ?? check.marker.name ?? "Resume";
	let running: RunningSubagent;
	try {
		running = await launchNativeTracked({
			kind: "native",
			id,
			name,
			task: message,
			agent: check.marker.agent,
			parent: {
				cwd: ctx.cwd,
				invocationCwd: process.cwd(),
				sessionFile: parentSessionFile,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionDir: ctx.sessionManager.getSessionDir(),
				agentDir: getAgentConfigDir(),
			},
			behavior: { interactive: mode === "interactive" },
			resume: { marker: check.marker, markerFile, message, mode },
			boundWorktree,
			signal,
		});
	} catch (error) {
		if (error instanceof NativeLaunchUnresolvedError)
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: resuming native ${label} session ${markerFile} failed after its process may have started: ${error.message}`,
					},
				],
				details: { error: "native-resume-unresolved" },
			};
		return fail(error instanceof Error ? error.message : String(error));
	}
	running.resumedNative = true;
	const run = running.native!;
	if (check.marker.loadout.spawnAgents) {
		const thinking = pi.getThinkingLevel();
		running.nativeDelegation = {
			ctx,
			parentThinking: isThinkingLevel(thinking) ? thinking : "medium",
			tools: new Set(check.marker.loadout.tools.split(",").filter(Boolean)),
			agents: [...check.marker.loadout.spawnAgents],
			cwd: check.marker.cwd,
			children: new Map(),
			total: 0,
			queue: Promise.resolve(),
		};
	}
	runningSubagents.set(id, running);
	startWidgetRefresh();
	startStatusRefresh(pi);
	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;
	let closePane = false;
	watchSubagent(running, watcherAbort.signal)
		.then((result) => {
			runningSubagents.delete(running.id);
			updateWidget();
			if (!shouldDeliverSubagentCompletion(running)) {
				running.lifecycle = markDelivery(running.lifecycle, "suppressed");
				closePane = result.native?.processExit !== "unconfirmed";
				return;
			}
			running.lifecycle = markDelivery(running.lifecycle, "delivered");
			const details: SubagentResultDetails = {
				name,
				task: message,
				agent: running.agent,
				exitCode: result.exitCode,
				elapsed: result.elapsed,
				sessionFile: markerFile,
			};
			if (result.errorMessage) details.errorMessage = result.errorMessage;
			if (result.worktree) details.worktree = result.worktree;
			if (result.native) details.native = result.native;
			sendSubagentResult(
				selectCompletionApi(pi, runtime.pi),
				resolveResultPresentation(result, name),
				details,
			);
			closePane = result.native?.processExit !== "unconfirmed";
			closePaneAfterLateExit(running, result.native);
		})
		.catch((err) => {
			runningSubagents.delete(running.id);
			updateWidget();
			// Release the session and worktree leases only after a fresh exit
			// check; an unconfirmed run is retained for reconciliation.
			const settlement = settleThrownNativeWatcher(running, run);
			closePane = settlement.native.processExit === "confirmed";
			if (!shouldDeliverSubagentCompletion(running)) return;
			running.lifecycle = markDelivery(running.lifecycle, "delivered");
			const details: SubagentResultDetails = {
				name,
				error: err?.message,
				sessionFile: markerFile,
				native: settlement.native,
			};
			if (settlement.worktree) details.worktree = settlement.worktree;
			sendSubagentResult(
				selectCompletionApi(pi, runtime.pi),
				boundResultPresentation(
					`Native resume error for "${name}": ${err?.message ?? String(err)}`,
					formatNativeSessionReference(settlement.native),
				),
				details,
			);
			closePaneAfterLateExit(running, settlement.native);
		})
		.finally(() => {
			if (closePane) closeCompletedPanes([running.surface]);
		});
	return {
		content: [
			{
				type: "text",
				text:
					`Native ${label} session "${name}" resumed with its recorded loadout (${mode}). ` +
					"This is a fire-and-forget call: its result is delivered automatically as a steer message. Do not poll." +
					(boundWorktree
						? ` It runs in an ordinary pane at the retained worktree ${boundWorktree.path} and holds that worktree's lease until its exit is confirmed.`
						: ""),
			},
		],
		details: {
			id,
			name,
			sessionPath: markerFile,
			launchScriptFile: running.launchScriptFile,
			harness: run.harness,
			nativeSessionId: nativeSessionId(run),
			status: "started",
		},
	};
}

/**
 * The terminal notice for a persistent specialist whose process ended: a
 * confirmed stop, a stop whose exit is unconfirmed, or an exit without a
 * stop request. Undelivered native task results travel inside the notice.
 */
function sendPersistentTerminalNotice(
	running: RunningSubagent,
	result: SubagentResult,
	api: Pick<ExtensionAPI, "sendMessage">,
	undelivered: NativeSettledTask[],
): void {
	const stopRequested =
		running.stopState === "requested" || running.stopState === "pending";
	if (
		running.native &&
		result.native?.processExit === "unconfirmed" &&
		stopRequested
	) {
		// State changes only after the notice is sent, so a retry resends it.
		sendPersistentStopFailure(api, running);
		running.stopState = "failed";
		running.stopFailure =
			"native process exit was not confirmed after the graceful exit command";
		return;
	}
	if (stopRequested) {
		if (!running.stopRecorded) {
			try {
				appendPersistentDeliveryLedger(running.sessionFile, {
					task: "stop",
					outcome: "stopped",
					generation: running.generationId!,
					logicalId: running.logicalId!,
					policyHash: running.policyHash!,
				});
			} catch (error) {
				// A native stop notice is still sent; the ledger is evidence only.
				if (!running.native) throw error;
			}
			running.stopRecorded = true;
		}
		const facts = persistentSpecialistFacts(running);
		api.sendMessage(
			{
				customType: "subagent_stop",
				content: `Persistent specialist stopped.${formatUndeliveredTasks(undelivered)}\n\n${formatPersistentSpecialistFacts(facts)}`,
				display: true,
				details: persistentNoticeDetails(running, {
					status: "stopped",
					facts,
				}),
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
		return;
	}
	if (running.stopState !== "failed")
		notifyPersistentCrash(running, api, undelivered, result.errorMessage);
}

function formatUndeliveredTasks(undelivered: NativeSettledTask[]): string {
	if (!undelivered.length) return "";
	return `\n\nTask results that could not be delivered separately:${undelivered
		.map(
			(entry) =>
				`\n- ${entry.task} (${entry.outcome}): ${abbreviateMiddle(entry.summary ?? entry.error ?? "no output", 2_000, " [...] ")}`,
		)
		.join("")}`;
}

/** Per-call preparation options that are not tool parameters. */
interface PrepareSubagentOptions {
	/** Deny every spawning tool regardless of the role (nested leaves). */
	forceLeaf?: boolean;
	/** A verified administrator-approved tuple for an automatic spawn. */
	auto?: AutoLaunchAuthorization;
}

/**
 * Read-only inputs that the preparations of one automatic candidate snapshot
 * share, so the role catalog, installed skills, and native prerequisites are
 * read once per snapshot and never across prompts. Omitted inputs are read
 * fresh, as every launch does.
 */
interface PreparationReads {
	catalog?: AgentCatalog;
	installedSkills?: () => InstalledSkill[];
	nativeOperations?: NativeHarnessOperations;
}

/** Per-call launch options that are not tool parameters. */
interface StartSubagentOptions extends PrepareSubagentOptions {
	/** Results go to the requesting native child instead of the parent. */
	nestedOf?: NestedOrigin;
	/** Aborts a native launch before its process is dispatched. */
	signal?: AbortSignal;
	/**
	 * A run from prepareSubagentRun, or its automatic snapshot handle,
	 * launched with its own options. Launch consumes it once and starts only
	 * if a fresh preparation is identical.
	 */
	prepared?: PendingPreparedRun;
	/**
	 * The coordinator's binding for an automatic prepared run: its resource
	 * and dispatch guards, cancellation, dispatch latch, and lifecycle.
	 * Every launch of an automatic tuple requires it, and it authorizes only
	 * the pending prepared handle it was created for.
	 */
	autoRun?: AutoRunBinding;
}

/**
 * Everything one fresh spawn resolves before any Herdr resource: the role
 * snapshot, harness selection and projection, modes, Pi runtime plans or the
 * native plan, and prerequisites. Preparing creates no pane, workspace,
 * worktree, file, or lease.
 */
interface PreparedSubagentRun {
	readonly params: Readonly<Static<typeof SubagentParams>>;
	/** The precedence-resolved role before projection; null for bare spawns. */
	readonly role: ListedAgentDefinition | null;
	readonly selection: SubagentSelection;
	/** The role as the effective harness sees it; null for bare spawns. */
	readonly agentDefs: ListedAgentDefinition | null;
	readonly persistent: boolean;
	readonly forceLeaf: boolean;
	readonly parentThinking: ThinkingLevel;
	/** Pi plans in fallback order; empty for a native harness. */
	readonly runtimePlans: ResolvedRuntimePlan[];
	readonly nativePlan?: NativeLaunchPlan;
	/** Canonical origin of the effective model and thinking. */
	readonly provenance: RuntimeProvenance;
	readonly auto?: AutoLaunchAuthorization;
	/** The checkout and parent session the run was prepared for. */
	readonly origin: PreparedRunOrigin;
}

/**
 * What launch reads from a pending prepared run. Its plan is never launched
 * as held: launch prepares afresh and must resolve identically.
 */
type PendingPreparedRun = Pick<
	PreparedSubagentRun,
	"params" | "forceLeaf" | "auto" | "origin"
>;

/**
 * A prepared run as an automatic snapshot holds it: identical, except that
 * native skill snapshots keep their hashes but not their file bytes.
 */
type AutoPreparedSubagentRun = Omit<PreparedSubagentRun, "nativePlan"> & {
	readonly nativePlan?: AutoNativePlanView;
};

/** The checkout and parent session one prepared run is bound to. */
interface PreparedRunOrigin {
	/** Canonical parent cwd (`ctx.cwd`). */
	readonly cwd: string;
	/** Canonical `process.cwd()`, where project roles are discovered. */
	readonly discoveryCwd: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly sessionDir: string;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function preparedRunOrigin(
	ctx: Parameters<typeof launchSubagent>[1],
): PreparedRunOrigin {
	return Object.freeze({
		cwd: canonicalPath(ctx.cwd ?? process.cwd()),
		discoveryCwd: canonicalPath(process.cwd()),
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? "",
		sessionDir: ctx.sessionManager.getSessionDir(),
	});
}

/** Native CLI and hook prerequisite checks: the test seam's, else the real ones. */
function nativeHarnessOperations(): NativeHarnessOperations {
	return (
		runtime.nativeTestSeam?.nativeOperations ?? createNativeHarnessOperations()
	);
}

type SubagentPreparation =
	| { ok: true; prepared: PreparedSubagentRun }
	| { ok: false; result: AgentToolResult<any> };

/** Prepared runs not yet launched, with the launch key recorded at preparation. */
const unlaunchedPreparedRuns = new WeakMap<PendingPreparedRun, string>();

function rejected(result: AgentToolResult<any>): SubagentPreparation {
	return { ok: false, result };
}

/** Everything a launch depends on, so any change after preparation is detected. */
function preparedRunKey(prepared: PreparedSubagentRun): string {
	const native = prepared.nativePlan;
	return JSON.stringify({
		params: prepared.params,
		role: prepared.role,
		selection: prepared.selection,
		agentDefs: prepared.agentDefs,
		persistent: prepared.persistent,
		forceLeaf: prepared.forceLeaf,
		parentThinking: prepared.parentThinking,
		runtimePlans: prepared.runtimePlans,
		native: native && {
			spec: native.spec,
			models: native.models,
			skills: native.skills.map((skill) => ({
				name: skill.name,
				sha256: skill.sha256,
				snapshot: skill.snapshot?.sha256 ?? null,
			})),
			lineage: native.lineage?.mode ?? null,
			initialText: native.initialText,
		},
		provenance: prepared.provenance,
		auto: prepared.auto && {
			configDigest: prepared.auto.configDigest,
			candidate: prepared.auto.candidate.id,
		},
		origin: prepared.origin,
	});
}

/** A native capability failure, attributed to its projection when switched. */
function nativeProjectionError(
	selection: SubagentSelection,
	reason: string,
): AgentToolResult<any> {
	const text =
		selection.projected && selection.role
			? `Role "${selection.role.name}" cannot be projected from ${selection.role.harness} to ${selection.harness}: ${reason}`
			: reason;
	return {
		content: [{ type: "text", text: `Error: ${text}` }],
		details: { error: "native-harness-unsupported" },
	};
}

/** Per-call fields an automatic spawn never sets; its role runs as declared. */
const AUTO_FORBIDDEN_OVERRIDES = [
	"thinking",
	"systemPrompt",
	"skills",
	"tools",
	"cwd",
	"fork",
	"persistent",
	"interactive",
] as const;

/**
 * Why an approved role cannot run as an automatic spawn. An automatic child
 * is an autonomous, standalone, non-persistent leaf in the parent's cwd that
 * runs its role exactly as declared: no per-call override, and no role
 * capability is stripped to make it eligible.
 */
function autoLaunchIneligibility(
	params: Static<typeof SubagentParams>,
	agentDefs: ListedAgentDefinition,
): string | undefined {
	const overrides = AUTO_FORBIDDEN_OVERRIDES.filter(
		(key) => params[key] !== undefined,
	).join(", ");
	if (overrides || params.worktree != null)
		return `An automatic spawn cannot set ${overrides || "worktree"}; it runs its approved role as declared.`;
	const name = agentDefs.name;
	if (agentDefs.disableModelInvocation)
		return `Role "${name}" is hidden from model invocation and cannot run automatically.`;
	if (
		resolveEffectivePersistent(params, agentDefs) ||
		!resolveEffectiveAutoExit(params, agentDefs) ||
		resolveEffectiveInteractive(params, agentDefs) ||
		resolveEffectiveSessionMode(params, agentDefs) !== "standalone"
	)
		return `Role "${name}" is not an autonomous, standalone, non-persistent role and cannot run automatically.`;
	if (agentDefs.cwd)
		return `Role "${name}" overrides cwd; an automatic spawn runs in the parent's cwd.`;
	const tools = (agentDefs.tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (
		tools.length === 0 ||
		tools.some((tool) => SPAWNING_TOOLS.has(tool)) ||
		agentDefs.spawning !== false ||
		agentDefs.spawnAgents?.trim()
	)
		return `Role "${name}" is not a declared leaf (explicit tools without orchestration tools, spawning: false, no spawn-agents); an automatic spawn never strips a role capability.`;
	return undefined;
}

/**
 * Canonical origin of one native model or effort chosen by the caller or the
 * role. Mirrors resolveNativeLaunchSpec: a supplied request value wins even
 * when empty, and `default` without a key is the native CLI's own default.
 */
function nativeFieldProvenance(
	requestValue: string | undefined,
	roleValue: string | undefined,
): RuntimeFieldProvenance {
	const role = roleValue?.trim();
	if (requestValue != null)
		return { source: requestValue.trim() ? "request" : "default" };
	return { source: role ? "role" : "default" };
}

/**
 * What an automatic tuple replaces, recorded as provenance only and never a
 * fallback: the model and thinking the precedence-resolved role would get on
 * its own declared harness, tagged with that harness when the tuple runs on
 * another one, so a cross-harness pin is reported truthfully.
 */
function autoReplacedDefaults(
	role: ListedAgentDefinition,
	harness: SubagentHarness,
): RuntimeDefaults {
	const declared: SubagentHarness = role.cli ?? "pi";
	const own: RuntimeDefaults =
		declared === "pi"
			? resolveRuntimeDefaults(role.name, role)
			: {
					model: role.model,
					thinking: role.thinking,
					origin: {
						model: role.model?.trim() ? { source: "role" } : undefined,
					},
				};
	if (declared === harness) return own;
	const model = own.origin?.model;
	return {
		...own,
		origin: {
			model: model && { ...model, harness: declared },
			thinking: { source: "role", harness: declared },
		},
	};
}

/**
 * Resolve and validate one fresh spawn without creating anything: the role
 * snapshot, harness projection, modes, the native plan or Pi runtime plans,
 * and the Herdr and session prerequisites. Every rejection happens here,
 * before Herdr creates a pane, workspace, or worktree, and preparation never
 * writes a file or takes a lease. Shared by launch and by trusted internal
 * callers that must know a spawn is feasible before choosing it.
 */
function prepareSubagentRun(
	pi: ExtensionAPI,
	params: Static<typeof SubagentParams>,
	ctx: Parameters<typeof launchSubagent>[1],
	options: PrepareSubagentOptions = {},
	reads: PreparationReads = {},
): SubagentPreparation {
	const { auto } = options;
	const catalog = params.agent
		? (reads.catalog ?? discoverAgentCatalog(runtime.pi))
		: undefined;
	const roleDiagnostic =
		catalog && !catalog.agents.some((agent) => agent.name === params.agent)
			? catalog.diagnostics.find(
					(candidate) =>
						candidate.agentName === params.agent &&
						(candidate.code === "external-cli-unsupported" ||
							candidate.code === "native-harness-unsupported" ||
							candidate.code === "invalid-capability-declaration"),
				)
			: undefined;
	if (roleDiagnostic) {
		return rejected({
			content: [{ type: "text", text: `Error: ${roleDiagnostic.message}` }],
			details: { error: roleDiagnostic.code },
		});
	}

	// The role is resolved once; every launch attempt uses this snapshot.
	const role =
		(params.agent &&
			catalog?.agents.find((agent) => agent.name === params.agent)) ||
		null;
	if (params.agent && !role) {
		// Unresolved roles fail before any resource, whatever the harness.
		const diagnostic = catalog?.diagnostics.find(
			(candidate) => candidate.agentName === params.agent,
		);
		return rejected({
			content: [
				{
					type: "text",
					text: `Error: ${diagnostic?.message ?? `Agent "${params.agent}" was not found.`}`,
				},
			],
			details: { error: diagnostic?.code ?? "agent-not-found" },
		});
	}
	const projection = resolveRoleProjection(params, role, auto);
	if (!projection.ok) {
		return rejected({
			content: [{ type: "text", text: `Error: ${projection.message}` }],
			details: { error: projection.error },
		});
	}
	const { selection, agentDefs: selectedDefs } = projection;
	const autoRejection =
		auto && selectedDefs
			? autoLaunchIneligibility(params, selectedDefs)
			: undefined;
	if (autoRejection)
		return rejected({
			content: [{ type: "text", text: `Error: ${autoRejection}` }],
			details: { error: "auto-launch-ineligible" },
		});
	// Automatic spawns are leaves whose model and effort come only from the
	// approved tuple; role and configured defaults are never fallbacks.
	const forceLeaf = options.forceLeaf === true || auto !== undefined;
	const runtimeParams = auto
		? { ...params, model: auto.model, thinking: auto.effort }
		: params;

	// Native harness capability checks run before any Herdr resource.
	let nativeSpec: NativeLaunchSpec | undefined;
	if (selection.harness !== "pi" && selectedDefs) {
		try {
			nativeSpec = resolveNativeSpecForParams(runtimeParams, {
				...selectedDefs,
				cli: selection.harness,
			});
		} catch (error) {
			return rejected(
				nativeProjectionError(
					selection,
					error instanceof Error ? error.message : String(error),
				),
			);
		}
		if (
			auto &&
			(nativeSpec.modelRequest.kind !== "exact" ||
				nativeSpec.model !== auto.model ||
				nativeSpec.thinking !== auto.effort)
		)
			return rejected(
				nativeProjectionError(
					selection,
					`cannot run approved model ${JSON.stringify(auto.model)} at effort ${auto.effort} exactly.`,
				),
			);
	}

	const persistent = resolveEffectivePersistent(params, selectedDefs);
	const capError = persistent ? persistentCapacityError() : undefined;
	if (capError) {
		return rejected({
			content: [{ type: "text", text: capError }],
			details: { error: "persistent-cap" },
		});
	}

	// Native models, skills, inherited context, and prompt bounds resolve
	// before the Herdr check and before any Herdr resource exists.
	let nativePlan: NativeLaunchPlan | undefined;
	if (nativeSpec) {
		// Nested children are leaves: a delegated native child never delegates.
		if (forceLeaf) nativeSpec.spawnAgents = null;
		try {
			nativePlan = planNativeLaunch(nativeSpec, {
				task: params.task,
				parentSessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined,
				installedSkills:
					reads.installedSkills ??
					(() => discoverInstalledSkills(pi, ctx.cwd ?? process.cwd())),
				snapshotRoot: nativeSkillSnapshotRoot(ctx),
				nativeTasks: modelConfig.native,
				isPiModelRef: (value) => isPiModelRef(ctx.modelRegistry, value),
			});
		} catch (error) {
			return rejected(
				nativeProjectionError(
					selection,
					error instanceof Error ? error.message : String(error),
				),
			);
		}
	}

	// Validate prerequisites
	if (!terminalReady()) {
		return rejected(muxUnavailableResult());
	}

	if (!ctx.sessionManager.getSessionFile()) {
		return rejected({
			content: [
				{
					type: "text",
					text: "Error: no session file. Start pi with a persistent session to use subagents.",
				},
			],
			details: { error: "no session file" },
		});
	}

	const parentThinking = pi.getThinkingLevel();
	if (
		parentThinking !== "off" &&
		parentThinking !== "minimal" &&
		parentThinking !== "low" &&
		parentThinking !== "medium" &&
		parentThinking !== "high" &&
		parentThinking !== "xhigh" &&
		parentThinking !== "max"
	) {
		throw new Error(`Unsupported parent thinking level: ${parentThinking}`);
	}
	// What an automatic tuple replaces comes from the role as declared,
	// before projection dropped a pin that belongs to another harness.
	const replaced =
		auto && role ? autoReplacedDefaults(role, selection.harness) : undefined;
	// Native harnesses pass their own model IDs through; Pi routing never applies.
	const runtimePlans = nativeSpec
		? []
		: resolveSubagentRuntimePlans(
				params,
				ctx,
				parentThinking,
				selectedDefs,
				auto && replaced ? { authorization: auto, replaced } : undefined,
			);
	// Native CLI and hook prerequisites are read-only checks, made here after
	// the Herdr, session, and runtime checks, and again by the launch itself.
	if (nativePlan)
		(reads.nativeOperations ?? nativeHarnessOperations()).assertAvailable(
			nativePlan.spec.harness,
		);
	const provenance: RuntimeProvenance | undefined = !(
		nativeSpec && selectedDefs
	)
		? runtimePlans[0]?.provenance
		: replaced
			? {
					version: 1,
					model: automaticFieldProvenance(
						replaced.model,
						replaced.origin?.model,
					),
					thinking: automaticFieldProvenance(
						replaced.thinking,
						replaced.origin?.thinking ?? { source: "role" },
					),
				}
			: {
					version: 1,
					model: nativeFieldProvenance(params.model, selectedDefs.model),
					thinking: nativeFieldProvenance(
						params.thinking,
						selectedDefs.thinking,
					),
				};
	if (!provenance)
		throw new Error("Subagent runtime provenance could not be resolved.");

	const preparedParams = { ...params };
	if (params.worktree)
		preparedParams.worktree = Object.freeze({ ...params.worktree });
	const prepared: PreparedSubagentRun = Object.freeze({
		params: Object.freeze(preparedParams),
		role,
		selection,
		agentDefs: selectedDefs,
		persistent,
		forceLeaf,
		parentThinking,
		runtimePlans,
		nativePlan,
		provenance,
		auto,
		origin: preparedRunOrigin(ctx),
	});
	unlaunchedPreparedRuns.set(prepared, preparedRunKey(prepared));
	return { ok: true, prepared };
}

/**
 * The pending handle an automatic snapshot holds for a prepared run: the
 * same plain data without native skill file bytes, which freezing cannot
 * make immutable. It replaces the run as the one pending launch; the launch
 * re-reads the skills privately and starts only if every hash is identical.
 */
function snapshotSafePreparedRun(
	prepared: PreparedSubagentRun,
): AutoPreparedSubagentRun {
	const key = unlaunchedPreparedRuns.get(prepared);
	unlaunchedPreparedRuns.delete(prepared);
	const { nativePlan: native, ...run } = prepared;
	const handle: AutoPreparedSubagentRun = Object.freeze(
		native
			? {
					...run,
					nativePlan: {
						...native,
						skills: native.skills.map(({ snapshot, ...skill }) =>
							snapshot
								? {
										...skill,
										snapshot: {
											dir: snapshot.dir,
											sha256: snapshot.sha256,
											files: snapshot.files.map(
												({ content: _content, ...file }) => file,
											),
										},
									}
								: skill,
						),
					},
				}
			: run,
	);
	if (key !== undefined) unlaunchedPreparedRuns.set(handle, key);
	return handle;
}

/**
 * The launch authority automatic candidate snapshots are built with: normal
 * role discovery with its layered failures, installed skills, native
 * prerequisites, the Pi registry, and prepareSubagentRun under an
 * authorization minted from the loaded allowlist, returning snapshot-safe
 * handles. Every member is read-only; none creates a Herdr resource, file,
 * lease, or network request.
 */
function createAutoRoutingAuthority(
	pi: ExtensionAPI,
	ctx: Parameters<typeof launchSubagent>[1],
): AutoRoutingAuthority<AutoPreparedSubagentRun, AutoAgentCatalog> {
	return {
		context: () => ({
			origin: preparedRunOrigin(ctx),
			herdrAvailable: terminalReady(),
			parentRuntime: ctx.model
				? {
						provider: ctx.model.provider,
						modelId: ctx.model.id,
						thinking: pi.getThinkingLevel(),
					}
				: null,
		}),
		discoverRoles() {
			const failures: AgentLayerFailure[] = [];
			return {
				...discoverAgentCatalog(runtime.pi, bundledRoleConfig, failures),
				failures,
			};
		},
		installedSkills: () =>
			discoverInstalledSkills(pi, ctx.cwd ?? process.cwd()),
		skillSnapshotRoot: () => nativeSkillSnapshotRoot(ctx),
		nativeOperations: nativeHarnessOperations,
		piModels: () => wrapPiModelRegistry(ctx.modelRegistry),
		prepare(state, candidateId, params, reads) {
			let auto: AutoLaunchAuthorization;
			try {
				auto = createAutoLaunchAuthorization(state, candidateId);
			} catch (error) {
				return {
					ok: false,
					error: "auto-authorization-invalid",
					message: error instanceof Error ? error.message : String(error),
				};
			}
			const preparation = prepareSubagentRun(pi, params, ctx, { auto }, reads);
			if (preparation.ok)
				return {
					ok: true,
					prepared: snapshotSafePreparedRun(preparation.prepared),
				};
			return {
				ok: false,
				error: String(preparation.result.details?.error ?? "launch-rejected"),
				message: preparation.result.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join(""),
			};
		},
	};
}

/**
 * Consume a run prepared earlier: it launches at most once, and only when a
 * fresh preparation with the same authority resolves identically.
 */
function consumePreparedRun(
	pi: ExtensionAPI,
	params: Static<typeof SubagentParams>,
	ctx: Parameters<typeof launchSubagent>[1],
	prepared: PendingPreparedRun,
	options: StartSubagentOptions,
): SubagentPreparation {
	const key = unlaunchedPreparedRuns.get(prepared);
	unlaunchedPreparedRuns.delete(prepared);
	if (
		key === undefined ||
		params !== prepared.params ||
		options.auto !== undefined ||
		options.forceLeaf !== undefined
	)
		return rejected({
			content: [
				{
					type: "text",
					text: "Error: this prepared subagent run is not a pending preparation of these parameters. Prepare it again.",
				},
			],
			details: { error: "prepared-run-invalid" },
		});
	// A prepared run never moves to another checkout or parent session.
	if (
		JSON.stringify(preparedRunOrigin(ctx)) !== JSON.stringify(prepared.origin)
	)
		return rejected({
			content: [
				{
					type: "text",
					text: "Error: this prepared subagent run belongs to another checkout or parent session; nothing was launched.",
				},
			],
			details: { error: "prepared-run-context-changed" },
		});
	const fresh = prepareSubagentRun(pi, prepared.params, ctx, {
		forceLeaf: prepared.forceLeaf,
		auto: prepared.auto,
	});
	if (!fresh.ok) return fresh;
	unlaunchedPreparedRuns.delete(fresh.prepared);
	if (preparedRunKey(fresh.prepared) !== key)
		return rejected({
			content: [
				{
					type: "text",
					text: "Error: the subagent's role, runtime, or prerequisites changed after preparation; nothing was launched.",
				},
			],
			details: { error: "prepared-run-stale" },
		});
	return fresh;
}

/**
 * Validate, launch, and start watching one subagent. Every rejection happens
 * in prepareSubagentRun or the automatic binding check, before Herdr creates
 * a pane, workspace, or worktree. Shared by the subagent tool, authenticated nested-spawn
 * requests, and the routing coordinator's bound automatic prepared run.
 */
async function startSubagentRun(
	pi: ExtensionAPI,
	params: Static<typeof SubagentParams>,
	ctx: Parameters<typeof launchSubagent>[1],
	options: StartSubagentOptions = {},
): Promise<AgentToolResult<any>> {
	const { autoRun } = options;
	const invalidBinding: AgentToolResult<any> = {
		content: [
			{
				type: "text",
				text: "Error: this automatic run binding does not match the prepared tuple; nothing was launched.",
			},
		],
		details: { error: "auto-binding-invalid" },
	};
	// A binding authorizes only the one pending prepared handle the
	// coordinator created it for; any other pairing consumes nothing.
	if (
		autoRun &&
		(!options.prepared || !autoRunBindingAuthorizes(autoRun, options.prepared))
	)
		return invalidBinding;
	const preparation = options.prepared
		? consumePreparedRun(pi, params, ctx, options.prepared, options)
		: prepareSubagentRun(pi, params, ctx, {
				forceLeaf: options.forceLeaf,
				auto: options.auto,
			});
	if (!preparation.ok) return preparation.result;
	const {
		selection,
		agentDefs: selectedDefs,
		forceLeaf,
		parentThinking,
		runtimePlans,
		nativePlan,
		provenance,
		auto,
	} = preparation.prepared;
	// This launch consumes the preparation; it never starts a second run.
	unlaunchedPreparedRuns.delete(preparation.prepared);
	// An automatic tuple creates resources only under the coordinator's
	// binding; preparing one alone stays resource-free.
	if (auto && !autoRun)
		return {
			content: [
				{
					type: "text",
					text: "Error: an automatic run launches only under its routing decision's run binding; nothing was launched.",
				},
			],
			details: { error: "auto-binding-required" },
		};
	// The handle's fresh preparation must still be the binding's exact tuple.
	if (
		autoRun &&
		(!auto ||
			autoRun.approvalId !== auto.candidate.id ||
			autoRun.receipt.configHash !== auto.configDigest ||
			(nativePlan ? nativePlan.models.length : runtimePlans.length) !== 1)
	)
		return invalidBinding;
	// Automatic children suppress inherited routing and the Jev credential;
	// a bound launch also runs the coordinator's guards and cancellation.
	const automatic: AutomaticLaunch | undefined = auto
		? { guard: autoRun }
		: undefined;
	const nativeSignal =
		autoRun && options.signal
			? AbortSignal.any([autoRun.signal, options.signal])
			: (autoRun?.signal ?? options.signal);

	// Launch the subagent (creates pane, sends command)
	const noLaunchFailures: ModelFailure[] = [];
	const worktreeLaunchWarning = resolveWorktreeLaunchWarning(
		params,
		runtime.pi,
	);
	const {
		running: initialRunning,
		index: initialPlanIndex,
		launchFailures: initialLaunchFailures,
	} = nativePlan
		? {
				running: await launchNativeFromParams(params, ctx, nativePlan, {
					agentDefs: selectedDefs,
					parentThinking,
					signal: nativeSignal,
					automatic,
				}),
				index: 0,
				launchFailures: noLaunchFailures,
			}
		: await launchSubagentWithFallbacks(
				params,
				ctx,
				parentThinking,
				runtimePlans,
				{
					forceLeaf,
					agentDefs: selectedDefs,
					automatic,
					signal: autoRun?.signal,
				},
			);

	let running = initialRunning;
	running.selection = selection;
	running.runtimeProvenance = provenance;
	if (autoRun) running.autoRouting = autoRun.receipt;
	if (options.nestedOf) running.nestedOf = options.nestedOf;
	// Before the watcher exists, so even an instant result settles a child
	// the coordinator already accounts for as started.
	autoRun?.recordStarted(running.id);

	// Create a separate AbortController for the watcher
	// (the tool's signal completes when we return)
	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;

	// Start widget refresh and status supervision when the first agent launches
	startWidgetRefresh();
	startStatusRefresh(pi);

	// Keep all temporary attempt panes until the final parent handoff.
	const completedPanes = new Set<string>();
	// Close after accepted delivery or explicit parent shutdown, not failed delivery.
	let shouldCloseTemporaryPanes = false;
	// Fire-and-forget: start watching in background
	(nativePlan
		? watchNativeWithFallbacks(
				running,
				params,
				ctx,
				nativePlan,
				watcherAbort.signal,
				completedPanes,
				{ agentDefs: selectedDefs, parentThinking },
			)
		: watchSubagentWithFallbacks(
				running,
				initialPlanIndex,
				params,
				ctx,
				parentThinking,
				runtimePlans,
				watcherAbort.signal,
				completedPanes,
				initialLaunchFailures,
				{ forceLeaf, agentDefs: selectedDefs },
			)
	)
		.then(({ running: completedRunning, result }) => {
			running = completedRunning;
			if (completedRunning.stopTimeout)
				clearTimeout(completedRunning.stopTimeout);
			if (completedRunning.nestedOf) {
				if (shouldDeliverSubagentCompletion(completedRunning)) {
					completedRunning.lifecycle = markDelivery(
						completedRunning.lifecycle,
						"delivered",
					);
					deliverNestedResult(pi, completedRunning, result);
				} else
					completedRunning.lifecycle = markDelivery(
						completedRunning.lifecycle,
						"suppressed",
					);
				runningSubagents.delete(completedRunning.id);
				updateWidget();
				shouldCloseTemporaryPanes = true;
				return;
			}
			if (completedRunning.persistent) {
				if (!shouldDeliverSubagentCompletion(completedRunning)) {
					shouldCloseTemporaryPanes = true;
					return;
				}
				drainPersistentTaskEvents(
					completedRunning,
					selectCompletionApi(pi, runtime.pi),
				);
				completedRunning.lifecycle = markDelivery(
					completedRunning.lifecycle,
					"delivered",
				);
				shouldCloseTemporaryPanes = true;
				runningSubagents.delete(completedRunning.id);
				updateWidget();
				// Native task results settled just before exit (even by a fast
				// exit) are delivered before the terminal notice, with retries.
				if (completedRunning.native) {
					afterNativePersistentDeliveries(completedRunning, (undelivered) =>
						sendPersistentTerminalNotice(
							completedRunning,
							result,
							selectCompletionApi(pi, runtime.pi),
							undelivered,
						),
					);
					return;
				}
				sendPersistentTerminalNotice(
					completedRunning,
					result,
					selectCompletionApi(pi, runtime.pi),
					[],
				);
				return;
			}
			if (!shouldDeliverSubagentCompletion(completedRunning)) {
				// Explicit parent shutdown still releases temporary panes.
				shouldCloseTemporaryPanes = true;
				completedRunning.lifecycle = markDelivery(
					completedRunning.lifecycle,
					"suppressed",
				);
				runningSubagents.delete(completedRunning.id);
				updateWidget();
				return;
			}
			completedRunning.lifecycle = markDelivery(
				completedRunning.lifecycle,
				"delivered",
			);
			runningSubagents.delete(completedRunning.id);
			updateWidget();
			const completionApi = selectCompletionApi(pi, runtime.pi);

			if (result.ping) {
				// Subagent is requesting help — steer a ping message with session path for resume
				const worktreeRef = result.worktree
					? `\n\n${formatWorktreeHandoff(result.worktree)}`
					: "";
				const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
				const pingDetails: SubagentPingDetails = {
					name: result.ping.name,
					message: result.ping.message,
					agent: running.agent,
					sessionFile: result.sessionFile!,
				};
				if (result.worktree) pingDetails.worktree = result.worktree;
				if (completedRunning.selection)
					pingDetails.selection = completedRunning.selection;
				if (completedRunning.runtimeProvenance)
					pingDetails.runtimeProvenance = completedRunning.runtimeProvenance;
				if (completedRunning.autoRouting)
					pingDetails.autoRouting = completedRunning.autoRouting;
				completionApi.sendMessage(
					{
						customType: "subagent_ping",
						content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${worktreeRef}${sessionRef}`,
						display: true,
						details: pingDetails,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				shouldCloseTemporaryPanes = true;
				return;
			}

			const presentation = resolveResultPresentation(
				result,
				completedRunning.name,
				completedRunning.runtimePlan?.runtimeMismatch,
				completedRunning.selection,
			);

			const resultDetails: SubagentResultDetails = {
				name: completedRunning.name,
				task: completedRunning.task,
				agent: completedRunning.agent,
				exitCode: result.exitCode,
				elapsed: result.elapsed,
				sessionFile: result.sessionFile,
			};
			if (result.errorMessage) resultDetails.errorMessage = result.errorMessage;
			if (result.fallbackAttempts)
				resultDetails.fallbackAttempts = result.fallbackAttempts;
			if (result.fallbackFailures)
				resultDetails.fallbackFailures = result.fallbackFailures;
			if (result.worktree)
				// An unconfirmed native exit must not be re-inspected as reviewable.
				resultDetails.worktree =
					result.native?.processExit === "unconfirmed"
						? result.worktree
						: captureWorktreeHandoff(result.worktree);
			if (completedRunning.runtimePlan)
				resultDetails.runtimePlan = completedRunning.runtimePlan;
			if (result.native) resultDetails.native = result.native;
			if (completedRunning.selection)
				resultDetails.selection = completedRunning.selection;
			if (completedRunning.runtimeProvenance)
				resultDetails.runtimeProvenance = completedRunning.runtimeProvenance;
			if (completedRunning.autoRouting)
				resultDetails.autoRouting = completedRunning.autoRouting;
			sendSubagentResult(completionApi, presentation, resultDetails);
			closePaneAfterLateExit(completedRunning, result.native);
			shouldCloseTemporaryPanes = true;
		})
		.catch((err) => {
			// A native watcher failure belongs to the latest fallback attempt:
			// re-check and release that run, never the first one.
			if (err instanceof NativeAttemptWatchError) running = err.attempt;
			// Every branch below, delivered or not, first settles a native run.
			const nativeSettlement = running.native
				? settleThrownNativeWatcher(running, running.native)
				: undefined;
			if (!shouldDeliverSubagentCompletion(running)) {
				running.lifecycle = markDelivery(running.lifecycle, "suppressed");
				runningSubagents.delete(running.id);
				updateWidget();
				return;
			}
			running.lifecycle = markDelivery(running.lifecycle, "delivered");
			runningSubagents.delete(running.id);
			updateWidget();
			if (running.nestedOf) {
				deliverNestedResult(pi, running, {
					name: running.name,
					task: running.task,
					summary: `Subagent error: ${err?.message ?? String(err)}`,
					exitCode: 1,
					elapsed: Math.floor((Date.now() - running.startTime) / 1000),
					errorMessage: err?.message ?? String(err),
				});
				shouldCloseTemporaryPanes = true;
				return;
			}
			if (running.persistent) {
				const current = running;
				if (current.native)
					afterNativePersistentDeliveries(current, (undelivered) =>
						notifyPersistentCrash(
							current,
							selectCompletionApi(pi, runtime.pi),
							undelivered,
							err?.message ?? String(err),
						),
					);
				else
					notifyPersistentCrash(current, selectCompletionApi(pi, runtime.pi));
				shouldCloseTemporaryPanes = true;
				return;
			}
			const errDetails: SubagentResultDetails = {
				name: running.name,
				task: running.task,
				error: err?.message,
				sessionFile: running.sessionFile,
			};
			if (running.selection) errDetails.selection = running.selection;
			if (running.runtimeProvenance)
				errDetails.runtimeProvenance = running.runtimeProvenance;
			if (running.autoRouting) errDetails.autoRouting = running.autoRouting;
			if (nativeSettlement) {
				errDetails.native = nativeSettlement.native;
				if (nativeSettlement.worktree)
					errDetails.worktree = nativeSettlement.worktree;
			} else if (running.worktree)
				errDetails.worktree = captureWorktreeHandoff(running.worktree);
			sendSubagentResult(
				selectCompletionApi(pi, runtime.pi),
				nativeSettlement
					? boundResultPresentation(
							`Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
							formatNativeSessionReference(nativeSettlement.native),
						)
					: resolveUnexpectedErrorPresentation(
							`Sub-agent "${running.name}" error`,
							err,
							running.sessionFile,
						),
				errDetails,
			);
			if (nativeSettlement?.native.processExit === "confirmed") {
				if (!running.worktree) completedPanes.add(running.surface);
			} else closePaneAfterLateExit(running, nativeSettlement?.native);
			shouldCloseTemporaryPanes = true;
		})
		.finally(() => {
			// Every delivery, error, and suppression path settles the automatic
			// slot once; uncertain dispatch never reaches this watcher.
			autoRun?.recordSettled();
			if (shouldCloseTemporaryPanes) closeCompletedPanes(completedPanes);
		});

	// Return immediately
	const startedDetails: SubagentStartedDetails = {
		id: running.id,
		name: params.name,
		task: params.task,
		agent: params.agent,
		sessionFile: running.sessionFile,
		launchScriptFile: running.launchScriptFile,
		model: running.runtimePlan?.model,
		thinking: running.runtimePlan?.thinking,
		runtimePlan: running.runtimePlan,
		selection,
		runtimeProvenance: provenance,
		status: "started",
	};
	if (running.autoRouting) startedDetails.autoRouting = running.autoRouting;
	if (nativePlan) {
		startedDetails.harness = nativePlan.spec.harness;
		startedDetails.model = running.native?.model ?? undefined;
		if (nativePlan.models.length > 1)
			startedDetails.nativeModels = nativePlan.models.map(
				(model) => model ?? "(native CLI default)",
			);
		if (nativePlan.spec.thinking)
			startedDetails.nativeThinking = nativePlan.spec.thinking;
		startedDetails.nativeMode = nativePlan.spec.mode;
	}
	if (running.worktree) startedDetails.worktree = running.worktree;
	const startedWarning = [worktreeLaunchWarning, running.dispatchWarning]
		.filter(Boolean)
		.join(" ");
	if (startedWarning) startedDetails.warning = startedWarning;
	return {
		content: [
			{
				type: "text",
				text:
					`Sub-agent "${params.name}" launched and is now running in the background` +
					(running.worktree
						? ` in worktree ${running.worktree.path} on branch ${running.worktree.branch}. `
						: ". ") +
					(startedWarning ? `Warning: ${startedWarning} ` : "") +
					(selection.harnessSource === "request"
						? `${formatSubagentSelection(selection)} `
						: "") +
					`Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
					`The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
					`Until then, move on to other work or tell the user you're waiting.`,
			},
		],
		details: startedDetails,
	};
}

/**
 * The automatic-routing launch handoff: consume the revalidated snapshot's
 * pending prepared run through the ordinary startSubagentRun path, whose
 * watcher and result delivery are unchanged. A returned rejection happened in
 * preparation, before any Herdr resource; a throw may follow a resource or
 * dispatch and is reported as uncertain, never as no work.
 */
async function launchAutoRoutedRun(
	pi: ExtensionAPI,
	handoff: AutoLaunchHandoff<AutoPreparedSubagentRun, ExtensionContext>,
): Promise<AutoLaunchOutcome> {
	const prepared = handoff.candidate.prepared;
	const binding = handoff.binding;
	// Only the latch proves no process: before `dispatch-attempted` no
	// runScript ran, and a native run whose exit is unconfirmed is never
	// known no-work.
	const undispatched = () => {
		const state = binding.dispatchState();
		return state === "uncommitted" || state === "resources-created";
	};
	const uncertain: AutoLaunchOutcome = {
		status: "uncertain",
		detail: "The launch failed after its dispatch may have been attempted.",
	};
	let result: AgentToolResult<any>;
	try {
		result = await startSubagentRun(pi, prepared.params, handoff.ctx, {
			prepared,
			autoRun: binding,
		});
	} catch (error) {
		if (undispatched() && !(error instanceof NativeLaunchUnresolvedError))
			return {
				status: "rejected",
				detail:
					error instanceof AutoLaunchStoppedError
						? error.reason
						: "launch-failed-before-dispatch",
			};
		return uncertain;
	}
	const details = result.details;
	if (details?.status === "started" && isString(details.id))
		return {
			status: "started",
			childId: details.id,
			name: prepared.params.name,
		};
	if (!undispatched()) return uncertain;
	return {
		status: "rejected",
		detail: isString(details?.error) ? details.error : "launch-rejected",
	};
}

/** Test and embedding seams for automatic routing; never tool parameters. */
type AutoRoutingExtensionOptions = Partial<
	Pick<
		AutoRoutingCoordinatorOptions<
			AutoPreparedSubagentRun,
			AutoAgentCatalog,
			ExtensionContext
		>,
		| "env"
		| "loadConfig"
		| "herdrAvailable"
		| "transport"
		| "launch"
		| "now"
		| "setTimer"
	>
>;

/** Render one routing message view in the shared custom-message box. */
function renderAutoMessageView(
	view: AutoMessageView,
	expanded: boolean,
	theme: Theme,
) {
	return {
		invalidate() {},
		render(width: number): string[] {
			const lineWidth = Math.max(1, width - 6);
			const contentLines = [
				`${theme.fg(view.tone, "•")} ${theme.fg("toolTitle", theme.bold(view.title))}`,
				// Expanded views wrap to show the full text; previews truncate.
				...view.lines.map((line) =>
					expanded ? line : theme.fg("dim", truncateToWidth(line, lineWidth)),
				),
			];
			if (view.omitted > 0)
				contentLines.push(
					theme.fg(
						"muted",
						expanded
							? `… ${view.omitted} more lines not shown (the stored message is complete)`
							: `… ${view.omitted} more lines`,
					),
				);
			if (!expanded)
				contentLines.push(
					theme.fg("muted", keyHint("app.tools.expand", "to expand")),
				);
			const box = new Box(1, 1, (text: string) =>
				theme.bg("customMessageBg", text),
			);
			box.addChild(new Text(contentLines.join("\n"), 0, 0));
			return ["", ...box.render(width)];
		},
	};
}

export default function subagentsExtension(
	pi: ExtensionAPI,
	options: {
		cleanupOperations?: (ctx: ExtensionContext) => WorktreeCleanupOperations;
		autoRouting?: AutoRoutingExtensionOptions;
	} = {},
) {
	runtime.pi = pi;
	const parentSession = !process.env.PI_SUBAGENT_ID;
	const autoRoutingSeams = options.autoRouting ?? {};
	// One package decision at a time; manual paths never consult it.
	const autoRouting = createAutoRoutingCoordinator<
		AutoPreparedSubagentRun,
		AutoAgentCatalog,
		ExtensionContext
	>({
		pi,
		env: autoRoutingSeams.env,
		loadConfig: autoRoutingSeams.loadConfig ?? loadAutoRoutingConfig,
		herdrAvailable: autoRoutingSeams.herdrAvailable ?? terminalReady,
		managedWorkOutstanding: () =>
			runningSubagents.size > 0 ||
			unresolvedNativeRuns().size > 0 ||
			(runtime.plannedNativeDispatches?.size ?? 0) > 0,
		isChildRunning: (childId) => runningSubagents.has(childId),
		authority: (ctx) => createAutoRoutingAuthority(pi, ctx),
		transport:
			autoRoutingSeams.transport ??
			((ctx) => createJevTransport({ registry: ctx.modelRegistry })),
		launch:
			autoRoutingSeams.launch ??
			((handoff) => launchAutoRoutedRun(pi, handoff)),
		now: autoRoutingSeams.now,
		setTimer: autoRoutingSeams.setTimer,
		// Survives /reload with the shared runtime: dispatched work stays busy.
		retained: {
			get: () => runtime.autoRoutingRetained,
			set: (work) => {
				runtime.autoRoutingRetained = work;
			},
			resolved: {
				has: (decisionId) =>
					runtime.autoRoutingResolved?.has(decisionId) === true,
				add: (decisionId) => {
					runtime.autoRoutingResolved ??= new Set();
					runtime.autoRoutingResolved.add(decisionId);
				},
			},
		},
	});
	const cleanupInput = (ctx: ExtensionContext) => ({
		cwd: ctx.cwd,
		operations:
			options.cleanupOperations?.(ctx) ??
			createWorktreeCleanupOperations({
				manifestDir: join(
					ctx.sessionManager.getSessionDir(),
					"artifacts",
					ctx.sessionManager.getSessionId(),
					"worktree-runs",
				),
				liveHolders: () => [
					...[...runningSubagents.values()].flatMap((child) =>
						child.worktree
							? [{ path: child.worktree.path, persistent: child.persistent }]
							: [],
					),
					// Native runs with unconfirmed exit keep their worktree lease.
					...reconcileUnresolvedNativeRuns().flatMap((entry) =>
						entry.worktreePath ? [{ path: entry.worktreePath }] : [],
					),
				],
			}),
	});
	let btwChild: BtwChild | undefined;

	const closeBtw = async (): Promise<boolean> => {
		const child = btwChild;
		if (!child) return false;

		let paneMissing = false;
		try {
			paneMissing = (await inspectPane(child.surface)).kind === "missing";
		} catch {
			// Best effort: try closing the pane directly when inspection is unavailable.
		}

		if (!paneMissing) {
			try {
				interruptPane(child.surface);
			} catch {
				// Escape is best effort; pane close is authoritative for this MVP.
			}
			closePane(child.surface);
		}

		btwChild = undefined;
		for (const file of [child.sessionFile, child.launchScriptFile]) {
			try {
				rmSync(file, { force: true });
			} catch {
				// Ephemeral artifact cleanup is best effort.
			}
		}
		return true;
	};

	/**
	 * A compact startup indicator for the routing config this load
	 * initialized, and for durable unknown work recovery found on the active
	 * branch. Nothing contacts Jev at startup, and no command can enable
	 * routing.
	 */
	const announceAutoRouting = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		try {
			const loaded = autoRouting.configuration();
			if (loaded.status === "enabled") {
				ctx.ui.setStatus(
					"subagents-routing",
					`auto-route: ${loaded.config.mode}`,
				);
				ctx.ui.notify(
					`Automatic routing is ${loaded.config.mode}: eligible idle TUI input, as this extension sees it, is sent with reviewed routing profiles to TypeSafe AI${loaded.config.mode === "shadow" ? " for observation only" : ""}. RPC, JSON, print, extension, and streaming input bypass it. See /subagents-routing status.`,
					"warning",
				);
			} else {
				ctx.ui.setStatus("subagents-routing", undefined);
				if (loaded.status === "invalid")
					ctx.ui.notify(
						"The automatic routing configuration is invalid, so automatic routing is disabled; manual subagents are unaffected.",
						"warning",
					);
			}
			const recovery = autoRouting.snapshotStatus().recovery;
			if (recovery && recovery.status !== "clear")
				ctx.ui.notify(
					"Automatic routing found earlier automatic work it cannot account for on this branch, so new automatic routing is disabled here; nothing is replayed or retried. See /subagents-routing status.",
					"warning",
				);
		} catch {
			// The indicator is best effort; routing keeps its loaded snapshot.
		}
	};

	if (parentSession) {
		// Idle top-level TUI input only; the coordinator gates everything else.
		pi.on("input", (event, ctx) => autoRouting.onInput(event, ctx));
		pi.on("agent_start", () => autoRouting.onLifecycle("agent_start"));
		// Invalidate when a transition starts, so a delayed, failed, or
		// cancelled one still stops an undispatched decision; never cancel it.
		pi.on("session_before_tree", () => {
			autoRouting.onLifecycle("session_before_tree");
		});
		pi.on("session_tree", () => autoRouting.onLifecycle("session_tree"));
		pi.on("session_before_compact", () => {
			autoRouting.onLifecycle("session_before_compact");
		});
		pi.on("session_compact", () => autoRouting.onLifecycle("session_compact"));
	}

	// Capture the UI context for widget updates and restore presentation for
	// subagents whose watchers survived a reload.
	pi.on("session_start", async (_event, ctx) => {
		runtime.latestCtx = ctx;
		autoRouting.onLifecycle("session_start");
		if (parentSession) {
			// Before any admission: durable unknown work from an earlier
			// process blocks new automatic routing on this branch.
			if (autoRouting.configuration().status === "enabled")
				autoRouting.recover(ctx);
			announceAutoRouting(ctx);
		}
		try {
			// A crash between a persistent first task's plan and its commit
			// leaves it `planned`; resolve it from process evidence.
			recoverPlannedPersistentDispatches(
				join(
					ctx.sessionManager.getSessionDir(),
					"artifacts",
					ctx.sessionManager.getSessionId(),
				),
			);
		} catch {
			// Recovery is retried at the next session start.
		}
		const registry = wrapPiModelRegistry(ctx.modelRegistry);
		const authenticatedTaskPreferences = getAuthenticatedTaskPreferences(
			registry,
			modelConfig.tasks,
		);
		runtime.modelCatalog = buildAuthenticatedModelCatalog(
			registry,
			24,
			modelConfig.tasks,
		);
		const refreshedGuidelines = buildSubagentRoutingGuidelines(
			runtime.modelCatalog,
			authenticatedTaskPreferences,
		);
		subagentRoutingGuidelines.splice(
			0,
			subagentRoutingGuidelines.length,
			...refreshedGuidelines,
		);
		if (runningSubagents.size > 0) {
			startWidgetRefresh();
			startStatusRefresh(pi);
			updateWidget();
		}
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async (event, _ctx) => {
		autoRouting.onLifecycle("session_shutdown");
		if (widgetInterval) {
			clearInterval(widgetInterval);
			widgetInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				WIDGET_INTERVAL_KEY,
				null,
			);
		}
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = null;
			writeGlobalSlot<ReturnType<typeof setInterval> | null>(
				STATUS_INTERVAL_KEY,
				null,
			);
		}

		cleanupSubagentsForShutdown(event.reason, runningSubagents);
		if (!shouldPreserveSubagentsOnShutdown(event.reason)) {
			// In-flight native launches stop before dispatching a process.
			runtime.nativeLaunchAbort?.abort();
			runtime.nativeLaunchAbort = undefined;
			clearTimeout(runtime.lateExitRecheck);
			runtime.lateExitRecheck = undefined;
			runtime.supervision?.close();
			runtime.supervision = undefined;
		}
		try {
			await closeBtw();
		} catch {
			// Best effort during parent shutdown; the Herdr pane remains recoverable.
		}
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_SUBAGENT_ID ? (process.env.PI_DENY_TOOLS ?? "") : "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);

	if (parentSession) {
		pi.registerTool({
			name: "worktree_list",
			label: "Worktree inventory",
			description:
				"Inspect managed worktrees, including cross-session orphans. Only source repositories inside cwd are eligible for explicit removal. This tool never removes anything.",
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _update, ctx) => {
				const entries = await listContainedWorktrees(cleanupInput(ctx));
				return {
					content: [{ type: "text", text: formatWorktreeInventory(entries) }],
					details: { entries },
				};
			},
		});
		pi.registerTool({
			name: "worktree_remove",
			label: "Remove worktree",
			description:
				"Explicitly remove one managed worktree by exact path, branch, or workspace ID. Rechecks cwd containment, live children/leases, and Git state. Branches and commits are retained. Dirty work requires explicit preserve: true to make a WIP commit first.",
			parameters: Type.Object({
				target: Type.String({ minLength: 1 }),
				preserve: Type.Optional(Type.Boolean()),
			}),
			execute: async (_id, params, _signal, _update, ctx) => {
				const result = await removeContainedWorktree({
					...cleanupInput(ctx),
					...params,
				});
				if (result.status === "blocked" || result.status === "failed")
					throw new Error(result.message);
				return {
					content: [{ type: "text", text: result.message }],
					details: result,
				};
			},
		});
	}

	if (
		!process.env.PI_SUBAGENT_ID &&
		shouldRegister("subagents_write_task_models")
	)
		pi.registerTool({
			name: "subagents_write_task_models",
			label: "Write task model preferences",
			description: `Validate and atomically replace models.tasks and models.tasksMeta in the durable Pi agent config, preserving unrelated settings. Supported categories: ${TASK_CATEGORIES.join(", ")}. Partial nonempty categories are accepted; omitted categories are removed. Rejects duplicate exact refs within a category. Review the active authenticated registry and existing preferences first. Returns normalized saved preferences and missing categories; reload required.`,
			parameters: Type.Object({
				tasks: Type.Object(
					Object.fromEntries(
						TASK_CATEGORIES.map((category) => [
							category,
							Type.Optional(
								Type.Array(Type.String({ minLength: 1 }), {
									minItems: 1,
									description: TASK_CATEGORY_DESCRIPTIONS[category],
								}),
							),
						]),
					),
					{ additionalProperties: false, minProperties: 1 },
				),
				tasksMeta: Type.Object({
					generatedAt: Type.String(),
					method: Type.Union([
						Type.Literal("research"),
						Type.Literal("registry-only"),
					]),
				}),
			}),
			execute: async (_id, params, _signal, _update, ctx) => {
				const registry = wrapPiModelRegistry(ctx.modelRegistry);
				// SAFETY: TypeBox validates the tool payload; the write seam performs stricter schema validation.
				const tasks = params.tasks as TaskPreferences;
				// SAFETY: TypeBox validates the tool payload; the write seam performs stricter schema validation.
				const tasksMeta = params.tasksMeta as TaskPreferencesMeta;
				const saved = writeTaskModelConfig(
					getSubagentsConfigPath(),
					getSubagentsConfigExamplePath(),
					tasks,
					tasksMeta,
					(candidate) => {
						const parsed = parseExactModelRef(candidate);
						const model =
							parsed && registry.find(parsed.provider, parsed.modelId);
						return !!model && registry.hasConfiguredAuth(model);
					},
				);
				return {
					content: [
						{
							type: "text",
							text: `Wrote task model preferences. Reload required.\n${JSON.stringify(saved, null, 2)}`,
						},
					],
					details: saved,
				};
			},
		});

	// ── subagent tool ──
	if (shouldRegister("subagent"))
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Spawn a sub-agent in a dedicated terminal herdr pane, or in an isolated Herdr-managed Git worktree when worktree is provided. " +
				"Use ordinary panes for read-only tasks; a single or sequential writer can work in the parent checkout without a worktree. " +
				"Reserve unique worktree branches for parallel independent writers starting from committed state — the worktree base is committed HEAD, so uncommitted parent changes are not copied. " +
				"Worktree runs retain their workspace after completion for parent review; they are not pushed, merged, or removed automatically. " +
				"To inspect a retained worktree result, spawn read-only agents in an ordinary pane with cwd set to that worktree path — do not create a new worktree for them. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate, assume, or summarize results after calling this tool. " +
				"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
			promptSnippet:
				"Spawn a sub-agent in a dedicated terminal herdr pane, or in an isolated Herdr-managed Git worktree when worktree is provided. " +
				"Use ordinary panes for read-only tasks; a single or sequential writer can work in the parent checkout without a worktree. " +
				"Reserve unique worktree branches for parallel independent writers starting from committed state — the worktree base is committed HEAD, so uncommitted parent changes are not copied. " +
				"Worktree runs retain their workspace after completion for parent review; they are not pushed, merged, or removed automatically. " +
				"To inspect a retained worktree result, spawn read-only agents in an ordinary pane with cwd set to that worktree path — do not create a new worktree for them. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate, assume, or summarize results after calling this tool. " +
				"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
			promptGuidelines: subagentRoutingGuidelines,
			parameters: SubagentParams,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				// Prevent self-spawning (e.g. planner spawning another planner)
				const currentAgent = process.env.PI_SUBAGENT_AGENT;
				if (params.agent && currentAgent && params.agent === currentAgent) {
					return {
						content: [
							{
								type: "text",
								text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
							},
						],
						details: { error: "self-spawn blocked" },
					};
				}

				return startSubagentRun(pi, params, ctx, { signal });
			},

			renderCall(args, theme) {
				const partialArgs: PartialSubagentArgs = isPlainObject(args)
					? args
					: {};
				const name =
					isString(partialArgs.name) && partialArgs.name
						? partialArgs.name
						: "(unnamed)";
				const task = isString(partialArgs.task) ? partialArgs.task : "";
				const agent =
					isString(partialArgs.agent) && partialArgs.agent
						? theme.fg("dim", ` (${partialArgs.agent})`)
						: "";
				const cwdHint =
					isString(partialArgs.cwd) && partialArgs.cwd
						? theme.fg("dim", ` in ${partialArgs.cwd}`)
						: "";
				const worktree = isPlainObject(partialArgs.worktree)
					? partialArgs.worktree
					: undefined;
				const worktreeHint = isString(worktree?.branch)
					? theme.fg("dim", ` on ${worktree.branch} (worktree)`)
					: "";
				let text =
					"▸ " +
					theme.fg("toolTitle", theme.bold(name)) +
					agent +
					cwdHint +
					worktreeHint;

				// Show a one-line task preview. renderCall is called repeatedly as the
				// LLM generates tool arguments, so args.task grows token by token.
				// We keep it compact here — Ctrl+O on renderResult expands the full content.
				if (task) {
					const firstLine =
						task.split("\n").find((l: string) => l.trim()) ?? "";
					const preview =
						firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
					if (preview) {
						text += "\n" + theme.fg("toolOutput", preview);
					}
					const totalLines = task.split("\n").length;
					if (totalLines > 1) {
						text += theme.fg("muted", ` (${totalLines} lines)`);
					}
				}

				return new Text(text, 0, 0);
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				const name = details?.name ?? "(unnamed)";

				// "Started" result — tool returned immediately
				if (details?.status === "started") {
					const runtime = details?.model
						? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
						: " — started";
					const worktree = details?.worktree?.branch
						? ` · ${details.worktree.branch}`
						: "";
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", runtime + worktree),
						0,
						0,
					);
				}

				// Fallback (shouldn't happen)
				return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
			},
		});

	// ── subagent_send tool ──
	if (shouldRegister("subagent_send"))
		pi.registerTool({
			name: "subagent_send",
			label: "Send Persistent Task",
			description:
				"Deliver one follow-up task to an idle persistent specialist (Pi or native); busy specialists reject tasks as rejected-busy and no queue is kept. " +
				"For a running native (cli: claude|kiro) non-persistent child, queue one correlated follow-up turn (limit 4) that is typed only after the current tagged turn's verified Stop, never into a busy session; its outcome is reported in the final result. " +
				"Pi-backed non-persistent children do not accept follow-ups. Fire-and-forget: do not poll.",
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({
						description: "Exact persistent specialist logical ID",
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Exact unambiguous persistent specialist name",
					}),
				),
				message: Type.String({ description: "The next task" }),
			}),
			async execute(_toolCallId, params) {
				return handleSubagentSend(params);
			},
		});

	// ── subagent_stop tool ──
	if (shouldRegister("subagent_stop"))
		pi.registerTool({
			name: "subagent_stop",
			label: "Stop Persistent Specialist",
			description:
				"Gracefully stop a persistent specialist after its active task settles. Exit is confirmed before the specialist is removed.",
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({
						description: "Exact persistent specialist logical ID",
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Exact unambiguous persistent specialist name",
					}),
				),
			}),
			async execute(_toolCallId, params) {
				return handleSubagentStop(params, selectCompletionApi(pi, runtime.pi));
			},
		});

	// ── subagent_interrupt tool ──
	if (shouldRegister("subagent_interrupt"))
		pi.registerTool({
			name: "subagent_interrupt",
			label: "Interrupt Subagent",
			description:
				"Send Escape to the active turn of a currently running subagent. " +
				"Pi-backed children stay alive. Native (cli: claude|kiro) children are interrupted only when their process ownership is verified and a correlated receipt shows the tagged turn in progress; the turn is recorded as interrupted, never as a success. " +
				"This returns only a local acknowledgement and does not emit a subagent_result solely because of this request.",
			promptSnippet:
				"Send Escape to the active turn of a currently running subagent. " +
				"Pi-backed children stay alive. Native (cli: claude|kiro) children are interrupted only when their process ownership is verified and a correlated receipt shows the tagged turn in progress; the turn is recorded as interrupted, never as a success. " +
				"This returns only a local acknowledgement and does not emit a subagent_result solely because of this request.",
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({ description: "Exact running subagent id" }),
				),
				name: Type.Optional(
					Type.String({ description: "Exact running subagent display name" }),
				),
			}),

			async execute(_toolCallId, params) {
				return handleSubagentInterrupt(params);
			},

			renderCall(args, theme) {
				const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(target)) +
						theme.fg("dim", " — interrupt turn"),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				if (details?.status === "interrupt_requested") {
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg(
								"toolTitle",
								theme.bold(details.name ?? details.id ?? "subagent"),
							) +
							theme.fg("dim", " — interrupt requested"),
						0,
						0,
					);
				}

				return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
			},
		});

	// ── subagents_list tool ──
	if (shouldRegister("subagents_list"))
		pi.registerTool({
			name: "subagents_list",
			label: "List Subagents",
			description:
				"List all available package, global, and project subagent definitions. " +
				"Project agents override global definitions, which override package definitions.",
			promptSnippet:
				"List all available package, global, and project subagent definitions. " +
				"Project agents override global definitions, which override package definitions.",
			parameters: Type.Object({}),

			async execute() {
				const catalog = discoverAgentCatalog(pi);
				const list = catalog.agents.filter(
					(agent) => !agent.disableModelInvocation,
				);
				const unresolved = reconcileUnresolvedNativeRuns();
				const lines = [
					...formatVisibleAgentDefinitions(list),
					...formatLivePersistentSpecialists(),
					...(unresolved.length
						? [
								"Native runs with unconfirmed process exit (evidence retained):",
								...unresolved.map(
									(entry) =>
										`• ${entry.run.harness} run ${entry.run.processRun.id} | ${entry.worktreePath ?? "ordinary pane"} | ${entry.run.runDir}`,
								),
							]
						: []),
					...formatSupervisionDiagnostics(),
					...formatAgentDiagnostics(catalog.diagnostics),
				];

				return {
					content: [
						{
							type: "text",
							text: lines.join("\n") || "No subagent definitions found.",
						},
					],
					details: { agents: list, diagnostics: catalog.diagnostics },
				};
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				const agents = details?.agents ?? [];
				const diagnostics = details?.diagnostics ?? [];
				if (agents.length === 0 && diagnostics.length === 0) {
					return new Text(
						theme.fg("dim", "No subagent definitions found."),
						0,
						0,
					);
				}
				const lines = agents.map((a: any) => {
					const source =
						a.source === "package" && a.provider
							? `package:${a.provider}`
							: a.source;
					const badge = theme.fg("accent", ` (${source})`);
					const desc = a.description
						? theme.fg("dim", ` — ${a.description}`)
						: "";
					const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
					return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
				});
				for (const diagnostic of diagnostics) {
					lines.push(theme.fg("warning", `  ! ${diagnostic.message}`));
				}
				return new Text(lines.join("\n"), 0, 0);
			},
		});

	// ── subagent_resume tool ──
	if (shouldRegister("subagent_resume"))
		pi.registerTool({
			name: "subagent_resume",
			label: "Resume Subagent",
			description:
				"Resume a previous sub-agent session in a new herdr pane. Pi sessions use their .jsonl file; native (cli: claude|kiro) sessions use their native-sessions/<id>.json marker, require a message, and restore exactly the recorded loadout (tools, model, thinking, identity, skill snapshots, nested-spawn grant, mode, cwd). " +
				"A Pi resume does not reattach a retained managed worktree; continue worktree-bound follow-up in its existing workspace. A worktree-bound native resume runs in an ordinary pane at the verified retained worktree and holds its lease until exit is confirmed. Persistent specialists never resume. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			promptSnippet:
				"Resume a previous sub-agent session in a new herdr pane. Pi sessions use their .jsonl file; native (cli: claude|kiro) sessions use their native-sessions/<id>.json marker, require a message, and restore exactly the recorded loadout (tools, model, thinking, identity, skill snapshots, nested-spawn grant, mode, cwd). " +
				"A Pi resume does not reattach a retained managed worktree; continue worktree-bound follow-up in its existing workspace. A worktree-bound native resume runs in an ordinary pane at the verified retained worktree and holds its lease until exit is confirmed. Persistent specialists never resume. " +
				"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
				"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
				"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
				"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			parameters: Type.Object({
				sessionPath: Type.String({
					description:
						"Path to the Pi session .jsonl file, or the native session marker .json, to resume",
				}),
				name: Type.Optional(
					Type.String({
						description: "Display name for the terminal tab. Default: 'Resume'",
					}),
				),
				message: Type.Optional(
					Type.String({
						description:
							"Message to send after resuming (e.g. follow-up instructions). Required for native sessions: it becomes the correlated tagged turn.",
					}),
				),
				autoExit: Type.Optional(
					Type.Boolean({
						description:
							"Pi sessions: whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions. Native sessions always resume in their recorded mode; a conflicting autoExit is rejected.",
					}),
				),
			}),

			renderCall(args, theme) {
				const name = args.name ?? "Resume";
				const text =
					"▸ " +
					theme.fg("toolTitle", theme.bold(name)) +
					theme.fg("dim", " — resuming session");
				return new Text(text, 0, 0);
			},

			renderResult(result, _opts, theme) {
				// SAFETY: renderResult only ever receives the details this tool's own
				// execute() above returned; the framework's TDetails type isn't threaded
				// through this callback precisely enough for TypeScript to see that.
				const details = result.details as any;
				const name = details?.name ?? "Resume";

				if (details?.status === "started") {
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", " — resumed"),
						0,
						0,
					);
				}

				// Fallback
				return new Text(theme.fg("dim", getFirstText(result.content)), 0, 0);
			},

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const name = params.name ?? "Resume";
				const id = Math.random().toString(16).slice(2, 10);

				if (readNativeSessionMarker(params.sessionPath))
					return resumeNativeSession(pi, params, ctx, signal);

				if (!isTerminalAvailable()) {
					return muxUnavailableResult();
				}

				if (!existsSync(params.sessionPath)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: session file not found: ${params.sessionPath}`,
							},
						],
						details: { error: "session not found" },
					};
				}

				// Record entry count before resuming so we can extract new messages
				const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

				const running: RunningSubagent = await launchPiSubagent({
					kind: "resume",
					id,
					name,
					sessionFile: params.sessionPath,
					message: params.message,
					parent: {
						sessionId: ctx.sessionManager.getSessionId(),
						sessionDir: ctx.sessionManager.getSessionDir(),
					},
					behavior: { autoExit: params.autoExit },
				});
				runningSubagents.set(id, running);
				startWidgetRefresh();
				startStatusRefresh(pi);

				// Fire-and-forget watcher
				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;

				// Close after accepted delivery or explicit parent shutdown, not failed delivery.
				let shouldCloseTemporaryPanes = false;
				watchSubagent(running, watcherAbort.signal)
					.then((result) => {
						if (!shouldDeliverSubagentCompletion(running)) {
							shouldCloseTemporaryPanes = true;
							running.lifecycle = markDelivery(running.lifecycle, "suppressed");
							runningSubagents.delete(running.id);
							updateWidget();
							return;
						}
						running.lifecycle = markDelivery(running.lifecycle, "delivered");
						runningSubagents.delete(running.id);
						updateWidget();
						const completionApi = selectCompletionApi(pi, runtime.pi);

						if (result.ping) {
							const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;
							completionApi.sendMessage(
								{
									customType: "subagent_ping",
									content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
									display: true,
									details: {
										name: result.ping.name,
										message: result.ping.message,
										sessionFile: params.sessionPath,
									},
								},
								{ triggerTurn: true, deliverAs: "steer" },
							);
							shouldCloseTemporaryPanes = true;
							return;
						}

						const allEntries = getNewEntries(
							params.sessionPath,
							entryCountBefore,
						);
						const summary =
							findLastAssistantMessage(allEntries) ??
							(result.errorMessage
								? `Subagent error: ${result.errorMessage}`
								: result.exitCode === 0
									? "Resumed session exited without new output"
									: `Resumed session exited with code ${result.exitCode}`);
						const presentation = resolveResultPresentation(
							{ ...result, summary, sessionFile: params.sessionPath },
							name,
							running.runtimePlan?.runtimeMismatch,
						);

						const resumeDetails: SubagentResultDetails = {
							name,
							task: params.message ?? "resumed session",
							exitCode: result.exitCode,
							elapsed: result.elapsed,
							sessionFile: params.sessionPath,
						};
						if (result.errorMessage)
							resumeDetails.errorMessage = result.errorMessage;
						if (running.runtimePlan)
							resumeDetails.runtimePlan = running.runtimePlan;
						sendSubagentResult(completionApi, presentation, resumeDetails);
						shouldCloseTemporaryPanes = true;
					})
					.catch((err) => {
						if (!shouldDeliverSubagentCompletion(running)) {
							running.lifecycle = markDelivery(running.lifecycle, "suppressed");
							runningSubagents.delete(running.id);
							updateWidget();
							return;
						}
						running.lifecycle = markDelivery(running.lifecycle, "delivered");
						runningSubagents.delete(running.id);
						updateWidget();
						sendSubagentResult(
							selectCompletionApi(pi, runtime.pi),
							resolveUnexpectedErrorPresentation(
								"Resume error",
								err,
								params.sessionPath,
							),
							{ name, error: err?.message, sessionFile: params.sessionPath },
						);
						shouldCloseTemporaryPanes = true;
					})
					.finally(() => {
						if (shouldCloseTemporaryPanes)
							closeCompletedPanes([running.surface]);
					});

				return {
					content: [{ type: "text", text: `Session "${name}" resumed.` }],
					details: {
						id,
						name,
						sessionPath: params.sessionPath,
						launchScriptFile: running.launchScriptFile,
						status: "started",
					},
				};
			},
		});

	if (!process.env.PI_SUBAGENT_ID)
		pi.registerCommand("subagents-init", {
			description:
				"Draft task-category model preferences from the live registry; optional arguments set ranking preferences",
			handler: async (args, ctx) => {
				const brief = buildTaskModelBrief(
					ctx.modelRegistry,
					loadModelConfig(),
					args,
				);
				pi.sendUserMessage(buildTaskModelInitPrompt(brief));
			},
		});

	pi.registerCommand("btw", {
		description:
			"Open an ephemeral side-question session in a background Herdr tab",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}
			if (!isTerminalAvailable()) {
				ctx.ui.notify(terminalSetupHint(), "error");
				return;
			}

			let sessionFile: string | undefined;
			let surface: string | undefined;
			let launchScriptFile: string | undefined;
			try {
				await ctx.waitForIdle();
				if (btwChild) await closeBtw();

				const parentSessionFile = ctx.sessionManager.getSessionFile();
				const leafId = ctx.sessionManager.getLeafId();
				if (!parentSessionFile || !leafId) {
					throw new Error("No completed session context is available for BTW");
				}
				if (!ctx.model) throw new Error("No parent model is selected");

				sessionFile = createBtwSessionSnapshot(parentSessionFile, leafId);
				surface = createSubagentPane("BTW");
				await waitForShellReady(surface);

				const artifactDir = getArtifactDir(
					ctx.sessionManager.getSessionDir(),
					ctx.sessionManager.getSessionId(),
				);
				launchScriptFile = join(
					artifactDir,
					"subagent-scripts",
					`btw-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
				);
				const command = buildBtwLaunchCommand({
					cwd: ctx.cwd,
					sessionFile,
					question,
					model: `${ctx.model.provider}/${ctx.model.id}`,
					thinking: pi.getThinkingLevel(),
					agentDir: process.env.PI_CODING_AGENT_DIR,
				});
				runScriptInPane(surface, command, {
					scriptPath: launchScriptFile,
					scriptPreamble: [
						"# BTW side-question session",
						`# Session: ${sessionFile}`,
						`# Generated: ${new Date().toISOString()}`,
					].join("\n"),
				});
				btwChild = { surface, sessionFile, launchScriptFile };
				ctx.ui.notify("BTW opened in a background Herdr tab.", "info");
			} catch (error) {
				if (surface) {
					try {
						closePane(surface);
					} catch {
						// Leave the pane for manual recovery if launch cleanup fails.
					}
				}
				for (const file of [sessionFile, launchScriptFile]) {
					if (!file) continue;
					try {
						rmSync(file, { force: true });
					} catch {
						// Best effort.
					}
				}
				ctx.ui.notify(
					`BTW failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("btw-close", {
		description: "Close the current BTW side-question session",
		handler: async (_args, ctx) => {
			try {
				if (!(await closeBtw())) {
					ctx.ui.notify("No BTW session is open.", "info");
					return;
				}
				ctx.ui.notify("BTW session closed.", "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not close BTW session: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("worktree", {
		description: parentSession
			? "Fork into a worktree, list retained worktrees, or explicitly remove one"
			: "Fork this session into a worktree; use /worktree list to inspect them",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (trimmed === "list") {
				if (!isTerminalAvailable()) {
					ctx.ui.notify(terminalSetupHint(), "error");
					return;
				}
				try {
					ctx.ui.notify(
						parentSession
							? formatWorktreeInventory(
									await listContainedWorktrees(cleanupInput(ctx)),
								)
							: listHerdrWorktrees(ctx.cwd)
									.map(
										(worktree) =>
											`${worktree.branch || "(detached HEAD)"} — ${worktree.path}${worktree.workspaceId ? ` (${worktree.workspaceId})` : ""}`,
									)
									.join("\n") || "No worktrees found.",
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`Worktree list failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}

			if (parts[0] === "remove") {
				if (!parentSession) {
					ctx.ui.notify("Worktree removal is parent-only.", "warning");
					return;
				}
				const preserve = parts.at(-1) === "--preserve";
				const target = trimmed
					.slice("remove".length)
					.trim()
					.replace(/\s+--preserve$/, "");
				if (!target || target === "--preserve") {
					ctx.ui.notify(
						"Usage: /worktree remove <path|branch|workspace-id> [--preserve]",
						"warning",
					);
					return;
				}
				const result = await removeContainedWorktree({
					...cleanupInput(ctx),
					target,
					preserve,
				});
				ctx.ui.notify(
					result.message,
					result.status === "removed" || result.status === "already-removed"
						? "info"
						: "warning",
				);
				return;
			}
			const branch = parts.shift();
			if (!branch || branch === "list") {
				ctx.ui.notify(
					parentSession
						? "Usage: /worktree <name> [task] | /worktree list | /worktree remove <target> [--preserve]"
						: "Usage: /worktree <name> [task] | /worktree list",
					"warning",
				);
				return;
			}
			if (!isTerminalAvailable()) {
				ctx.ui.notify(terminalSetupHint(), "error");
				return;
			}

			try {
				await ctx.waitForIdle();
				const sessionFile = ctx.sessionManager.getSessionFile();
				const leafId = ctx.sessionManager.getLeafId();
				if (!sessionFile || !leafId) {
					throw new Error(
						"Start pi with a completed persistent session before handing off",
					);
				}
				if (!ctx.model) throw new Error("No parent model is selected");
				const thinking = pi.getThinkingLevel();
				if (!isThinkingLevel(thinking)) {
					throw new Error(`Unsupported parent thinking level: ${thinking}`);
				}
				const task =
					parts.join(" ") || "Continue the current work in the new worktree.";
				const runtimePlan = resolveRuntimePlan(
					{},
					{},
					{
						provider: ctx.model.provider,
						modelId: ctx.model.id,
						thinking,
					},
					wrapPiModelRegistry(ctx.modelRegistry),
				);
				const result = await launchPiWorktreeHandoff({
					kind: "fresh",
					name: `wt: ${branch}`,
					task,
					cwd: ctx.cwd,
					worktree: { branch },
					handoff: { leafId },
					parent: {
						cwd: ctx.cwd,
						invocationCwd: process.cwd(),
						sessionFile,
						sessionId: ctx.sessionManager.getSessionId(),
						sessionDir: ctx.sessionManager.getSessionDir(),
						agentDir: getAgentConfigDir(),
					},
					runtimePlan,
					behavior: {
						deniedTools: [],
						autoExit: false,
						interactive: true,
						sessionMode: "standalone",
					},
				});
				const worktree = result.running.worktree;
				if (!worktree) {
					throw new Error("Worktree handoff did not return worktree metadata");
				}
				ctx.ui.notify(
					result.focusError
						? `Worktree launched, but workspace focus failed: ${result.focusError}\nWorktree: ${worktree.path}`
						: `Worktree launched in ${worktree.path} (workspace ${worktree.workspaceId}).`,
					result.focusError ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Worktree launch failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	// /iterate command — fork the session into a subagent
	pi.registerCommand("iterate", {
		description:
			"Fork session into a subagent for focused work (bugfixes, iteration)",
		handler: async (args, _ctx) => {
			const task = args.trim() || "";
			const toolCall = task
				? `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: ${JSON.stringify(task)}`
				: `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
			pi.sendUserMessage(toolCall);
		},
	});

	// /subagent command — spawn a subagent by name, or list available agents
	pi.registerCommand("subagent", {
		description:
			"Spawn a subagent: /subagent <agent> [--harness pi|claude|kiro] [--model <value>] [--thinking <level>] [--] [task]; list agents: /subagent list",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "list") {
				const catalog = discoverAgentCatalog(pi);
				const lines = [
					...formatVisibleAgentDefinitions(catalog.agents),
					...formatAgentDiagnostics(catalog.diagnostics),
				];
				ctx.ui.notify(
					lines.join("\n") || "No subagent definitions found.",
					"info",
				);
				return;
			}
			if (!trimmed) {
				ctx.ui.notify(SUBAGENT_COMMAND_USAGE, "warning");
				return;
			}

			const parsed = parseSubagentCommand(trimmed);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}

			const catalog = discoverAgentCatalog(pi);
			const defs = catalog.agents.find((agent) => agent.name === parsed.agent);
			if (!defs) {
				const diagnostic = catalog.diagnostics.find(
					(candidate) => candidate.agentName === parsed.agent,
				);
				ctx.ui.notify(
					diagnostic?.message ?? `Agent "${parsed.agent}" not found.`,
					"error",
				);
				return;
			}
			// Projection rules are checked early for feedback; the tool
			// re-validates everything, including native capabilities.
			const projection = resolveRoleProjection(parsed, defs);
			if (!projection.ok) {
				ctx.ui.notify(projection.message, "error");
				return;
			}

			pi.sendUserMessage(buildSubagentCommandMessage(parsed));
		},
	});

	// ── subagent_result message renderer ──
	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_result"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const errorMessage = isString(details.errorMessage)
					? details.errorMessage
					: "";
				const failed = exitCode !== 0 || !!errorMessage;
				const elapsed =
					details.elapsed == null ? "?" : formatElapsed(details.elapsed);
				const bgFn = failed
					? (text: string) => theme.bg("toolErrorBg", text)
					: (text: string) => theme.bg("toolSuccessBg", text);
				const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const status = errorMessage
					? "failed (provider/agent error)"
					: failed
						? `failed (exit ${exitCode})`
						: "completed";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";

				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
				const rawContent = isString(details.resultContent)
					? details.resultContent
					: isString(message.content)
						? message.content
						: "";

				// Clean summary (remove session ref and leading label for display)
				const summary = rawContent
					.replace(/\n\nSession: .+\nResume: .+$/, "")
					.replace(/\n\nNative harness: [\s\S]*$/, "")
					.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
					.replace(
						`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`,
						"",
					)
					.replace(
						new RegExp(
							`^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error\\)\\.\\n\\n`,
						),
						"",
					);

				// Build content for the box
				const contentLines = [header];

				if (options.expanded) {
					// Full view: complete summary + session info
					if (summary) {
						for (const line of summary.split("\n")) {
							contentLines.push(line.slice(0, width - 6));
						}
					}
					if (details.native) {
						// Native markers are not Pi transcripts; never offer pi --session.
						contentLines.push("");
						contentLines.push(
							theme.fg(
								"dim",
								`Native harness: ${details.native.harness ?? "unknown"} · session ${details.native.sessionId ?? "unknown"}`,
							),
						);
						contentLines.push(
							theme.fg("dim", `Native marker: ${details.native.markerFile}`),
						);
						contentLines.push(
							theme.fg(
								"dim",
								details.native.resume?.available
									? "Resume: subagent_resume with this marker and a message"
									: `Resume: unavailable (${details.native.resume?.reason ?? "spawn a new subagent"})`,
							),
						);
						if (isString(details.native.warning))
							contentLines.push(
								theme.fg("warning", `Warning: ${details.native.warning}`),
							);
					} else if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Session: ${details.sessionFile}`),
						);
						contentLines.push(
							theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
						);
					}
				} else {
					// Collapsed: preview + expand hint
					if (summary) {
						const previewLines = summary.split("\n").slice(0, 5);
						for (const line of previewLines) {
							contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
						}
						const totalLines = summary.split("\n").length;
						if (totalLines > 5) {
							contentLines.push(
								theme.fg("muted", `… ${totalLines - 5} more lines`),
							);
						}
					}
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				// Render via Box for background + padding, with blank line above for separation
				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_status message renderer ──
	pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_status"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		const lines = Array.isArray(details?.lines) ? details.lines : [];
		const overflow = isFiniteNumber(details?.overflow) ? details.overflow : 0;
		if (lines.length === 0 && overflow === 0) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const lineWidth = Math.max(0, width - 6);
				const contentLines = [
					`${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
					...lines.map((line: string) =>
						theme.fg("dim", truncateToWidth(line, lineWidth)),
					),
				];

				if (overflow > 0) {
					contentLines.push(theme.fg("muted", `+${overflow} more running.`));
				}
				if (!options.expanded) {
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, (text: string) =>
					theme.bg("customMessageBg", text),
				);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	// ── subagent_ping message renderer ──
	pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
		// SAFETY: this renderer is only ever wired to messages this extension sends
		// with customType "subagent_ping"; registerMessageRenderer has no static
		// link between the customType string and a details shape.
		const details = message.details as any;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";
				const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

				const icon = theme.fg("accent", "?");
				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

				const contentLines = [header];

				if (options.expanded) {
					contentLines.push("");
					contentLines.push(details.message ?? "");
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Session: ${details.sessionFile}`),
						);
					}
				} else {
					const preview = (details.message ?? "")
						.split("\n")[0]
						.slice(0, width - 10);
					contentLines.push(theme.fg("dim", preview));
					contentLines.push(
						theme.fg("muted", keyHint("app.tools.expand", "to expand")),
					);
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	pi.registerMessageRenderer(
		AUTO_REQUEST_CUSTOM_TYPE,
		(message, options, theme) =>
			renderAutoMessageView(
				autoRequestView(message, options.expanded),
				options.expanded,
				theme,
			),
	);
	pi.registerMessageRenderer(
		AUTO_STATUS_CUSTOM_TYPE,
		(message, options, theme) =>
			renderAutoMessageView(
				autoStatusView(message, options.expanded),
				options.expanded,
				theme,
			),
	);

	// Local diagnostics only: never enables routing or writes approvals.
	if (parentSession)
		pi.registerCommand("subagents-routing", {
			description:
				"Automatic routing diagnostics: /subagents-routing status | cancel (local only; cannot enable routing, approve, or stop a running child)",
			handler: async (args, ctx) => {
				const action = args.trim();
				if (action === "" || action === "status") {
					ctx.ui.notify(
						formatAutoRoutingStatus(autoRouting.snapshotStatus()),
						"info",
					);
					return;
				}
				if (action === "cancel") {
					const report = autoRouting.cancel();
					ctx.ui.notify(report.message, report.cancelled ? "info" : "warning");
					return;
				}
				ctx.ui.notify("Usage: /subagents-routing status|cancel", "warning");
			},
		});

	// /plan command — start the full planning workflow
	pi.registerCommand("plan", {
		description: "Start a planning session: /plan <what to build>",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /plan <what to build>", "warning");
				return;
			}

			// Load the plan skill from the subagents extension directory
			const planSkillPath = join(SUBAGENTS_DIR, "plan-skill.md");
			let content = readFileSync(planSkillPath, "utf8");
			content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
			pi.sendUserMessage(
				`<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
			);
		},
	});
}
