import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getSubagentActivityFile } from "./activity.ts";
import { createLifecycle, type SubagentLifecycle } from "./lifecycle.ts";
import type { ResolvedRuntimePlan } from "./runtime-routing.ts";
import { createSubagentPaneFactory, loadPaneConfig } from "./pane-config.ts";
import { HerdrWorktreeCreateError } from "./herdr.ts";
import { isNonEmptyString, isRecord, type JsonObject } from "./type-guards.ts";
import {
	createNativeHarnessOperations,
	releaseNativeRun,
	markNativeSubmitted,
	prepareNativeRun,
	type NativeHarnessOperations,
	type NativeLaunchPlan,
	type NativeResumeRequest,
	type NativeRun,
} from "./native-harness.ts";
import { supervisedCommand } from "./process-run.ts";
import {
	createWorktreeSessionFork,
	getNewEntries,
	readSubagentSessionPolicy,
	seedSubagentSessionFile,
	writeSubagentSessionPolicy,
} from "./session.ts";
import {
	closePane,
	createSubagentPane,
	createGroupedSubagentPane,
	createSubagentWorktree,
	splitCurrentPane,
	runScriptInPane,
	shellQuote,
	waitForPiReady,
	waitForShellReady,
	focusWorkspace,
	type HerdrWorktreeSurface,
} from "./terminal.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface WorktreeLaunch {
	path: string;
	workspaceId: string;
	paneId: string;
	branch: string;
	baseRef: string;
	baseSha: string;
	manifestFile: string;
	sessionFile?: string;
	sourceSessionFile?: string;
	handoffMessage?: string;
}

interface FailedWorktreeManifest extends JsonObject {
	state: "failed";
	id: string;
	name: string;
	sourceCwd: string;
	branch: string;
	baseRef: string;
	baseSha: string;
	createdAt: number;
	path?: string;
	workspaceId?: string;
	error?: string;
}

export interface WorktreeHandoff extends WorktreeLaunch {
	headSha: string | null;
	commitsAhead: number | null;
	clean: boolean | null;
	conflicted: boolean | null;
	changedFiles: string[] | null;
	untrackedFiles: string[] | null;
	gitError?: string;
}

export interface FreshPiLaunchRequest {
	kind: "fresh";
	id?: string;
	name: string;
	task: string;
	agent?: string;
	cwd?: string;
	worktree?: { branch: string; base?: string } | null;
	fork?: boolean;
	handoff?: { leafId: string };
	surface?: string;
	parent: {
		cwd: string;
		invocationCwd?: string;
		sessionFile: string;
		sessionId: string;
		sessionDir: string;
		agentDir?: string;
	};
	runtimePlan: ResolvedRuntimePlan;
	behavior: {
		tools?: string;
		skills?: string;
		deniedTools: readonly string[];
		autoExit: boolean;
		interactive: boolean;
		persistent?: boolean;
		logicalId?: string;
		generationId?: string;
		taskId?: string;
		identity?: string;
		systemPromptMode?: "append" | "replace";
		sessionMode: SubagentSessionMode;
		cwd?: string;
	};
}

export interface ResumePiLaunchRequest {
	kind: "resume";
	id?: string;
	name: string;
	sessionFile: string;
	message?: string;
	parent: {
		sessionId: string;
		sessionDir: string;
	};
	behavior?: {
		autoExit?: boolean;
		interactive?: boolean;
	};
}

export type PiLaunchRequest = FreshPiLaunchRequest | ResumePiLaunchRequest;

export interface PiRunningChild {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile: string;
	activityFile: string;
	interactive: boolean;
	runtimePlan: ResolvedRuntimePlan | undefined;
	worktree?: WorktreeLaunch;
	lifecycle: SubagentLifecycle;
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
	crashNotified?: boolean;
	/** Why the first task's durable dispatch record could not be written. */
	dispatchWarning?: string;
}

export interface PiLaunchOperations {
	createPane(name: string, cwd?: string): string;
	createWorktree(
		name: string,
		cwd: string,
		branch: string,
		base: string,
	): HerdrWorktreeSurface;
	waitForShellReady(surface: string): Promise<void>;
	runScript(
		surface: string,
		command: string,
		options: { scriptPath: string; scriptPreamble: string },
	): string;
	closePane(pane: string): void;
	waitForPiReady?(
		surface: string,
		sessionFile: string,
		cwd: string,
	): Promise<void>;
	focusWorkspace?(workspaceId: string): void;
}

const paneConfig = loadPaneConfig();

const defaultOperations: PiLaunchOperations = {
	createPane: createSubagentPaneFactory(
		paneConfig,
		createSubagentPane,
		splitCurrentPane,
		createGroupedSubagentPane,
	),
	createWorktree: createSubagentWorktree,
	waitForShellReady,
	runScript: runScriptInPane,
	closePane,
	waitForPiReady,
	focusWorkspace,
};

interface LaunchLocation {
	id: string;
	startTime: number;
	agentDir: string;
	localAgentDir: string | null;
	sourceCwd: string;
	artifactDir: string;
}

/** Fields common to every fresh launch that selects a Herdr surface. */
interface SurfaceLaunch extends LaunchLocation {
	request: Pick<FreshPiLaunchRequest, "name" | "worktree" | "surface">;
}

interface ResolvedLaunch extends SurfaceLaunch {
	request: FreshPiLaunchRequest;
	sessionMode: SubagentSessionMode;
	taskDelivery: "direct" | "artifact";
}

