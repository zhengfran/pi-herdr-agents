/**
 * Current-host input compatibility and eligibility for automatic routing.
 *
 * This is the package-only contract against the public Pi extension API
 * (inspected on Pi 0.99.1). It needs no host patch, private API, or input
 * metadata the host does not export:
 *
 * - Only `ctx.mode === "tui"`, `event.source === "interactive"`, and an
 *   absent `event.streamingBehavior` can be admitted. Every RPC, JSON, print,
 *   extension-origin, and steer/follow-up event bypasses.
 * - Text and images are the handler-visible current view after any earlier
 *   transform. Nothing here can recover the original submission, prove that
 *   no image or command marker was removed upstream, or identify a host
 *   submission: a package decision ID correlates one local attempt only.
 * - `ctx.signal` is the active agent-operation signal and is undefined while
 *   idle, so it is never read as an idle-input cancellation facility.
 * - Required public methods are feature-detected; their absence is a local
 *   `unsupported-public-api` bypass with no classifier or launch call.
 *
 * The gate is synchronous so the coordinator reserves its in-flight slot
 * before the first await. Request recording confirms `pi.sendMessage`, which
 * returns no acknowledgement, through the public read-only branch plus a
 * bounded read-back of the existing on-disk session artifact.
 *
 * createAutoRoutingCoordinator wires the gate to one package decision at a
 * time: a random decision ID and session generation, a package-owned
 * AbortController, the pinned two-batch classification on one deadline, an
 * irreversible ownership latch, verified request persistence, TUI-only
 * shadow/pilot/auto behavior, and one injected launch handoff. It never
 * deduplicates host submissions, replays input, or promises that TUI Escape
 * cancels an idle classification.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
	type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { types as utilTypes } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	AUTO_ROUTING_REQUEST_LIMITS,
	buildAutoRoutingSnapshot,
	revalidateAutoRoutingSnapshot,
	type AutoCandidate,
	type AutoPreparedRun,
	type AutoRoleCatalog,
	type AutoRoutingAuthority,
	type AutoRoutingSnapshot,
} from "./auto-routing-candidates.ts";
import {
	canonicalJson,
	type EnabledAutoRoutingMode,
	type EnabledAutoRoutingState,
	type LoadedAutoRoutingConfig,
} from "./auto-routing-config.ts";
import {
	AUTO_REASON_CODES,
	AUTO_ROUTING_POLICY_VERSION,
	AUTO_ROUTING_QUESTION_VERSION,
	decideAfterBatchA,
	decideAfterBatchB,
	type AutoBypassReason,
	type AutoCancelReason,
	type AutoReasonCode,
	type AutoRoutingJevModel,
	type AutoSelectedRoute,
	type JevBatchEvidence,
} from "./auto-routing-policy.ts";
import type { JevDeadline, JevTransport } from "./jev-client.ts";
import { buildBatchA, buildBatchB, type JevBatch } from "./jev-questions.ts";
import { isRecord, isString, type JsonObject } from "./type-guards.ts";

/** The host release this contract was inspected against; not a handshake. */
export const AUTO_INPUT_TESTED_PI_VERSION = "0.99.1";

/**
 * Recursion guard stamped on package-created sessions that lack a child
 * identity. It is not an authorization boundary.
 */
export const AUTO_ROUTING_DISABLED_ENV = "PI_HERDR_AUTO_ROUTING_DISABLED";

/** Child launch environment this package sets; any one marks a child. */
export const AUTO_ROUTING_CHILD_ENV = Object.freeze([
	"PI_SUBAGENT_ID",
	"PI_SUBAGENT_SESSION",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_AUTO_EXIT",
	"PI_SUBAGENT_PERSISTENT",
	"PI_SUBAGENT_GENERATION_ID",
	"PI_SUBAGENT_TASK_ID",
]);

/** A user opt-out marker; only its presence in the current view is seen. */
export const AUTO_ROUTING_OPT_OUT_MARKER = "[no-auto-route]";

/**
 * Local eligibility failures, in gate order. Each continues the input
 * unchanged with no classifier call, child, or replacement message.
 * Transformed input is deliberately absent: it cannot be detected.
 */
export const AUTO_INPUT_BYPASS_REASONS = [
	"routing-off",
	"config-invalid",
	"unsupported-public-api",
	"unsupported-session-mode",
	"non-interactive-source",
	"not-fresh-prompt",
	"child-session",
	"auto-busy",
	"parent-busy",
	"image-input",
	"blank-prompt",
	"command-input",
	"prompt-too-large",
	"user-opt-out",
	"egress-screened",
	"no-session-file",
	"herdr-unavailable",
] as const satisfies readonly AutoBypassReason[];
export type AutoInputBypassReason = (typeof AUTO_INPUT_BYPASS_REASONS)[number];

/** The public extension API surface the routing path depends on. */
export type AutoInputHost = Pick<ExtensionAPI, "on" | "sendMessage">;

/** The public context surface the routing path depends on. */
export type AutoInputContext = Pick<
	ExtensionContext,
	| "mode"
	| "cwd"
	| "isIdle"
	| "hasPendingMessages"
	| "sessionManager"
	| "modelRegistry"
	| "ui"
>;

/**
 * Public methods feature-detected before any routing work, by owner.
 * `ctx.signal` is intentionally absent: it is undefined at idle.
 */
export const AUTO_INPUT_REQUIRED_API = Object.freeze({
	pi: Object.freeze(["on", "sendMessage"]),
	ctx: Object.freeze(["isIdle", "hasPendingMessages"]),
	sessionManager: Object.freeze([
		"getSessionId",
		"getSessionFile",
		"getLeafId",
		"getLeafEntry",
	]),
	modelRegistry: Object.freeze(["findOfType", "classify"]),
	/** Pilot confirmation only; missing dialog support never approves. */
	pilotUi: Object.freeze(["confirm"]),
});

const EXTENSION_MODES = new Set(["tui", "rpc", "json", "print"]);
const INPUT_SOURCES = new Set(["interactive", "rpc", "extension"]);
const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);

export type AutoInputSupport =
	| Readonly<{ supported: true }>
	| Readonly<{
			supported: false;
			reason: "unsupported-public-api";
			missing: readonly string[];
	  }>;

function isCallable(value: any): value is (...args: any[]) => any {
	return value instanceof Function;
}

/** A property read that treats a throwing host getter as absent. */
function readMember(owner: any, name: string): any {
	try {
		return owner === null || owner === undefined ? undefined : owner[name];
	} catch {
		return undefined;
	}
}

/** One event-field read that keeps a failed read distinct from undefined. */
type Captured = Readonly<{ ok: true; value: any }> | Readonly<{ ok: false }>;

const NOT_CAPTURED: Captured = Object.freeze({ ok: false });

/**
 * Capture an own data property exactly once. The host builds the input event
 * as a plain object literal, so an accessor, a throwing proxy trap, or an
 * inherited field fails rather than being re-read or treated as undefined.
 * Only a field absent from the whole prototype chain reads as undefined; the
 * `in` check consults presence without invoking an inherited accessor.
 */
function captureField(owner: any, name: string): Captured {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(owner, name);
		if (descriptor === undefined)
			return name in owner
				? NOT_CAPTURED
				: Object.freeze({ ok: true, value: undefined });
		if (!("value" in descriptor)) return NOT_CAPTURED;
		return Object.freeze({ ok: true, value: descriptor.value });
	} catch {
		return NOT_CAPTURED;
	}
}

/** The event fields the gate reads, each captured once, or undefined. */
type CapturedInput = Readonly<{
	text: string;
	source: string;
	streamingBehavior: string | undefined;
	imageCount: number;
}>;

function captureInputEvent(event: any): CapturedInput | undefined {
	const text = captureField(event, "text");
	const source = captureField(event, "source");
	const streaming = captureField(event, "streamingBehavior");
	const images = captureField(event, "images");
	if (
		!text.ok ||
		// A primitive check: `isString` would consult a hostile
		// `Symbol.toStringTag` and admit boxed strings.
		// oxlint-disable-next-line anti-slop/no-runtime-typeof
		typeof text.value !== "string" ||
		!source.ok ||
		!INPUT_SOURCES.has(source.value) ||
		!streaming.ok ||
		!(
			streaming.value === undefined || STREAMING_BEHAVIORS.has(streaming.value)
		) ||
		!images.ok
	)
		return undefined;
	let imageCount = 0;
	if (images.value !== undefined) {
		try {
			// A revoked proxy throws here rather than answering.
			if (!Array.isArray(images.value)) return undefined;
		} catch {
			return undefined;
		}
		const length = captureField(images.value, "length");
		if (!length.ok || !Number.isSafeInteger(length.value)) return undefined;
		imageCount = length.value;
	}
	return Object.freeze({
		text: text.value,
		source: source.value,
		streamingBehavior: streaming.value,
		imageCount,
	});
}

/**
 * Feature-detect the public methods this routing mode needs. Only property
 * presence is inspected: nothing is called, and `ctx.signal` is never read.
 */
export function detectAutoInputSupport(
	pi: AutoInputHost,
	ctx: AutoInputContext,
	mode: EnabledAutoRoutingMode,
): AutoInputSupport {
	const missing: string[] = [];
	const methods = (owner: any, label: string, names: readonly string[]) => {
		for (const name of names)
			if (!isCallable(readMember(owner, name)))
				missing.push(`${label}.${name}`);
	};
	methods(pi, "pi", AUTO_INPUT_REQUIRED_API.pi);
	if (!EXTENSION_MODES.has(readMember(ctx, "mode"))) missing.push("ctx.mode");
	const cwd = readMember(ctx, "cwd");
	if (!isString(cwd) || cwd === "") missing.push("ctx.cwd");
	methods(ctx, "ctx", AUTO_INPUT_REQUIRED_API.ctx);
	methods(
		readMember(ctx, "sessionManager"),
		"ctx.sessionManager",
		AUTO_INPUT_REQUIRED_API.sessionManager,
	);
	methods(
		readMember(ctx, "modelRegistry"),
		"ctx.modelRegistry",
		AUTO_INPUT_REQUIRED_API.modelRegistry,
	);
	if (mode === "pilot")
		methods(readMember(ctx, "ui"), "ctx.ui", AUTO_INPUT_REQUIRED_API.pilotUi);
	return missing.length === 0
		? Object.freeze({ supported: true })
		: Object.freeze({
				supported: false,
				reason: "unsupported-public-api",
				missing: Object.freeze(missing),
			});
}

/** Whether this process is a subagent child or an opted-out side session. */
export function isAutoRoutingChildEnvironment(env: NodeJS.ProcessEnv): boolean {
	return [...AUTO_ROUTING_CHILD_ENV, AUTO_ROUTING_DISABLED_ENV].some(
		(name) => (env[name] ?? "") !== "",
	);
}

const PRIVATE_KEY_BLOCK =
	/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const CREDENTIAL_TOKENS = [
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{22,}/,
	/\bglpat-[A-Za-z0-9_-]{20,}/,
	/\bxox[abeprs]-[A-Za-z0-9-]{10,}/,
	/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
	/\bAIza[0-9A-Za-z_-]{35}/,
	/\bnpm_[A-Za-z0-9]{36}\b/,
	/\b[rs]k_live_[A-Za-z0-9]{16,}/,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];
const CREDENTIAL_ASSIGNMENT =
	/\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|credentials?)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i;
const AUTHORIZATION_HEADER =
	/\bauthorization\s*:\s*(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/i;
/** Control characters other than tab, newline, and carriage return. */
const CONTROL = /[^\P{Cc}\t\n\r]/u;
/** Lone surrogates and replacement characters suggest binary or broken text. */
const BINARY_TEXT = /[\p{Cs}�]/u;

export type AutoTextScreening =
	| Readonly<{ ok: true }>
	| Readonly<{
			ok: false;
			reason:
				| "blank-prompt"
				| "command-input"
				| "prompt-too-large"
				| "user-opt-out"
				| "egress-screened";
			detail: string;
	  }>;

function screened(
	reason: Exclude<AutoTextScreening, { ok: true }>["reason"],
	detail: string,
): AutoTextScreening {
	return Object.freeze({ ok: false, reason, detail });
}

/**
 * Screen the handler-visible text before any egress. This is defense in
 * depth over the current view, not secret detection or an original-input
 * guarantee: an earlier transform may already have removed a command,
 * marker, or image, or added file content. Details never echo the text.
 */
export function screenAutoRoutingText(text: string): AutoTextScreening {
	if (text.trim() === "") return screened("blank-prompt", "The text is blank.");
	const lead = text.trimStart();
	if (lead.startsWith("/") || lead.startsWith("!"))
		return screened(
			"command-input",
			"The text starts with command or shell syntax.",
		);
	if (
		Buffer.byteLength(text, "utf8") > AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes
	)
		return screened(
			"prompt-too-large",
			`The text exceeds ${AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes} UTF-8 bytes.`,
		);
	if (text.toLowerCase().includes(AUTO_ROUTING_OPT_OUT_MARKER))
		return screened("user-opt-out", "The text carries the routing opt-out.");
	if (CONTROL.test(text) || BINARY_TEXT.test(text))
		return screened(
			"egress-screened",
			"The text contains control or binary content.",
		);
	if (PRIVATE_KEY_BLOCK.test(text))
		return screened("egress-screened", "The text contains a private key.");
	if (
		CREDENTIAL_TOKENS.some((pattern) => pattern.test(text)) ||
		CREDENTIAL_ASSIGNMENT.test(text) ||
		AUTHORIZATION_HEADER.test(text)
	)
		return screened(
			"egress-screened",
			"The text resembles a credential or credential assignment.",
		);
	return Object.freeze({ ok: true });
}

/** Bound for reading the session header line from disk. */
export const AUTO_SESSION_HEADER_MAX_BYTES = 64 * 1024;

/**
 * The persisted parent session as observed on disk. `size` is the byte
 * offset the next append starts at; `branchAnchor` is the public leaf ID.
 */
export type AutoSessionObservation = Readonly<{
	sessionId: string;
	sessionFile: string;
	device: number;
	inode: number;
	size: number;
	branchAnchor: string | null;
}>;

export type AutoSessionObservationResult =
	| Readonly<{ ok: true; session: AutoSessionObservation }>
	| Readonly<{ ok: false; reason: "no-session-file"; detail: string }>;

function noSession(detail: string): AutoSessionObservationResult {
	return Object.freeze({ ok: false, reason: "no-session-file", detail });
}

/**
 * Open a path read-only without blocking and require a regular file before
 * any read, so a FIFO or device at the session path fails promptly instead
 * of waiting for a writer. The caller closes the returned descriptor.
 */
function openRegularFile(
	path: string,
): Readonly<{ fd: number; stat: Stats }> | undefined {
	let fd: number;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (stat.isFile()) return Object.freeze({ fd, stat });
	} catch {
		// Closed below.
	}
	closeSync(fd);
	return undefined;
}

