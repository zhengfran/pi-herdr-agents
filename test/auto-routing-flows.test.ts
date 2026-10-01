/** T09: registered public input/tool/command paths, real session artifacts,
 * existing launch/watch authority, fake Herdr and offline native fixtures.
 * This is not real-TUI or RPC-process integration evidence (T10).
 */
import "./isolated-agent-dir.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { InputEvent } from "@earendil-works/pi-coding-agent";

// Model a parent extension process, not this worker's inherited child identity.
delete process.env.PI_SUBAGENT_ID;
delete process.env.PI_HERDR_AUTO_ROUTING_DISABLED;
const flow = await import("./native-flow-harness.ts");
const { scratch, waitFor } = await import("./native-fixtures.ts");
const extension = (await import("../pi-extension/subagents/index.ts")).default;
const {
	parseAutoRoutingConfig,
	autoRoutingConfigDigest,
	loadAutoRoutingConfig,
} = await import("../pi-extension/subagents/auto-routing-config.ts");
const { autoRoleDefinitionSha256 } = await import(
	"../pi-extension/subagents/auto-routing-candidates.ts"
);
const { validateJevEvidence } = await import(
	"../pi-extension/subagents/auto-routing-policy.ts"
);
const { createJevDeadline } = await import(
	"../pi-extension/subagents/jev-client.ts"
);
const { JEV_REASONING_LEVELS, JEV_CONSEQUENCE_LEVELS } = await import(
	"../pi-extension/subagents/jev-questions.ts"
);
const { extractAutoRequestText, AUTO_RECEIPT_ENTRY_TYPE } = await import(
	"../pi-extension/subagents/auto-routing-input.ts"
);

const TASK = "Inspect the parser implementation and report a bounded finding.";
const ROLE = "af-reporter";
flow.writeRole(ROLE, [
	"model: fake/pinned",
	"thinking: low",
	"auto-exit: true",
	"tools: read, bash",
	"spawning: false",
]);
const durable = join(
	process.env.PI_CODING_AGENT_DIR!,
	"herdr-agents",
	"config.json",
);
const image = {
	type: "image" as const,
	data: "aGVsbG8=",
	mimeType: "image/png",
};
const event = (text = TASK, extra: Partial<InputEvent> = {}): InputEvent => ({
	type: "input",
	source: "interactive",
	text,
	...extra,
});
const modes = ["off", "shadow", "pilot", "auto"] as const;
type Mode = (typeof modes)[number];
type Harness = "pi" | "claude" | "kiro";
type NativeTestSeam = NonNullable<
	Parameters<typeof flow.testApi.setNativeTestSeam>[0]
>;
type PiResult = Awaited<ReturnType<NonNullable<NativeTestSeam["piWatch"]>>>;
/** Same shared runtime slot used by the extension across parent reloads. */
type RoutingTestRuntime = {
	autoRoutingRetained?: unknown;
	nativeTestSeam?: NativeTestSeam;
};
function runtimeState(): RoutingTestRuntime {
	// SAFETY: index.ts initializes this exact shared symbol before these tests;
	// only its retained slot and the installed, owner-typed test seam are used.
	const globals = globalThis as typeof globalThis & {
		[key: symbol]: RoutingTestRuntime;
	};
	return globals[Symbol.for("pi-subagents/runtime")];
}
const HANDLED = { action: "handled" };
const CONTINUE = { action: "continue" };

function config(
	mode: Mode,
	harness: Harness,
	failurePolicy: "parent" | "hold",
) {
	const role = flow.testApi
		.discoverAgentCatalog(flow.api)
		.agents.find((r: any) => r.name === ROLE)!;
	const document = {
		autoRouting: {
			version: 1,
			mode,
			policyVersion: "jev-auto-v1",
			questionVersion: "jev-auto-questions-v1",
			consent: {
				disclosureVersion: "jev-egress-v1",
				acknowledgedAt: "2026-09-30T00:00:00Z",
				sendCurrentPromptAndReviewedProfiles: true,
			},
			jev: { provider: "typesafe", model: "jev-1.13.0", timeoutMs: 5000 },
			failurePolicy,
			roles: [
				{
					id: "reporter",
					agent: ROLE,
					source: role.source,
					definitionSha256: autoRoleDefinitionSha256(role),
					labelRole: "build",
					intent: "report",
					purpose: "task",
					responsibility: "Bounded repository inspection.",
					deliverable: "A report.",
					excludes: "Publication.",
				},
			],
			candidates: [
				{
					id: `reporter-${harness}`,
					roleId: "reporter",
					harness,
					model:
						harness === "pi"
							? { namespace: "pi", ref: "fake/exact-2" }
							: { namespace: harness, id: `${harness}-fixture-20260930` },
					effort: "high",
					tier: "mid",
					family: "fixture",
					taskStrengths: "Inspection.",
					limitations: "No publication.",
					capabilityEvidence: "Offline fixture v1.",
					preference: 1,
				},
			],
		},
	};
	mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "herdr-agents"), {
		recursive: true,
	});
	writeFileSync(durable, JSON.stringify(document));
	const parsed = parseAutoRoutingConfig(document, durable);
	const loaded = loadAutoRoutingConfig();
	assert.notEqual(loaded.status, "invalid");
	if (loaded.status === "invalid") throw new Error(loaded.diagnostic);
	assert.equal(loaded.digest, autoRoutingConfigDigest(parsed));
	return loaded;
}