interface PreparedSurface {
	surface: string;
	targetCwd: string;
	effectiveAgentDir: string;
	localAgentDir: string | null;
	worktree?: WorktreeLaunch;
}

interface PreparedSession extends PreparedSurface {
	sessionFile: string;
	activityFile: string;
}

interface PreparedArtifacts extends PreparedSession {
	taskArg: string;
	systemPromptFile?: string;
}

/**
 * Launch one validated Pi-backed request. Lifecycle watching and parent
 * delivery begin only after this transaction returns the running child.
 */
export async function launchPiSubagent(
	request: PiLaunchRequest,
	operations: PiLaunchOperations = defaultOperations,
): Promise<PiRunningChild> {
	return request.kind === "resume"
		? launchResumedPiSubagent(request, operations)
		: launchFreshPiSubagent(request, operations);
}

export async function launchPiWorktreeHandoff(
	request: FreshPiLaunchRequest,
	operations: PiLaunchOperations = defaultOperations,
): Promise<{ running: PiRunningChild; focusError?: string }> {
	if (!request.worktree || !request.handoff) {
		throw new Error("A worktree handoff requires a worktree and active leaf");
	}
	const running = await launchPiSubagent(request, operations);
	if (!running.worktree) {
		throw new Error("Worktree handoff did not create a managed worktree");
	}
	try {
		operations.focusWorkspace?.(running.worktree.workspaceId);
	} catch (error) {
		const focusError = errorMessage(error);
		writeWorktreeManifest(running.worktree.manifestFile, {
			state: "running",
			focusError,
		});
		return {
			running,
			focusError,
		};
	}
	return { running };
}

async function launchFreshPiSubagent(
	request: FreshPiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	const resolved = resolveLaunchRequest(request);
	let surface: PreparedSurface | undefined;

	try {
		surface = prepareLaunchSurface(resolved, operations);
		const session = prepareChildSession(resolved, surface);
		const handoffArtifacts = request.handoff
			? prepareTaskArtifacts(resolved, session)
			: undefined;
		await confirmShellReady(session, operations);
		const artifacts =
			handoffArtifacts ?? prepareTaskArtifacts(resolved, session);
		const command = buildPiCommand(resolved, artifacts);
		const launchScriptFile = startPiProcess(
			resolved,
			artifacts,
			command,
			operations,
		);
		if (request.handoff) {
			if (!operations.waitForPiReady) {
				throw new Error("Pi startup confirmation is unavailable");
			}
			await operations.waitForPiReady(
				artifacts.surface,
				artifacts.sessionFile,
				artifacts.targetCwd,
			);
			if (artifacts.worktree) {
				persistWorktreeResult(artifacts.worktree, "running");
			}
		}
		return createRunningChild(resolved, artifacts, launchScriptFile);
	} catch (error) {
		rethrowLaunchFailure(request.surface, surface, error, operations);
	}
}

export interface FreshNativeLaunchRequest {
	kind: "native";
	id?: string;
	name: string;
	task: string;
	agent?: string;
	cwd?: string;
	worktree?: { branch: string; base?: string } | null;
	surface?: string;
	parent: FreshPiLaunchRequest["parent"];
	behavior: { interactive: boolean; cwd?: string };
	/** Pre-validated launch plan (fresh runs); see planNativeLaunch. */
	plan?: NativeLaunchPlan;
	/** Native model for this attempt; defaults to the plan's first candidate. */
	model?: string | null;
	/** Reopen a verified native session instead of creating one. */
	resume?: NativeResumeRequest;
	/**
	 * Fallback attempt only: reuse this retained managed worktree and its
	 * root pane after the previous attempt's exit was confirmed.
	 */
	reuseWorktree?: WorktreeLaunch;
	/**
	 * Fallback attempt: the run whose parent-reserved worktree lease this
	 * attempt takes over by atomic handoff.
	 */
	worktreeLeaseFrom?: string;
	/**
	 * Parent abort (shutdown or a cancelled call). Checked before any
	 * resource exists and immediately before the process is dispatched; a
	 * pending shell-readiness wait ends as soon as it aborts.
	 */
	signal?: AbortSignal;
	/**
	 * Runs once the run is prepared (marker and loadout hash exist) and
	 * immediately before its process is dispatched. A throw fails the launch
	 * with nothing started, so the failure path proves that and cleans up.
	 */
	beforeDispatch?: (run: NativeRun) => void;
	/**
	 * Resume of a worktree-bound session: run in a new ordinary pane at the
	 * retained worktree path, holding its lease for the run's lifetime.
	 */
	boundWorktree?: WorktreeLaunch;
}

export interface NativeRunningChild {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	/** Native session marker/loadout artifact, never a Pi transcript. */
	sessionFile: string;
	launchScriptFile: string;
	interactive: boolean;
	runtimePlan: undefined;
	worktree?: WorktreeLaunch;
	lifecycle: SubagentLifecycle;
	native: NativeRun;
}

/**
 * Launch one pre-validated native harness child. Herdr surface and worktree
 * provisioning, ownership manifests, and failure retention are shared with
 * Pi launches; only the prepared command and owned run files differ.
 */