/** Whether `offset` starts a line: the file start or just after a newline. */
function atLineStart(fd: number, offset: number): boolean {
	return offset === 0 || readRange(fd, offset - 1, 1).toString("utf8") === "\n";
}

/** Read `length` bytes at `position`, or fewer only at end of file. */
function readRange(fd: number, position: number, length: number): Buffer {
	const buffer = Buffer.alloc(length);
	let filled = 0;
	while (filled < length) {
		const read = readSync(
			fd,
			buffer,
			filled,
			length - filled,
			position + filled,
		);
		if (read === 0) break;
		filled += read;
	}
	return buffer.subarray(0, filled);
}

/**
 * Observe the parent session on disk: an existing regular file whose header
 * line names the current public session ID and whose last entry ends in a
 * newline, so the next append starts a line of its own. A non-null file name
 * is not enough, since the host defers creating a new session file until its
 * first conversation message; such a session bypasses rather than being
 * flushed.
 */
export function observeAutoRoutingSession(
	ctx: Pick<ExtensionContext, "sessionManager">,
): AutoSessionObservationResult {
	let sessionId: string | undefined;
	let file: string | undefined;
	let branchAnchor: string | null;
	try {
		const manager = ctx.sessionManager;
		sessionId = manager.getSessionId();
		file = manager.getSessionFile();
		branchAnchor = manager.getLeafId();
	} catch {
		return noSession("The session could not be observed.");
	}
	if (!isString(sessionId) || sessionId === "")
		return noSession("The session has no identity.");
	if (!isString(file) || file === "")
		return noSession("The session is not persisted.");
	const sessionFile = resolve(file);
	const opened = openRegularFile(sessionFile);
	if (opened === undefined)
		return noSession("The session file is not an existing regular file.");
	const { fd, stat } = opened;
	try {
		if (stat.size === 0)
			return noSession("The session file is not a written regular file.");
		const head = readRange(
			fd,
			0,
			Math.min(stat.size, AUTO_SESSION_HEADER_MAX_BYTES),
		).toString("utf8");
		const end = head.indexOf("\n");
		if (end < 0) return noSession("The session header is unreadable.");
		let header: any;
		try {
			header = JSON.parse(head.slice(0, end));
		} catch {
			return noSession("The session header is unreadable.");
		}
		if (
			!isRecord(header) ||
			header.type !== "session" ||
			header.id !== sessionId
		)
			return noSession("The session file belongs to another session.");
		if (!atLineStart(fd, stat.size))
			return noSession("The session file ends inside an entry.");
		return Object.freeze({
			ok: true,
			session: Object.freeze({
				sessionId,
				sessionFile,
				device: stat.dev,
				inode: stat.ino,
				size: stat.size,
				branchAnchor: branchAnchor ?? null,
			}),
		});
	} catch {
		return noSession("The session file could not be read.");
	} finally {
		closeSync(fd);
	}
}

export type AutoRoutingGateInput = Readonly<{
	config: LoadedAutoRoutingConfig;
	event: InputEvent;
	ctx: AutoInputContext;
	pi: AutoInputHost;
	/** Normally `process.env`; only child identity names are read. */
	env: NodeJS.ProcessEnv;
	/** An outstanding decision, auto-owned child, or known managed child. */
	busy: boolean;
	/** Probed only after every in-memory and session predicate passes. */
	herdrAvailable: () => boolean;
}>;

/** An admitted event: the exact captured handler-visible text and session. */
export type AutoRoutingAdmission = Readonly<{
	eligible: true;
	mode: EnabledAutoRoutingMode;
	request: string;
	session: AutoSessionObservation;
}>;

export type AutoRoutingGateResult =
	| AutoRoutingAdmission
	| Readonly<{
			eligible: false;
			reason: AutoInputBypassReason;
			detail: string;
	  }>;

function bypass(
	reason: AutoInputBypassReason,
	detail: string,
): AutoRoutingGateResult {
	return Object.freeze({ eligible: false, reason, detail });
}

/**
 * The synchronous local eligibility gate (§2.1 predicates 1–9) shared by
 * shadow, pilot, and auto. Cheap in-memory predicates run first; RPC, JSON,
 * print, extension, and streaming events are rejected before any context
 * method, session file, or Herdr probe is touched. It never calls the
 * classifier, sends a message, or reads `ctx.signal`. Config drift and the
 * feasible candidate set are checked by the snapshot, not here.
 */
export function evaluateAutoRoutingInput(
	input: AutoRoutingGateInput,
): AutoRoutingGateResult {
	const { config, event, ctx } = input;
	if (config.status === "off")
		return bypass("routing-off", "Automatic routing is off.");
	if (config.status !== "enabled")
		return bypass("config-invalid", "The routing configuration is invalid.");
	const mode = config.config.mode;

	const support = detectAutoInputSupport(input.pi, ctx, mode);
	if (!support.supported)
		return bypass(
			"unsupported-public-api",
			`Missing public API: ${support.missing.join(", ")}.`,
		);
	const captured = captureInputEvent(event);
	if (captured === undefined)
		return bypass(
			"unsupported-public-api",
			"The input event does not match the public contract.",
		);

	if (ctx.mode !== "tui")
		return bypass("unsupported-session-mode", `Mode ${ctx.mode} bypasses.`);
	if (captured.source !== "interactive")
		return bypass(
			"non-interactive-source",
			`Source ${captured.source} bypasses.`,
		);
	if (captured.streamingBehavior !== undefined)
		return bypass(
			"not-fresh-prompt",
			`Streaming ${captured.streamingBehavior} input bypasses.`,
		);
	if (isAutoRoutingChildEnvironment(input.env))
		return bypass("child-session", "This is a child or opted-out session.");
	if (input.busy)
		return bypass(
			"auto-busy",
			"Another automatic decision or child is outstanding.",
		);
	try {
		if (!ctx.isIdle() || ctx.hasPendingMessages())
			return bypass("parent-busy", "The parent is busy or has queued input.");
	} catch {
		return bypass("unsupported-public-api", "The idle state is unavailable.");
	}
	if (captured.imageCount > 0)
		return bypass("image-input", "The current input carries images.");
	const text = captured.text;
	const screening = screenAutoRoutingText(text);
	if (!screening.ok) return bypass(screening.reason, screening.detail);

	const observed = observeAutoRoutingSession(ctx);
	if (!observed.ok) return bypass(observed.reason, observed.detail);
	let herdr = false;
	try {
		herdr = input.herdrAvailable();
	} catch {
		herdr = false;
	}
	if (!herdr) return bypass("herdr-unavailable", "Herdr is not available.");
	return Object.freeze({
		eligible: true,
		mode,
		request: text,
		session: observed.session,
	});
}

/**
 * Package correlation for one local attempt: never a host submission
 * identity or a deduplication key. Identical later text is a new decision.
 */
export type AutoDecisionCorrelation = Readonly<{
	decisionId: string;
	parentSessionId: string;
	sessionGeneration: number;
}>;

/** A fresh random decision ID bound to the observed session generation. */
export function createAutoDecisionCorrelation(
	session: AutoSessionObservation,
	sessionGeneration: number,
): AutoDecisionCorrelation {
	if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0)
		throw new TypeError(
			"Automatic routing session generation must be a non-negative safe integer.",
		);
	return Object.freeze({
		decisionId: `ad-${randomUUID()}`,
		parentSessionId: session.sessionId,
		sessionGeneration,
	});
}

/** Bound for the bytes one recorded request may append to the session file. */
export const AUTO_REQUEST_RECORD_MAX_BYTES = 64 * 1024;

/** Headroom for the host's entry type, IDs, and timestamp around a record. */
const AUTO_ENTRY_ENVELOPE_BYTES = 1024;

/** A non-triggering custom message whose `details.decisionId` correlates it. */
export type AutoRequestRecord = Readonly<{
	customType: string;
	content: string;
	display: boolean;
	details: JsonObject;
}>;

export type AutoRecordConfirmation =
	| Readonly<{ ok: true; entryId: string; offset: number; bytes: number }>
	| Readonly<{
			ok: false;
			reason: "request-record-failed";
			/** Whether `pi.sendMessage` was called: a partial effect may exist. */
			sendAttempted: boolean;
			detail: string;
	  }>;

function recordFailed(
	sendAttempted: boolean,
	detail: string,
): AutoRecordConfirmation {
	return Object.freeze({
		ok: false,
		reason: "request-record-failed",
		sendAttempted,
		detail,
	});
}

function sameSessionFile(
	now: AutoSessionObservation,
	expected: AutoSessionObservation,
): boolean {
	return (
		now.sessionId === expected.sessionId &&
		now.sessionFile === expected.sessionFile &&
		now.device === expected.device &&
		now.inode === expected.inode
	);
}

/**
 * Confirm one just-sent request without polling: the public leaf entry must
 * be exactly this custom message, appended directly on the baseline branch
 * anchor, and the session file (same identity, still a regular file) must
 * have grown by exactly that one JSONL entry starting at a line boundary at
 * the baseline offset, within a fixed bound. A deferred, missing, altered,
 * accompanied, or line-merged append is unconfirmed: a reload would not see
 * it. This is an on-disk read-back, not an fsync or power-loss guarantee.
 */
export function confirmAutoRequestRecorded(
	ctx: Pick<ExtensionContext, "sessionManager">,
	baseline: AutoSessionObservation,
	record: AutoRequestRecord,
): AutoRecordConfirmation {
	const fail = (detail: string) => recordFailed(true, detail);
	const observed = observeAutoRoutingSession(ctx);
	if (!observed.ok || !sameSessionFile(observed.session, baseline))
		return fail("The session changed while recording.");
	let leaf: ReturnType<ExtensionContext["sessionManager"]["getLeafEntry"]>;
	try {
		leaf = ctx.sessionManager.getLeafEntry();
	} catch {
		return fail("The session branch could not be observed.");
	}
	if (
		leaf === undefined ||
		leaf.type !== "custom_message" ||
		leaf.id !== observed.session.branchAnchor ||
		leaf.parentId !== baseline.branchAnchor ||
		leaf.customType !== record.customType ||
		leaf.content !== record.content ||
		leaf.display !== record.display ||
		canonicalJson(leaf.details ?? null) !== canonicalJson(record.details)
	)
		return fail("The request is not the next entry on the active branch.");

	let appended: string;
	let bytes: number;
	const opened = openRegularFile(baseline.sessionFile);
	if (opened === undefined)
		return fail("The session file was replaced while recording.");
	const { fd, stat } = opened;
	try {
		if (stat.dev !== baseline.device || stat.ino !== baseline.inode)
			return fail("The session file was replaced while recording.");
		bytes = stat.size - baseline.size;
		if (bytes <= 0) return fail("The request is not on disk.");
		if (bytes > AUTO_REQUEST_RECORD_MAX_BYTES)
			return fail("The session grew beyond the recording bound.");
		if (!atLineStart(fd, baseline.size))
			return fail("The request does not start a session line.");
		appended = readRange(fd, baseline.size, bytes).toString("utf8");
	} catch {
		return fail("The session file could not be read back.");
	} finally {
		closeSync(fd);
	}
	if (
		!appended.endsWith("\n") ||
		appended.indexOf("\n") !== appended.length - 1
	)
		return fail("The session grew by other than exactly one entry.");
	let entry: any;
	try {
		entry = JSON.parse(appended);
	} catch {
		return fail("The appended entry is unreadable.");
	}
	if (
		!isRecord(entry) ||
		entry.type !== "custom_message" ||
		entry.id !== leaf.id ||
		entry.parentId !== baseline.branchAnchor ||
		entry.customType !== record.customType ||
		entry.content !== record.content ||
		entry.display !== record.display ||
		canonicalJson(entry.details ?? null) !== canonicalJson(record.details)
	)
		return fail("The appended entry does not match the request.");
	return Object.freeze({
		ok: true,
		entryId: leaf.id,
		offset: baseline.size,
		bytes,
	});
}

/**
 * Record a request with public non-triggering `pi.sendMessage` and confirm
 * it immediately. The parent must still be idle with nothing queued, and the
 * session must still be the admitted one on the same branch anchor, at the
 * admitted size and ending at a line boundary, or nothing is sent: a
 * disk-only append or truncation is drift, never silently rebased. The host
 * appends idle non-triggering messages synchronously; any other outcome is
 * unconfirmed, never retried or awaited.
 * The caller must already own the decision: a failure after sending may
 * still have left a partial effect.
 */