/** Valid complete wire distributions plus Pi's actual normalized shape. */
function answer(batch: any, abstain = false) {
	const wire: any = {
		model: "jev-1.13.0",
		answers: {},
		usage: { input_tokens: 100, output_tokens: 10 },
	};
	const normalized: any = {};
	for (const q of batch.expected) {
		let a: any;
		if (q.type === "choice") {
			const winner = abstain ? "none" : q.options[0];
			a = {
				type: "choice",
				choice: winner,
				confidence: 0.95,
				probabilities: Object.fromEntries(
					q.options.map((o: string) => [
						o,
						o === winner
							? 0.9
							: o === (winner === "none" ? q.options[0] : "none")
								? 0.1
								: 0,
					]),
				),
			};
			normalized[q.id] = a;
		} else if (q.type === "score") {
			const levels =
				q.id === "reasoning" ? JEV_REASONING_LEVELS : JEV_CONSEQUENCE_LEVELS;
			const p =
				q.id === "reasoning" ? [0.05, 0.9, 0.05, 0] : [0.95, 0.05, 0, 0];
			a = {
				type: "score",
				score: p.reduce((s, v, i) => s + v * i, 0),
				confidence: 0.95,
				probabilities: Object.fromEntries(p.map((v, i) => [String(i), v])),
				legend: Object.fromEntries(levels.map((v, i) => [String(i), v])),
			};
			normalized[q.id] = {
				type: "score",
				score: a.score,
				confidence: a.confidence,
			};
		} else {
			a = { type: "noul", noul: q.id.startsWith("role_fit_") ? 0.95 : 0.05 };
			normalized[q.id] = { type: "bool", probability: a.noul };
		}
		wire.answers[q.id] = a;
	}
	const validated = validateJevEvidence(batch, {
		wire,
		result: {
			api: "typesafe-system-one",
			provider: "typesafe",
			model: "jev-1.13.0",
			answers: normalized,
			stopReason: "stop",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 0,
		},
	});
	assert.ok(validated.ok, validated.ok ? "" : validated.detail);
	return { status: "ok" as const, evidence: validated.evidence };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function setup(
	options: {
		mode?: Mode;
		harness?: Harness;
		failurePolicy?: "parent" | "hold";
		persisted?: boolean;
		env?: NodeJS.ProcessEnv;
		respond?: (batch: any, index: number) => any;
		before?: (host: ReturnType<typeof flow.inputHost>) => void;
		seams?: NonNullable<Parameters<typeof extension>[1]>["autoRouting"];
	} = {},
) {
	const host = flow.inputHost(scratch("auto-flow"), options.persisted);
	const calls: any[] = [];
	const loaded = config(
		options.mode ?? "auto",
		options.harness ?? "pi",
		options.failurePolicy ?? "parent",
	);
	options.before?.(host);
	extension(host.api, {
		autoRouting: {
			env: options.env ?? {},
			loadConfig: loadAutoRoutingConfig,
			herdrAvailable: () => true,
			transport: () => ({
				createDeadline: (ms: number) =>
					createJevDeadline(ms, options.seams?.now),
				classify: async (request: any) => {
					calls.push(request);
					const result = options.respond
						? await options.respond(request.batch, calls.length - 1)
						: answer(request.batch);
					if (request.signals?.some((s: AbortSignal) => s.aborted))
						return { status: "cancelled" };
					if (request.deadline.expired())
						return { status: "unavailable", reason: "jev-timeout" };
					return result;
				},
			}),
			...options.seams,
		},
	});
	const entries = () =>
		readFileSync(host.manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const requests = () =>
		entries().filter(
			(e) => e.type === "custom_message" && e.customType === "jev_auto_request",
		);
	const receipts = () =>
		entries().filter(
			(e) => e.type === "custom" && e.customType === AUTO_RECEIPT_ENTRY_TYPE,
		);
	const results = () =>
		host.messages.filter(({ message }) =>
			["subagent_result", "subagent_ping"].includes(message.customType),
		);
	const fallback = () =>
		host.messages.filter(({ options }) => options.triggerTurn);
	return {
		...host,
		calls,
		loaded,
		entries,
		requests,
		receipts,
		results,
		fallback,
	};
}

function piRecorder(
	host: ReturnType<typeof setup>,
	options: {
		outcome?: "ok" | "error" | "help";
		wait?: () => Promise<void>;
		beforeResources?: () => void;
		failDispatch?: boolean;
		failResources?: boolean;
	} = {},
) {
	const commands: string[] = [];
	const events: string[] = [];
	flow.testApi.setNativeTestSeam({
		terminalAvailable: true,
		operations: {
			createPane(name) {
				assert.equal(
					host.requests().length,
					commands.length + 1,
					"actual disk request precedes resources",
				);
				options.beforeResources?.();
				if (options.failResources) throw new Error("pane unavailable");
				events.push(`create:${name}`);
				return "auto-pi-pane";
			},
			createWorktree() {
				throw new Error("auto must not create a worktree");
			},
			async waitForShellReady() {
				events.push("ready");
				await options.wait?.();
			},
			runScript(_surface, command, script) {
				assert.equal(
					host.requests().length,
					commands.length + 1,
					"actual disk request precedes dispatch",
				);
				assert.equal(
					extractAutoRequestText(
						host.requests().at(-1)!.content,
						host.requests().at(-1)!.details.decisionId,
					),
					host.calls[commands.length * 2].batch.context.state.prompt,
				);
				commands.push(command);
				events.push("run");
				if (options.failDispatch)
					throw new Error("lost dispatch acknowledgement");
				return script.scriptPath;
			},
			closePane() {
				events.push("close");
			},
		},
		piWatch: async (child) => {
			const result: PiResult = {
				name: child.name,
				task: child.task,
				summary: "Instant Pi fixture finding",
				exitCode: options.outcome === "error" ? 1 : 0,
				elapsed: 0,
				sessionFile: child.sessionFile,
			};
			if (options.outcome === "error") result.errorMessage = "fixture failed";
			if (options.outcome === "help")
				result.ping = { name: child.name, message: "Need a decision." };
			return result;
		},
	});
	return { commands, events };
}
function assertAutomatic(message: any, harness: Harness) {
	assert.equal(message.details.autoRouting.selectionSource, "auto");
	assert.equal(message.details.selection.harnessSource, "auto");
	assert.equal(message.details.selection.harness, harness);
	assert.equal(message.details.selection.role.name, ROLE);
	assert.equal(message.details.selection.role.source, "global");
	assert.equal(message.details.runtimeProvenance.model.source, "auto");
	assert.equal(message.details.runtimeProvenance.thinking.source, "auto");
	assert.equal(message.details.worktree, undefined);
	assert.equal(message.details.autoRouting.configHash.length, 64);
	assert.equal(message.details.autoRouting.candidateSetHash.length, 64);
	if (harness !== "pi") assert.equal(message.details.native.mode, "autonomous");
	assert.ok(message.details.autoRouting.decisionId);
}
async function settled(host: ReturnType<typeof setup>) {
	await waitFor(
		() =>
			host.results().length === 1 && flow.testApi.runningSubagents.size === 0,
	);
	assert.equal(
		host.state.signalReads,
		0,
		"idle ctx.signal is not an input cancellation API",
	);
}

afterEach(() => {
	// Uncertain decisions intentionally remain busy within their parent. Tests
	// below use process-local isolated parents, so clear only that test state.
	runtimeState().autoRoutingRetained = undefined;
});

describe("registered input: exact current public gate", () => {
	for (const routingMode of modes) {
		it(`${routingMode}: non-TUI/source/streaming/control/image/idle/API/session paths never call Jev`, async () => {
			const host = setup({ mode: routingMode });
			const recorder = piRecorder(host);
			for (const mode of ["rpc", "json", "print"] as const) {
				host.ctx.mode = mode;
				for (const source of ["interactive", "rpc", "extension"] as const)
					for (const streamingBehavior of [
						undefined,
						"steer",
						"followUp",
					] as const)
						assert.deepEqual(
							await host.input(event(TASK, { source, streamingBehavior })),
							CONTINUE,
						);
			}
			host.ctx.mode = "tui";
			for (const input of [
				event(TASK, { source: "rpc" }),
				event(TASK, { source: "extension" }),
				event(TASK, { streamingBehavior: "steer" }),
				event(TASK, { streamingBehavior: "followUp" }),
				event("", { images: [image] }),
				event(TASK, { images: [image] }),
				...[
					" ",
					"/subagent reporter",
					"/subagent_resume",
					"/subagent_send",
					"/plan",
					"/iterate",
					"/btw",
					"/worktree",
					"/subagents-init",
					" /unknown",
					" !echo hi",
				].map((text) => event(text)),
			])
				assert.deepEqual(await host.input(input), CONTINUE);
			host.state.idle = false;
			assert.deepEqual(await host.input(event()), CONTINUE);
			host.state.idle = true;
			host.state.pending = true;
			assert.deepEqual(await host.input(event()), CONTINUE);
			host.state.pending = false;
			const saved = host.ctx.hasPendingMessages;
			Reflect.deleteProperty(host.ctx, "hasPendingMessages");
			assert.deepEqual(await host.input(event()), CONTINUE);
			host.ctx.hasPendingMessages = saved;
			assert.equal(host.calls.length, 0);
			assert.equal(recorder.commands.length, 0);
			const fresh = setup({ mode: routingMode, persisted: false });
			assert.equal(existsSync(fresh.manager.getSessionFile()!), false);
			assert.deepEqual(await fresh.input(event()), CONTINUE);
			assert.equal(fresh.calls.length, 0);
		});
		for (const identity of ["PI_SUBAGENT_ID", "PI_HERDR_AUTO_ROUTING_DISABLED"])
			it(`${routingMode}: child/BTW/handoff/resumed marker ${identity} bypasses`, async () => {
				const host = setup({ mode: routingMode, env: { [identity]: "1" } });
				piRecorder(host);
				assert.deepEqual(await host.input(event()), CONTINUE);
				assert.equal(host.calls.length, 0);
			});
	}
});

describe("isolated ordered handlers only observe their current view", () => {
	for (const kind of ["images", "command", "file-text"] as const)
		it(`earlier ${kind} transform feeds routing; owned handled suppresses later handlers`, async () => {
			const captured =
				kind === "file-text"
					? `${TASK}\n<file name="private.ts">upstream file data</file>`
					: TASK;
			const host = setup({
				before: (h) =>
					h.api.on("input", () => ({
						action: "transform",
						text: captured,
						images: [],
					})),
			});
			const recorder = piRecorder(host);
			let later = 0;
			host.api.on("input", () => {
				later++;
				return { action: "transform", text: "not visible to router" };
			});
			assert.deepEqual(
				await host.input(
					event(
						kind === "command" ? "/upstream" : TASK,
						kind === "images" ? { images: [image] } : {},
					),
				),
				HANDLED,
			);
			await settled(host);
			assert.equal(later, 0);
			assert.equal(recorder.commands.length, 1);
			assert.equal(host.calls[0].batch.context.state.prompt, captured);
			assert.equal(
				extractAutoRequestText(
					host.requests()[0].content,
					host.requests()[0].details.decisionId,
				),
				captured,
			);
		});
	it("earlier handled prevents routing entirely, with independent registrations", async () => {
		const host = setup({ before: (h) => h.api.on("input", () => HANDLED) });
		piRecorder(host);
		assert.deepEqual(await host.input(event()), HANDLED);
		assert.equal(host.calls.length, 0);
		const other = setup({ respond: (b) => answer(b, true) });
		piRecorder(other);
		assert.deepEqual(await other.input(event()), CONTINUE);
		assert.equal(other.calls.length, 1);
	});
	it("continue preserves earlier transforms and allows later transforms, without reclassification", async () => {
		const host = setup({
			respond: (b) => answer(b, true),
			before: (h) =>
				h.api.on("input", () => ({
					action: "transform",
					text: "Earlier visible request.",
				})),
		});
		piRecorder(host);
		host.api.on("input", (e: InputEvent) => ({
			action: "transform",
			text: `${e.text} Later parent text.`,
		}));
		assert.deepEqual(await host.input(event()), {
			action: "transform",
			text: "Earlier visible request. Later parent text.",
			images: undefined,
		});
		assert.equal(
			host.calls[0].batch.context.state.prompt,
			"Earlier visible request.",
		);
		assert.equal(host.calls.length, 1);
		assert.equal(host.requests().length, 0);
	});
});

describe("registered decisions use existing launch and completion authority", () => {
	for (const outcome of ["ok", "error", "help"] as const)
		it(`Pi instant ${outcome}: request on disk before dispatch, one truthful automatic result`, async () => {
			const host = setup();
			const recorder = piRecorder(host, { outcome });
			assert.deepEqual(await host.input(event()), HANDLED);
			await settled(host);
			assert.equal(host.calls.length, 2);
			assert.equal(recorder.commands.length, 1);
			assert.match(recorder.commands[0], /--model 'fake\/exact-2'/);
			assert.match(recorder.commands[0], /--thinking 'high'/);
			assert.match(recorder.commands[0], /PI_HERDR_AUTO_ROUTING_DISABLED=1/);
			assert.match(recorder.commands[0], /unset TYPESAFE_API_KEY/);
			assert.doesNotMatch(recorder.commands[0], /--resume/);
			assert.match(recorder.commands[0], /--tools 'read,bash,caller_ping'/);
			assert.match(recorder.commands[0], /PI_SUBAGENT_AUTO_EXIT=1/);
			assert.doesNotMatch(recorder.commands[0], /PI_SUBAGENT_PERSISTENT=1/);
			assertAutomatic(host.results()[0].message, "pi");
			assert.match(
				host.results()[0].message.content,
				outcome === "help"
					? /Need a decision/
					: outcome === "error"
						? /fixture failed/
						: /Instant Pi fixture finding/,
				"existing parent wake-up carries the actual result, not a context-free notification",
			);
			assert.equal(
				host.results()[0].message.customType,
				outcome === "help" ? "subagent_ping" : "subagent_result",
			);
			assert.equal(
				host.results()[0].message.details.autoRouting.decisionId,
				host.requests()[0].details.decisionId,
			);
			const completionIndex = host.messages.findIndex(
				(m) => m.message === host.results()[0].message,
			);
			assert.equal(
				host.messages
					.slice(completionIndex + 1)
					.filter(
						(m) =>
							m.message.customType === "jev_auto_status" &&
							m.message.details?.state === "started",
					).length,
				0,
				"never publish running after settlement",
			);
			assert.equal(
				host.fallback().length,
				1,
				"only existing result delivery wakes the parent",
			);
			assert.deepEqual(
				await host.input(event("result synthesis", { source: "extension" })),
				CONTINUE,
			);
			assert.equal(host.calls.length, 2);
			const context = host.manager.buildSessionContext();
			assert.ok(
				context.messages.some(
					(m: any) =>
						m.role === "custom" && m.customType === "jev_auto_request",
				),
			);
		});
	for (const harness of ["claude", "kiro"] as const)
		it(`${harness}: exact administrator projection, autonomous standalone leaf, native receipt`, async () => {
			const host = setup({ harness });
			const log = join(host.ctx.cwd, "native.json");
			const herdr = flow.useHerdr({
				log,
				onRun: () => assert.equal(host.requests().length, 1),
			});
			assert.deepEqual(await host.input(event()), HANDLED);
			await settled(host);
			assert.equal(herdr.events.filter((e) => e === "run").length, 1);
			assert.equal(host.calls.length, 2);
			const launched = JSON.parse(readFileSync(log, "utf8"));
			assert.equal(
				launched.args[launched.args.indexOf("--model") + 1],
				`${harness}-fixture-20260930`,
			);
			if (harness === "claude") {
				assert.equal(launched.tools, "Read,Bash");
				assert.equal(launched.typesafeKey, null);
				assert.equal(launched.autoRoutingDisabled, "1");
				assert.equal(
					launched.args[launched.args.indexOf("--effort") + 1],
					"high",
				);
			} else assert.deepEqual(launched.profile.mcpServers, {});
			assert.equal(
				launched.args[launched.args.indexOf("--effort") + 1],
				"high",
			);
			assert.equal(launched.resumed, false);
			const result = host.results()[0].message;
			assertAutomatic(result, harness);
			assert.equal(result.customType, "subagent_result");
			assert.equal(result.details.exitCode, 0, result.content);
			assert.equal(result.details.error, undefined);
			assert.equal(result.details.errorMessage, undefined);
			assert.match(
				result.content,
				harness === "claude" ? /Claude fixture result/ : /Kiro fixture result/,
			);
			assert.equal(
				result.details.autoRouting.decisionId,
				host.requests()[0].details.decisionId,
			);
			assert.equal(result.details.native.processExit, "confirmed");
			const runs = readFileSync(
				`${result.details.native.markerFile}.runs.jsonl`,
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.deepEqual(
				runs.map(({ runId, kind, event, outcome }) => ({
					runId,
					kind,
					event,
					outcome,
				})),
				[
					{
						runId: runs[0].runId,
						kind: "fresh",
						event: "started",
						outcome: undefined,
					},
					{
						runId: runs[0].runId,
						kind: "fresh",
						event: "settled",
						outcome: "completed",
					},
				],
			);
			assert.deepEqual(result.details.native.turns, [
				{ id: runs[0].runId, kind: "initial", outcome: "completed" },
			]);
			assert.equal(
				flow.markerV2(result.details.native.markerFile).nativeSessionId,
				result.details.native.sessionId,
			);
			// The fixture event schema records received input, not hook names.
			// This exact exit follows the correlated completed turn above.
			assert.deepEqual(flow.fixtureEvents(log), [
				{ input: harness === "claude" ? "/exit" : "/quit" },
			]);
			await waitFor(() => herdr.children[0].exitCode !== null);
			assert.equal(herdr.children[0].exitCode, 0);
		});
	for (const harness of ["claude", "kiro"] as const)
		it(`${harness}: failed exact automatic model carries the same receipt, without fallback`, async () => {
			const host = setup({ harness });
			const log = join(host.ctx.cwd, "native-error.json");
			const herdr = flow.useHerdr({
				log,
				env: { FAKE_FAIL_MODEL: `${harness}-fixture-20260930` },
				onRun: () => assert.equal(host.requests().length, 1),
			});
			assert.deepEqual(await host.input(event()), HANDLED);
			await settled(host);
			const result = host.results()[0].message;
			assertAutomatic(result, harness);
			assert.notEqual(result.details.exitCode, 0);
			assert.equal(
				result.details.autoRouting.decisionId,
				host.requests()[0].details.decisionId,
			);
			assert.equal(result.details.native.model, `${harness}-fixture-20260930`);
			assert.equal(herdr.events.filter((e) => e === "run").length, 1);
			assert.equal(host.calls.length, 2);
			assert.equal(
				host.fallback().length,
				1,
				"only normal child failure delivery",
			);
		});
	it("completion beating the outer launch acknowledgement cannot leave stale status or occupancy", async () => {
		let host!: ReturnType<typeof setup>;
		host = setup({
			seams: {
				launch: async (handoff: any) => {
					const outcome = await flow.testApi.launchAutoRoutedRun(
						host.api,
						handoff,
					);
					await waitFor(
						() =>
							host.results().length === host.requests().length &&
							flow.testApi.runningSubagents.size === 0,
					);
					return outcome;
				},
			},
		});
		piRecorder(host);
		assert.deepEqual(await host.input(event()), HANDLED);
		const acknowledgement = host.messages.find(
			(m) =>
				m.message.customType === "jev_auto_status" &&
				m.message.details?.state === "started",
		)!;
		assert.match(acknowledgement.message.content, /already finished/);
		assert.doesNotMatch(
			acknowledgement.message.content,
			/do not perform the request yourself/,
		);
		assert.equal(host.results().length, 1);
		assert.equal(host.calls.length, 2);
		// A later route proves the settled binding released admission.
		assert.deepEqual(await host.input(event()), HANDLED);
		assert.equal(host.results().length, 2);
		assert.equal(host.calls.length, 4);
	});
	it("identical later text is a distinct decision, not hidden dedupe", async () => {
		const host = setup();
		// This recorder verifies the latest request instead of assuming only one.
		const recorder = piRecorder(host);
		assert.deepEqual(await host.input(event()), HANDLED);
		await settled(host);
		const first = host.requests()[0].details.decisionId;
		assert.deepEqual(await host.input(event()), HANDLED);
		await waitFor(
			() =>
				host.results().length === 2 && flow.testApi.runningSubagents.size === 0,
		);
		assert.notEqual(host.requests()[1].details.decisionId, first);
		assert.equal(host.calls.length, 4);
		assert.equal(recorder.commands.length, 2);
	});
});

describe("registered ownership and failure boundaries", () => {
	for (const policy of ["parent", "hold"] as const)
		for (const kind of ["abstain", "unavailable"] as const)
			it(`unowned ${kind} under ${policy}: safe continue versus recorded hold`, async () => {
				const host = setup({
					failurePolicy: policy,
					respond: (batch) =>
						kind === "abstain"
							? answer(batch, true)
							: { status: "unavailable", reason: "jev-unavailable" },
				});
				const recorder = piRecorder(host);
				assert.deepEqual(
					await host.input(event()),
					policy === "parent" ? CONTINUE : HANDLED,
				);
				assert.equal(host.calls.length, 1);
				assert.equal(recorder.commands.length, 0);
				assert.equal(host.requests().length, policy === "parent" ? 0 : 1);
				assert.equal(host.fallback().length, 0);
			});
	for (const kind of ["throw", "defer", "read-back"] as const)
		it(`request ${kind} uncertainty irrevocably handled, no resources or parent replay`, async () => {
			const host = setup();
			const recorder = piRecorder(host);
			const send = host.api.sendMessage;
			host.api.sendMessage = (message: any, options: any) => {
				if (message.customType !== "jev_auto_request")
					return send(message, options);
				if (kind === "throw") throw new Error("append unavailable");
				if (kind === "defer") return; // Void API is not a durability ack.
				send(message, options);
				truncateSync(host.manager.getSessionFile()!, 0);
			};
			assert.deepEqual(await host.input(event()), HANDLED);
			assert.equal(host.calls.length, 2);
			assert.equal(recorder.commands.length, 0);
			assert.equal(recorder.events.length, 0);
			assert.equal(host.fallback().length, 0);
		});
	for (const policy of ["parent", "hold"] as const)
		it(`owned known no-dispatch launch rejection: ${policy}, never another tuple`, async () => {
			const host = setup({ failurePolicy: policy });
			const recorder = piRecorder(host, { failResources: true });
			assert.deepEqual(await host.input(event()), HANDLED);
			assert.equal(host.requests().length, 1);
			assert.equal(recorder.commands.length, 0);
			assert.equal(host.calls.length, 2);
			assert.equal(host.fallback().length, policy === "parent" ? 1 : 0);
			if (policy === "parent") {
				assert.equal(host.receipts().at(-1).data.phase, "fallback-attempted");
				assert.match(
					host.fallback()[0].message.content,
					/no subagent was launched/i,
				);
			}
		});
	it("fallback send uncertainty is attempted once, never resent", async () => {
		const host = setup();
		const recorder = piRecorder(host, { failResources: true });
		const send = host.api.sendMessage;
		let attempts = 0;
		host.api.sendMessage = (message: any, options: any) => {
			if (options?.triggerTurn) {
				attempts++;
				throw new Error("unknown parent delivery");
			}
			return send(message, options);
		};
		assert.deepEqual(await host.input(event()), HANDLED);
		await host.emit("agent_start");
		assert.equal(attempts, 1);
		assert.equal(recorder.commands.length, 0);
		assert.equal(host.calls.length, 2);
	});
	it("whole-config drift after recording blocks before resources with one owned fallback", async () => {
		const host = setup();
		const recorder = piRecorder(host);
		const send = host.api.sendMessage;
		host.api.sendMessage = (message: any, options: any) => {
			send(message, options);
			if (message.customType === "jev_auto_request")
				writeFileSync(
					durable,
					JSON.stringify({ autoRouting: { version: 1, mode: "off" } }),
				);
		};
		assert.deepEqual(await host.input(event()), HANDLED);
		assert.equal(recorder.events.length, 0);
		assert.equal(host.fallback().length, 1);
		assert.equal(host.calls.length, 2);
	});
	for (const cancellation of [
		"cancel",
		"agent_start",
		"session_before_compact",
		"session_before_tree",
		"session_shutdown",
	] as const)
		it(`observable ${cancellation} during classification holds; late evidence cannot launch`, async () => {
			const late = deferred<any>();
			const host = setup({ respond: () => late.promise });
			const recorder = piRecorder(host);
			const input = host.input(event());
			await waitFor(() => host.calls.length === 1);
			if (cancellation === "cancel")
				await host.commands
					.get("subagents-routing")
					.handler("cancel", host.ctx);
			else await host.emit(cancellation, { reason: "reload" });
			late.resolve(answer(host.calls[0].batch));
			assert.deepEqual(await input, HANDLED);
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(host.calls.length, 1);
			assert.equal(recorder.commands.length, 0);
			assert.equal(host.fallback().length, 0);
		});
	it("replacement session during classification holds without injecting into either parent", async () => {
		const late = deferred<any>();
		const host = setup({ respond: () => late.promise });
		const recorder = piRecorder(host);
		const input = host.input(event());
		await waitFor(() => host.calls.length === 1);
		const replacement = flow.inputHost(scratch("replacement-session"));
		host.ctx.sessionManager = replacement.manager;
		late.resolve(answer(host.calls[0].batch));
		assert.deepEqual(await input, HANDLED);
		assert.equal(host.messages.length, 0);
		assert.equal(replacement.messages.length, 0);
		assert.equal(recorder.commands.length, 0);
		assert.equal(host.calls.length, 1);
	});
	it("bounded deadline ignores late evidence without repeat dispatch/fallback", async () => {
		const late = deferred<any>();
		let now = 0;
		const host = setup({
			respond: () => late.promise,
			seams: { now: () => now },
		});
		const recorder = piRecorder(host);
		const input = host.input(event());
		await waitFor(() => host.calls.length === 1);
		now = 5001;
		late.resolve(answer(host.calls[0].batch));
		assert.deepEqual(await input, CONTINUE);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(host.calls.length, 1);
		assert.equal(recorder.commands.length, 0);
		assert.equal(host.fallback().length, 0);
	});
	it("concurrent input supersedes one undispatched decision, rather than deduplicating text", async () => {
		const late = deferred<any>();
		const host = setup({ respond: () => late.promise });
		const recorder = piRecorder(host);
		const first = host.input(event());
		await waitFor(() => host.calls.length === 1);
		assert.deepEqual(await host.input(event()), CONTINUE);
		late.resolve(answer(host.calls[0].batch));
		assert.deepEqual(await first, HANDLED);
		await Promise.resolve();
		assert.equal(host.calls.length, 1);
		assert.equal(recorder.commands.length, 0);
		assert.equal(host.fallback().length, 0);
	});
	for (const reason of ["cancel", "branch"] as const)
		it(`${reason} during shell wait closes only the undispatched pane, never parent fallback`, async () => {
			const ready = deferred<void>();
			const host = setup();
			const recorder = piRecorder(host, { wait: () => ready.promise });
			const input = host.input(event());
			await waitFor(() => recorder.events.includes("ready"));
			if (reason === "cancel")
				await host.commands
					.get("subagents-routing")
					.handler("cancel", host.ctx);
			else host.manager.appendCustomEntry("unrelated", {});
			ready.resolve();
			assert.deepEqual(await input, HANDLED);
			assert.equal(recorder.commands.length, 0);
			assert.ok(recorder.events.includes("close"));
			assert.equal(host.fallback().length, 0);
		});
	it("possible dispatch failure stays busy and never retries or falls back in parent", async () => {
		const host = setup();
		const recorder = piRecorder(host, { failDispatch: true });
		assert.deepEqual(await host.input(event()), HANDLED);
		assert.equal(recorder.commands.length, 1);
		assert.equal(host.fallback().length, 0);
		assert.equal(host.receipts().at(-1).data.phase, "uncertain");
		await host.commands.get("subagents-routing").handler("cancel", host.ctx);
		assert.deepEqual(await host.input(event()), CONTINUE);
		assert.equal(host.calls.length, 2);
		assert.equal(recorder.commands.length, 1);
	});
	for (const state of ["accepted", "dispatched", "uncertain"] as const)
		it(`unknown post-crash ${state} evidence blocks admission, never automatically replayed`, async () => {
			const host = setup();
			const recorder = piRecorder(host);
			const decisionId = "ad-00000000-0000-4000-8000-000000000001";
			if (state === "accepted")
				host.manager.appendCustomMessageEntry(
					"jev_auto_request",
					"Previously captured request",
					true,
					{ version: 1, decisionId, state },
				);
			else
				host.manager.appendCustomEntry(AUTO_RECEIPT_ENTRY_TYPE, {
					version: 1,
					decisionId,
					phase: state,
				});
			await host.emit("session_start", { reason: "startup" });
			assert.deepEqual(await host.input(event()), CONTINUE);
			await host.commands.get("subagents-routing").handler("status", host.ctx);
			assert.equal(host.calls.length, 0);
			assert.equal(recorder.commands.length, 0);
			assert.ok(host.notices.some((n) => /unknown|recovery/i.test(n)));
		});
});

describe("registered TUI modes and unchanged manual authority", () => {
	it("shadow immediately continues and can never launch, even when late evidence selects", async () => {
		const late = deferred<any>();
		const host = setup({
			mode: "shadow",
			respond: (batch, i) => (i === 0 ? late.promise : answer(batch)),
		});
		const recorder = piRecorder(host);
		assert.deepEqual(await host.input(event()), CONTINUE);
		await waitFor(() => host.calls.length === 1);
		host.manager.appendCustomEntry("ordinary-parent-context", {});
		await host.emit("agent_start");
		late.resolve(answer(host.calls[0].batch));
		await waitFor(() => host.receipts().length > 0);
		assert.equal(host.calls.length, 2);
		assert.equal(recorder.commands.length, 0);
		assert.equal(host.messages.length, 0);
	});
	for (const approve of [false, true])
		it(`pilot ${approve ? "approval" : "decline"} occurs only after persisted request`, async () => {
			const host = setup({ mode: "pilot" });
			const recorder = piRecorder(host);
			let dialogs = 0;
			host.ctx.ui.confirm = async (_title, body, options) => {
				dialogs++;
				assert.equal(host.requests().length, 1);
				assert.equal(recorder.commands.length, 0);
				assert.match(body, /fake\/exact-2/);
				assert.ok(options?.signal);
				return approve;
			};
			assert.deepEqual(await host.input(event()), HANDLED);
			if (approve) await settled(host);
			assert.equal(dialogs, 1);
			assert.equal(recorder.commands.length, approve ? 1 : 0);
			assert.equal(host.fallback().length, approve ? 1 : 0);
		});
	it("pilot timeout consumes the persisted request; late approval cannot launch", async () => {
		const late = deferred<boolean>();
		const timers: Array<{ callback: () => void; ms: number }> = [];
		const host = setup({
			mode: "pilot",
			seams: {
				setTimer: (callback: () => void, ms: number) => {
					timers.push({ callback, ms });
					return () => {};
				},
			},
		});
		const recorder = piRecorder(host);
		host.ctx.ui.confirm = () => late.promise;
		const input = host.input(event());
		await waitFor(() => timers.some((t) => t.ms === 30000));
		timers.find((t) => t.ms === 30000)!.callback();
		assert.deepEqual(await input, HANDLED);
		late.resolve(true);
		await Promise.resolve();
		assert.equal(host.requests().length, 1);
		assert.equal(recorder.commands.length, 0);
		assert.equal(host.fallback().length, 0);
	});
	it("pilot without confirmation API never auto-approves", async () => {
		const host = setup({ mode: "pilot" });
		const recorder = piRecorder(host);
		Reflect.deleteProperty(host.ctx.ui, "confirm");
		assert.deepEqual(await host.input(event()), CONTINUE);
		assert.equal(host.calls.length, 0);
		assert.equal(recorder.commands.length, 0);
		assert.equal(host.fallback().length, 0);
	});
	for (const mode of modes)
		it(`${mode}: registered manual tool fallback, command, resume keep immutable native loadout and make zero Jev calls`, async () => {
			const host = setup({ mode });
			const log = join(host.ctx.cwd, "manual.json");
			flow.writeRole("af-manual", [
				"cli: claude",
				"auto-exit: true",
				"tools: read, bash",
			]);
			const herdr = flow.useHerdr({
				log,
				env: { FAKE_FAIL_MODEL: "manual-a" },
			});
			const tool = host.tools.find((t) => t.name === "subagent");
			const started = await tool.execute(
				"manual",
				{
					name: "manual",
					agent: "af-manual",
					task: TASK,
					model: "manual-a,manual-b",
					thinking: "high",
				},
				new AbortController().signal,
				() => {},
				host.ctx,
			);
			assert.equal(started.details.status, "started", JSON.stringify(started));
			await settled(host);
			assert.equal(
				herdr.events.filter((e) => e === "run").length,
				2,
				"existing positive-no-work fallback still works",
			);
			const first = host.results()[0].message;
			assert.equal(first.details.autoRouting, undefined);
			assert.equal(first.details.selection.harnessSource, "role");
			flow.writeRole("af-manual", [
				"cli: claude",
				"model: changed-model",
				"thinking: low",
				"auto-exit: true",
				"tools: read, bash, write",
			]);
			const durableConfig = JSON.parse(readFileSync(durable, "utf8"));
			durableConfig.models = {
				...durableConfig.models,
				default: "fake/changed-parent-default",
			};
			writeFileSync(durable, JSON.stringify(durableConfig));
			const assertRoutingCurrent = async () => {
				const current = loadAutoRoutingConfig();
				assert.ok(current.status === "off" || current.status === "enabled");
				assert.equal(current.status, mode === "off" ? "off" : "enabled");
				assert.equal(current.config.mode, mode);
				assert.equal(current.digest, host.loaded.digest);
				assert.deepEqual(current.config, host.loaded.config);
				const beforeStatus = host.notices.length;
				await host.commands
					.get("subagents-routing")
					.handler("status", host.ctx);
				const status = host.notices.slice(beforeStatus).join("\n");
				assert.match(status, new RegExp(`Automatic routing: ${mode}`));
				assert.doesNotMatch(status, /configuration file changed/);
			};
			await assertRoutingCurrent();
			const resumed = await host.tools
				.find((t) => t.name === "subagent_resume")
				.execute(
					"resume",
					{
						sessionPath: first.details.sessionFile,
						name: "manual-resumed",
						message: "Continue the bounded inspection.",
					},
					new AbortController().signal,
					() => {},
					host.ctx,
				);
			assert.equal(resumed.details.status, "started", JSON.stringify(resumed));
			await waitFor(
				() =>
					host.results().length === 2 &&
					flow.testApi.runningSubagents.size === 0,
			);
			const launched = JSON.parse(readFileSync(log, "utf8"));
			assert.equal(launched.resumed, true);
			assert.equal(launched.tools, "Read,Bash");
			assert.equal(
				launched.args[launched.args.indexOf("--model") + 1],
				"manual-b",
			);
			assert.equal(
				launched.args[launched.args.indexOf("--effort") + 1],
				"high",
			);
			await host.commands
				.get("subagent")
				.handler("af-manual Inspect locally", host.ctx);
			await host.commands
				.get("subagents-init")
				.handler("Use the offline registry snapshot", host.ctx);
			await host.commands
				.get("plan")
				.handler("Plan a bounded inspection", host.ctx);
			assert.equal(host.userMessages.length, 3);
			for (const text of host.userMessages)
				assert.deepEqual(
					await host.input(event(text, { source: "extension" })),
					CONTINUE,
				);
			await assertRoutingCurrent();
			assert.equal(host.calls.length, 0);
		});
	it("an existing watcher delivers to the replacement parent's API exactly once with automatic metadata", async () => {
		const host = setup();
		const done = deferred<any>();
		const recorder = piRecorder(host);
		const runtime = runtimeState();
		runtime.nativeTestSeam!.piWatch = (child: any) =>
			done.promise.then(() => ({
				name: child.name,
				task: child.task,
				summary: "Replacement-parent finding",
				exitCode: 0,
				elapsed: 0,
				sessionFile: child.sessionFile,
			}));
		assert.deepEqual(await host.input(event()), HANDLED);
		const replacement = flow.inputHost(host.ctx.cwd, true, host.manager);
		extension(replacement.api, {
			autoRouting: { env: {}, loadConfig: () => host.loaded },
		});
		assert.deepEqual(
			await replacement.input(event()),
			CONTINUE,
			"known running auto child stays busy across coordinator reload",
		);
		done.resolve({});
		await waitFor(
			() =>
				replacement.messages.some(
					({ message }) => message.customType === "subagent_result",
				) && flow.testApi.runningSubagents.size === 0,
		);
		assert.equal(host.results().length, 0);
		const results = replacement.messages.filter(
			({ message }) => message.customType === "subagent_result",
		);
		assert.equal(results.length, 1);
		assertAutomatic(results[0].message, "pi");
		assert.equal(
			results[0].message.details.autoRouting.decisionId,
			host.requests()[0].details.decisionId,
		);
		assert.equal(recorder.commands.length, 1);
		assert.equal(host.calls.length, 2);
	});
});