export async function launchNativeSubagent(
	request: FreshNativeLaunchRequest,
	operations: PiLaunchOperations = defaultOperations,
	nativeOperations: NativeHarnessOperations = createNativeHarnessOperations(),
): Promise<NativeRunningChild> {
	const location = resolveLaunchLocation(request);
	const harness = request.resume?.marker.harness ?? request.plan?.spec.harness;
	if (!harness) throw new Error("A native launch needs a plan or resume.");
	// Prerequisites fail before any pane, workspace, or worktree exists.
	nativeOperations.assertAvailable(harness);
	throwIfLaunchAborted(request.signal);
	let surface: PreparedSurface | undefined;
	let run: NativeRun | undefined;
	try {
		surface = prepareNativeSurface(request, location, operations);
		const binding = surface.worktree ?? request.boundWorktree;
		const prepared = prepareNativeRun({
			id: location.id,
			artifactDir: location.artifactDir,
			cwd: surface.targetCwd,
			name: request.name,
			agent: request.agent,
			plan: request.plan,
			model: request.model,
			resume: request.resume,
			worktreeLeaseFrom: request.worktreeLeaseFrom,
			worktree: binding
				? {
						path: binding.path,
						workspaceId: binding.workspaceId,
						branch: binding.branch,
						baseSha: binding.baseSha,
						manifestFile: binding.manifestFile,
					}
				: undefined,
		});
		run = prepared.run;
		if (surface.worktree) {
			surface.worktree.sessionFile = run.markerFile;
			const update: JsonObject = {
				sessionFile: run.markerFile,
				harness: run.harness,
			};
			if (request.reuseWorktree) {
				update.fallbackAttempt = location.id;
				update.nativeModel = run.model;
			}
			writeWorktreeManifest(surface.worktree.manifestFile, update);
		}
		nativeOperations.validate(run);
		await readyUnlessAborted(
			operations.waitForShellReady(surface.surface),
			request.signal,
		);
		// Last check before dispatch: an abort here leaves nothing started, so
		// the failure path below can prove the run never began and clean up.
		throwIfLaunchAborted(request.signal);
		request.beforeDispatch?.(run);
		if (surface.worktree) persistWorktreeResult(surface.worktree, "running");
		const launchScriptFile = operations.runScript(
			surface.surface,
			supervisedCommand(prepared.command, run.processRun),
			{
				scriptPath: join(
					location.artifactDir,
					"subagent-scripts",
					`${safeName(request.name) || "subagent"}-${run.harness}-${location.id}.sh`,
				),
				scriptPreamble: [
					shellComment(
						`Native ${run.harness} subagent launch script for ${request.name}`,
					),
					shellComment(`Generated: ${new Date().toISOString()}`),
					shellComment(`Native marker: ${run.markerFile}`),
					shellComment(`Surface: ${surface.surface}`),
				].join("\n"),
			},
		);
		markNativeSubmitted(run);
		if (request.boundWorktree)
			persistWorktreeResult(request.boundWorktree, "running");
		return {
			id: location.id,
			name: request.name,
			task: request.task,
			agent: request.agent,
			surface: surface.surface,
			startTime: location.startTime,
			sessionFile: run.markerFile,
			launchScriptFile,
			interactive: request.behavior.interactive,
			runtimePlan: undefined,
			worktree: surface.worktree ?? request.boundWorktree,
			lifecycle: createLifecycle(location.startTime),
			native: run,
		};
	} catch (error) {
		if (run && surface) {
			// The cancel marker stops a late-starting wrapper; owned files are
			// removed only when no owned process can be running.
			const exit = releaseNativeRun(run);
			if (exit.kind === "unconfirmed") {
				// An owned process may be running: never close its pane, capture
				// Git state, or release its profile, marker, or leases.
				const worktree = surface.worktree ?? request.boundWorktree;
				if (worktree) retainUnresolvedWorktree(worktree, exit.reason);
				throw new NativeLaunchUnresolvedError(
					`${errorMessage(error)} Native process exit is unconfirmed (${exit.reason}); its pane ${surface.surface}, owned run files at ${run.runDir}, and session lease${worktree ? `, and the worktree ${worktree.path} with its lease,` : ""} are retained until exit is confirmed.`,
					run,
					surface.surface,
					worktree,
				);
			}
		}
		rethrowLaunchFailure(request.surface, surface, error, operations);
	}
}

/** The parent aborted a native launch before its process was dispatched. */
export class NativeLaunchAbortedError extends Error {
	constructor() {
		super("Native launch cancelled before its process was dispatched.");
		this.name = "NativeLaunchAbortedError";
	}
}

function throwIfLaunchAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new NativeLaunchAbortedError();
}

/** Resolve with `ready`, or reject as soon as the launch is aborted. */
function readyUnlessAborted(
	ready: Promise<void>,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (!signal) return ready;
	throwIfLaunchAborted(signal);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new NativeLaunchAbortedError());
		signal.addEventListener("abort", onAbort, { once: true });
		ready.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * A native launch failed after its process may have been dispatched, and the
 * owned process exit is unconfirmed. The caller must track the run as
 * unresolved so its pane, owned files, and leases stay retained.
 */
export class NativeLaunchUnresolvedError extends Error {
	readonly run: NativeRun;
	readonly surface: string;
	readonly worktree: WorktreeLaunch | undefined;
	constructor(
		message: string,
		run: NativeRun,
		surface: string,
		worktree: WorktreeLaunch | undefined,
	) {
		super(message);
		this.name = "NativeLaunchUnresolvedError";
		this.run = run;
		this.surface = surface;
		this.worktree = worktree;
	}
}