export function recordAutoRequest(
	pi: Pick<ExtensionAPI, "sendMessage">,
	ctx: Pick<
		ExtensionContext,
		"sessionManager" | "isIdle" | "hasPendingMessages"
	>,
	admitted: AutoSessionObservation,
	decisionId: string,
	record: AutoRequestRecord,
): AutoRecordConfirmation {
	if (record.details.decisionId !== decisionId)
		return recordFailed(false, "The record does not carry this decision.");
	if (
		Buffer.byteLength(JSON.stringify(record), "utf8") >
		AUTO_REQUEST_RECORD_MAX_BYTES - AUTO_ENTRY_ENVELOPE_BYTES
	)
		return recordFailed(false, "The record exceeds the recording bound.");
	try {
		if (!ctx.isIdle() || ctx.hasPendingMessages())
			return recordFailed(false, "The parent is no longer idle.");
	} catch {
		return recordFailed(false, "The idle state is unavailable.");
	}
	const observed = observeAutoRoutingSession(ctx);
	if (
		!observed.ok ||
		!sameSessionFile(observed.session, admitted) ||
		observed.session.branchAnchor !== admitted.branchAnchor ||
		observed.session.size !== admitted.size
	)
		return recordFailed(
			false,
			"The session or branch changed before recording.",
		);
	const baseline = observed.session;
	try {
		pi.sendMessage(
			{
				customType: record.customType,
				content: record.content,
				display: record.display,
				details: record.details,
			},
			{ triggerTurn: false },
		);
	} catch {
		return recordFailed(true, "Sending the request failed.");
	}
	return confirmAutoRequestRecorded(ctx, baseline, record);
}

/** Custom message holding one owned, handler-visible request. */
export const AUTO_REQUEST_CUSTOM_TYPE = "jev_auto_request";
/** Custom message reporting one owned decision's launch, hold, or fallback. */
export const AUTO_STATUS_CUSTOM_TYPE = "jev_auto_status";
/** Non-context receipt entry: bounded IDs, hashes, and reason codes only. */
export const AUTO_RECEIPT_ENTRY_TYPE = "jev_auto_route_v1";
/** Pilot confirmation bound; no answer within it declines. */
export const AUTO_PILOT_CONFIRM_TIMEOUT_MS = 30_000;

/** What a decision reached; never a claim about host submission identity. */
export type AutoDecisionPhase =
	| "classifying"
	| "recording"
	| "confirming"
	| "revalidating"
	| "launching"
	/** A child started; the existing lifecycle settles it. */
	| "dispatched"
	/** Dispatch may have happened; unknown is never treated as no work. */
	| "uncertain"
	| "continued"
	| "held"
	| "fallback-attempted"
	| "observed";

/** State of an owned request record, carried in its details. */
export type AutoRequestState = "accepted" | "held";

/** Outcome of the injected launch handoff for one approved tuple. */
export type AutoLaunchOutcome =
	| Readonly<{ status: "started"; childId: string; name: string }>
	/** Rejected before any Herdr resource or dispatch: positively no work. */
	| Readonly<{ status: "rejected"; detail: string }>
	/** A resource or dispatch may exist; never parent fallback. */
	| Readonly<{ status: "uncertain"; detail: string }>;

export type AutoLaunchHandoff<
	P extends AutoPreparedRun,
	X extends AutoInputContext,
> = Readonly<{
	decisionId: string;
	/** The candidate from the snapshot just revalidated, pending one launch. */
	candidate: AutoCandidate<P>;
	route: AutoSelectedRoute;
	ctx: X;
	/** Package-owned; aborted only by an observed package cancellation. */
	signal: AbortSignal;
	/** The one launch of this decision: guards, dispatch latch, lifecycle. */
	binding: AutoRunBinding;
}>;

/**
 * Decision-only provenance an automatic child's started, result, error, and
 * help details carry. It correlates one local attempt with its approved
 * tuple; it is never a host submission identity or exactly-once evidence.
 */
export type AutoRunReceipt = Readonly<{
	decisionId: string;
	policyVersion: typeof AUTO_ROUTING_POLICY_VERSION;
	questionVersion: typeof AUTO_ROUTING_QUESTION_VERSION;
	jevModel: AutoRoutingJevModel;
	candidateId: string;
	configHash: string;
	candidateSetHash: string;
	selectionSource: "auto";
}>;

/**
 * How far one automatic launch got, in order; it only advances. From
 * `dispatch-attempted` on, a process may exist whatever the launch reports.
 */
export const AUTO_DISPATCH_STATES = Object.freeze([
	"uncommitted",
	"resources-created",
	"dispatch-attempted",
	"started",
] as const);
export type AutoDispatchState = (typeof AUTO_DISPATCH_STATES)[number];

/** A launch guard stopped an automatic launch before its dispatch. */
export class AutoLaunchStoppedError extends Error {
	readonly reason: AutoReasonCode;
	constructor(reason: AutoReasonCode, message: string) {
		super(message);
		this.name = "AutoLaunchStoppedError";
		this.reason = reason;
	}
}

/**
 * The one launch of an owned decision, created by the coordinator and
 * handed to the launch path. Its guards call back into the coordinator's
 * own state: cancellation, session, cwd, branch, generation, idle, the
 * persisted request, the initialized config, and the whole revalidated
 * candidate snapshot. It authorizes only the one pending prepared handle
 * it was created for (see autoRunBindingAuthorizes). Never a tool parameter.
 */
export interface AutoRunBinding {
	readonly receipt: AutoRunReceipt;
	/** The configured approval the receipt's opaque candidate maps to. */
	readonly approvalId: string;
	readonly signal: AbortSignal;
	dispatchState(): AutoDispatchState;
	/** Why a guard stopped the launch, when one did. */
	stopReason(): AutoReasonCode | undefined;
	/** Throws AutoLaunchStoppedError; runs before any Herdr resource. */
	beforeResources(): void;
	/** A Herdr surface now exists; never throws. */
	resourcesCreated(): void;
	/**
	 * Recheck, then irreversibly latch `dispatch-attempted` immediately
	 * before the one `runScript`. A second call always throws: one decision
	 * never dispatches twice.
	 */
	commitDispatch(): void;
	/** Once, with the actual child ID, before its watcher can settle it. */
	recordStarted(childId: string): void;
	/** Once, on the existing watcher's delivery or suppression path. */
	recordSettled(): void;
	settled(): boolean;
}

/**
 * Each coordinator-created binding and the one pending prepared handle of
 * the freshly revalidated candidate it was created for. Only the
 * coordinator registers a binding; a structural copy or a hand-built object
 * is never registered, so no caller can mint or forge one.
 */
const boundPreparedRuns = new WeakMap<AutoRunBinding, AutoPreparedRun>();

/**
 * Whether `binding` is a coordinator binding created for exactly this
 * pending prepared handle: identity, not structure, of both.
 */
export function autoRunBindingAuthorizes(
	binding: AutoRunBinding,
	prepared: Pick<AutoPreparedRun, "params">,
): boolean {
	const bound = boundPreparedRuns.get(binding);
	return bound !== undefined && bound === prepared;
}

/** Work this package dispatched, retained across coordinator reloads. */
export type AutoRetainedWork = Readonly<{
	decisionId: string;
	state: "dispatched" | "uncertain";
	childId?: string;
	/**
	 * The child's existing lifecycle reports its settlement through its run
	 * binding: it stays busy until then, across reloads.
	 */
	bound?: boolean;
}>;

export type AutoRetainedStore = Readonly<{
	get(): AutoRetainedWork | undefined;
	set(work: AutoRetainedWork | undefined): void;
	/**
	 * Decisions this process saw reach a no-work outcome or a settled child.
	 * Startup recovery after a reload defers to them instead of treating
	 * their durable evidence as unknown work.
	 */
	resolved?: Readonly<{
		has(decisionId: string): boolean;
		add(decisionId: string): void;
	}>;
}>;

/**
 * Lifecycle events the coordinator observes; no host metadata beyond them.
 * The `session_before_*` events invalidate at the start of a transition, so
 * a delayed, failed, or cancelled compaction or navigation still stops an
 * undispatched decision instead of letting it cross the transition.
 */
export type AutoLifecycleEvent =
	| "session_start"
	| "session_shutdown"
	| "session_before_tree"
	| "session_tree"
	| "session_before_compact"
	| "session_compact"
	| "agent_start";

/** Durable evidence of work an earlier process may have left running. */
export type AutoUnknownWork = Readonly<{
	decisionId: string;
	/** An accepted request with no no-work outcome, or dispatch evidence. */
	evidence: "accepted" | "dispatched" | "uncertain";
}>;

/** How many unknown decisions recovery keeps for display. */
export const AUTO_RECOVERY_MAX_REPORTED = 8;

export type AutoRecoveryResult =
	| Readonly<{ status: "clear" }>
	| Readonly<{
			status: "unknown";
			work: readonly AutoUnknownWork[];
			/** Every unknown decision found, including those not kept. */
			total: number;
	  }>
	| Readonly<{ status: "unavailable"; detail: string }>;

const DECISION_ID =
	/^ad-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Receipt phases that prove this decision dispatched nothing. */
const NO_WORK_PHASES = new Set([
	"held",
	"continued",
	"observed",
	"fallback-attempted",
]);

/**
 * Reconstruct conservative unknown occupancy from the active branch through
 * the public read-only `sessionManager.getBranch`. An accepted request with
 * no durable no-work outcome, or any dispatched or uncertain receipt, is
 * unknown work: it is never adopted, replayed, retried, or presumed finished.
 * Held, continued, observed, and fallback-attempted evidence creates none.
 * `known` names decisions this process already accounts for in memory. An
 * absent or failing branch read is unavailable, which blocks as well.
 */
export function recoverAutoRoutingWork(
	ctx: Pick<ExtensionContext, "sessionManager">,
	known: (decisionId: string) => boolean = () => false,
): AutoRecoveryResult {
	const unavailable = (detail: string): AutoRecoveryResult =>
		Object.freeze({ status: "unavailable", detail });
	const manager = readMember(ctx, "sessionManager");
	const getBranch = readMember(manager, "getBranch");
	if (!isCallable(getBranch))
		return unavailable(
			"The session branch cannot be read (sessionManager.getBranch).",
		);
	const decisions = new Map<
		string,
		{ accepted: boolean; noWork: boolean; work?: "dispatched" | "uncertain" }
	>();
	try {
		const branch = getBranch.call(manager);
		if (!Array.isArray(branch))
			return unavailable("The session branch is unreadable.");
		for (const entry of branch) {
			const type = readMember(entry, "type");
			const customType = readMember(entry, "customType");
			const request =
				type === "custom_message" && customType === AUTO_REQUEST_CUSTOM_TYPE;
			const receipt =
				type === "custom" && customType === AUTO_RECEIPT_ENTRY_TYPE;
			if (!request && !receipt) continue;
			const data = readMember(entry, request ? "details" : "data");
			const decisionId = readMember(data, "decisionId");
			if (!isString(decisionId) || !DECISION_ID.test(decisionId)) continue;
			const state = decisions.get(decisionId) ?? {
				accepted: false,
				noWork: false,
			};
			decisions.set(decisionId, state);
			if (request) {
				const recorded = readMember(data, "state");
				if (recorded === "accepted") state.accepted = true;
				else if (recorded === "held") state.noWork = true;
				continue;
			}
			const phase = readMember(data, "phase");
			if (phase === "uncertain") state.work = "uncertain";
			else if (phase === "dispatched") state.work ??= "dispatched";
			else if (isString(phase) && NO_WORK_PHASES.has(phase))
				state.noWork = true;
		}
	} catch {
		return unavailable("The session branch could not be read.");
	}
	const work: AutoUnknownWork[] = [];
	let total = 0;
	for (const [decisionId, state] of decisions) {
		// Dispatch evidence outranks any later no-work receipt.
		const evidence =
			state.work ?? (state.accepted && !state.noWork ? "accepted" : undefined);
		if (evidence === undefined || known(decisionId)) continue;
		total++;
		if (work.length < AUTO_RECOVERY_MAX_REPORTED)
			work.push(Object.freeze({ decisionId, evidence }));
	}
	return total === 0
		? Object.freeze({ status: "clear" })
		: Object.freeze({ status: "unknown", work: Object.freeze(work), total });
}

export type AutoRoutingCoordinatorOptions<
	P extends AutoPreparedRun,
	C extends AutoRoleCatalog,
	X extends AutoInputContext,
> = Readonly<{
	pi: AutoInputHost & Partial<Pick<ExtensionAPI, "appendEntry">>;
	/** Normally `process.env`; only child identity names are read. */
	env?: NodeJS.ProcessEnv;
	loadConfig(): LoadedAutoRoutingConfig;
	herdrAvailable(): boolean;
	/** Any known managed child or unresolved native launch. */
	managedWorkOutstanding(): boolean;
	isChildRunning(childId: string): boolean;
	authority(ctx: X): AutoRoutingAuthority<P, C>;
	transport(ctx: X): JevTransport;
	/** The launch authority; T08 adds its resource and dispatch guards. */
	launch(handoff: AutoLaunchHandoff<P, X>): Promise<AutoLaunchOutcome>;
	/** Monotonic milliseconds for receipt timings and the pilot bound. */
	now?: () => number;
	/** One-shot timer; returns its canceller. */
	setTimer?: (callback: () => void, ms: number) => () => void;
	retained?: AutoRetainedStore;
	canonicalCwd?: (cwd: string) => string;
}>;