/** A handoff whose Git state is unknown because a process may still write it. */
export function unknownWorktreeHandoff(
	worktree: WorktreeLaunch,
	reason: string,
): WorktreeHandoff {
	return {
		...worktree,
		headSha: null,
		commitsAhead: null,
		clean: null,
		conflicted: null,
		changedFiles: null,
		untrackedFiles: null,
		gitError: `Git state not captured: native process exit is unconfirmed (${reason}).`,
	};
}

/** Mark a worktree failed and unresolved without capturing its Git state. */
export function retainUnresolvedWorktree(
	worktree: WorktreeLaunch,
	reason: string,
): WorktreeHandoff {
	const handoff = unknownWorktreeHandoff(worktree, reason);
	try {
		persistWorktreeResult(worktree, "failed", handoff);
		writeWorktreeManifest(worktree.manifestFile, {
			processExit: "unconfirmed",
		});
	} catch (error) {
		handoff.gitError = `${handoff.gitError} Manifest update failed: ${errorMessage(error)}`;
	}
	return handoff;
}

/**
 * Select the Herdr surface for a native run. Fresh runs share Pi's surface
 * provisioning; fallback attempts reuse the retained worktree root pane;
 * resumes open an ordinary pane at the session's recorded cwd.
 */
function prepareNativeSurface(
	request: FreshNativeLaunchRequest,
	location: LaunchLocation,
	operations: PiLaunchOperations,
): PreparedSurface {
	if (request.reuseWorktree) {
		if (request.resume || request.worktree || request.surface)
			throw new Error("A fallback attempt reuses only its retained worktree.");
		return {
			surface: request.reuseWorktree.paneId,
			targetCwd: request.reuseWorktree.path,
			effectiveAgentDir: location.agentDir,
			localAgentDir: null,
			worktree: request.reuseWorktree,
		};
	}
	if (request.resume) {
		if (request.worktree)
			throw new Error("Native resume cannot create a new worktree.");
		const cwd = request.resume.marker.cwd;
		if (request.boundWorktree && request.boundWorktree.path !== cwd)
			throw new Error(
				"Native resume worktree binding does not match the session cwd.",
			);
		return {
			surface: request.surface ?? operations.createPane(request.name, cwd),
			targetCwd: cwd,
			effectiveAgentDir: location.agentDir,
			localAgentDir: null,
		};
	}
	return prepareLaunchSurface({ ...location, request }, operations);
}

/**
 * Common failure handling after surface preparation: close only an ordinary
 * pane this launch created, and retain a managed worktree with a failed
 * manifest. The original launch error remains authoritative.
 */
function rethrowLaunchFailure(
	callerSurface: string | undefined,
	surface: PreparedSurface | undefined,
	error: any,
	operations: PiLaunchOperations,
): never {
	if (!surface) throw error;
	if (!surface.worktree) {
		if (!callerSurface) {
			try {
				operations.closePane(surface.surface);
			} catch {
				// The launch error remains authoritative when cleanup also fails.
			}
		}
		throw error;
	}
	const handoff = captureWorktreeHandoff(surface.worktree);
	try {
		persistWorktreeResult(surface.worktree, "failed", handoff);
	} catch {
		// The launch error remains authoritative when persistence also fails.
	}
	throw new Error(
		`Failed to launch subagent; worktree retained at ${surface.worktree.path} ` +
			`(workspace ${surface.worktree.workspaceId}): ${errorMessage(error)}`,
	);
}

/** The native session marker a launch with this ID and parent will write. */
export function nativeSessionMarkerPath(
	parent: Pick<FreshPiLaunchRequest["parent"], "sessionDir" | "sessionId">,
	id: string,
): string {
	return join(
		parent.sessionDir,
		"artifacts",
		parent.sessionId,
		"native-sessions",
		`${id}.json`,
	);
}

function resolveLaunchLocation(request: {
	id?: string;
	cwd?: string;
	parent: FreshPiLaunchRequest["parent"];
	behavior: { cwd?: string };
}): LaunchLocation {
	const id = request.id ?? Math.random().toString(16).slice(2, 10);
	const agentDir =
		request.parent.agentDir ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent");
	const rawCwd = request.cwd ?? request.behavior.cwd;
	const cwdBase =
		request.cwd == null && request.behavior.cwd != null
			? agentDir
			: (request.parent.invocationCwd ?? request.parent.cwd);
	const sourceCwd = rawCwd
		? rawCwd.startsWith("/")
			? rawCwd
			: join(cwdBase, rawCwd)
		: request.parent.cwd;
	const localAgentDir = rawCwd ? join(sourceCwd, ".pi", "agent") : null;
	return {
		id,
		startTime: Date.now(),
		agentDir,
		localAgentDir:
			localAgentDir && existsSync(localAgentDir) ? localAgentDir : null,
		sourceCwd,
		artifactDir: join(
			request.parent.sessionDir,
			"artifacts",
			request.parent.sessionId,
		),
	};
}

function resolveLaunchRequest(request: FreshPiLaunchRequest): ResolvedLaunch {
	let sessionMode: SubagentSessionMode = request.behavior.sessionMode;
	if (request.fork === true) sessionMode = "fork";
	else if (request.fork === false) sessionMode = "standalone";
	return {
		...resolveLaunchLocation(request),
		request,
		sessionMode,
		taskDelivery: sessionMode === "fork" ? "direct" : "artifact",
	};
}