/** The last settled decision: IDs, phase, and reason code only. */
export type AutoLastDecision = {
	decisionId: string;
	mode: EnabledAutoRoutingMode;
	phase: AutoDecisionPhase;
	reason?: AutoReasonCode;
};

export type AutoRetainedStatus = {
	decisionId: string;
	state: "dispatched" | "uncertain";
	childId?: string;
	running: boolean;
};

/** Local diagnostics; frozen when returned. */
export type AutoRoutingStatus = {
	/** The configuration initialized at extension load; never re-activated. */
	config: "off" | "invalid" | EnabledAutoRoutingMode;
	/** The durable file no longer matches it; `/reload` applies a change. */
	configChanged: boolean;
	/**
	 * Recovery of work an earlier process may have left, scanned on the
	 * active branch since the last observed session or branch transition.
	 */
	recovery?: AutoRecoveryResult;
	sessionGeneration: number;
	pending?: Readonly<{
		decisionId: string;
		mode: EnabledAutoRoutingMode;
		phase: AutoDecisionPhase;
		owned: boolean;
		elapsedMs: number;
	}>;
	retained?: Readonly<AutoRetainedStatus>;
	/** Store occupancy is unknown: admission fails closed until readable. */
	retainedUnavailable?: true;
	last?: Readonly<AutoLastDecision>;
	limitations: readonly string[];
};

export type AutoCancelReport = Readonly<{
	cancelled: boolean;
	decisionId?: string;
	message: string;
}>;

export interface AutoRoutingCoordinator<X extends AutoInputContext> {
	onInput(event: InputEvent, ctx: X): Promise<InputEventResult>;
	onLifecycle(event: AutoLifecycleEvent): void;
	/**
	 * Reconstruct unknown occupancy from the active branch before admission.
	 * The result is kept until the next observed session or branch
	 * transition, after which the next call rescans the active branch.
	 */
	recover(ctx: Pick<ExtensionContext, "sessionManager">): AutoRecoveryResult;
	/** The configuration snapshot initialized when this coordinator loaded. */
	configuration(): LoadedAutoRoutingConfig;
	/** Local cancel: pending preflight or pilot confirmation only. */
	cancel(): AutoCancelReport;
	snapshotStatus(): AutoRoutingStatus;
	/** Resolves when background shadow evaluations have finished. */
	settled(): Promise<void>;
}

/** Truthful limits every status report repeats. */
export const AUTO_ROUTING_LIMITATIONS = Object.freeze([
	"TUI Escape is not a cancellation guarantee for idle classification; the classifier deadline and observed package cancel or lifecycle events bound it.",
	"/subagents-routing cancel stops only a pending preflight or pilot confirmation, and only when the command can run; it never terminates a running child (use subagent_interrupt).",
	"Decision IDs correlate one local attempt; they are not host submission identities or duplicate protection across processes.",
	"Automatic children share the current checkout with parent and manual work; this is not a machine-wide lock.",
]);

const CONTINUE: InputEventResult = Object.freeze({ action: "continue" });
const HANDLED: InputEventResult = Object.freeze({ action: "handled" });
const REASON_CODES = new Set<string>(AUTO_REASON_CODES);

type Decision<P extends AutoPreparedRun, X extends AutoInputContext> = {
	readonly correlation: AutoDecisionCorrelation;
	readonly mode: EnabledAutoRoutingMode;
	readonly config: EnabledAutoRoutingState;
	readonly request: string;
	readonly admitted: AutoSessionObservation;
	readonly cwd: string;
	readonly ctx: X;
	readonly controller: AbortController;
	readonly startedAt: number;
	phase: AutoDecisionPhase;
	/** Irreversible: once set, the input is always handled. */
	owned: boolean;
	/** Irreversible: no further dispatch, fallback, or settlement. */
	terminal: boolean;
	cancelReason?: AutoCancelReason;
	snapshot?: AutoRoutingSnapshot<P>;
	route?: AutoSelectedRoute;
	/** Set once a request record is confirmed on the branch and on disk. */
	record?: AutoRequestRecord;
	/** A record send was attempted: it is never attempted again. */
	recordAttempted: boolean;
	/** Where this decision's own known appends left the session. */
	expected: { branchAnchor: string | null; size: number };
	batches: number;
	/** The one classifier deadline for Batch A, Batch B, and launch. */
	deadline?: JevDeadline;
	/**
	 * The budget left when an approved pilot dialog closed, and when: the
	 * explicit dialog allowance pauses the budget rather than spending it.
	 */
	pilotResume?: Readonly<{ remainingMs: number; approvedAt: number }>;
	childId?: string;
	reason?: AutoReasonCode;
	/** The one launch, once the decision reaches it. */
	run?: AutoRunBinding;
};

/** What a launch binding rechecks at each boundary. */
type RunBindingInput<
	P extends AutoPreparedRun,
	C extends AutoRoleCatalog,
> = Readonly<{
	authority: AutoRoutingAuthority<P, C>;
	snapshot: AutoRoutingSnapshot<P>;
	candidateId: string;
	approvalId: string;
	/** The pending handle of the freshly revalidated candidate. */
	prepared: P;
	record: AutoRequestRecord;
	entryId: string;
}>;

type Evaluation<P extends AutoPreparedRun> =
	| Readonly<{
			kind: "selected";
			candidate: AutoCandidate<P>;
			route: AutoSelectedRoute;
	  }>
	| Readonly<{
			kind: "abstain" | "unavailable";
			reason: AutoReasonCode;
	  }>
	| Readonly<{ kind: "stopped"; reason: AutoCancelReason }>;

const noop = () => undefined;