function prepareLaunchSurface(
	resolved: SurfaceLaunch,
	operations: PiLaunchOperations,
): PreparedSurface {
	const { request } = resolved;
	if (!request.worktree) {
		return {
			surface:
				request.surface ??
				operations.createPane(request.name, resolved.sourceCwd),
			targetCwd: resolved.sourceCwd,
			effectiveAgentDir: resolved.localAgentDir ?? resolved.agentDir,
			localAgentDir: resolved.localAgentDir,
		};
	}
	if (request.surface)
		throw new Error("A worktree subagent cannot use a pre-created pane");

	const baseRef = request.worktree.base ?? "HEAD";
	const baseSha = resolveGitCommit(resolved.sourceCwd, baseRef);
	const provisionCwd = resolveWorktreeProvisionCwd(resolved.sourceCwd);
	const manifestFile = join(
		resolved.artifactDir,
		"worktree-runs",
		`${resolved.id}.json`,
	);
	const ownership = {
		id: resolved.id,
		name: request.name,
		sourceCwd: resolved.sourceCwd,
		branch: request.worktree.branch,
		baseRef,
		baseSha,
		createdAt: resolved.startTime,
	};
	writeWorktreeManifest(manifestFile, {
		state: "provisioning",
		...ownership,
	});

	let created: HerdrWorktreeSurface;
	try {
		created = operations.createWorktree(
			request.name,
			provisionCwd,
			request.worktree.branch,
			baseSha,
		);
	} catch (error) {
		const failedManifest: FailedWorktreeManifest = {
			state: "failed",
			...ownership,
		};
		if (error instanceof HerdrWorktreeCreateError) {
			Object.assign(failedManifest, error.recoveredWorktree);
		}
		failedManifest.error = errorMessage(error);
		writeWorktreeManifest(manifestFile, failedManifest);
		throw error;
	}

	const worktree: WorktreeLaunch = {
		path: created.path,
		workspaceId: created.workspaceId,
		paneId: created.paneId,
		branch: created.branch,
		baseRef,
		baseSha,
		manifestFile,
	};
	writeWorktreeManifest(manifestFile, {
		state: "provisioned",
		...ownership,
		...worktree,
	});
	const isolatedAgentDir = join(created.path, ".pi", "agent");
	const hasIsolatedAgentDir = existsSync(isolatedAgentDir);
	return {
		surface: created.paneId,
		targetCwd: created.path,
		effectiveAgentDir: hasIsolatedAgentDir
			? isolatedAgentDir
			: resolved.agentDir,
		localAgentDir: hasIsolatedAgentDir ? isolatedAgentDir : null,
		worktree,
	};
}

function prepareChildSession(
	resolved: ResolvedLaunch,
	surface: PreparedSurface,
): PreparedSession {
	const sessionDir = getDefaultSessionDirFor(
		surface.targetCwd,
		surface.effectiveAgentDir,
	);
	const timestamp = timestampForFile();
	const uuid = [
		resolved.id,
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	const sessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
	if (surface.worktree) {
		surface.worktree.sessionFile = sessionFile;
		writeWorktreeManifest(surface.worktree.manifestFile, { sessionFile });
	}
	writeSubagentSessionPolicy(sessionFile, {
		owner: surface.worktree ? "managed-worktree" : "public",
		tools: resolved.request.behavior.tools,
		deniedTools: resolved.request.behavior.deniedTools,
		persistent: resolved.request.behavior.persistent,
		logicalId: resolved.request.behavior.logicalId ?? resolved.id,
		generationId: resolved.request.behavior.generationId,
		worktree: surface.worktree
			? {
					path: surface.worktree.path,
					workspaceId: surface.worktree.workspaceId,
					branch: surface.worktree.branch,
					baseSha: surface.worktree.baseSha,
				}
			: undefined,
	});
	const activityFile = getSubagentActivityFile(
		resolved.artifactDir,
		resolved.id,
	);
	return { ...surface, sessionFile, activityFile };
}

async function confirmShellReady(
	session: PreparedSession,
	operations: PiLaunchOperations,
): Promise<void> {
	await operations.waitForShellReady(session.surface);
}

function buildWorktreeHandoffMessage(
	request: FreshPiLaunchRequest,
	worktree: WorktreeLaunch,
	sessionFile: string,
): string {
	const task = request.task.slice(0, 2000);
	return [
		"Worktree handoff context:",
		`Branch: ${worktree.branch}`,
		`Base commit: ${worktree.baseSha}`,
		`Worktree: ${worktree.path}`,
		`Source session: ${request.parent.sessionFile}`,
		`Fork session: ${sessionFile}`,
		"",
		"Requested task:",
		task || "Continue the current work in this worktree.",
	].join("\n");
}

function prepareTaskArtifacts(
	resolved: ResolvedLaunch,
	session: PreparedSession,
): PreparedArtifacts {
	const { request } = resolved;
	if (request.handoff) {
		if (!session.worktree) {
			throw new Error("A worktree handoff requires a managed worktree");
		}
		const handoffMessage = buildWorktreeHandoffMessage(
			request,
			session.worktree,
			session.sessionFile,
		);
		createWorktreeSessionFork({
			parentSessionFile: request.parent.sessionFile,
			leafId: request.handoff.leafId,
			childSessionFile: session.sessionFile,
			childCwd: session.targetCwd,
			handoffMessage,
		});
		session.worktree.sourceSessionFile = request.parent.sessionFile;
		session.worktree.handoffMessage = handoffMessage;
		writeWorktreeManifest(session.worktree.manifestFile, {
			sourceSessionFile: request.parent.sessionFile,
			handoffMessage,
		});
	} else if (resolved.sessionMode !== "standalone") {
		seedSubagentSessionFile({
			mode: resolved.sessionMode,
			parentSessionFile: request.parent.sessionFile,
			childSessionFile: session.sessionFile,
			childCwd: session.targetCwd,
		});
	}
	mkdirSync(dirname(session.activityFile), { recursive: true });

	const identityInSystemPrompt =
		request.behavior.systemPromptMode && request.behavior.identity;
	const roleBlock =
		request.behavior.identity && !identityInSystemPrompt
			? `\n\n${request.behavior.identity}`
			: "";
	const modeHint = request.behavior.autoExit
		? "Complete your task autonomously."
		: "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
	const summaryInstruction = request.behavior.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
	const fullTask = request.handoff
		? request.task
		: resolved.sessionMode === "fork"
			? request.task
			: `${roleBlock}\n\n${modeHint}\n\n${request.task}\n\n${summaryInstruction}`;
	let taskArg = fullTask;
	if (resolved.taskDelivery === "artifact" && !request.handoff) {
		const artifactPath = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(artifactPath), { recursive: true });
		writeFileSync(artifactPath, fullTask, "utf8");
		taskArg = `@${artifactPath}`;
	}

	let systemPromptFile: string | undefined;
	if (identityInSystemPrompt) {
		systemPromptFile = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-sysprompt-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(systemPromptFile), { recursive: true });
		writeFileSync(systemPromptFile, identityInSystemPrompt, "utf8");
	}
	return { ...session, taskArg, systemPromptFile };
}

function buildPiCommand(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
): string {
	const { request } = resolved;
	const parts = [
		"pi",
		"--session",
		shellQuote(artifacts.sessionFile),
		...(request.handoff
			? []
			: ["-e", shellQuote(join(SUBAGENTS_DIR, "subagent-done.ts"))]),
		"--model",
		shellQuote(request.runtimePlan.model),
		"--thinking",
		shellQuote(request.runtimePlan.thinking),
	];
	if (artifacts.systemPromptFile) {
		parts.push(
			request.behavior.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			shellQuote(artifacts.systemPromptFile),
		);
	}
	const toolAllowlist = buildSubagentToolAllowlist(
		request.behavior.tools,
		request.behavior.autoExit,
	);
	if (toolAllowlist) parts.push("--tools", shellQuote(toolAllowlist));
	if (!request.handoff) {
		for (const prompt of buildPromptArgs(
			request.behavior.skills,
			resolved.taskDelivery,
			artifacts.taskArg,
		)) {
			parts.push(shellQuote(prompt));
		}
	}

	const env: string[] = [];
	if (artifacts.localAgentDir) {
		env.push(`PI_CODING_AGENT_DIR=${shellQuote(artifacts.localAgentDir)}`);
	} else if (process.env.PI_CODING_AGENT_DIR) {
		env.push(
			`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`,
		);
	}
	if (!request.handoff) {
		if (request.behavior.deniedTools.length > 0) {
			env.push(
				`PI_DENY_TOOLS=${shellQuote(request.behavior.deniedTools.join(","))}`,
			);
		}
		env.push(`PI_SUBAGENT_NAME=${shellQuote(request.name)}`);
		if (request.agent)
			env.push(`PI_SUBAGENT_AGENT=${shellQuote(request.agent)}`);
		env.push(`PI_SUBAGENT_AUTO_EXIT=${request.behavior.autoExit ? "1" : "0"}`);
		if (request.behavior.persistent) {
			env.push("PI_SUBAGENT_PERSISTENT=1");
			env.push(
				`PI_SUBAGENT_GENERATION_ID=${shellQuote(request.behavior.generationId ?? "")}`,
			);
			env.push(
				`PI_SUBAGENT_TASK_ID=${shellQuote(request.behavior.taskId ?? "")}`,
			);
		}
		env.push(`PI_SUBAGENT_SESSION=${shellQuote(artifacts.sessionFile)}`);
		env.push(`PI_SUBAGENT_ID=${shellQuote(resolved.id)}`);
		env.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(artifacts.activityFile)}`);
		env.push(`PI_SUBAGENT_SURFACE=${shellQuote(artifacts.surface)}`);
	}

	const piCommand =
		`cd ${shellQuote(artifacts.targetCwd)} && ` +
		`${env.join(" ")} ${parts.join(" ")}`;
	return request.handoff
		? piCommand
		: `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
}

function startPiProcess(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
	command: string,
	operations: PiLaunchOperations,
): string {
	const launchScriptFile = join(
		resolved.artifactDir,
		"subagent-scripts",
		`${safeName(resolved.request.name) || "subagent"}-${resolved.id}.sh`,
	);
	if (artifacts.worktree && !resolved.request.handoff) {
		persistWorktreeResult(artifacts.worktree, "running");
	}
	return operations.runScript(artifacts.surface, command, {
		scriptPath: launchScriptFile,
		scriptPreamble: [
			shellComment(`Subagent launch script for ${resolved.request.name}`),
			shellComment(`Generated: ${new Date().toISOString()}`),
			shellComment(`Session: ${artifacts.sessionFile}`),
			shellComment(`Surface: ${artifacts.surface}`),
		].join("\n"),
	});
}