function defaultTimer(callback: () => void, ms: number): () => void {
	const timer = setTimeout(callback, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}

function defaultCanonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

function memoryStore(): AutoRetainedStore {
	let work: AutoRetainedWork | undefined;
	const resolved = new Set<string>();
	return Object.freeze({
		get: () => work,
		set: (next: AutoRetainedWork | undefined) => {
			work = next;
		},
		resolved: Object.freeze({
			has: (decisionId: string) => resolved.has(decisionId),
			add: (decisionId: string) => {
				resolved.add(decisionId);
			},
		}),
	});
}

/**
 * Callback-free mutation fence for a normal public context object. Data
 * properties are compared by value/identity; current Pi's read-only getters
 * are compared by descriptor identity (their backing state is observed by
 * the bounded public snapshot below). Proxies are not a supported fence.
 * This neither invokes getters nor patches/reads private host state.
 */
function contextFence(ctx: AutoInputContext): () => boolean {
	if (utilTypes.isProxy(ctx)) throw new Error("Unfenceable public context");
	const fields = [
		"cwd",
		"sessionManager",
		"mode",
		"isIdle",
		"hasPendingMessages",
		"modelRegistry",
	];
	const descriptors = fields.map((field) => {
		const descriptor = Object.getOwnPropertyDescriptor(ctx, field);
		if (!descriptor) throw new Error("Unfenceable public context field");
		return descriptor;
	});
	return () =>
		fields.every((field, index) => {
			const before = descriptors[index];
			const after = Object.getOwnPropertyDescriptor(ctx, field);
			return (
				after !== undefined &&
				before.value === after.value &&
				before.get === after.get &&
				before.set === after.set &&
				before.writable === after.writable &&
				before.enumerable === after.enumerable &&
				before.configurable === after.configurable
			);
		});
}

/**
 * Kernel file identity/mutation version, without calling an injected loader
 * or host method. Nanosecond ctime also catches same-size in-place rewrites.
 * Missing virtual config sources are supported by injected test loaders;
 * production's enabled loader necessarily read an existing durable file.
 */
function fileMutationVersion(path: string): string {
	try {
		const stat = statSync(path, { bigint: true });
		if (!stat.isFile()) throw new Error("Not a regular boundary file");
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return "missing";
		throw error;
	}
}

/**
 * Whether an event is at the exact observable ingress boundary: a TUI
 * interactive submission with no streaming behavior. Only such an event may
 * supersede a pending decision; text, image, and command eligibility are not
 * required. Every read is guarded, and any failed read is not the boundary.
 */
function isIngressBoundaryEvent(
	event: InputEvent,
	ctx: AutoInputContext,
): boolean {
	if (readMember(ctx, "mode") !== "tui") return false;
	const source = captureField(event, "source");
	const streaming = captureField(event, "streamingBehavior");
	return (
		source.ok &&
		source.value === "interactive" &&
		streaming.ok &&
		streaming.value === undefined
	);
}

/** One loaded configuration's identity, for drift detection only. */
function configIdentity(loaded: LoadedAutoRoutingConfig): string {
	return loaded.status === "invalid"
		? `invalid:${loaded.diagnostic}`
		: `${loaded.status}:${loaded.digest}`;
}

function beginMarker(decisionId: string): string {
	return `----- BEGIN REQUEST ${decisionId} -----`;
}

function endMarker(decisionId: string): string {
	return `----- END REQUEST ${decisionId} -----`;
}

const ACCEPTED_HEADER = [
	"Automatic delegation: user request (handler-visible text).",
	"The request between the markers is the text this extension saw after any earlier input handlers, preserved exactly. It is awaiting delegated execution by one automatically selected subagent; no work has started from this message.",
	"Do not perform it concurrently. A subagent result or a fallback notice follows.",
].join("\n");

function heldHeader(reason: AutoReasonCode): string {
	return [
		`Automatic delegation held this user request (handler-visible text; reason: ${reason}).`,
		"No subagent was launched for it and no parent turn was started. Do not act on it unless the user asks again.",
	].join("\n");
}

/**
 * The content of an owned request record: a fixed header, then the exact
 * captured text between markers named by the random decision ID, so the
 * request cannot forge its own boundary without guessing that ID.
 */
export function formatAutoRequestContent(
	decisionId: string,
	request: string,
	state: AutoRequestState,
	reason?: AutoReasonCode,
): string {
	const header =
		state === "accepted"
			? ACCEPTED_HEADER
			: heldHeader(reason ?? "internal-error");
	return `${header}\n\n${beginMarker(decisionId)}\n${request}\n${endMarker(decisionId)}`;
}

/** The exact request inside a record's markers, or undefined. */
export function extractAutoRequestText(
	content: string,
	decisionId: string,
): string | undefined {
	const begin = `\n${beginMarker(decisionId)}\n`;
	const end = `\n${endMarker(decisionId)}`;
	const start = content.indexOf(begin);
	if (start < 0 || !content.endsWith(end)) return undefined;
	const from = start + begin.length;
	const to = content.length - end.length;
	return from <= to ? content.slice(from, to) : undefined;
}

function autoRequestRecord(
	decisionId: string,
	request: string,
	state: AutoRequestState,
	reason?: AutoReasonCode,
): AutoRequestRecord {
	const details: JsonObject = {
		version: 1,
		decisionId,
		source: "interactive",
		state,
	};
	if (state === "held" && reason) details.reason = reason;
	return Object.freeze({
		customType: AUTO_REQUEST_CUSTOM_TYPE,
		content: formatAutoRequestContent(decisionId, request, state, reason),
		display: true,
		details: Object.freeze(details),
	});
}

function describeRole(candidate: AutoCandidate<AutoPreparedRun>): string {
	const role = candidate.role;
	return role.provider
		? `${role.name} (package:${role.provider}@${role.providerVersion ?? "?"})`
		: `${role.name} (${role.source})`;
}

function exactModelLabel(route: AutoSelectedRoute): string {
	return route.exactModel.namespace === "pi"
		? route.exactModel.ref
		: route.exactModel.id;
}

/**
 * Create the package input coordinator. It holds at most one in-flight
 * decision, reserved synchronously before its first await, and returns
 * `continue` only before ownership under the parent failure policy. Once a
 * decision is owned it always returns `handled` and never throws.
 */
export function createAutoRoutingCoordinator<
	P extends AutoPreparedRun,
	C extends AutoRoleCatalog,
	X extends AutoInputContext = ExtensionContext,
>(options: AutoRoutingCoordinatorOptions<P, C, X>): AutoRoutingCoordinator<X> {
	const { pi } = options;
	const env = options.env ?? process.env;
	const now = options.now ?? (() => performance.now());
	const setTimer = options.setTimer ?? defaultTimer;
	const retained = options.retained ?? memoryStore();
	const canonicalCwd = options.canonicalCwd ?? defaultCanonicalCwd;
	let generation = 0;
	let current: Decision<P, X> | undefined;
	let last: Readonly<AutoLastDecision> | undefined;
	let recovery: AutoRecoveryResult | undefined;

	const readConfig = (): LoadedAutoRoutingConfig => {
		try {
			return options.loadConfig();
		} catch {
			return Object.freeze({
				status: "invalid",
				source: "",
				diagnostic: "The routing configuration could not be read.",
			});
		}
	};
	// Initialized once per extension load: a later change (off to auto,
	// shadow to auto, approvals, or enablement) never activates without a
	// reload. Later reads only detect drift or revocation.
	const initialized = readConfig();

	/** The durable config still is the initialized enabled snapshot. */
	const configCurrent = (config: EnabledAutoRoutingState): boolean => {
		const loaded = readConfig();
		return loaded.status === "enabled" && loaded.digest === config.digest;
	};

	const setLast = (
		decision: Decision<P, X>,
		phase: AutoDecisionPhase,
		reason?: AutoReasonCode,
	) => {
		const entry: AutoLastDecision = {
			decisionId: decision.correlation.decisionId,
			mode: decision.mode,
			phase,
		};
		if (reason) entry.reason = reason;
		last = Object.freeze(entry);
	};
	const background = new Set<Promise<void>>();

	// The retained store is an external seam: every call is contained. This
	// coordinator's own mirror is written first and fails closed, so a store
	// failure never frees the slot or reads as no work in this process; a
	// reload without the store still recovers from durable session evidence.
	let localWork: AutoRetainedWork | undefined;
	const localResolved = new Set<string>();
	/** The store's work; `ok: false` when it could not be read. */
	const storedWork = ():
		| Readonly<{ ok: true; work: AutoRetainedWork | undefined }>
		| Readonly<{ ok: false }> => {
		try {
			return { ok: true, work: retained.get() };
		} catch {
			return { ok: false };
		}
	};
	const storeWork = (work: AutoRetainedWork | undefined) => {
		try {
			retained.set(work);
		} catch {
			// The local mirror still holds the slot.
		}
	};
	const markResolved = (decisionId: string) => {
		localResolved.add(decisionId);
		try {
			retained.resolved?.add(decisionId);
		} catch {
			// Known locally; a reload rescans durable evidence conservatively.
		}
	};
	/** Retain possibly executing work: locally first, then in the store. */
	const retainWork = (work: AutoRetainedWork) => {
		localWork = work;
		storeWork(work);
	};
	/** Retained work for display: the local mirror, else a readable store. */
	const visibleWork = (): AutoRetainedWork | undefined => {
		if (localWork) return localWork;
		const stored = storedWork();
		return stored.ok ? stored.work : undefined;
	};
	/** Uncertain work and bound or running children stay busy. */
	const workBusy = (work: AutoRetainedWork): boolean =>
		work.state === "uncertain" ||
		work.bound === true ||
		(work.childId !== undefined && options.isChildRunning(work.childId));

	const retainedBusy = (): boolean => {
		if (localWork) {
			if (workBusy(localWork)) return true;
			// The existing lifecycle settled this unbound child here.
			markResolved(localWork.decisionId);
			localWork = undefined;
		}
		const stored = storedWork();
		// An unreadable store fails closed.
		if (!stored.ok) return true;
		const work = stored.work;
		if (!work) return false;
		if (workBusy(work)) return true;
		// The existing lifecycle settled this child in this process.
		markResolved(work.decisionId);
		storeWork(undefined);
		return false;
	};

	const knownToProcess = (decisionId: string): boolean => {
		if (localWork?.decisionId === decisionId || localResolved.has(decisionId))
			return true;
		const stored = storedWork();
		if (stored.ok && stored.work?.decisionId === decisionId) return true;
		try {
			return retained.resolved?.has(decisionId) === true;
		} catch {
			// Unknown to this process: recovery treats it conservatively.
			return false;
		}
	};

	const recover = (
		ctx: Pick<ExtensionContext, "sessionManager">,
	): AutoRecoveryResult => {
		if (recovery === undefined) {
			try {
				recovery = recoverAutoRoutingWork(ctx, knownToProcess);
			} catch {
				recovery = Object.freeze({
					status: "unavailable",
					detail: "The session branch could not be read.",
				});
			}
		}
		return recovery;
	};

	/** Unknown or unrecoverable durable work blocks every new decision. */
	const recoveryBlocks = (): boolean =>
		recovery !== undefined && recovery.status !== "clear";

	const busy = (): boolean => {
		if (current !== undefined || retainedBusy() || recoveryBlocks())
			return true;
		try {
			return options.managedWorkOutstanding();
		} catch {
			return true;
		}
	};

	const sameGeneration = (decision: Decision<P, X>) =>
		decision.correlation.sessionGeneration === generation;

	/** The session is still the admitted one, where this decision left it. */
	const sessionUnchanged = (
		decision: Decision<P, X>,
		requireAnchor: boolean,
	): boolean => {
		if (!sameGeneration(decision)) return false;
		const observed = observeAutoRoutingSession(decision.ctx);
		if (!observed.ok || !sameSessionFile(observed.session, decision.admitted))
			return false;
		if (!requireAnchor) return true;
		let cwd: string;
		try {
			cwd = canonicalCwd(decision.ctx.cwd);
		} catch {
			return false;
		}
		return (
			cwd === decision.cwd &&
			observed.session.branchAnchor === decision.expected.branchAnchor &&
			observed.session.size === decision.expected.size
		);
	};

	/** Why an owning decision must stop now, if it must. */
	const stopReason = (
		decision: Decision<P, X>,
	): AutoCancelReason | undefined => {
		if (decision.cancelReason) return decision.cancelReason;
		if (!sessionUnchanged(decision, true)) return "session-changed";
		return undefined;
	};

	const notify = (
		decision: Decision<P, X>,
		text: string,
		level: "info" | "warning" = "warning",
	) => {
		if (!sameGeneration(decision)) return;
		try {
			decision.ctx.ui.notify(text, level);
		} catch {
			// Best effort: the decision outcome does not depend on the notice.
		}
	};

	const appendReceipt = (decision: Decision<P, X>) => {
		const append = pi.appendEntry;
		if (!isCallable(append) || !sessionUnchanged(decision, false)) return;
		const receipt: JsonObject = {
			version: 1,
			decisionId: decision.correlation.decisionId,
			mode: decision.mode,
			phase: decision.phase,
			owned: decision.owned,
			recorded: decision.record !== undefined,
			batches: decision.batches,
			elapsedMs: Math.max(0, Math.round(now() - decision.startedAt)),
			configHash: decision.config.digest,
			policyVersion: AUTO_ROUTING_POLICY_VERSION,
			questionVersion: AUTO_ROUTING_QUESTION_VERSION,
		};
		if (decision.reason) receipt.reason = decision.reason;
		if (decision.snapshot)
			receipt.snapshotHash = decision.snapshot.snapshotHash;
		if (decision.route) receipt.candidateId = decision.route.candidateId;
		if (decision.childId) receipt.childId = decision.childId;
		try {
			append.call(pi, AUTO_RECEIPT_ENTRY_TYPE, receipt);
		} catch {
			// A receipt is diagnostics only.
		}
	};

	/** Make the decision terminal in this process; persists nothing. */
	const settle = (
		decision: Decision<P, X>,
		phase: AutoDecisionPhase,
		reason?: AutoReasonCode,
	) => {
		decision.terminal = true;
		decision.phase = phase;
		if (reason) decision.reason = reason;
		if (current === decision) current = undefined;
		// Every phase settled here dispatched nothing.
		markResolved(decision.correlation.decisionId);
		setLast(decision, phase, reason);
	};

	const finish = (
		decision: Decision<P, X>,
		phase: AutoDecisionPhase,
		reason?: AutoReasonCode,
	) => {
		settle(decision, phase, reason);
		appendReceipt(decision);
	};

	/** The decision's one classifier budget, with any pilot allowance. */
	const budgetExpired = (decision: Decision<P, X>): boolean => {
		const deadline = decision.deadline;
		if (deadline === undefined) return true;
		const resume = decision.pilotResume;
		if (resume === undefined) return deadline.expired();
		return now() - resume.approvedAt >= resume.remainingMs;
	};

	/**
	 * Return an unowned decision to Pi only while it is still safe: nothing
	 * stopped it, the session and branch are where it was admitted, and the
	 * parent is still idle with nothing queued. Otherwise it holds.
	 */
	const continueUnowned = (
		decision: Decision<P, X>,
		reason: AutoReasonCode,
	): InputEventResult => {
		const stopped = stopReason(decision);
		if (stopped) return hold(decision, stopped);
		try {
			if (!decision.ctx.isIdle() || decision.ctx.hasPendingMessages())
				return hold(decision, "parent-busy");
		} catch {
			return hold(decision, "internal-error");
		}
		finish(decision, "continued", reason);
		return CONTINUE;
	};

	/** A non-triggering status message into the still-current session. */
	const sendStatus = (
		decision: Decision<P, X>,
		content: string,
		details: JsonObject,
		requireAnchor: boolean,
	): boolean => {
		if (!sessionUnchanged(decision, requireAnchor)) return false;
		try {
			pi.sendMessage(
				{
					customType: AUTO_STATUS_CUSTOM_TYPE,
					content,
					display: true,
					details: {
						version: 1,
						decisionId: decision.correlation.decisionId,
						...details,
					},
				},
				{ triggerTurn: false },
			);
			return true;
		} catch {
			return false;
		}
	};

	/**
	 * A dispatch was attempted but never confirmed started: terminal and
	 * retained as uncertain, never no work, a fallback, or a retry. The
	 * decision is terminal and retained locally before any store call.
	 */
	const retainUncertain = (decision: Decision<P, X>): InputEventResult => {
		const id = decision.correlation.decisionId;
		decision.owned = true;
		decision.terminal = true;
		decision.phase = "uncertain";
		decision.reason = "dispatch-uncertain";
		if (current === decision) current = undefined;
		setLast(decision, "uncertain", "dispatch-uncertain");
		retainWork(Object.freeze({ decisionId: id, state: "uncertain" }));
		appendReceipt(decision);
		if (
			!sendStatus(
				decision,
				`Automatic delegation for decision ${id} may have started work that could not be confirmed. Do not perform the recorded request in the parent; inspect the subagent panes before retrying anything.`,
				{ state: "uncertain", reason: "dispatch-uncertain" },
				false,
			)
		)
			notify(
				decision,
				`Automatic routing decision ${id} may have dispatched work; inspect it before retrying.`,
			);
		return HANDLED;
	};

	/**
	 * The child was recorded started, so its existing watcher supervises it:
	 * terminal and dispatched. recordStarted already retained it.
	 */
	const markDispatched = (decision: Decision<P, X>) => {
		decision.owned = true;
		decision.terminal = true;
		decision.phase = "dispatched";
		if (current === decision) current = undefined;
		setLast(decision, "dispatched");
		appendReceipt(decision);
	};

	/**
	 * Hold an owned (or stopped) decision: consume the input, launch nothing,
	 * and keep the captured request visible where the originating session is
	 * still safely addressable. Never throws, retries, or starts a turn. A
	 * decision whose dispatch was attempted is never held as no work.
	 */
	const hold = (
		decision: Decision<P, X>,
		reason: AutoReasonCode,
	): InputEventResult => {
		decision.owned = true;
		if (decision.terminal) return HANDLED;
		const id = decision.correlation.decisionId;
		const dispatch = decision.run?.dispatchState();
		if (dispatch === "dispatch-attempted") return retainUncertain(decision);
		if (dispatch === "started") {
			markDispatched(decision);
			notify(
				decision,
				`Automatic delegation started child ${decision.childId ?? "(unknown)"} for decision ${id}; its result is delivered automatically. Do not perform the request in the parent.`,
				"info",
			);
			return HANDLED;
		}
		let visible = false;
		try {
			if (decision.record) {
				visible = sendStatus(
					decision,
					`Automatic delegation held decision ${id} (reason: ${reason}). No subagent was launched for the recorded request and no parent turn was started. Do not act on it unless the user asks again.`,
					{ state: "held", reason },
					true,
				);
			} else if (!decision.recordAttempted && sameGeneration(decision)) {
				// Sends nothing unless the admitted session and branch are
				// unchanged and the parent is still idle.
				const record = autoRequestRecord(id, decision.request, "held", reason);
				const confirmed = recordAutoRequest(
					pi,
					decision.ctx,
					decision.admitted,
					id,
					record,
				);
				decision.recordAttempted = confirmed.ok || confirmed.sendAttempted;
				visible = confirmed.ok;
				if (confirmed.ok) decision.record = record;
			}
		} catch {
			visible = false;
		}
		if (!visible)
			notify(
				decision,
				`Automatic routing held a request (decision ${id}, reason: ${reason}); it was not launched or sent to the parent, and it could not be confirmed in this session. Resubmit it if needed.`,
			);
		finish(decision, "held", reason);
		return HANDLED;
	};

	/**
	 * The one explicit parent fallback: only after verified persistence,
	 * with positively known no dispatch, in the same session and branch, and
	 * never past the classifier budget. The decision is terminal before the
	 * turn is triggered, and the budget is checked after every check that can
	 * take time. Its receipt is written only after the trigger, so no write
	 * can outlast the budget first; a crash in between leaves the accepted
	 * request without an outcome, which recovery treats as unknown work.
	 */
	const fallbackOrHold = (
		decision: Decision<P, X>,
		reason: AutoReasonCode,
	): InputEventResult => {
		if (!decision.terminal && budgetExpired(decision))
			return hold(decision, "jev-timeout");
		let idle = false;
		try {
			idle = decision.ctx.isIdle() && !decision.ctx.hasPendingMessages();
		} catch {
			idle = false;
		}
		if (
			decision.terminal ||
			decision.config.config.failurePolicy !== "parent" ||
			!decision.record ||
			decision.cancelReason ||
			!idle ||
			!sessionUnchanged(decision, true)
		)
			return hold(decision, reason);
		if (budgetExpired(decision)) return hold(decision, "jev-timeout");
		const id = decision.correlation.decisionId;
		settle(decision, "fallback-attempted", reason);
		try {
			pi.sendMessage(
				{
					customType: AUTO_STATUS_CUSTOM_TYPE,
					content: `Automatic delegation fell back to the parent (decision ${id}, reason: ${reason}). No subagent was launched. Handle this request normally, or ask the user to clarify as needed:\n\n${beginMarker(id)}\n${decision.request}\n${endMarker(id)}`,
					display: true,
					details: {
						version: 1,
						decisionId: id,
						state: "fallback-parent",
						reason,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch {
			decision.phase = "held";
			setLast(decision, "held", reason);
			notify(
				decision,
				`Automatic routing could not hand decision ${id} back to the parent; the recorded request is held and was not resent.`,
			);
		}
		appendReceipt(decision);
		return HANDLED;
	};

	const classify = async (
		decision: Decision<P, X>,
		transport: JevTransport,
		deadline: JevDeadline,
		batch: JevBatch,
		authorize: () => boolean,
	): Promise<
		| Readonly<{ ok: true; evidence: JevBatchEvidence }>
		| Readonly<{ ok: false; evaluation: Evaluation<P> }>
	> => {
		decision.batches++;
		const result = await transport.classify({
			batch,
			deadline,
			signals: [decision.controller.signal],
			authorize,
		});
		if (result.status === "ok") return { ok: true, evidence: result.evidence };
		if (result.status === "cancelled")
			return {
				ok: false,
				evaluation: {
					kind: "stopped",
					reason: decision.cancelReason ?? "user-cancelled",
				},
			};
		return {
			ok: false,
			evaluation: { kind: "unavailable", reason: result.reason },
		};
	};

	/**
	 * Exact Batch A, the deterministic decision, and Batch B only when it is
	 * required, on one deadline kept on the decision. `check` runs after every
	 * await. The durable config must still be the initialized snapshot before
	 * each batch, after each batch, and inside the observing fetch right
	 * before forwarding, so a revocation or change while a batch or the
	 * host's authentication is pending sends nothing further.
	 */
	const evaluate = async (
		decision: Decision<P, X>,
		snapshot: AutoRoutingSnapshot<P>,
		transport: JevTransport,
		check: () => AutoCancelReason | undefined,
	): Promise<Evaluation<P>> => {
		const thresholds = decision.config.config.thresholds;
		const deadline = transport.createDeadline(
			decision.config.config.jev.timeoutMs,
		);
		decision.deadline = deadline;
		const drifted: Evaluation<P> = {
			kind: "unavailable",
			reason: "config-drift",
		};
		const authorize = () =>
			check() === undefined && configCurrent(decision.config);
		const builtA = buildBatchA(snapshot);
		if (!builtA.ok) return { kind: "unavailable", reason: builtA.reason };
		if (!configCurrent(decision.config)) return drifted;
		const a = await classify(
			decision,
			transport,
			deadline,
			builtA.batch,
			authorize,
		);
		const afterA = check();
		if (afterA) return { kind: "stopped", reason: afterA };
		if (!configCurrent(decision.config)) return drifted;
		if (!a.ok) return a.evaluation;
		const outcomeA = decideAfterBatchA(snapshot, a.evidence, thresholds);
		if (outcomeA.kind !== "continue") return outcomeA;
		const builtB = buildBatchB(outcomeA.plan);
		if (!builtB.ok) return { kind: "unavailable", reason: builtB.reason };
		if (!configCurrent(decision.config)) return drifted;
		const b = await classify(
			decision,
			transport,
			deadline,
			builtB.batch,
			authorize,
		);
		const afterB = check();
		if (afterB) return { kind: "stopped", reason: afterB };
		if (!configCurrent(decision.config)) return drifted;
		if (!b.ok) return b.evaluation;
		const outcomeB = decideAfterBatchB(outcomeA.plan, b.evidence, thresholds);
		if (outcomeB.kind !== "selected") return outcomeB;
		return {
			kind: "selected",
			candidate: outcomeB.candidate,
			route: outcomeB.route,
		};
	};

	/** Bounded TUI confirmation; only an explicit yes approves. */
	const confirmPilot = async (
		decision: Decision<P, X>,
		candidate: AutoCandidate<P>,
		route: AutoSelectedRoute,
	): Promise<"approved" | AutoCancelReason | "internal-error"> => {
		const dialog = new AbortController();
		const dismiss = () => dialog.abort();
		const signal = decision.controller.signal;
		signal.addEventListener("abort", dismiss, { once: true });
		let timedOut = false;
		let cancelTimer: () => void = noop;
		const shownAt = now();
		const message = [
			`Role: ${escapeTerminalText(describeRole(candidate))}`,
			`Harness: ${route.harness}`,
			`Model: ${escapeTerminalText(exactModelLabel(route))}`,
			`Effort: ${route.exactEffort}`,
			"It runs autonomously in the current checkout, which parent and manual work share.",
			"Escape during classification was not a cancellation guarantee.",
			`No answer within ${AUTO_PILOT_CONFIRM_TIMEOUT_MS / 1000} seconds declines; nothing runs without approval.`,
		].join("\n");
		try {
			const answered = (async () => {
				try {
					const approved = await decision.ctx.ui.confirm(
						"Delegate this request to an automatically selected subagent?",
						message,
						{ timeout: AUTO_PILOT_CONFIRM_TIMEOUT_MS, signal: dialog.signal },
					);
					return approved === true ? "yes" : "no";
				} catch {
					return "error";
				}
			})();
			const expired = new Promise<"timeout">((resolveTimeout) => {
				cancelTimer = setTimer(() => {
					timedOut = true;
					dialog.abort();
					resolveTimeout("timeout");
				}, AUTO_PILOT_CONFIRM_TIMEOUT_MS);
			});
			const cancelled = new Promise<"cancelled">((resolveCancel) => {
				if (signal.aborted) resolveCancel("cancelled");
				else
					signal.addEventListener("abort", () => resolveCancel("cancelled"), {
						once: true,
					});
			});
			const answer = await Promise.race([answered, expired, cancelled]);
			if (decision.cancelReason) return decision.cancelReason;
			// Any answer observed at or past the allowance declines, a yes
			// included, even when the timer callback itself runs late.
			if (
				answer === "timeout" ||
				timedOut ||
				now() - shownAt >= AUTO_PILOT_CONFIRM_TIMEOUT_MS
			)
				return "pilot-timeout";
			if (answer === "yes") return "approved";
			if (answer === "error") return "internal-error";
			return "pilot-declined";
		} finally {
			cancelTimer();
			signal.removeEventListener("abort", dismiss);
			dialog.abort();
		}
	};

	/**
	 * Why the owned decision's launch must stop now, if it must: every check
	 * the coordinator made before handing off, repeated synchronously at a
	 * launch boundary. It never depends on a host idle-input signal.
	 *
	 * There is no public host-wide version/transaction API. The guarantee is
	 * a bounded coherent snapshot under current Pi's observational public
	 * getters/methods and the package's read-only authority/loader contract,
	 * plus callback-free context-descriptor and durable-file mutation fences.
	 * Callback-bearing coherence checks finish before a separate terminal
	 * idle/pending observation; only callback-free fences/local state follow
	 * that observation. Current Pi's cwd/session accessors assert the runner
	 * is active and return backing values, and its idle/pending methods are
	 * observational. Descriptor fences do not read accessor backing state.
	 * Reentrant data-property replacement, durable writes, and observed
	 * lifecycle/cancel changes are fenced even on the last callback. This
	 * cannot prove arbitrary malicious host methods did not lie, mutate
	 * private accessor/loader/clock backing state after its last read, or
	 * change-and-restore hidden state; nor does it lock out another process.
	 */
	const launchStop = (
		decision: Decision<P, X>,
		bound: RunBindingInput<P, C>,
	): AutoReasonCode | undefined => {
		// Only package-owned state here: even the injected deadline clock is
		// a callback, so it must run BEFORE the final mutation fence.
		const localStop = (): AutoReasonCode | undefined => {
			if (decision.cancelReason) return decision.cancelReason;
			if (decision.controller.signal.aborted) return "user-cancelled";
			if (!sameGeneration(decision)) return "session-changed";
			return undefined;
		};
		const latched = (): AutoReasonCode | undefined => {
			const expired = budgetExpired(decision);
			return localStop() ?? (expired ? "jev-timeout" : undefined);
		};
		// Session, cwd, branch, and idle reads call into the host, which may
		// cancel the decision or switch the session from inside them.
		const observed = (): AutoReasonCode | undefined => {
			if (!sessionUnchanged(decision, true)) return "session-changed";
			if (!decision.ctx.isIdle() || decision.ctx.hasPendingMessages())
				return "parent-started";
			return undefined;
		};
		try {
			const contextStable = contextFence(decision.ctx);
			const sessionVersion = fileMutationVersion(decision.admitted.sessionFile);
			const configVersion = fileMutationVersion(decision.config.source);
			// Known role/skill source files are also snapshot authority. A
			// loader callback after the last revalidation must not rewrite them.
			const sourcePaths = new Set(
				bound.snapshot.roles.map((role) => role.role.path),
			);
			for (const candidate of bound.snapshot.candidates)
				for (const skill of candidate.prepared.nativePlan?.skills ?? [])
					sourcePaths.add(skill.filePath);
			const sourceVersions = [...sourcePaths].map(
				(path) => [path, fileMutationVersion(path)] as const,
			);
			const validate = (): AutoReasonCode | undefined => {
				const first = observed();
				if (first) return first;
				const reverified = confirmAutoRequestRecorded(
					decision.ctx,
					decision.admitted,
					bound.record,
				);
				if (!reverified.ok || reverified.entryId !== bound.entryId)
					return "request-record-failed";
				const configured = configCurrent(decision.config);
				const afterConfig = latched();
				if (afterConfig) return afterConfig;
				if (!configured) return "stale-snapshot";
				const revalidated = revalidateAutoRoutingSnapshot(
					bound.snapshot,
					{
						config: readConfig(),
						branchAnchor: bound.snapshot.branchAnchor,
						sessionGeneration: bound.snapshot.sessionGeneration,
					},
					bound.authority,
				);
				const afterRevalidation = latched();
				if (afterRevalidation) return afterRevalidation;
				if (
					!revalidated.ok ||
					!revalidated.snapshot.candidates.some(
						(entry) => entry.id === bound.candidateId,
					)
				)
					return "stale-snapshot";
				/**
				 * Two fixed callback-bearing coherence passes, not a retry loop.
				 * Pending precedes session/cwd/request/config here to close its
				 * observable mutations, including accessor-backed host state and
				 * injected virtual config/clock changes. These are NOT the final
				 * idle/pending observation: the last loader/authority/clock can
				 * still change busy state, so the terminal phase below must observe
				 * it after every such callback, without another coherence pass.
				 */
				const collect = (): AutoReasonCode | undefined => {
					if (decision.ctx.hasPendingMessages() || !decision.ctx.isIdle())
						return "parent-started";
					const fresh = revalidateAutoRoutingSnapshot(
						bound.snapshot,
						{
							config: readConfig(),
							branchAnchor: bound.snapshot.branchAnchor,
							sessionGeneration: bound.snapshot.sessionGeneration,
						},
						bound.authority,
					);
					if (
						!fresh.ok ||
						!fresh.snapshot.candidates.some(
							(entry) => entry.id === bound.candidateId,
						)
					)
						return "internal-error";
					if (!sessionUnchanged(decision, true)) return "session-changed";
					const recorded = confirmAutoRequestRecorded(
						decision.ctx,
						decision.admitted,
						bound.record,
					);
					if (!recorded.ok || recorded.entryId !== bound.entryId)
						return "request-record-failed";
					// Drift DURING boundary callbacks is incoherence, not a safe
					// pre-existing route rejection eligible for parent fallback.
					if (!configCurrent(decision.config)) return "internal-error";
					return undefined;
				};
				return collect() ?? collect();
			};
			const reason = latched() ?? validate();
			// Finish ALL loader/authority/deadline callbacks before observing
			// terminal idle/pending. Start the built-in monotonic timer BEFORE
			// sampling the injected allowance, conservatively charging its call
			// as well as the final observation and fences against that allowance.
			const afterCallbacks = latched();
			const allowanceStartedAt = performance.now();
			const remaining = decision.pilotResume
				? decision.pilotResume.remainingMs -
					(now() - decision.pilotResume.approvedAt)
				: (decision.deadline?.remainingMs() ?? 0);
			// A distinct terminal phase, not another full collect/retry. Pending
			// first lets an observable pending callback's idle change be seen.
			const busy = decision.ctx.hasPendingMessages() || !decision.ctx.isIdle();
			// From here to the monotonic latch: no await, host accessor/method,
			// authority, loader, or injected deadline/clock callback. Mutations
			// from the final observation still hit descriptors/durable versions
			// or package-owned lifecycle state; elapsed time uses only the built-in
			// clock, not a fresh injected clock that could invalidate busy above.
			const contextChanged = !contextStable();
			const sessionChanged =
				fileMutationVersion(decision.admitted.sessionFile) !== sessionVersion;
			const configChanged =
				fileMutationVersion(decision.config.source) !== configVersion;
			const sourcesChanged = sourceVersions.some(
				([path, version]) => fileMutationVersion(path) !== version,
			);
			// Pure final decision, immediately followed by the monotonic latch.
			return (
				localStop() ??
				afterCallbacks ??
				(!(remaining > performance.now() - allowanceStartedAt)
					? "jev-timeout"
					: undefined) ??
				(contextChanged ? "session-changed" : undefined) ??
				(sessionChanged ? "request-record-failed" : undefined) ??
				(configChanged || sourcesChanged ? "internal-error" : undefined) ??
				(busy ? "parent-started" : undefined) ??
				reason
			);
		} catch {
			return localStop() ?? "internal-error";
		}
	};

	/** The monotonic launch binding of one owned decision. */
	const createRunBinding = (
		decision: Decision<P, X>,
		bound: RunBindingInput<P, C>,
	): AutoRunBinding => {
		const id = decision.correlation.decisionId;
		const snapshot = bound.snapshot;
		const receipt: AutoRunReceipt = Object.freeze({
			decisionId: id,
			policyVersion: AUTO_ROUTING_POLICY_VERSION,
			questionVersion: AUTO_ROUTING_QUESTION_VERSION,
			jevModel: snapshot.jevModel,
			candidateId: bound.candidateId,
			configHash: snapshot.configHash,
			candidateSetHash: snapshot.candidateSetHash,
			selectionSource: "auto",
		});
		let state: AutoDispatchState = "uncommitted";
		let stopped: AutoReasonCode | undefined;
		let settled = false;
		const advance = (next: AutoDispatchState) => {
			if (
				AUTO_DISPATCH_STATES.indexOf(next) > AUTO_DISPATCH_STATES.indexOf(state)
			)
				state = next;
		};
		const guard = (boundary: string) => {
			const reason = launchStop(decision, bound);
			if (reason === undefined) return;
			stopped ??= reason;
			throw new AutoLaunchStoppedError(
				reason,
				`Automatic launch stopped ${boundary} (${reason}); nothing was dispatched.`,
			);
		};
		const binding: AutoRunBinding = Object.freeze({
			receipt,
			approvalId: bound.approvalId,
			signal: decision.controller.signal,
			dispatchState: () => state,
			stopReason: () => stopped,
			beforeResources() {
				if (state !== "uncommitted")
					throw new AutoLaunchStoppedError(
						"internal-error",
						"This automatic launch already began.",
					);
				guard("before creating resources");
			},
			resourcesCreated() {
				advance("resources-created");
			},
			commitDispatch() {
				if (state === "dispatch-attempted" || state === "started")
					throw new AutoLaunchStoppedError(
						"internal-error",
						"This automatic decision already attempted its one dispatch.",
					);
				guard("before dispatch");
				// No await separates this latch from runScript.
				advance("dispatch-attempted");
			},
			// Neither accounting call throws: a store failure never keeps the
			// watcher from being installed or the result from being delivered.
			recordStarted(childId: string) {
				if (state === "started") return;
				advance("started");
				decision.childId = childId;
				retainWork(
					Object.freeze({
						decisionId: id,
						state: "dispatched",
						childId,
						bound: true,
					}),
				);
			},
			recordSettled() {
				if (state !== "started" || settled) return;
				settled = true;
				if (localWork?.decisionId === id) localWork = undefined;
				markResolved(id);
				const stored = storedWork();
				if (
					stored.ok &&
					stored.work?.decisionId === id &&
					stored.work.state === "dispatched"
				)
					storeWork(undefined);
			},
			settled: () => settled,
		});
		boundPreparedRuns.set(binding, bound.prepared);
		return binding;
	};

	/** After ownership: record, confirm, revalidate, and hand off once. */
	const owningPath = async (
		decision: Decision<P, X>,
		authority: AutoRoutingAuthority<P, C>,
		candidate: AutoCandidate<P>,
		route: AutoSelectedRoute,
	): Promise<InputEventResult> => {
		const id = decision.correlation.decisionId;
		decision.phase = "recording";
		const record = autoRequestRecord(id, decision.request, "accepted");
		const confirmed = recordAutoRequest(
			pi,
			decision.ctx,
			decision.admitted,
			id,
			record,
		);
		// A partial effect may exist after a failed send; it is never retried,
		// rebased, or followed by a second record.
		decision.recordAttempted = confirmed.ok || confirmed.sendAttempted;
		if (!confirmed.ok) return hold(decision, "request-record-failed");
		decision.record = record;
		decision.expected = {
			branchAnchor: confirmed.entryId,
			size: confirmed.offset + confirmed.bytes,
		};
		// Recording is synchronous but not free; an expired budget holds.
		// The pilot dialog is entered only with budget left.
		if (budgetExpired(decision)) return hold(decision, "jev-timeout");

		if (decision.mode === "pilot") {
			decision.phase = "confirming";
			const remainingMs = decision.deadline?.remainingMs() ?? 0;
			const answer = await confirmPilot(decision, candidate, route);
			if (answer !== "approved") return hold(decision, answer);
			// The dialog's explicit 30-second allowance does not retroactively
			// expire an approval; time after it spends the remaining budget.
			decision.pilotResume = Object.freeze({
				remainingMs,
				approvedAt: now(),
			});
		}

		decision.phase = "revalidating";
		const stopped = stopReason(decision);
		if (stopped) return hold(decision, stopped);
		try {
			if (!decision.ctx.isIdle() || decision.ctx.hasPendingMessages())
				return hold(decision, "parent-started");
		} catch {
			return hold(decision, "internal-error");
		}
		const reverified = confirmAutoRequestRecorded(
			decision.ctx,
			decision.admitted,
			record,
		);
		if (!reverified.ok || reverified.entryId !== confirmed.entryId)
			return hold(decision, "request-record-failed");
		const snapshot = decision.snapshot;
		if (!snapshot) return hold(decision, "internal-error");
		// This decision's own request is the only append since admission, so
		// the admitted branch anchor still describes the candidate context.
		const revalidated = revalidateAutoRoutingSnapshot(
			snapshot,
			{
				config: options.loadConfig(),
				branchAnchor: snapshot.branchAnchor,
				sessionGeneration: snapshot.sessionGeneration,
			},
			authority,
		);
		// Past the budget nothing launches, and no parent fallback is sent,
		// even when revalidation also failed.
		if (budgetExpired(decision)) return hold(decision, "jev-timeout");
		if (!revalidated.ok) return fallbackOrHold(decision, "stale-snapshot");
		const fresh = revalidated.snapshot.candidates.find(
			(entry) => entry.id === candidate.id,
		);
		if (!fresh) return fallbackOrHold(decision, "stale-snapshot");

		const binding = createRunBinding(decision, {
			authority,
			snapshot,
			candidateId: candidate.id,
			approvalId: candidate.profile.id,
			prepared: fresh.prepared,
			record,
			entryId: confirmed.entryId,
		});
		decision.run = binding;
		decision.phase = "launching";
		let outcome: AutoLaunchOutcome;
		try {
			outcome = await options.launch({
				decisionId: id,
				candidate: fresh,
				route,
				ctx: decision.ctx,
				signal: decision.controller.signal,
				binding,
			});
		} catch {
			outcome = {
				status: "uncertain",
				detail: "The launch failed after it may have dispatched.",
			};
		}
		// The latch, not the reported outcome, says whether a process may
		// exist: past `dispatch-attempted` nothing is ever known no-work, and
		// a child recorded started is supervised by its existing watcher.
		const dispatchState = binding.dispatchState();
		if (
			dispatchState === "started" &&
			outcome.status !== "started" &&
			decision.childId !== undefined
		)
			outcome = {
				status: "started",
				childId: decision.childId,
				name: fresh.prepared.params.name,
			};
		else if (
			outcome.status === "rejected" &&
			(dispatchState === "dispatch-attempted" || dispatchState === "started")
		)
			outcome = {
				status: "uncertain",
				detail: "The launch failed after its dispatch was attempted.",
			};
		if (outcome.status === "rejected") {
			const stopped = decision.cancelReason ?? binding.stopReason();
			// Only a stale snapshot may take the parent policy; cancellation,
			// session, idle, persistence, and internal stops always hold.
			return stopped && stopped !== "stale-snapshot"
				? hold(decision, stopped)
				: fallbackOrHold(decision, stopped ?? "launch-rejected");
		}
		if (outcome.status === "uncertain") return retainUncertain(decision);
		decision.childId = outcome.childId;
		markDispatched(decision);
		// A bound child was retained by recordStarted before its watcher, and
		// a fast one may already be settled: never retain it again.
		if (binding.dispatchState() !== "started")
			retainWork(
				Object.freeze({
					decisionId: id,
					state: "dispatched",
					childId: outcome.childId,
				}),
			);
		// A fast child may already have settled; never claim it is running.
		const running =
			!binding.settled() && options.isChildRunning(outcome.childId);
		const started: JsonObject = {
			state: "started",
			childId: outcome.childId,
			name: outcome.name,
			agent: candidate.role.name,
			roleSource: candidate.role.source,
			harness: route.harness,
			model: exactModelLabel(route),
			effort: route.exactEffort,
			candidateId: route.candidateId,
		};
		if (candidate.role.provider) {
			started.provider = candidate.role.provider;
			started.providerVersion = candidate.role.providerVersion ?? "";
		}
		sendStatus(
			decision,
			`Automatic delegation started subagent "${outcome.name}" (${outcome.childId}) for decision ${id}: role ${describeRole(candidate)}, harness ${route.harness}, model ${exactModelLabel(route)}, effort ${route.exactEffort}, all automatically selected from the administrator allowlist. ${running ? "Its result is delivered automatically; do not perform the request yourself." : "It has already finished; its result is delivered separately."}`,
			started,
			false,
		);
		return HANDLED;
	};

	const runOwning = async (
		decision: Decision<P, X>,
		snapshot: AutoRoutingSnapshot<P>,
		authority: AutoRoutingAuthority<P, C>,
		transport: JevTransport,
	): Promise<InputEventResult> => {
		let evaluation: Evaluation<P>;
		try {
			evaluation = await evaluate(decision, snapshot, transport, () =>
				stopReason(decision),
			);
		} catch {
			return hold(decision, "internal-error");
		}
		if (evaluation.kind === "stopped") return hold(decision, evaluation.reason);
		const stopped = stopReason(decision);
		if (stopped) return hold(decision, stopped);
		const unowned = (reason: AutoReasonCode) =>
			decision.config.config.failurePolicy === "hold"
				? hold(decision, reason)
				: continueUnowned(decision, reason);
		if (evaluation.kind !== "selected") return unowned(evaluation.reason);
		decision.route = evaluation.route;
		// Unowned drift or revocation never launches or reclassifies.
		if (!configCurrent(decision.config)) return unowned("config-drift");
		// A selection past the one budget is a timeout, before any effect.
		if (budgetExpired(decision)) return unowned("jev-timeout");
		// Ownership precedes every request, resource, or fallback effect.
		decision.owned = true;
		try {
			return await owningPath(
				decision,
				authority,
				evaluation.candidate,
				evaluation.route,
			);
		} catch {
			return hold(decision, "internal-error");
		}
	};

	/** Shadow: observational only; never owns, records, or launches. */
	const runShadow = async (
		decision: Decision<P, X>,
		snapshot: AutoRoutingSnapshot<P>,
		transport: JevTransport,
	): Promise<void> => {
		const check = (): AutoCancelReason | undefined =>
			decision.cancelReason ??
			(sameGeneration(decision) ? undefined : "session-changed");
		let evaluation: Evaluation<P>;
		try {
			evaluation = await evaluate(decision, snapshot, transport, check);
		} catch {
			evaluation = { kind: "stopped", reason: "user-cancelled" };
			decision.reason = "internal-error";
		}
		if (evaluation.kind === "selected") decision.route = evaluation.route;
		finish(
			decision,
			"observed",
			decision.reason ??
				(evaluation.kind === "selected" ? undefined : evaluation.reason),
		);
	};

	const launchUndispatched = (decision: Decision<P, X>): boolean => {
		const state = decision.run?.dispatchState();
		return state === "uncommitted" || state === "resources-created";
	};

	const cancelDecision = (
		decision: Decision<P, X>,
		reason: AutoCancelReason,
	): boolean => {
		if (decision.terminal || decision.cancelReason) return false;
		// A launch stops only while no dispatch was attempted; its guards
		// and shell wait observe this reason and the aborted signal.
		if (decision.phase === "launching" && !launchUndispatched(decision))
			return false;
		decision.cancelReason = reason;
		decision.controller.abort();
		return true;
	};

	const onInput = async (
		event: InputEvent,
		ctx: X,
	): Promise<InputEventResult> => {
		let decision: Decision<P, X> | undefined;
		try {
			// A second submission at the exact observable ingress boundary (TUI,
			// interactive, no streaming) never waits behind an older undispatched
			// decision: the older one is held, this one continues. RPC, JSON,
			// print, extension, steer, and follow-up input has no effect on it.
			const older = current;
			if (
				older &&
				older.mode !== "shadow" &&
				isIngressBoundaryEvent(event, ctx)
			) {
				cancelDecision(older, "superseded");
				return CONTINUE;
			}
			const config = initialized;
			const gate = evaluateAutoRoutingInput({
				config,
				event,
				ctx,
				pi,
				env,
				busy: busy(),
				herdrAvailable: options.herdrAvailable,
			});
			if (!gate.eligible || config.status !== "enabled") return CONTINUE;
			// A changed or revoked durable config blocks until reload.
			if (!configCurrent(config)) return CONTINUE;
			// Durable unknown work from an earlier process blocks admission.
			recover(ctx);
			if (recoveryBlocks()) return CONTINUE;
			// Reserve the one slot synchronously, before any await.
			decision = {
				correlation: createAutoDecisionCorrelation(gate.session, generation),
				mode: gate.mode,
				config,
				request: gate.request,
				admitted: gate.session,
				cwd: canonicalCwd(ctx.cwd),
				ctx,
				controller: new AbortController(),
				startedAt: now(),
				phase: "classifying",
				owned: false,
				terminal: false,
				recordAttempted: false,
				expected: {
					branchAnchor: gate.session.branchAnchor,
					size: gate.session.size,
				},
				batches: 0,
			};
			current = decision;
			const authority = options.authority(ctx);
			const built = buildAutoRoutingSnapshot(
				{
					config,
					task: gate.request,
					decisionId: decision.correlation.decisionId,
					branchAnchor: gate.session.branchAnchor,
					sessionGeneration: decision.correlation.sessionGeneration,
				},
				authority,
			);
			if (!built.ok) {
				if (built.reason === "jev-request-too-large") {
					if (decision.mode === "shadow") {
						finish(decision, "observed", built.reason);
						return CONTINUE;
					}
					if (config.config.failurePolicy === "hold")
						return hold(decision, built.reason);
				}
				// Ineligible before classification: no receipt, no effect.
				decision.terminal = true;
				if (current === decision) current = undefined;
				return CONTINUE;
			}
			decision.snapshot = built.snapshot;
			const transport = options.transport(ctx);
			if (decision.mode === "shadow") {
				const task = runShadow(decision, built.snapshot, transport).catch(noop);
				background.add(task);
				void task.finally(() => background.delete(task));
				return CONTINUE;
			}
			return await runOwning(decision, built.snapshot, authority, transport);
		} catch {
			if (!decision) return CONTINUE;
			if (decision.mode === "shadow") {
				if (!decision.terminal) finish(decision, "observed", "internal-error");
				return CONTINUE;
			}
			return hold(decision, "internal-error");
		}
	};

	const onLifecycle = (event: AutoLifecycleEvent) => {
		const decision = current;
		if (event === "agent_start") {
			// Parent work never cancels shadow observation or dispatched work.
			if (decision && decision.mode !== "shadow")
				cancelDecision(decision, "parent-started");
			return;
		}
		// Every session transition, observed at its start or its end, is a
		// new generation; shadow observation stops for it too.
		generation++;
		// The active branch may now hold other durable evidence: the next
		// admission rescans it. In-process retained and resolved accounting
		// is kept, so this process's own decisions stay known.
		recovery = undefined;
		if (decision)
			cancelDecision(
				decision,
				event === "session_shutdown" ? "shutdown" : "session-changed",
			);
	};

	const cancel = (): AutoCancelReport => {
		const decision = current;
		const work = visibleWork();
		const running =
			work?.childId !== undefined && options.isChildRunning(work.childId);
		if (decision && cancelDecision(decision, "user-cancelled"))
			return Object.freeze({
				cancelled: true,
				decisionId: decision.correlation.decisionId,
				message:
					decision.mode === "shadow"
						? `Cancelled shadow observation ${decision.correlation.decisionId}; the input was already handled normally.`
						: `Cancelled pending automatic decision ${decision.correlation.decisionId}; its request is held and was not sent to a child or the parent.`,
			});
		if (decision && decision.phase === "launching")
			return Object.freeze({
				cancelled: false,
				decisionId: decision.correlation.decisionId,
				message: `Decision ${decision.correlation.decisionId} already attempted its dispatch and may be running; cancel did not stop it. Use subagent_interrupt once it runs.`,
			});
		if (work?.state === "uncertain")
			return Object.freeze({
				cancelled: false,
				decisionId: work.decisionId,
				message: `Decision ${work.decisionId} may have dispatched work that could not be confirmed; cancel did not stop anything. Inspect the subagent panes.`,
			});
		if (work && running)
			return Object.freeze({
				cancelled: false,
				decisionId: work.decisionId,
				message: `No automatic decision is pending. Child ${work.childId} from decision ${work.decisionId} is already running; cancel does not terminate it (use subagent_interrupt).`,
			});
		return Object.freeze({
			cancelled: false,
			message: "No automatic routing decision is pending.",
		});
	};

	const snapshotStatus = (): AutoRoutingStatus => {
		const status: AutoRoutingStatus = {
			config:
				initialized.status === "enabled"
					? initialized.config.mode
					: initialized.status,
			configChanged:
				configIdentity(readConfig()) !== configIdentity(initialized),
			sessionGeneration: generation,
			limitations: AUTO_ROUTING_LIMITATIONS,
		};
		if (recovery) status.recovery = recovery;
		const decision = current;
		if (decision)
			status.pending = Object.freeze({
				decisionId: decision.correlation.decisionId,
				mode: decision.mode,
				phase: decision.phase,
				owned: decision.owned,
				elapsedMs: Math.max(0, Math.round(now() - decision.startedAt)),
			});
		const stored = storedWork();
		if (!stored.ok) status.retainedUnavailable = true;
		const work = localWork ?? (stored.ok ? stored.work : undefined);
		if (work) {
			const kept: AutoRetainedStatus = {
				decisionId: work.decisionId,
				state: work.state,
				running:
					work.childId !== undefined && options.isChildRunning(work.childId),
			};
			if (work.childId) kept.childId = work.childId;
			status.retained = Object.freeze(kept);
		}
		if (last) status.last = last;
		return Object.freeze(status);
	};

	return Object.freeze({
		onInput,
		onLifecycle,
		recover,
		configuration: () => initialized,
		cancel,
		snapshotStatus,
		settled: async () => {
			while (background.size > 0) await Promise.all(background);
		},
	});
}

/** Local status lines for `/subagents-routing status`. */
export function formatAutoRoutingStatus(status: AutoRoutingStatus): string {
	const lines = [`Automatic routing: ${status.config}`];
	if (status.retainedUnavailable)
		lines.push(
			"Unknown: retained automatic work could not be read; new automatic dispatch stays disabled in this process.",
		);
	if (status.configChanged)
		lines.push(
			"The configuration file changed since this session loaded; it takes effect only after /reload, and an enabled mode sends nothing while it differs.",
		);
	const recovery = status.recovery;
	if (recovery?.status === "unavailable")
		lines.push(
			`Unknown: earlier automatic work could not be reconstructed (${recovery.detail}); new automatic routing stays disabled in this session.`,
		);
	else if (recovery?.status === "unknown") {
		for (const work of recovery.work)
			lines.push(
				`Unknown: decision ${work.decisionId} has durable ${work.evidence === "accepted" ? "accepted-request" : work.evidence} evidence with no recorded no-work outcome; it may still be running.`,
			);
		if (recovery.total > recovery.work.length)
			lines.push(
				`Unknown: ${recovery.total - recovery.work.length} more decisions are not listed.`,
			);
		lines.push(
			"Unknown work is never replayed, adopted, or retried, and new automatic routing stays disabled on this branch. Inspect the session and subagent panes, recover manually, and use a fresh session for further automatic work once no earlier work is running.",
		);
	}
	if (status.pending)
		lines.push(
			`Pending decision ${status.pending.decisionId} (${status.pending.mode}): ${status.pending.phase}, ${status.pending.owned ? "owned" : "not owned"}, ${status.pending.elapsedMs} ms.`,
		);
	else lines.push("No decision is pending.");
	if (status.retained)
		lines.push(
			status.retained.state === "uncertain"
				? `Busy: decision ${status.retained.decisionId} may have dispatched work (unknown); new automatic dispatch stays disabled in this process.`
				: `Busy: child ${status.retained.childId ?? "?"} from decision ${status.retained.decisionId} is ${status.retained.running ? "running" : "settled"}.`,
		);
	if (status.last)
		lines.push(
			`Last decision ${status.last.decisionId} (${status.last.mode}): ${status.last.phase}${status.last.reason ? ` (${status.last.reason})` : ""}.`,
		);
	lines.push(...status.limitations);
	return lines.join("\n");
}

/** Bidirectional formatting and line/paragraph separators. */
const BIDI_CONTROL =
	/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu;
/** Control characters other than newline. */
const DISPLAY_CONTROL = /[^\P{Cc}\n]/gu;

/**
 * Make untrusted text safe for a terminal: tabs become spaces, and every
 * other control, bidirectional override, and separator is shown as an
 * escape instead of being interpreted.
 */
export function escapeTerminalText(text: string): string {
	const visible = (character: string) =>
		`\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`;
	return text
		.replace(/\t/g, "    ")
		.replace(DISPLAY_CONTROL, visible)
		.replace(BIDI_CONTROL, visible);
}

/**
 * The most display characters one UTF-8 byte of admissible text becomes:
 * a one-byte control is shown as `\u{1b}`, six characters. Every other
 * escape or unescaped character is no longer per byte.
 */
const AUTO_DISPLAY_MAX_CHARS_PER_BYTE = 6;
/** Room for a status message's fixed header and markers around a request. */
const AUTO_DISPLAY_ENVELOPE = Object.freeze({ lines: 16, chars: 4096 });

/**
 * Display bounds of one rendered routing message. Expanded bounds derive
 * from the admission cap, so every admissible request is shown in full
 * after escaping, even one made only of newlines or controls; only content
 * no admitted request can produce is bounded.
 */
export const AUTO_MESSAGE_VIEW_LIMITS = Object.freeze({
	previewLines: 5,
	expandedLines:
		AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes +
		1 +
		AUTO_DISPLAY_ENVELOPE.lines,
	expandedChars:
		AUTO_ROUTING_REQUEST_LIMITS.maxPromptBytes *
			AUTO_DISPLAY_MAX_CHARS_PER_BYTE +
		1 +
		AUTO_DISPLAY_ENVELOPE.chars,
	fieldChars: 256,
});

export type AutoMessageView = Readonly<{
	title: string;
	tone: "accent" | "warning" | "error";
	lines: readonly string[];
	/** Lines omitted by the display bound; the stored message is complete. */
	omitted: number;
}>;

function messageText(content: any): string {
	if (isString(content)) return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			isRecord(block) && block.type === "text" && isString(block.text)
				? block.text
				: "",
		)
		.join("");
}

function field(value: any): string | undefined {
	if (!isString(value) || value === "") return undefined;
	const escaped = escapeTerminalText(value).replace(/\n/g, " ");
	return escaped.length > AUTO_MESSAGE_VIEW_LIMITS.fieldChars
		? `${escaped.slice(0, AUTO_MESSAGE_VIEW_LIMITS.fieldChars)}…`
		: escaped;
}

function knownReason(value: any): string | undefined {
	return isString(value) && REASON_CODES.has(value) ? value : undefined;
}

/** Display lines of one message body and how many the bound omitted. */
type DisplayLines = Readonly<{ lines: string[]; omitted: number }>;

function boundedLines(text: string, expanded: boolean): DisplayLines {
	const all = escapeTerminalText(text).split("\n");
	if (!expanded) {
		const lines = all.slice(0, AUTO_MESSAGE_VIEW_LIMITS.previewLines);
		return { lines, omitted: all.length - lines.length };
	}
	const lines: string[] = [];
	let chars = 0;
	for (const line of all) {
		if (
			lines.length >= AUTO_MESSAGE_VIEW_LIMITS.expandedLines ||
			chars + line.length > AUTO_MESSAGE_VIEW_LIMITS.expandedChars
		)
			break;
		lines.push(line);
		chars += line.length + 1;
	}
	return { lines, omitted: all.length - lines.length };
}

/**
 * The view of a `jev_auto_request` message: the exact handler-visible
 * request, labeled as such, escaped and bounded for display only.
 */
export function autoRequestView(
	message: Readonly<{ content: any; details?: any }>,
	expanded: boolean,
): AutoMessageView {
	const details = isRecord(message.details) ? message.details : {};
	const decisionId = field(details.decisionId);
	const content = messageText(message.content);
	const request = isString(details.decisionId)
		? extractAutoRequestText(content, details.decisionId)
		: undefined;
	const held = details.state === "held";
	const reason = knownReason(details.reason);
	const title = `User request · automatic delegation · handler-visible text${held ? ` · held${reason ? ` (${reason})` : ""}` : ""}`;
	const body = boundedLines(request ?? content, expanded);
	const lines = [
		...(request === undefined
			? [
					"(The record's request markers are missing; showing its stored content.)",
				]
			: []),
		...body.lines,
	];
	if (expanded && decisionId) lines.push("", `Decision: ${decisionId}`);
	return Object.freeze({
		title,
		tone: held || request === undefined ? "warning" : "accent",
		lines: Object.freeze(lines),
		omitted: body.omitted,
	});
}

const STATUS_TITLES: Readonly<Record<string, string>> = Object.freeze({
	started: "Automatic delegation · started",
	held: "Automatic delegation · held",
	"fallback-parent": "Automatic delegation · handed back to the parent",
	uncertain: "Automatic delegation · dispatch unknown",
});

/**
 * The view of a `jev_auto_status` message: the recorded state and the exact
 * automatically selected tuple, never presented as a caller's request.
 */
export function autoStatusView(
	message: Readonly<{ content: any; details?: any }>,
	expanded: boolean,
): AutoMessageView {
	const details = isRecord(message.details) ? message.details : {};
	const state = isString(details.state) ? details.state : "";
	const title = STATUS_TITLES[state] ?? "Automatic delegation · status";
	const reason = knownReason(details.reason);
	const role = field(details.agent);
	const source = field(details.provider)
		? `package:${field(details.provider)}@${field(details.providerVersion) ?? "?"}`
		: field(details.roleSource);
	const tuple = [
		field(details.harness),
		field(details.model),
		field(details.effort),
	].filter((part) => part !== undefined);
	const lines = [
		...(field(details.childId)
			? [
					`Child: ${field(details.name) ?? "subagent"} (${field(details.childId)})`,
				]
			: []),
		...(role ? [`Role: ${role}${source ? ` (${source})` : ""}`] : []),
		...(tuple.length > 0
			? [`Automatically selected: ${tuple.join(" · ")}`]
			: []),
		...(reason ? [`Reason: ${reason}`] : []),
	];
	let omitted = 0;
	if (expanded) {
		const body = boundedLines(messageText(message.content), true);
		lines.push("", ...body.lines);
		omitted = body.omitted;
		if (field(details.decisionId))
			lines.push("", `Decision: ${field(details.decisionId)}`);
	}
	return Object.freeze({
		title,
		tone:
			state === "uncertain"
				? "error"
				: state === "started"
					? "accent"
					: "warning",
		lines: Object.freeze(lines),
		omitted,
	});
}