function createRunningChild(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
	launchScriptFile: string,
): PiRunningChild {
	return {
		id: resolved.id,
		name: resolved.request.name,
		task: resolved.request.task,
		agent: resolved.request.agent,
		surface: artifacts.surface,
		startTime: resolved.startTime,
		sessionFile: artifacts.sessionFile,
		launchScriptFile,
		activityFile: artifacts.activityFile,
		interactive: resolved.request.behavior.interactive,
		runtimePlan: resolved.request.runtimePlan,
		worktree: artifacts.worktree,
		lifecycle: createLifecycle(resolved.startTime),
	};
}

async function launchResumedPiSubagent(
	request: ResumePiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	const id = request.id ?? Math.random().toString(16).slice(2, 10);
	const policy = readSubagentSessionPolicy(request.sessionFile);
	if (policy.owner !== "public") {
		throw new Error(
			`Cannot resume ${policy.owner} session through subagent_resume. ` +
				"Use its retained managed-worktree workspace instead.",
		);
	}
	if (policy.persistent) {
		throw new Error(
			`Cannot resume persistent specialist ${request.sessionFile}. Spawn a new specialist instead; persistent sessions retain their evidence but do not revive in v1.`,
		);
	}
	const autoExit = request.behavior?.autoExit ?? true;
	const interactive = request.behavior?.interactive ?? !autoExit;
	const startTime = Date.now();
	const artifactDir = join(
		request.parent.sessionDir,
		"artifacts",
		request.parent.sessionId,
	);
	const header = getNewEntries(request.sessionFile, 0).find(
		(entry) => entry.type === "session",
	);
	const cwd = isNonEmptyString(header?.cwd) ? header.cwd : process.cwd();
	const surface = operations.createPane(request.name, cwd);
	try {
		await operations.waitForShellReady(surface);
		const activityFile = getSubagentActivityFile(artifactDir, id);
		mkdirSync(dirname(activityFile), { recursive: true });

		let messageFile: string | undefined;
		if (request.message) {
			messageFile = join(
				artifactDir,
				"subagent-resume",
				`${safeName(request.name) || "resume"}-${timestampForFile(false)}.md`,
			);
			mkdirSync(dirname(messageFile), { recursive: true });
			writeFileSync(messageFile, request.message, "utf8");
		}

		const env = [
			...(process.env.PI_CODING_AGENT_DIR
				? [`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`]
				: []),
			...(policy.deniedTools.length > 0
				? [`PI_DENY_TOOLS=${shellQuote(policy.deniedTools.join(","))}`]
				: []),
			`PI_SUBAGENT_NAME=${shellQuote(request.name)}`,
			`PI_SUBAGENT_SESSION=${shellQuote(request.sessionFile)}`,
			`PI_SUBAGENT_ID=${shellQuote(id)}`,
			`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`,
			`PI_SUBAGENT_AUTO_EXIT=${autoExit ? "1" : "0"}`,
		];
		const toolAllowlist = buildSubagentToolAllowlist(
			policy.tools?.join(","),
			autoExit,
		);
		const command = [
			...env,
			"pi",
			"--session",
			shellQuote(request.sessionFile),
			...(toolAllowlist ? ["--tools", shellQuote(toolAllowlist)] : []),
			"-e",
			shellQuote(join(SUBAGENTS_DIR, "subagent-done.ts")),
			...(messageFile ? [shellQuote(`@${messageFile}`)] : []),
		].join(" ");
		const launchScriptFile = operations.runScript(
			surface,
			`${command}; echo '__SUBAGENT_DONE_'$?'__'`,
			{
				scriptPath: join(
					artifactDir,
					"subagent-scripts",
					`${safeName(request.name) || "resume"}-resume-${Date.now()}.sh`,
				),
				scriptPreamble: [
					shellComment(`Subagent resume script for ${request.name}`),
					shellComment(`Generated: ${new Date().toISOString()}`),
					shellComment(`Session: ${request.sessionFile}`),
					shellComment(`Surface: ${surface}`),
					...(messageFile
						? [shellComment(`Resume message file: ${messageFile}`)]
						: []),
				].join("\n"),
			},
		);
		return {
			id,
			name: request.name,
			task: request.message ?? "resumed session",
			surface,
			startTime,
			sessionFile: request.sessionFile,
			launchScriptFile,
			activityFile,
			interactive,
			runtimePlan: undefined,
			lifecycle: createLifecycle(startTime),
		};
	} catch (error) {
		try {
			operations.closePane(surface);
		} catch {
			// The launch error remains authoritative when cleanup also fails.
		}
		throw error;
	}
}

export function buildSubagentToolAllowlist(
	tools?: string,
	autoExit = false,
): string | null {
	const requested = (tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (requested.length === 0) return null;
	const allow = new Set(requested);
	allow.delete("subagent_done");
	allow.add("caller_ping");
	if (!autoExit) allow.add("subagent_done");
	return [...allow].join(",");
}

function buildPromptArgs(
	skills: string | undefined,
	taskDelivery: "direct" | "artifact",
	taskArg: string,
): string[] {
	const skillPrompts = (skills ?? "")
		.split(",")
		.map((skill) => skill.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);
	return [
		...(taskDelivery === "artifact" && skillPrompts.length > 0 ? [""] : []),
		...skillPrompts,
		taskArg,
	];
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

function timestampForFile(includeMilliseconds = true): string {
	return (
		new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, includeMilliseconds ? 23 : 19) +
		(includeMilliseconds ? "Z" : "")
	);
}

function shellComment(value: string): string {
	return `# ${value.replace(/[\r\n\u2028\u2029]/g, " ")}`;
}

function safeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function resolveGitCommit(cwd: string, ref: string): string {
	return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function resolveWorktreeProvisionCwd(sourceCwd: string): string {
	let gitDir: string;
	let commonDir: string;
	try {
		gitDir = resolveGitPath(sourceCwd, "--git-dir");
		commonDir = resolveGitPath(sourceCwd, "--git-common-dir");
	} catch (error) {
		throw new Error(
			`Unable to identify the Git checkout for worktree provisioning from ${sourceCwd}: ${errorMessage(error)}`,
		);
	}
	if (gitDir === commonDir) return sourceCwd;

	try {
		const output = execFileSync(
			"git",
			["worktree", "list", "--porcelain", "-z"],
			{ cwd: sourceCwd },
		).toString("utf8");
		const principal = output
			.split("\0")
			.find((record) => record.startsWith("worktree "))
			?.slice("worktree ".length);
		if (!principal) throw new Error("Git returned no principal worktree");
		return principal;
	} catch (error) {
		throw new Error(
			`Unable to determine the principal Git checkout for linked worktree ${sourceCwd}: ${errorMessage(error)}`,
		);
	}
}

function resolveGitPath(
	cwd: string,
	flag: "--git-dir" | "--git-common-dir",
): string {
	const output = execFileSync(
		"git",
		["rev-parse", "--path-format=absolute", flag],
		{ cwd, encoding: "utf8" },
	);
	return output.endsWith("\n") ? output.slice(0, -1) : output;
}

export function readWorktreeManifest(path: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			isRecord(value) &&
			value.version === 1 &&
			value.kind === "worktree-run" &&
			value.owner === "pi-herdr-subagents"
		)
			return value;
	} catch {
		// Unreachable or malformed manifests do not establish ownership.
	}
	return undefined;
}

export function writeWorktreeManifest(path: string, value: JsonObject): void {
	mkdirSync(dirname(path), { recursive: true });
	let existing: JsonObject = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			existing = {};
		}
	}
	const tempPath = `${path}.tmp`;
	writeFileSync(
		tempPath,
		`${JSON.stringify(
			{
				...existing,
				...value,
				version: 1,
				kind: "worktree-run",
				owner: "pi-herdr-subagents",
				updatedAt: Date.now(),
			},
			null,
			2,
		)}\n`,
	);
	renameSync(tempPath, path);
}

function gitPathList(cwd: string, args: string[]): string[] {
	return execFileSync("git", args, { cwd, encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
}

export function captureWorktreeHandoff(
	worktree: WorktreeLaunch,
): WorktreeHandoff {
	try {
		const headSha = resolveGitCommit(worktree.path, "HEAD");
		const status = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all", "-z"],
			{ cwd: worktree.path, encoding: "utf8" },
		);
		const untrackedFiles = gitPathList(worktree.path, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		]);
		const conflictedFiles = gitPathList(worktree.path, [
			"diff",
			"--name-only",
			"--diff-filter=U",
			"-z",
		]);
		const changedFiles = new Set([
			...gitPathList(worktree.path, [
				"diff",
				"--name-only",
				"-z",
				`${worktree.baseSha}...HEAD`,
			]),
			...gitPathList(worktree.path, ["diff", "--name-only", "-z"]),
			...gitPathList(worktree.path, ["diff", "--cached", "--name-only", "-z"]),
			...untrackedFiles,
		]);
		const commitsAhead = Number.parseInt(
			execFileSync(
				"git",
				["rev-list", "--count", `${worktree.baseSha}..HEAD`],
				{ cwd: worktree.path, encoding: "utf8" },
			).trim(),
			10,
		);
		return {
			...worktree,
			headSha,
			commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : 0,
			clean: status.length === 0,
			conflicted: conflictedFiles.length > 0,
			changedFiles: [...changedFiles].sort(),
			untrackedFiles: untrackedFiles.sort(),
		};
	} catch (error) {
		return {
			...worktree,
			headSha: null,
			commitsAhead: null,
			clean: null,
			conflicted: null,
			changedFiles: null,
			untrackedFiles: null,
			gitError: errorMessage(error),
		};
	}
}

export function persistWorktreeResult(
	worktree: WorktreeLaunch,
	state: "running" | "ready_for_review" | "failed" | "needs_help" | "removed",
	handoff?: WorktreeHandoff,
): void {
	writeWorktreeManifest(worktree.manifestFile, {
		state,
		...worktree,
		...handoff,
	});
}

export function runSubagentScript(
	surface: string,
	command: string,
	options: Parameters<typeof runScriptInPane>[2],
	worktree?: WorktreeLaunch,
	run: typeof runScriptInPane = runScriptInPane,
): string {
	if (worktree) persistWorktreeResult(worktree, "running");
	try {
		return run(surface, command, options);
	} catch (error) {
		if (!worktree) throw error;
		const handoff = captureWorktreeHandoff(worktree);
		try {
			persistWorktreeResult(worktree, "failed", handoff);
		} catch {
			// The launch error remains authoritative when persistence also fails.
		}
		throw new Error(
			`Failed to launch subagent; worktree retained at ${worktree.path} ` +
				`(workspace ${worktree.workspaceId}): ${errorMessage(error)}`,
		);
	}
}

function errorMessage(error: any): string {
	return error instanceof Error ? error.message : String(error);
}
